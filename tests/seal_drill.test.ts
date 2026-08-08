// The seal drill (WU-0008) — catch unsealable contracts at simulate prices.
//
// THE GAP. standard_simulate estimated cost from phase SHAPE only, so a standard
// whose contract types could not be satisfied by ANY payload simulated clean and
// died at a terminal chair — execution prices for a defect knowable in milliseconds.
// The live instance: three consecutive failed gigs on 2026-08-08, ~$5.20, all from
// contract defects a pre-dispatch drill would have caught for $0.
//
// THE RULE THIS FILE FREEZES: for every chair output-contract type, the drill builds
// a minimal stub from the type's EFFECTIVE schema and pushes it through the REAL seal
// path — registry.validate (domain schema) + validateOutput (core substance floor).
// If no stub the schema itself describes can seal, the drill reports the chair, the
// type, and the errors — before any inference is spent.
import { describe, it, expect } from "vitest";
import { createRegistry, type DomainType } from "../src/registry.js";
import { sealDrill, stubForSchema } from "../src/seal_drill.js";

const healthy: DomainType = {
  slug: "drill-note",
  extends: "Signal",
  domain: "demo",
  schema: { properties: { text: { type: "string" } } },
  required_fields: ["text", "source"],
};

// Registerable (every required field is declared) yet UNSEALABLE: `mode` is pinned to
// an empty enum, so no payload exists that satisfies the schema. Exactly the class
// authoring-time checks pass over and a terminal chair discovers.
const unsealable: DomainType = {
  slug: "dead-sig",
  extends: "Signal",
  domain: "demo",
  schema: { properties: { text: { type: "string" }, mode: { enum: [] } } },
  required_fields: ["text", "mode", "source"],
};

const standardOver = (types: string[]) => ({
  slug: "drill-std",
  phases: [
    {
      name: "sense",
      chairs: types.map((t, i) => ({ role: `chair-${i}`, output_contract: [t] })),
    },
  ],
});

describe("stubForSchema — minimal payload from an effective schema", () => {
  it("fills required fields with type-conformant values, including core floors", () => {
    const reg = createRegistry([healthy]);
    const stub = stubForSchema(reg.effectiveSchema("drill-note")!) as Record<string, unknown>;
    expect(typeof stub["text"]).toBe("string");
    expect((stub["text"] as string).length).toBeGreaterThan(0);
    expect(typeof stub["source"]).toBe("string");
  });

  it("honors enums and non-empty floors for arrays", () => {
    const stub = stubForSchema({
      type: "object",
      properties: {
        kind: { enum: ["a", "b"] },
        items: { type: "array", items: { type: "string" } },
      },
      required: ["kind", "items"],
    }) as Record<string, unknown>;
    expect(stub["kind"]).toBe("a");
    expect(Array.isArray(stub["items"])).toBe(true);
    expect((stub["items"] as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("sealDrill — the pre-dispatch gate that can actually fail", () => {
  it("drills a healthy standard clean", () => {
    const reg = createRegistry([healthy]);
    const res = sealDrill(standardOver(["drill-note"]), reg);
    expect(res.ok).toBe(true);
    expect(res.failures).toEqual([]);
    expect(res.checked).toContain("drill-note");
  });

  it("reports the chair and type when no payload can seal", () => {
    const reg = createRegistry([healthy, unsealable]);
    const res = sealDrill(standardOver(["drill-note", "dead-sig"]), reg);
    expect(res.ok).toBe(false);
    expect(res.failures).toHaveLength(1);
    const f = res.failures[0]!;
    expect(f.domain_type).toBe("dead-sig");
    expect(f.role).toBe("chair-1");
    expect(f.errors.join(" ")).toMatch(/mode/);
  });

  it("runs the REAL core substance floor, not just the domain schema", () => {
    // A bare core type in a contract has no domain schema; the floor still applies —
    // the drill must produce a floor-satisfying stub for it and pass.
    const reg = createRegistry([]);
    const res = sealDrill(standardOver(["Interpretation"]), reg);
    expect(res.ok).toBe(true);
  });

  it("flags unknown domain types instead of skipping them silently", () => {
    const reg = createRegistry([]);
    const res = sealDrill(standardOver(["no-such-type"]), reg);
    expect(res.ok).toBe(false);
    expect(res.failures[0]!.errors.join(" ")).toMatch(/unknown/i);
  });
});
