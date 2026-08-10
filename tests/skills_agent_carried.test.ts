// Skills travel with the player — method and technique belong to the AGENT; law and data belong
// to the INSTITUTION and arrive through hydration. (Governor ruling, 2026-08-10.)
//
// Until now a skill could only be a shared repertoire entry an agent REFERENCED by slug
// (`Agent.skill_slugs` → `skills/<slug>/`). That models the off-the-shelf method well and the
// grown one not at all: an agent sits closest to its own work, so it is the agent that develops
// technique, and that technique has to be portable — the same player seated in a second
// institution must bring it along rather than wait for the second institution's repertoire to
// contain it. So an agent may CARRY full skill definitions on its own record.
//
// What the agent must NOT carry is the institution's data. A carried skill declares HYDRATION
// SLOTS — named holes with a declared type — and each slot is filled from outside the agent, at a
// declared BINDING TIME:
//
//   binding "institution" — filled at SEAT time from the chair's `supplies`. A required slot no
//                           chair fills is a DEAD SLOT: the same defect class as a granted tool
//                           that resolves to no provider, so it is refused where the genome is
//                           authored (compose time), not discovered mid-run.
//   binding "gig"         — filled at DISPATCH time from the gig payload. These are the chair
//                           contract's formal parameters and the dispatch input is the argument
//                           list, so compose time is the wrong place to demand them: nothing is
//                           known about a run's arguments before the run.
//
// A chair's expectations become two-tier: `required_skills` stays the strict floor (it refuses a
// seating), while `preferred_skills` is soft — a chair states the technique it would rather have,
// and an institution with a differently-skilled roster still seats somebody. A preference that
// refused a seating would just be a second floor under another name.
//
// Finally, seating becomes a RECORDED act: a chair assignment may cite the `technique_evidence`
// the seating decision weighed, so "why this player in this chair" is a record, not a recollection.
//
// RED-first: written against an engine where AgentSchema has no `skills`, SkillSchema no
// `hydration`, ChairSchema no `preferred_skills`/`supplies`, and ChairAssignmentSchema no
// `technique_evidence`. The new fields are read through the accessors below so that a missing
// field fails an ASSERTION rather than the build — the RED has to be about behaviour.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPrompt,
  composeStandard,
  createOutputStore,
  createRegistry,
  loadGenome,
  runGig,
  MemoryLedger,
  type Agent,
  type AgentInvocationContext,
  type AgentInvoker,
  type DomainType,
  type PhaseDef,
  type SkillRecord,
} from "../src";
import {
  AgentSchema,
  ChairAssignmentSchema,
  ChairSchema,
  InstitutionalChairSchema,
  SkillSchema,
} from "../src/genome_schema.js";
import { MCP_TOOLS } from "../src/mcp.js";
import { testAgent } from "./_support/agents.js";
import { makeGenomeDir, rmGenome, seedCoreTypes, writeAgent, writeSkillPackage } from "./_support/genome.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── the shapes this change adds, and the accessors that read them ─────────────
interface Slot { type?: string; description?: string; required?: boolean; binding?: "institution" | "gig" }
interface Carried { slug: string; md?: string; hydration?: Record<string, Slot> }
/** The skills an agent record CARRIES (as opposed to the slugs it references). */
const carriedOn = (a: unknown): readonly Carried[] =>
  ((a as { skills?: readonly Carried[] } | undefined)?.skills ?? []);
const hydrationOf = (s: unknown): Record<string, Slot> =>
  ((s as { hydration?: Record<string, Slot> } | undefined)?.hydration ?? {});
const field = <T>(o: unknown, key: string): T | undefined => (o as Record<string, T> | undefined)?.[key];
/** testAgent with the carried-skill field, which Partial<AgentDef> does not know yet. */
const agentCarrying = (o: Record<string, unknown>) => testAgent(o as Parameters<typeof testAgent>[0]);

