// DS-5 — drafting:the-baseline-holds, DRIVEN (wiki spec.chancery.the-testable-charter.drafting-standard rev 4).
//
// The law protecting every unscoped law had never run: compareBaselineLoop had no caller, its test asserted only that
// the symbol exists, and the review seat it fell to may not make the throwaway trees a comparison needs (DS-3). Found by
// a paid drain run (gig d0e332e8). The cure seats a skill-backed `baseline` chair between scope and review. Its
// acceptance is this: chancery-red-drafting-v0 AS HELD, through runGig, with the real scope-gate and baseline-gate skills
// in a real git tree whose `loop/loop-result` reports each law's verdict and each plant's outcome.
//
// Plant: the drafter amends a SCOPED term so that an UNSCOPED law passes its own plant. The scope gate admits it (the
// term is named); only the baseline holds can see it, and must refuse it, naming the law and the plant, before review.
// Twin: the drafter adds a law and leaves the term alone; the baseline passes and the reviewer is seated.
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
import { runGig, type AgentInvoker } from "../src/runtime.js";
import type { Standard } from "../src/composition.js";
import { coreInvariantFields } from "./_support/specs.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const genome = loadGenome(ROOT);
const registry = createRegistry([...genome.domain_types.values()] as never);
const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const UNSCOPED = "fixture:the-greeting-is-polite";
const NEW = "fixture:the-greeting-names-the-guest";
const TERM = "polite-word";
// laws.sx: each law's check may name a term as {term}; each plant is "<id>" "<shell mutation>" run in a throwaway copy
const LAWS = `(law "${UNSCOPED}"\n  (check "grep -q '{${TERM}}' src/greeting.txt")\n  (plant "drop-please" "sed -i.bak 's/please//' src/greeting.txt"))\n\n`;
const TERMS = (v: string) => `(term "${TERM}"\n  (value "${v}"))\n`;
// loop/loop-result: the repository's declared loop result, as JSON (BaselineLoopResult)
const LOOP_RESULT = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), os = require("os"), { spawnSync, execSync } = require("child_process");
const terms = {}; for (const m of fs.readFileSync("crossing/terms.sx", "utf8").matchAll(/\\(term "([^"]+)"\\s*\\(value "([^"]*)"\\)\\)/g)) terms[m[1]] = m[2];
const sub = (c) => c.replace(/\\{([^}]+)\\}/g, (_, t) => terms[t] ?? "");
const text = fs.readFileSync("crossing/laws.sx", "utf8"); const laws = [];
for (const m of text.matchAll(/\\(law "([^"]+)"\\s*\\(check "((?:[^"\\\\]|\\\\.)*)"\\)((?:\\s*\\(plant "[^"]+" "(?:[^"\\\\]|\\\\.)*"\\))*)\\)/g)) {
  const check = sub(m[2].replace(/\\\\(.)/g, "$1"));
  const run = (dir) => spawnSync("bash", ["-c", check], { cwd: dir, stdio: "ignore" }).status === 0;
  const plants = [];
  for (const p of m[3].matchAll(/\\(plant "([^"]+)" "((?:[^"\\\\]|\\\\.)*)"\\)/g)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plant-")); execSync("cp -R . " + JSON.stringify(dir));
    spawnSync("bash", ["-c", p[2].replace(/\\\\(.)/g, "$1")], { cwd: dir, stdio: "ignore" });
    plants.push({ id: p[1], outcome: run(dir) ? "green" : "red" }); fs.rmSync(dir, { recursive: true, force: true });
  }
  laws.push({ id: m[1], verdict: run(".") ? "pass" : "fail", plants });
}
process.stdout.write(JSON.stringify({ laws }));
`;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=l@x", "-c", "user.name=l", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: GIT_ENV });
const w = (dir: string, rel: string, text: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "baseline-gate-")); tmps.push(dir);
  git(dir, "init", "-q");
  w(dir, "crossing/laws.sx", LAWS); w(dir, "crossing/terms.sx", TERMS("please")); w(dir, "src/greeting.txt", "Hello, please come in.\n");
  w(dir, "loop/loop-result", LOOP_RESULT); chmodSync(join(dir, "loop/loop-result"), 0o755);
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "baseline");
  return { dir, baseline: git(dir, "rev-parse", "HEAD").trim() };
}

const SPEC = "eir:spec.chancery.the-testable-charter";
const H = "c".repeat(64), VOR = "principal:vor";
async function drive(stageAmend: (dir: string) => void) {
  const std = (genome.standards.get("chancery-red-drafting-v0") ?? genome.draft_standards.get("chancery-red-drafting-v0")) as Standard;
  const r = repo();
  const seated: string[] = [];
  const invoke: AgentInvoker = (ctx) => {
    seated.push(ctx.role ?? ctx.agent.slug);
    if ((ctx.role ?? "") === "draft") {
      stageAmend(r.dir);
      git(r.dir, "add", "-A", "crossing");
      return { ...coreInvariantFields("Artifact"), validation_criteria: ["observed red"], input_refs: [], testing_method: "loop/loop-result",
        laws: [{ path: "crossing/laws.sx", commit: r.baseline }], spec_doc: "draft",
        coverage_map: [{ invariant_id: NEW, test_name: "the guest is named", test_file: "crossing/laws.sx", kind: "behavioural", drives: "loop/loop-result — crossing/laws.sx", plant: "remove the guest's name from src/greeting.txt" }] };
    }
    return { ...coreInvariantFields("Verdict"), pass: true, target_ref: "red-spec", inferred_not_run: [], recommendation: "accept", checks: [{ method: "observed", target_ref: NEW, result: "holds" }] };
  };
  const outputs = createOutputStore(registry);
  let err: unknown;
  try {
    await runGig(std, { "change-request": { source: "eugene", request_text: "Add the guest law.", acceptance_criteria: ["observed red"], spec: SPEC, content_hash: H, spec_grade: "g1",
      scope: { files: ["crossing/laws.sx", "crossing/terms.sx"], laws: [NEW], terms: [TERM] }, baseline_commit: r.baseline, branch: "red/x" } }, {
      outputs, ledger: new MemoryLedger(), invoke, tree_root: r.dir,
      skill_dirs: new Map([["scope-gate", join(ROOT, "skills", "scope-gate")], ["baseline-gate", join(ROOT, "skills", "baseline-gate")]]),
      spec_grades: { conformance_seat: VOR, grades: [{ id: "g1", record: { spec: SPEC, content_hash: H, verdict: "PASS", scope: [NEW], by: VOR, held_seat: true } }] },
    } as never);
  } catch (e) { err = e; }
  return { err, seated, outputs };
}

describe("DS-5 driven — the baseline-gate chair holds every unscoped law to the baseline, in every round, before review", () => {
  it("DS-5 — chancery-red-drafting-v0 seats a skill-backed `baseline` chair between scope and review", () => {
    const std = (genome.standards.get("chancery-red-drafting-v0") ?? genome.draft_standards.get("chancery-red-drafting-v0")) as Standard;
    const order = std.phases.flatMap((p) => p.chairs.map((c) => c.role));
    expect(order, "no baseline chair: DS-5 is a function no gig calls").toEqual(["draft", "scope", "baseline", "review"]);
    const b = std.phases.flatMap((p) => p.chairs).find((c) => c.role === "baseline") as { skill_slug?: string } | undefined;
    expect(b?.skill_slug).toBe("baseline-gate");
  });

  it("DS-5 plant, driven — a scoped term amended so an UNSCOPED law passes its own plant: refused by baseline-gate, naming the law and the plant, the reviewer never seated", { timeout: 60_000 }, async () => {
    const d = await drive((dir) => {
      w(dir, "crossing/terms.sx", TERMS(""));
      w(dir, "crossing/laws.sx", LAWS + `(law "${NEW}"\n  (check "grep -qE 'Ada|Grace' src/greeting.txt")\n  (plant "drop-name" "true"))\n\n`);
    });
    expect(d.seated.filter((s) => s === "review").length, "the reviewer was seated over a baseline the branch broke").toBe(0);
    const bv = d.outputs.all().filter((o) => o.domain_type === "baseline-verdict").at(-1);
    expect(bv?.data["pass"], "no failing baseline-verdict was sealed").toBe(false);
    const said = JSON.stringify(bv?.data ?? {});
    expect(said).toContain(UNSCOPED);
    expect(said).toContain("drop-please");
  });

  it("DS-5 twin, driven — a red pass that adds a law and leaves the term alone passes baseline-gate and the reviewer is seated", { timeout: 60_000 }, async () => {
    const d = await drive((dir) => {
      w(dir, "crossing/laws.sx", LAWS + `(law "${NEW}"\n  (check "grep -qE 'Ada|Grace' src/greeting.txt")\n  (plant "drop-name" "true"))\n\n`);
    });
    const bv = d.outputs.all().filter((o) => o.domain_type === "baseline-verdict").at(-1);
    expect(bv?.data["pass"], `baseline-gate refused an honest red pass: ${JSON.stringify(bv?.data ?? {}).slice(0, 400)}`).toBe(true);
    expect(d.seated.filter((s) => s === "review").length).toBeGreaterThanOrEqual(1);
  });
});
