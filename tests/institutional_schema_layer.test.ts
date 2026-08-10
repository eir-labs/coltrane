// The institutional definitional layer — institutions, organizations, agents-as-members
// (human and model on the SAME contract), chairs, seats, lineage — defined ONCE in the
// genome's Zod source, like every other genome class.
//
// Why: the same concepts existed in three disagreeing representations (engine genome files,
// hand-shaped instance tables, empty carryover tables) and every surface drifted — an agent
// record could hold 2 skills in one store and 8 in another with nothing to say which was
// true. The fix is the repo's own discipline: one schema in src/genome_schema.ts, from which
// the TS types, the validators, the MCP surface, and the instance-store shapes all derive.
//
// RED-first: written against a genome_schema.ts that has no institutional classes. The
// schema makes it green; nothing else may.
import { describe, it, expect } from "vitest";
import {
  InstitutionSchema,
  OrganizationSchema,
  AgentRecordSchema,
  OrgMemberSchema,
  OrgInstitutionSchema,
  CapGrantSchema,
  InstitutionalChairSchema,
  ChairAssignmentSchema,
  ExchangeContractSchema,
  ForebearSchema,
  NorthstarSchema,
  LineageEdgeSchema,
  OrgServiceKeySchema,
  zodToMcpProps,
} from "../src/genome_schema.js";

describe("institution", () => {
  it("parses a plain institution and applies defaults (laws=[], sovereign=false)", () => {
    const inst = InstitutionSchema.parse({ slug: "atelier", name: "Atelier", kind: "institution" });
    expect(inst.laws).toEqual([]);
    expect(inst.sovereign).toBe(false);
  });

  it("parses a sovereign personal institution carrying laws", () => {
    const inst = InstitutionSchema.parse({
      slug: "founder-personal",
      name: "Founder (personal institution)",
      kind: "personal",
      laws: ["self-governed by the founder's north stars", "exposes to other institutions only by contract"],
      sovereign: true,
      wiki_space: "founder",
    });
    expect(inst.sovereign).toBe(true);
    expect(inst.laws).toHaveLength(2);
  });

  it("rejects an unknown kind", () => {
    expect(() => InstitutionSchema.parse({ slug: "x", name: "X", kind: "committee" })).toThrow();
  });
});

describe("organization", () => {
  it("parses with nullable charter and parent_org", () => {
    const org = OrganizationSchema.parse({ slug: "org-a", name: "Org A", address: "org-a.example" });
    expect(org.charter).toBeNull();
    expect(org.parent_org).toBeNull();
  });
});

describe("agent record — human and model on the SAME contract", () => {
  it("parses a human agent linked to an auth account", () => {
    const a = AgentRecordSchema.parse({
      slug: "founder",
      name: "The Founder",
      kind: "human",
      is_institution: true,
      auth_user_id: "00000000-0000-0000-0000-000000000001",
    });
    expect(a.kind).toBe("human");
    expect(a.status).toBe("proposed"); // default: nothing is active until governed so
    expect(a.named_from_forebear).toBeNull();
    expect(a.skill_slugs).toEqual([]);
  });

  it("parses a model agent (steve) through the identical schema", () => {
    const a = AgentRecordSchema.parse({
      slug: "steve-9",
      name: "Steve-9",
      kind: "steve",
      skill_slugs: ["corpus-gathering"],
    });
    expect(a.kind).toBe("steve");
    expect(a.auth_user_id).toBeNull(); // a model agent simply has no auth account
  });

  it("a named agent carries its forebear edge", () => {
    const a = AgentRecordSchema.parse({
      slug: "steve-9",
      name: "Nomen",
      kind: "steve",
      status: "named",
      named_from_forebear: "forebear-example",
    });
    expect(a.named_from_forebear).toBe("forebear-example");
  });

  it("rejects kinds outside human|steve and statuses outside the lifecycle", () => {
    expect(() => AgentRecordSchema.parse({ slug: "x", name: "X", kind: "daemon" })).toThrow();
    expect(() => AgentRecordSchema.parse({ slug: "x", name: "X", kind: "human", status: "immortal" })).toThrow();
  });
});

describe("membership + participation edges", () => {
  it("org membership is (org, agent)", () => {
    const m = OrgMemberSchema.parse({ org_slug: "org-a", agent_slug: "founder" });
    expect(m).toEqual({ org_slug: "org-a", agent_slug: "founder" });
  });
  it("org↔institution participation is (org, institution)", () => {
    const p = OrgInstitutionSchema.parse({ org_slug: "org-a", institution_slug: "atelier" });
    expect(p.institution_slug).toBe("atelier");
  });
});

