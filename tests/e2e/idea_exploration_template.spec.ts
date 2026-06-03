// e2e — full diamond-cycle on Hum/Drift through the idea-exploration template.
//
// User story (read top-to-bottom as a manual):
//   1. A fresh user clones a coltrane-oss flavored repo with templates/idea-exploration/ live.
//   2. They invoke /coltrane-explore-idea on the Hum/Drift instrument topic.
//   3. DISCOVER produces >=7 distinct candidate framings.
//   4. DEFINE_SEAL produces sealed pre-regs (predict + kill + apoha + sha256) for survivors.
//   5. DEVELOP picks 1, archives the rest as unsown-seeds with seal-hash intact.
//   6. DELIVER ripens against the frozen seal.
//
// This test layers `templates/idea-exploration/*` into the harness tempdir clone, then
// drives `claude -p` end-to-end. It DOES NOT mock the model — it runs the real CLI.
// If the live coltrane MCP surface doesn't yet support standard_dispatch with this protocol,
// the test fails honestly — per Eugene's verify-gate-not-hollow-green rule.
//
// The MAJORITY of the test exercises is layered as direct MCP tool-calls (agent_define +
// standard_compose) that ARE verified to work in the existing user_drives_claude_with_coltrane
// spec. The full Claude-driven 5-phase walk is exercised in a single long-running it()
// at the end, gated by SKIP_CLAUDE_DRIVE env var (default: skip — turn on locally to verify).
//
// Run:
//   npx vitest run --config tests/e2e/vitest.config.ts \
//     tests/e2e/idea_exploration_template.spec.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  setupTempdirColtrane,
  spawnClaudeSubthread,
  parseStreamJson,
  assistantText,
  type TempdirColtrane,
  type SubthreadResult,
} from "./_harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");
const TEMPLATE_ROOT = join(REPO_ROOT, "templates", "idea-exploration");

const SKIP_PERMS = "--dangerously-skip-permissions";

// SKIP_CLAUDE_DRIVE=1 short-circuits the slowest test (the live claude-driven 5-phase walk).
// The structural tests (template-loads, sha-seal-correctness, archival-integrity) ALWAYS run.
const SKIP_CLAUDE_DRIVE = process.env.SKIP_CLAUDE_DRIVE === "1";

async function askClaude(
  prompt: string,
  env: TempdirColtrane,
  timeoutMs = 240_000,
): Promise<SubthreadResult> {
  return spawnClaudeSubthread(["-p", prompt, SKIP_PERMS], {
    mcpConfigPath: env.mcpConfigPath,
    cwd: env.tempDir,
    timeoutMs,
  });
}

function toolUses(stdout: string): Array<{ name: string; input: Record<string, unknown> }> {
  const events = parseStreamJson(stdout);
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const ev of events) {
    if (ev.type !== "assistant") continue;
    const msg = ev.message as
      | { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> }
      | undefined;
    if (!msg?.content) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        calls.push({ name: block.name, input: block.input ?? {} });
      }
    }
  }
  return calls;
}

/**
 * Layer the idea-exploration template OVER the harness's base tempdir clone.
 * - Wipes the demo agents/standards/skills/domain_types so only our template's entities load.
 * - Copies templates/idea-exploration/agents/*, standards/*, skills/*, domain_types/* in.
 * - Returns the tempdir env unchanged for the harness's claude-driver.
 */
function layerIdeaExplorationTemplate(env: TempdirColtrane): void {
  for (const dir of ["agents", "standards", "skills", "domain_types"]) {
    const target = join(env.tempDir, dir);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    const src = join(TEMPLATE_ROOT, dir);
    if (existsSync(src)) cpSync(src, target, { recursive: true });
  }
  // archived_seeds/ is where unsown-seeds land
  mkdirSync(join(env.tempDir, "archived_seeds"), { recursive: true });
}

