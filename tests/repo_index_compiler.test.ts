// RED SPEC — the deterministic producer for change-context's MECHANICAL fields.
//
// The reading seat (agent john, software-change-pr-v1) spends 14–24 of a 24 tool-call cap
// RE-DERIVING repository facts every run — the import graph, the module→tests index, the exported
// symbols and their call sites — and three gigs this week DIED at the ceiling before reaching the
// judgment half. subsystem-contract C2/O3-O4 answers with a deterministic producer that COMPILES
// those mechanical fields from source, refreshed as a build artifact, more accurate than a model
// reading (RIG paper / SCIP / Kythe, grounding-dossier claims #5-#6).
//
// This file is the falsifiable RED contract for that producer. It asserts the UNIVERSAL laws a
// correct compiled index obeys — property-based (fast-check) where the invariant is a universal
// property over all repositories, metamorphic where it relates a source repo's index to a
// transformed one, WITHOUT ever hand-authoring "the one correct index" (that oracle would recreate
// the model reading the compiler replaces — grounding-dossier method_findings #1,#2).
//
// It is RED by design: `src/repo_index.ts` does not exist yet. `beforeAll` fails to import it, so
// every case below errors for exactly one reason — the enforcement it demands is unbuilt. An
// implementation gig turns it green by writing a compiler that satisfies these laws.
import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";

// The compiled index — MECHANICAL structure only. There is deliberately no `claims` / `unknowns`
// / `frame` field on it: judgment is not the compiler's to produce (I12, C3).
interface ImporterEdge { from: string; to: string; symbol: string }
interface ModuleTest { module: string; test: string }
interface EntryPoint { module: string; symbol: string }
interface RepositoryIndex {
  source_revision: string;
  files_to_exports: Record<string, string[]>;
  file_importers: ImporterEdge[];
  module_tests: ModuleTest[];
  entry_points: EntryPoint[];
  conventions_observed: string[];
  boundary: string[];
}
type RepoFile = { path: string; content: string };

// Bound to the real module in beforeAll. `any` until it exists — the point is that it does not.
let C: {
  compileRepositoryIndex: (files: RepoFile[], opts: { source_revision: string }) => RepositoryIndex;
  reconcileMechanical: (compiled: RepositoryIndex, modelReading: Pick<RepositoryIndex, "file_importers">) => RepositoryIndex;
  RepoIndexError: new (m?: string) => Error;
};

beforeAll(async () => {
  // RED: no such module yet. This throw is the whole point — every test below is unreachable
  // until a deterministic compiler exists on disk.
  C = (await import("../src/repo_index.js")) as unknown as typeof C;
});

// ── A synthetic repository, generated — the input space the laws quantify over ──────────────────
type ModSpec = { id: number; exports: string[] };
type ImpSpec = { from: number; to: number; symbol: string };
type RepoSpec = { modules: ModSpec[]; imports: ImpSpec[]; tests: number[] };

const REV = "rev-fixed";
const nameDefault = (id: number) => `m${id}`;
const modPath = (id: number, nameOf = nameDefault) => `src/${nameOf(id)}.ts`;
const testPath = (id: number) => `tests/m${id}.test.ts`;
const edgeKey = (e: ImporterEdge) => `${e.from}|${e.to}|${e.symbol}`;
const mtKey = (m: ModuleTest) => `${m.module}|${m.test}`;

/** Render a spec to real source files. `nameOf` lets a rename move a module's on-disk name. */
function render(spec: RepoSpec, nameOf = nameDefault): RepoFile[] {
  const files: RepoFile[] = [];
  for (const m of spec.modules) {
    const imports = spec.imports.filter((e) => e.from === m.id);
    const importLines = imports.map((e) => `import { ${e.symbol} } from "./${nameOf(e.to)}.js";`);
    const exportLines = m.exports.map((s) => `export function ${s}() { return 0; }`);
    files.push({ path: modPath(m.id, nameOf), content: [...importLines, ...exportLines].join("\n") + "\n" });
  }
  for (const t of spec.tests) {
    const target = spec.modules.find((m) => m.id === t)!;
    const sym = target.exports[0]!;
    files.push({ path: testPath(t), content: `import { ${sym} } from "../src/${nameOf(t)}.js";\ntest("${sym}", () => { ${sym}(); });\n` });
  }
  return files;
}

const expectedEdges = (spec: RepoSpec, nameOf = nameDefault): ImporterEdge[] =>
  spec.imports.map((e) => ({ from: modPath(e.from, nameOf), to: modPath(e.to, nameOf), symbol: e.symbol }));

const expectedTests = (spec: RepoSpec, nameOf = nameDefault): ModuleTest[] =>
  spec.tests.map((t) => ({ module: modPath(t, nameOf), test: testPath(t) }));

/** A generator of coherent synthetic repos: modules with unique exports, acyclic import edges that
 *  each name a REAL export of a lower-id module, and a subset of modules carrying a test file. */
