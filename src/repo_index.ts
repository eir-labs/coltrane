// The deterministic producer for a change-context's MECHANICAL fields.
//
// The reading seat (agent john, software-change-pr-v1) spends most of a 24 tool-call cap
// RE-DERIVING repository structure every run -- the import graph, the module-to-tests index, the
// exported symbols and their entry points. This module COMPILES those facts from source, so the
// mechanical half of a reading is a build artifact rather than a thing a model re-establishes by
// hand (and mis-establishes: three hand-rolled structural sweeps this week each needed correction,
// and a guessed invocation surface once survived into sealed tests).
//
// The prohibition that gives it its shape (#424 I12/I13): this compiler emits STRUCTURE ONLY. It
// never populates `claims`, `unknowns` or `frame` -- noticing is the reader's office, not the
// index's. The absence is enforced structurally: `RepositoryIndex` has no field for any of the
// three, so a compiled index carrying one would not type-check. A fast index that notices nothing
// is the POINT: it buys the reader's turns back for the judgment half a model is actually needed
// for.
//
// Everything here is pure and deterministic: the same file set in any order compiles to a
// byte-identical index (every field is canonicalised -- keys and arrays sorted -- before return).
// The compiler fails CLOSED: an import that resolves to no file in the input set refuses with a
// RepoIndexError rather than emitting a partial, dangling index.

/** One import edge: `from` imports `symbol`, which is a real export of `to`. */
export interface ImporterEdge {
  from: string;
  to: string;
  symbol: string;
}

/** One module-to-test link: `test` references `module`. */
export interface ModuleTest {
  module: string;
  test: string;
}

/** One entry point: `symbol` is an export of `module` that no other module imports. */
export interface EntryPoint {
  module: string;
  symbol: string;
}

/**
 * The compiled index -- MECHANICAL structure only. There is deliberately no `claims` / `unknowns`
 * / `frame` field: judgment is not the compiler's to produce (I12). The absence is a compile-time
 * property of this type, not a runtime filter -- nothing can put a judgment field here.
 */
export interface RepositoryIndex {
  source_revision: string;
  files_to_exports: Record<string, string[]>;
  file_importers: ImporterEdge[];
  module_tests: ModuleTest[];
  entry_points: EntryPoint[];
  conventions_observed: string[];
  boundary: string[];
}

/** A file in the input set: its repo-relative path and its raw source text. */
export type RepoFile = { path: string; content: string };

/**
 * The compiler refuses rather than emitting a partial index. Thrown when a relative import
 * specifier resolves to no file in the input set -- a dangling edge is not representable, so the
 * whole index is withheld (I18, fail-closed).
 */
export class RepoIndexError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "RepoIndexError";
    // Restore the prototype chain under ES5-target transpilation so `instanceof` holds.
    Object.setPrototypeOf(this, RepoIndexError.prototype);
  }
}

// -- source classification -----------------------------------------------------------------------
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const isTestFile = (path: string): boolean => TEST_FILE.test(path);

// -- a small POSIX path resolver (the tree is described in POSIX paths, no fs access) ------------
/** Resolve a relative specifier against the importing file's directory, POSIX-style. */
function resolveRelative(fromPath: string, spec: string): string {
  const slash = fromPath.lastIndexOf("/");
  const fromDir = slash >= 0 ? fromPath.slice(0, slash) : "";
  const parts = (fromDir ? fromDir.split("/") : []).concat(spec.split("/"));
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      stack.pop();
      continue;
    }
    stack.push(p);
  }
  return stack.join("/");
}

/**
 * Map a resolved `.js`-style specifier target to the real source file in the set (the ESM/bundler
 * convention: source is `.ts`, the specifier names the emitted `.js`). Returns the matched path,
 * or undefined when nothing in the set answers it.
 */
function resolveModule(resolvedTarget: string, fileSet: ReadonlySet<string>): string | undefined {
  const base = resolvedTarget.replace(/\.[cm]?jsx?$/, "");
  const candidates = [
    base + ".ts",
    base + ".tsx",
    base + ".mts",
    base + ".cts",
    resolvedTarget,
    base + "/index.ts",
    base + "/index.tsx",
  ];
  for (const c of candidates) {
    if (fileSet.has(c)) return c;
  }
  return undefined;
}

// -- structural parse of the fixed import/export grammar -----------------------------------------
type ParsedImport = { spec: string; symbols: string[] };

/**
 * Extract the named-import bindings and their module specifier from a source text. Only named
 * imports carry the symbols an importer edge names; `import Default from` and `import * as ns`
 * bring in no named export and are recorded with an empty symbol list (so resolution/fail-closed
 * still runs on their specifier). Bare (non-relative) specifiers are left to the caller to skip.
 */
function parseImports(content: string): ParsedImport[] {
  const out: ParsedImport[] = [];
  // `import [type] [ ... ] from "spec"` -- the binding clause is optional (side-effect imports).
  const re = /import\s+(?:type\s+)?([^;'"]*?\s+from\s+)?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const clause = m[1] ?? "";
    const spec = m[2]!;
    const braces = /\{([^}]*)\}/.exec(clause);
    const symbols: string[] = [];
    if (braces) {
      for (const raw of braces[1]!.split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
        // The edge names the target's EXPORTED symbol -- the left side of `orig as local`.
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) symbols.push(name);
      }
    }
    out.push({ spec, symbols });
  }
  return out;
}

