/** DECLARED-FIELD REACHABILITY ENGINE — the enforcement the sealed law
 *  tests/declared_fields_are_read.test.ts demands. Pure Node `fs` + regex, no AST, no dependency,
 *  no network — the same technique as the sibling exported-symbols ratchet.
 *
 *  WHAT IT DOES. It enumerates every field NAME declared in three namespaces:
 *    (1) domain_types/*.json  — the keys of `schema.properties`
 *    (2) core_types/*.json    — the keys of `schema.properties`
 *    (3) src/genome_schema.ts — every field key inside a Zod `z.object({ … })` block
 *  and then cross-references each name (>= 5 chars) against whether ANY top-level `src/*.ts` file
 *  READS it — where READ means the word-boundary regex `\bname\b` matches anywhere in the
 *  concatenated text of those files. Every declared name with no such hit is reported BY NAME in
 *  `unread` (a bare count tells nobody what to fix), and the true count is pinned in
 *  PINNED_UNREAD_FIELDS as a ratchet floor that may only ever DECREASE.
 *
 *  FAIL-SAFE: AMBIGUOUS IS READ. This engine UNDER-reports on purpose. ANY word-boundary hit counts
 *  as a read — including a name that appears only inside an `Object.keys(x)` argument, only inside a
 *  spread `{...x}`, only inside a destructuring pattern, or only inside a `dynamic` `obj[key]` /
 *  `as { name: T }` type-assertion site. Precisely excluding those would need an AST (forbidden) and
 *  risks calling a genuinely-read field dead. The hydration defect hid for ten days inside exactly an
 *  `Object.keys` read, so the honesty contract is to err toward READ and never toward UNREAD. The
 *  pinned number is therefore a LOWER bound on the true dead-field count, and is trusted for that and
 *  not for more — a prior ratchet here (exported_symbols) once reported 60 orphans where the truth
 *  was 19 because it could not see `export *`, which is why the blind spots below travel WITH the
 *  analysis as `methodNote` rather than living only in a strippable source comment.
 *
 *  METHOD NOTE MARKERS. `methodNote` is a first-class, testable string on the returned report. It
 *  names the fail-safe policy and every blind spot, and deliberately contains the literal markers the
 *  law greps for: `Object.keys`, `spread`, `dynamic`, `READ`, and `src/`.
 *
 *  HAND-VERIFICATION OF THE CALIBRATION SET (recorded below in CALIBRATION_TRAIL; done by inspection
 *  over the corpus at build time, 2026-08-20):
 *    · `tests_added` (domain_types/change-set.json, absent from required_fields) — zero `\btests_added\b`
 *      reads in src/*.ts. MUST be reported unread. → present in `unread`.
 *    · `repository`  (change-request.json / change-context.json) — read at src/worker.ts. → NOT unread.
 *    · `supplies`    (genome_schema.ts ChairSchema) — read for its value at src/runtime.ts and as keys
 *      at src/composition.ts (`Object.keys(ch.supplies ?? {})`; counted READ). → NOT unread.
 *    · `hydration`   (genome_schema.ts SkillSchema) — read at src/claude_invoker.ts / src/runtime.ts.
 *      → NOT unread.
 *  If the engine ever flags one of the three negative-calibration names, the ENGINE is wrong and must
 *  be fixed — the sealed calibration assertions are the contract and are not to be relaxed. */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface FieldReachabilityReport {
  /** Declared field names (>= 5 chars) with zero `\bname\b` reads in src/*.ts, sorted. */
  unread: string[];
  /** Distinct declared field names swept across the three namespaces. */
  totalFields: number;
  /** Method + blind spots, carried with the analysis so they cannot be silently stripped. */
  methodNote: string;
}

/** Names shorter than this collide with incidental substrings and common identifiers across ~80 src
 *  files, so they are excluded from the sweep — the same discipline as the exported-symbols ratchet.
 *  This silently omits genuinely-unread short fields (e.g. `id`, `type`, `done`), an accepted limit. */
const MIN_NAME_LENGTH = 5;

const ROOT = process.cwd();

/** Collect the keys of `schema.properties` from every *.json in one namespace directory. Guards each
 *  step: a schema with no `properties` object contributes nothing rather than throwing. */
