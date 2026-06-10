// Schema inheritance (docs/genome-extension.md): a domain type extending a core type
// inherits the core's schema PROPERTIES — base fields are available at runtime because
// the core is always loaded. The subtype OVERLOADS (same-named field wins) and EXTENDS
// (adds its own). required stays the subtype's own, so existing instances that carry
// only their own fields still validate (non-breaking).
import { describe, it, expect } from "vitest";
import { createRegistry, type DomainType } from "../src";

// widget-finding extends Interpretation (base props incl. frame, confidence, claims, …)
const widgetFinding: DomainType = {
  slug: "widget-finding",
  extends: "Interpretation",
  domain: "widgetco",
  schema: { properties: { note: { type: "string" } } },
  required_fields: ["note"],
};

describe("schema inheritance: a subtype inherits its base core type's properties", () => {
  it("a subtype instance may carry a BASE field (inherited), not just its own", () => {
    const r = createRegistry();
    r.registerType(widgetFinding);
    // `frame` is an Interpretation base field — allowed on the subtype now
    const res = r.validate({ core_type: "Interpretation", domain_type: "widget-finding", data: { note: "x", frame: "analysis" } });
    expect(res.valid, JSON.stringify(res.errors)).toBe(true);
  });

  it("still validates with ONLY the subtype's own field (base fields available, not forced)", () => {
    const r = createRegistry();
    r.registerType(widgetFinding);
    const res = r.validate({ core_type: "Interpretation", domain_type: "widget-finding", data: { note: "x" } });
    expect(res.valid, JSON.stringify(res.errors)).toBe(true);
  });

  it("rejects a field that is neither inherited nor declared (additionalProperties still holds)", () => {
    const r = createRegistry();
    r.registerType(widgetFinding);
    const res = r.validate({ core_type: "Interpretation", domain_type: "widget-finding", data: { note: "x", not_a_field: 1 } });
    expect(res.valid).toBe(false);
  });

  it("a subtype can OVERLOAD a base field with its own type (subtype wins)", () => {
    const r = createRegistry();
    // Interpretation base declares `confidence`; overload it to a string
    r.registerType({ slug: "odd-finding", extends: "Interpretation", domain: "x", schema: { properties: { confidence: { type: "string" } } }, required_fields: ["confidence"] });
    expect(r.validate({ core_type: "Interpretation", domain_type: "odd-finding", data: { confidence: "high" } }).valid).toBe(true);
    // a number now FAILS — the subtype's string type won over the base's number
    expect(r.validate({ core_type: "Interpretation", domain_type: "odd-finding", data: { confidence: 0.9 } }).valid).toBe(false);
  });
});
