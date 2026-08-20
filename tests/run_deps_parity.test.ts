// RUN-DEPS PARITY — the drain must not be the unenforced path.
//
// RED-first, and deliberately red on merge: this test does not propose a fix. It makes an existing
// gap executable so that whatever fix lands can be checked, and so that the gap cannot widen further
// while nobody is looking.
//
// `runGig` takes its dependencies as a bag of OPTIONALS, and every absence has a benign-looking
// back-compat default:
//
//   deps.budget        absent -> "Budget state. When deps.budget is undefined, enforcement is OFF
//                                 (back-compat)."                        runtime.ts
//   deps.toolProviders absent -> grant resolution disabled; a dead name is passed through to the
//                                spawn instead of failing closed         claude_invoker.ts
//   deps.signal        absent -> no abort wiring; nothing can stop the run between phases
//
// Each default is individually defensible. Collectively they mean the path that runs UNTRUSTED
// QUEUED WORK on a shared machine — `coltrane work`, the drain — is the one running without a spend
// ceiling, without grant resolution, and without an abort. The demo path (`coltrane dispatch`, via
// bootstrapServerDeps) has all three.
//
// This is a text-level test over the two call sites, which is crude and is the point: it needs no
// runtime, cannot be satisfied by a plausible-looking refactor that quietly drops a wire, and would
// have caught all nine. If the two call sites are ever replaced by ONE shared assembly — the fix I
// would argue for — this test should be re-pointed at that assembly rather than deleted, because
// what it pins is the invariant, not the duplication.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** Extract the top-level keys of the object literal passed as `runGig`'s third argument.
 *  Brace-matched from the call site rather than regex-per-line, so a nested option object
 *  (`budget: { opening, k }`) contributes `budget` once and none of its inner names. */
function runGigDepKeys(relPath: string): Set<string> {
  const src = readFileSync(join(REPO, relPath), "utf8");
  // RE-POINTED, as this file's own header instructed: "If the two call sites are ever replaced by ONE
  // shared assembly — the fix I would argue for — this test should be re-pointed at that assembly
  // rather than deleted, because what it pins is the invariant, not the duplication."
  //
  // That day came (SPEC-one-chain-two-doors). The wires are assembled once in assembleRunDeps() and
  // every door obtains its deps from it, so the enforcement-bearing keys are no longer text at the
  // call sites — they are text in the assembler. The invariant is unchanged and is now pinned in the
  // one place it can be dropped from; a door that hand-rolled a literal again would fail
  // ASSEMBLER-SOURCED below.
  // UNION of both halves. A door's deps are now assembleRunDeps({…}) plus whatever is genuinely
  // door-specific alongside it — `signal` is each door's own AbortController and cannot come from a
  // shared assembler. The invariant this file pins is that the wire REACHES the path, not which half
  // supplies it, so both are read and merged.
  // Read the deps that come OUT of the assembler, not the arguments passed IN. A first attempt at
  // this re-point read the call sites' argument lists and was VACUOUS: deleting
  // `toolProviders: args.toolProviders` from the assembler's RETURN left every law green, because the
  // argument was still being passed at the call site while the wire was dropped on the floor. What
  // runGig receives is the assembler's return object; that is the thing this file has always pinned.
  const assembled = relPath.endsWith("run_deps.ts")
    ? []
    : extractAssemblerReturnKeys();
  // Anchor on runGig( ONLY. Its object literal is `...assembleRunDeps({…})` plus the door-specific
  // siblings, and the brace-flattening below reduces the nested assembler ARGUMENTS to `0` — which is
  // what we want: the arguments a door passes IN are not evidence that the wire comes OUT. A second
  // attempt at this re-point unioned the call site's argument list in and was still VACUOUS for that
  // exact reason. What survives here is the door-specific siblings; the shared wires come from the
  // assembler's RETURN via `assembled` above.
  const anchors = ["runGig("].filter((an) => src.includes(an));
  expect(anchors.length, `${relPath} must contain a runGig( or assembleRunDeps( call site`).toBeGreaterThan(0);
  const keysFrom = (start: number): Set<string> => extractKeysAt(src, start);
  const merged = new Set<string>(assembled);
  for (const an of anchors) for (const k of keysFrom(src.indexOf(an))) merged.add(k);
  return merged;
}

/** The keys assembleRunDeps() actually RETURNS — the deps runGig receives, whatever the doors passed
 *  in. Dropping a wire here is exactly the regression this file exists to catch. */
function extractAssemblerReturnKeys(): string[] {
  const src = readFileSync(join(REPO, "src/run_deps.ts"), "utf8");
  const fn = src.indexOf("export function assembleRunDeps");
  expect(fn, "src/run_deps.ts must export assembleRunDeps").toBeGreaterThan(-1);
  const ret = src.indexOf("return {", fn);
  expect(ret, "assembleRunDeps must return an object literal").toBeGreaterThan(-1);
  return [...extractKeysAt(src, ret)];
}

