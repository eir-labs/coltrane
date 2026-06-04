// onboarding_pipeline.spec.ts — e2e for onboard-v0.
//
// the recursive design under test:
//   user clones coltrane-oss → claude reads CLAUDE.md → claude dispatches onboard-v0
//   → pipeline runs ON the user (scan → infer → pick → seed → orient) → user sees
//   the orientation-report verdict. every subsequent coltrane pipeline takes this
//   same 5-phase shape — onboard-v0 is self-demonstrating.
//
// surface under test:
//   - 5 domain types (repo-scan / lane-inference / seed-selection /
//     steve-instantiation / orientation-report)
//   - 5 agents (repo-scanner / lane-inferer / seed-picker / steve-seeder / orienter)
//   - 1 standard (onboard-v0) wiring them sequentially
//   - runtime: typed-output validation + provenance threading
//
// design contract (per src/runtime.ts):
//   AgentInvoker is the one non-deterministic seam. we inject a deterministic
//   invoker so CI doesn't burn 5 real claudes. the runtime around it is
//   deterministic — validation + provenance + ledger sealing are all asserted.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  loadGenome,
  loadRegistry,
  createOutputStore,
  MemoryLedger,
  runGig,
  type AgentInvoker,
  type OutputRecord,
} from "../../src/index.js";

// Repo root (this test lives at tests/e2e/onboarding_pipeline.spec.ts).
const REPO_ROOT = join(__dirname, "..", "..");

// ──────────────────────────────────────────────────────────────────────────
// fixture: a mock-repo with a package.json so lane-inferer has real signal
// ──────────────────────────────────────────────────────────────────────────
let mockRepoDir: string;

beforeAll(() => {
  mockRepoDir = mkdtempSync(join(tmpdir(), "onboard-mvp-mock-repo-"));
  // shape it like a backend node project so the deterministic inferer has signal
  writeFileSync(
    join(mockRepoDir, "package.json"),
    JSON.stringify({ name: "mock-backend", dependencies: { express: "^4.0.0" } }, null, 2),
  );
  writeFileSync(join(mockRepoDir, "README.md"), "# mock backend\n\nA mock backend repo.\n");
  mkdirSync(join(mockRepoDir, "src"), { recursive: true });
  writeFileSync(join(mockRepoDir, "src", "server.ts"), "export const port = 3000;\n");
  writeFileSync(join(mockRepoDir, "src", "routes.ts"), "export const routes = [];\n");
});

