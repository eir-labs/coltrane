// The DEFAULT genome — the institutional pattern, demonstrated end to end inside the repo
// rather than described in prose.
//
// The pattern has three joints and every one of them was previously undemonstrated here:
//
//   institution → organization   what a reader will call "the project"
//   organization → chair         the office: role, function, mission, capability grant
//   chair → agent                the incumbent: a named player swapped into the office
//
// The load-bearing claim is the middle joint. A chair's `caps` carry a DISPATCH grant naming
// the standards its incumbent may run, so authority lives on the office and not on the player.
// A grant naming a standard the genome does not contain is a DEAD NAME — the same defect class
// as an `allowed_tools` entry that resolves to no provider — and it must fail here, at
// authoring time, rather than at a dispatch that confabulates a workflow.
//
// RED-first: written against a repo with no `institutions/` directory, no john/bill/miles
// agents, and neither default standard. Nothing but the genome files may green it — there is
// no engine change in this change, which is the point: the institutional layer is already
// expressible in the one Zod source (src/genome_schema.ts), and this proves it by instance.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { loadGenome } from "../src";
import {
  InstitutionSchema,
  OrganizationSchema,
  AgentRecordSchema,
  OrgMemberSchema,
  InstitutionalChairSchema,
  ChairAssignmentSchema,
  ForebearSchema,
  LineageEdgeSchema,
} from "../src/genome_schema.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const INSTITUTIONS_DIR = join(REPO_ROOT, "institutions");

/** The three named seats this genome ships, and the two standards they are seated in. */
const NAMED_SEATS = ["bill", "john", "miles"] as const;
const DEFAULT_STANDARDS = ["product-design-v1", "software-change-v1"] as const;

/** The institution document's sections, each validated by the class it instantiates. */
interface InstitutionDoc {
  institution: unknown;
  organizations: unknown[];
  agent_records: unknown[];
  org_members: unknown[];
  chairs: unknown[];
  assignments: unknown[];
  forebears: unknown[];
  lineage_edges: unknown[];
}

const docFiles = existsSync(INSTITUTIONS_DIR)
  ? readdirSync(INSTITUTIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
  : [];
const docs: Array<{ file: string; doc: InstitutionDoc }> = docFiles.map((f) => ({
  file: f,
  doc: JSON.parse(readFileSync(join(INSTITUTIONS_DIR, f), "utf8")) as InstitutionDoc,
}));

/**
 * Parse through the class schema and prove nothing was DROPPED on the way through — the same
 * loss-free bar every other genome class is held to. A `.parse` that silently strips an
 * authored field would let a file claim a grant, an obligation, or a citation the engine never
 * sees; asserting field-by-field survival is what makes "it parses" mean "it parsed whole".
 */
function parseLossFree<S extends z.ZodTypeAny>(schema: S, raw: unknown, where: string): z.output<S> {
  const parsed = schema.parse(raw) as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    expect(parsed[k], `${where}: authored field "${k}" did not survive the parse`).toEqual(v);
  }
  return parsed as z.output<S>;
}

