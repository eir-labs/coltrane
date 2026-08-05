// Phase checkpoint/resume + engine-level output reuse.
//
// One idea, two ranges: reuse a sealed output instead of paying to derive it again. RESUME
// reuses THIS gig's own completed phases after a mid-run failure; the REUSE CACHE serves a
// chair from a PRIOR gig's sealed output. A full convergence run is ~$4–7 and minutes long,
// and until now a failure at phase 5 discarded phases 1–4 entirely.
//
// What these tests defend is not the saving. It is that a saving cannot be taken by splicing
// two different systems together. A resume into a pipeline whose genome moved would have
// chairs from genome B consuming sealed outputs from genome A, with nothing in `input_shas`,
// `genome_hash` or `run_fingerprint` recording that it happened. So the load-bearing
// assertions here are the REFUSALS, and the counting of invocations — an outcome assertion
// alone cannot tell a skipped chair from a re-run one.

import { describe, it, expect } from "vitest";
import {
  runGig, ResumeRefused, RuntimeError,
  type AgentInvoker, type GigProgressEvent, type RunDeps,
} from "../src/runtime.js";
import {
  createRegistry, createOutputStore, MemoryLedger,
  type DomainType, type Agent, type Standard, type OutputStore, type Ledger, type Registry,
} from "../src/index.js";
import {
  createMemoryCheckpointStore, createCheckpointStore, createReuseStore,
  reuseCacheKey, checkReuseEntry, ReuseStoreError,
  CHECKPOINT_SCHEMA_VERSION, REUSE_SCHEMA_VERSION,
  type ReuseStore, type ReuseEntry, type GigCheckpoint,
} from "../src/reuse.js";
import { testAgent } from "./_support/agents.js";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fixture genome ────────────────────────────────────────────────────────────
// Three phases in a line: sense → interpret → judge. Every core carries a substance floor
// (#227/#228), so each payload below satisfies its own core's required key.
const SIGNAL = { source: "fixture://rfp" };
const INTERPRETATION = { claims: [{ claim: "the fixture asserts one claim" }] };
const JUDGMENT = { criteria: ["the fixture asserts one criterion"] };

const seedT: DomainType = { slug: "seed-t", extends: "Signal", domain: "demo", schema: { properties: { s: { type: "string" } } }, required_fields: ["s"] };
const midT: DomainType = { slug: "mid-t", extends: "Interpretation", domain: "demo", schema: { properties: { m: { type: "string" } } }, required_fields: ["m"] };
const endT: DomainType = { slug: "end-t", extends: "Judgment", domain: "demo", schema: { properties: { e: { type: "string" } } }, required_fields: ["e"] };

const scout: Agent = testAgent({ slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["seed-t"], domain: "demo" });
const reader: Agent = testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: ["seed-t"], output_types: ["mid-t"], domain: "demo" });
const judge: Agent = testAgent({ slug: "judge", primitives: ["JUDGE"], input_types: ["mid-t"], output_types: ["end-t"], domain: "demo" });

function pipeline(over?: Partial<Standard>): Standard {
  return {
    slug: "line", domain: "demo", agents: [scout, reader, judge],
    phases: [
      { name: "p1", chairs: [{ role: "r1", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["seed-t"], required_skills: [] }] },
      { name: "p2", chairs: [{ role: "r2", agent_slug: "reader", depends_on: ["r1"], input_contract: ["seed-t"], output_contract: ["mid-t"], required_skills: [] }] },
      { name: "p3", chairs: [{ role: "r3", agent_slug: "judge", depends_on: ["r2"], input_contract: ["mid-t"], output_contract: ["end-t"], required_skills: [] }] },
    ],
    ...over,
  } as Standard;
}

interface Bench { outputs: OutputStore; ledger: Ledger; registry: Registry }

function bench(types: DomainType[] = [seedT, midT, endT]): Bench {
  const registry = createRegistry();
  for (const t of types) registry.registerType(t);
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger(), registry };
}

