// RED-DEF-15 — RESOLUTION ONLY NARROWS.
//
// "Grants only ever narrow" — the precedent is venueEffectiveTools (src/chart.ts), where "a venue cannot
// hand a player authority its charter never claimed". Resolution is three steps: expand role tokens
// through the layout, ∩ target_paths for Write/Edit, ∩ the venue's equipment. The FIRST step is the only
// one allowed to produce a string the agent did not literally write, and only from its own tokens and the
// layout's own answers. Each later step may only remove, or narrow a Write/Edit to a target path its glob
// already covered. A step that ADDS — a room equipping a tool the agent never claimed, a target path the
// agent's globs never reached — is a widening wearing the name of a narrowing.
//
//   law                                       kind         drives                                  plant
//   expansion draws only on tokens + layout   behavioural  resolveSeatGrants — src/layout_grants.ts expand a token to its layout globs PLUS the
//                                                                                                   agent's other literals of that tool
//   targets/venue never add (property)        behavioural  same                                    union target_paths in as Write(<path>) for
//                                                                                                   every target, covered or not
//   a room cannot add a tool                  behavioural  same                                    take the venue's equipment.tools as the
//                                                                                                   grant set instead of intersecting
//   a target outside every glob adds nothing  behavioural  same                                    grant Write(<target>) for every target
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { testAgent } from "./_support/agents.js";
import { loadLayoutGrants, room, type Layout } from "./layout_grants_fixtures.js";

const PATH_ROLES = ["source", "tests", "migrations", "scripts", "docs"] as const;
const COMMAND_ROLES = ["build", "test", "laws", "ship_dry"] as const;
const DIRS = ["src", "lib", "ios/Sources", "ios/Tests", "tests", "docs", "db"];
const PREFIXES = ["npx vitest run", "npm run build", "swift test", "npm pack --dry-run"];
const LITERALS = ["Read", "Grep", "Write(src/**)", "Edit(tests/**)", "Bash(git diff:*)", "mcp__coltrane__type_browse"];
const TOKENS = ["Write(@source)", "Edit(@source)", "Edit(@tests)", "Write(@docs)", "Write(@migrations)", "Bash(@laws)", "Bash(@build)", "Bash(@ship_dry)"];
const FILES = ["src/a.ts", "lib/b.ts", "ios/Sources/App.swift", "tests/c.test.ts", "docs/d.md", "db/001.sql", "elsewhere/x"];
const ROOM_TOOLS = ["Read", "Grep", "Write", "Edit", "Bash", "mcp__coltrane__type_browse"];