describe("institutions/ — the institutional layer, file-shaped and loss-free", () => {
  it("ships at least one institution document", () => {
    expect(
      docFiles,
      "institutions/ is the genome location for institutional instances (the definitional " +
        "classes already live in src/genome_schema.ts). An empty or absent directory means the " +
        "pattern ships as prose only.",
    ).not.toEqual([]);
  });

  for (const { file, doc } of docs) {
    describe(file, () => {
      it("the institution parses loss-free and carries its laws", () => {
        const inst = parseLossFree(InstitutionSchema, doc.institution, `${file}.institution`);
        expect(inst.slug.length).toBeGreaterThan(0);
        expect(inst.laws, "an institution with no laws governs nothing").not.toEqual([]);
      });

      it("every organization parses loss-free and carries a charter", () => {
        expect(doc.organizations, `${file}: no organizations`).not.toEqual([]);
        for (const raw of doc.organizations) {
          const org = parseLossFree(OrganizationSchema, raw, `${file}.organizations`);
          expect(org.charter, `organization ${org.slug} has no charter`).toBeTypeOf("string");
          expect((org.charter ?? "").length).toBeGreaterThan(60);
        }
      });

      it("every agent record, membership edge, chair, and seat parses loss-free", () => {
        for (const raw of doc.agent_records) parseLossFree(AgentRecordSchema, raw, `${file}.agent_records`);
        for (const raw of doc.org_members) parseLossFree(OrgMemberSchema, raw, `${file}.org_members`);
        for (const raw of doc.chairs) parseLossFree(InstitutionalChairSchema, raw, `${file}.chairs`);
        for (const raw of doc.assignments) parseLossFree(ChairAssignmentSchema, raw, `${file}.assignments`);
        expect(doc.chairs.length).toBeGreaterThanOrEqual(1);
        expect(doc.assignments.length).toBeGreaterThanOrEqual(1);
      });

      it("every forebear and lineage edge parses loss-free", () => {
        for (const raw of doc.forebears) parseLossFree(ForebearSchema, raw, `${file}.forebears`);
        for (const raw of doc.lineage_edges) parseLossFree(LineageEdgeSchema, raw, `${file}.lineage_edges`);
      });

      it("every record is anchored in THIS institution — no cross-institution leakage", () => {
        const inst = InstitutionSchema.parse(doc.institution);
        for (const raw of doc.chairs) {
          expect(InstitutionalChairSchema.parse(raw).institution_slug).toBe(inst.slug);
        }
        for (const raw of doc.forebears) {
          expect(ForebearSchema.parse(raw).institution_slug).toBe(inst.slug);
        }
        for (const raw of doc.lineage_edges) {
          expect(LineageEdgeSchema.parse(raw).institution_slug).toBe(inst.slug);
        }
      });

      it("organization → chair → agent resolves at every joint", () => {
        const orgSlugs = new Set(doc.organizations.map((o) => OrganizationSchema.parse(o).slug));
        const chairIds = new Set(doc.chairs.map((c) => InstitutionalChairSchema.parse(c).id));
        const recordSlugs = new Set(doc.agent_records.map((a) => AgentRecordSchema.parse(a).slug));

        for (const raw of doc.chairs) {
          const chair = InstitutionalChairSchema.parse(raw);
          expect(chair.id, `chair "${chair.role}" has no id for a seat to reference`).toBeTypeOf("string");
          expect(chair.mission.length, `chair "${chair.role}" has no mission`).toBeGreaterThan(20);
        }
        for (const raw of doc.assignments) {
          const seat = ChairAssignmentSchema.parse(raw);
          expect(chairIds, `seat references unknown chair_id "${seat.chair_id}"`).toContain(seat.chair_id);
          expect(orgSlugs, `seat references unknown org "${seat.org_slug}"`).toContain(seat.org_slug);
          expect(recordSlugs, `seat references unknown agent "${seat.agent_slug}"`).toContain(seat.agent_slug);
        }
        for (const raw of doc.org_members) {
          const m = OrgMemberSchema.parse(raw);
          expect(orgSlugs).toContain(m.org_slug);
          expect(recordSlugs).toContain(m.agent_slug);
        }
      });
    });
  }
});

describe("the default genome loads, and the three named seats are seatable anywhere", () => {
  const genome = loadGenome(REPO_ROOT);

  it("the genome loads with no errors", () => {
    expect(
      genome.load_errors.map((e) => `${e.kind} ${e.slug ?? e.path}: ${e.error}`),
      "a soft load error means a shipped definition does not compose",
    ).toEqual([]);
  });

  it("john, bill, and miles load as engine agents", () => {
    for (const slug of NAMED_SEATS) {
      expect(genome.agents.has(slug), `agent "${slug}" missing from the genome`).toBe(true);
    }
  });

  it("each named seat is domain-agnostic, so any standard may seat it", () => {
    for (const slug of NAMED_SEATS) {
      expect(genome.agents.get(slug)!.domain, `agent "${slug}" is pinned to a domain`).toBeNull();
    }
  });

  it("each named seat carries a two-role disposition, and no two share the same pair", () => {
    const pairs = NAMED_SEATS.map((slug) => {
      const bp = genome.agents.get(slug)!.behavioral_primitives;
      expect(bp, `agent "${slug}" disposition is not a pair`).toHaveLength(2);
      expect(bp[0], `agent "${slug}" pairs a role with itself — no tension`).not.toBe(bp[1]);
      return [...bp].join("+");
    });
    expect(new Set(pairs).size, `dispositions collide: ${pairs.join(", ")}`).toBe(NAMED_SEATS.length);
  });

  it("each named seat holds least authority — a read-only grant, capped", () => {
    for (const slug of NAMED_SEATS) {
      const a = genome.agents.get(slug)!;
      const tools = a.allowed_tools ?? [];
      for (const t of tools) {
        expect(
          ["Read", "Glob", "Grep"],
          `agent "${slug}" is granted "${t}" — a mutating or executing grant on a default seat ` +
            `widens the blast radius of every standard that seats it`,
        ).toContain(t.split("(")[0]);
      }
      if (tools.length > 0) {
        expect(a.code_tool_access, `agent "${slug}" grant/access mismatch`).toBe("read");
        expect(a.max_tool_calls, `agent "${slug}" has an uncapped grant`).toBeGreaterThan(0);
      }
    }
  });
});

