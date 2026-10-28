// RED — the drafting standard `chancery-red-drafting-v0` (DS-1 … DS-5). Spec:
// docs/specs/chancery-red-drafting.red-spec.md. Contract source: Eugene's ruling, 27 Oct 2026; spec wiki
// eir:spec.chancery.the-testable-charter.drafting-standard rev 2 (content_sha e23773db…6524), graded PASS
// by Vör.
//
// WHAT IS RED TODAY, and why. Nothing this contract names exists: no standard
// `standards/chancery-red-drafting-v0.json`, no agents `chancery-red-drafter` / `chancery-red-reviewer`, no
// skill package `skills/scope-gate/`, no domain type `scope-verdict`, no reader of a `spec_grade` record on
// the run path, no baseline-vs-branch comparison. The records are landed later by the operator through the
// engine's genome door; the engine enforcement (DS-2…DS-5) is built later by a seat that writes only
// src/** and docs/**. So every law below reaches the thing it guards AT RUNTIME, never by import: the
// genome is loaded from the repo root through the production loader (loadGenome), the standard is composed
// through the production compose path (composeStandard), the skill is run through the production skill
// execution path (executeSkillAsync — what a skill-backed chair spawns), the gig is run through runGig, and
// the not-yet-exported comparison is read off the engine's public entry (src/index.ts) at call time. Each
// law FAILS today on an assertion that states the contract's reason — never on an import or type error.
//
// TESTING METHOD — example-based throughout. Every invariant here is a specific behaviour with a named
// plant (a refusal with the offending file/id/chair named), not a universal property over a generated
// space, so property-based generation would add an engine and no teeth. Each refusal law is paired with a
// CONTROL that must be admitted, so a gate that refuses everything cannot pass. DS-1 and DS-5 build a
// throwaway git repo in a temp dir (no chancery-os checkout is read).
//
//   law   kind         drives                                                       plant (smallest production edit → red)
//   DS-1  behavioural  executeSkillAsync(skills/scope-gate) — src/skill_subprocess  make the gate skip the diff of crossing/laws.sx / terms.sx
//                      over a real git repo's staged diff                           id check (accept any id), or drop the file-set subset check
//   DS-2  behavioural  composeStandard — src/composition.ts, on the genome as       delete the compose-time refusal of a model seat at `scope`
//                      loaded by loadGenome — src/loader.ts
//   DS-3  behavioural  composeStandard + seatEffectiveTools — src/composition.ts,   delete the compose-time refusal of drafter-at-review /
//                      src/chart.ts                                                 a write grant at `review`
//   DS-4  behavioural  runGig — src/runtime.ts, with a recording invoker and        delete the spec_grade admission at the head of runGig
//                      RunDeps.spec_grades (the seam this red-spec fixes)           (or admit on verdict alone)
//   DS-5  behavioural  compareBaselineLoop — src/index.ts (the seam this red-spec    make the comparison ignore plant outcomes, or ignore
//                      fixes), over loop results taken from a real git repo         the scope's exemption direction
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as engine from "../src/index.js";
import { composeStandard, defineAgent, CompositionError } from "../src/composition.js";
import type { Agent, Chair, PhaseDef, Standard } from "../src/composition.js";
import { loadGenome } from "../src/loader.js";
import { loadSkillPackage } from "../src/skills.js";
import { executeSkillAsync } from "../src/skill_subprocess.js";
import { seatEffectiveTools } from "../src/chart.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { runGig, type AgentInvoker } from "../src/runtime.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SLUG = "chancery-red-drafting-v0";
const DRAFTER = "chancery-red-drafter";
const REVIEWER = "chancery-red-reviewer";
const GATE = "scope-gate";
const GATE_DIR = join(ROOT, "skills", GATE);

const genome = loadGenome(ROOT);
const registry = createRegistry([...genome.domain_types.values()] as never);

// ── temp dirs, cleaned up once ─────────────────────────────────────────────────────────────────────
const tmps: string[] = [];
const mktmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

// ── the standard AS HELD in the repo, through the production loader ────────────────────────────────
// A standard at status `draft` loads into `draft_standards`, not `standards` (src/loader.ts), so both are
// read; the absence of either is the whole of what is red for DS-2/DS-3 today.
const held = (): Standard => {
  const std = genome.standards.get(SLUG) ?? genome.draft_standards.get(SLUG);
  expect(std, `standards/${SLUG}.json is not in the genome (loadGenome(repo root) holds neither standards nor draft_standards "${SLUG}"; load_errors: ${JSON.stringify(genome.load_errors.map((e) => e.slug))}) — the drafting standard does not exist yet`).toBeDefined();
  return std as Standard;
};
const allChairs = (std: Standard): Chair[] => std.phases.flatMap((p) => [...p.chairs]);
const chairByRole = (std: Standard, role: string): Chair => {
  const c = allChairs(std).find((x) => x.role === role);
  expect(c, `${SLUG} has no chair "${role}" (chairs: ${allChairs(std).map((x) => x.role).join(", ")})`).toBeDefined();
  return c as Chair;
};
const agentOf = (std: Standard, slug: string): Agent => {
  const a = std.agents.find((x) => x.slug === slug);
  expect(a, `${SLUG} does not seat agent "${slug}" (agents: ${std.agents.map((x) => x.slug).join(", ")})`).toBeDefined();
  return a as Agent;
};

