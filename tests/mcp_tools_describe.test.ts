// EVERY ADVERTISED VERB SAYS WHAT IT DOES.
//
// THE DEFECT THIS CLOSES. `createToolSurface` built each tool's description by formatting its
// category — `description: \`${t.category} tool\`` — so all 54 verbs reached every MCP client as
// "run tool", "build tool", "understand tool", "improve tool" or "manage_context tool". The
// description is the field a model reads to CHOOSE a verb, so the surface offered fifty-four
// options and five distinct hints, over stdio and over the hosted endpoint alike.
//
// It survived because it was COMPUTED rather than left blank. A missing description would have
// been visibly missing; a generated one always produced a string, so nothing looked unfinished
// and no law could tell a written description from an absent one. That is this repo's own named
// failure — an absence that returns a legitimate-looking value — committed against the surface
// every client reads first.
//
// So the laws below do not merely assert a description EXISTS. Existence was never the problem.
// They assert it is not the category, not the slug, and not shorter than a sentence — the three
// shapes a plausible-looking non-description takes.
import { describe, it, expect } from "vitest";
import { MCP_TOOLS, TOOL_DESCRIPTIONS } from "../src/mcp.js";
import { createToolSurface } from "../src/server.js";

describe("every advertised verb says what it does", () => {
  it("the registry is non-empty (the laws below are not vacuous)", () => {
    expect(MCP_TOOLS.length).toBeGreaterThan(20);
  });

  it("law 1 — every tool carries a description", () => {
    const missing = MCP_TOOLS.filter((t) => !t.description || t.description.trim() === "");
    expect(missing.map((t) => t.slug)).toEqual([]);
  });

  it("law 2 — no description is its category restated (the exact defect that shipped)", () => {
    const lazy = MCP_TOOLS.filter(
      (t) => t.description.trim().toLowerCase() === `${t.category} tool`,
    );
    expect(
      lazy.map((t) => t.slug),
      "a verb described by its category tells a caller nothing it did not already know from the category field",
    ).toEqual([]);
  });

  it("law 3 — no description is merely the slug spelled out", () => {
    const echoes = MCP_TOOLS.filter((t) => {
      const words = t.slug.replace(/_/g, " ");
      return t.description.trim().toLowerCase().replace(/[.\s]+$/, "") === words;
    });
    expect(echoes.map((t) => t.slug)).toEqual([]);
  });

  it("law 4 — a description is at least a sentence, so it can carry WHEN to reach for the verb", () => {
    const thin = MCP_TOOLS.filter((t) => t.description.trim().length < 40).map(
      (t) => `${t.slug} (${t.description.trim().length} chars)`,
    );
    expect(thin).toEqual([]);
  });

  it("law 5 — the SURFACE serves the tool's own description, not one computed from it", () => {
    // The bug was in the surface, not the registry — a registry full of good descriptions is
    // worth nothing if createToolSurface goes on formatting the category. This drives the real
    // constructor and compares what a client would actually receive.
    const surface = createToolSurface({} as never);
    expect(surface.length).toBe(MCP_TOOLS.length);

    const byName = new Map(surface.map((t) => [t.name, t.description]));
    for (const t of MCP_TOOLS) {
      expect(byName.get(t.slug), `the surface rewrote ${t.slug}'s description`).toBe(t.description);
    }
  });

  it("law 6 — TOOL_DESCRIPTIONS holds no entry for a verb that does not exist", () => {
    // The other direction, and the one the load-time throw CANNOT cover: it fires on a tool with
    // no description, never on a description with no tool. A renamed or retired verb leaving its
    // entry behind is a dead string nothing will ever surface.
    //
    // THIS LAW COULD NOT FAIL IN ITS FIRST DRAFT. TOOL_DESCRIPTIONS was not exported, so it built
    // a Set from MCP_TOOLS and then asserted MCP_TOOLS was in it — a tautology, plus a duplicate
    // check that says nothing about orphans. It read as the reverse-direction guard and was two
    // statements about one array. Caught in review, not by running it: a tautology is green on
    // every input, so no sabotage of the SUBJECT could ever have reddened it. The map is exported
    // now and the law reads it.
    const slugs = new Set(MCP_TOOLS.map((t) => t.slug));
    const orphans = Object.keys(TOOL_DESCRIPTIONS).filter((k) => !slugs.has(k));
    expect(
      orphans,
      `these describe verbs the registry does not declare — a rename or retirement left them behind:\n${orphans.join("\n")}`,
    ).toEqual([]);

    // And the map is not empty: an emptied map has no orphans and would satisfy the above.
    expect(Object.keys(TOOL_DESCRIPTIONS).length).toBe(MCP_TOOLS.length);
  });

  it("law 7 — a description that names an argument names one the schema declares", () => {
    // WHAT THIS COVERS, EXACTLY. A description is prose sitting beside a generated
    // `input_schema`; the schema moves when the handler moves, the prose does not. A verb whose
    // argument is renamed or dropped leaves its description telling callers to pass a parameter
    // that no longer exists — and nothing else here would notice.
    //
    // WHAT IT DOES NOT COVER, said plainly so this law is not read as more than it is. Two of the
    // defects review found in these very descriptions were SEMANTIC, and a name-existence check
    // reaches neither: `output_query` stated the opposite of its own default (server.ts treats
    // include_data as true unless explicitly false), and the two promote verbs omitted `status`
    // altogether while describing promotion as a jump to active. A name that exists can still be
    // described wrongly. This is a drift ratchet, not a correctness check.
    //
    // THIS LAW'S FIRST DRAFT COULD NOT FAIL, and the sabotage is what said so. It forgave any
    // backticked token that no tool ANYWHERE declared, reasoning that such a token must be an
    // English word rather than a stale parameter. But a RENAMED OR REMOVED argument is exactly
    // a name no tool declares any more — the whole defect class walked through the exemption.
    // Renaming `current` to `slug_current` in standard_promote's description left it green.
    //
    // So the rule is strict: inside these descriptions a backticked bare snake_case token IS an
    // argument reference. A literal value is written without backticks (the promote verbs spell
    // their status chain as plain prose) or with its field (`include_data:false`, which this
    // regex does not match because of the colon).
    //
    // Corpus at the time of writing: 3 verbs, 8 names (gig_dispatch, agent_promote,
    // standard_promote). Deliberately not pinned to a count — a description that stops
    // backticking its arguments should not red.
    const wrong: string[] = [];
    for (const t of MCP_TOOLS) {
      const schema = t.input_schema as { properties?: Record<string, unknown> };
      const declared = new Set(Object.keys(schema.properties ?? {}));
      for (const m of t.description.matchAll(/`([a-z_][a-z0-9_]*)`/g)) {
        const name = m[1] as string;
        if (!declared.has(name)) {
          wrong.push(`${t.slug} names \`${name}\`, which its input_schema does not declare`);
        }
      }
    }
    expect(
      wrong,
      `a description points a caller at an argument the verb's own input_schema does not have:\n${wrong.join("\n")}`,
    ).toEqual([]);
  });
});