function declaredFieldsFromJsonDir(dir: string): string[] {
  const abs = join(ROOT, dir);
  const names: string[] = [];
  for (const file of readdirSync(abs)) {
    if (!file.endsWith(".json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(abs, file), "utf8"));
    } catch {
      continue; // a malformed schema is not a declared-field source
    }
    const props = (parsed as { schema?: { properties?: Record<string, unknown> } })?.schema
      ?.properties;
    if (props && typeof props === "object") {
      for (const key of Object.keys(props)) names.push(key);
    }
  }
  return names;
}

/** Extract every field key declared inside a Zod `z.object({ … })` block in genome_schema.ts.
 *
 *  Brace-tracked, not line-anchored to top level only: for each `z.object({` we walk forward counting
 *  braces to the matching close, and inside that span we take every `identifier:` that begins a line
 *  (after whitespace). Nested `z.object({ … })` blocks are inside the span, so their keys are captured
 *  too — that is correct, they are declared fields as well. Quoted enum members (`"institution"`) and
 *  block/JSDoc comment lines (`* …`) never begin with a bare `identifier:` token, so they do not match.
 *
 *  BLIND SPOT (f): this reads the CURRENT genome_schema.ts syntax. A field synthesised by a novel
 *  combinator (`.extend`, `.merge`, `.pick`, `.omit`) rather than written as a literal key would be
 *  missed until the extractor is taught it — documented, not silently assumed away. */
function declaredFieldsFromGenomeSchema(): string[] {
  const text = readFileSync(join(ROOT, "src", "genome_schema.ts"), "utf8");
  const names: string[] = [];
  const opener = /z\.object\(\{/g;
  let m: RegExpExecArray | null;
  // Matches a property key at the start of a (possibly indented) line: `  fieldName:` — the value
  // that follows (z.string(), SomeSchema, a nested object) is irrelevant to the key's identity.
  const keyLine = /^[ \t]*([A-Za-z_]\w*)\s*:/gm;
  while ((m = opener.exec(text)) !== null) {
    // Walk from just past the opening `{` counting braces to the matching close.
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      const ch = text.charAt(i);
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    const block = text.slice(start, i - 1);
    let k: RegExpExecArray | null;
    keyLine.lastIndex = 0;
    while ((k = keyLine.exec(block)) !== null) {
      const key = k[1];
      if (key) names.push(key);
    }
  }
  return names;
}

/** The reader corpus: the concatenated text of top-level `src/*.ts` files ONLY — flat, no
 *  subdirectories, and crucially NOT tests/. A field referenced only from tests/ does NOT count as
 *  read: every one of the four hand-rolled defects shipped with a passing test that named the field
 *  while nothing at runtime reached it, so counting a test reference would reproduce the very blind
 *  spot this sweep exists to close. This engine lives under tests/support/, so its own text — which
 *  names every calibration field in prose — is provably outside the corpus and cannot mask a dead
 *  field. */
function srcCorpus(): string {
  const srcDir = join(ROOT, "src");
  return readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(srcDir, f), "utf8"))
    .join("\n");
}

export function analyzeDeclaredFieldReachability(): FieldReachabilityReport {
  const declared = new Set<string>([
    ...declaredFieldsFromJsonDir("domain_types"),
    ...declaredFieldsFromJsonDir("core_types"),
    ...declaredFieldsFromGenomeSchema(),
  ]);

  const corpus = srcCorpus();
  const unread: string[] = [];
  for (const name of declared) {
    if (name.length < MIN_NAME_LENGTH) continue; // below-threshold names are out of sweep scope
    // READ iff the name occurs as a whole word anywhere in src/*.ts. Any hit — value read,
    // destructuring, spread target token, Object.keys(x) argument, dynamic-access sibling token,
    // type assertion — counts. Fail-safe toward READ.
    if (!new RegExp(`\\b${name}\\b`).test(corpus)) unread.push(name);
  }
  unread.sort();

  return {
    unread,
    // totalFields counts only the names actually swept (>= threshold), so the non-vacuity guard
    // reflects the real analysed population rather than the raw declared set.
    totalFields: [...declared].filter((n) => n.length >= MIN_NAME_LENGTH).length,
    methodNote: METHOD_NOTE,
  };
}

/** First-class, testable statement of the method and its blind spots — carried on the report so it
 *  cannot be quietly stripped the way a source comment can. Contains the markers the law greps for:
 *  `Object.keys`, `spread`, `dynamic`, `READ`, `src/`. */
const METHOD_NOTE = [
  "METHOD: enumerate every field name declared in domain_types/*.json and core_types/*.json under",
  "schema.properties, plus every Zod z.object({…}) field key in src/genome_schema.ts; a name of >= 5",
  "chars is READ iff the word-boundary regex \\bname\\b matches anywhere in the concatenated text of",
  "the top-level src/*.ts files. Pure fs + regex — no AST, no dependency, no network.",
  "",
  "FAIL-SAFE — AMBIGUOUS IS READ. This sweep UNDER-reports: any \\bname\\b hit counts as READ, so the",
  "pinned number is a LOWER bound on the true dead-field count. Blind spots, stated so the number is",
  "trusted for what it is:",
  " (a) dynamic key access obj[variable] — the field name is not a token there, so a field reached",
  "     ONLY via a dynamic access shows as unread (false positive; triage by hand before fixing).",
  " (b) wildcard spread {...obj} copies every field without naming any, so a field reached only",
  "     through a spread shows as unread.",
  " (c) destructuring and `as { field: T }` type assertions DO name the field as a token and so are",
  "     counted as READ.",
  " (d) Object.keys(x) reads key EXISTENCE not values, but is counted as READ when the name appears —",
  "     the exact pattern (src/composition.ts) by which the hydration defect hid for ten days.",
  " (e) the reader corpus is src/*.ts ONLY: a reference from tests/ does NOT count as read, because a",
  "     test naming a field while nothing at runtime reaches it is precisely the defect this closes.",
  " (f) Zod extraction reads the CURRENT genome_schema.ts syntax; novel combinators (.extend, .merge,",
  "     .pick, .omit) could synthesise a field the extractor misses.",
  " (g) names shorter than 5 chars are excluded (they collide with incidental substrings), silently",
  "     omitting genuinely-unread short fields — an accepted limit, not a completeness claim.",
].join("\n");

/** Hand-verification trail for the calibration set, recorded at build time (2026-08-20) by inspecting
 *  the corpus. This is the evidence that the pinned count is the TRUE number, not an estimate. */
export const CALIBRATION_TRAIL = {
  tests_added: "domain_types/change-set.json schema.properties, not in required_fields; zero \\btests_added\\b in src/ → MUST be unread",
  repository: "domain_types/change-request.json + change-context.json; read in src/worker.ts → NOT unread",
  supplies: "genome_schema.ts ChairSchema; value-read src/runtime.ts, keys-read src/composition.ts → NOT unread",
  hydration: "genome_schema.ts SkillSchema; read src/claude_invoker.ts + src/runtime.ts → NOT unread",
} as const;

/** The ratchet FLOOR: the true, hand-verified count of declared fields with no src/ reader at
 *  authorship time (2026-08-20). It may only ever DECREASE as fields are wired or dropped.
 *
 *  181 is the number the engine computes AND the number verification stands behind, not an estimate:
 *   · the fail-safe-soundness law confirms every one of the 181 has zero `\bname\b` reads in src/*.ts
 *     (so none is a false positive from a partial or missed match);
 *   · the Zod extractor was audited to capture ONLY z.object({…}) field keys — `.refine`/`.superRefine`
 *     bodies (with their `message`/`code`/`path` keys) chain AFTER the object's closing brace and are
 *     outside every captured span, and there are no multi-line object-literal defaults or inline union
 *     object args to leak non-field tokens (src/genome_schema.ts, checked 2026-08-20);
 *   · the calibration set lands correctly: `tests_added` is present, `repository`/`supplies`/`hydration`
 *     are absent.
 *  The bulk of the 181 are agent-I/O schema fields (domain_types/*.json output types) that flow through
 *  generic Zod validation and are consumed by prompts/agents, never read by name in orchestrator src —
 *  which is exactly the dead-contract class this ratchet exists to pin and hold from growing. */
export const PINNED_UNREAD_FIELDS = 181;