// ── shared scaffolding (the shape the rest of the suite uses) ─────────────────
const T = (slug: string, extendsCore: string): DomainType => ({
  slug, extends: extendsCore, domain: "demo",
  schema: { properties: { v: { type: "string" } } }, required_fields: [],
});
function harness(types: DomainType[]) {
  return { outputs: createOutputStore(createRegistry(types)), ledger: new MemoryLedger() };
}
const CLAIMS = { claims: ["fixture: the note carries one claim"] };
const repertoire = (...recs: Array<{ slug: string; md: string }>): ReadonlyMap<string, SkillRecord> =>
  new Map(recs.map((r) => [r.slug, { slug: r.slug, version: 1, md: r.md } as unknown as SkillRecord]));

const SLOT_INSTITUTION = "house-style";
const SLOT_GIG = "target-paths";
/** The carried technique. `required` and `binding` vary per test; the slot name does not. */
const carriedSkill = (o?: { required?: boolean; binding?: "institution" | "gig"; slug?: string; md?: string }) => ({
  slug: o?.slug ?? "structure-conformance",
  version: 1,
  skill_type: "analysis",
  description: "settle the structure against the house's own written constraints",
  md: o?.md ?? "CARRIED_TECHNIQUE",
  hydration: {
    [SLOT_INSTITUTION]: {
      type: "string",
      description: "the institution's own formatting and naming constraints",
      ...(o?.required === false ? {} : { required: true }),
      ...(o?.binding ? { binding: o.binding } : {}),
    },
  },
});
/** A carried skill with no floor to fill — the shape the resolution tests use. */
const CARRIED_SOFT = carriedSkill({ required: false });

const noteChair = (o?: Record<string, unknown>) => ({
  role: "structure", agent_slug: "carrier", depends_on: [], input_contract: [],
  output_contract: ["note"], required_skills: [], ...o,
});
const oneChairStandard = (agents: Agent[], chair: Record<string, unknown>) =>
  composeStandard({
    slug: "carried", domain: "demo", agents,
    phases: [{ name: "p0", chairs: [chair] } as unknown as PhaseDef],
  });