const specArb: fc.Arbitrary<RepoSpec> = fc.integer({ min: 1, max: 5 }).chain((n) =>
  fc
    .record({
      exportCounts: fc.array(fc.integer({ min: 1, max: 2 }), { minLength: n, maxLength: n }),
      rawEdges: fc.array(
        fc.record({ a: fc.integer({ min: 0, max: n - 1 }), b: fc.integer({ min: 0, max: n - 1 }), sym: fc.integer({ min: 0, max: 1 }) }),
        { maxLength: n * 2 },
      ),
      tests: fc.subarray([...Array(n).keys()]),
    })
    .map(({ exportCounts, rawEdges, tests }) => {
      const modules: ModSpec[] = exportCounts.map((c, id) => ({ id, exports: Array.from({ length: c }, (_, k) => `f${id}_${k}`) }));
      const seen = new Set<string>();
      const imports: ImpSpec[] = [];
      for (const e of rawEdges) {
        const from = Math.max(e.a, e.b);
        const to = Math.min(e.a, e.b);
        if (from === to) continue; // no self-import; acyclic because to < from
        const target = modules[to]!;
        const symbol = target.exports[e.sym % target.exports.length]!;
        const key = `${from}->${to}:${symbol}`;
        if (seen.has(key)) continue; // an import of the same symbol twice is ONE edge
        seen.add(key);
        imports.push({ from, to, symbol });
      }
      return { modules, imports, tests };
    }),
);

