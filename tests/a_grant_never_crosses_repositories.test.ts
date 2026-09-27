// RED-DEF-10 — A GRANT NEVER CROSSES REPOSITORIES.
//
// Chancery amendments 000022 and 000023 widened the implementer's FLAT allowed_tools with
// `Write(ios/**)` and `Write(scripts/**)` — for every repository that implementer is ever seated in,
// because a flat grant has no idea which repository it is in. The founder, 26 Sep: "the folder that's
// relevant to editing should not be set in rules in the engine… shouldn't that be defined in the genome
// instance of the app in question?"
//
// So a role token (`Write(@source)`) means "this repository's source", and ONLY the layout of the
// repository the gig runs against says what that is. Seated against a TypeScript layout (`src/**`), the
// same agent holds no grant that reaches `ios/…`.
//
//   law                                          kind         drives                                  plant
//   @source means THIS layout's source, only     behavioural  resolveSeatGrants — src/layout_grants.ts expand role tokens from a module-level
//                                                                                                     ROLE_GLOBS table instead of `layout`
//   two layouts, two answers                     behavioural  same                                    same
import { describe, it, expect } from "vitest";
import { testAgent } from "./_support/agents.js";
import { loadLayoutGrants, TS_LAYOUT, IOS_LAYOUT } from "./layout_grants_fixtures.js";

const implementer = testAgent({
  slug: "implementer", primitives: ["CREATE"], input_types: [], output_types: ["note"], domain: "demo",
  allowed_tools: ["Read", "Write(@source)", "Edit(@source)"],
});

/** Does a path-scoped grant of `tool` reach `path`? Literal-prefix reading of `dir/**` globs — the only
 *  glob shape these fixtures use — so the test never needs its own glob engine. */
const reaches = (grants: readonly string[], tool: string, path: string): boolean =>
  grants.some((g) => {
    const m = new RegExp(`^${tool}\\((.*)\\)$`).exec(g);
    if (!m) return g === tool; // a BARE Write reaches everything
    const scope = m[1]!;
    return scope === path || scope === "**" || (scope.endsWith("/**") && path.startsWith(scope.slice(0, -2)));
  });

describe("RED-DEF-10 — a grant never crosses repositories", () => {
  it("an implementer holding Write(@source), seated against a layout whose source is src/**, holds exactly Write(src/**) and nothing that reaches ios/", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: implementer, layout: TS_LAYOUT });
    expect(r.refusals, `a declared role was refused: ${JSON.stringify(r.refusals)}`).toEqual([]);
    expect([...r.grants].sort(), "the role token did not expand to exactly the layout's source globs").toEqual(
      ["Edit(src/**)", "Read", "Write(src/**)"],
    );
    expect(reaches(r.grants, "Write", "ios/Sources/App.swift"), "a TypeScript repository's seat can write ios/ — the grant crossed repositories").toBe(false);
    expect(reaches(r.grants, "Edit", "ios/Sources/App.swift"), "a TypeScript repository's seat can edit ios/").toBe(false);
    expect(reaches(r.grants, "Write", "scripts/ship.sh"), "a TypeScript repository's seat can write scripts/, which its layout never named as source").toBe(false);
    // Non-vacuity: the seat CAN write its own source.
    expect(reaches(r.grants, "Write", "src/index.ts")).toBe(true);
  });

  it("the same agent answers differently in two repositories — the expansion is the layout's, not a table the engine carries", async () => {
    const L = await loadLayoutGrants();
    const ts = L.resolveSeatGrants({ agent: implementer, layout: TS_LAYOUT }).grants;
    const ios = L.resolveSeatGrants({ agent: implementer, layout: IOS_LAYOUT }).grants;
    expect(ts, "in the iOS repository's terms the TypeScript seat reached ios/").not.toContain("Write(ios/Sources/**)");
    expect(ios, "in the TypeScript repository's terms the iOS seat reached src/").not.toContain("Write(src/**)");
    expect(new Set(ts), "two layouts resolved to the same grants — the layout was not consulted").not.toEqual(new Set(ios));
  });
});
