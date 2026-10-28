// THE GATE ON EVERY ROUND, MEASURED ON THE CLAIM — Vör's plant for #596, driven end to end.
//
// tests/amend_gate_every_round.test.ts proves the engine re-runs a gate on every amend round, with stub
// seats. This file measures the claim the cure exists for: chancery-red-drafting-v0 AS HELD in the genome,
// run through runGig, with the REAL scope-gate skill reading a REAL git tree. Round one's staged diff is in
// scope; the reviewer fails it; the drafter's amend stages an edit to a law the scope does not name. The
// scope gate must refuse that amended diff, naming the law, before the reviewer is seated again.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { runGig, type AgentInvoker, type GigProgressEvent } from "../src/runtime.js";
import type { Standard } from "../src/composition.js";
import { coreInvariantFields } from "./_support/specs.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SLUG = "chancery-red-drafting-v0";
const GATE_DIR = join(ROOT, "skills", "scope-gate");
const BASELINE_DIR = join(ROOT, "skills", "baseline-gate");
const genome = loadGenome(ROOT);
const registry = createRegistry([...genome.domain_types.values()] as never);

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const LAW_SEALED = "institution:charter:sealed-and-amended-under-its-sponsors-governor"; // NOT in the scope
const LAW_NAMED = "institution:charter:the-charter-is-testable";                        // in the scope
const S_SEALED = "A charter is sealed and amended under its sponsor's governor.";
const S_NAMED = "A charter states a law that can be run.";
const lawForm = (id: string, statement: string): string => `(law "${id}"\n  (statement "${statement}")\n  (status green)\n  (plant "p"))\n\n`;
const BASE_LAWS = lawForm(LAW_SEALED, S_SEALED) + lawForm(LAW_NAMED, S_NAMED);

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.email=law@example.test", "-c", "user.name=law", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: GIT_ENV });
const writeRel = (dir: string, rel: string, text: string): void => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };

function repo(): { dir: string; baseline: string } {
  const dir = mkdtempSync(join(tmpdir(), "amend-gate-")); tmps.push(dir);
  git(dir, "init", "-q");
  writeRel(dir, "crossing/laws.sx", BASE_LAWS);
  // the repository's declared loop result (DS-5's baseline-gate reads it): every law passes, its plant "p" red. The
  // statement edits this plant makes move no verdict, so the baseline holds and only the scope gate can refuse.
  writeRel(dir, "loop/loop-result", `#!/usr/bin/env node\nconst t = require("fs").readFileSync("crossing/laws.sx", "utf8");\nprocess.stdout.write(JSON.stringify({ laws: [...t.matchAll(/\\(law "([^"]+)"/g)].map((m) => ({ id: m[1], verdict: "pass", plants: [{ id: "p", outcome: "red" }] })) }));\n`);
  chmodSync(join(dir, "loop/loop-result"), 0o755);
  git(dir, "add", "--", "crossing/laws.sx", "loop/loop-result");
  git(dir, "commit", "-q", "-m", "baseline");
  return { dir, baseline: git(dir, "rev-parse", "HEAD").trim() };
}

const SPEC = "eir:spec.chancery.the-testable-charter";
const HASH = "c".repeat(64);
const VOR = "principal:vor";
const SCOPE = { files: ["crossing/laws.sx"], laws: [LAW_NAMED], terms: [] as string[] };