const compile = (files: RepoFile[]): RepositoryIndex => C.compileRepositoryIndex(files, { source_revision: REV });

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Property laws — universal over all repositories (I1–I4)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("repo-index compiler — the importer/export laws hold over every repository", () => {
  it("I1 every file→importers edge is the exact inverse of a real export-consumption", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const idx = compile(render(spec));
        const got = new Set(idx.file_importers.map(edgeKey));
        const want = new Set(expectedEdges(spec).map(edgeKey));
        // Round-trip: the importer relation is EXACTLY the set of (from, to, symbol) where `from`
        // imports `symbol` and `symbol` is a real export of `to`. No missing, no invented edge.
        expect(got).toEqual(want);
      }),
    );
  });

  it("I2 no dangling edges — every endpoint of every edge resolves to a real source file", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const files = render(spec);
        const paths = new Set(files.map((f) => f.path));
        const idx = compile(files);
        for (const e of idx.file_importers) {
          expect(paths.has(e.from), `importer endpoint ${e.from}`).toBe(true);
          expect(paths.has(e.to), `imported endpoint ${e.to}`).toBe(true);
        }
        for (const m of Object.keys(idx.files_to_exports)) expect(paths.has(m), `export owner ${m}`).toBe(true);
        for (const mt of idx.module_tests) {
          expect(paths.has(mt.module), `tested module ${mt.module}`).toBe(true);
          expect(paths.has(mt.test), `test file ${mt.test}`).toBe(true);
        }
      }),
    );
  });

  it("I3 entry_points is a subset of the module's declared exports — never an invented symbol", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const idx = compile(render(spec));
        for (const ep of idx.entry_points) {
          const declared = idx.files_to_exports[ep.module] ?? [];
          expect(declared.includes(ep.symbol), `entry_point ${ep.module}#${ep.symbol} must be a declared export`).toBe(true);
        }
      }),
    );
  });

  it("I4 module→tests soundness — every entry names a test file that references the module", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const idx = compile(render(spec));
        const got = new Set(idx.module_tests.map(mtKey));
        const want = new Set(expectedTests(spec).map(mtKey));
        expect(got).toEqual(want);
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Metamorphic relations — a transformed source and its index (I5–I8). No absolute oracle needed.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("repo-index compiler — metamorphic laws relate a source change to an index delta", () => {
  it("I5 determinism — permuting file order on disk leaves the index byte-identical", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const files = render(spec);
        const a = compile(files);
        const b = compile([...files].reverse());
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }),
    );
  });

  it("I6 add-one-import locality — adding one import yields exactly one new importer edge, nothing else", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        // find a (from,to,symbol) that is a legal NON-edge to add
        let add: ImpSpec | undefined;
        outer: for (const from of spec.modules) {
          for (const to of spec.modules) {
            if (to.id >= from.id) continue; // keep acyclic
            for (const symbol of to.exports) {
              if (!spec.imports.some((e) => e.from === from.id && e.to === to.id && e.symbol === symbol)) {
                add = { from: from.id, to: to.id, symbol };
                break outer;
              }
            }
          }
        }
        fc.pre(add !== undefined);
        const before = compile(render(spec));
        const after = compile(render({ ...spec, imports: [...spec.imports, add!] }));
        const newEdge: ImporterEdge = { from: modPath(add!.from), to: modPath(add!.to), symbol: add!.symbol };
        const expected = new Set([...before.file_importers.map(edgeKey), edgeKey(newEdge)]);
        expect(new Set(after.file_importers.map(edgeKey))).toEqual(expected);
        // and nothing else moved
        expect(after.files_to_exports).toEqual(before.files_to_exports);
        expect(new Set(after.module_tests.map(mtKey))).toEqual(new Set(before.module_tests.map(mtKey)));
      }),
    );
  });

  it("I7 rename completeness — renaming a module rewrites all-and-only the edges that referenced it", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const k = 0; // module 0 is a pure import TARGET (nothing imports above-id modules into it)
        const newName = (id: number) => (id === k ? `renamed${id}` : nameDefault(id));
        const before = compile(render(spec));
        const after = compile(render(spec, newName));
        const oldPath = modPath(k);
        const newPath = modPath(k, newName);
        const remap = (p: string) => (p === oldPath ? newPath : p);
        const projected: RepositoryIndex = {
          source_revision: before.source_revision,
          files_to_exports: Object.fromEntries(Object.entries(before.files_to_exports).map(([p, ex]) => [remap(p), ex])),
          file_importers: before.file_importers.map((e) => ({ from: remap(e.from), to: remap(e.to), symbol: e.symbol })),
          module_tests: before.module_tests.map((m) => ({ module: remap(m.module), test: m.test })),
          entry_points: before.entry_points.map((e) => ({ module: remap(e.module), symbol: e.symbol })),
          conventions_observed: before.conventions_observed,
          boundary: before.boundary,
        };
        const canon = (i: RepositoryIndex) => ({
          f2e: Object.fromEntries(Object.entries(i.files_to_exports).map(([p, ex]) => [p, [...ex].sort()])),
          imp: [...i.file_importers.map(edgeKey)].sort(),
          mt: [...i.module_tests.map(mtKey)].sort(),
          ep: [...i.entry_points.map((e) => `${e.module}#${e.symbol}`)].sort(),
        });
        expect(canon(after)).toEqual(canon(projected));
      }),
    );
  });

  it("I8 delete-test locality — deleting a test drops exactly its module→tests entries and nothing else", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        fc.pre(spec.tests.length > 0);
        const t = spec.tests[0]!;
        const files = render(spec);
        const before = compile(files);
        const after = compile(files.filter((f) => f.path !== testPath(t)));
        const droppedModule = modPath(t);
        const expected = new Set(before.module_tests.filter((m) => m.test !== testPath(t)).map(mtKey));
        expect(new Set(after.module_tests.map(mtKey))).toEqual(expected);
        // the deleted test named `droppedModule` — assert only ITS entry is gone, exports untouched
        expect(after.files_to_exports).toEqual(before.files_to_exports);
        expect(new Set(after.file_importers.map(edgeKey))).toEqual(new Set(before.file_importers.map(edgeKey)));
        void droppedModule;
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The compiler is mechanical-only, authoritative, and fails closed (I12, I15, I18)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("repo-index compiler — mechanical only, oracle on divergence, fail-closed", () => {
  const fixture: RepoSpec = {
    modules: [
      { id: 0, exports: ["alpha", "beta"] },
      { id: 1, exports: ["gamma"] },
    ],
    imports: [{ from: 1, to: 0, symbol: "alpha" }],
    tests: [0],
  };

  it("I12 the compiler NEVER populates a judgment field — no claims, unknowns, or frame", () => {
    const idx = compile(render(fixture)) as unknown as Record<string, unknown>;
    // The deterministic producer emits MECHANICAL structure only. Judgment stays with the reader
    // (C3, RIG paper's own exclusion of "semantic interpretation / subjective architectural
    // judgments"). A compiled index carrying any of these fields is a contract violation.
    expect("claims" in idx).toBe(false);
    expect("unknowns" in idx).toBe(false);
    expect("frame" in idx).toBe(false);
  });

  it("I15 on divergence with a model reading, the compiler value is authoritative", () => {
    const idx = compile(render(fixture));
    // A model reading hallucinates an importer edge that does NOT exist in source.
    const hallucinated: ImporterEdge = { from: modPath(0), to: modPath(1), symbol: "gamma" };
    const modelReading = { file_importers: [...idx.file_importers, hallucinated] };
    const reconciled = C.reconcileMechanical(idx, modelReading);
    // The reconciled mechanical fields are the COMPILER's — the hallucinated edge is dropped.
    expect(new Set(reconciled.file_importers.map(edgeKey))).toEqual(new Set(idx.file_importers.map(edgeKey)));
    expect(reconciled.file_importers.map(edgeKey)).not.toContain(edgeKey(hallucinated));
  });

  it("I18 the compiler fails closed — an unresolvable import refuses, never a partial index", () => {
    // A file importing a module that does not exist cannot yield a complete, dangling-free index.
    // The compiler must REFUSE (RepoIndexError), not silently emit a partial index (F5/O4/O18).
    const broken: RepoFile[] = [{ path: "src/m0.ts", content: `import { ghost } from "./nope.js";\nexport function a() {}\n` }];
    expect(() => compile(broken)).toThrow(C.RepoIndexError);
  });
});
