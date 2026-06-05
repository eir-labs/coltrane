// T8 — the backward-compat findings view returns correct, correctly-projected data.
// The view is outputs WHERE domain_type='finding' AND domain='eirtests', with the
// v1 finding columns projected out of the JSONB `data`.
import { describe, it, expect } from "vitest";
import { createRegistry, createOutputStore, type DomainType, type OutputWrite } from "../src";

const findingType: DomainType = {
  slug: "finding",
  extends: "Verdict",
  domain: "eirtests",
  schema: {
    properties: {
      pattern_key: { type: "string" },
      severity: { type: "string" },
      title: { type: "string" },
      evidence: { type: "string" },
      location: { type: "string" },
      recommendation: { type: "string" },
      is_novel: { type: "boolean" },
      dimension: { type: "string" },
      status: { type: "string" },
      kpi_impacts: { type: "object" },
    },
  },
  required_fields: ["pattern_key", "severity", "title"],
};

// A non-finding type in another domain — must NOT leak into the findings view.
const noteType: DomainType = {
  slug: "note",
  extends: "Interpretation",
  domain: "codechange",
  schema: { properties: { body: { type: "string" } } },
  required_fields: ["body"],
};

function setup() {
  const reg = createRegistry();
  reg.registerType(findingType);
  reg.registerType(noteType);
  return createOutputStore(reg);
}

function finding(data: Record<string, unknown>, overrides: Partial<OutputWrite> = {}): OutputWrite {
  return {
    core_type: "Verdict",
    domain_type: "finding",
    domain: "eirtests",
    gig_id: "g1",
    agent_slug: "site-analyst",
    primitive: "VERIFY",
    data,
    ...overrides,
  };
}

describe("T8: backward-compat findings view", () => {
  it("projects finding rows with the v1 columns out of data", () => {
    const store = setup();
    store.write(
      finding({
        pattern_key: "missing-alt-text",
        severity: "high",
        title: "Images lack alt text",
        evidence: "12 <img> with no alt",
        location: "/products",
        recommendation: "add alt attributes",
        is_novel: true,
        dimension: "accessibility",
        status: "open",
        kpi_impacts: { seo: 0.2 },
      }),
    );
    const rows = store.findings();
    expect(rows.length).toBe(1);
    const f = rows[0]!;
    expect(f.pattern_key).toBe("missing-alt-text");
    expect(f.severity).toBe("high");
    expect(f.title).toBe("Images lack alt text");
    expect(f.is_novel).toBe(true);
    expect(f.dimension).toBe("accessibility");
    expect(f.kpi_impacts).toEqual({ seo: 0.2 });
    expect(f.agent_role).toBe("site-analyst"); // agent_slug → agent_role
    expect(f.gig_id).toBe("g1");
    expect(f.created_at).toBeTruthy();
  });

  it("excludes outputs that are not findings in the eirtests domain", () => {
    const store = setup();
    store.write(finding({ pattern_key: "p", severity: "low", title: "t" }));
    store.write({
      core_type: "Interpretation",
      domain_type: "note",
      domain: "codechange",
      gig_id: "g2",
      agent_slug: "code-scout",
      primitive: "INTERPRET",
      data: { body: "a note, not a finding" },
    });
    const rows = store.findings();
    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBe("t");
  });

  it("returns one row per finding output, all from the eirtests domain", () => {
    const store = setup();
    for (let i = 0; i < 5; i++) {
      store.write(finding({ pattern_key: `p${i}`, severity: "med", title: `finding ${i}` }));
    }
    const rows = store.findings();
    expect(rows.length).toBe(5);
    expect(new Set(rows.map((r) => r.pattern_key)).size).toBe(5);
  });
});
