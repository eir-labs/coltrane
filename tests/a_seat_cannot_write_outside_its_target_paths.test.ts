// RED-DEF-11 — A SEAT CANNOT WRITE OUTSIDE ITS CHANGE'S target_paths.
//
// The change-request (domain_types/change-request.json) already carries `target_paths`, described today
// as "a belief, not a finding". Nothing reads it: a seat granted `Write(src/**)` for a one-file change can
// rewrite the whole of src/. The effective grant is the layout's expansion INTERSECTED with target_paths
// for Write and Edit: a grant survives only for the target paths its glob covers, narrowed to those paths.
//
// Decided semantics: target_paths ABSENT → no target narrowing, and the result SAYS so
// (`target_paths_applied: false`) — recorded, not silent.
//
//   law                                          kind         drives                                  plant
//   narrowed to the covered targets              behavioural  resolveSeatGrants — src/layout_grants.ts skip the target_paths intersection step
//   an uncovered target is never granted         behavioural  same                                    union target_paths into the grant set
//                                                                                                     instead of intersecting
//   Bash is not a path grant                     behavioural  same                                    apply the target intersection to every
//                                                                                                     scoped grant, not only Write/Edit
//   absence is recorded, not silent              behavioural  same                                    return target_paths_applied: true
//                                                                                                     unconditionally
import { describe, it, expect } from "vitest";
import { testAgent } from "./_support/agents.js";
import { loadLayoutGrants, TS_LAYOUT } from "./layout_grants_fixtures.js";

const LAYOUT = { ...TS_LAYOUT, paths: { ...TS_LAYOUT.paths, source: ["src/**", "lib/**"] } };

const implementer = testAgent({
  slug: "implementer", primitives: ["CREATE"], input_types: [], output_types: ["note"], domain: "demo",
  allowed_tools: ["Read", "Write(@source)", "Edit(@source)", "Bash(@laws)"],
});

describe("RED-DEF-11 — a seat cannot write outside its change's target_paths", () => {
  it("Write/Edit(@source) against targets [src/a.ts, docs/x.md] survive ONLY as src/a.ts — the covered target, narrowed to it", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: implementer, layout: LAYOUT, target_paths: ["src/a.ts", "docs/x.md"] });
    expect(r.target_paths_applied, "target_paths were supplied and the result does not say they were applied").toBe(true);
    const writes = r.grants.filter((g) => /^(Write|Edit)\(/.test(g)).sort();
    expect(writes, "the seat's write grants are not exactly the covered target").toEqual(["Edit(src/a.ts)", "Write(src/a.ts)"]);
    expect(r.grants, "the whole source glob survived a one-file change").not.toContain("Write(src/**)");
    expect(r.grants, "a source glob no target falls under survived").not.toContain("Write(lib/**)");
    expect(r.grants, "a target OUTSIDE the seat's source was granted — target_paths widened the seat").not.toContain("Write(docs/x.md)");
    expect(r.grants).not.toContain("Edit(docs/x.md)");
  });

  it("a literal Write(src/**) is narrowed by target_paths too — the intersection is not only for role tokens", async () => {
    const L = await loadLayoutGrants();
    const literal = testAgent({ slug: "lit", primitives: ["CREATE"], input_types: [], output_types: ["note"], domain: "demo", allowed_tools: ["Write(src/**)"] });
    const r = L.resolveSeatGrants({ agent: literal, target_paths: ["src/b.ts"] });
    expect(r.grants).toEqual(["Write(src/b.ts)"]);
  });

  it("Bash and Read are not path grants — target_paths leave them exactly as expanded", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: implementer, layout: LAYOUT, target_paths: ["src/a.ts"] });
    expect(r.grants, "Read was narrowed by target_paths").toContain("Read");
    expect(r.grants, "the laws command was narrowed away by target_paths").toContain("Bash(npx vitest run:*)");
  });

  it("target_paths ABSENT → no target narrowing, and the result records target_paths_applied: false", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: implementer, layout: LAYOUT });
    expect(r.target_paths_applied, "no target_paths were supplied and the result claims they were applied").toBe(false);
    expect(r.grants).toContain("Write(src/**)");
    expect(r.grants).toContain("Write(lib/**)");
  });
});