describe("cap grants + chairs — the chair is the thing", () => {
  it("a cap grant is a typed lineage-edge scope, with optional expiry", () => {
    const cap = CapGrantSchema.parse({ edge_type: "produced-by", scope: { institution: "atelier" } });
    expect(cap.expires).toBeNull();
    expect(() => CapGrantSchema.parse({ edge_type: "owns-everything", scope: {} })).toThrow();
  });

  it("a chair carries role + function + mission + required_skills + caps + obligations", () => {
    const chair = InstitutionalChairSchema.parse({
      institution_slug: "atelier",
      role: "adjudicator",
      function: "VERIFY",
      mission: "adjudicate the mint",
      required_skills: ["institutional-adjudication"],
      caps: [{ edge_type: "produced-by", scope: { institution: "atelier" } }],
      obligations: ["review-verdict"],
    });
    expect(chair.function).toBe("VERIFY");
    expect(chair.required_skills).toContain("institutional-adjudication");
  });

  it("chair function must be one of the six primitives", () => {
    expect(() =>
      InstitutionalChairSchema.parse({ institution_slug: "atelier", role: "x", function: "DECIDE", mission: "m" }),
    ).toThrow();
  });

  it("a seat (chair assignment) binds an agent into a chair for an org", () => {
    const seat = ChairAssignmentSchema.parse({
      chair_id: "11111111-1111-1111-1111-111111111111",
      agent_slug: "steve-9",
      org_slug: "org-a",
    });
    expect(seat.agent_slug).toBe("steve-9");
  });

  it("cross-institution exposure is an exchange contract carrying caps", () => {
    const x = ExchangeContractSchema.parse({
      from_institution: "founder-personal",
      to_institution: "atelier",
      caps: [{ edge_type: "anchored-in", scope: { institution: "founder-personal" } }],
    });
    expect(x.caps).toHaveLength(1);
  });
});

describe("lineage — forebears, north stars, edges", () => {
  it("a forebear is a sealed lineage anchor", () => {
    const f = ForebearSchema.parse({
      slug: "forebear-example",
      institution_slug: "founder-personal",
      name: "An Ancestor Figure",
      kind: "methodological",
      what_taken: "the discipline of severe tests",
    });
    expect(f.kind).toBe("methodological");
  });

  it("a north star carries its statement", () => {
    const n = NorthstarSchema.parse({
      slug: "n1",
      institution_slug: "founder-personal",
      title: "Rigor is the product",
      statement: "The verification discipline IS what is sold.",
    });
    expect(n.title.length).toBeGreaterThan(0);
  });

  it("a lineage edge is typed and rejects unknown edge types", () => {
    const e = LineageEdgeSchema.parse({
      institution_slug: "atelier",
      edge_type: "descends-from",
      from_node: "agent:steve-9",
      to_node: "forebear:forebear-example",
    });
    expect(e.edge_type).toBe("descends-from");
    expect(() =>
      LineageEdgeSchema.parse({ institution_slug: "a", edge_type: "likes", from_node: "x", to_node: "y" }),
    ).toThrow();
  });
});

describe("org service key — self-describing, and the secret CANNOT live here", () => {
  it("parses the issued key DOCUMENT: key id, org scope, issuer, endpoints — never the secret", () => {
    const k = OrgServiceKeySchema.parse({
      key_id: "key-01",
      org_slug: "org-a",
      issuer: "coltrane-live",
      scopes: ["drain:write", "genome:read"],
      endpoints: { drain: "https://drain.example/rest" },
    });
    expect(k.status).toBe("active");
    expect(k.scopes).toContain("drain:write");
  });

  it("REFUSES any field that smells like key material — the schema is strict by construction", () => {
    for (const field of ["secret", "key", "key_material", "service_role"]) {
      expect(
        () => OrgServiceKeySchema.parse({ key_id: "k", org_slug: "o", issuer: "i", [field]: "sk-oops" }),
        `a key document carrying "${field}" must not parse`,
      ).toThrow();
    }
  });
});

describe("the institutional classes are MCP-surfaceable", () => {
  it("zodToMcpProps derives a properties map for each class", () => {
    for (const s of [
      InstitutionSchema,
      OrganizationSchema,
      AgentRecordSchema,
      InstitutionalChairSchema,
      ChairAssignmentSchema,
      OrgServiceKeySchema,
    ]) {
      const props = zodToMcpProps(s);
      expect(Object.keys(props).length).toBeGreaterThan(1);
    }
    expect(zodToMcpProps(AgentRecordSchema)["kind"]).toBe("string");
    expect(zodToMcpProps(InstitutionalChairSchema)["caps"]).toBe("array");
  });
});
