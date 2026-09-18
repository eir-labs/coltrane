// RED — contract-unknown-gig-input-v1: no dispatch payload key is silently ignored.
//
// THE MEASURED PROBLEM (operator, 2026-09-18, src/runtime.ts @52d2dda). The dispatch preflight
// computes `normalizeKey` (~1516) and, inside `missingGigInput` (~1524), both `nearMiss` (a provided
// key that normalizes to the needed one) and `unknown` (every provided key the standard does not
// declare). BOTH exist ONLY inside that error message, which is raised ONLY when a DECLARED input is
// ABSENT. So when every declared input is present, an undeclared key is neither refused nor mentioned:
// it is dropped in silence. A payload carrying BOTH spellings — `grant-requirements` and
// `grant_requirements` — has one read and one dropped, and the caller cannot tell which carried their
// data. In a doctor-facing product the dropped key is the RFP requirements. The engine refuses a dead
// tool grant, an unenforceable skill permission and a boundary check with a missing term list; an
// undeclared dispatch key is the same class and is currently silent.
//
// THE CONTRACT. At preflight — before any chair is prepared or invoked —
//   O1: a payload key that NORMALIZES to a declared input (same string once case, hyphens, underscores
//       and spaces are removed) FAILS the gig with a typed refusal naming the offending key, the
//       declared key it resembles, and the rule that gig input keys are the hyphenated type slug —
//       EVEN WHEN the declared key is also present, because one of the two is being dropped.
//   O2: every OTHER undeclared key is NAMED, never dropped — one typed preflight progress event
//       carrying ALL of them, and `coltrane dispatch` writes them to stderr naming the standard. This
//       is not a refusal: a caller passing harmless metadata keeps working.
//
// THESE LAWS ARE RED BY DESIGN: the near-miss-when-present refusal and the undeclared-key event do not
// exist. runGig with the declared key present runs the chair today; the collision is never checked and
// the harmless keys are never named. Each law fails on that ABSENCE, stating the contract's reason.
//
// The event type this spec introduces is `{ type: "undeclared_gig_input"; standard; keys: string[] }`
// (keys sorted). It is not in the GigProgressEvent union yet, so the laws read `.type`/`.keys` through
// a widening cast (`evType`/`keysOf`) — that keeps `tsc` (build_once's globalSetup) clean while the
// variant is unwritten, so the laws fail at RUNTIME on the missing behaviour, not at compile time.
//
// Every law runs through runGig with a standard composed by composeStandard; I2 uses an `invoke` that
// THROWS if ever called, proving "before any chair fires" rather than asserting it; the O2 CLI law
// goes through `coltrane dispatch`'s own output path (the tests/spec_spend_survives_kill_failure_resume
// pattern). No law invokes a model or reaches the network. See docs/specs/unknown-gig-input.red-spec.md.
import { describe, it, expect } from "vitest";
import {
  composeStandard,
  createOutputStore,
  createRegistry,
  MemoryLedger,
  type AgentInvoker,
  type DomainType,
  type GigProgressEvent,
  type PhaseDef,
  type Standard,
} from "../src/index.js";
import { runGig } from "../src/runtime.js";
import { runCli, type CliIO } from "../src/cli.js";
import type { ServerDeps } from "../src/server.js";
import { testAgent } from "./_support/agents.js";

// ── shared scaffolding (the silent_resolution.test.ts #244 house pattern) ──────────────────────────
const T = (slug: string, core: string): DomainType => ({
  slug, extends: core, domain: "demo",
  schema: { properties: { v: { type: "string" } } }, required_fields: [],
});
// Seed types through the CONSTRUCTOR (not registerType, which enforces type reuse) so two same-shape
// Interpretation types both land.
function harness(types: DomainType[]) {
  return { outputs: createOutputStore(createRegistry(types)), ledger: new MemoryLedger() };
}
// The Interpretation core floor: every sealed `note` must carry claims, or the CHAIR aborts before the
// gig reaches the question these laws are about.
const CLAIMS = { claims: ["fixture: the note carries one claim"] };

const DECLARED = "grant-requirements";           // the declared gig-input type slug (hyphenated)
const NEARMISS = "grant_requirements";           // the underscored near-miss the caller actually sends

// The not-yet-existing preflight event, read through a widening cast so an unwritten union variant is
// not a compile error — the law fails at runtime on the missing emission, not at `tsc`.
const evType = (e: GigProgressEvent): string => (e as { type: string }).type;
const keysOf = (e: GigProgressEvent): string[] => (e as { keys?: string[] }).keys ?? [];
const undeclaredEvents = (evs: GigProgressEvent[]): GigProgressEvent[] =>
  evs.filter((e) => evType(e) === "undeclared_gig_input");

const TYPES = (): DomainType[] => [T(DECLARED, "Interpretation"), T("note", "Interpretation")];

/** One INTERPRET chair that reads a single declared gig input and seals a `note`. The declared input is
 *  a gig seed (input_types), so a payload key is exactly what satisfies it. */