describe("the scope gate runs on every amend round of chancery-red-drafting-v0, in a real tree", () => {
  it("G4 (Vör's plant, end to end) — round one in scope, the reviewer fails it, the amend edits an unscoped law: the scope gate refuses it by name and the reviewer is not seated again", { timeout: 60_000 }, async () => {
    const std = (genome.standards.get(SLUG) ?? genome.draft_standards.get(SLUG)) as Standard | undefined;
    expect(std, `${SLUG} is not in the genome`).toBeDefined();
    expect(std!.max_examine_rounds ?? 0, "the standard must budget amend rounds for this plant to mean anything").toBeGreaterThan(0);
    const r = repo();
    const seated: string[] = [];
    let drafts = 0;
    const invoke: AgentInvoker = (ctx) => {
      seated.push(ctx.role ?? ctx.agent.slug);
      if ((ctx.role ?? "") === "draft") {
        drafts++;
        // round one: amend only the NAMED law (in scope). The amend: also rewrite the sealed law (out of scope).
        let text = BASE_LAWS.replace(S_NAMED, "A charter states a law that can be run, and it is run.");
        if (drafts > 1) text = text.replace(S_SEALED, "A charter is sealed and amended under nobody's governor.");
        writeRel(r.dir, "crossing/laws.sx", text);
        git(r.dir, "add", "--", "crossing/laws.sx");
        return {
          ...coreInvariantFields("Artifact"),
          validation_criteria: ["each law is observed red"], input_refs: [], testing_method: "pgTAP",
          laws: [{ path: "crossing/laws.sx", commit: r.baseline }], coverage_map: [{ invariant_id: LAW_NAMED, test_name: "the named law is run", test_file: "crossing/laws.sx", kind: "behavioural", drives: "door — crossing/laws.sx", plant: "drop the named law from crossing/laws.sx" }], spec_doc: `draft ${drafts}`,
        };
      }
      // the reviewer: fails round one, passes any later look
      const looks = seated.filter((s) => s === (ctx.role ?? ctx.agent.slug)).length;
      return {
        ...coreInvariantFields("Verdict"),
        pass: looks > 1, target_ref: "red-spec", inferred_not_run: [], recommendation: looks > 1 ? "accept" : "amend",
        checks: [{ method: "a plant is missing for the named law", target_ref: LAW_NAMED, result: looks > 1 ? "holds" : "fails" }],
      };
    };
    const events: GigProgressEvent[] = [];
    const request = {
      source: "eugene", request_text: "Draft the red laws.", acceptance_criteria: ["each law is observed red"],
      spec: SPEC, content_hash: HASH, spec_grade: "g1", scope: SCOPE, baseline_commit: r.baseline, branch: "red/x",
    };
    let err: unknown;
    const outputs = createOutputStore(registry);
    try {
      await runGig(std!, { "change-request": request }, {
        outputs, ledger: new MemoryLedger(), invoke,
        skill_dirs: new Map([["scope-gate", GATE_DIR], ["baseline-gate", BASELINE_DIR]]),
        tree_root: r.dir,
        spec_grades: { conformance_seat: VOR, grades: [{ id: "g1", record: { spec: SPEC, content_hash: HASH, verdict: "PASS", scope: SCOPE.laws, by: VOR } }] },
        onProgress: (e: GigProgressEvent) => events.push(e),
      } as never);
    } catch (e) { err = e; }
    // DS-7: the standard declares refuse_when_unresolved, so a gate that stops the loop ends the gig refused, naming it.
    expect(String((err as Error)?.message ?? err), "the gig must end refused, naming the gate").toMatch(/gig refused \(refuse_when_unresolved\): the gate "scope"/);

    const reviewerSeats = seated.filter((s) => s === "review").length;
    expect(seated.filter((s) => s === "draft").length, "the drafter amended once").toBe(2);
    expect(reviewerSeats, "the reviewer is not seated after the gate refuses the amended diff").toBe(1);
    const gated = events.filter((e) => e.type === "amend_gated") as Array<GigProgressEvent & Record<string, unknown>>;
    expect(gated.length, "amend_gated names the gate").toBe(1);
    expect(gated[0]).toMatchObject({ gate: "scope" });
    const sv = outputs.all().filter((o) => o.domain_type === "scope-verdict").at(-1)!;
    expect(sv.data["pass"], "the scope gate refused the amended diff").toBe(false);
    expect(JSON.stringify(sv.data), "the refusal names the unscoped law").toContain(LAW_SEALED);
    const cv = outputs.all().filter((o) => o.domain_type === "change-verdict").at(-1)!;
    expect(cv.data["pass"], "the reviewer's round-one failing verdict stands").toBe(false);
  });
});
