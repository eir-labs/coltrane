// T2 — output validates against domain type schema (valid output passes).
// T3 — bad-schema output is rejected AT WRITE (not silently written through).
import { describe, it, expect } from "vitest";
import { createRegistry, createOutputStore, OutputStoreError, type DomainType, type OutputWrite } from "../src";

// A 'finding' domain type extending the 'verdict' core type, requiring a few fields.
const findingType: DomainType = {
  slug: "finding",
  extends: "Verdict",
  domain: "eirtests",
  schema: {
    properties: {
      pattern_key: { type: "string" },
      severity: { type: "string" },
      title: { type: "string" },
    },
  },
  required_fields: ["pattern_key", "severity", "title"],
};

function populatedRegistry() {
  const reg = createRegistry();
  reg.registerType(findingType);
  return reg;
}

function baseWrite(overrides: Partial<OutputWrite> = {}): OutputWrite {
  return {
    core_type: "Verdict",
    domain_type: "finding",
    domain: "eirtests",
    gig_id: "g1",
    agent_slug: "site-analyst",
    primitive: "VERIFY",
    data: { pattern_key: "missing-alt-text", severity: "high", title: "Images lack alt text" },
    ...overrides,
  };
}

describe("T2: output validates against domain type schema", () => {
  it("accepts an output whose data satisfies the domain schema", () => {
    const store = createOutputStore(populatedRegistry());
    const rec = store.write(baseWrite());
    expect(rec.id).toBeTruthy();
    expect(rec.domain_type).toBe("finding");
    expect(store.get(rec.id)).toBeDefined();
  });

  it("carries the core type, primitive, and provenance refs onto the stored row", () => {
    const store = createOutputStore(populatedRegistry());
    const rec = store.write(baseWrite({ input_refs: ["upstream-1"] }));
    expect(rec.core_type).toBe("Verdict");
    expect(rec.primitive).toBe("VERIFY");
    expect(rec.input_refs).toEqual(["upstream-1"]);
    expect(rec.domain_type_version).toBe(1);
  });
});

// #200 — a type may opt into open extension. When its schema declares
// additionalProperties:true, the seal must accept agent-added contextual fields
// (e.g. opportunity_id) instead of aborting the terminal chair. The default
// stays closed: an undeclared additionalProperties still rejects extras.
const openType: DomainType = {
  slug: "submission-verdict",
  extends: "Verdict",
  domain: "eirtests",
  schema: {
    additionalProperties: true,
    properties: {
      title: { type: "string" },
    },
  },
  required_fields: ["title"],
};

describe("#200: type-declared additionalProperties is honored at seal", () => {
  it("accepts an agent-added field when the type declares additionalProperties:true", () => {
    const reg = createRegistry();
    reg.registerType(openType);
    const store = createOutputStore(reg);
    const rec = store.write({
      core_type: "Verdict",
      domain_type: "submission-verdict",
      domain: "eirtests",
      gig_id: "g1",
      agent_slug: "submission-judge",
      primitive: "VERIFY",
      data: { title: "go", opportunity_id: "opp-42" }, // extra contextual id
    });
    expect(rec.id).toBeTruthy();
    expect((rec.data as Record<string, unknown>).opportunity_id).toBe("opp-42");
  });

  it("still rejects an extra field when additionalProperties is not declared (default closed)", () => {
    const store = createOutputStore(populatedRegistry());
    const bad = baseWrite({
      data: { pattern_key: "x", severity: "high", title: "t", opportunity_id: "opp-42" },
    });
    expect(() => store.write(bad)).toThrow(OutputStoreError);
    expect(store.all().length).toBe(0);
  });
});

describe("T3: bad-schema output is rejected at write", () => {
  it("throws when a required domain field is missing — not silently written", () => {
    const store = createOutputStore(populatedRegistry());
    const bad = baseWrite({ data: { pattern_key: "x", severity: "high" } }); // missing 'title'
    expect(() => store.write(bad)).toThrow(OutputStoreError);
    expect(store.all().length).toBe(0); // nothing persisted
  });

  it("throws when the domain_type is unknown to the registry", () => {
    const store = createOutputStore(createRegistry()); // empty registry
    expect(() => store.write(baseWrite())).toThrow(OutputStoreError);
    expect(store.all().length).toBe(0);
  });
});
