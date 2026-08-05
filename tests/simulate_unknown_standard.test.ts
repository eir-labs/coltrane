// #267 — `standard_simulate` returns ok:true for a standard that does not exist.
//
//   standard_simulate({ standard_slug: "this-standard-does-not-exist-xyzzy" })
//   → { ok: true, data: { phases: [sense, process, deliver], estimated_cost: 1 } }
//
// The tool is documented — here and in downstream CLAUDE.md — as the cheap pre-dispatch
// gate: "validate before you spend". A gate that cannot fail is worse than no gate,
// because callers stop looking. A typo'd slug is the single most likely thing an
// operator wants caught, and it is exactly what slips through.
//
// #239 fixed the ESTIMATE for the case where the standard resolves. This is the
// unresolvable case, which still falls through to an invented three-phase skeleton.
// `basis: "fallback"` is honest labelling, but it is a field inside a SUCCESS payload —
// it stops nobody.
//
// The gate belongs at the MCP boundary, not in `standardSimulate()`. The pure function's
// fallback path is tested (estimate_honesty.test.ts) and used elsewhere; it is the TOOL
// that must refuse. Same principle as #263/#227: a validity check nobody consults is not
// a validity check.
import { describe, it, expect } from "vitest";
import {
  createRegistry,
  createOutputStore,
  composeStandard,
  MemoryLedger,
  standardSimulate,
  type DomainType,
  type Chair,
  type PhaseDef,
  type Standard,
  type ServerDeps,
} from "../src/index.js";
import { dispatchTool } from "../src/server.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const reading: DomainType = { slug: "reading", extends: "Interpretation", domain: "demo", schema: { properties: { v: { type: "string" } } }, required_fields: ["v"] };

const c = (role: string, agent_slug: string, depends_on: string[], input_contract: string[], output_contract: string[]): Chair =>
  ({ role, agent_slug, depends_on, input_contract, output_contract, required_skills: [] });

const realStandard = (): Standard => composeStandard({
  slug: "convergence-lite", domain: "demo",
  agents: [
    testAgent({ slug: "parser", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" }),
    testAgent({ slug: "blueprinter", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["reading"], domain: "demo" }),
  ],
  phases: [
    { name: "rfp-parse", chairs: [c("p", "parser", [], [], ["note"])] } as PhaseDef,
    { name: "blueprint", chairs: [c("b", "blueprinter", ["p"], ["note"], ["reading"])] } as PhaseDef,
  ],
});

/** `withStandards: false` models a host that wired no standards map at all — the tool
 *  cannot resolve ANYTHING there, which is a different situation from "I looked and it
 *  is not present". */
function makeDeps(withStandards = true): ServerDeps {
  const registry = createRegistry();
  for (const t of [note, reading]) registry.registerType(t);
  const std = realStandard();
  return {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    ...(withStandards ? { standards: new Map([[std.slug, std]]) } : {}),
  };
}

describe("#267 — standard_simulate refuses a standard it cannot find", () => {
  // THE case.
  it("does not return ok:true for a slug that does not exist", async () => {
    const r = await dispatchTool(
      "standard_simulate",
      { standard_slug: "this-standard-does-not-exist-xyzzy", mock_input: {}, depth: "standard" },
      makeDeps(),
    );
    expect(
      r.ok,
      "an estimate for a standard that does not exist is a fabricated number presented as a reading",
    ).toBe(false);
  });

  it("names the slug it could not find, and where to look", async () => {
    const r = await dispatchTool(
      "standard_simulate",
      { standard_slug: "submisson-convergence", mock_input: {}, depth: "standard" }, // typo, deliberately
      makeDeps(),
    );
    expect(r.error ?? "").toMatch(/submisson-convergence/);
    expect(r.error ?? "", "point the operator at the thing that loads standards").toMatch(/genome_reload/);
  });

  it("refuses an empty slug rather than estimating the empty string", async () => {
    const r = await dispatchTool("standard_simulate", { mock_input: {}, depth: "standard" }, makeDeps());
    expect(r.ok).toBe(false);
  });

  // Positive control — without this, "refuse everything" passes the tests above.
  it("still simulates a standard that DOES exist, with its real phases", async () => {
    const r = await dispatchTool(
      "standard_simulate",
      { standard_slug: "convergence-lite", mock_input: {}, depth: "standard" },
      makeDeps(),
    );
    expect(r.ok).toBe(true);
    const d = r.data as { phases: { name: string }[]; basis: string };
    expect(d.phases.map((p) => p.name)).toEqual(["rfp-parse", "blueprint"]);
    expect(d.basis).toBe("structural");
  });

  // "I looked and it is absent" is a different answer from "I have no way to look".
  // A host that wired no standards map has not told us the slug is wrong, so turning
  // that into a rejection would be a fabrication in the other direction.
  it("leaves a host with no standards map on the fallback path", async () => {
    const r = await dispatchTool(
      "standard_simulate",
      { standard_slug: "anything-at-all", mock_input: {}, depth: "standard" },
      makeDeps(false),
    );
    expect(r.ok).toBe(true);
    expect((r.data as { basis: string }).basis).toBe("fallback");
  });

  // The pure function keeps its fallback. The gate is the tool's job, and putting it in
  // `standardSimulate` would break its other callers and its own tests.
  it("does not move the gate into standardSimulate()", () => {
    const guess = standardSimulate({ standard_slug: "unknown-thing", mock_input: {}, depth: "standard" });
    expect(guess.basis).toBe("fallback");
    expect(guess.estimated_cost).toBeGreaterThan(0);
  });
});
