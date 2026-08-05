// Silent resolution — one theme, five issues (#241 #242 #244 #247 #248).
//
// Every bug in this file is the same shape: a DANGLING REFERENCE silently degrades into a
// plausible-looking value instead of a named error. The engine already holds the right
// principle elsewhere — `assertToolGrantsResolvable` fails closed on an unresolvable tool
// grant ("a granted tool with no provider is a dead name"), and `Chair.skill_slug` hard-throws.
// `Agent.skill_slugs`, `Chair.required_skills`, the genome manifest, the output store, and the
// gig-input pre-flight all failed silent.
//
// THE BOUNDARY these tests pin (do not move it without moving the reasoning):
//   A skill package that LOADS is a legitimate degradation candidate — it has an identity, a
//   version, a code_hash, and its degradation is already surfaced and sealed via
//   `degraded_reason` (tests/skill_graceful_degradation.test.ts, which must stay entirely
//   green). A slug that resolves to NO PACKAGE AT ALL has nothing to degrade and must fail
//   closed when a chair declared it REQUIRED, and be reported — never asserted to the model —
//   when it did not.

import { describe, it, expect } from "vitest";
import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPrompt,
  composeStandard,
  createOutputStore,
  createRegistry,
  loadGenome,
  loadLayeredGenome,
  resolveGenome,
  runGig,
  MemoryLedger,
  type AgentInvocationContext,
  type AgentInvoker,
  type DomainType,
  type GigProgressEvent,
  type PhaseDef,
  type SkillRecord,
} from "../src";
import { testAgent } from "./_support/agents.js";
import { makeGenomeDir, rmGenome, seedCoreTypes, writeAgent, writeSkillPackage } from "./_support/genome.js";

// ── shared scaffolding ───────────────────────────────────────────────────────
const T = (slug: string, extendsCore: string): DomainType => ({
  slug, extends: extendsCore, domain: "demo",
  schema: { properties: { v: { type: "string" } } }, required_fields: [],
});

// Seed through the constructor, not registerType — the latter enforces type REUSE
// (an existing same-shape type scores >=80), which is a genome-authoring policy, not
// something these scaffolds should have to satisfy.
function harness(types: DomainType[]) {
  return { outputs: createOutputStore(createRegistry(types)), ledger: new MemoryLedger() };
}

// The substance every sealed output carries by virtue of its CORE type. `outputs.write`
// enforces one floor per core on every seal — bare core or domain subtype (#227 ruling) — so
// a stub payload that omits it aborts the CHAIR, and the gig never reaches the resolution
// question the test is actually about. `note` is Interpretation-cored throughout this file;
// `sig` and `gig-req` are Signal-cored.
const CLAIMS = { claims: ["fixture: the note carries one claim"] };
const SIGNAL = { source: "fixture://demo/seeder" };

const skillMap = (...slugs: string[]): ReadonlyMap<string, SkillRecord> =>
  new Map(slugs.map((s) => [s, { slug: s, version: 1, md: `# ${s}` } as unknown as SkillRecord]));