function oneInputStandard(slug = "unknown-input-demo"): Standard {
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

const good: AgentInvoker = () => ({ v: "x", ...CLAIMS });

// ── O1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe("unknown gig input — a near-miss is refused even when the declared key is present (O1)", () => {
  it("O1 — a key that normalizes to a declared input FAILS the gig, naming the offending key, the declared key, and the hyphen rule", async () => {
    const { outputs, ledger } = harness(TYPES());
    let fired = false;
    const invoke: AgentInvoker = () => { fired = true; return { v: "x", ...CLAIMS }; };

    // BOTH spellings present: the declared `grant-requirements` AND the undeclared `grant_requirements`.
    const err = await runGig(
      oneInputStandard(),
      { [DECLARED]: { ...CLAIMS }, [NEARMISS]: { ...CLAIMS } },
      { outputs, ledger, invoke },
    ).catch((e: unknown) => e);

    expect(err, "a near-miss beside the declared key must FAIL the gig — one of the two is being dropped and the caller cannot see which; today the gig runs to completion").toBeInstanceOf(Error);
    const msg = String((err as Error).message);
    expect(msg, "the refusal names the offending undeclared key").toContain(NEARMISS);
    expect(msg, "and the declared key it resembles").toContain(DECLARED);
    expect(msg, "and the rule: gig input keys are the hyphenated type slug").toMatch(/hyphen/i);
    expect(msg, "this is a NEW collision refusal, not the missing-input error — the declared key is present").not.toMatch(/MissingGigInput/);
    expect(fired, "the refusal fires at preflight — no chair is invoked").toBe(false);
  });
});

// ── I2 ─────────────────────────────────────────────────────────────────────────────────────────────
describe("unknown gig input — the near-miss refusal costs nothing (I2)", () => {
  it("I2 — an invoke that THROWS if called is never reached: the near-miss dispatch still fails with the typed refusal", async () => {
    const { outputs, ledger } = harness(TYPES());
    const boom: AgentInvoker = () => { throw new Error("CHAIR_RAN: a chair was invoked before the preflight refusal"); };

    const err = await runGig(
      oneInputStandard(),
      { [DECLARED]: { ...CLAIMS }, [NEARMISS]: { ...CLAIMS } },
      { outputs, ledger, invoke: boom },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const msg = String((err as Error).message);
    // The failure must be the REFUSAL, not the invoke's own throw. Today the declared key is present so
    // the preflight passes and the chair runs — the error carries CHAIR_RAN, proving real money would burn.
    expect(msg, "the near-miss must be refused BEFORE any chair is invoked").toContain(NEARMISS);
    expect(msg, "if this is the invoke's throw, a chair ran before a knowable-at-t=0 refusal").not.toContain("CHAIR_RAN");
  });
});

// ── O2 (runtime event) ───────────────────────────────────────────────────────────────────────────
describe("unknown gig input — every other undeclared key is named, never dropped (O2)", () => {
  it("O2 — undeclared keys (no near-miss) surface on ONE typed preflight event, and the gig still completes", async () => {
    const { outputs, ledger } = harness(TYPES());
    const events: GigProgressEvent[] = [];

    const res = await runGig(
      oneInputStandard(),
      { [DECLARED]: { ...CLAIMS }, extra_meta: 1, another_extra: 2 },
      { outputs, ledger, invoke: good, onProgress: (e) => events.push(e) },
    );

    expect(res.status, "harmless metadata is not a refusal — the gig completes").toBe("complete");
    const named = undeclaredEvents(events);
    expect(named.length, "exactly one typed undeclared-key event is emitted at preflight — today none is").toBe(1);
    expect(keysOf(named[0]!), "the event names ALL undeclared keys, sorted — never merely the first").toEqual(["another_extra", "extra_meta"]);
  });
});

// ── I3 ─────────────────────────────────────────────────────────────────────────────────────────────
describe("unknown gig input — all undeclared keys are named, not the first (I3)", () => {
  it("I3 — three undeclared keys beside the declared one are all named, in sorted order", async () => {
    const { outputs, ledger } = harness(TYPES());
    const events: GigProgressEvent[] = [];

    const res = await runGig(
      oneInputStandard(),
      { [DECLARED]: { ...CLAIMS }, zeta_key: 1, alpha_key: 2, mid_key: 3 },
      { outputs, ledger, invoke: good, onProgress: (e) => events.push(e) },
    );

    expect(res.status).toBe("complete");
    const named = undeclaredEvents(events);
    expect(named.length, "the undeclared keys are carried on one event").toBe(1);
    expect(keysOf(named[0]!), "all three named, sorted — not just the first found").toEqual(["alpha_key", "mid_key", "zeta_key"]);
  });
});

// ── I1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe("unknown gig input — an exactly-declared payload is untouched (I1)", () => {
  it("I1 — exactly the declared keys: no refusal, no undeclared-key event — and the mechanism DOES fire when a key is undeclared", async () => {
    // The clean path: keys are exactly the declared inputs. No refusal, no event, completes as today.
    const clean = harness(TYPES());
    const cleanEvents: GigProgressEvent[] = [];
    const cleanRes = await runGig(
      oneInputStandard(),
      { [DECLARED]: { ...CLAIMS } },
      { outputs: clean.outputs, ledger: clean.ledger, invoke: good, onProgress: (e) => cleanEvents.push(e) },
    );
    expect(cleanRes.status, "an exactly-declared payload runs unchanged").toBe("complete");
    expect(undeclaredEvents(cleanEvents), "no undeclared-key event on the clean path").toEqual([]);

    // NON-VACUITY: the same standard with ONE undeclared key DOES emit exactly one event — so the
    // silence above is a real guarantee, not a mechanism that never fires. This half is RED today.
    const dirty = harness(TYPES());
    const dirtyEvents: GigProgressEvent[] = [];
    const dirtyRes = await runGig(
      oneInputStandard(),
      { [DECLARED]: { ...CLAIMS }, harmless_extra: 1 },
      { outputs: dirty.outputs, ledger: dirty.ledger, invoke: good, onProgress: (e) => dirtyEvents.push(e) },
    );
    expect(dirtyRes.status).toBe("complete");
    expect(undeclaredEvents(dirtyEvents).length, "the mechanism fires when a key IS undeclared — otherwise I1's silence is vacuous").toBe(1);
  });
});