/** A deterministic invoker that COUNTS each chair's invocations by agent slug. */
function counting(failOn?: { agent: string; times: number }): { invoke: AgentInvoker; calls: Record<string, number>; total: () => number } {
  const calls: Record<string, number> = {};
  let failsLeft = failOn?.times ?? 0;
  const invoke: AgentInvoker = (ctx) => {
    calls[ctx.agent.slug] = (calls[ctx.agent.slug] ?? 0) + 1;
    if (failOn && ctx.agent.slug === failOn.agent && failsLeft > 0) {
      failsLeft--;
      throw new Error(`stub failure in ${ctx.agent.slug}`);
    }
    switch (ctx.agent.slug) {
      case "scout": return { s: "seeded", ...SIGNAL };
      case "reader": return { m: "read", ...INTERPRETATION };
      default: return { e: "judged", ...JUDGMENT };
    }
  };
  return { invoke, calls, total: () => Object.values(calls).reduce((a, b) => a + b, 0) };
}

/** A ReuseStore that also lets a test SEE what was cached — the corruption tests need it. */
function spyReuse(): ReuseStore & { entries: () => ReuseEntry[] } {
  const m = new Map<string, string>();
  return {
    get: (k) => { const raw = m.get(k); return raw === undefined ? undefined : (JSON.parse(raw) as ReuseEntry); },
    put: (e) => void m.set(e.cache_key, JSON.stringify(e)),
    entries: () => [...m.values()].map((v) => JSON.parse(v) as ReuseEntry),
  };
}

const GIG = "gig-fixed-0001";

const run = (b: Bench, invoke: AgentInvoker, extra?: Partial<RunDeps>): RunDeps =>
  ({ outputs: b.outputs, ledger: b.ledger, invoke, gig_id: GIG, ...extra });

