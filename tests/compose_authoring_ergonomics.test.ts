// #187 + #156 — composeStandard must accept the standards downstream actually authors.
// #187: a chair that omits an optional array field (required_skills/depends_on/input_contract/
//       output_contract) must be treated as [], not crash with a raw "ch.<field> is not iterable".
// #156: an ENTRY chair (first phase, depends_on []) may declare a typed input_contract sourced
//       from gigInput; composeStandard must not reject it, and runGig validates gigInput against
//       it at start-of-run (before any chair fires) with a named error.
import { describe, it, expect } from "vitest";
import { composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger, type PhaseDef, type DomainType, type AgentInvoker } from "../src";
import { testAgent } from "./_support/agents.js";

describe("#187 — optional chair fields default to [] (no 'is not iterable' crash)", () => {
  it("a chair omitting optional array fields composes (treated as [], no TypeError)", () => {
    const sensor = testAgent({ slug: "s1", primitives: ["SENSE"], input_types: [], output_types: ["sig"] });
    const verifier = testAgent({ slug: "v1", primitives: ["VERIFY"], input_types: ["sig"], output_types: ["verdict-x"] });
    expect(() =>
      composeStandard({
        slug: "demo187", domain: "demo", agents: [sensor, verifier],
        phases: [
          // root chair omits required_skills, depends_on, AND input_contract — all default to []
          { name: "p0", chairs: [{ role: "sense", agent_slug: "s1", output_contract: ["sig"] }] } as unknown as PhaseDef,
          // consumer omits required_skills — the field that crashed with "is not iterable"
          { name: "p1", chairs: [{ role: "verdict", agent_slug: "v1", depends_on: ["sense"], input_contract: ["sig"], output_contract: ["verdict-x"] }] } as unknown as PhaseDef,
        ],
      }),
    ).not.toThrow();
  });
});

describe("#156 — entry chairs may declare a typed input_contract sourced from gigInput", () => {
  const onboarder = testAgent({ slug: "onboarder", primitives: ["INTERPRET"], input_types: ["applicant-profile"], output_types: ["onboarding-note"] });
  const std = () =>
    composeStandard({
      slug: "pi-onboard", domain: "demo", agents: [onboarder],
      input_types: ["applicant-profile"],
      phases: [
        // entry chair: depends_on [], but declares it consumes applicant-profile from the gig input
        { name: "onboard", chairs: [{ role: "onboard", agent_slug: "onboarder", depends_on: [], input_contract: ["applicant-profile"], output_contract: ["onboarding-note"], required_skills: [] }] } as PhaseDef,
      ],
    });

  it("composes without a CompositionError (the entry contract is the gig seed)", () => {
    expect(() => std()).not.toThrow();
  });

  it("runGig validates gigInput against the entry contract; missing input throws before any chair fires", async () => {
    const registry = createRegistry();
    const t: DomainType = { slug: "applicant-profile", extends: "Signal", domain: "demo", schema: { properties: { name: { type: "string" } } }, required_fields: [] };
    registry.registerType(t);
    let fired = false;
    const invoke: AgentInvoker = () => { fired = true; return { note: "x", claims: ["x"] }; };
    await expect(
      runGig(std(), {}, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke }),
    ).rejects.toThrow(/applicant-profile|gig input|MissingGigInput/i);
    expect(fired, "no chair should fire on bad gig input").toBe(false);
  });

  it("runGig runs when the gig input satisfies the entry contract", async () => {
    const registry = createRegistry();
    const t: DomainType = { slug: "applicant-profile", extends: "Signal", domain: "demo", schema: { properties: { name: { type: "string" } } }, required_fields: [] };
    registry.registerType(t);
    const ob: DomainType = { slug: "onboarding-note", extends: "Interpretation", domain: "demo", schema: { properties: { note: { type: "string" } } }, required_fields: [] };
    registry.registerType(ob);
    const invoke: AgentInvoker = () => ({ note: "welcome", claims: ["welcome"] });
    const res = await runGig(std(), { "applicant-profile": { name: "Ada" } }, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke });
    expect(res.status).toBe("complete");
  });
});
