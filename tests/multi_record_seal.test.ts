// RED-first — a chair that writes N well-formed records of its declared output type must end the
// gig with N records in the store. The ledger's core promise is that `ok:true` means KEPT; the
// collapsing seal path broke it silently.
//
// WHAT WAS MEASURED (the change request's evidence, not a hypothesis): gig 8baced9d
// (lineage-deepen-v0, chair identify-external, output_types ['lineage-hit']) called output_write
// FIFTEEN times. Every call returned {ok:true, validated:true}. ONE record reached the store. The
// seat then truthfully reported "all 11 lineage hits are sealed" — it was told exactly that. Same
// pattern across ff9819d6. Seventeen outputs discarded across two gigs, every one acknowledged as
// valid, because captureOutputWrites kept the LAST write per declared type (last-wins overwrite)
// and executeChair sealed one record from that single blob.
//
// The four laws below pin the fix (direction settled by miles: Option A — seal all valid records,
// bounded by a named cap whose surplus is refused loudly):
//   (a) N same-type calls seal N records — 15 accepted → 15 stored, not 1.
//   (b) The acknowledgement matches the effect — every ok write has a content-matching stored row,
//       checked by CONTENT lookup, not by count.
//   (c) The bound is named and finite — the (MAX_SEALED_RECORDS_PER_TYPE + 1)th same-type write is
//       refused loudly, so an unbounded seal path cannot become a DoS on the ledger.
//   (d) Downstream consumption is unaffected — many records of one type from one upstream chair are
//       all resolved by a dependent chair via AgentInvocationContext.inputs (already a list).
//
// Law (e) — single-seal chairs (human approval, skill-backed) still seal exactly one — is guarded
// by the UNCHANGED tests/multi_output_chair.test.ts, tests/human_chair_approval.test.ts and the
// skill single-seal suites, not re-asserted here.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, captureOutputWrites, MAX_SEALED_RECORDS_PER_TYPE } from "../src/claude_invoker.js";
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  composeStandard,
  runGig,
  type AgentInvoker,
  type PhaseDef,
  type Chair,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";

function setup() {
  const registry = createRegistry();
  // lineage-hit is a Signal (substance floor: `source`); the scout gathers many of them.
  registry.registerType({
    slug: "lineage-hit", extends: "Signal", domain: "demo",
    schema: { properties: { source: { type: "string" }, claim: { type: "string" } } },
    required_fields: ["source"],
  });
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { registry, outputs, ledger };
}

const scout = () => testAgent({ slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["lineage-hit"], domain: "demo" });
const scoutChair: Chair = {
  role: "identify-external", agent_slug: "scout", depends_on: [],
  input_contract: [], output_contract: ["lineage-hit"], required_skills: [],
};

/** One in-band output_write tool_use for a lineage-hit, as the child's stream-json emits it. */
const writeLine = (id: string, data: Record<string, unknown>): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { domain_type: "lineage-hit", data } }] },
  });

/** A clean run that sealed N distinct lineage-hits, each with content the store can be searched for. */
const streamOf = (n: number): string =>
  [
    ...Array.from({ length: n }, (_, i) => writeLine(`w${i}`, { source: `hit-${i}`, claim: `claim-${i}` })),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }),
  ].join("\n");

const scoutStd = () =>
  composeStandard({
    slug: "scout-std", domain: "demo", agents: [scout()],
    phases: [{ name: "identify", chairs: [scoutChair] } as PhaseDef],
  });

describe("(a) a chair that writes N well-formed records of its declared type seals N, not 1", () => {
  it("15 accepted lineage-hit writes leave 15 records in the store (gig 8baced9d sealed 1)", async () => {
    const { registry, outputs, ledger } = setup();
    const invoke = makeClaudeInvoker({ registry, sealVia: "output_write", run: () => streamOf(15) });
    const res = await runGig(scoutStd(), { q: "x" }, { outputs, ledger, invoke });
    expect(res.status).toBe("complete");
    const sealed = outputs.all().filter((o) => o.gig_id === res.gig_id && o.domain_type === "lineage-hit");
    // The heart of the change request: gig 8baced9d made 15 accepted output_write calls and sealed
    // 1. Against the collapsing seal path this reads 1 and fails; the multi-record seal makes it 15.
    expect(sealed.length, "15 accepted calls must leave 15 records — silently keeping 1 is the lie being fixed").toBe(15);
  });
});

