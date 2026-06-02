import { describe, it, expect } from "vitest";
import {
  validateCharter,
  loadCharter,
  CharterError,
  type Charter,
} from "../src";

const valid: Charter = {
  subject_name: "Acme Corp",
  subject_type: "company",
  charter: "ship trustworthy software with verifiable outputs",
  north_stars: [
    { goal: "ship v2", priority: "high", timeframe: "Q3 2026", metrics: ["dau", "retention"] },
  ],
  products: [
    { name: "WebApp", type: "saas", url: "https://acme.com", description: "main product" },
  ],
  pain_points: ["onboarding friction"],
  tech_stack: ["typescript", "postgres"],
  existing_tools: ["github", "linear"],
  access_grants: [],
};

describe("§10 Charter — required fields", () => {
  it("accepts a fully-populated valid context", () => {
    expect(validateCharter(valid).valid).toBe(true);
  });

  it("rejects empty subject_name", () => {
    const r = validateCharter({ ...valid, subject_name: "" });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.path === "subject_name")).toBe(true);
  });

  it("rejects empty charter", () => {
    const r = validateCharter({ ...valid, charter: "" });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.path === "charter")).toBe(true);
  });
});

describe("§10 subject_type — must be one of the 5 deployment shapes", () => {
  it.each(["company", "lab", "solo", "oss", "other"])("accepts %s", (t) => {
    const r = validateCharter({ ...valid, subject_type: t });
    expect(r.valid).toBe(true);
  });

  it("rejects an unknown subject_type", () => {
    const r = validateCharter({ ...valid, subject_type: "corporation" });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.path === "subject_type")).toBe(true);
  });
});

describe("§10 solo deployment — naming covers single-person case", () => {
  it("accepts subject_type=solo with subject_name as a person", () => {
    const r = validateCharter({
      ...valid,
      subject_type: "solo",
      subject_name: "Eugene",
    });
    expect(r.valid).toBe(true);
  });
});

describe("§10 north_stars validation", () => {
  it("rejects invalid priority", () => {
    const r = validateCharter({
      ...valid,
      north_stars: [{ goal: "x", priority: "urgent", timeframe: "soon", metrics: [] }],
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.path === "north_stars[0].priority")).toBe(true);
  });

  it("accepts all 4 priority levels", () => {
    for (const p of ["low", "medium", "high", "critical"]) {
      const r = validateCharter({
        ...valid,
        north_stars: [{ goal: "g", priority: p, timeframe: "Q3", metrics: [] }],
      });
      expect(r.valid).toBe(true);
    }
  });

  it("rejects empty north_star goal", () => {
    const r = validateCharter({
      ...valid,
      north_stars: [{ goal: "", priority: "high", timeframe: "Q3", metrics: [] }],
    });
    expect(r.valid).toBe(false);
  });
});

describe("§10 array-of-strings fields", () => {
  it("rejects pain_points with non-string element", () => {
    const r = validateCharter({ ...valid, pain_points: ["valid", 42] });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.path === "pain_points")).toBe(true);
  });
});

describe("§10 products validation", () => {
  it("rejects a product missing required fields", () => {
    const r = validateCharter({ ...valid, products: [{ name: "x" }] });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.path.startsWith("products[0]"))).toBe(true);
  });
});

describe("§10 loadCharter — throw vs return", () => {
  it("returns typed context on success", () => {
    const c = loadCharter(valid);
    expect(c.subject_name).toBe("Acme Corp");
    expect(c.charter).toBeTruthy();
  });

  it("throws CharterError on invalid input", () => {
    expect(() => loadCharter({ subject_name: "" })).toThrow(CharterError);
  });
});