/** Extract the exported symbol names declared in a source text. */
function parseExports(content: string): string[] {
  const names = new Set<string>();
  const push = (re: RegExp) => {
    let m: RegExpExecArray | null;
    const g = new RegExp(re.source, "g");
    while ((m = g.exec(content)) !== null) if (m[1]) names.add(m[1]);
  };
  // export [async] function NAME / export [abstract] class NAME / export const|let|var NAME /
  // export type|interface|enum NAME
  push(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/);
  push(/export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
  push(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  push(/export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/);
  // export { a, b as c } -- the exported name is the right side of `as`, else the bare name.
  let mm: RegExpExecArray | null;
  const named = /export\s*(?:type\s*)?\{([^}]*)\}(?!\s*from)/g;
  while ((mm = named.exec(content)) !== null) {
    for (const raw of mm[1]!.split(",")) {
      const parts = raw.trim().split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0])?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

const isRelative = (spec: string): boolean => spec.startsWith("./") || spec.startsWith("../");
const edgeKey = (e: ImporterEdge): string => `${e.from} ${e.to} ${e.symbol}`;
const mtKey = (m: ModuleTest): string => `${m.module} ${m.test}`;
const epKey = (e: EntryPoint): string => `${e.module} ${e.symbol}`;

/**
 * Compile a repository index from source. Deterministic: the returned index is byte-identical
 * under any permutation of `files`. Fails closed: a relative import that resolves to no file in
 * the set throws RepoIndexError rather than yielding a partial, dangling index.
 */
export function compileRepositoryIndex(
  files: RepoFile[],
  opts: { source_revision: string },
): RepositoryIndex {
  const fileSet = new Set(files.map((f) => f.path));

  // Resolve a relative specifier or FAIL CLOSED -- every endpoint of every edge must be a real file.
  const resolveOrThrow = (fromPath: string, spec: string): string => {
    const target = resolveModule(resolveRelative(fromPath, spec), fileSet);
    if (target === undefined) {
      throw new RepoIndexError(
        `unresolvable import in ${fromPath}: "${spec}" resolves to no file in the input set -- refusing a partial, dangling index`,
      );
    }
    return target;
  };

  const filesToExports: Record<string, string[]> = {};
  const edges = new Map<string, ImporterEdge>();
  const moduleTests = new Map<string, ModuleTest>();
  const jsExtImport = { seen: false };
  const colocatedTests = { seen: false };

  for (const f of files) {
    const imports = parseImports(f.content);
    for (const imp of imports) {
      if (!isRelative(imp.spec)) continue; // external/bare specifier -- not an in-tree edge
      if (/\.[cm]?jsx?$/.test(imp.spec)) jsExtImport.seen = true;
      const target = resolveOrThrow(f.path, imp.spec);
      if (isTestFile(f.path)) {
        // A test file's imports feed the module-to-tests index, never the importer graph.
        if (!isTestFile(target)) {
          const mt: ModuleTest = { module: target, test: f.path };
          moduleTests.set(mtKey(mt), mt);
          colocatedTests.seen = true;
        }
      } else {
        // A source file's named imports are importer edges -- one per named symbol.
        for (const symbol of imp.symbols) {
          const e: ImporterEdge = { from: f.path, to: target, symbol };
          edges.set(edgeKey(e), e);
        }
      }
    }

    if (!isTestFile(f.path)) {
      filesToExports[f.path] = parseExports(f.content);
    }
  }

  // entry_points = exported symbols no OTHER module imports (roots of symbol consumption). A
  // symbol reached only from a test file still counts as an entry point -- tests are not consumers
  // in the import graph.
  const importedSymbols = new Set<string>();
  for (const e of edges.values()) importedSymbols.add(`${e.to} ${e.symbol}`);
  const entryPoints: EntryPoint[] = [];
  for (const [module, exports] of Object.entries(filesToExports)) {
    for (const symbol of exports) {
      if (!importedSymbols.has(`${module} ${symbol}`)) entryPoints.push({ module, symbol });
    }
  }

  const conventions: string[] = [];
  if (jsExtImport.seen) conventions.push("esm-js-extension-import-specifiers");
  if (colocatedTests.seen) conventions.push("tests-reference-source-by-relative-import");

  // -- canonicalise every field: sorted keys, sorted arrays -- so JSON.stringify is order-stable --
  const canonExports: Record<string, string[]> = {};
  for (const path of Object.keys(filesToExports).sort()) {
    canonExports[path] = [...filesToExports[path]!].sort();
  }

  return {
    source_revision: opts.source_revision,
    files_to_exports: canonExports,
    file_importers: [...edges.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
    module_tests: [...moduleTests.values()].sort((a, b) => mtKey(a).localeCompare(mtKey(b))),
    entry_points: entryPoints.sort((a, b) => epKey(a).localeCompare(epKey(b))),
    conventions_observed: conventions.sort(),
    boundary: [...fileSet].sort(),
  };
}

/**
 * Reconcile a compiled index against a model's claimed reading of the SAME mechanical fields. The
 * compiler is authoritative: on any divergence the compiled value wins, so a model-hallucinated
 * edge is dropped (I15). The model reading is offered for comparison only -- it never adds to the
 * mechanical structure.
 */
export function reconcileMechanical(
  compiled: RepositoryIndex,
  _modelReading: Pick<RepositoryIndex, "file_importers">,
): RepositoryIndex {
  void _modelReading; // authoritative-compiler contract: the model's mechanical claims do not win
  return {
    ...compiled,
    file_importers: [...compiled.file_importers],
  };
}
