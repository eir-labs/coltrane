// #263 — a record's asserted `core_type` is never checked against its own
// `domain_type`'s `extends`. That matters because #227/#228 made `core_type`
// LOAD-BEARING: it selects which substance invariant `validateOutput` enforces.
// So a caller asserting the wrong core does not merely mislabel the record — it
// gets the WRONG core's floor applied, and can satisfy `Verdict.checks[]` while
// sealing something the registry says is an Interpretation that owed `claims[]`.
//
// Two shipped e2e specs carried exactly this contradiction for as long as they
// existed (`soft-verdict` declared as Verdict, `summary` as Artifact — both
// extend Interpretation) and every layer accepted it.
//
// The resolution already exists and is simply not consulted: `coreTypeOf`
// returns a registered type's `extends`. This pins that it is.
import { describe, it, expect } from "vitest";
import { createRegistry, createOutputStore, OutputStoreError, type DomainType, type OutputStore } from "../src";

// `soft-verdict` is the real shape from the e2e specs: named like a Verdict,
// DEFINED as an Interpretation.
//
// `additionalProperties: true` is deliberate and load-bearing for this file. A
// closed schema rejects a stray `checks` on its own, which would make these
// tests pass for the wrong reason — the schema catching an undeclared field,
// not the agreement check catching a contradicted core. Opening it strips that
// confound so a rejection can only come from the thing under test.
const softVerdict: DomainType = {
  slug: "soft-verdict",
  extends: "Interpretation",
  domain: "eirtests",
  schema: { properties: { title: { type: "string" } }, additionalProperties: true },
  required_fields: ["title"],
};

const CLAIMS = { claims: ["the fixture asserts one claim"] };
const CHECKS = { checks: [{ method: "fixture-assertion", target_ref: "eirtests", result: "pass" }] };

function store(): OutputStore {
  const reg = createRegistry();
  reg.registerType(softVerdict);
  return createOutputStore(reg);
}

const base = { domain: "eirtests", gig_id: "g1", agent_slug: "judge", primitive: "INTERPRET" as const };

describe("#263 — a record's core_type must agree with its domain_type's extends", () => {
  // THE case. Everything else here is a guard around it.
  //
  // The payload satisfies the asserted core's floor (`checks[]` for Verdict) and
  // the schema accepts it. Without an agreement check this seals CLEAN — a record
  // the registry says is an Interpretation, sealed with a Verdict's evidence and
  // none of the `claims[]` it actually owed. That is the wrong core's invariant
  // being enforced, which is the defect.
  it("rejects even when the WRONG core's substance floor is satisfied", () => {
    const s = store();
    expect(() =>
      s.write({ ...base, core_type: "Verdict", domain_type: "soft-verdict", data: { title: "x", ...CHECKS } }),
    ).toThrow(OutputStoreError);
  });

  // The message has to say WHICH core came from where. An earlier version of this test
  // asserted only that all three names appeared somewhere in the string — set membership,
  // not role — and a mutation that SWAPPED the two interpolations (so the message claimed
  // the record was sealed as Interpretation and the registry says Verdict, the exact
  // opposite of the truth) left it green. An error that confidently states the inverse of
  // what happened is worse than no error. Anchor each name to its role.
  it("the rejection says which core was ASSERTED and which the registry defines", () => {
    const s = store();
    let msg = "";
    try {
      s.write({ ...base, core_type: "Verdict", domain_type: "soft-verdict", data: { title: "x", ...CHECKS } });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/soft-verdict/);
    expect(msg, "the ASSERTED core, attributed to the caller").toMatch(/sealed as core_type "Verdict"/);
    expect(msg, "the REGISTERED core, attributed to the registry").toMatch(/registry defines it as "Interpretation"/);
  });

  // Positive control — the check must not reject a correct record. Without this,
  // "reject everything" passes the tests above.
  it("accepts a record whose core matches its type's extends", () => {
    const s = store();
    const rec = s.write({ ...base, core_type: "Interpretation", domain_type: "soft-verdict", data: { title: "x", ...CLAIMS } });
    expect(rec.core_type).toBe("Interpretation");
    expect(rec.domain_type).toBe("soft-verdict");
  });

  // Freeform outputs (Rob #133) have no registered type to disagree with. The
  // check must stay silent rather than becoming a back-door type requirement.
  it("leaves a freeform output (no domain_type) alone", () => {
    const s = store();
    const rec = s.write({ ...base, core_type: "Interpretation", domain_type: "", data: { note: "freeform", ...CLAIMS } });
    expect(rec.core_type).toBe("Interpretation");
  });

  it("a bare core that MATCHES the asserted core still seals", () => {
    const s = store();
    const rec = s.write({ ...base, core_type: "Interpretation", domain_type: "Interpretation", data: { note: "x", ...CLAIMS } });
    expect(rec.core_type).toBe("Interpretation");
  });

  // The matching case above is indistinguishable from the check being skipped entirely for
  // bare cores — a mutation that excluded them passed the whole suite. This is the case that
  // actually pins the behaviour. `domain_type: "Interpretation"` with `core_type: "Verdict"`
  // is the same contradiction as the headline case with the subtype spelled out longhand,
  // and it gets the same answer.
  it("rejects a bare core that CONTRADICTS the asserted core", () => {
    const s = store();
    expect(() =>
      s.write({ ...base, core_type: "Verdict", domain_type: "Interpretation", data: { note: "x", ...CHECKS } }),
    ).toThrow(OutputStoreError);
  });

  // #263's own thesis is that the core is caller-asserted and never verified. With no
  // domain_type there is nothing to disagree WITH, so the agreement check cannot fire — and
  // an unrecognised core means `validateOutput` applies NO floor at all. That is the defect
  // in its purest form, reachable with no registry entry whatsoever.
  it("rejects a core_type that is not a core type at all", () => {
    const s = store();
    expect(() => s.write({ ...base, core_type: "Nonsense", domain_type: "", data: { note: "x" } })).toThrow(
      OutputStoreError,
    );
    expect(() => s.write({ ...base, core_type: "", domain_type: "", data: { note: "x" } })).toThrow(OutputStoreError);
  });

  // A contradicted core must be diagnosed BY the core check, even when the schema would
  // also have something to say. Every shipped domain type has a closed schema, so the stray
  // substance field trips Ajv's additionalProperties too — and being told to delete `checks`
  // sends the operator to repair the payload when the real fault is the declared core.
  it("diagnoses a contradicted core ahead of the closed-schema complaint about the same field", () => {
    const reg = createRegistry();
    reg.registerType({ ...softVerdict, slug: "closed-verdict", schema: { properties: { title: { type: "string" } } } });
    const s = createOutputStore(reg);
    let msg = "";
    try {
      s.write({ ...base, core_type: "Verdict", domain_type: "closed-verdict", data: { title: "x", ...CHECKS } });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg, "the core check owns this diagnosis, not additionalProperties").toMatch(/registry defines it as/);
    expect(msg).not.toMatch(/additionalProperties/);
  });

  // Not the agreement check's job, and pinned here so a future "resolve, and
  // reject if unresolvable" refactor cannot silently change which layer owns it.
  it("an unregistered domain_type is still the registry's rejection, not this one", () => {
    const s = store();
    let msg = "";
    try {
      s.write({ ...base, core_type: "Interpretation", domain_type: "not-registered", data: { note: "x", ...CLAIMS } });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/unknown domain_type/);
  });
});
