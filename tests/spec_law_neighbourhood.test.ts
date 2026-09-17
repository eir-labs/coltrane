// RED — the index knows which laws reach a module, the way this repo's laws actually reach it.
//
// Slice 4 of the seat-briefing plan (the law neighbourhood). Half of a law seat's reading is on the
// test side (gig c539c33b: 8 of 16 Reads were specs, laws and fixtures), and compileRepositoryIndex
// cannot answer "which laws cover src/runtime.ts" for most of them:
//   · 136 test files import through the barrel (`from "../src"` / "../src/index.js"), and module_tests
//     records the barrel, never the module that defines the imported name;
//   · 17 test files are RED-by-import with a literal `await import("../src/x.js")` (more through computed
//     hrefs, which stay out of scope), and parseImports requires the
//     `import <clause> from` form, so a dynamic import is not an edge at all.
// Resolution must be PER IMPORTED NAME: linking every barrel importer to every re-exported module
// would make all 136 barrel importers neighbours of every module, which is no index.
import { describe, it, expect } from "vitest";
import { compileRepositoryIndex } from "../src/repo_index.js";

const FILES = [
  { path: "src/runtime.ts", content: "export function runGig(): number { return 1; }\n" },
  { path: "src/helper.ts", content: "export const helperX = 2;\n" },
  { path: "src/index.ts", content: 'export * from "./runtime.js";\nexport * from "./helper.js";\n' },
  { path: "tests/amend.test.ts", content: 'import { runGig } from "../src";\nrunGig();\n' },
  { path: "tests/helper_only.test.ts", content: 'import { helperX } from "../src/index.js";\nvoid helperX;\n' },
  { path: "tests/spec_red.test.ts", content: 'const R = await import("../src/runtime.js");\nvoid R;\n' },
  { path: "tests/spec_new.test.ts", content: 'const N = await import("../src/not_yet.js");\nvoid N;\n' },
];

const pairs = (idx: ReturnType<typeof compileRepositoryIndex>, module: string): string[] =>
  idx.module_tests.filter((m) => m.module === module).map((m) => m.test).sort();

describe("module_tests follows the laws to the module that defines what they use", () => {
  it("a law importing a name through the barrel is a neighbour of the module that defines that name", () => {
    const idx = compileRepositoryIndex(FILES, { source_revision: "r1" });
    expect(pairs(idx, "src/runtime.ts"), "a barrel import records only src/index.ts, so runtime.ts looks like it has no laws").toContain("tests/amend.test.ts");
  });

  it("barrel resolution is per imported name: a law importing only helperX is not a neighbour of runtime.ts", () => {
    const idx = compileRepositoryIndex(FILES, { source_revision: "r1" });
    expect(pairs(idx, "src/helper.ts"), "a barrel import of helperX records only src/index.ts").toContain("tests/helper_only.test.ts");
    expect(pairs(idx, "src/runtime.ts"), "every barrel importer was linked to every re-exported module").not.toContain("tests/helper_only.test.ts");
  });

  it("a RED-by-import law (`await import(...)`) is a neighbour of the module it imports", () => {
    const idx = compileRepositoryIndex(FILES, { source_revision: "r1" });
    expect(pairs(idx, "src/runtime.ts"), "a dynamic import is invisible to the index").toContain("tests/spec_red.test.ts");
  });

  it("a dynamic import of a module that does not exist yet is recorded as pending, never a refusal and never dropped", () => {
    // The RED idiom imports modules before they exist. Refusing would make this repo unindexable;
    // dropping would make a law for a module-to-be invisible to the seat that builds it.
    const idx = compileRepositoryIndex(FILES, { source_revision: "r1" }) as unknown as { pending_modules?: Array<{ module: string; test: string }> };
    expect(idx.pending_modules, "a law importing a module that does not exist yet left no trace in the index").toEqual([
      { module: "src/not_yet.ts", test: "tests/spec_new.test.ts" },
    ]);
  });
});
