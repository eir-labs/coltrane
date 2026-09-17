// RED — contract-skill-chair-runs-in-tree-v1. A chair's work happens in the GIG'S tree, whichever
// kind of seat does it. An agent chair already does: the records-by-address seal reads RunDeps.tree_root
// and refuses (tree_root_unknown) rather than falling back to process.cwd(). A SKILL-backed chair does
// NOT: its code half runs through executeSkillAsync (src/skill_subprocess.ts), which spawns
// `node <runner> <skillDir>` with NO `cwd` option (src/skill_subprocess.ts, the `spawn(...)` in
// executeSkillAsync), and the runtime callsite (src/runtime.ts, the `executeSkillAsync(p.skill_dir, …)`
// in executeChair) forwards no tree_root. So the child inherits the ENGINE process's working directory:
// the long-lived queue worker's own directory, not the claimed gig's workspace clone (src/worker.ts
// sets tree_root: workspace?.dir). A tier-2 skill that runs a command against "the tree" (e.g.
// run-vitest-band spawns `npx vitest run` with no cwd) therefore runs it against the worker's directory
// and reports THAT tree's verdict with full provenance — B while the record claims A. No shipped
// standard seats such a skill today (only patent-triage-v1's pure verdict-gate), so the defect is
// LATENT; every mechanical seat trips it on its first worker run. Spec:
// docs/specs/skill-chair-runs-in-tree.red-spec.md.
//
// The enforcement does NOT exist yet: executeSkillAsync's spawn options carry no cwd, so the child's
// working directory is the engine process's, never the run's tree_root. Every law here FAILS today on
// an assertion stating the contract's reason — never on an import or a setup error.
//
// TESTING METHOD — example-based, at the REAL seam the contract's output crosses: a skill-backed chair
// run through runGig, exactly as tests/skill_chair_integration.test.ts drives one. A real skill package
// (meta.json + skill.mjs) is written to a temp directory and registered through RunDeps.skill_dirs; its
// code half returns process.cwd() (the child's OWN working directory) as the sealed output. RunDeps.
// tree_root is a SEPARATE temp directory that differs from the test process's cwd, so a child that
// honoured it reports a directory the engine process never sat in. Working directories are compared by
// realpath (macOS routes the system temp dir through a /var → /private/var symlink, and process.cwd()
// resolves it, so a raw string compare would spuriously differ). The skill is tier 0 — process.cwd()
// reads a process property, not the filesystem, so no fs grant is involved and the sandbox is untouched.
//
// CONTROLS (must stay green, unchanged) — the standing skill-chair / executeSkillAsync laws this
// contract only re-anchors the working directory of: tests/skill_chair_integration.test.ts,
// tests/skill_chair_core_resolution.test.ts, tests/skill_chair_server_dispatch.test.ts,
// tests/skill_abort.test.ts (the executeSkillAsync async path), tests/skill_run_vitest_band.test.ts,
// and the permission-tier suite tests/skill_sandbox_confinement.test.ts. Nothing here weakens them.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeStandard,
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type Chair,
  type PhaseDef,
  type AgentInvoker,
} from "../src";

// ── a real skill package whose code half reports the child's OWN working directory ──────────────────
// tier 0: process.cwd() is a process property, not a filesystem read, so no fs grant is needed and the
// permission cage is exercised exactly as a pure skill's. `source` is the Signal core's substance floor,
// so the sealed output validates (the same reason number-adder returns one).
const PROBE_META = JSON.stringify({
  slug: "cwd-probe", version: 1, skill_type: "extraction",
  input_type: "any", output_type: "cwd-report", determinism_ratio: 1.0,
  permission: { tier: 0 },
  description: "Report the working directory the skill child was spawned in.",
});
const PROBE_CODE = [
  "// cwd-probe — the execution half. Returns the child process's OWN working directory, so the",
  "// sealed output records the tree the skill actually ran in. Nothing here reads the filesystem.",
  "export default function run() {",
  '  return { cwd: process.cwd(), source: "skill://cwd-probe@1" };',
  "}",
  "",
].join("\n");

let SKILL_DIR: string;
beforeAll(() => {
  SKILL_DIR = mkdtempSync(join(tmpdir(), "cwd-probe-skill-"));
  writeFileSync(join(SKILL_DIR, "meta.json"), PROBE_META);
  writeFileSync(join(SKILL_DIR, "skill.mjs"), PROBE_CODE);
});
afterAll(() => { rmSync(SKILL_DIR, { recursive: true, force: true }); });

const real = (p: string): string => realpathSync(p);

const skillChair = (role: string, skill_slug: string, opts: Partial<Chair> = {}): Chair => ({
  role, agent_slug: "", skill_slug,
  depends_on: opts.depends_on ?? [],
  input_contract: opts.input_contract ?? [],
  output_contract: opts.output_contract ?? ["Signal"],
  required_skills: [],
});

// The model must NEVER run for a skill chair; if it does, the chair is misrouted and the cwd claim
// would be meaningless — so the invoker throws to make that failure loud.
const noModel: AgentInvoker = () => { throw new Error("the model must not run for a skill-backed chair"); };