/** Recompose a loaded standard through the PRODUCTION compose path, optionally over mutated agents/phases. */
function recompose(std: Standard, over: { agents?: readonly Agent[]; phases?: readonly PhaseDef[] } = {}): Standard {
  return composeStandard({
    slug: std.slug, domain: std.domain,
    ...(std.status !== undefined ? { status: std.status } : {}),
    agents: over.agents ?? std.agents, phases: over.phases ?? std.phases,
    ...(std.eval_slugs !== undefined ? { eval_slugs: std.eval_slugs } : {}),
    ...(std.input_types !== undefined ? { input_types: std.input_types } : {}),
    ...(std.output_types !== undefined ? { output_types: std.output_types } : {}),
    ...(std.max_examine_rounds !== undefined ? { max_examine_rounds: std.max_examine_rounds } : {}),
    ...(std.description !== undefined ? { description: std.description } : {}),
    ...(std.reserve_pool !== undefined ? { reserve_pool: std.reserve_pool } : {}),
  });
}
const swapChair = (std: Standard, role: string, f: (c: Chair) => Chair): PhaseDef[] =>
  std.phases.map((ph) => ({ ...ph, chairs: ph.chairs.map((c) => (c.role === role ? f(c) : c)) }));
const GATE_REASON = /\b(model|deterministic|determinism|gate)\b/i;
const SELF_REVIEW_REASON = /\b(same|different|distinct|separate|independent|itself|self-review|cannot review|may not review|own work)\b/i;
const WRITE_REASON = /\b(write|write-capable|read-only|grant)\b/i;
const withoutCeiling =(c: Chair): Chair => { const { allowed_tools: _ceiling, ...rest } = c; return rest as Chair; };

/** Build the planted composition and demand it be REFUSED by composeStandard, naming `chair`. */
/** `reason` is a token the refusal must state beyond naming the chair: other compose rules (a missing
 *  input, an undeclared skill, a dead ceiling) also name the chair and the agent, so naming alone could
 *  pass for the wrong refusal. The tokens below are ones those unrelated messages do not contain. */
function refusedNamingChair(chair: string, build: () => unknown, what: string, reason: RegExp): string {
  let err: unknown;
  let composed = false;
  try { build(); composed = true; } catch (e) { err = e; }
  expect(composed, `composeStandard ACCEPTED ${what} — the standard composed; nothing refused it`).toBe(false);
  expect(err, `${what} failed for a reason other than a compose refusal (${String(err)}) — the plant must be refused BY composeStandard`).toBeInstanceOf(CompositionError);
  const msg = (err as Error).message;
  expect(msg, `the refusal of ${what} must name the "${chair}" chair; got: ${msg}`).toMatch(new RegExp(`\\b${chair}\\b`));
  expect(msg, `the refusal of ${what} must state its reason (${reason}), not merely name the chair; got: ${msg}`).toMatch(reason);
  return msg;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// DS-1 — drafting:scope-is-the-spec's. The scope gate, run as the production skill, on a real repo.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The .sx fixtures are THIS SPEC'S ASSUMPTION of crossing/laws.sx and crossing/terms.sx (no chancery-os
// checkout was readable): one `(law "<id>" …)` / `(term "<id>" …)` form per id, id a quoted string first
// after the head. If chancery-os's real grammar differs, the fixture — not the contract — is what moves.
const LAW_SEALED = "institution:charter:sealed-and-amended-under-its-sponsors-governor"; // NOT named in the scope
const LAW_NAMED = "institution:charter:the-charter-is-testable";                        // named, pre-existing
const LAW_NEW = "institution:charter:a-red-pass-leaves-a-branch";                        // named, to be added
const LAW_RENAMED = "institution:charter:the-charter-is-checkable";                      // NOT named
const LAW_UNNAMED_NEW = "institution:charter:an-unscoped-addition";                     // NOT named
const TERM_REFS = "record-refs-resolve";                                                  // NOT named
const TERM_NAMED = "law-has-a-plant";                                                     // named

const lawForm = (id: string, statement: string, uses: readonly string[], plant: string, status = "green"): string =>
  `(law "${id}"\n  (statement "${statement}")\n  (status ${status})\n${uses.map((t) => `  (uses-term "${t}")\n`).join("")}  (plant "${plant}"))\n\n`;
const termForm = (id: string, definition: string, strict = true): string =>
  `(term "${id}"\n  (definition "${definition}")\n  (strict ${strict}))\n\n`;

const S_SEALED = "A charter is sealed and amended under its sponsor's governor.";
const S_NAMED = "A charter states a law that can be run.";
const BASE_LAWS =
  lawForm(LAW_SEALED, S_SEALED, [TERM_REFS], "drop-the-governor-check") +
  lawForm(LAW_NAMED, S_NAMED, [TERM_NAMED], "drop-the-test") +
  lawForm("institution:charter:every-law-names-its-plant", "Every law names the plant that turns it red.", [], "name-no-plant");
const BASE_TERMS = termForm(TERM_REFS, "a reference names a record that exists") + termForm(TERM_NAMED, "a law carries a plant");
const BASE_LOOP = "#!/bin/sh\necho loop\n";

const SCOPE = {
  files: ["crossing/laws.sx", "crossing/terms.sx", "tests/testable_charter.red.sh"],
  laws: [LAW_NAMED, LAW_NEW],
  terms: [TERM_NAMED],
};

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=law@example.test", "-c", "user.name=law", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: GIT_ENV });
}
function writeRel(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

interface Repo { dir: string; baseline: string }
/** A throwaway git repo whose single commit is the baseline the red pass is measured from. */
function baselineRepo(): Repo {
  const dir = mktmp("chancery-drafting-");
  git(dir, "init", "-q");
  writeRel(dir, "crossing/laws.sx", BASE_LAWS);
  writeRel(dir, "crossing/terms.sx", BASE_TERMS);
  writeRel(dir, "loop/loop.sh", BASE_LOOP);
  git(dir, "add", "--", "crossing/laws.sx", "crossing/terms.sx", "loop/loop.sh");
  git(dir, "commit", "-q", "-m", "baseline");
  return { dir, baseline: git(dir, "rev-parse", "HEAD").trim() };
}
/** Write `files` into the repo and STAGE exactly those paths — the drafter's staged diff. */
function stage(repo: Repo, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) writeRel(repo.dir, rel, text);
  git(repo.dir, "add", "--", ...Object.keys(files));
}
const edit = (text: string, from: string, to: string): string => {
  expect(text, `fixture edit: "${from}" is not in the text it edits`).toContain(from);
  return text.replace(from, to);
};