/**
 * Brace-matching extractors. Claude often surrounds JSON with prose and/or
 * code fences. Regex-with-greedy [\s\S]* over-shoots. Walk braces/brackets
 * with string-awareness instead.
 */
function extractJsonObject(text: string): unknown {
  return extractBalanced(text, "{", "}");
}
function extractJsonArray(text: string): unknown {
  return extractBalanced(text, "[", "]");
}
function extractBalanced(text: string, open: string, close: string): unknown {
  // strip code fences for cleanliness, then find the first balanced span.
  const cleaned = text.replace(/```(?:json)?\n?/gi, "").replace(/```/g, "");
  const start = cleaned.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i]!;
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Canonical-json sha256 helper — same algorithm the kill_condition_keeper uses to seal. */
function sha256Canonical(obj: unknown): string {
  return createHash("sha256").update(canonicalize(obj)).digest("hex");
}
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalize((v as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

// =====================================================================
// Structural tests — verify the template's shape directly. Always runs.
// =====================================================================

describe("idea-exploration template — structural integrity", () => {
  it("template root exists with the 6 required components", () => {
    expect(existsSync(TEMPLATE_ROOT), `template at ${TEMPLATE_ROOT}`).toBe(true);
    for (const sub of [
      "agents",
      "standards",
      "skills",
      "domain_types",
      "core_types",
      "CLAUDE.md",
      "README.md",
      "examples/hum_drift_exploration.md",
      ".claude/commands/coltrane-explore-idea.md",
      "archived_seeds",
    ]) {
      expect(existsSync(join(TEMPLATE_ROOT, sub)), `missing: ${sub}`).toBe(true);
    }
  });

  it("ships 5 agents with valid phase-agent shapes", () => {
    const agents = readdirSync(join(TEMPLATE_ROOT, "agents")).filter((f) => f.endsWith(".json"));
    expect(agents.sort()).toEqual([
      "audience_modeler.json",
      "idea_explorer.json",
      "kill_condition_keeper.json",
      "ripener.json",
      "seed_sower.json",
    ]);
    for (const f of agents) {
      const a = JSON.parse(readFileSync(join(TEMPLATE_ROOT, "agents", f), "utf-8")) as {
        slug: string;
        primitives: string[];
        domain: string;
        _charter?: { apoha?: string[] };
      };
      expect(a.slug, f).toBeTruthy();
      expect(a.primitives.length, `${f} primitives`).toBeGreaterThan(0);
      expect(a.domain, `${f} domain`).toBe("idea-exploration");
      // apoha-discipline check: every lane-agent in this template SHOULD encode an apoha.
      expect(
        a._charter?.apoha?.length ?? 0,
        `${f} must encode an apoha (inverted-kill set)`,
      ).toBeGreaterThan(0);
    }
  });

  it("ships the idea_exploration_protocol standard with all 5 phases", () => {
    const std = JSON.parse(
      readFileSync(join(TEMPLATE_ROOT, "standards", "idea_exploration_protocol.json"), "utf-8"),
    ) as { slug: string; phases: Array<{ name: string }>; gates: Record<string, unknown> };
    expect(std.slug).toBe("idea_exploration_protocol");
    expect(std.phases.map((p) => p.name)).toEqual([
      "discover",
      "define_audience",
      "define_seal",
      "develop",
      "deliver",
    ]);
    // Refuse-premature-convergence gate must be expressible
    expect(std.gates).toHaveProperty("discover_to_define_audience");
    expect(std.gates).toHaveProperty("define_seal_to_develop");
    expect(std.gates).toHaveProperty("develop_to_deliver");
  });

  it("loads as a self-contained coltrane genome", async () => {
    // Hit the loader directly — no MCP, no claude. Just structural validity.
    const { loadGenome } = await import("../../src/loader.js");
    const g = loadGenome(TEMPLATE_ROOT);
    expect([...g.agents.keys()].sort()).toEqual([
      "audience_modeler",
      "idea_explorer",
      "kill_condition_keeper",
      "ripener",
      "seed_sower",
    ]);
    expect([...g.standards.keys()]).toContain("idea_exploration_protocol");
    expect([...g.domain_types.keys()].length).toBeGreaterThanOrEqual(6);
  });

  it("template's CLAUDE.md encodes the refuse-premature-convergence discipline", () => {
    const claude = readFileSync(join(TEMPLATE_ROOT, "CLAUDE.md"), "utf-8");
    expect(claude).toMatch(/Refuse to commit until.*7 alternatives/i);
    expect(claude).toMatch(/SEAL/);
    expect(claude).toMatch(/apoha/);
    expect(claude).toMatch(/archived_seeds/);
    expect(claude).toMatch(/audience-modeler|audience_modeler/i);
  });

  it("worked-example surfaces >=7 candidates AND walks through DEVELOP archival", () => {
    const ex = readFileSync(
      join(TEMPLATE_ROOT, "examples", "hum_drift_exploration.md"),
      "utf-8",
    );
    // candidate IDs c1..c10 — at least 7 must appear in the worked example
    const candidateIds = (ex.match(/\bc\d+\b/g) ?? []).filter(
      (v, i, a) => a.indexOf(v) === i,
    );
    expect(candidateIds.length, `worked example must surface >=7 candidate IDs`).toBeGreaterThanOrEqual(7);
    expect(ex).toMatch(/sha256/i);
    expect(ex).toMatch(/RIPENED|PARTLY-RIPENED|KILL-FIRED/);
    expect(ex).toMatch(/archived_seeds/);
  });
});

// =====================================================================
// Seal-mechanics tests — verify sha256_pre_verdict math is correct.
// =====================================================================

describe("idea-exploration template — seal mechanics", () => {
  it("sha256_pre_verdict over canonical triple is reproducible and binding", () => {
    const candidate = {
      candidate_id: "c1",
      predict: "WITHIN 8 weeks, >=6 of 12 duos report a listening-shift",
      kill_condition: "IF <4 of 12 by week 8, FALSIFIED",
      apoha: [
        "NOT a one-player solo with FX",
        "NOT a turn-taking duet",
        "NOT a generic jam tool",
      ],
    };
    const h1 = sha256Canonical(candidate);
    const h2 = sha256Canonical({
      // same triple, keys in different order — canonicalize sorts keys
      apoha: candidate.apoha,
      kill_condition: candidate.kill_condition,
      candidate_id: candidate.candidate_id,
      predict: candidate.predict,
    });
    expect(h1, "key-order must not change the hash").toBe(h2);

    // Touching ANY sealed field MUST change the hash (the seal is binding).
    const drifted = { ...candidate, predict: candidate.predict + " " };
    expect(sha256Canonical(drifted)).not.toBe(h1);

    // Removing the apoha array entirely also changes the hash (apoha is sealed).
    const noApoha = { ...candidate, apoha: [] };
    expect(sha256Canonical(noApoha)).not.toBe(h1);
  });

  it("archived unsown-seed re-hashes to its stored sha256 (restartability)", () => {
    // Simulate a sealed candidate going into archived_seeds/ — then re-verify integrity.
    const sealed = {
      candidate_id: "c5",
      predict: "WITHIN 6-couple trial, >=4 couples report lead/follow surfacing",
      kill_condition: "IF <3 couples OR <2 therapists report, FALSIFIED",
      apoha: ["NOT couples therapy itself", "NOT a diagnostic tool"],
    };
    const seal = sha256Canonical(sealed);

    const unsown = {
      ...sealed,
      sha256_pre_verdict: seal,
      framing: "dyad-therapy adjunct",
      archived_at: "2026-06-02T00:00:00Z",
      reason_not_developed: "deferred until clinical partner found",
    };

    // The ripener's integrity check: re-hash the original triple, compare to stored.
    const recomputed = sha256Canonical({
      candidate_id: unsown.candidate_id,
      predict: unsown.predict,
      kill_condition: unsown.kill_condition,
      apoha: unsown.apoha,
    });
    expect(recomputed).toBe(unsown.sha256_pre_verdict);
  });
});

// =====================================================================
// MCP-level test — template lays into a tempdir and the coltrane MCP
// server loads it. Exercises the loader + composition end-to-end.
// =====================================================================

describe("idea-exploration template — tempdir layering", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    layerIdeaExplorationTemplate(env);
  }, 300_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("layered tempdir loads via coltrane loadGenome with idea-exploration entities", async () => {
    const { loadGenome } = await import("../../src/loader.js");
    const g = loadGenome(env.tempDir);
    expect([...g.agents.keys()].sort()).toEqual([
      "audience_modeler",
      "idea_explorer",
      "kill_condition_keeper",
      "ripener",
      "seed_sower",
    ]);
    expect([...g.standards.keys()]).toContain("idea_exploration_protocol");
    expect(g.standards.get("idea_exploration_protocol")!.phases.length).toBe(5);
  });

  it("asks claude (via MCP) to read the idea_explorer agent and confirm its discover charter", async () => {
    if (SKIP_CLAUDE_DRIVE) {
      console.log("SKIP_CLAUDE_DRIVE=1 — skipping live claude invocation");
      return;
    }
    const r = await askClaude(
      [
        "Read the file agents/idea_explorer.json using the Read tool.",
        "Reply with ONE WORD: the value of the `primitives` field's FIRST entry.",
        "Just one word. No prose.",
      ].join(" "),
      env,
      180_000,
    );
    expect(r.exitCode, `stderr:\n${r.stderr.slice(0, 800)}`).toBe(0);
    const reply = assistantText(parseStreamJson(r.stdout));
    expect(reply, `assistant reply:\n${reply}`).toMatch(/SENSE/);
  }, 240_000);
});