// ─────────────────────────────────────────────────────────────────────────────
// #242 — Chair.required_skills is never read at runtime.
//
// The CLEANEST case in the family: "required" means required, there is no degradation
// tension at all. composeStandard checks only that the agent DECLARES the same string
// (composition.ts:260-267) — it never asks whether the string resolves to a package.
// ─────────────────────────────────────────────────────────────────────────────
describe("#242 — a chair's required_skills must be enforced at runtime, not just string-matched at compose", () => {
  const REQUIRED = "citation-grounding";
  const std = () =>
    composeStandard({
      slug: "req-skill", domain: "demo",
      agents: [testAgent({ slug: "grounded", primitives: ["INTERPRET"], input_types: [], output_types: ["note"], skill_slugs: [REQUIRED] })],
      phases: [{
        name: "p0",
        chairs: [{ role: "ground", agent_slug: "grounded", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [REQUIRED] }],
      } as PhaseDef],
    });

  it("a REQUIRED skill that resolves to no package fails the chair closed — before the model is invoked", async () => {
    const { outputs, ledger } = harness([T("note", "Interpretation")]);
    let fired = false;
    const invoke: AgentInvoker = () => { fired = true; return { v: "x", ...CLAIMS }; };

    await expect(
      // skills map is supplied and simply does NOT contain the required slug — a dangling binding.
      runGig(std(), {}, { outputs, ledger, invoke, skills: skillMap("some-other-skill") }),
    ).rejects.toThrow(new RegExp(`${REQUIRED}[\\s\\S]*requir|requir[\\s\\S]*${REQUIRED}`, "i"));

    expect(fired, "a chair missing a REQUIRED skill must not reach the model").toBe(false);
  });

  it("the dangling REQUIRED binding costs nothing — it is rejected before the budget deduction", async () => {
    const { outputs, ledger } = harness([T("note", "Interpretation")]);
    const invoke: AgentInvoker = () => ({ v: "x", ...CLAIMS });
    const err = await runGig(std(), {}, {
      outputs, ledger, invoke, skills: skillMap(), budget: { opening: 1_000 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // The error is the required-skill failure, NOT BudgetExhausted — i.e. the decision
    // happens on the correct side of the deduction.
    expect(String((err as Error).message)).toMatch(new RegExp(REQUIRED));
    expect(String((err as Error).name)).not.toBe("BudgetExhausted");
  });

  it("positive control: the same standard runs when the required skill resolves", async () => {
    const { outputs, ledger } = harness([T("note", "Interpretation")]);
    const invoke: AgentInvoker = () => ({ v: "x", ...CLAIMS });
    const res = await runGig(std(), {}, { outputs, ledger, invoke, skills: skillMap(REQUIRED) });
    expect(res.status).toBe("complete");
  });

  it("back-compat: with NO skills map supplied, resolution is not configured and nothing is claimed either way", async () => {
    // deps.skills absent is the documented v0 back-compat path (unit suites that don't
    // supply skills). Absence of a map is not evidence of a dangling binding, so the
    // runtime must not manufacture one.
    const { outputs, ledger } = harness([T("note", "Interpretation")]);
    const invoke: AgentInvoker = () => ({ v: "x", ...CLAIMS });
    const res = await runGig(std(), {}, { outputs, ledger, invoke });
    expect(res.status).toBe("complete");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #241 — a dangling skill slug is silently dropped, AND the prompt then asserts the
// missing skill to the model.
// ─────────────────────────────────────────────────────────────────────────────
describe("#241 — a dangling (non-required) skill binding is reported, never silent, never asserted to the model", () => {
  const REAL = "real-skill";
  const PHANTOM = "phantom-skill-that-does-not-exist";
  const std = () =>
    composeStandard({
      slug: "dangle", domain: "demo",
      agents: [testAgent({ slug: "partial", primitives: ["INTERPRET"], input_types: [], output_types: ["note"], skill_slugs: [REAL, PHANTOM] })],
      phases: [{
        name: "p0",
        chairs: [{ role: "interp", agent_slug: "partial", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }],
      } as PhaseDef],
    });

  it("the gig survives (it is not required) but the miss reaches the invocation context", async () => {
    const { outputs, ledger } = harness([T("note", "Interpretation")]);
    const seen: AgentInvocationContext[] = [];
    const invoke: AgentInvoker = (ctx) => { seen.push(ctx); return { v: "x", ...CLAIMS }; };

    const res = await runGig(std(), {}, { outputs, ledger, invoke, skills: skillMap(REAL) });
    expect(res.status).toBe("complete");

    const ctx = seen[0]!;
    expect(ctx.skills?.map((s) => s.slug)).toEqual([REAL]);
    // The whole point: the drop is no longer invisible to the thing being invoked.
    expect(ctx.missing_skills, "a dropped binding must be threaded to the invocation context").toEqual([PHANTOM]);
  });

  it("the miss is emitted as a progress event so a live monitor sees it", async () => {
    const { outputs, ledger } = harness([T("note", "Interpretation")]);
    const events: GigProgressEvent[] = [];
    const invoke: AgentInvoker = () => ({ v: "x", ...CLAIMS });

    await runGig(std(), {}, {
      outputs, ledger, invoke, skills: skillMap(REAL),
      onProgress: (ev) => events.push(ev),
    });

    const miss = events.find((e) => e.type === "skills_unresolved");
    expect(miss, "a dangling binding must surface on the progress channel").toBeDefined();
    expect(miss).toMatchObject({ type: "skills_unresolved", role: "interp", agent: "partial", missing: [PHANTOM] });
  });

  it("PROMPT, total dangle: an all-unresolved agent is never told it holds a discipline that does not exist", () => {
    // Empirically (issue #241): this rendered `# Skills` / `## phantom-skill` with zero
    // content — the prompt ASSERTING a skill the agent does not hold. The slug-only
    // fallback (claude_invoker.ts:104) must never name an unresolved slug.
    const agent = testAgent({ slug: "partial", primitives: ["INTERPRET"], input_types: [], output_types: ["note"], skill_slugs: [PHANTOM] });
    const prompt = buildPrompt({
      agent, phase: "p0", inputs: [], gig_input: {}, skills: [], missing_skills: [PHANTOM],
    });
    expect(prompt).not.toContain(PHANTOM);
    expect(prompt, "no skill resolved → no Skills layer at all, not an empty one").not.toContain("# Skills");
  });

  it("PROMPT, partial dangle: the resolved skill renders, the dangling one is not named", () => {
    const agent = testAgent({ slug: "partial", primitives: ["INTERPRET"], input_types: [], output_types: ["note"], skill_slugs: [REAL, PHANTOM] });
    const prompt = buildPrompt({
      agent, phase: "p0", inputs: [], gig_input: {},
      skills: [{ slug: REAL, version: 1, md: "GROUNDING_RULE" } as unknown as SkillRecord],
      missing_skills: [PHANTOM],
    });
    expect(prompt).toContain("# Skills");
    expect(prompt).toContain(REAL);
    expect(prompt).toContain("GROUNDING_RULE");
    expect(prompt).not.toContain(PHANTOM);
  });

  it("PROMPT back-compat: with no resolution attempted, the slug-only fallback still names bound skills", () => {
    // `missing_skills` absent = the runtime never resolved (no skills map). Nothing is
    // KNOWN unresolved, so the legacy index behaviour is preserved.
    const agent = testAgent({ slug: "partial", primitives: ["INTERPRET"], input_types: [], output_types: ["note"], skill_slugs: [REAL] });
    const prompt = buildPrompt({ agent, phase: "p0", inputs: [], gig_input: {}, skills: [] });
    expect(prompt).toContain("# Skills");
    expect(prompt).toContain(REAL);
  });

  it("LOAD TIME: a dangling skill binding is a soft load_error — the genome still loads", () => {
    const root = makeGenomeDir();
    try {
      seedCoreTypes(root);
      writeSkillPackage(root, { slug: REAL, md: "real" });
      writeAgent(root, { slug: "partial", primitives: ["INTERPRET"], input_types: [], output_types: ["note"], skill_slugs: [REAL, PHANTOM] });

      const g = loadGenome(root);
      // Soft: the agent is still there.
      expect(g.agents.get("partial")).toBeDefined();
      const err = g.load_errors.find((e) => e.slug === "partial" && e.error.includes(PHANTOM));
      expect(err, "load_errors:[] is the pass signal operators are told to trust — a dangling binding must break it").toBeDefined();
      expect(err!.kind).toBe("agent");
      // The RESOLVED binding must not be reported.
      expect(err!.error).not.toContain(REAL);
    } finally { rmGenome(root); }
  });

  it("LOAD TIME, layered: a base agent may legitimately bind a skill a HIGHER layer supplies", () => {
    // The check runs post-fold, so this must produce no load_error at all.
    const base = makeGenomeDir("coltrane-base-");
    const top = makeGenomeDir("coltrane-top-");
    try {
      seedCoreTypes(base);
      writeAgent(base, { slug: "partial", primitives: ["INTERPRET"], input_types: [], output_types: ["note"], skill_slugs: [REAL] });
      seedCoreTypes(top);
      writeSkillPackage(top, { slug: REAL, md: "supplied by the consumer layer" });

      const g = loadLayeredGenome([base, top]);
      expect(g.agents.get("partial")).toBeDefined();
      expect(g.skills.get(REAL)).toBeDefined();
      expect(
        g.load_errors.filter((e) => e.error.includes(REAL)),
        "a base binding satisfied by a higher layer is not dangling",
      ).toEqual([]);
    } finally { rmGenome(base); rmGenome(top); }
  });

  it("LOAD TIME, layered: a binding NO layer supplies is still reported once folded", () => {
    const base = makeGenomeDir("coltrane-base-");
    const top = makeGenomeDir("coltrane-top-");
    try {
      seedCoreTypes(base);
      writeAgent(base, { slug: "partial", primitives: ["INTERPRET"], input_types: [], output_types: ["note"], skill_slugs: [PHANTOM] });
      seedCoreTypes(top);

      const g = loadLayeredGenome([base, top]);
      const errs = g.load_errors.filter((e) => e.error.includes(PHANTOM));
      expect(errs.length, "reported exactly once, post-fold — not once per layer").toBe(1);
      expect(errs[0]!.kind).toBe("agent");
      expect(errs[0]!.slug).toBe("partial");
    } finally { rmGenome(base); rmGenome(top); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #247 — a malformed genome.json silently drops the entire base layer, destroying the
// root cause and relocating the symptom to a cascade of errors pointing at correct files.
// The `LoadError` channel for this already exists (kind: "manifest") and is simply unused.
// ─────────────────────────────────────────────────────────────────────────────
describe("#247 — a malformed genome.json must not silently un-extend the genome", () => {
  it("a trailing comma in genome.json is reported as a manifest LoadError, not swallowed", () => {
    const root = makeGenomeDir("coltrane-manifest-");
    try {
      seedCoreTypes(root);
      // A trailing comma — the canonical hand-edit typo.
      writeFileSync(join(root, "genome.json"), '{ "extends": ["./base"], }');

      const g = resolveGenome(root);
      const err = g.load_errors.find((e) => e.kind === "manifest" && e.path.endsWith("genome.json"));
      expect(err, "the manifest LoadError channel exists and must be used here").toBeDefined();
      expect(err!.error).toMatch(/malformed|parse|JSON/i);
    } finally { rmGenome(root); }
  });

  it("the load still completes (soft-fail) — one broken manifest is not a crash", () => {
    const root = makeGenomeDir("coltrane-manifest-");
    try {
      seedCoreTypes(root);
      writeAgent(root, { slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"] });
      writeFileSync(join(root, "genome.json"), "{ not json at all");

      const g = resolveGenome(root);
      expect(g.agents.get("solo")).toBeDefined();
      expect(g.load_errors.some((e) => e.kind === "manifest")).toBe(true);
    } finally { rmGenome(root); }
  });

  it("a WELL-FORMED manifest with no extends records no manifest error", () => {
    const root = makeGenomeDir("coltrane-manifest-");
    try {
      seedCoreTypes(root);
      writeFileSync(join(root, "genome.json"), JSON.stringify({ extends: [] }));
      expect(resolveGenome(root).load_errors.filter((e) => e.kind === "manifest")).toEqual([]);
    } finally { rmGenome(root); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #248 — a malformed persisted line is silently dropped from the output store, so the
// engine reports a SHORTER CHAIN as if it were the whole chain. This is the INVERSE of
// the ledger's old problem (#211): two stores in the same engine, opposite failure modes,
// neither correct. PR #256 established skip-and-REPORT as the answer for the ledger.
// ─────────────────────────────────────────────────────────────────────────────
describe("#248 — a torn line in the persisted output store is skipped AND reported", () => {
  const NOTE = [T("note", "Interpretation")];
  function persisted() {
    const dir = makeGenomeDir("coltrane-outputs-");
    return { dir, store: createOutputStore(createRegistry(NOTE), { persistDir: dir }) };
  }

  it("integrity() reports the corrupt line while all() keeps serving the intact rows", () => {
    const { dir, store } = persisted();
    try {
      const rec = store.write({ core_type: "Interpretation", domain_type: "note", domain: "demo", gig_id: "g1", agent_slug: "a", primitive: "INTERPRET", data: { v: "kept", ...CLAIMS } });
      // Simulate a torn append (crash mid-write / disk full) on the SAME gig file.
      appendFileSync(join(dir, "outputs", "g1.jsonl"), '{"id":"torn","core_type":"Inter\n', "utf8");

      // A fresh store over the same dir — this is the cross-session read path.
      const fresh = createOutputStore(createRegistry(NOTE), { persistDir: dir });

      expect(fresh.all().map((r) => r.id)).toEqual([rec.id]); // forgiving: the good row survives
      const report = fresh.integrity();
      expect(report.ok, "a shorter chain must never be reported as the whole chain").toBe(false);
      expect(report.corrupt.length).toBe(1);
      expect(report.corrupt[0]!.path).toContain("g1.jsonl");
      expect(report.corrupt[0]!.line_no).toBe(2);
      expect(report.corrupt[0]!.reason).toMatch(/JSON|parse/i);
      expect(report.corrupt[0]!.preview).toContain("torn");
    } finally { rmGenome(dir); }
  });

  it("a clean store reports ok:true with no corruption", () => {
    const { dir, store } = persisted();
    try {
      store.write({ core_type: "Interpretation", domain_type: "note", domain: "demo", gig_id: "g1", agent_slug: "a", primitive: "INTERPRET", data: { v: "x", ...CLAIMS } });
      const report = store.integrity();
      expect(report).toMatchObject({ ok: true, corrupt: [] });
    } finally { rmGenome(dir); }
  });

  it("an in-memory store (no persistDir) is trivially intact", () => {
    expect(createOutputStore(createRegistry(NOTE)).integrity()).toMatchObject({ ok: true, corrupt: [] });
  });

  it("a corrupt REFS line is reported too — provenance edges are part of the chain", () => {
    const { dir, store } = persisted();
    try {
      const a = store.write({ core_type: "Interpretation", domain_type: "note", domain: "demo", gig_id: "g1", agent_slug: "a", primitive: "INTERPRET", data: { v: "a", ...CLAIMS } });
      const b = store.write({ core_type: "Interpretation", domain_type: "note", domain: "demo", gig_id: "g1", agent_slug: "a", primitive: "INTERPRET", data: { v: "b", ...CLAIMS } });
      store.addRef(b.id, a.id, "derived_from", "INTERPRET");
      appendFileSync(join(dir, "refs", "g1.jsonl"), "{oops\n", "utf8");

      const fresh = createOutputStore(createRegistry(NOTE), { persistDir: dir });
      fresh.refs();
      const report = fresh.integrity();
      expect(report.ok).toBe(false);
      expect(report.corrupt.some((c) => c.path.includes(join("refs", "g1.jsonl")))).toBe(true);
    } finally { rmGenome(dir); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #244 — the gig-input pre-flight covers only phase-0 `depends_on: []` chairs, so a real
// chair fires and burns real money before a knowable-at-t=0 failure — and the error blames
// "upstream outputs" when the cause is a missing key in the caller's own payload.
// ─────────────────────────────────────────────────────────────────────────────
describe("#244 — the gig-input pre-flight must cover every statically-knowable chair", () => {
  const seed = testAgent({ slug: "seeder", primitives: ["SENSE"], input_types: [], output_types: ["sig"] });
  const needer = testAgent({ slug: "needer", primitives: ["INTERPRET"], input_types: ["gig-req", "sig"], output_types: ["note"] });
  const types = [T("sig", "Signal"), T("gig-req", "Signal"), T("note", "Interpretation")];

  // `seeder` fills a Signal-cored chair and `needer` an Interpretation-cored one, so the stub
  // answers per chair rather than carrying both cores' floors on one payload.
  const byChair = (slug: string): Record<string, unknown> =>
    slug === "seeder" ? { v: "x", ...SIGNAL } : { v: "x", ...CLAIMS };

  // (a) The dependent chair sits in phase 1 with depends_on: [] — the pre-flight skipped it
  //     because it only looked at phase 0.
  const laterPhase = () =>
    composeStandard({
      slug: "later-phase", domain: "demo", agents: [seed, needer], input_types: ["gig-req"],
      phases: [
        { name: "p0", chairs: [{ role: "S", agent_slug: "seeder", depends_on: [], input_contract: [], output_contract: ["sig"], required_skills: [] }] },
        { name: "p1", chairs: [{ role: "N", agent_slug: "needer", depends_on: [], input_contract: ["gig-req"], output_contract: ["note"], required_skills: [] }] },
      ] as PhaseDef[],
    });

  // (b) The dependent chair sits in phase 0 but has depends_on — the pre-flight skipped it
  //     because of the `depends_on.length > 0` continue.
  const samePhaseDependent = () =>
    composeStandard({
      slug: "same-phase", domain: "demo", agents: [seed, needer], input_types: ["gig-req"],
      phases: [
        { name: "p0", chairs: [
          { role: "S", agent_slug: "seeder", depends_on: [], input_contract: [], output_contract: ["sig"], required_skills: [] },
          { role: "N", agent_slug: "needer", depends_on: ["S"], input_contract: ["gig-req", "sig"], output_contract: ["note"], required_skills: [] },
        ] },
      ] as PhaseDef[],
    });

  it("(a) a later-phase entry chair's missing gig input stops the run BEFORE phase 0 spends a token", async () => {
    const { outputs, ledger } = harness(types);
    const fired: string[] = [];
    const invoke: AgentInvoker = (ctx) => { fired.push(ctx.agent.slug); return byChair(ctx.agent.slug); };
    await expect(runGig(laterPhase(), {}, { outputs, ledger, invoke })).rejects.toThrow(/gig-req/);
    expect(fired, "in production this is a real claude spawn and real dollars").toEqual([]);
  });

  it("(b) a dependent chair's missing gig input stops the run BEFORE its phase-0 sibling fires", async () => {
    const { outputs, ledger } = harness(types);
    const fired: string[] = [];
    const invoke: AgentInvoker = (ctx) => { fired.push(ctx.agent.slug); return byChair(ctx.agent.slug); };
    await expect(runGig(samePhaseDependent(), {}, { outputs, ledger, invoke })).rejects.toThrow(/gig-req/);
    expect(fired).toEqual([]);
  });

  it("the error blames the DISPATCH PAYLOAD, not the upstream pipeline", async () => {
    const { outputs, ledger } = harness(types);
    const invoke: AgentInvoker = (ctx) => byChair(ctx.agent.slug);
    const err = await runGig(laterPhase(), {}, { outputs, ledger, invoke }).catch((e: unknown) => e) as Error;
    expect(err.message).toMatch(/MissingGigInput/);
    expect(err.message).toMatch(/gig input|payload|dispatch/i);
    expect(err.message, "telling the operator their pipeline is mis-wired sends them to the wrong file").not.toMatch(/upstream outputs only provide/);
  });

  it("NO false positives: a chair whose need is satisfied UPSTREAM still runs", async () => {
    // `seeder` produces gig-req, so `needer` can be satisfied without the gig payload.
    // The pre-flight must only fire on a provably-unreachable need.
    const upstreamSeeder = testAgent({ slug: "seeder", primitives: ["SENSE"], input_types: [], output_types: ["gig-req"] });
    const std = composeStandard({
      slug: "upstream-sat", domain: "demo", agents: [upstreamSeeder, needer], input_types: ["gig-req"],
      phases: [
        { name: "p0", chairs: [{ role: "S", agent_slug: "seeder", depends_on: [], input_contract: [], output_contract: ["gig-req"], required_skills: [] }] },
        { name: "p1", chairs: [{ role: "N", agent_slug: "needer", depends_on: ["S"], input_contract: ["gig-req"], output_contract: ["note"], required_skills: [] }] },
      ] as PhaseDef[],
    });
    const { outputs, ledger } = harness(types);
    const invoke: AgentInvoker = (ctx) => byChair(ctx.agent.slug);
    const res = await runGig(std, {}, { outputs, ledger, invoke });
    expect(res.status).toBe("complete");
  });

  it("NO false positives: supplying the gig input runs the whole standard", async () => {
    const { outputs, ledger } = harness(types);
    const invoke: AgentInvoker = (ctx) => byChair(ctx.agent.slug);
    const res = await runGig(laterPhase(), { "gig-req": { v: "here" } }, { outputs, ledger, invoke });
    expect(res.status).toBe("complete");
  });
});

describe("#244 (neighbourhood) — unknown-key diagnostics: gigInput's keys are in scope and never inspected", () => {
  const needer = testAgent({ slug: "needer", primitives: ["INTERPRET"], input_types: ["grant-requirements"], output_types: ["note"] });
  const std = () =>
    composeStandard({
      slug: "keys", domain: "demo", agents: [needer], input_types: ["grant-requirements"],
      phases: [{ name: "p0", chairs: [{ role: "N", agent_slug: "needer", depends_on: [], input_contract: ["grant-requirements"], output_contract: ["note"], required_skills: [] }] }] as PhaseDef[],
    });

  it("an underscored near-miss of a hyphenated type slug is named as the likely cause", async () => {
    const { outputs, ledger } = harness([T("grant-requirements", "Interpretation"), T("note", "Interpretation")]);
    const invoke: AgentInvoker = () => ({ v: "x", ...CLAIMS });
    const err = await runGig(std(), { grant_requirements: { v: "oops" } }, { outputs, ledger, invoke }).catch((e: unknown) => e) as Error;
    expect(err.message).toContain("grant_requirements");
    expect(err.message).toMatch(/did you mean|hyphen/i);
  });

  it("unrecognized payload keys are listed so the operator can see what they actually sent", async () => {
    const { outputs, ledger } = harness([T("grant-requirements", "Interpretation"), T("note", "Interpretation")]);
    const invoke: AgentInvoker = () => ({ v: "x", ...CLAIMS });
    const err = await runGig(std(), { totally_unrelated: 1 }, { outputs, ledger, invoke }).catch((e: unknown) => e) as Error;
    expect(err.message).toContain("totally_unrelated");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The shipped genome is the regression canary: every skill binding in agents/ must
// resolve. If this goes red, someone authored a dangling binding.
// ─────────────────────────────────────────────────────────────────────────────
describe("the shipped coltrane genome has no dangling skill bindings", () => {
  it("loads with no dangling-skill-binding load_errors", () => {
    const root = new URL("..", import.meta.url).pathname;
    const g = loadGenome(root);
    const dangling = g.load_errors.filter((e) => /dangling skill|skill binding/i.test(e.error));
    expect(dangling, `dangling: ${JSON.stringify(dangling)}`).toEqual([]);
    // Sanity: the fixture we lean on above is real.
    expect(readFileSync(join(root, "package.json"), "utf-8")).toContain("@eir-dev/coltrane");
  });
});