/** Run the REAL scope-gate package — the skill execution a skill-backed chair spawns — in the repo. */
async function runGate(repo: Repo, scope = SCOPE): Promise<Record<string, unknown>> {
  expect(existsSync(join(GATE_DIR, "meta.json")), `skills/${GATE}/ does not exist — the scope gate is not built`).toBe(true);
  const r = await executeSkillAsync(GATE_DIR, { scope, baseline_commit: repo.baseline }, 60_000, { cwd: repo.dir });
  expect(r.ok, `the ${GATE} skill did not run to a verdict: ${r.error}`).toBe(true);
  expect(r.output && typeof r.output === "object", "the scope-gate skill must return a scope-verdict object").toBe(true);
  return r.output as Record<string, unknown>;
}
function expectRefusal(out: Record<string, unknown>, names: string, why: string): void {
  expect(out["pass"], `${why} — the verdict must be pass:false; got ${JSON.stringify(out).slice(0, 400)}`).toBe(false);
  expect(JSON.stringify(out), `${why} — the refusal must NAME ${names}`).toContain(names);
}

describe("DS-1 — drafting:scope-is-the-spec's: the scope gate refuses a red pass that leaves the scope", () => {
  it("DS-1 control — a diff touching only scoped files, amending only scoped ids, PASSES and seals as a scope-verdict", async () => {
    const repo = baselineRepo();
    stage(repo, {
      "crossing/laws.sx": edit(BASE_LAWS, S_NAMED, "A charter states a law that can be run, and the run is red.") +
        lawForm(LAW_NEW, "A red pass leaves a branch and publishes nothing.", [TERM_NAMED], "publish-from-the-pass"),
      "crossing/terms.sx": edit(BASE_TERMS, "a law carries a plant", "a law carries a plant that names the edit"),
      "tests/testable_charter.red.sh": "#!/bin/sh\nexit 1\n",
    });
    const out = await runGate(repo);
    expect(out["pass"], `the in-scope control must PASS the gate; got ${JSON.stringify(out).slice(0, 400)}`).toBe(true);
    expect(genome.domain_types.has("scope-verdict"), "the genome holds no domain type `scope-verdict` — the gate's output has no type to seal as").toBe(true);
    const v = registry.validate({ core_type: "Verdict", domain_type: "scope-verdict", data: { id: "scope-verdict-law", ...out } } as never);
    expect(v.valid, `the gate's output does not satisfy the genome's scope-verdict type: ${JSON.stringify(v.errors)}`).toBe(true);
  });

  it("DS-1 P1 — a red pass that amends a law the scope does not name (body only, id line untouched) is refused, naming that id", async () => {
    const repo = baselineRepo();
    stage(repo, { "crossing/laws.sx": edit(BASE_LAWS, S_SEALED, "A charter is sealed and amended under nobody's governor.") });
    expectRefusal(await runGate(repo), LAW_SEALED, "the diff edits the statement of an UNSCOPED law (its `(law \"id\"` line is not in the hunk)");
  });

  it("DS-1 P2 — a red pass that writes loop/loop.sh, which the scope's file list does not name, is refused, naming the file", async () => {
    const repo = baselineRepo();
    stage(repo, {
      "crossing/laws.sx": edit(BASE_LAWS, S_NAMED, "A charter states a law that can be run, and the run is red."),
      "loop/loop.sh": BASE_LOOP + "echo planted\n",
    });
    expectRefusal(await runGate(repo), "loop/loop.sh", "the diff writes a file outside the scope's file list");
  });

  it("DS-1 P3 — renaming a NAMED law to an id the scope does not list is refused, naming the new (unscoped) id", async () => {
    const repo = baselineRepo();
    stage(repo, { "crossing/laws.sx": edit(BASE_LAWS, `(law "${LAW_NAMED}"`, `(law "${LAW_RENAMED}"`) });
    expectRefusal(await runGate(repo), LAW_RENAMED, "a rename adds the new id, and the new id is not in the scope");
  });

  it("DS-1 P3b — a rename counts as removing the OLD id too: renaming an UNNAMED law to a named id is refused, naming the old id", async () => {
    const repo = baselineRepo();
    stage(repo, { "crossing/laws.sx": edit(BASE_LAWS, `(law "${LAW_SEALED}"`, `(law "${LAW_NEW}"`) });
    expectRefusal(await runGate(repo), LAW_SEALED, "a rename removes the old id, and the old id is not in the scope");
  });

  it("DS-1 P4 — adding a law whose id the scope does not name is refused, naming that id", async () => {
    const repo = baselineRepo();
    stage(repo, { "crossing/laws.sx": BASE_LAWS + lawForm(LAW_UNNAMED_NEW, "An addition nobody scoped.", [], "none") });
    expectRefusal(await runGate(repo), LAW_UNNAMED_NEW, "the diff adds a law id the scope does not name");
  });

  it("DS-1 P5 — amending a term the scope does not name (crossing/terms.sx) is refused, naming that term id", async () => {
    const repo = baselineRepo();
    stage(repo, { "crossing/terms.sx": edit(BASE_TERMS, "a reference names a record that exists", "a reference names anything") });
    expectRefusal(await runGate(repo), TERM_REFS, "the diff amends a term id the scope does not name");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// DS-2 — drafting:the-gate-is-not-a-model. The standard as held, and the model seat at `scope`.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
const modelSeatFitting = (chair: Chair, slug: string): Agent =>
  defineAgent({
    slug, primitives: ["INTERPRET"], input_types: [...chair.input_contract],
    identity: "a planted model seat", method: "read the inputs and answer", constraints: [],
    behavioral_primitives: ["analyst", "critic"],
  } as never);

describe("DS-2 — drafting:the-gate-is-not-a-model: `scope` is skill-backed and a model seat there fails to compose", () => {
  it("DS-2 control — the standard as held composes: draft(agent) → scope(skill scope-gate, no agent) → baseline(skill baseline-gate, DS-5) → review(agent), 3 examine rounds", () => {
    const std = held();
    expect(std.phases.map((p) => p.name), "phases, in order").toEqual(["draft", "scope", "baseline", "review"]);
    const draft = chairByRole(std, "draft"), scope = chairByRole(std, "scope"), review = chairByRole(std, "review");
    expect(draft.agent_slug).toBe(DRAFTER);
    expect(draft.output_contract).toEqual(["red-spec"]);
    expect(agentOf(std, DRAFTER).primitives, "the drafter's primitive is CREATE").toContain("CREATE");
    expect(scope.skill_slug, "`scope` must be SKILL-BACKED by scope-gate").toBe(GATE);
    expect(scope.agent_slug ?? "", "`scope` must hold no agent (no model seat)").toBe("");
    expect(scope.output_contract).toEqual(["scope-verdict"]);
    const baseline = chairByRole(std, "baseline");
    expect(baseline.skill_slug, "`baseline` must be SKILL-BACKED by baseline-gate (DS-5)").toBe("baseline-gate");
    expect(baseline.agent_slug ?? "", "`baseline` must hold no agent (no model seat)").toBe("");
    expect(baseline.output_contract).toEqual(["baseline-verdict"]);
    expect((genome.skills.get("baseline-gate") as unknown as { determinism_ratio?: number } | undefined)?.determinism_ratio, "the baseline gate's skill declares determinism_ratio 1.0").toBe(1);
    expect(review.agent_slug).toBe(REVIEWER);
    expect(review.output_contract).toEqual(["change-verdict"]);
    expect(agentOf(std, REVIEWER).primitives, "the reviewer's primitive is VERIFY").toContain("VERIFY");
    expect(std.max_examine_rounds, "a failing verdict returns to the drafter at most 3 times").toBe(3);
    const gate = genome.skills.get(GATE) as unknown as { determinism_ratio?: number } | undefined;
    expect(gate, `the genome holds no skill "${GATE}"`).toBeDefined();
    expect(gate?.determinism_ratio, "the scope gate's skill declares determinism_ratio 1.0").toBe(1);
    expect(() => recompose(std), "the standard as held must compose").not.toThrow();
  });

  it("DS-2 package — skills/scope-gate/ is a code-first skill declaring determinism_ratio 1.0, with fixtures", () => {
    expect(existsSync(join(GATE_DIR, "meta.json")), `skills/${GATE}/ does not exist`).toBe(true);
    const pkg = loadSkillPackage(GATE_DIR);
    expect(pkg.meta.slug).toBe(GATE);
    expect(pkg.meta.determinism_ratio, "determinism_ratio must be exactly 1.0 — the gate is not a model").toBe(1);
    expect(pkg.codeHash, "the gate must have a code half (skill.mjs)").not.toBeNull();
    expect(pkg.fixtures.length, "a skill ships its pre-registered fixtures").toBeGreaterThan(0);
  });

  it("DS-2 P1 — a model seat (an agent) at `scope`, in place of the skill, is REFUSED by composeStandard, naming the scope chair", () => {
    const std = held();
    const scope = chairByRole(std, "scope");
    const planted = modelSeatFitting(scope, "planted-model-seat");
    const phases = swapChair(std, "scope", (c) => { const { skill_slug: _skill, ...rest } = c; return { ...rest, agent_slug: planted.slug } as Chair; });
    refusedNamingChair("scope", () => recompose(std, { agents: [...std.agents, planted], phases }), "a model seat at `scope`", GATE_REASON);
  });

  it("DS-2 P2 — an agent seated AT `scope` alongside the skill (both set) is REFUSED, naming the scope chair", () => {
    const std = held();
    const scope = chairByRole(std, "scope");
    const planted = modelSeatFitting(scope, "planted-model-seat");
    const phases = swapChair(std, "scope", (c) => ({ ...c, agent_slug: planted.slug }));
    refusedNamingChair("scope", () => recompose(std, { agents: [...std.agents, planted], phases }), "an agent seated alongside the scope skill", GATE_REASON);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// DS-3 — drafting:the-drafter-cannot-review. Different seat, no write grant.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const baseName = (g: string): string => g.replace(/\(.*$/, "");
/** Whether a grant is write-capable: a write tool, or an UNSCOPED shell (a scoped `Bash(cmd:*)` is not). */
const isWriteGrant = (g: string): boolean => WRITE_TOOLS.has(baseName(g)) || g === "Bash";

/** The held standard with the reviewer agent re-defined to also hold `extra` (and `over`), the review
 *  chair's ceiling removed so the grant is EFFECTIVE, then recomposed. */
function composeWithReviewerGrant(std: Standard, extra: readonly string[], over: Record<string, unknown> = {}): Standard {
  const review = chairByRole(std, "review");
  const rev = agentOf(std, review.agent_slug);
  const planted = defineAgent({ ...rev, allowed_tools: [...(rev.allowed_tools ?? []), ...extra], ...over } as never);
  return recompose(std, {
    agents: std.agents.map((a) => (a.slug === rev.slug ? planted : a)),
    phases: swapChair(std, "review", withoutCeiling),
  });
}

describe("DS-3 — drafting:the-drafter-cannot-review: `review` is a different seat from the drafter and holds no write grant", () => {
  it("DS-3 control — as held: review is not the drafter's agent, its EFFECTIVE grant holds no write tool, and the standard composes", () => {
    const std = held();
    const draft = chairByRole(std, "draft"), review = chairByRole(std, "review");
    expect(review.agent_slug, "the review chair must be held by a different agent from the drafter").not.toBe(draft.agent_slug);
    const rev = agentOf(std, review.agent_slug);
    const effective = seatEffectiveTools(rev, review);
    expect(effective.filter(isWriteGrant), `the review seat's effective grant [${effective.join(", ")}] holds a write tool`).toEqual([]);
    // code_tool_access is a LADDER of what the cage keeps (src/claude_invoker.ts codeToolsKept), and a reviewer that
    // runs a scoped Bash must be `full` (tests/genome_behavioral_floor.test.ts) — so "no EFFECTIVE write" is: every
    // write tool the ladder would keep (write/full: Write, Edit…) is named in the agent's disallowed_tools.
    const keepsWrite = /^(write|full)$/.test(rev.code_tool_access ?? "none");
    const unDenied = keepsWrite ? [...WRITE_TOOLS].filter((t) => !(rev.disallowed_tools ?? []).includes(t)) : [];
    expect(unDenied, `the review seat's code_tool_access "${rev.code_tool_access}" keeps write tools its disallowed_tools [${(rev.disallowed_tools ?? []).join(", ")}] do not deny`).toEqual([]);
    expect(() => recompose(std), "the standard as held must compose").not.toThrow();
  });

  it("DS-3 P1 — the drafter (`chancery-red-drafter`) seated at `review` is REFUSED by composeStandard, naming the review chair and the drafter", () => {
    const std = held();
    const review = chairByRole(std, "review");
    const dr = agentOf(std, DRAFTER);
    // The drafter, widened so NOTHING but the self-review is wrong with this seating: it declares every
    // input and skill the review chair needs, and no mandate or ceiling can trip an unrelated compose rule.
    const widened = defineAgent({
      ...dr,
      input_types: [...new Set([...dr.input_types, ...review.input_contract])],
      skill_slugs: [...new Set([...(dr.skill_slugs ?? []), ...review.required_skills])],
      required_inputs: [],
    } as never);
    const phases = swapChair(std, "review", (c) => ({ ...withoutCeiling(c), agent_slug: DRAFTER }));
    const msg = refusedNamingChair("review", () => recompose(std, { agents: std.agents.map((a) => (a.slug === DRAFTER ? widened : a)), phases }), "the drafter seated at `review`", SELF_REVIEW_REASON);
    expect(msg, "the refusal must name the drafter it refused to seat at review").toContain(DRAFTER);
  });

  it("DS-3 P2 — a review seat whose effective grant includes `Write` is REFUSED, naming the review chair and the grant", () => {
    const std = held();
    const msg = refusedNamingChair("review", () => composeWithReviewerGrant(std, ["Write"]), "a review seat granted `Write`", WRITE_REASON);
    expect(msg, "the refusal must name the write grant").toContain("Write");
  });

  it("DS-3 P2b — Edit, MultiEdit and NotebookEdit are write grants too: each is REFUSED at `review`, naming the grant", () => {
    const std = held();
    for (const tool of ["Edit", "MultiEdit", "NotebookEdit"]) {
      const msg = refusedNamingChair("review", () => composeWithReviewerGrant(std, [tool]), `a review seat granted \`${tool}\``, WRITE_REASON);
      expect(msg, `the refusal must name the ${tool} grant`).toContain(tool);
    }
  });

  it("DS-3 P2c — an UNSCOPED `Bash` is a write-capable shell: a review seat granted it is REFUSED, naming the grant", () => {
    const std = held();
    const msg = refusedNamingChair("review", () => composeWithReviewerGrant(std, ["Bash"]), "a review seat granted an unscoped `Bash`", WRITE_REASON);
    expect(msg, "the refusal must name the Bash grant").toContain("Bash");
  });

  it("DS-3 P2d — code_tool_access `write` on the review seat's agent is a write grant: REFUSED, naming the review chair", () => {
    const std = held();
    refusedNamingChair("review", () => composeWithReviewerGrant(std, [], { code_tool_access: "write" }), "a review seat with code_tool_access=write", WRITE_REASON);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// DS-4 — drafting:only-a-graded-spec. runGig, with a recording invoker, on the spec_grade shape.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE SEAM THIS RED-SPEC FIXES (spec_grade is Chancery's and is not built here; only its SPECIFIED shape
// {spec, content_hash, verdict, scope, by} is used, with no field added). The gig's change-request names
// its record by id (`spec_grade`); Chancery supplies the spec's grades in record order, oldest first,
// alongside the id each is held under, and who holds the conformance seat, as `RunDeps.spec_grades`:
//   { conformance_seat: <principal>, grades: [{ id, record: {spec, content_hash, verdict, scope, by} }] }
interface SpecGrade { spec: string; content_hash: string; verdict: "PASS" | "HOLD"; scope: string[] | null; by: string }
const SPEC = "eir:spec.chancery.the-testable-charter.drafting-standard";
const H_OLD = "a".repeat(64);
const H_NEW = "b".repeat(64);
const VOR = "principal:vor";
const INTRUDER = "principal:someone-else";
const L1 = "drafting:scope-is-the-specs";
const L2 = "drafting:the-baseline-holds";
const grade = (over: Partial<SpecGrade> = {}): SpecGrade =>
  ({ spec: SPEC, content_hash: H_NEW, verdict: "PASS", scope: [L1, L2], by: VOR, ...over });
const changeRequest = (gradeId: string | undefined, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: "eugene", request_text: "Draft the RED laws DS-1 to DS-5.", acceptance_criteria: ["each law is observed red"],
  spec: SPEC, content_hash: H_NEW, ...(gradeId !== undefined ? { spec_grade: gradeId } : {}),
  scope: { files: ["tests/chancery_red_drafting.test.ts"], laws: [L1, L2], terms: [] },
  baseline_commit: "0".repeat(40), branch: "standard/chancery-red-drafting", ...over,
});

interface Driven { err: unknown; calls: string[]; message: string }
/**
 * The standard DS-4 runs. The REAL one when the genome holds it. Until the operator lands it, a stand-in
 * of the SAME slug seating one agent-backed `draft` chair (change-request → red-spec) — so these laws reach
 * `runGig` today and are red for the contract's reason (no reader of a spec_grade: the draft chair is
 * seated, the model is invoked, nothing refused) rather than for the missing standard. The stand-in carries
 * none of the guarded behaviour; it only gives runGig a chair to take. DS-2/DS-3, whose subject IS the
 * standard, never use it.
 */
function standardForDs4(): { std: Standard; key: string } {
  const real = genome.standards.get(SLUG) ?? genome.draft_standards.get(SLUG);
  if (real !== undefined) return { std: real, key: (real.input_types ?? []).includes("change-request") ? "change-request" : (real.input_types ?? [])[0] ?? "change-request" };
  // The gig-input key of the stand-in is a type the registry does NOT hold: the genome's `change-request`
  // type is closed (additionalProperties:false) and would refuse the contract's fields at the door before
  // any gate could read them — see the "DS-4 input" law. An unheld type is not shape-checked by runGig.
  const KEY = "drafting-request";
  const seat = defineAgent({
    slug: DRAFTER, primitives: ["INTERPRET"], input_types: [KEY], output_types: ["red-spec"],
    identity: "a stand-in drafter", method: "answer", constraints: [], behavioral_primitives: ["executor", "critic"],
  } as never);
  return { key: KEY, std: composeStandard({
    slug: SLUG, domain: "spec-drafting", agents: [seat], input_types: [KEY], output_types: ["red-spec"],
    phases: [{ name: "draft", chairs: [{
      role: "draft", agent_slug: DRAFTER, depends_on: [], input_contract: [KEY],
      output_contract: ["red-spec"], required_skills: [],
    } as Chair] }],
  }) };
}
async function drive(grades: { id: string; record: SpecGrade }[], input: Record<string, unknown>, seat = VOR): Promise<Driven> {
  const { std, key } = standardForDs4();
  const calls: string[] = [];
  const invoke: AgentInvoker = (ctx) => {
    calls.push(ctx.role ?? ctx.agent.slug);
    throw new Error("stub invoker: a model seat was invoked");
  };
  const deps = {
    outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke,
    skill_dirs: new Map([[GATE, GATE_DIR], ["baseline-gate", join(ROOT, "skills", "baseline-gate")]]),
    spec_grades: { conformance_seat: seat, grades },
  };
  let err: unknown;
  try { await runGig(std, { [key]: input }, deps as never); } catch (e) { err = e; }
  return { err, calls, message: err instanceof Error ? err.message : String(err ?? "") };
}
/** The refusal contract: no model seat invoked, the gig refused, the reason named. */
function expectRefusedBeforeAnyModel(d: Driven, why: string, naming: readonly (string | RegExp)[]): void {
  expect(d.calls, `${why} — a model seat was INVOKED (${d.calls.join(", ")}) before the grade was refused`).toEqual([]);
  expect(d.err, `${why} — runGig did not refuse the gig`).toBeDefined();
  for (const n of naming) {
    if (typeof n === "string") expect(d.message, `${why} — the refusal must name ${n}; got: ${d.message}`).toContain(n);
    else expect(d.message, `${why} — the refusal must state its reason (${n}); got: ${d.message}`).toMatch(n);
  }
}

describe("DS-4 — drafting:only-a-graded-spec: the gig runs only on an admitting, LATEST spec_grade", () => {
  it("DS-4 input — the `change-request` type the gig is dispatched with can CARRY the fields the gate reads (spec, content_hash, spec_grade, scope, baseline_commit, branch)", () => {
    // The door (runGig's payload check) validates a declared gig input against its registered type with
    // the schema the seal enforces. The genome's `change-request` is closed today (additionalProperties:
    // false), so the contract's input — which names a spec_grade record, a content hash and a scope —
    // would be refused at the door, before any gate ran. Either the type is extended (type_extend) or the
    // standard declares another input type; either way the payload it is dispatched with must validate.
    const std = genome.standards.get(SLUG) ?? genome.draft_standards.get(SLUG);
    const declared = std?.input_types ?? ["change-request"];
    const key = declared.includes("change-request") ? "change-request" : declared[0] ?? "change-request";
    const verdict = createOutputStore(registry).validateShape(key, changeRequest("g-new"));
    expect(verdict.valid, `the input type "${key}" cannot carry the gate's fields: ${verdict.errors.join("; ")}`).toBe(true);
  });

  it("DS-4 control — an admitting PASS (right hash, made by the conformance seat, scope covers, LATEST) lets the draft chair run", async () => {
    const d = await drive([{ id: "g-new", record: grade() }], changeRequest("g-new"));
    expect(d.calls[0], `the draft chair must be seated for an admitting grade; the run said: ${d.message}`).toBe("draft");
    expect(d.message, "the only stop is the stub invoker's own").toMatch(/stub invoker/);
  });

  it("DS-4 control — a later grade for ANOTHER spec does not refuse: latest is per spec", async () => {
    const d = await drive(
      [{ id: "g-new", record: grade() }, { id: "g-other", record: grade({ spec: "eir:spec.some-other", content_hash: H_OLD }) }],
      changeRequest("g-new"),
    );
    expect(d.calls[0], `a later grade of a different spec must not refuse this one; the run said: ${d.message}`).toBe("draft");
  });

  it("DS-4 control — a PASS whose scope is null (covers everything) admits", async () => {
    const d = await drive([{ id: "g-new", record: grade({ scope: null }) }], changeRequest("g-new"));
    expect(d.calls[0], `a null grade scope covers every law id; the run said: ${d.message}`).toBe("draft");
  });

  it("DS-4 P1 — a spec_grade with verdict HOLD is refused before any model seat is invoked, naming HOLD", async () => {
    const d = await drive([{ id: "g-hold", record: grade({ verdict: "HOLD" }) }], changeRequest("g-hold"));
    expectRefusedBeforeAnyModel(d, "verdict HOLD", [/\bHOLD\b/]);
  });

  it("DS-4 P2 — a PASS made by another principal than the conformance seat is refused, naming the principal and the seat", async () => {
    const d = await drive([{ id: "g-x", record: grade({ by: INTRUDER }) }], changeRequest("g-x"));
    expectRefusedBeforeAnyModel(d, "PASS by another principal", [INTRUDER, /conformance/i]);
  });

  it("DS-4 P3 — a PASS at another content hash than the input's is refused, naming the content hash", async () => {
    const d = await drive([{ id: "g-x", record: grade({ content_hash: H_OLD }) }], changeRequest("g-x", { content_hash: H_NEW }));
    expectRefusedBeforeAnyModel(d, "PASS at another content hash", [/content[_ -]?hash/i]);
  });

  it("DS-4 P4 — a PASS whose scope omits a law id the input names is refused, naming the omitted id", async () => {
    const d = await drive([{ id: "g-x", record: grade({ scope: [L1] }) }], changeRequest("g-x"));
    expectRefusedBeforeAnyModel(d, "PASS whose scope omits a named law", [L2]);
  });

  it("DS-4 P5 — the input names a PASS at an OLDER content hash while a later grade for the same spec exists at a NEWER hash: refused, naming the later grade", async () => {
    const d = await drive(
      [{ id: "g-old", record: grade({ content_hash: H_OLD }) }, { id: "g-new", record: grade({ content_hash: H_NEW }) }],
      changeRequest("g-old", { content_hash: H_OLD }),
    );
    expectRefusedBeforeAnyModel(d, "an older PASS superseded by a later grade", ["g-new", /later|newer|latest|superseded/i]);
  });

  it("DS-4 P6 — an input that names NO spec_grade record is refused before any model seat is invoked", async () => {
    const d = await drive([{ id: "g-new", record: grade() }], changeRequest(undefined));
    expectRefusedBeforeAnyModel(d, "no spec_grade named", [/spec[_ -]?grade/i]);
  });

  it("DS-4 P7 — an input naming a spec_grade id that Chancery did not supply is refused, naming the id", async () => {
    const d = await drive([{ id: "g-new", record: grade() }], changeRequest("g-nonexistent"));
    expectRefusedBeforeAnyModel(d, "a named record that is not among the supplied grades", ["g-nonexistent"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// DS-5 — drafting:the-baseline-holds. The comparison of a baseline loop result with a branch's.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE SEAM THIS RED-SPEC FIXES: `compareBaselineLoop({ baseline, branch, scope })`, exported from
// src/index.ts, takes two loop results and the scope's named law ids, and returns (or resolves to) a
// verdict `{ pass: boolean, … }`; a refusal is pass:false and names the law (and, for a plant, the plant).
//   LoopResult = { laws: [{ id, verdict: "pass" | "fail", plants: [{ id, outcome: "red" | "green" }] }] }
// A plant's outcome is "red" when the law goes red under it (as it must) and "green" when the law PASSES
// its own plant — a law that has lost its teeth. The loop results here are read from a REAL throwaway git
// repo at two commits by a toy loop (a fixture, not the thing guarded): a law's verdict is "fail" iff its
// form says `(status red)`, and each of its plants is "red" iff every term it uses is `(strict true)`.
interface PlantOutcome { id: string; outcome: "red" | "green" }
interface LawResult { id: string; verdict: "pass" | "fail"; plants: PlantOutcome[] }
interface LoopResult { laws: LawResult[] }
const forms = (text: string, head: string): string[] => text.split(new RegExp(`(?=^\\(${head} )`, "m")).filter((f) => f.startsWith(`(${head} `));
const quoted = (form: string, re: RegExp): string[] =>
  [...form.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))].map((m) => m[1] as string);

function toyLoop(repo: Repo, ref: string): LoopResult {
  const laws = git(repo.dir, "show", `${ref}:crossing/laws.sx`);
  const terms = git(repo.dir, "show", `${ref}:crossing/terms.sx`);
  const strict = new Map<string, boolean>();
  for (const t of forms(terms, "term")) strict.set(quoted(t, /^\(term "([^"]+)"/)[0] as string, /\(strict true\)/.test(t));
  return {
    laws: forms(laws, "law").map((f) => {
      const uses = quoted(f, /\(uses-term "([^"]+)"\)/g);
      const outcome = uses.every((u) => strict.get(u) === true) ? "red" : "green";
      return {
        id: quoted(f, /^\(law "([^"]+)"/)[0] as string,
        verdict: /\(status red\)/.test(f) ? "fail" : "pass",
        plants: quoted(f, /\(plant "([^"]+)"\)/g).map((id) => ({ id, outcome })),
      } as LawResult;
    }),
  };
}
/** Commit `files` on a new branch off the baseline; return the branch name. */
function branchWith(repo: Repo, name: string, files: Record<string, string>): string {
  git(repo.dir, "checkout", "-q", "-b", name, repo.baseline);
  if (Object.keys(files).length > 0) {
    for (const [rel, text] of Object.entries(files)) writeRel(repo.dir, rel, text);
    git(repo.dir, "add", "--", ...Object.keys(files));
    git(repo.dir, "commit", "-q", "-m", name);
  }
  return name;
}
const lawResult = (r: LoopResult, id: string): LawResult | undefined => r.laws.find((l) => l.id === id);

const LAW_A = "institution:charter:references-resolve";   // unscoped; uses the (scoped) term record-refs-resolve
const LAW_B = LAW_NAMED;                                   // scoped
const DS5_LAWS =
  lawForm(LAW_A, "Every reference names a record that exists.", [TERM_REFS], "dangling-ref") +
  lawForm(LAW_B, S_NAMED, [TERM_NAMED], "drop-the-test") +
  lawForm(LAW_SEALED, S_SEALED, [], "drop-the-governor-check");
const DS5_SCOPE = { laws: [LAW_B, LAW_NEW], terms: [TERM_REFS, TERM_NAMED] };

/** A repo whose baseline is DS5_LAWS + BASE_TERMS, and whose baseline loop is all-pass, all-plants-red. */
function ds5Repo(): Repo {
  const repo = baselineRepo();
  writeRel(repo.dir, "crossing/laws.sx", DS5_LAWS);
  git(repo.dir, "add", "--", "crossing/laws.sx");
  git(repo.dir, "commit", "-q", "-m", "ds5 baseline");
  repo.baseline = git(repo.dir, "rev-parse", "HEAD").trim();
  const base = toyLoop(repo, repo.baseline);
  expect(base.laws.map((l) => l.verdict), "fixture: the baseline loop is all-pass").toEqual(["pass", "pass", "pass"]);
  expect(base.laws.flatMap((l) => l.plants.map((p) => p.outcome)), "fixture: every baseline plant turns its law red").toEqual(["red", "red", "red"]);
  return repo;
}
async function compare(baseline: LoopResult, branch: LoopResult): Promise<Record<string, unknown>> {
  const fn = (engine as unknown as Record<string, unknown>)["compareBaselineLoop"];
  expect(typeof fn, "src/index.ts exports no `compareBaselineLoop` — there is no baseline-vs-branch comparison; nothing can refuse a red pass that breaks an unscoped law").toBe("function");
  return (await (fn as (a: unknown) => unknown)({ baseline, branch, scope: DS5_SCOPE })) as Record<string, unknown>;
}

describe("DS-5 — drafting:the-baseline-holds: an unscoped pre-existing law keeps its verdict and the outcome of each plant", () => {
  it("DS-5 control — a branch whose loop result equals the baseline's is NOT refused", async () => {
    const repo = ds5Repo();
    const branch = branchWith(repo, "ds5-control-same", {});
    const out = await compare(toyLoop(repo, repo.baseline), toyLoop(repo, branch));
    expect(out["pass"], `an unchanged loop must hold the baseline; got ${JSON.stringify(out).slice(0, 400)}`).toBe(true);
  });

  it("DS-5 control — a law the scope NAMES whose verdict and plant outcome change (and a new red law) is NOT refused", async () => {
    const repo = ds5Repo();
    const branch = branchWith(repo, "ds5-control-scoped", {
      "crossing/laws.sx": edit(DS5_LAWS, `(law "${LAW_B}"\n  (statement "${S_NAMED}")\n  (status green)`, `(law "${LAW_B}"\n  (statement "${S_NAMED}")\n  (status red)`) +
        lawForm(LAW_NEW, "A red pass leaves a branch.", [TERM_NAMED], "publish", "red"),
      "crossing/terms.sx": termForm(TERM_REFS, "a reference names a record that exists") + termForm(TERM_NAMED, "a law carries a plant", false),
    });
    const base = toyLoop(repo, repo.baseline), br = toyLoop(repo, branch);
    expect(lawResult(br, LAW_B)?.verdict, "fixture: the scoped law's verdict changed").toBe("fail");
    expect(lawResult(br, LAW_B)?.plants[0]?.outcome, "fixture: the scoped law now passes its own plant").toBe("green");
    expect(lawResult(br, LAW_NEW)?.verdict, "fixture: a new red law exists on the branch").toBe("fail");
    const out = await compare(base, br);
    expect(out["pass"], `the scope names ${LAW_B} and ${LAW_NEW}: their change is the red pass's point; got ${JSON.stringify(out).slice(0, 400)}`).toBe(true);
  });

  it("DS-5 P1 — an amended term that makes an UNSCOPED law pass its own plant is REFUSED, naming the law and the plant", async () => {
    const repo = ds5Repo();
    const branch = branchWith(repo, "ds5-p1-record-refs", {
      "crossing/terms.sx": edit(BASE_TERMS, `(term "${TERM_REFS}"\n  (definition "a reference names a record that exists")\n  (strict true))`, `(term "${TERM_REFS}"\n  (definition "a reference names a record that exists")\n  (strict false))`),
    });
    const base = toyLoop(repo, repo.baseline), br = toyLoop(repo, branch);
    expect(lawResult(br, LAW_A)?.plants[0]?.outcome, "fixture: the amended term made the unscoped law pass its own plant").toBe("green");
    expect(lawResult(br, LAW_A)?.verdict, "fixture: the law's verdict is unchanged — only its plant outcome moved").toBe("pass");
    const out = await compare(base, br);
    expectRefusal(out, LAW_A, `the term ${TERM_REFS} was amended and the UNSCOPED law ${LAW_A} now passes its own plant`);
    expect(JSON.stringify(out), "the refusal must name the plant that no longer turns the law red").toContain("dangling-ref");
  });

  it("DS-5 P2 — an UNSCOPED law whose verdict changes between baseline and branch is REFUSED, naming the law", async () => {
    const repo = ds5Repo();
    const branch = branchWith(repo, "ds5-p2-verdict", {
      "crossing/laws.sx": edit(DS5_LAWS, `(statement "${S_SEALED}")\n  (status green)`, `(statement "${S_SEALED}")\n  (status red)`),
    });
    const base = toyLoop(repo, repo.baseline), br = toyLoop(repo, branch);
    expect(lawResult(br, LAW_SEALED)?.verdict, "fixture: the unscoped law's verdict flipped").toBe("fail");
    expectRefusal(await compare(base, br), LAW_SEALED, `the verdict of the UNSCOPED law ${LAW_SEALED} changed`);
  });

  it("DS-5 P3 — an UNSCOPED law that is absent from the branch's loop result is REFUSED, naming the law", async () => {
    const repo = ds5Repo();
    const branch = branchWith(repo, "ds5-p3-dropped", {
      "crossing/laws.sx": lawForm(LAW_B, S_NAMED, [TERM_NAMED], "drop-the-test") + lawForm(LAW_SEALED, S_SEALED, [], "drop-the-governor-check"),
    });
    const base = toyLoop(repo, repo.baseline), br = toyLoop(repo, branch);
    expect(lawResult(br, LAW_A), "fixture: the unscoped law is gone from the branch").toBeUndefined();
    expectRefusal(await compare(base, br), LAW_A, `the UNSCOPED law ${LAW_A} no longer has a verdict on the branch`);
  });
});
