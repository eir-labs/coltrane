// RED — a chair narrows what the agent seated in it may REACH.
//
// Today `allowed_tools` lives only on the AGENT. Two chairs seating one agent therefore get the
// identical grant, so "one player, seated into many seats, each seat constraining what it may do"
// is not expressible: the only way to give two seats different authority is to author two agents.
//
// That is the force that grew this genome. Measured on the default repertoire before writing this
// file: 68 agents collapse to 49 distinct capability signatures (primitives + exact tool grant +
// tier + code_tool_access), and of the 49, the majority differ from a sibling ONLY by their grant.
// The agents are not sloppiness — they are the shape the engine forced.
//
// The precedent is already in the engine, one field over. #174 made a chair narrow the agent's
// OUTPUT types: "a multi-capability agent bound to a single-purpose chair produces only the promised
// subset, not its whole catalogue" (src/runtime.ts, ctx.output_types). This does the same for what
// the seat may reach. A chair is the place the engine already expresses "this agent, here, doing
// only this".
//
// DIRECTION IS THE WHOLE POINT, exactly as for a venue (src/chart.ts venueEffectiveTools): a chair
// is a CEILING, never a grant. It can only ever return a subset of the agent's own grants, so a
// standard cannot hand a player authority its charter never claimed.
//
// testing_method: example-based against the shared oracle and composeStandard, plus a runGig law
// that the narrowed set is what actually reaches the invoker (the seam where a ceiling that is
// computed but not applied would look identical to one that is enforced).
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard,
  type AgentInvoker, type AgentInvocationContext, type DomainType, type Chair, type Standard, type Agent,
} from "../src/index.js";
import { runGig } from "../src/runtime.js";
import { seatEffectiveTools, venueEffectiveTools, type Venue } from "../src/chart.js";
import { VenueSchema } from "../src/genome_schema.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = { slug: "ct-note", extends: "Signal", domain: "chair-tools", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const read: DomainType = { slug: "ct-read", extends: "Interpretation", domain: "chair-tools", schema: { properties: { summary: { type: "string" } } }, required_fields: ["summary"] };
const call: DomainType = { slug: "ct-call", extends: "Verdict", domain: "chair-tools", schema: { properties: { v: { type: "string" } } }, required_fields: ["v"] };

/** A bare source, so the PLAYER can sit purely downstream and be seated twice. */
const source = (): Agent => testAgent({ slug: "ct-source", primitives: ["SENSE"], input_types: [], output_types: ["ct-note"], domain: "chair-tools" }) as Agent;

/** ONE agent, broadly granted — the player. The chairs do the narrowing. */
const player = (): Agent => testAgent({
  slug: "ct-player", primitives: ["INTERPRET", "VERIFY"], input_types: ["ct-note"], output_types: ["ct-read", "ct-call"],
  domain: "chair-tools",
  allowed_tools: ["Read", "Glob", "Grep", "Bash(git diff:*)", "Write(tests/**)"],
}) as Agent;


/** A chair literal for oracle laws: only the fields the ceiling cares about. */
const chair = (role: string, allowed_tools?: string[]): Chair =>
  ({ role, agent_slug: "ct-player", depends_on: [], input_contract: [], output_contract: [], required_skills: [],
     ...(allowed_tools ? { allowed_tools } : {}) }) as unknown as Chair;

const ROOM = { slug: "ct-room", institution_slug: "quartet", equipment: { tools: ["Read", "Glob", "Grep"] }, lifecycle: { policy: "ephemeral" } };

describe("C1 — a chair's ceiling narrows, and can never grant", () => {
  it("the effective set is a SUBSET of the agent's own grants", () => {
    const a = player();
    const got = seatEffectiveTools(a, chair("r", ["Read", "Glob"]));
    expect(new Set(got)).toEqual(new Set(["Read", "Glob"]));
    for (const g of got) expect(a.allowed_tools).toContain(g);
  });

  it("a tool the CHAIR names and the agent does NOT hold never appears — a chair cannot grant", () => {
    const got = seatEffectiveTools(player(), chair("r", ["Read", "WebFetch"]));
    expect(got, "WebFetch is in the chair and absent from the charter").toEqual(["Read"]);
  });

  // The house rule, stated so nobody mistakes a ceiling for a scope rewriter: matching is on BASE
  // name, exactly as a venue matches. A chair naming `Bash(rm:*)` does NOT grant rm — the agent never
  // held it — but it also does not re-scope the agent's own `Bash(git diff:*)` down to rm. A ceiling
  // chooses WHICH of the agent's grants survive, never what any of them means.
  it("a ceiling selects whole grants by base name; it never re-scopes one", () => {
    const got = seatEffectiveTools(player(), chair("r", ["Bash(rm:*)"]));
    expect(got, "the agent's own Bash grant survives, unrewritten").toEqual(["Bash(git diff:*)"]);
    expect(got, "and rm was never granted, because the charter never held it").not.toContain("Bash(rm:*)");
  });

  it("a chair with NO ceiling changes nothing — the agent's full grant stands", () => {
    const a = player();
    expect(new Set(seatEffectiveTools(a, chair("r")))).toEqual(new Set(a.allowed_tools));
  });

  it("scoped grants match on BASE name, as every other grant resolution does", () => {
    const got = seatEffectiveTools(player(), chair("r", ["Bash"]));
    expect(got, "a chair that holds Bash holds the agent's scoped Bash grant").toEqual(["Bash(git diff:*)"]);
  });
});

