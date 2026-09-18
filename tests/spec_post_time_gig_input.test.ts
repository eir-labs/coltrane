// RED — contract-post-time-gig-input-v1: the hosted dispatch door validates the payload at POST time,
// in the same words as the preflight, and says so when it could not.
//
// THE MEASURED PROBLEM (operator, 2026-09-18, src/server.ts @5693588). contract-unknown-gig-input-v1
// validates the dispatch payload in runGig's preflight (src/runtime.ts ~1613) — the LOCAL dispatch path
// and the drain's. But the HOSTED branch of the surface (callSurfaceTool → gig_dispatch, src/server.ts
// ~3765) hands `args` STRAIGHT to `deps.queueGig(args)` and returns, before any standard is resolved.
// `postgrestQueueGig` posts p_standard and p_input to the coltrane_gig_dispatch RPC without consulting
// the standard. So a misspelled or undeclared key posted through the hosted door is caught when the
// WORKER runs the gig, not when the caller posts it. The partner's product is doctor-facing (Optimedge
// Grant Studio): a doctor uploads an RFP, the product posts a dispatch, and the person who could still
// fix the key is told nothing — the failure surfaces later as a run that did not do what they asked.
//
// THE CONTRACT (contract-post-time-gig-input-v1). Before `deps.queueGig` is called, the hosted door
// partitions the payload against the standard's declared inputs EXACTLY as the preflight does:
//   O1: a near-miss — an undeclared key that normalizes to a declared key which is ALSO present —
//       returns a typed refusal `{ ok: false, refusal: "unknown_gig_input", error }` and NOTHING is
//       queued. The engine NEVER throws on this path (a throw reaches the caller as an opaque failure).
//   O2: the refusal's `error` is produced by the SAME builder the preflight uses — identical down to
//       the character, whichever door caught it, so the two doors cannot drift into two vocabularies.
//   O3: OTHER undeclared keys do not refuse — the gig is queued and the reply carries them, sorted, as
//       `undeclared_input_keys`, so the caller is told at post time what the engine will ignore.
//   O4: the declared inputs are read from `deps.standards` when the surface holds that standard;
//       otherwise from an optional host-wired reader `deps.declaredGigInputs(standard_slug)` — the
//       engine defines the seam, the host wires it (the same idiom as `queueGig`). Exactly one read.
//   I1: the preflight is NOT replaced. A gig queued by something other than this door is still
//       validated when it runs.
//   I2: a clean payload is queued exactly as today — byte-identical args to queueGig, no annotation.
//   F1: when neither deps.standards nor a wired reader can supply the declared inputs, the engine does
//       NOT guess: the gig is queued as today and the reply carries `input_validated: false` with a
//       `reason`. The preflight remains the backstop.
//   F2: an absent or non-object payload is unchanged — this contract adds no new refusal for a shape
//       the door already handles.
//
// THESE LAWS ARE RED BY DESIGN: the hosted door forwards `args` unvalidated today, so it never refuses a
// near-miss, never annotates undeclared keys, and never says it could not check. Each law fails on that
// ABSENCE, stating the contract's reason. The laws drive the REAL hosted door (createToolSurface with
// `hosted: true` deps + an injected `queueGig` that RECORDS its calls and, where the contract says
// nothing must be queued, ALSO throws) — so "refused before anything is queued" is PROVEN by an empty
// call log, not asserted. One law (O2) compares the post-time refusal to the preflight's for the same
// payload, character for character. No law invokes a model or reaches the network.
//
// `deps.declaredGigInputs`, `res.undeclared_input_keys`, `res.input_validated` and `res.reason` are the
// new seams/fields this contract introduces; they are read through widening casts (HostedDepsX,
// undeclaredKeysOf, …) so an unwritten type is not a compile error — the laws fail at RUNTIME on the
// missing behaviour, not at `tsc` (build_once's globalSetup). See docs/specs/post-time-gig-input.red-spec.md.
import { describe, it, expect, vi } from "vitest";
import {
  composeStandard,
  createOutputStore,
  createRegistry,
  MemoryLedger,
  type AgentInvoker,
  type DomainType,
  type PhaseDef,
  type Standard,
} from "../src/index.js";
import { runGig } from "../src/runtime.js";
import { createToolSurface, type ToolSurfaceDeps, type SurfaceToolResult } from "../src/server.js";
import { testAgent } from "./_support/agents.js";

