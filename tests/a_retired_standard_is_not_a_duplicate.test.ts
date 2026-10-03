// A retired standard is not a duplicate — the store loader's version rule for standards.
//
// MEASURED (3 Oct 2026): an org re-seated one chair of a standard through the governed upsert as
// version 2. The upsert did what its own comment promises — "a new active version retires the one it
// replaces" — and marked version 1 `retired`. The loader then reported the SLUG as a duplicate: the
// standards branch drops DRAFTS and nothing else, so a retired row and the active row that replaced
// it were two live claimants, the second threw `duplicate standard slug`, the org's genome carried a
// load error, and the drain refused every gig in the org at claim time. The skills branch already has
// the right rule ("RETIRED is ignored; deprecated and active both stand; the highest version per slug
// wins; two rows at one version refuse") and the venues branch keeps only active rows. The standards
// branch gets the skills rule.
import { describe, it, expect } from "vitest";
import { reconstructGenome } from "../src/genome_store.js";

const AGENT_ROWS = [
  {
    slug: "scout", version: 1, status: "active",
    primitives: ["SENSE"], input_types: [], output_types: ["scan-report"], domain: "demo",
    identity: "you are scout", method: "1. look 2. report 3. stop", constraints: [], depth_profile: "standard",
    permissions: { allowed_tools: ["Read"], model_tier: "economy", max_tool_calls: 5 },
    behavioral_primitives: ["explorer", "critic"], skill_slots: [], default_skills: [],
  },
  {
    slug: "sentry", version: 1, status: "active",
    primitives: ["SENSE"], input_types: [], output_types: ["scan-report"], domain: "demo",
    identity: "you are sentry", method: "1. watch 2. report 3. stop", constraints: [], depth_profile: "standard",
    permissions: { allowed_tools: ["Read"], model_tier: "economy", max_tool_calls: 5 },
    behavioral_primitives: ["explorer", "critic"], skill_slots: [], default_skills: [],
  },
];
const TYPE_ROWS = [{
  slug: "scan-report", version: 1, extends: "Signal", domain: "demo", status: "active",
  schema: { type: "object", properties: { summary: { type: "string" } } }, required_fields: ["summary"],
}];
const standardRow = (version: number, status: string, agent: string) => ({
  slug: "scan-v1", version, status, domain: "demo",
  phases: [{ name: "scan", chairs: [{ role: "scout-seat", agent_slug: agent, depends_on: [], input_contract: [], output_contract: ["scan-report"], required_skills: [] }] }],
  output_types: ["scan-report"],
});
const load = (standards: unknown[]) =>
  reconstructGenome({ core_types: [], domain_types: TYPE_ROWS, agents: AGENT_ROWS, standards, skills: [] } as never, { base: null });
const seatOf = (g: ReturnType<typeof load>) => g.standards.get("scan-v1")?.phases[0]?.chairs[0]?.agent_slug;

describe("the store loader's version rule for standards — retired rows are not rooms, the highest live version wins", () => {
  it("L1 · the measured case: v1 retired + v2 active under one slug is a version history, not a duplicate", () => {
    const g = load([standardRow(1, "retired", "scout"), standardRow(2, "active", "sentry")]);
    expect(g.load_errors, "no duplicate reported").toEqual([]);
    expect(seatOf(g), "the active v2 is what loads").toBe("sentry");
  });

  it("L2 · row order does not decide: the retired row arriving second is equally ignored", () => {
    const g = load([standardRow(2, "active", "sentry"), standardRow(1, "retired", "scout")]);
    expect(g.load_errors).toEqual([]);
    expect(seatOf(g)).toBe("sentry");
  });

  it("L3 · a retired row alone loads nothing and reports nothing — retired is not a problem, it is not a room", () => {
    const g = load([standardRow(1, "retired", "scout")]);
    expect(g.load_errors).toEqual([]);
    expect(g.standards.has("scan-v1")).toBe(false);
  });

  it("L4 · two ACTIVE rows at different versions: the highest wins (what a version IS), no error", () => {
    const g = load([standardRow(1, "active", "scout"), standardRow(2, "active", "sentry")]);
    expect(g.load_errors).toEqual([]);
    expect(seatOf(g)).toBe("sentry");
  });

  it("L5 · two live rows at the SAME version is contradictory data: refused, naming both, and neither loads", () => {
    const g = load([standardRow(2, "active", "scout"), standardRow(2, "active", "sentry")]);
    expect(g.load_errors.length).toBe(1);
    expect(g.load_errors[0]?.error).toMatch(/ambiguous standard "scan-v1": 2 rows share one version/);
    expect(g.standards.has("scan-v1")).toBe(false);
  });

  it("L6 · deprecated still stands (do not reach for it, but it exists) — the skills rule, one class over", () => {
    const g = load([standardRow(1, "deprecated", "scout")]);
    expect(g.load_errors).toEqual([]);
    expect(g.standards.get("scan-v1")?.status).toBe("deprecated");
  });

  it("L7 · a draft is still kept apart: v1 active + v2 draft loads v1 and offers v2 for promotion", () => {
    const g = load([standardRow(1, "active", "scout"), standardRow(2, "draft", "sentry")]);
    expect(g.load_errors).toEqual([]);
    expect(seatOf(g)).toBe("scout");
    expect(g.draft_standards.has("scan-v1")).toBe(true);
  });
});
