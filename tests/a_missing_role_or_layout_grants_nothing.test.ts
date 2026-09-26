// RED-DEF-13 — FAIL CLOSED ON A MISSING ROLE OR A MISSING LAYOUT.
//
// A role token is a question to the repository: "what is your source?" When the repository does not
// answer — its layout declares no such role, or the gig runs against a tree with no layout at all — the
// only honest answer is NOTHING. The tempting default (`**`, "the whole tree") is the exact widening this
// change exists to end, arriving by omission instead of by amendment. So the token grants nothing, the
// result carries a refusal NAMING the role, and the chair is refused at dispatch naming it — before any
// seat is spawned.
//
//   law                                          kind         drives                                  plant
//   no layout → nothing, refusal names role      behavioural  resolveSeatGrants — src/layout_grants.ts default a missing layout's role to ["**"]
//   undeclared role → nothing, names it          behavioural  same                                    default a missing role to ["**"]
//   literals beside survive                      behavioural  same                                    drop every grant when any role refuses
//   the chair is refused at dispatch, by role    behavioural  runGig — src/runtime.ts                 ignore resolveSeatGrants().refusals when
//                                                                                                     seating a chair (invoke anyway)
import { describe, it, expect } from "vitest";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker } from "../src/index.js";
import { loadLayoutGrants, TS_LAYOUT } from "./layout_grants_fixtures.js";

const seat = (allowed_tools: string[]) =>
  testAgent({ slug: "migrator", primitives: ["CREATE"], input_types: [], output_types: ["note"], domain: "demo", allowed_tools });

describe("RED-DEF-13 — fail closed on a missing role or layout", () => {
  it("NO layout: every role token grants nothing and is refused by its role; the literal beside it survives", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: seat(["Read", "Write(@source)", "Bash(@laws)"]) });
    expect(r.grants, "a role token granted something with no layout to answer it").toEqual(["Read"]);
    expect(r.refusals.map((x) => x.role).sort(), "the refusals do not name the unanswered roles").toEqual(["laws", "source"]);
    expect(r.refusals.find((x) => x.role === "source")?.token).toBe("Write(@source)");
    for (const x of r.refusals) expect(x.reason, "a refusal with no reason").toMatch(/\S/);
  });

  it("a layout that does not declare the role: the token grants nothing — never ** — and the refusal names `migrations`", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: seat(["Read", "Write(@source)", "Write(@migrations)", "Bash(@ship_dry)"]), layout: TS_LAYOUT });
    expect(r.grants.some((g) => g.includes("**") && !g.startsWith("Write(src/")), `a missing role widened to a default: ${JSON.stringify(r.grants)}`).toBe(false);
    expect(r.grants.some((g) => g.includes("@")), "a role token leaked through unexpanded").toBe(false);
    expect([...r.grants].sort(), "the declared role and the literal must survive the missing one").toEqual(["Read", "Write(src/**)"]);
    expect(r.refusals.map((x) => x.role).sort()).toEqual(["migrations", "ship_dry"]);
  });

  it("the chair is refused at dispatch naming the missing role — no seat is invoked", async () => {
    const agent = seat(["Read", "Write(@migrations)"]);
    const standard = {
      slug: "migrate-v1", domain: "demo", agents: [agent],
      phases: [{ name: "p", chairs: [{ role: "m", agent_slug: "migrator", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
    } as unknown as Standard;
    const registry = createRegistry();
    registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
    let invoked = 0;
    const invoke: AgentInvoker = () => {
      invoked += 1;
      return { ...coreInvariantFields("Signal"), value: "migrated" };
    };
    let said = "";
    try {
      const result = await runGig(standard, {}, {
        outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, layout: TS_LAYOUT,
      } as never);
      said = JSON.stringify(result);
    } catch (e) {
      said = String((e as Error)?.message ?? e);
    }
    expect(invoked, "a chair whose role the layout does not declare was seated anyway").toBe(0);
    expect(said, `the refusal does not name the missing role: ${said.slice(0, 300)}`).toMatch(/migrations/);
  });
});