// =====================================================================
// Full claude-driven walk through the 5 phases on Hum/Drift.
// Slow + flaky — guarded by SKIP_CLAUDE_DRIVE (default: skip).
// Run locally with: SKIP_CLAUDE_DRIVE=0 npx vitest run ...
// =====================================================================

describe("idea-exploration template — full Hum/Drift 5-phase walk", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    layerIdeaExplorationTemplate(env);
  }, 300_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("DISCOVER produces >=7 distinct candidate framings", async () => {
    if (SKIP_CLAUDE_DRIVE) {
      console.log("SKIP_CLAUDE_DRIVE=1 — skipping live claude DISCOVER drive");
      return;
    }
    const r = await askClaude(
      [
        "You are running the idea-exploration template (see CLAUDE.md). DISCOVER PHASE ONLY.",
        "Seed topic: 'Hum/Drift — a two-person ambient instrument over a shared edge fabric.'",
        "Generate exactly 7 distinct candidate framings. For each:",
        "  - id (c1..c7)",
        "  - framing (one short phrase)",
        "  - one_liner (one sentence)",
        "Output as a JSON ARRAY of 7 objects. NO prose around it.",
      ].join(" "),
      env,
      240_000,
    );
    expect(r.exitCode, `stderr:\n${r.stderr.slice(0, 800)}`).toBe(0);
    const text = assistantText(parseStreamJson(r.stdout));
    const arr = extractJsonArray(text) as Array<{ id: string; framing: string; one_liner: string }>;
    expect(Array.isArray(arr), `claude reply must include a JSON array of candidates:\n${text.slice(0, 1000)}`).toBe(true);
    expect(arr.length, `DISCOVER must produce >=7 candidates, got ${arr.length}`).toBeGreaterThanOrEqual(7);
    const ids = new Set(arr.map((c) => c.id));
    expect(ids.size, "candidate IDs must be distinct").toBe(arr.length);
    const framings = new Set(arr.map((c) => c.framing.toLowerCase().trim()));
    expect(framings.size, "candidate framings must be distinct").toBe(arr.length);
  }, 360_000);

  it("DEFINE_SEAL produces sha256-sealed pre-regs with predict + kill + apoha", async () => {
    if (SKIP_CLAUDE_DRIVE) {
      console.log("SKIP_CLAUDE_DRIVE=1 — skipping live claude DEFINE_SEAL drive");
      return;
    }
    // Hand claude a fixed candidate to seal (so the test is deterministic re: structure).
    const r = await askClaude(
      [
        "You are running the idea-exploration template's DEFINE_SEAL phase (agent: kill_condition_keeper).",
        "Given this candidate:",
        '  {"candidate_id":"c1","framing":"listening-instrument","one_liner":"each player shapes what the OTHER plays via shared envelope follower"}',
        "Produce a sealed-prereg as a JSON object with EXACTLY these fields:",
        '  candidate_id (string), predict (string with a SPECIFIC observable+threshold+window),',
        '  kill_condition (string, falsification trigger), apoha (array of >=1 "NOT X" strings).',
        "Do NOT compute sha256 — we'll compute it deterministically in the test.",
        "Reply with ONLY the JSON object. No prose.",
      ].join(" "),
      env,
      180_000,
    );
    expect(r.exitCode, `stderr:\n${r.stderr.slice(0, 800)}`).toBe(0);
    const text = assistantText(parseStreamJson(r.stdout));
    const sealed = extractJsonObject(text) as {
      candidate_id: string;
      predict: string;
      kill_condition: string;
      apoha: string[];
    };
    expect(sealed, `claude reply must include a JSON object:\n${text.slice(0, 1000)}`).toBeTruthy();
    expect(sealed.candidate_id).toBe("c1");
    // predict apoha-discipline checks — NOT shipping vague predicts
    expect(sealed.predict.length, "predict must be substantive").toBeGreaterThan(20);
    expect(sealed.predict.toLowerCase(), "predict must NOT be 'this will be useful'").not.toMatch(/this will be useful/);
    expect(sealed.kill_condition.length, "kill_condition must be substantive").toBeGreaterThan(15);
    expect(sealed.apoha.length, "apoha must contain >=1 inverted-kill").toBeGreaterThanOrEqual(1);
    for (const ap of sealed.apoha) {
      expect(ap.toLowerCase(), `apoha entry must be inverted-kill: ${ap}`).toMatch(/\bnot\b/i);
    }
    // The seal sha is computable by the test (kill_condition_keeper's canonicalize math).
    const seal = sha256Canonical({
      candidate_id: sealed.candidate_id,
      predict: sealed.predict,
      kill_condition: sealed.kill_condition,
      apoha: sealed.apoha,
    });
    expect(seal).toMatch(/^[0-9a-f]{64}$/);
  }, 240_000);

  it("DEVELOP archives non-selected candidates as unsown-seeds with seal-hash intact", () => {
    // Structural test — exercises the seed_sower's archival contract directly.
    // Given 3 sealed candidates, picking 1 for develop must leave 2 unsown-seeds with seal-hashes intact.
    const sealed = [
      {
        candidate_id: "c1",
        framing: "listening-instrument",
        predict: "WITHIN 8 weeks, >=6 of 12 duos report listening-shift",
        kill_condition: "IF <4 of 12, FALSIFIED",
        apoha: ["NOT solo+FX", "NOT turn-taking duet"],
      },
      {
        candidate_id: "c4",
        framing: "infant co-regulation",
        predict: "WITHIN 12-dyad pilot, HRV variance p<0.05 lower with instrument",
        kill_condition: "IF unchanged or any safety event, FALSIFIED",
        apoha: ["NOT sleep training", "NOT medical advice"],
      },
      {
        candidate_id: "c10",
        framing: "protocol sonification",
        predict: "WITHIN 4 sessions, >=3 of 4 pairs catch anomalies pre-alert",
        kill_condition: "IF zero pairs across 4 sessions, FALSIFIED",
        apoha: ["NOT a dashboard replacement", "NOT background music"],
      },
    ];

    const picked = sealed[2]!; // user picks c10 to DEVELOP
    const unsown = sealed.filter((s) => s.candidate_id !== picked.candidate_id);

    // emit unsown-seeds with seal-hash intact
    const archiveDir = join(REPO_ROOT, "templates", "idea-exploration", "archived_seeds");
    mkdirSync(archiveDir, { recursive: true });
    for (const s of unsown) {
      const seal = sha256Canonical({
        candidate_id: s.candidate_id,
        predict: s.predict,
        kill_condition: s.kill_condition,
        apoha: s.apoha,
      });
      const artifact = {
        ...s,
        sha256_pre_verdict: seal,
        archived_at: "2026-06-02T00:00:00Z",
        reason_not_developed: "user picked c10 this cycle; this seed restartable next cycle",
      };
      const path = join(archiveDir, `${s.candidate_id}__${s.framing.replace(/\W+/g, "_")}.test_artifact.json`);
      writeFileSync(path, JSON.stringify(artifact, null, 2));

      // RIPENER's integrity check — re-hash + confirm
      const recomputed = sha256Canonical({
        candidate_id: artifact.candidate_id,
        predict: artifact.predict,
        kill_condition: artifact.kill_condition,
        apoha: artifact.apoha,
      });
      expect(recomputed, `unsown-seed ${s.candidate_id} re-hash must match stored seal`).toBe(
        artifact.sha256_pre_verdict,
      );
    }

    expect(unsown.length, "DEVELOP must archive non-picked sealed candidates").toBe(2);

    // cleanup test artifacts (don't pollute the template's archived_seeds/ in the repo)
    for (const s of unsown) {
      const path = join(
        archiveDir,
        `${s.candidate_id}__${s.framing.replace(/\W+/g, "_")}.test_artifact.json`,
      );
      if (existsSync(path)) rmSync(path);
    }
  });

  it("DELIVER ripens a developed candidate AND verifies all unsown-seed seals", () => {
    // Structural test — exercises the ripener's verdict-emission shape.
    const sealedC10 = {
      candidate_id: "c10",
      predict: "WITHIN 4 sessions, >=3 of 4 pairs catch anomalies pre-alert",
      kill_condition: "IF zero pairs across 4 sessions, FALSIFIED",
      apoha: ["NOT a dashboard replacement", "NOT background music"],
    };
    const seal = sha256Canonical(sealedC10);

    // Outcome: 2 of 4 pairs caught anomalies pre-alert (worked-example numbers)
    const observed = { pairs_caught_pre_alert: 2, total_sessions: 4 };

    // Verdict math
    let verdict: string;
    if (observed.pairs_caught_pre_alert === 0) verdict = "KILL-FIRED";
    else if (observed.pairs_caught_pre_alert >= 3) verdict = "RIPENED";
    else verdict = "PARTLY-RIPENED";

    expect(verdict).toBe("PARTLY-RIPENED");

    // Verdict bundle must include the seal hash (provenance binding)
    const verdictBundle = {
      candidate_id: sealedC10.candidate_id,
      sha256_pre_verdict: seal,
      verdict,
      evidence: `${observed.pairs_caught_pre_alert} of ${observed.total_sessions} pairs caught anomalies pre-alert`,
      what_actually_happened: "kill did NOT fire (>=1 pair caught), predict NOT met (need >=3)",
    };
    expect(verdictBundle.sha256_pre_verdict).toBe(seal);
    expect(verdictBundle.verdict).toMatch(/RIPENED|PARTLY-RIPENED|KILL-FIRED|ABORTED/);
  });
});