describe("the two default standards compose from the genome", () => {
  const genome = loadGenome(REPO_ROOT);
  const coreSlugs = new Set(genome.core_types.keys());
  const domainSlugs = new Set([...genome.domain_types.values()].map((t) => t.slug));

  for (const slug of DEFAULT_STANDARDS) {
    describe(slug, () => {
      it("composed and is present in the loaded genome", () => {
        expect(genome.standards.has(slug), `standard "${slug}" did not compose`).toBe(true);
      });

      it("seats only the three named seats", () => {
        const std = genome.standards.get(slug)!;
        const seated = new Set(std.phases.flatMap((p) => p.chairs.map((c) => c.agent_slug)).filter(Boolean));
        expect([...seated].sort()).toEqual([...NAMED_SEATS]);
      });

      it("every type named in a chair contract or gig contract resolves in the genome", () => {
        const std = genome.standards.get(slug)!;
        const named = [
          ...(std.input_types ?? []),
          ...(std.output_types ?? []),
          ...std.phases.flatMap((p) => p.chairs.flatMap((c) => [...c.input_contract, ...c.output_contract])),
        ];
        expect(named.length).toBeGreaterThan(0);
        for (const t of named) {
          expect(
            coreSlugs.has(t) || domainSlugs.has(t),
            `standard "${slug}" names type "${t}" which is neither a core nor a registered domain type`,
          ).toBe(true);
        }
      });

      it("crosses at least four seams, and its promised types span at least four cores", () => {
        const std = genome.standards.get(slug)!;
        expect(std.phases.length, "a default standard should demonstrate a real phase graph").toBeGreaterThanOrEqual(4);
        // Each promised type's core comes from its own `extends` (src/runtime.ts) — so the
        // spread of cores across a standard's chairs is the spread of cognitive primitives
        // the run actually seals through.
        const byslug = new Map([...genome.domain_types.values()].map((t) => [t.slug, t.extends]));
        const cores = new Set(
          std.phases
            .flatMap((p) => p.chairs.flatMap((c) => [...c.output_contract]))
            .map((t) => byslug.get(t) ?? t),
        );
        expect(
          cores.size,
          `standard "${slug}" seals only [${[...cores].sort().join(", ")}] — a default standard that ` +
            `crosses one core teaches one move`,
        ).toBeGreaterThanOrEqual(4);
      });
    });
  }
});