// ── shared scaffolding (the spec_unknown_gig_input.test.ts house pattern) ─────────────────────────────
const T = (slug: string, core: string): DomainType => ({
  slug, extends: core, domain: "demo",
  schema: { properties: { v: { type: "string" } } }, required_fields: [],
});
const TYPES = (): DomainType[] => [T(DECLARED, "Interpretation"), T("note", "Interpretation")];

const DECLARED = "grant-requirements";           // the declared gig-input type slug (hyphenated)
const NEARMISS = "grant_requirements";           // the underscored near-miss the caller actually sends
const STD = "post-time-demo";                    // the standard slug both doors resolve against
const VAL = { v: "x" };                          // a payload value — the preflight only checks presence

// One INTERPRET chair that reads a single declared gig input and seals a `note`. The declared input is a
// gig seed (input_types), so a payload key is exactly what satisfies it. Same shape as the preflight spec.
function oneInputStandard(slug = STD): Standard {
  return composeStandard({
    slug, domain: "demo",
    agents: [testAgent({ slug: "needer", primitives: ["INTERPRET"], input_types: [DECLARED], output_types: ["note"] })],
    input_types: [DECLARED],
    phases: [{
      name: "p0",
      chairs: [{ role: "N", agent_slug: "needer", depends_on: [], input_contract: [DECLARED], output_contract: ["note"], required_skills: [] }],
    }] as PhaseDef[],
  });
}