const base = (g: string): string => (g.indexOf("(") >= 0 ? g.slice(0, g.indexOf("(")) : g);
const scope = (g: string): string | undefined => /^[^(]+\((.*)\)$/.exec(g)?.[1];
/** Does the `dir/**` glob (the only glob shape generated here) cover the file? */
const covers = (glob: string, file: string): boolean => glob === "**" || glob === file || (glob.endsWith("/**") && file.startsWith(glob.slice(0, -2)));

const layoutArb: fc.Arbitrary<Layout> = fc.record({
  paths: fc.dictionary(fc.constantFrom(...PATH_ROLES), fc.uniqueArray(fc.constantFrom(...DIRS).map((d) => `${d}/**`), { minLength: 1, maxLength: 3 })),
  commands: fc.dictionary(fc.constantFrom(...COMMAND_ROLES), fc.uniqueArray(fc.constantFrom(...PREFIXES), { minLength: 1, maxLength: 2 })),
}) as fc.Arbitrary<Layout>;

const grantsArb = fc.uniqueArray(fc.constantFrom(...LITERALS, ...TOKENS), { minLength: 1, maxLength: 8 });

describe("RED-DEF-15 — resolution only narrows", () => {
  it("expansion alone draws only on the agent's own literals and the layout's answers to the agent's own tokens", async () => {
    const L = await loadLayoutGrants();
    fc.assert(
      fc.property(grantsArb, fc.option(layoutArb, { nil: undefined }), (declared, layout) => {
        const agent = testAgent({ slug: "p", primitives: ["CREATE"], input_types: [], output_types: ["note"], domain: "demo", allowed_tools: declared });
        const { grants } = L.resolveSeatGrants({ agent, layout });
        for (const g of grants) {
          if (declared.includes(g) && !g.includes("@")) continue;
          const answered = declared.some((t) => {
            const m = /^(\w+)\(@(\w+)\)$/.exec(t);
            if (!m || m[1] !== base(g)) return false;
            const role = m[2]!;
            if (m[1] === "Bash") return (layout?.commands?.[role as (typeof COMMAND_ROLES)[number]] ?? []).some((p) => g === `Bash(${p}:*)`);
            return (layout?.paths?.[role as (typeof PATH_ROLES)[number]] ?? []).some((glob) => g === `${m[1]}(${glob})`);
          });
          if (!answered) throw new Error(`"${g}" is neither a declared literal nor the layout's answer to a declared token (declared ${JSON.stringify(declared)}, layout ${JSON.stringify(layout)})`);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("target_paths and the venue never add: every final grant is an expanded grant, or a Write/Edit narrowed to a target an expanded glob already covered, held in the room", async () => {
    const L = await loadLayoutGrants();
    fc.assert(
      fc.property(
        grantsArb,
        layoutArb,
        fc.option(fc.uniqueArray(fc.constantFrom(...FILES), { maxLength: 4 }), { nil: undefined }),
        fc.option(fc.uniqueArray(fc.constantFrom(...ROOM_TOOLS), { maxLength: 6 }), { nil: undefined }),
        (declared, layout, targets, tools) => {
          const agent = testAgent({ slug: "p", primitives: ["CREATE"], input_types: [], output_types: ["note"], domain: "demo", allowed_tools: declared });
          const expanded = L.resolveSeatGrants({ agent, layout }).grants;
          const venue = tools ? room(tools) : undefined;
          const final = L.resolveSeatGrants({ agent, layout, target_paths: targets, venue }).grants;
          for (const g of final) {
            if (g.includes("@")) throw new Error(`a role token reached the final grant set: ${g}`);
            if (tools && !tools.includes(base(g))) throw new Error(`"${g}" survived a room that does not equip ${base(g)} (room ${JSON.stringify(tools)})`);
            if (expanded.includes(g)) continue;
            const s = scope(g);
            const narrowed =
              targets !== undefined && s !== undefined && (base(g) === "Write" || base(g) === "Edit") && targets.includes(s) &&
              expanded.some((e) => base(e) === base(g) && (scope(e) === undefined || covers(scope(e)!, s)));
            if (!narrowed) throw new Error(`"${g}" was ADDED by target_paths/venue (expanded ${JSON.stringify(expanded)}, targets ${JSON.stringify(targets)})`);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it("a room that equips tools the agent never claimed adds none of them", async () => {
    const L = await loadLayoutGrants();
    const agent = testAgent({ slug: "r", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", allowed_tools: ["Read"] });
    const r = L.resolveSeatGrants({ agent, venue: room(["Read", "Write", "Bash", "WebFetch"]) });
    expect(r.grants, "the room handed the seat authority its charter never claimed").toEqual(["Read"]);
  });

  it("a room that does not equip Bash removes the laws command the layout expanded", async () => {
    const L = await loadLayoutGrants();
    const agent = testAgent({ slug: "r", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", allowed_tools: ["Read", "Bash(@laws)"] });
    const layout: Layout = { commands: { laws: ["npx vitest run"] } };
    expect(L.resolveSeatGrants({ agent, layout }).grants, "non-vacuity: without a room the laws command is held").toContain("Bash(npx vitest run:*)");
    expect(L.resolveSeatGrants({ agent, layout, venue: room(["Read"]) }).grants).toEqual(["Read"]);
  });

  it("a target outside every glob the seat holds adds nothing", async () => {
    const L = await loadLayoutGrants();
    const agent = testAgent({ slug: "r", primitives: ["CREATE"], input_types: [], output_types: ["note"], domain: "demo", allowed_tools: ["Read", "Write(@source)"] });
    const r = L.resolveSeatGrants({ agent, layout: { paths: { source: ["src/**"] } }, target_paths: ["ios/Sources/App.swift"] });
    expect(r.grants, "a target the seat's source never covered became a grant").toEqual(["Read"]);
    expect(r.target_paths_applied).toBe(true);
  });
});
