// RED spec — residency-spec-v0: the GENERAL formalization-spec pipeline (WO-E03 §2).
// Genome entries only for reusable graphs; the subject arrives entirely in the dispatch
// input — telesis today, any handmade->governed formalization after. RED until it lands.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const P = join(REPO, "standards", "residency-spec-v0.json");
const load = () => JSON.parse(readFileSync(P, "utf8"));

describe("residency-spec-v0 · INV-1 presence", () => {
  it("exists", () => expect(existsSync(P)).toBe(true));
});

describe("residency-spec-v0 · INV-2 four phases in order", () => {
  it("survey, charter, contract, approve", () => {
    expect(load().phases.map((p: any) => p.name)).toEqual(["survey", "charter", "contract", "approve"]);
  });
});

describe("residency-spec-v0 · INV-3 the seats and contracts", () => {
  it("survey: domain-explorer -> repo-survey, entry seat", () => {
    const c = load().phases[0].chairs[0];
    expect(c.agent_slug).toBe("domain-explorer");
    expect(c.depends_on).toEqual([]);
    expect(c.output_contract).toEqual(["repo-survey"]);
  });
  it("charter: problem-definer, downstream of survey -> project-charter", () => {
    const c = load().phases[1].chairs[0];
    expect(c.agent_slug).toBe("problem-definer");
    expect(c.depends_on).toEqual(["survey"]);
    expect(c.input_contract).toContain("repo-survey");
    expect(c.output_contract).toEqual(["project-charter"]);
  });
  it("contract: solution-developer -> subsystem-contract", () => {
    const c = load().phases[2].chairs[0];
    expect(c.agent_slug).toBe("solution-developer");
    expect(c.depends_on).toEqual(["charter"]);
    expect(c.output_contract).toEqual(["subsystem-contract"]);
  });
});

describe("residency-spec-v0 · INV-4 the approve seat is human-only and sole verdict", () => {
  it("human, empty agent_slug, parks doctrine in intent, sole verdict producer", () => {
    const d = load();
    const a = d.phases[3].chairs[0];
    expect(a.human).toBe(true);
    expect(a.agent_slug).toBe("");
    expect(a.depends_on).toEqual(["contract"]);
    expect(a.input_contract).toEqual(["subsystem-contract"]);
    for (const ph of d.phases.slice(0, 3))
      for (const c of ph.chairs)
        expect(c.output_contract).not.toContain(a.output_contract[0]);
    expect((d.phases[3].intent || "").toUpperCase()).toContain("PARK");
  });
});

describe("residency-spec-v0 · INV-5 generality — the subject lives in the input", () => {
  it("no subject named in the standard; typed input only", () => {
    const raw = readFileSync(P, "utf8").toLowerCase();
    for (const subject of ["telesis", "vercel", "fly.io", "eugene"])
      expect(raw).not.toContain(subject);
    const d = load();
    expect(d.domain).toBe("seeding");
    expect(d.status).toBe("active");
  });
});