function harness() {
  const registry = createRegistry(TYPES());
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

// The hosted surface deps, plus the new host-wired reader seam this contract defines. `declaredGigInputs`
// is not on ToolSurfaceDeps yet — carried here as a widening extension so the field reaches the door at
// runtime while `tsc` stays clean (the seam is unwritten, so the RED failure is a runtime one).
type HostedDepsX = ToolSurfaceDeps & { declaredGigInputs?: (slug: string) => Promise<string[]> };

function hostedDeps(opts: {
  standards: Map<string, Standard>;
  queueGig: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  declaredGigInputs?: (slug: string) => Promise<string[]>;
}): HostedDepsX {
  const registry = createRegistry(TYPES());
  const base: ToolSurfaceDeps = {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    hosted: true,
    standards: opts.standards,
    queueGig: opts.queueGig,
  };
  return opts.declaredGigInputs ? { ...base, declaredGigInputs: opts.declaredGigInputs } : base;
}

async function dispatch(deps: HostedDepsX, args: Record<string, unknown>): Promise<SurfaceToolResult> {
  const tool = createToolSurface(deps).find((t) => t.name === "gig_dispatch");
  return tool!.call(args);
}

// A queue seam that RECORDS every call and returns a queued row — the honest "it was queued" witness.
function recordingQueue(): { fn: (a: Record<string, unknown>) => Promise<Record<string, unknown>>; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return { fn: async (a) => { calls.push(a); return { gig_id: "gig-1", status: "queued" }; }, calls };
}

// A queue seam that RECORDS then THROWS: wired where the contract says nothing must be queued. If it is
// ever reached, the call log is non-empty AND the throw text leaks — both are how a law proves the door
// did not refuse before queuing.
function guardedQueue(): { fn: (a: Record<string, unknown>) => Promise<Record<string, unknown>>; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return { fn: async (a) => { calls.push(a); throw new Error("QUEUED_ON_REFUSAL: nothing must be queued when the payload is refused"); }, calls };
}

const mapOf = (std: Standard): Map<string, Standard> => new Map([[std.slug, std]]);

// The new reply fields, read through widening casts (an unwritten field is not a compile error).
const undeclaredKeysOf = (r: SurfaceToolResult): string[] | undefined => (r as { undeclared_input_keys?: string[] }).undeclared_input_keys;
const inputValidatedOf = (r: SurfaceToolResult): boolean | undefined => (r as { input_validated?: boolean }).input_validated;
const reasonOf = (r: SurfaceToolResult): string | undefined => (r as { reason?: string }).reason;

const throwingInvoke: AgentInvoker = () => { throw new Error("CHAIR_RAN: a chair was invoked before a t=0 refusal"); };

// ── O1 ────────────────────────────────────────────────────────────────────────────────────────────
describe("post-time gig input — a near-miss is refused at POST time, before anything is queued (O1)", () => {
  it("O1 — a near-miss returns { ok:false, refusal:'unknown_gig_input', error }, NOTHING is queued, and the door never throws", async () => {
    const q = guardedQueue(); // records-then-throws: if the door queues, both the log and the text betray it
    const res = await dispatch(
      hostedDeps({ standards: mapOf(oneInputStandard()), queueGig: q.fn }),
      { standard_slug: STD, input: { [DECLARED]: VAL, [NEARMISS]: VAL } },
    );

    expect(q.calls.length, "refused BEFORE anything is queued — the guarded queue must never be reached").toBe(0);
    expect(res.ok, "a near-miss is a refusal, not a queued gig").toBe(false);
    expect(res.refusal, "the typed refusal code the caller branches on — not an opaque throw").toBe("unknown_gig_input");
    expect(String(res.error ?? ""), "the refusal names the offending near-miss key").toContain(NEARMISS);
    expect(String(res.error ?? ""), "the engine never throws on this path — a throw would reach the caller as an opaque queue failure").not.toContain("QUEUED_ON_REFUSAL");
  });
});

// ── O2 ────────────────────────────────────────────────────────────────────────────────────────────
describe("post-time gig input — the two doors speak ONE vocabulary (O2)", () => {
  it("O2 — the post-time refusal message is byte-identical to the preflight's for the same payload", async () => {
    const payload = { [DECLARED]: VAL, [NEARMISS]: VAL };
    const std = oneInputStandard();

    // The preflight's message for the SAME payload + standard (the collision refusal, thrown at t=0).
    const { outputs, ledger } = harness();
    const preErr = await runGig(std, payload, { outputs, ledger, invoke: throwingInvoke }).catch((e: unknown) => e);
    expect(preErr, "the preflight refuses the near-miss (the control this door must match)").toBeInstanceOf(Error);
    const preMsg = String((preErr as Error).message);

    // The hosted door for the same payload — its refusal `error` must be the preflight's, character for character.
    const q = recordingQueue();
    const res = await dispatch(hostedDeps({ standards: mapOf(std), queueGig: q.fn }), { standard_slug: STD, input: payload });

    expect(res.ok, "the door refuses the near-miss").toBe(false);
    expect(res.error, "the post-time refusal is the preflight's message down to the character — one builder, not two vocabularies").toBe(preMsg);
  });
});

// ── O3 ────────────────────────────────────────────────────────────────────────────────────────────
describe("post-time gig input — other undeclared keys are named at post time, never dropped (O3)", () => {
  it("O3 — harmless undeclared keys do not refuse: the gig is queued and the reply names them, sorted, as undeclared_input_keys", async () => {
    const q = recordingQueue();
    const res = await dispatch(
      hostedDeps({ standards: mapOf(oneInputStandard()), queueGig: q.fn }),
      { standard_slug: STD, input: { [DECLARED]: VAL, zeta_x: 1, alpha_x: 2 } },
    );

    expect(res.ok, "harmless metadata is not a refusal — the gig is queued").toBe(true);
    expect(q.calls.length, "the gig still reaches the queue").toBe(1);
    expect(undeclaredKeysOf(res), "the caller is told AT POST TIME which keys the engine will ignore, ALL of them, sorted").toEqual(["alpha_x", "zeta_x"]);
  });
});

// ── O4 ────────────────────────────────────────────────────────────────────────────────────────────
describe("post-time gig input — the declared inputs come from deps.standards, else a wired reader (O4)", () => {
  it("O4 — deps.standards is used when it holds the standard; otherwise exactly one read of the host-wired reader", async () => {
    const payload = { [DECLARED]: VAL, [NEARMISS]: VAL };

    // (a) deps.standards HOLDS the standard → the host reader is never consulted, and the near-miss is caught.
    const readerA = vi.fn(async (_slug: string): Promise<string[]> => [DECLARED]);
    const qa = guardedQueue();
    const resA = await dispatch(
      hostedDeps({ standards: mapOf(oneInputStandard()), queueGig: qa.fn, declaredGigInputs: readerA }),
      { standard_slug: STD, input: payload },
    );
    expect(resA.refusal, "the standard on deps.standards is enough to catch the near-miss").toBe("unknown_gig_input");
    expect(readerA, "when deps.standards holds the standard, NO host read is issued").not.toHaveBeenCalled();
    expect(qa.calls.length, "nothing is queued on the refusal").toBe(0);

    // (b) deps.standards is EMPTY but a reader is wired → exactly ONE read of THIS slug, and the near-miss is still caught.
    const readerB = vi.fn(async (_slug: string): Promise<string[]> => [DECLARED]);
    const qb = guardedQueue();
    const resB = await dispatch(
      hostedDeps({ standards: new Map(), queueGig: qb.fn, declaredGigInputs: readerB }),
      { standard_slug: STD, input: payload },
    );
    expect(readerB, "the engine defines the seam; the host wires the read — exactly one narrow read").toHaveBeenCalledTimes(1);
    expect(readerB, "and it reads THIS standard's declared inputs, not another genome class").toHaveBeenCalledWith(STD);
    expect(resB.refusal, "the wired reader supplies the declared inputs and the near-miss is caught").toBe("unknown_gig_input");
    expect(qb.calls.length, "nothing is queued on the refusal").toBe(0);
  });
});

// ── I1 ────────────────────────────────────────────────────────────────────────────────────────────
describe("post-time gig input — the preflight is not replaced (I1)", () => {
  it("I1 — a payload the hosted door NEVER saw still fails in runGig, AND the hosted door adds the same gate at post time", async () => {
    const std = oneInputStandard();

    // The backstop (GREEN today, must stay): a gig validated when it RUNS, not posted through this door.
    const { outputs, ledger } = harness();
    const backstop = await runGig(std, { [DECLARED]: VAL, [NEARMISS]: VAL }, { outputs, ledger, invoke: throwingInvoke }).catch((e: unknown) => e);
    expect(backstop, "the preflight remains the backstop for a payload this door never saw").toBeInstanceOf(Error);
    expect(String((backstop as Error).message), "and it still names the near-miss").toContain(NEARMISS);

    // The new door (RED today): the SAME near-miss is ALSO caught at post time — an ADDITION, not a replacement.
    const q = guardedQueue();
    const res = await dispatch(hostedDeps({ standards: mapOf(std), queueGig: q.fn }), { standard_slug: STD, input: { [DECLARED]: VAL, [NEARMISS]: VAL } });
    expect(res.refusal, "the hosted door adds a SECOND gate in front of the queue — it does not weaken the preflight").toBe("unknown_gig_input");
    expect(q.calls.length, "and it refuses before queuing").toBe(0);
  });
});

// ── I2 ────────────────────────────────────────────────────────────────────────────────────────────
describe("post-time gig input — a clean payload is queued exactly as today (I2)", () => {
  it("I2 — an exactly-declared payload reaches queueGig byte-identical with no annotation; the annotation mechanism DOES fire when a key is undeclared", async () => {
    // The clean path: keys are exactly the declared inputs. Byte-identical to today's forwarded args, no annotation.
    const qClean = recordingQueue();
    const cleanArgs = { standard_slug: STD, input: { [DECLARED]: VAL } };
    const cleanRes = await dispatch(hostedDeps({ standards: mapOf(oneInputStandard()), queueGig: qClean.fn }), cleanArgs);
    expect(cleanRes.ok, "a clean payload is queued").toBe(true);
    expect(qClean.calls[0], "byte-identical to what today's door forwards — validation adds nothing to a clean payload").toEqual(cleanArgs);
    expect(undeclaredKeysOf(cleanRes), "a clean reply carries no undeclared_input_keys").toBeUndefined();

    // NON-VACUITY (RED today): one undeclared key DOES surface, so the silence above is a guarantee, not a dead mechanism.
    const qDirty = recordingQueue();
    const dirtyRes = await dispatch(hostedDeps({ standards: mapOf(oneInputStandard()), queueGig: qDirty.fn }), { standard_slug: STD, input: { [DECLARED]: VAL, harmless_x: 1 } });
    expect(dirtyRes.ok).toBe(true);
    expect(undeclaredKeysOf(dirtyRes), "the mechanism fires when a key IS undeclared — otherwise I2's silence is vacuous").toEqual(["harmless_x"]);
  });
});

// ── F1 ────────────────────────────────────────────────────────────────────────────────────────────
describe("post-time gig input — when the engine cannot check, it SAYS so (F1)", () => {
  it("F1 — neither deps.standards nor a wired reader can supply the declared inputs: the gig is queued as today and the reply is input_validated:false with a reason", async () => {
    const q = recordingQueue();
    // Unknown slug, no reader → the door cannot resolve the declared inputs.
    const args = { standard_slug: "unknown-slug", input: { [DECLARED]: VAL, [NEARMISS]: VAL } };
    const res = await dispatch(hostedDeps({ standards: new Map(), queueGig: q.fn }), args);

    expect(res.ok, "the engine does NOT guess and does not refuse — it queues as today and lets the preflight backstop it").toBe(true);
    expect(q.calls.length, "the gig is queued as today").toBe(1);
    expect(inputValidatedOf(res), "the reply does not IMPLY it checked — it says it could not").toBe(false);
    expect(String(reasonOf(res) ?? ""), "and names WHY it could not be checked").toMatch(/standard|declared|reader|resolve|unknown/i);
    expect(res.refusal, "'could not check' is not a refusal — the payload is not rejected").not.toBe("unknown_gig_input");
  });
});

// ── F2 ────────────────────────────────────────────────────────────────────────────────────────────
describe("post-time gig input — an absent or non-object payload is unchanged (F2)", () => {
  it("F2 — the post-time guard fires only on a present, object payload: an absent or non-object payload adds NO new refusal", async () => {
    // A present near-miss DOES refuse (RED today) — the guard exists and is scoped to real payloads.
    const qNear = recordingQueue();
    const near = await dispatch(hostedDeps({ standards: mapOf(oneInputStandard()), queueGig: qNear.fn }), { standard_slug: STD, input: { [DECLARED]: VAL, [NEARMISS]: VAL } });
    expect(near.refusal, "a present near-miss is refused — the guard is real").toBe("unknown_gig_input");

    // An ABSENT payload adds no new refusal and is queued as today.
    const qAbsent = recordingQueue();
    const absent = await dispatch(hostedDeps({ standards: mapOf(oneInputStandard()), queueGig: qAbsent.fn }), { standard_slug: STD });
    expect(absent.refusal, "an absent payload is a shape the door already handles — no new unknown_gig_input refusal").not.toBe("unknown_gig_input");
    expect(qAbsent.calls.length, "and it is queued as today").toBe(1);

    // A NON-OBJECT payload adds no new refusal either.
    const qNonObj = recordingQueue();
    const nonObj = await dispatch(hostedDeps({ standards: mapOf(oneInputStandard()), queueGig: qNonObj.fn }), { standard_slug: STD, input: "not-an-object" });
    expect(nonObj.refusal, "a non-object payload adds no new unknown_gig_input refusal").not.toBe("unknown_gig_input");
  });
});