afterAll(() => {
  if (mockRepoDir) rmSync(mockRepoDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// deterministic invoker: each agent produces a schema-valid output for the
// onboard-v0 domain types, parameterized by the mock repo's actual shape.
// the test asserts the runtime correctly threads typed outputs + provenance —
// not that some particular LLM produces particular content.
// ──────────────────────────────────────────────────────────────────────────
function buildInvoker(cwd: string): AgentInvoker {
  return ({ agent, inputs }) => {
    switch (agent.slug) {
      case "repo-scanner":
        return {
          cwd,
          paths: ["package.json", "README.md", "src/server.ts", "src/routes.ts"],
          files_by_ext_count: { ts: 2, json: 1, md: 1 },
          has_package_json: true,
          has_cargo_toml: false,
          has_claude_md: false,
          frameworks_detected: ["node", "typescript", "express"],
        };
      case "lane-inferer": {
        const upstream = inputs[0]!.id;
        return {
          input_refs: [upstream],
          lanes: [
            { name: "backend", confidence: 0.85, reasoning: "package.json + express + src/*.ts → node backend" },
            { name: "infra",   confidence: 0.20, reasoning: "thin signal: no deploy config detected" },
          ],
        };
      }
      case "seed-picker": {
        const upstream = inputs[0]!.id;
        return {
          input_refs: [upstream],
          chosen_lanes: ["backend"],
          rationale: "backend lane has 0.85 confidence; infra below threshold — seed one Steve for the dominant lane only",
        };
      }
      case "steve-seeder": {
        const upstream = inputs[0]!.id;
        const uuid = randomUUID();
        return {
          input_refs: [upstream],
          sub_sessions: [
            {
              lane: "backend",
              session_uuid: uuid,
              resume_command: `claude --resume ${uuid}`,
            },
          ],
        };
      }
      case "orienter": {
        const upstream = inputs[0]!.id;
        const sub = (inputs[0]!.data["sub_sessions"] as Array<{ lane: string; session_uuid: string; resume_command: string }>)[0]!;
        return {
          input_refs: [upstream],
          report_md: [
            "# coltrane onboard complete",
            "",
            "Scanned this repo. Inferred lanes. Seeded **1 Steve** for the **backend** lane.",
            "",
            `- backend → \`${sub.resume_command}\``,
            "",
            "Read CLAUDE.md to learn the genome; wake the Steve when you're ready.",
          ].join("\n"),
          lanes_spawned: ["backend"],
          suggested_first_action: sub.resume_command,
        };
      }
      default:
        throw new Error(`unexpected agent ${agent.slug} in onboard-v0`);
    }
  };
}

// ──────────────────────────────────────────────────────────────────────────
// the test
// ──────────────────────────────────────────────────────────────────────────
describe("onboard-v0 e2e: onboarding IS the first coltrane pipeline", () => {
  it("dispatches 5 phases, lands 5 typed outputs, threads full provenance back to repo-scan", async () => {
    // load the live genome (the JSON files we just authored)
    const genome = loadGenome(REPO_ROOT);

    // sanity: the 5 domain types + 5 agents + standard all loaded
    expect(genome.domain_types.has("repo-scan@1")).toBe(true);
    expect(genome.domain_types.has("lane-inference@1")).toBe(true);
    expect(genome.domain_types.has("seed-selection@1")).toBe(true);
    expect(genome.domain_types.has("steve-instantiation@1")).toBe(true);
    expect(genome.domain_types.has("orientation-report@1")).toBe(true);

    for (const slug of ["repo-scanner", "lane-inferer", "seed-picker", "steve-seeder", "orienter"]) {
      expect(genome.agents.has(slug)).toBe(true);
    }

    const standard = genome.standards.get("onboard-v0");
    expect(standard).toBeDefined();
    expect(standard!.phases.map((p) => p.name)).toEqual(["scan", "infer", "pick", "seed", "orient"]);

    // build deps + run the gig
    const registry = loadRegistry(genome);
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();
    const invoke = buildInvoker(mockRepoDir);

    const result = await runGig(
      standard!,
      { cwd: mockRepoDir, user_cwd_history: "~/.claude/projects/" },
      { outputs, ledger, invoke, model_version: "onboard-e2e" },
    );

    // ── assertion 1: 5 outputs landed, each typed
    expect(result.outputs.length).toBe(5);
    const byType = new Map<string, OutputRecord>();
    for (const o of result.outputs) byType.set(o.domain_type, o);
    expect([...byType.keys()].sort()).toEqual(
      ["lane-inference", "orientation-report", "repo-scan", "seed-selection", "steve-instantiation"],
    );

    // ── assertion 2: each output's data validates against its schema
    // (runGig already calls outputs.write which validates — but explicitly re-validate
    // each via the registry to prove the typed contract is honest, not just incidentally green)
    for (const [domainType, rec] of byType) {
      const v = registry.validate({ core_type: rec.core_type, domain_type: domainType, data: rec.data });
      expect(v.valid, `${domainType} should validate, got errors: ${v.errors.join("; ")}`).toBe(true);
    }

    // ── assertion 3: final orientation-report has ≥1 lane spawned
    const orient = byType.get("orientation-report")!;
    const lanesSpawned = orient.data["lanes_spawned"] as string[];
    expect(lanesSpawned.length).toBeGreaterThanOrEqual(1);
    expect(lanesSpawned).toContain("backend");

    // ── assertion 4: report_md is a non-trivial user-facing string
    const reportMd = orient.data["report_md"] as string;
    expect(reportMd.length).toBeGreaterThan(20);
    expect(reportMd).toContain("backend");

    // ── assertion 5: suggested_first_action surfaces the resume command
    const sugg = orient.data["suggested_first_action"] as string;
    expect(sugg).toMatch(/claude --resume [0-9a-f-]{36}/);

    // ── assertion 6: provenance walks orientation-report → steve-instantiation
    //   → seed-selection → lane-inference → repo-scan (5 hops back to the root signal)
    const trace = outputs.trace(orient.id);
    const traceIds = new Set(trace.map((t) => t.id));
    const repoScan = byType.get("repo-scan")!;
    const laneInf = byType.get("lane-inference")!;
    const seedSel = byType.get("seed-selection")!;
    const steveInst = byType.get("steve-instantiation")!;
    expect(traceIds.has(steveInst.id), "trace should reach steve-instantiation").toBe(true);
    expect(traceIds.has(seedSel.id),   "trace should reach seed-selection").toBe(true);
    expect(traceIds.has(laneInf.id),   "trace should reach lane-inference").toBe(true);
    expect(traceIds.has(repoScan.id),  "trace should reach repo-scan (the root signal)").toBe(true);

    // ── assertion 7: repo-scan IS a root signal (no upstream input_refs)
    expect(repoScan.input_refs.length).toBe(0);

    // ── assertion 8: ledger sealed exactly one entry with a deterministic genome_hash
    const ledgerEntries = ledger.query({ gig_id: result.gig_id });
    expect(ledgerEntries.length).toBe(1);
    expect(ledgerEntries[0]!.genome_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ledgerEntries[0]!.run_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(ledgerEntries[0]!.standard_slug).toBe("onboard-v0");
  });
});