// ─────────────────────────────────────────────────────────────────────────────
// 1 — the shapes, in the one Zod source
// ─────────────────────────────────────────────────────────────────────────────
describe("the schema — an agent carries skills; a skill declares hydration slots", () => {
  const AGENT_BASE = {
    slug: "carrier", primitives: ["INTERPRET"], identity: "i", method: "m", constraints: [],
    behavioral_primitives: ["analyst", "synthesizer"],
  };

  it("AgentSchema parses an agent carrying a whole skill definition, loss-free", () => {
    const skill = carriedSkill();
    const parsed = AgentSchema.parse({ ...AGENT_BASE, skills: [skill] });
    expect(carriedOn(parsed), "a carried skill must survive the parse whole — md, hydration and all").toEqual([skill]);
  });

  it("the carried set and the referenced set are DIFFERENT fields — slugs reference the repertoire", () => {
    const parsed = AgentSchema.parse({ ...AGENT_BASE, skill_slugs: ["summarize-tight"], skills: [carriedSkill()] });
    expect(parsed.skill_slugs).toEqual(["summarize-tight"]);
    expect(carriedOn(parsed).map((s) => s.slug)).toEqual(["structure-conformance"]);
  });

  it("a hydration slot declares a type, and optionally a description, a floor, and a binding time", () => {
    const sk = SkillSchema.parse({
      slug: "s",
      hydration: {
        [SLOT_INSTITUTION]: { type: "string", description: "the house's constraints", required: true, binding: "institution" },
        [SLOT_GIG]: { type: "array", required: true, binding: "gig" },
      },
    });
    const h = hydrationOf(sk);
    expect(h[SLOT_INSTITUTION]?.type).toBe("string");
    expect(h[SLOT_INSTITUTION]?.required).toBe(true);
    expect(h[SLOT_INSTITUTION]?.description).toBe("the house's constraints");
    expect(h[SLOT_GIG]?.binding).toBe("gig");
  });

  it("a slot with no declared type, or a binding time outside {institution, gig}, is refused", () => {
    expect(() => SkillSchema.parse({ slug: "s", hydration: { x: { required: true } } })).toThrow();
    expect(() => SkillSchema.parse({ slug: "s", hydration: { x: { type: "string", binding: "vendor" } } })).toThrow();
  });

  it("a standard's chair states a soft preference and may supply the institution's data", () => {
    const ch = ChairSchema.parse({
      role: "structure", agent_slug: "carrier",
      preferred_skills: ["structure-conformance"], supplies: { [SLOT_INSTITUTION]: "two-space indent" },
    });
    expect(field<string[]>(ch, "preferred_skills")).toEqual(["structure-conformance"]);
    expect(field<Record<string, unknown>>(ch, "supplies")?.[SLOT_INSTITUTION]).toBe("two-space indent");
    expect(field<string[]>(ChairSchema.parse({ role: "r" }), "preferred_skills"),
      "no preference stated is an empty preference, not an absent field").toEqual([]);
  });

  it("an institutional chair carries the same two fields — the seat is where the institution's data lands", () => {
    const chair = InstitutionalChairSchema.parse({
      institution_slug: "atelier", role: "structure-builder", function: "CREATE", mission: "settle the structure",
      preferred_skills: ["structure-conformance"], supplies: { [SLOT_INSTITUTION]: "the house style, stated" },
    });
    expect(field<string[]>(chair, "preferred_skills")).toEqual(["structure-conformance"]);
    expect(field<Record<string, unknown>>(chair, "supplies")?.[SLOT_INSTITUTION]).toBe("the house style, stated");
    const bare = InstitutionalChairSchema.parse({ institution_slug: "a", role: "r", function: "JUDGE", mission: "m" });
    expect(field<string[]>(bare, "preferred_skills")).toEqual([]);
  });

  it("a seating cites the technique evidence it weighed — source and claim, both required", () => {
    const seat = ChairAssignmentSchema.parse({
      chair_id: "c1", agent_slug: "bill", org_slug: "o1",
      technique_evidence: [{ source: "tests/skills_agent_carried.test.ts", claim: "the carried technique parses and its slot is supplied" }],
    });
    expect(field<unknown[]>(seat, "technique_evidence")).toHaveLength(1);
    expect(() => ChairAssignmentSchema.parse({
      chair_id: "c1", agent_slug: "bill", org_slug: "o1", technique_evidence: [{ source: "somewhere" }],
    }), "a cited source with no claim records nothing").toThrow();
  });

  it("the MCP write-surface carries both new fields, generated (never hand-written)", () => {
    const props = (slug: string) =>
      (MCP_TOOLS.find((t) => t.slug === slug)?.input_schema as { properties?: Record<string, { type?: string }> })?.properties ?? {};
    expect(props("agent_define")["skills"]?.type, "agent_define must be able to author a carried skill").toBe("array");
    expect(props("skill_define")["hydration"]?.type, "skill_define must be able to declare a hydration slot").toBe("object");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 — resolution: a carried skill behaves exactly like a bound repertoire skill,
//     and wins the slug when both exist
// ─────────────────────────────────────────────────────────────────────────────
describe("resolution — a carried skill reaches the prompt, and shadows the repertoire on collision", () => {
  const run = async (agent: Agent, deps?: Record<string, unknown>, chair?: Record<string, unknown>) => {
    const { outputs, ledger } = harness([T("note", "Interpretation")]);
    const seen: AgentInvocationContext[] = [];
    const invoke: AgentInvoker = (ctx) => { seen.push(ctx); return { v: "x", ...CLAIMS }; };
    const res = await runGig(oneChairStandard([agent], noteChair(chair)), {}, { outputs, ledger, invoke, ...deps });
    return { res, ctx: seen[0]! };
  };

  it("a carried skill resolves with NO repertoire map at all — it travels with the player", async () => {
    const agent = agentCarrying({ slug: "carrier", primitives: ["INTERPRET"], input_types: [], output_types: ["note"], skills: [CARRIED_SOFT] });
    const { res, ctx } = await run(agent);
    expect(res.status).toBe("complete");
    expect(ctx.skills?.map((s) => s.slug), "the agent's own skill needs no genome lookup").toEqual(["structure-conformance"]);
    expect(buildPrompt(ctx)).toContain("CARRIED_TECHNIQUE");
  });

  it("a carried skill SHADOWS a same-slug repertoire skill", async () => {
    const shared = "shared-technique";
    const agent = agentCarrying({
      slug: "carrier", primitives: ["INTERPRET"], input_types: [], output_types: ["note"],
      skill_slugs: [shared], skills: [carriedSkill({ required: false, slug: shared, md: "CARRIED_TECHNIQUE" })],
    });
    const { ctx } = await run(agent, { skills: repertoire({ slug: shared, md: "REPERTOIRE_TECHNIQUE" }) });
    expect(ctx.skills?.filter((s) => s.slug === shared), "one slug resolves to one skill, not two").toHaveLength(1);
    const prompt = buildPrompt(ctx);
    expect(prompt, "the player's own technique is the one that plays").toContain("CARRIED_TECHNIQUE");
    expect(prompt).not.toContain("REPERTOIRE_TECHNIQUE");
    expect(ctx.missing_skills, "the slug resolved — to the carried definition").toEqual([]);
  });

  it("carried skills come first, then the repertoire bindings, in declaration order", async () => {
    const agent = agentCarrying({
      slug: "carrier", primitives: ["INTERPRET"], input_types: [], output_types: ["note"],
      skill_slugs: ["from-repertoire"], skills: [CARRIED_SOFT],
    });
    const { ctx } = await run(agent, { skills: repertoire({ slug: "from-repertoire", md: "REPERTOIRE_TECHNIQUE" }) });
    expect(ctx.skills?.map((s) => s.slug)).toEqual(["structure-conformance", "from-repertoire"]);
  });

  it("a carried skill satisfies a chair's required_skills — at compose AND at run", async () => {
    const agent = agentCarrying({ slug: "carrier", primitives: ["INTERPRET"], input_types: [], output_types: ["note"], skills: [CARRIED_SOFT] });
    expect(() => oneChairStandard([agent], noteChair({ required_skills: ["structure-conformance"] }))).not.toThrow();
    const { res } = await run(agent, { skills: repertoire() }, { required_skills: ["structure-conformance"] });
    expect(res.status, "a required skill the agent CARRIES is not a dead name").toBe("complete");
  });

  it("LOAD TIME: a slug covered by a carried definition is not a dangling binding; an uncovered one still is", () => {
    const root = makeGenomeDir();
    try {
      seedCoreTypes(root);
      writeSkillPackage(root, { slug: "on-disk", md: "repertoire" });
      writeAgent(root, {
        slug: "carrier", primitives: ["INTERPRET"], input_types: [], output_types: ["Interpretation"],
        skill_slugs: ["structure-conformance", "on-disk"], skills: [CARRIED_SOFT],
      } as Parameters<typeof writeAgent>[1]);
      writeAgent(root, {
        slug: "dangler", primitives: ["INTERPRET"], input_types: [], output_types: ["Interpretation"],
        skill_slugs: ["nowhere-at-all"],
      });
      const g = loadGenome(root);
      const errs = g.load_errors.filter((e) => e.kind === "agent");
      expect(errs.map((e) => e.slug), "the carried definition IS the package for that slug").toEqual(["dangler"]);
      expect(errs[0]!.error).toMatch(/nowhere-at-all/);
    } finally {
      rmGenome(root);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — the hydration seam: an unfilled INSTITUTION slot is a dead slot; a GIG slot
//     is a formal parameter and is not compose time's business
// ─────────────────────────────────────────────────────────────────────────────
describe("hydration — a required institution slot no chair fills is refused at compose", () => {
  const agentWith = (skill: unknown) =>
    agentCarrying({ slug: "carrier", primitives: ["INTERPRET"], input_types: [], output_types: ["note"], skills: [skill] });

  it("names the slot, the skill and the chair — an unfilled required slot is a dead slot", () => {
    let msg: string | undefined;
    try {
      oneChairStandard([agentWith(carriedSkill({ binding: "institution" }))], noteChair());
    } catch (e) { msg = String((e as Error).message); }
    expect(msg, "an unfilled required slot must be refused where the genome is authored").toBeDefined();
    expect(msg!).toContain(SLOT_INSTITUTION);
    expect(msg!).toContain("structure-conformance");
    expect(msg!, "the message must name the chair the seating happened at").toContain("structure");
  });

  it("an omitted binding time IS institution-bound — the default is the seat, not the gig", () => {
    expect(() => oneChairStandard([agentWith(carriedSkill())], noteChair())).toThrow(new RegExp(SLOT_INSTITUTION));
  });

  it("the chair's `supplies` fills it — that is what a seat is for", () => {
    expect(() => oneChairStandard(
      [agentWith(carriedSkill({ binding: "institution" }))],
      noteChair({ supplies: { [SLOT_INSTITUTION]: "two-space indent; British spelling" } }),
    )).not.toThrow();
  });

  it("a GIG-bound required slot composes unfilled — the gig payload is its argument list", () => {
    const gigBound = {
      slug: "structure-conformance", version: 1, md: "CARRIED_TECHNIQUE",
      hydration: { [SLOT_GIG]: { type: "array", required: true, binding: "gig" } },
    };
    expect(() => oneChairStandard([agentWith(gigBound)], noteChair()),
      "compose time knows nothing about the arguments of a run that has not been dispatched").not.toThrow();
  });

  it("a slot that is not required composes unfilled", () => {
    expect(() => oneChairStandard([agentWith(carriedSkill({ required: false }))], noteChair())).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 — two tiers: preference is soft, the floor still refuses
// ─────────────────────────────────────────────────────────────────────────────
describe("expectation tiers — `preferred_skills` is soft, `required_skills` is the floor", () => {
  const bare = () => testAgent({ slug: "carrier", primitives: ["INTERPRET"], input_types: [], output_types: ["note"] });

  it("a chair seats an agent that holds NONE of its preferred skills", () => {
    expect(() => oneChairStandard([bare()], noteChair({ preferred_skills: ["structure-conformance", "not-held-either"] })),
      "a preference that refused a seating would be a second floor, not a preference").not.toThrow();
  });

  it("a preference may name a technique no agent in the genome has grown yet", () => {
    expect(() => oneChairStandard([bare()], noteChair({ preferred_skills: ["a-technique-nobody-has-grown-yet"] }))).not.toThrow();
  });

  it("the floor still refuses: required_skills the agent neither binds nor carries", () => {
    expect(() => oneChairStandard([bare()], noteChair({ required_skills: ["structure-conformance"] })))
      .toThrow(/skill|declare/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 — the shipped genome demonstrates it by instance
// ─────────────────────────────────────────────────────────────────────────────
describe("the default genome — the maker carries its own technique, the institution fills the slot", () => {
  const genome = loadGenome(REPO_ROOT);
  const quartet = JSON.parse(readFileSync(join(REPO_ROOT, "institutions", "quartet.json"), "utf-8")) as {
    chairs: Array<{ id?: string; role: string; preferred_skills?: string[]; supplies?: Record<string, unknown> }>;
    assignments: Array<{ id?: string; chair_id: string; agent_slug: string; technique_evidence?: Array<{ source: string; claim: string }> }>;
  };
  const billsSkill = (): Carried => {
    const carried = carriedOn(genome.agents.get("bill"));
    expect(carried.length, "the maker is the seat closest to its own technique").toBeGreaterThanOrEqual(1);
    return carried[0]!;
  };

  it("the genome still loads with no errors", () => {
    expect(genome.load_errors.map((e) => `${e.kind} ${e.slug ?? e.path}: ${e.error}`)).toEqual([]);
  });

  it("bill carries a skill of its own, with one institution-bound and one gig-bound slot", () => {
    const slots = Object.entries(hydrationOf(billsSkill()));
    expect(slots.length, "a carried skill with no slot demonstrates nothing about hydration").toBeGreaterThanOrEqual(2);
    const bindings = new Set(slots.map(([, v]) => v.binding ?? "institution"));
    expect(bindings, "one slot of each binding time, so both seams are shown").toEqual(new Set(["institution", "gig"]));
    for (const [name, slot] of slots) {
      expect(slot.type, `slot "${name}" declares no type`).toBeTypeOf("string");
      expect(slot.description, `slot "${name}" says nothing about what fills it`).toBeTypeOf("string");
    }
  });

  it("every standard chair bill sits in states the carried technique as a preference", () => {
    const carriedSlug = billsSkill().slug;
    const billChairs = [...genome.standards.values()].flatMap((std) =>
      std.phases.flatMap((p) => p.chairs.filter((c) => c.agent_slug === "bill").map((c) => ({ std: std.slug, c }))),
    );
    expect(billChairs.length).toBeGreaterThan(0);
    for (const { std, c } of billChairs) {
      expect(field<string[]>(c, "preferred_skills") ?? [],
        `${std}/${c.role} states no preference for the technique it wants`).toContain(carriedSlug);
    }
  });

  it("the quartet's maker chair SUPPLIES every institution-bound slot, and supplies nothing else", () => {
    const slots = Object.entries(hydrationOf(billsSkill()));
    const chair = quartet.chairs.find((c) => c.role === "structure-builder")!;
    const supplied = Object.keys(chair.supplies ?? {});
    for (const [name, slot] of slots) {
      if ((slot.binding ?? "institution") !== "institution") continue;
      expect(supplied, `the institution declares nothing for slot "${name}"`).toContain(name);
      expect(String(chair.supplies![name]).length, `slot "${name}" is filled with nothing`).toBeGreaterThan(20);
    }
    for (const key of supplied) {
      expect(Object.keys(hydrationOf(billsSkill())), `chair supplies "${key}", which names no declared slot`).toContain(key);
    }
  });

  it("a gig-bound slot is filled by nobody at seat time — the institution does not pre-answer a run", () => {
    const chair = quartet.chairs.find((c) => c.role === "structure-builder")!;
    const gigSlots = Object.entries(hydrationOf(billsSkill())).filter(([, v]) => v.binding === "gig").map(([k]) => k);
    expect(gigSlots.length).toBeGreaterThanOrEqual(1);
    for (const name of gigSlots) {
      expect(Object.keys(chair.supplies ?? {}),
        `slot "${name}" is a run parameter; a seat that answers it removes the parameter`).not.toContain(name);
    }
  });

  it("every shipped seating cites the technique evidence it weighed", () => {
    expect(quartet.assignments.length).toBeGreaterThanOrEqual(3);
    for (const seat of quartet.assignments) {
      const ev = seat.technique_evidence ?? [];
      expect(ev.length, `seat "${seat.id ?? seat.chair_id}" seats ${seat.agent_slug} on an unrecorded judgement`).toBeGreaterThanOrEqual(1);
      for (const e of ev) {
        expect(e.source.length, "an evidence entry with no source is a recollection").toBeGreaterThan(10);
        expect(e.claim.length, "an evidence entry with no claim cites nothing in particular").toBeGreaterThan(40);
      }
    }
  });
});