/** Brace-matched key extraction from the object literal beginning at the first `{` after `from`. */
function extractKeysAt(src: string, from: number): Set<string> {
  const call = from;
  if (call < 0) return new Set();
  // third argument starts at the first `{` after the second comma at depth 0 of the arg list
  let i = src.indexOf("{", call);
  let depth = 0;
  let body = "";
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
    if (depth === 1 && ch !== "{") body += ch;
  }
  // Flatten nested literals so only depth-1 names survive, then take `name:` and shorthand `name,`.
  let flat = body;
  for (let pass = 0; pass < 8; pass++) flat = flat.replace(/\{[^{}]*\}/g, "0");
  flat = flat.replace(/\/\/[^\n]*/g, "");
  const keys = new Set<string>();
  for (const m of flat.matchAll(/(?:^|[,\n])\s*([A-Za-z_]\w*)\s*[:,\n]/g)) keys.add(m[1]!);
  // THIS RECOVERY COULD NEVER FIRE, and is removed rather than left looking like coverage. It claimed
  // to recover names from `...(cond ? { resume_from: x } : {})` spreads by matching `{` in `body` —
  // but `body` is built with `ch !== "{"` and therefore never contains a brace. A mechanism that
  // cannot match, inside the check written to catch mechanisms that cannot fire.
  //
  // Nothing is lost by deleting it: what it purported to recover, the ENFORCEMENT_BEARING and
  // FIDELITY_BEARING wires, now comes from the assembler's RETURN via extractAssemblerReturnKeys(),
  // which reads them at depth 1 where they actually are.
  return keys;
}

/** Dependencies whose ABSENCE silently disables a control. These must be present on every path that
 *  runs a gig, whatever else differs between call sites. */
const ENFORCEMENT_BEARING = [
  "budget", // absent => spend enforcement OFF, on the paid path
  "toolProviders", // absent => grant resolution off; dead names reach the spawn
  "mcpServerConfigs", // absent => same, and the engine MCP surface is not wired
  "signal", // absent => no abort; a runaway cannot be stopped between phases
] as const;

/** Dependencies whose absence degrades fidelity rather than enforcement. Separated because the
 *  argument for each is weaker and a fix might reasonably land in two steps. */
const FIDELITY_BEARING = ["model_version", "skill_dirs", "evals"] as const;

/** Legitimately path-specific — the drain resumes from checkpoints, the server reports progress.
 *  Listed so the parity check below is a statement about enforcement, not about symmetry. */
const PATH_SPECIFIC = new Set(["checkpoints", "resume_from", "onProgress", "depth", "reuse", "human"]);

describe("run-deps parity — the drain must not be the unenforced path", () => {
  const server = runGigDepKeys("src/server.ts");
  const drain = runGigDepKeys("src/worker.ts");

  it("both call sites were parsed (guard against a silently-empty comparison)", () => {
    // Without this, a parser that returned {} would make every assertion below pass vacuously —
    // the exact failure mode this whole test exists to catch, one level up.
    expect(server.size, "server call site parsed no keys — the extractor broke").toBeGreaterThan(6);
    expect(drain.size, "drain call site parsed no keys — the extractor broke").toBeGreaterThan(3);
    expect(server.has("outputs") && drain.has("outputs")).toBe(true);
    expect(server.has("invoke") && drain.has("invoke")).toBe(true);
  });

  it.each(ENFORCEMENT_BEARING)(
    "the drain passes `%s` — its absence disables a control, silently",
    (key) => {
      expect(
        drain.has(key),
        `worker.ts does not pass \`${key}\` to runGig. The server path does. Absent, this control ` +
          `is off for every drained gig — the path that runs untrusted queued work on a shared machine.`,
      ).toBe(true);
    },
  );

  it.each(FIDELITY_BEARING)("the drain passes `%s` — a drained gig records as much as a dispatched one", (key) => {
    expect(
      drain.has(key),
      `worker.ts does not pass \`${key}\`, so a drained gig's run is less faithful than a dispatched ` +
        `one for no stated reason.`,
    ).toBe(true);
  });

  it("no server dependency is missing from the drain except the path-specific ones", () => {
    const missing = [...server].filter((k) => !drain.has(k) && !PATH_SPECIFIC.has(k)).sort();
    expect(
      missing,
      `these dependencies exist on the server path and not on the drain. Each is a control or a ` +
        `record the production path does without. If one of them is genuinely path-specific, add it ` +
        `to PATH_SPECIFIC with the reason — do not delete this assertion.`,
    ).toEqual([]);
  });
});
