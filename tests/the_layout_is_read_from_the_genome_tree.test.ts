// THE LAYOUT IS READ FROM THE GENOME TREE THE GIG RUNS AGAINST — through one Zod schema.
//
// A layout nobody loads is a file, not a grant: role tokens would resolve against `undefined` and fail
// closed forever, and every law about expansion would be green against a hand-built object while the
// loaded genome carried nothing. So the loader must expose `coltrane.layout.json` on the genome it
// returns, validated by the ONE Zod schema (`LayoutSchema`, src/genome_schema.ts) — the repo rule that
// a class's shape is written once. An absent file is `undefined` (a genome with no layout is legal and
// loads as today); a MALFORMED file is a load_error naming it, and is treated as absent — never half-read.
//
//   law                                   kind         drives                                    plant
//   the file becomes genome.layout        behavioural  loadGenome — src/loader.ts                  never read coltrane.layout.json (layout stays undefined)
//   absent file → undefined, no error     behavioural  same                                      default an absent layout to {} or a house layout
//   malformed → load_error, and absent    behavioural  same                                      keep the raw JSON when LayoutSchema refuses it
//   one schema, strict                    behavioural  LayoutSchema — src/genome_schema.ts       drop .strict() from the paths object
//   the assembler threads it              behavioural  assembleRunDeps — src/run_deps.ts         omit `layout` from assembleRunDeps' return
import { describe, it, expect } from "vitest";
import { loadGenome } from "../src/loader.js";
import { genomeTree, layoutSchema, TS_LAYOUT } from "./layout_grants_fixtures.js";

const layoutOf = (g: unknown): unknown => (g as { layout?: unknown }).layout;

describe("the layout is read from the genome tree the gig runs against", () => {
  it("a tree with coltrane.layout.json loads it as genome.layout, exactly as written", () => {
    const g = loadGenome(genomeTree({ layout: TS_LAYOUT }));
    expect(g.load_errors, JSON.stringify(g.load_errors)).toEqual([]);
    expect(layoutOf(g), "the loaded genome carries no layout — the file was never read").toEqual(TS_LAYOUT);
  });

  it("a tree with NO layout file loads as today: layout undefined, no load error", () => {
    const g = loadGenome(genomeTree());
    expect(g.load_errors).toEqual([]);
    expect("layout" in g ? layoutOf(g) : undefined, "an absent layout was defaulted to something").toBeUndefined();
    // Non-vacuity: the same loader DOES carry a layout when one is there (the law above), so undefined
    // here is the absence being honoured, not a loader that never reads the file.
  });

  it("a MALFORMED layout is a load_error naming the file, and the genome carries no layout", () => {
    for (const bad of ["{ not json", JSON.stringify({ paths: { source: "src/**" } }), JSON.stringify({ paths: { sources: ["src/**"] } })]) {
      const g = loadGenome(genomeTree({ layout: bad }));
      expect(
        g.load_errors.some((e) => e.path.endsWith("coltrane.layout.json")),
        `a malformed layout (${bad.slice(0, 40)}) loaded without a load_error naming coltrane.layout.json`,
      ).toBe(true);
      expect(layoutOf(g), `a malformed layout (${bad.slice(0, 40)}) was half-read into genome.layout`).toBeUndefined();
    }
  });

  it("LayoutSchema is the one source: it admits the declared roles and refuses an undeclared one", () => {
    const S = layoutSchema();
    expect(S.safeParse(TS_LAYOUT).success, "the schema refused a well-formed layout").toBe(true);
    expect(
      S.safeParse({ paths: { source: ["src/**"], tests: ["tests/**"], migrations: ["db/**"], scripts: ["scripts/**"], docs: ["docs/**"] }, commands: { build: ["npm run build"], test: ["npm test"], laws: ["npx vitest run"], ship_dry: ["npm pack --dry-run"] } }).success,
      "the schema refused one of the nine declared roles",
    ).toBe(true);
    expect(S.safeParse({ paths: { sources: ["src/**"] } }).success, "a misspelt path role was admitted — it would silently grant nothing").toBe(false);
    expect(S.safeParse({ commands: { deploy: ["fly deploy"] } }).success, "an undeclared command role was admitted").toBe(false);
    expect(S.safeParse({ paths: { source: "src/**" } }).success, "a role that is not a list of globs was admitted").toBe(false);
  });

  it("assembleRunDeps threads the layout to the run — the one assembler every door builds its deps from", async () => {
    const RD = (await import("../src/run_deps.js")) as unknown as { assembleRunDeps(a: Record<string, unknown>): Record<string, unknown> };
    const deps = RD.assembleRunDeps({ outputs: {}, ledger: {}, invoke: () => ({}), mcpServerConfigs: undefined, layout: TS_LAYOUT });
    expect(deps["layout"], "the assembler dropped the layout — no door's run can see it").toEqual(TS_LAYOUT);
  });
});