describe("the chair contract is the dispatch authority — and it has no dead names", () => {
  const genome = loadGenome(REPO_ROOT);

  /** Every dispatch grant in the genome's institutions, with the chair it sits on. */
  const dispatchGrants = docs.flatMap(({ file, doc }) =>
    doc.chairs.flatMap((raw) => {
      const chair = InstitutionalChairSchema.parse(raw);
      return chair.caps
        .filter((c): c is Extract<typeof c, { grant: "dispatch" }> => "grant" in c && c.grant === "dispatch")
        .map((c) => ({
          file,
          chair,
          standards: [...c.standards],
        }));
    }),
  );

  it("at least one chair carries a dispatch grant", () => {
    expect(
      dispatchGrants,
      'the chair contract is the point of the demonstration: caps must carry {"grant":"dispatch","standards":[…]}',
    ).not.toEqual([]);
  });

  it("a dispatch grant names only standards that exist in the genome", () => {
    for (const { chair, standards } of dispatchGrants) {
      expect(standards, `chair "${chair.role}" grants dispatch over nothing`).not.toEqual([]);
      for (const s of standards) {
        expect(
          genome.standards.has(s),
          `chair "${chair.role}" grants dispatch over standard "${s}", which the genome does not ` +
            `contain — a dead name. Either compose the standard or drop it from the grant.`,
        ).toBe(true);
      }
    }
  });

  it("every seat a default standard fills is authorised by the chair its incumbent holds", () => {
    // The binding, stated as an assertion: for each chair a standard seats an agent in, that
    // agent must hold an institutional seat whose CHAIR grants dispatch over that standard.
    // Authority on the office, not the player — and checkable.
    const grantsByAgent = new Map<string, Set<string>>();
    for (const { doc } of docs) {
      const chairById = new Map(
        doc.chairs.map((raw) => {
          const c = InstitutionalChairSchema.parse(raw);
          return [c.id ?? "", c] as const;
        }),
      );
      for (const raw of doc.assignments) {
        const seat = ChairAssignmentSchema.parse(raw);
        const chair = chairById.get(seat.chair_id);
        if (!chair) continue; // reported by the resolution test above
        const granted = grantsByAgent.get(seat.agent_slug) ?? new Set<string>();
        for (const cap of [...chair.caps, ...seat.contract_caps]) {
          if (!("grant" in cap) || cap.grant !== "dispatch") continue;
          for (const s of cap.standards) granted.add(s);
        }
        grantsByAgent.set(seat.agent_slug, granted);
      }
    }

    for (const slug of DEFAULT_STANDARDS) {
      const std = genome.standards.get(slug);
      expect(std, `standard "${slug}" did not compose`).toBeDefined();
      for (const phase of std!.phases) {
        for (const chair of phase.chairs) {
          if (!chair.agent_slug) continue; // a skill-backed chair has no incumbent
          expect(
            grantsByAgent.get(chair.agent_slug) ?? new Set<string>(),
            `standard "${slug}" seats "${chair.agent_slug}" at role "${chair.role}", but no chair ` +
              `that agent holds grants dispatch over "${slug}"`,
          ).toContain(slug);
        }
      }
    }
  });
});

describe("lineage — every named seat is anchored in a cited forebear", () => {
  const forebears = new Map(
    docs.flatMap(({ doc }) => doc.forebears.map((raw) => {
      const f = ForebearSchema.parse(raw);
      return [f.slug, f] as const;
    })),
  );
  const records = new Map(
    docs.flatMap(({ doc }) => doc.agent_records.map((raw) => {
      const a = AgentRecordSchema.parse(raw);
      return [a.slug, a] as const;
    })),
  );
  const edges = docs.flatMap(({ doc }) => doc.lineage_edges.map((raw) => LineageEdgeSchema.parse(raw)));

  for (const slug of NAMED_SEATS) {
    describe(slug, () => {
      it("has an agent record naming the forebear it descends from", () => {
        const rec = records.get(slug);
        expect(rec, `no agent record for "${slug}"`).toBeDefined();
        expect(rec!.named_from_forebear, `agent record "${slug}" names no forebear`).toBeTypeOf("string");
        expect(forebears.has(rec!.named_from_forebear!), `forebear "${rec!.named_from_forebear}" has no record`).toBe(true);
      });

      it("the forebear record states what the seat takes, with dates", () => {
        const f = forebears.get(records.get(slug)?.named_from_forebear ?? "");
        expect(f, `no forebear record reachable from "${slug}"`).toBeDefined();
        expect(f!.what_taken, `forebear "${f!.slug}" does not say what was taken`).toBeTypeOf("string");
        expect(f!.what_taken!.length).toBeGreaterThan(120);
        expect(f!.what_taken!, `forebear "${f!.slug}" states no dates`).toMatch(/\b(18|19|20)\d{2}\b/);
      });

      it("a typed lineage edge binds the seat to the forebear, carrying its citation", () => {
        const rec = records.get(slug);
        const edge = edges.find((e) => e.from_node === `agent:${slug}`);
        expect(edge, `no lineage edge from "agent:${slug}"`).toBeDefined();
        expect(edge!.edge_type).toBe("descends-from");
        expect(edge!.to_node).toBe(`forebear:${rec?.named_from_forebear}`);
        expect(
          Object.keys(edge!.source ?? {}).length,
          `lineage edge for "${slug}" carries no source — an uncited attribution is a claim, not a record`,
        ).toBeGreaterThan(0);
      });
    });
  }
});
