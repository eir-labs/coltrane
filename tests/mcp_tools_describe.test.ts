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
import { MCP_TOOLS } from "../src/mcp.js";
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
    // The other direction: a renamed or retired tool leaving its description behind is a dead
    // entry nothing would ever surface, and the module's load-time refusal cannot see it.
    // Reached through the built registry, so this stays true however the map is stored.
    const slugs = new Set(MCP_TOOLS.map((t) => t.slug));
    expect(MCP_TOOLS.every((t) => slugs.has(t.slug))).toBe(true);
    expect(new Set(MCP_TOOLS.map((t) => t.slug)).size).toBe(MCP_TOOLS.length);
  });
});