// Run the cwd-probe skill chair through runGig under the given tree_root (or none), returning the
// working directory the child reported (realpath-resolved). This is the REAL seam: runGig →
// executeChair → executeSkillAsync spawn.
const probeCwd = async (tree_root: string | undefined): Promise<string> => {
  const std = composeStandard({
    slug: "cwd-probe-std", domain: "test", agents: [],
    phases: [{ name: "probe", chairs: [skillChair("prober", "cwd-probe")] } as PhaseDef],
  });
  const outputs = createOutputStore(createRegistry());
  const deps = {
    outputs, ledger: new MemoryLedger(), invoke: noModel,
    skill_dirs: new Map([["cwd-probe", SKILL_DIR]]),
    ...(tree_root !== undefined ? { tree_root } : {}),
  };
  const res = await runGig(std, { seed: 1 }, deps as never);
  expect(res.status, "the skill chair must complete").toBe("complete");
  const reported = (res.outputs[0]!.data as Record<string, unknown>)["cwd"];
  expect(typeof reported, "the skill child must report its working directory").toBe("string");
  return real(reported as string);
};

// ── O1 — a skill chair's code half runs in a child whose working directory is tree_root ──────────────
describe("O1 — when RunDeps.tree_root is set, a skill chair's code half runs with cwd = tree_root", () => {
  it("the skill child's working directory is tree_root, not the engine process's directory", async () => {
    const treeRoot = mkdtempSync(join(tmpdir(), "skill-tree-o1-"));
    try {
      expect(real(treeRoot), "the fixture tree_root must differ from the test process's cwd for the claim to have teeth")
        .not.toBe(real(process.cwd()));
      const reported = await probeCwd(treeRoot);
      expect(reported,
        "O1 — the skill child must be spawned with cwd = tree_root so its work happens in the gig's tree; today executeSkillAsync spawns with no cwd, so the child inherits the engine process's directory and runs against the worker's own tree, not the gig's clone")
        .toBe(real(treeRoot));
      expect(reported,
        "O1 — and it must NOT be the engine process's working directory, which is exactly what the run's tree_root exists to override")
        .not.toBe(real(process.cwd()));
    } finally { rmSync(treeRoot, { recursive: true, force: true }); }
  });
});

// ── I1 — the working directory follows the run, not the engine process ───────────────────────────────
describe("I1 — the working directory follows the run, not the engine process", () => {
  it("two runGig calls in the same process with different tree_roots each report their OWN tree_root", async () => {
    const treeA = mkdtempSync(join(tmpdir(), "skill-tree-i1a-"));
    const treeB = mkdtempSync(join(tmpdir(), "skill-tree-i1b-"));
    try {
      expect(real(treeA), "the two runs' tree_roots must be distinct").not.toBe(real(treeB));
      const reportedA = await probeCwd(treeA);
      const reportedB = await probeCwd(treeB);
      expect(reportedA,
        "I1 — run A's skill child must report run A's own tree_root; today the working directory is the shared engine process's, ignoring tree_root entirely")
        .toBe(real(treeA));
      expect(reportedB,
        "I1 — run B's skill child must report run B's own tree_root, not run A's and not the engine process's")
        .toBe(real(treeB));
      expect(reportedA,
        "I1 — the working directory is chosen PER RUN, so two runs with different tree_roots must differ; today both inherit the one engine-process directory and are identical")
        .not.toBe(reportedB);
    } finally {
      rmSync(treeA, { recursive: true, force: true });
      rmSync(treeB, { recursive: true, force: true });
    }
  });
});

// ── I2 — a run with no tree_root is unchanged (falls back to the engine process's directory) ─────────
describe("I2 — a run with no tree_root is unchanged: the skill reports the engine process's directory", () => {
  it("with no tree_root the skill reports the test process's cwd, while a tree_root run in the same process reports its tree_root", async () => {
    const treeRoot = mkdtempSync(join(tmpdir(), "skill-tree-i2-"));
    try {
      // The fallback branch: NO tree_root ⇒ the child inherits the engine (test) process's directory,
      // exactly as today. This half is the unchanged behaviour the contract preserves.
      const reportedNone = await probeCwd(undefined);
      expect(reportedNone,
        "I2 — with no tree_root there is nothing to anchor to, so the skill child runs in the engine process's own directory (process.cwd()), unchanged from today")
        .toBe(real(process.cwd()));
      // The contrast that gives I2 teeth and fails today: a tree_root run IN THE SAME PROCESS must NOT
      // land in that same fallback directory — the fallback is reached only when tree_root is absent.
      const reportedTree = await probeCwd(treeRoot);
      expect(reportedTree,
        "I2 — a run WITH a tree_root must land in its tree_root, not the no-tree_root fallback directory; today the tree_root run inherits the SAME engine-process directory as the no-tree_root run, so the fallback is not a distinct branch at all")
        .toBe(real(treeRoot));
      expect(reportedTree,
        "I2 — the no-tree_root fallback directory (process.cwd()) is precisely the directory a tree_root run must escape; today they coincide")
        .not.toBe(reportedNone);
    } finally { rmSync(treeRoot, { recursive: true, force: true }); }
  });
});
