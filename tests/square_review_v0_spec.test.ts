// RED spec — square-review-v0 (WO-002, Article the First): the public square's review
// law — on merge, a change-set is read turn by turn on the cheap open path and its
// verdict admitted to the lineage in daylight. Phase graph proven by the founder's
// work-order validator against this genome before deliberation. RED until it lands.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const P = join(REPO, "standards", "square-review-v0.json");
const load = () => JSON.parse(readFileSync(P, "utf8"));

describe("square-review-v0 · INV-1 presence", () => {
  it("exists", () => expect(existsSync(P)).toBe(true));
});

describe("square-review-v0 · INV-2 two phases in order", () => {
  it("sense-merge then review-turns", () => {
    expect(load().phases.map((p: any) => p.name)).toEqual(["sense-merge", "review-turns"]);
  });
});

describe("square-review-v0 · INV-3 the seats", () => {
  it("sense-merge: context-reader entry seat, change-request -> change-context", () => {
    const c = load().phases[0].chairs[0];
    expect(c.agent_slug).toBe("context-reader");
    expect(c.depends_on).toEqual([]);
    expect(c.input_contract).toEqual(["change-request"]);
    expect(c.output_contract).toEqual(["change-context"]);
  });
  it("review-turns: spec-reviewer downstream -> change-verdict", () => {
    const c = load().phases[1].chairs[0];
    expect(c.agent_slug).toBe("spec-reviewer");
    expect(c.depends_on).toEqual(["sense-merge"]);
    expect(c.input_contract).toEqual(["change-set", "change-context"]);
    expect(c.output_contract).toEqual(["change-verdict"]);
  });
});

describe("square-review-v0 · INV-4 the open-and-cheap doctrine", () => {
  it("intents carry turn-by-turn, daylight, and the cheap path", () => {
    const d = load();
    const all = d.phases.map((p: any) => p.intent || "").join(" ").toLowerCase();
    expect(all).toContain("turn by turn");
    expect(all).toContain("daylight");
    expect((d.description || "").toLowerCase()).toContain("cheap");
  });
  it("the square is model-agnostic — asserted positively, not by absent words", () => {
    const d = load();
    expect((d.description || "").toLowerCase()).toContain("model-agnostic");
    for (const ph of d.phases)
      for (const c of ph.chairs)
        expect(c.model_tier, "no chair may pin a model tier").toBeUndefined();
    const raw = readFileSync(P, "utf8").toLowerCase();
    for (const tier of ["premium", "privileged", "gold"]) expect(raw).not.toContain(tier);
  });
});

describe("square-review-v0 · INV-5 metadata", () => {
  it("domain, status, types", () => {
    const d = load();
    expect(d.domain).toBe("spec-drafting");
    expect(d.status).toBe("active");
    expect(d.input_types).toEqual(["change-request", "change-set"]);
    expect(d.output_types).toEqual(["change-verdict"]);
  });
});