// ═══════════════════════════════════════════════════════════════════════════════
describe("resume — a mid-run failure no longer discards the phases that succeeded", () => {
  it("resumes a failed run and does NOT re-invoke the chairs that already completed", async () => {
    const b = bench();
    const checkpoints = createMemoryCheckpointStore();

    // Attempt 1 — phases 1 and 2 succeed, phase 3 dies.
    const first = counting({ agent: "judge", times: 1 });
    await expect(runGig(pipeline(), {}, run(b, first.invoke, { checkpoints }))).rejects.toThrow(RuntimeError);
    expect(first.calls, "attempt 1 runs all three chairs, the last one failing").toEqual({ scout: 1, reader: 1, judge: 1 });

    // Attempt 2 — resume. Only the chair that failed may run.
    const second = counting();
    const res = await runGig(pipeline(), {}, run(b, second.invoke, { checkpoints, resume_from: GIG }));

    expect(res.status).toBe("complete");
    expect(second.calls, "scout and reader were sealed already — re-invoking them is the whole bug").toEqual({ judge: 1 });
    expect(second.total()).toBe(1);
    expect(res.resumed_from?.from_gig_id).toBe(GIG);
    expect(res.resumed_from?.roles.map((r) => r.role)).toEqual(["r1", "r2"]);
  });

  it("a resumed run carries the SAME run_fingerprint as a cold run", async () => {
    // The property that makes resume a continuation rather than a fork. If splicing shifted
    // the reproducibility key, "resume" would be a different artifact wearing the same name.
    const cold = bench();
    const coldRes = await runGig(pipeline(), {}, run(cold, counting().invoke));

    const warm = bench();
    const checkpoints = createMemoryCheckpointStore();
    await expect(
      runGig(pipeline(), {}, run(warm, counting({ agent: "judge", times: 1 }).invoke, { checkpoints })),
    ).rejects.toThrow();
    const warmRes = await runGig(pipeline(), {}, run(warm, counting().invoke, { checkpoints, resume_from: GIG }));

    expect(warmRes.run_fingerprint).toBe(coldRes.run_fingerprint);
    expect(warmRes.outputs.length, "the restored outputs are part of what this gig produced").toBe(coldRes.outputs.length);
  });

  it("says which phases it skipped, and why, in the result AND on the event stream", async () => {
    const b = bench();
    const checkpoints = createMemoryCheckpointStore();
    await expect(runGig(pipeline(), {}, run(b, counting({ agent: "judge", times: 1 }).invoke, { checkpoints }))).rejects.toThrow();

    const events: GigProgressEvent[] = [];
    const res = await runGig(pipeline(), {}, run(b, counting().invoke, {
      checkpoints, resume_from: GIG, onProgress: (e) => void events.push(e),
    }));

    expect(res.skipped?.map((s) => [s.phase, s.role, s.reason])).toEqual([["p1", "r1", "resume"], ["p2", "r2", "resume"]]);
    const skips = events.filter((e) => e.type === "chair_skipped");
    expect(skips.length, "a silent saving is indistinguishable from a bug").toBe(2);
    expect(skips.every((e) => e.type === "chair_skipped" && e.reason === "resume")).toBe(true);
  });

  // ── THE load-bearing safety test ───────────────────────────────────────────
  it("REFUSES to resume into a changed genome, and spends nothing doing so", async () => {
    const b = bench();
    const checkpoints = createMemoryCheckpointStore();
    await expect(runGig(pipeline(), {}, run(b, counting({ agent: "judge", times: 1 }).invoke, { checkpoints }))).rejects.toThrow();

    // The genome moves: the judge now also consumes the seed. genomeHash folds every agent's
    // input_types, so this is a different pipeline — and its chairs must not consume outputs
    // sealed by the old one.
    const movedJudge = testAgent({ slug: "judge", primitives: ["JUDGE"], input_types: ["mid-t", "seed-t"], output_types: ["end-t"], domain: "demo" });
    const moved = pipeline({ agents: [scout, reader, movedJudge] });

    const after = counting();
    await expect(runGig(moved, {}, run(b, after.invoke, { checkpoints, resume_from: GIG }))).rejects.toThrow(ResumeRefused);
    expect(after.total(), "refusing must cost nothing — a refusal that already spent is not a refusal").toBe(0);
  });

  it("the refusal names genome_hash as the field that moved", async () => {
    const b = bench();
    const checkpoints = createMemoryCheckpointStore();
    await expect(runGig(pipeline(), {}, run(b, counting({ agent: "judge", times: 1 }).invoke, { checkpoints }))).rejects.toThrow();
    const movedJudge = testAgent({ slug: "judge", primitives: ["JUDGE"], input_types: ["mid-t", "seed-t"], output_types: ["end-t"], domain: "demo" });

    let msg = "";
    try { await runGig(pipeline({ agents: [scout, reader, movedJudge] }), {}, run(b, counting().invoke, { checkpoints, resume_from: GIG })); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/genome_hash/);
  });

  it("REFUSES to resume under a different dispatch payload", async () => {
    // The same splice, one layer down: phases 1–2 derived from payload A, phase 3 consuming
    // payload B. genome_hash cannot see this — the pipeline is identical.
    const b = bench();
    const checkpoints = createMemoryCheckpointStore();
    await expect(runGig(pipeline(), { seed: "A" }, run(b, counting({ agent: "judge", times: 1 }).invoke, { checkpoints }))).rejects.toThrow();

    const after = counting();
    await expect(runGig(pipeline(), { seed: "B" }, run(b, after.invoke, { checkpoints, resume_from: GIG }))).rejects.toThrow(/gig_input_sha/);
    expect(after.total()).toBe(0);
  });

  it("REFUSES when the checkpoint names an output the store no longer holds", async () => {
    const b = bench();
    const checkpoints = createMemoryCheckpointStore();
    await expect(runGig(pipeline(), {}, run(b, counting({ agent: "judge", times: 1 }).invoke, { checkpoints }))).rejects.toThrow();

    // A fresh store — the checkpoint is intact, the outputs it points at are gone.
    const after = counting();
    await expect(
      runGig(pipeline(), {}, run(bench(), after.invoke, { checkpoints, resume_from: GIG })),
    ).rejects.toThrow(ResumeRefused);
    expect(after.total()).toBe(0);
  });

  it("REFUSES a resume for a gig that was never checkpointed", async () => {
    const after = counting();
    await expect(
      runGig(pipeline(), {}, run(bench(), after.invoke, { checkpoints: createMemoryCheckpointStore(), resume_from: "no-such-gig" })),
    ).rejects.toThrow(ResumeRefused);
    expect(after.total(), "a cold run here would be a COST surprise wearing a success reply").toBe(0);
  });

  it("REFUSES a resume when no checkpoint store is wired at all", async () => {
    await expect(runGig(pipeline(), {}, run(bench(), counting().invoke, { resume_from: GIG }))).rejects.toThrow(ResumeRefused);
  });

  it("REFUSES to resume across a type change the genome_hash cannot see", async () => {
    // genomeHash folds the standard and its agents — NOT the domain-type registry. A type
    // that gained a required field between the two attempts would have its already-sealed
    // records injected into a run whose seal validator now rejects that shape. Same store,
    // same records; only the registry moves.
    const b = bench();
    const checkpoints = createMemoryCheckpointStore();
    await expect(runGig(pipeline(), {}, run(b, counting({ agent: "judge", times: 1 }).invoke, { checkpoints }))).rejects.toThrow();

    // An ADDITIVE edit — a new optional property. The already-sealed data still validates, so
    // nothing here forces a failure by other means: if the resume were allowed, it would
    // succeed, quietly, under a type that is no longer the one those records were sealed
    // against. That is precisely the splice the gate has to refuse.
    b.registry.replaceTypes([
      { ...seedT, schema: { properties: { s: { type: "string" }, note: { type: "string" } } } },
      midT, endT,
    ]);

    const after = counting();
    await expect(runGig(pipeline(), {}, run(b, after.invoke, { checkpoints, resume_from: GIG }))).rejects.toThrow(ResumeRefused);
    expect(after.total()).toBe(0);
  });

  it("does nothing at all when no resume is requested — the default path is untouched", async () => {
    const b = bench();
    const first = counting();
    const res = await runGig(pipeline(), {}, run(b, first.invoke, { checkpoints: createMemoryCheckpointStore() }));
    expect(res.resumed_from).toBeUndefined();
    expect(res.skipped).toBeUndefined();
    expect(first.total()).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("reuse — a chair served from a prior gig's sealed output", () => {
  const withReuse = (b: Bench, invoke: AgentInvoker, gig: string, reuse: ReuseStore): RunDeps =>
    ({ outputs: b.outputs, ledger: b.ledger, invoke, gig_id: gig, reuse });

  it("a second run of the same dispatch invokes nothing and completes", async () => {
    const reuse = spyReuse();
    const first = counting();
    await runGig(pipeline(), {}, withReuse(bench(), first.invoke, "gig-a", reuse));
    expect(first.total()).toBe(3);

    const b2 = bench();
    const second = counting();
    const res = await runGig(pipeline(), {}, withReuse(b2, second.invoke, "gig-b", reuse));
    expect(second.total(), "every chair was already sealed under an identical key").toBe(0);
    expect(res.status).toBe("complete");
    expect(res.reuse?.hits.map((h) => h.role)).toEqual(["r1", "r2", "r3"]);
  });

  it("a fully-reused run carries the SAME run_fingerprint as the cold run it stands in for", async () => {
    const reuse = spyReuse();
    const cold = await runGig(pipeline(), {}, withReuse(bench(), counting().invoke, "gig-a", reuse));
    const hot = await runGig(pipeline(), {}, withReuse(bench(), counting().invoke, "gig-b", reuse));
    expect(hot.run_fingerprint).toBe(cold.run_fingerprint);
  });

  it("a reused output is re-sealed into this gig with THIS gig's provenance", async () => {
    const reuse = spyReuse();
    await runGig(pipeline(), {}, withReuse(bench(), counting().invoke, "gig-a", reuse));
    const res = await runGig(pipeline(), {}, withReuse(bench(), counting().invoke, "gig-b", reuse));

    for (const o of res.outputs) {
      expect(o.gig_id, "a recalled output belongs to the gig that recalled it").toBe("gig-b");
      expect(o.reused_from?.gig_id, "recall must be distinguishable from derivation").toBe("gig-a");
    }
    const mid = res.outputs.find((o) => o.domain_type === "mid-t")!;
    const seed = res.outputs.find((o) => o.domain_type === "seed-t")!;
    expect(mid.input_refs, "the chain must name the records THIS gig fed the chair").toEqual([seed.id]);
    expect(mid.input_shas).toEqual([seed.content_sha]);
  });

  it("does nothing when reuse is not opted into", async () => {
    const reuse = spyReuse();
    await runGig(pipeline(), {}, withReuse(bench(), counting().invoke, "gig-a", reuse));

    const b2 = bench();
    const second = counting();
    const res = await runGig(pipeline(), {}, { outputs: b2.outputs, ledger: b2.ledger, invoke: second.invoke, gig_id: "gig-b" });
    expect(second.total(), "reuse must never happen by surprise").toBe(3);
    expect(res.reuse).toBeUndefined();
  });

  it("a changed agent definition busts the key — the slug alone is not the producer", async () => {
    const reuse = spyReuse();
    await runGig(pipeline(), {}, withReuse(bench(), counting().invoke, "gig-a", reuse));

    const edited = testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: ["seed-t"], output_types: ["mid-t"], domain: "demo", method: "read the document COMPLETELY differently" });
    const second = counting();
    await runGig(pipeline({ agents: [scout, edited, judge] }), {}, withReuse(bench(), second.invoke, "gig-b", reuse));
    expect(second.calls["reader"], "an agent edited under a stable slug is a different producer").toBe(1);
    expect(second.calls["scout"] ?? 0, "the untouched chair still hits").toBe(0);
  });

  it("a changed dispatch payload busts the key", async () => {
    const reuse = spyReuse();
    await runGig(pipeline(), { seed: "A" }, withReuse(bench(), counting().invoke, "gig-a", reuse));
    const second = counting();
    await runGig(pipeline(), { seed: "B" }, withReuse(bench(), second.invoke, "gig-b", reuse));
    expect(second.total(), "every chair sees the whole payload; the engine cannot know which keys it read").toBe(3);
  });

  it("a changed upstream OUTPUT busts the downstream key — inputs are content, not identity", async () => {
    // The scout is edited, so its own key busts and it re-derives DIFFERENT bytes. The reader's
    // entry is keyed on the content_sha it consumed, so it must miss too — a cache keyed on
    // record IDENTITY (or on position in the DAG) would have served it stale work.
    const reuse = spyReuse();
    await runGig(pipeline(), {}, withReuse(bench(), counting().invoke, "gig-a", reuse));

    const editedScout = testAgent({ slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["seed-t"], domain: "demo", method: "sense something else entirely" });
    const calls: Record<string, number> = {};
    const drifting: AgentInvoker = (ctx) => {
      calls[ctx.agent.slug] = (calls[ctx.agent.slug] ?? 0) + 1;
      switch (ctx.agent.slug) {
        case "scout": return { s: "DIFFERENT BYTES", ...SIGNAL };
        case "reader": return { m: "read", ...INTERPRETATION };
        default: return { e: "judged", ...JUDGMENT };
      }
    };
    const res = await runGig(pipeline({ agents: [editedScout, reader, judge] }), {}, withReuse(bench(), drifting, "gig-b", reuse));

    // ...and the cascade stops where the CONTENT stops differing. The reader, re-run, produced
    // byte-identical output, so the judge's inputs genuinely are the same as last time and its
    // entry is genuinely valid. A cache that invalidated the whole subtree below any change
    // would be safe but would throw away real, provable savings; content-addressing is what
    // lets the invalidation be exactly as wide as the change actually is.
    expect(calls, "the reader must re-derive; the judge must not").toEqual({ scout: 1, reader: 1 });
    expect(res.reuse?.hits.map((h) => h.role)).toEqual(["r3"]);
  });

  it("populating the cache is itself gated by the opt-in", async () => {
    // The store is cross-gig by construction, so WRITING to it is the decision that run A's
    // outputs may serve run B. That is a decision, not a side effect.
    const reuse = spyReuse();
    const b = bench();
    await runGig(pipeline(), {}, { outputs: b.outputs, ledger: b.ledger, invoke: counting().invoke, gig_id: "gig-a" });
    expect(reuse.entries().length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("reuse must never become a way to skip a check", () => {
  const withReuse = (b: Bench, invoke: AgentInvoker, gig: string, reuse: ReuseStore): RunDeps =>
    ({ outputs: b.outputs, ledger: b.ledger, invoke, gig_id: gig, reuse });

  it("an entry whose type has changed shape is REJECTED, not injected", async () => {
    const reuse = spyReuse();
    await runGig(pipeline(), {}, withReuse(bench(), counting().invoke, "gig-a", reuse));

    // `mid-t` changes shape (a new optional property). Everything else — genome, payload,
    // upstream content — is identical, so the cache key still matches and the entry IS found.
    // The edit is additive on purpose: the cached data would still VALIDATE, so only the
    // fingerprint can tell that it was sealed against a type that no longer exists.
    const tightened = bench([seedT, { ...midT, schema: { properties: { m: { type: "string" }, why: { type: "string" } } } }, endT]);
    const second = counting();
    const res = await runGig(pipeline(), {}, withReuse(tightened, second.invoke, "gig-b", reuse));

    expect(second.calls["reader"], "the chair whose type moved must actually re-derive").toBe(1);
    expect(res.reuse?.rejected.map((r) => [r.role, r.reason])).toContainEqual(["r2", "type-fingerprint-mismatch"]);
    expect(res.reuse?.hits.map((h) => h.role), "a rejected entry is not also a hit").not.toContain("r2");
  });

  it("an entry that the CURRENT seal would refuse is rejected — the store is not trusted", async () => {
    // The fingerprint is the cheap guard; the seal boundary is the authoritative one. This is
    // the case the fingerprint cannot catch: an entry written by an older engine (or a hand
    // edit) whose bytes do not satisfy the type it still correctly names.
    const reuse = spyReuse();
    await runGig(pipeline(), {}, withReuse(bench(), counting().invoke, "gig-a", reuse));

    const readerEntry = reuse.entries().find((e) => e.source_role === "r2")!;
    expect(readerEntry, "the run must have cached the reader for this test to mean anything").toBeDefined();
    reuse.put({
      ...readerEntry,
      outputs: readerEntry.outputs.map((o) => ({ ...o, data: { m: 42, ...INTERPRETATION } })),
    });

    const b2 = bench();
    const second = counting();
    const res = await runGig(pipeline(), {}, withReuse(b2, second.invoke, "gig-b", reuse));

    expect(second.calls["reader"], "a refused entry means the work happens, not that the run fails").toBe(1);
    expect(res.reuse?.rejected.map((r) => r.reason)).toContain("seal-rejected");
    // Nothing half-injected: exactly one mid-t exists and it is the freshly derived one.
    const mids = b2.outputs.all().filter((o) => o.domain_type === "mid-t");
    expect(mids.length).toBe(1);
    expect(mids[0]!.reused_from).toBeUndefined();
  });

  it("a multi-output entry is all-or-nothing — one bad record injects neither", async () => {
    // #243 made a chair all-or-nothing at the seal. A reused chair inherits that: an entry
    // whose second record fails validation must not leave the first one durable.
    const dual: Agent = testAgent({ slug: "dual", primitives: ["SENSE", "JUDGE"], input_types: [], output_types: ["seed-t", "end-t"], domain: "demo" });
    const std: Standard = {
      slug: "dual-line", domain: "demo", agents: [dual],
      phases: [{ name: "p", chairs: [{ role: "d", agent_slug: "dual", depends_on: [], input_contract: [], output_contract: ["seed-t", "end-t"], required_skills: [] }] }],
    } as Standard;
    const both: AgentInvoker = () => ({ "seed-t": { s: "a", ...SIGNAL }, "end-t": { e: "b", ...JUDGMENT } });

    const reuse = spyReuse();
    await runGig(std, {}, { outputs: bench().outputs, ledger: new MemoryLedger(), invoke: both, gig_id: "gig-a", reuse });

    const entry = reuse.entries()[0]!;
    reuse.put({
      ...entry,
      // First record intact; SECOND one corrupted.
      outputs: entry.outputs.map((o, i) => (i === 0 ? o : { ...o, data: { e: 7, ...JUDGMENT } })),
    });

    const b2 = bench();
    let calls = 0;
    const res = await runGig(std, {}, { outputs: b2.outputs, ledger: b2.ledger, invoke: (c) => { calls++; return both(c); }, gig_id: "gig-b", reuse });
    expect(calls, "the chair re-derives").toBe(1);
    expect(res.reuse?.rejected.map((r) => r.reason)).toContain("seal-rejected");
    expect(b2.outputs.all().filter((o) => o.reused_from).length, "no half-injection").toBe(0);
    expect(b2.outputs.all().length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("the key, as a pure function", () => {
  const base = {
    standard_slug: "s", phase: "p", chair: { role: "r" }, agent: { slug: "a" },
    skills: [], input_shas: ["aa", "bb"], gig_input_sha: "gi",
    model_version: "m", depth: "skim", output_types: ["t1", "t2"], canonical_form_version: "1.1",
  };

  it("is stable under input ordering — a reordered depends_on consumed the same thing", () => {
    expect(reuseCacheKey({ ...base, input_shas: ["bb", "aa"] })).toBe(reuseCacheKey(base));
  });

  it("no two components can collide by moving a delimiter between them", () => {
    // Length-prefixed framing: "ab"+"c" must not hash as "a"+"bc".
    const a = reuseCacheKey({ ...base, standard_slug: "ab", phase: "c" });
    const b = reuseCacheKey({ ...base, standard_slug: "a", phase: "bc" });
    expect(a).not.toBe(b);
  });

  it("depth is part of the key — a skim answer must not be served to a deep run", () => {
    expect(reuseCacheKey({ ...base, depth: "deep" })).not.toBe(reuseCacheKey(base));
  });

  it("model_version is part of the key", () => {
    expect(reuseCacheKey({ ...base, model_version: "other" })).not.toBe(reuseCacheKey(base));
  });

  it("an entry naming a type the registry cannot describe is never served", () => {
    const entry: ReuseEntry = {
      schema_version: REUSE_SCHEMA_VERSION, cache_key: "k", source_gig_id: "g", source_role: "r",
      created_at: new Date().toISOString(),
      outputs: [{ core_type: "Signal", domain_type: "ghost-t", domain: "demo", primitive: "SENSE", agent_slug: "a", phase: "p", data: {}, content_sha: "x", type_fingerprint: "y", source_output_id: "o" }],
    };
    expect(checkReuseEntry(entry, () => "").reason, "a cache that cannot check its entries must not serve them").toBe("type-unfingerprintable");
  });

  it("an entry from a future schema version is never served", () => {
    const entry: ReuseEntry = {
      schema_version: REUSE_SCHEMA_VERSION + 1, cache_key: "k", source_gig_id: "g", source_role: "r",
      created_at: new Date().toISOString(), outputs: [],
    };
    expect(checkReuseEntry(entry, () => "fp").reason).toBe("schema-version");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("the file-backed stores — what the server actually wires", () => {
  const tmp = (): string => mkdtempSync(join(tmpdir(), "coltrane-reuse-"));

  it("creates nothing until something is written", () => {
    // #210's property, kept: merely bootstrapping deps must leave no trace on disk.
    const dir = tmp();
    createCheckpointStore(dir);
    createReuseStore(dir);
    expect(existsSync(join(dir, "checkpoints"))).toBe(false);
    expect(existsSync(join(dir, "reuse"))).toBe(false);
  });

  it("round-trips a checkpoint", () => {
    const dir = tmp();
    const store = createCheckpointStore(dir);
    const cp: GigCheckpoint = {
      schema_version: CHECKPOINT_SCHEMA_VERSION, gig_id: "g1",
      identity: { standard_slug: "s", genome_hash: "h", gig_input_sha: "i", model_version: "m", depth: "", canonical_form_version: "1.1" },
      started_at: "t0", updated_at: "t1",
      roles: [{ role: "r", phase: "p", output_ids: ["o"], content_shas: ["c"], domain_types: ["t"], type_fingerprints: ["f"], sealed_at: "t1" }],
    };
    store.write(cp);
    expect(store.read("g1")).toEqual(cp);
    expect(store.read("g2")).toBeUndefined();
  });

  it("a gig id cannot name a path", () => {
    // The id reaches the store from a caller's argument. Without this it addresses the
    // filesystem, and `read` is the first thing a resume does.
    const store = createCheckpointStore(tmp());
    expect(store.read("../../etc/passwd")).toBeUndefined();
    expect(store.read("a/b")).toBeUndefined();
  });

  it("a cache key that is not a sha256 is never looked up", () => {
    expect(createReuseStore(tmp()).get("../escape")).toBeUndefined();
  });

  it("a damaged entry THROWS rather than reading as absent", () => {
    // Absent and damaged are different facts. Silently treating damage as "no entry" would
    // make a corrupt cache indistinguishable from a cold one — the runtime turns this into a
    // reported `unreadable` rejection, which is only possible because the store says so.
    const dir = tmp();
    const key = "0".repeat(64);
    mkdirSync(join(dir, "reuse"), { recursive: true });
    writeFileSync(join(dir, "reuse", `${key}.json`), "{not json", "utf8");
    expect(() => createReuseStore(dir).get(key)).toThrow(ReuseStoreError);
  });

  it("a checkpoint write replaces the previous one atomically", () => {
    const dir = tmp();
    const store = createCheckpointStore(dir);
    const base: GigCheckpoint = {
      schema_version: CHECKPOINT_SCHEMA_VERSION, gig_id: "g1",
      identity: { standard_slug: "s", genome_hash: "h", gig_input_sha: "i", model_version: "m", depth: "", canonical_form_version: "1.1" },
      started_at: "t0", updated_at: "t1", roles: [],
    };
    store.write(base);
    store.write({ ...base, updated_at: "t2", roles: [{ role: "r", phase: "p", output_ids: [], content_shas: [], domain_types: [], type_fingerprints: [], sealed_at: "t2" }] });
    const back = store.read("g1")!;
    expect(back.updated_at, "a checkpoint is a snapshot, not an append log").toBe("t2");
    expect(back.roles.length).toBe(1);
  });
});