// ── F1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe("unknown gig input — the missing-input path is preserved (F1)", () => {
  it("F1 — a missing declared input keeps its MissingGigInput error; the collision refusal fires only when the declared key is present, and never twice for the same key", async () => {
    // Case A — CONTROL (already law-bound, green): declared ABSENT + its near-miss present → the
    // existing MissingGigInput error with its current near-miss hint. The new refusal must NOT replace it.
    const a = harness(TYPES());
    const errA = await runGig(
      oneInputStandard(),
      { [NEARMISS]: { ...CLAIMS } },
      { outputs: a.outputs, ledger: a.ledger, invoke: good },
    ).catch((e: unknown) => e);
    expect(errA).toBeInstanceOf(Error);
    const msgA = String((errA as Error).message);
    expect(msgA, "the missing-input path stays MissingGigInput — already law-bound").toMatch(/MissingGigInput/);
    expect(msgA, "with its existing near-miss hint").toMatch(/did you mean|hyphen/i);

    // Case B — RED today: declared PRESENT + its near-miss present → the collision refusal, a DIFFERENT
    // error from MissingGigInput, thrown ONCE and NOT also emitted as a harmless undeclared-key event.
    const b = harness(TYPES());
    const events: GigProgressEvent[] = [];
    const errB = await runGig(
      oneInputStandard(),
      { [DECLARED]: { ...CLAIMS }, [NEARMISS]: { ...CLAIMS } },
      { outputs: b.outputs, ledger: b.ledger, invoke: good, onProgress: (e) => events.push(e) },
    ).catch((e: unknown) => e);
    expect(errB, "with the declared key present, the near-miss is refused rather than silently dropped").toBeInstanceOf(Error);
    const msgB = String((errB as Error).message);
    expect(msgB, "the collision refusal is a DIFFERENT error — it never replaces the missing-input path").not.toMatch(/MissingGigInput/);
    expect(msgB, "and names the offending near-miss").toContain(NEARMISS);
    const doubled = undeclaredEvents(events).some((e) => keysOf(e).includes(NEARMISS));
    expect(doubled, "a refused near-miss must not ALSO be reported as a harmless undeclared key — never twice for the same key").toBe(false);
  });
});

// ── O2 (CLI) ─────────────────────────────────────────────────────────────────────────────────────
describe("unknown gig input — coltrane dispatch names undeclared keys on stderr (O2)", () => {
  function cliDeps(): ServerDeps {
    const registry = createRegistry(TYPES());
    const std = oneInputStandard("harmless-meta");
    return {
      registry,
      outputs: createOutputStore(registry),
      ledger: new MemoryLedger(),
      standards: new Map([[std.slug, std]]),
      invoke: good,
      gig_runs: new Map(),
    };
  }
  function cliIo(deps: ServerDeps): { io: CliIO; stderr: () => string } {
    const errBuf: string[] = [];
    return { io: { out: () => {}, err: (s: string) => errBuf.push(s), deps } as CliIO, stderr: () => errBuf.join("") };
  }

  it("O2 (CLI) — a completing dispatch with harmless metadata writes the undeclared keys and the standard to stderr", async () => {
    const { io, stderr } = cliIo(cliDeps());
    const payload = JSON.stringify({ [DECLARED]: { ...CLAIMS }, extra_meta: 1, another_extra: 2 });

    const code = await runCli(["dispatch", "harmless-meta", "--wait", "--input", payload], io);
    const out = stderr();

    expect(code, "harmless metadata is not a refusal — the dispatch still exits 0").toBe(0);
    expect(out, "the dispatch command must NAME the undeclared keys on stderr — today it prints only 'complete'").toContain("extra_meta");
    expect(out, "every undeclared key, not the first").toContain("another_extra");
    expect(out, "and names the standard that did not declare them").toContain("harmless-meta");
  });
});