describe("(b) the acknowledgement matches the effect — every ok write has a content-matching row", () => {
  it("for every accepted write, a stored record with that EXACT content exists (content lookup, not count)", async () => {
    const { registry, outputs, ledger } = setup();
    const invoke = makeClaudeInvoker({ registry, sealVia: "output_write", run: () => streamOf(15) });
    const res = await runGig(scoutStd(), { q: "x" }, { outputs, ledger, invoke });
    const sealed = outputs.all().filter((o) => o.gig_id === res.gig_id && o.domain_type === "lineage-hit");
    for (let i = 0; i < 15; i++) {
      const found = sealed.find((o) => {
        const d = o.data as { source?: unknown; claim?: unknown };
        return d.source === `hit-${i}` && d.claim === `claim-${i}`;
      });
      expect(found, `write ${i} returned ok but no stored record carries its content — ack without effect`).toBeTruthy();
    }
  });
});

describe("(c) the bound on how many records one chair may seal is named and finite", () => {
  it("the (MAX_SEALED_RECORDS_PER_TYPE + 1)th same-type write is REFUSED loudly, not dropped", () => {
    // Referenced by the exported constant name — a literal here would drift from the one declaration
    // site the bound is tuned at. An unbounded seal path is a denial-of-service on the ledger.
    expect(() => captureOutputWrites(streamOf(MAX_SEALED_RECORDS_PER_TYPE + 1), ["lineage-hit"]))
      .toThrow(/MAX_SEALED_RECORDS_PER_TYPE/);
  });

  it("exactly MAX_SEALED_RECORDS_PER_TYPE same-type writes is within bound and keeps every one", () => {
    const blob = captureOutputWrites(streamOf(MAX_SEALED_RECORDS_PER_TYPE), ["lineage-hit"]);
    expect((blob["lineage-hit"] as unknown[]).length).toBe(MAX_SEALED_RECORDS_PER_TYPE);
  });
});

describe("(d) downstream consumption is unaffected — a dependent chair resolves ALL the records", () => {
  it("many records of one type from one upstream chair are all resolved via ctx.inputs (already a list)", async () => {
    const { registry, outputs, ledger } = setup();
    registry.registerType({
      // `count` is tally's own distinguishing field — requiring it (not the inherited Signal
      // floor `source`) keeps tally from scoring as a near-duplicate of lineage-hit under reuse
      // enforcement (same extends+domain+required `source` scores 100 >= 80 and is refused). The
      // Signal substance floor `source` is still enforced at seal and supplied by the invoke below.
      slug: "tally", extends: "Signal", domain: "demo",
      schema: { properties: { count: { type: "number" } } }, required_fields: ["count"],
    });
    const tallier = testAgent({ slug: "tallier", primitives: ["SENSE"], input_types: ["lineage-hit"], output_types: ["tally"], domain: "demo" });
    const upstream = makeClaudeInvoker({ registry, sealVia: "output_write", run: () => streamOf(15) });
    let seenCount = -1;
    const invoke: AgentInvoker = async (ctx) => {
      if (ctx.agent.slug === "scout") return upstream(ctx);
      // The dependent chair sees every upstream lineage-hit, because inputs is a readonly list.
      seenCount = ctx.inputs.filter((i) => i.domain_type === "lineage-hit").length;
      return { source: "fixture://demo/tally", count: seenCount };
    };
    const std = composeStandard({
      slug: "scout-then-tally", domain: "demo", agents: [scout(), tallier],
      phases: [
        { name: "identify", chairs: [scoutChair] } as PhaseDef,
        { name: "tally", chairs: [{ role: "tally", agent_slug: "tallier", depends_on: ["identify-external"], input_contract: ["lineage-hit"], output_contract: ["tally"], required_skills: [] }] } as PhaseDef,
      ],
    });
    await runGig(std, { q: "x" }, { outputs, ledger, invoke });
    // Before the fix production collapses to 1, so only one record ever reaches downstream and this
    // reads 1 even though inputs was already a list. After the fix all 15 arrive.
    expect(seenCount, "a dependent chair must resolve every record of a type its upstream sealed").toBe(15);
  });
});
