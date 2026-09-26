// A TARGET PATH NEVER ESCAPES THE TREE — and is never normalised into a grant.
//
// target_paths arrive in the gig payload: the least trusted input a seat's authority is computed from.
// The resolver narrows Write/Edit to them, so a target that CLIMBS (`src/../coltrane.layout.json`),
// is ABSOLUTE (`/etc/x`), or is spelled with Windows separators (`src\..\coltrane.layout.json`) is an
// attempt to reach a path by a name the grant check does not see. Normalising it first and then
// checking (`src/../README.md` → `README.md`) still hands the seat a path the change never named in
// plain form; removing the normaliser (the surviving plant) makes `src/../coltrane.layout.json` a
// grant outright. The ruling: such an entry is REFUSED — the resolver grants nothing for it, and the
// dispatch door refuses the chair naming the entry, before any seat is invoked.
//
//   law                                           kind         drives                                    plant
//   an escaping entry grants nothing, ever        behavioural  resolveSeatGrants — src/layout_grants.ts  remove normaliseTarget (the raw entry is
//                                                                                                        matched against the glob)
//   …not even after normalising                   behavioural  same                                      normalise `..` and grant the result
//                                                                                                        (today's behaviour)
//   the chair is refused at dispatch, by entry    behavioural  runGig — src/runtime.ts                   skip the escaping-entry check in the
//                                                                                                        target preflight
import { describe, it, expect } from "vitest";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker } from "../src/index.js";
import { loadLayoutGrants, LAYOUT_FILE, type Layout } from "./layout_grants_fixtures.js";

const WIDE: Layout = { paths: { source: ["**"] } };
const SRC: Layout = { paths: { source: ["src/**"] } };

const ESCAPES = [
  "src/../coltrane.layout.json",
  "./src/../../etc/x",
  "../outside.ts",
  "src/../README.md",
  "/abs/path",
  "/etc/passwd",
  "src\\..\\coltrane.layout.json",
  "..\\outside.ts",
  "C:\\abs\\path",
];

const implementer = testAgent({
  slug: "implementer", primitives: ["CREATE"], input_types: [], output_types: ["note"], domain: "demo",
  allowed_tools: ["Read", "Write(@source)", "Edit(@source)"],
});

describe("a target path never escapes the tree", () => {
  for (const bad of ESCAPES) {
    it(`"${bad}" grants nothing under a ** source — only the plain target beside it is granted`, async () => {
      const L = await loadLayoutGrants();
      const r = L.resolveSeatGrants({ agent: implementer, layout: WIDE, target_paths: ["src/ok.ts", bad] });
      const writes = r.grants.filter((g) => /^(Write|Edit)\(/.test(g)).sort();
      expect(writes, `the escaping target "${bad}" became (or normalised into) a grant`).toEqual(["Edit(src/ok.ts)", "Write(src/ok.ts)"]);
      expect(r.grants.some((g) => g.includes(LAYOUT_FILE)), "a target reached the layout file").toBe(false);
    });
  }

  it("under a src/** source, `src/../x` never survives by starting with src/", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: implementer, layout: SRC, target_paths: ["src/../coltrane.layout.json", "src/../../etc/x"] });
    expect(r.grants, "a climbing target matched src/** by its prefix").toEqual(["Read"]);
  });

  describe("the chair is refused at dispatch, naming the entry", () => {
    const standard = {
      slug: "change-v1", domain: "demo", agents: [implementer],
      phases: [{ name: "p", chairs: [{ role: "impl", agent_slug: "implementer", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
    } as unknown as Standard;

    async function dispatch(target_paths: string[]): Promise<{ invoked: number; said: string }> {
      const registry = createRegistry();
      registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
      let invoked = 0;
      const invoke: AgentInvoker = () => { invoked += 1; return { ...coreInvariantFields("Signal"), value: "done" }; };
      let said = "";
      try {
        said = JSON.stringify(await runGig(standard, { request_text: "x", target_paths }, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, layout: WIDE } as never));
      } catch (e) {
        said = String((e as Error)?.message ?? e);
      }
      return { invoked, said };
    }

    for (const bad of ["src/../coltrane.layout.json", "/abs/path", "src\\..\\x.ts"]) {
      it(`"${bad}" refuses the chair before any seat is invoked`, async () => {
        const { invoked, said } = await dispatch(["src/ok.ts", bad]);
        expect(invoked, `an escaping target (${bad}) reached a seat`).toBe(0);
        expect(said.includes(bad) || said.includes(JSON.stringify(bad).slice(1, -1)), `the refusal does not name the entry: ${said.slice(0, 300)}`).toBe(true);
      });
    }
  });
});