describe("C2 — THE POINT: two chairs, one agent, different authority", () => {
  it("the same agent in two chairs reaches two different tool sets", () => {
    const a = player();
    const readerSeat = seatEffectiveTools(a, chair("reader", ["Read", "Grep"]));
    const writerSeat = seatEffectiveTools(a, chair("writer", ["Write(tests/**)"]));
    expect(new Set(readerSeat)).toEqual(new Set(["Read", "Grep"]));
    expect(new Set(writerSeat)).toEqual(new Set(["Write(tests/**)"]));
    expect(readerSeat, "the reading seat cannot write").not.toContain("Write(tests/**)");
    expect(writerSeat, "the writing seat cannot read").not.toContain("Read");
  });
});

describe("C3 — chair and venue compose; the room is still a ceiling over both", () => {
  it("agent ∩ chair ∩ venue", () => {
    const got = seatEffectiveTools(player(), chair("r", ["Read", "Write(tests/**)"]), VenueSchema.parse(ROOM) as unknown as Venue);
    expect(got, "Write is in agent+chair but NOT in the room").toEqual(["Read"]);
  });

  it("venueEffectiveTools is the SAME intersection with no chair — one oracle, no second copy", () => {
    const a = player(); const v = VenueSchema.parse(ROOM) as unknown as Venue;
    expect(new Set(venueEffectiveTools(a, v))).toEqual(new Set(seatEffectiveTools(a, undefined, v)));
  });
});

describe("C4 — a ceiling that can reach nothing is a dead chair, refused at COMPOSE time", () => {
  const mk = (tools: string[]): () => Standard => () => composeStandard({
    slug: "ct-dead", domain: "chair-tools",
    agents: [player()],
    phases: [{ name: "p0", chairs: [{ role: "r0", agent_slug: "ct-player", allowed_tools: tools, depends_on: [], input_contract: [], output_contract: ["ct-read"], required_skills: [] } as unknown as Chair] }],
  });

  it("a chair whose entire ceiling lies outside its agent's grant is REFUSED, naming the chair", () => {
    expect(mk(["WebFetch", "WebSearch"]), "a seat that can reach nothing it named is a dead chair").toThrow(/r0/);
  });

  it("a chair whose ceiling overlaps the grant composes fine", () => {
    expect(mk(["Read", "WebFetch"])).not.toThrow();
  });
});

describe("C5 — the narrowed set REACHES the invocation, not just the oracle", () => {
  function twoSeats(): Standard {
    return composeStandard({
      slug: "ct-two-seats", domain: "chair-tools",
      agents: [source(), player()],
      phases: [
        { name: "p0", chairs: [{ role: "src", agent_slug: "ct-source", depends_on: [], input_contract: [], output_contract: ["ct-note"], required_skills: [] } as unknown as Chair] },
        // ONE agent. TWO chairs. TWO authorities.
        { name: "p1", chairs: [
          { role: "reading-seat", agent_slug: "ct-player", allowed_tools: ["Read", "Grep"], depends_on: ["src"], input_contract: ["ct-note"], output_contract: ["ct-read"], required_skills: [] } as unknown as Chair,
          { role: "writing-seat", agent_slug: "ct-player", allowed_tools: ["Write(tests/**)"], depends_on: ["src"], input_contract: ["ct-note"], output_contract: ["ct-call"], required_skills: [] } as unknown as Chair,
        ] },
      ],
    });
  }

  it("each seat's ctx carries ITS OWN ceiling — the same agent, two authorities, in one run", async () => {
    const registry = createRegistry(); registry.registerType(note); registry.registerType(read); registry.registerType(call);
    const seen = new Map<string, readonly string[] | undefined>();
    const invoke: AgentInvoker = (ctx: AgentInvocationContext) => {
      seen.set(ctx.role ?? "?", ctx.allowed_tools);
      if (ctx.role === "src") return { t: "x", source: "fixture://chair-tools" };
      if (ctx.role === "reading-seat") return { summary: "y", claims: ["read it"] };
      return { v: "go", checks: [{ method: "one check", result: "pass" }] };
    };
    await runGig(twoSeats(), {}, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, model_version: "m" });

    expect(new Set(seen.get("reading-seat") ?? []), "the reading seat is handed only its own ceiling").toEqual(new Set(["Read", "Grep"]));
    expect(new Set(seen.get("writing-seat") ?? []), "the writing seat is handed only its own ceiling").toEqual(new Set(["Write(tests/**)"]));
    expect(seen.get("reading-seat"), "the reading seat cannot write").not.toContain("Write(tests/**)");
    expect(seen.get("writing-seat"), "the writing seat cannot read").not.toContain("Read");
  });

  it("ctx.allowed_tools EQUALS the shared oracle for that chair — not a re-inlined intersection", async () => {
    const registry = createRegistry(); registry.registerType(note); registry.registerType(read); registry.registerType(call);
    const std = twoSeats();
    const a = player();
    const oracleFor = (role: string): string[] => {
      const chair = std.phases.flatMap((p) => p.chairs).find((c) => c.role === role)!;
      return seatEffectiveTools(a, chair);
    };
    const seen = new Map<string, readonly string[] | undefined>();
    const invoke: AgentInvoker = (ctx) => {
      seen.set(ctx.role ?? "?", ctx.allowed_tools);
      if (ctx.role === "src") return { t: "x", source: "fixture://chair-tools" };
      if (ctx.role === "reading-seat") return { summary: "y", claims: ["read it"] };
      return { v: "go", checks: [{ method: "one check", result: "pass" }] };
    };
    await runGig(std, {}, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, model_version: "m" });
    for (const role of ["reading-seat", "writing-seat"]) {
      expect(new Set(seen.get(role) ?? []), `${role} must equal the oracle`).toEqual(new Set(oracleFor(role)));
    }
  });
});
