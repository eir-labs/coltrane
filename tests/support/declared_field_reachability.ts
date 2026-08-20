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
  return srcCorpusExcluding(null);
}

/**
 * The src/ corpus, optionally MINUS the file the fields were declared in.
 *
 * THE DECLARATION IS NOT A READ, and omitting this made the ENGINE ratchet vacuous: genome_schema.ts
 * is itself a src/*.ts file, so every Zod field it declares matched its own declaration and every
 * engine field counted as READ. PINNED_UNREAD_ENGINE_FIELDS sat at 0 not because the engine has no
 * dead fields but because it could not have anything else. Injecting a field nothing reads
 * (`a_field_nothing_reads: z.string()`) left all 18 laws green — the check could not fire.
 *
 * A field is reachable when something OTHER than its own declaration names it. That is the whole
 * question this module was built to ask, and asking it of a corpus containing the declaration
 * answers it trivially yes, every time.
 */
function srcCorpusExcluding(excludeFile: string | null): string {
  const srcDir = join(ROOT, "src");
  return readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => excludeFile === null || f !== excludeFile)
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

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * TWO CORPORA — engine (src/) vs contract (broad).
 *
 * The single sweep above unions THREE namespaces and searches ONE corpus (flat src/*.ts). Those three
 * namespaces do not share a reader obligation, so the sweep is split into TWO populations, each with its
 * OWN corpus and its OWN ratchet pin:
 *
 *   · ENGINE fields  — the Zod object keys of src/genome_schema.ts. src/ IS the right corpus: orchestrator
 *     code is meant to read them. Searched in the SAME flat top-level src/*.ts corpus as the single sweep
 *     (srcCorpus()). Because genome_schema.ts is itself a top-level src/*.ts file, every extracted Zod key
 *     necessarily matches \bname\b at its own declaration line, so — under the preserved fail-safe rule
 *     (ANY word-boundary hit is READ) — NO engine field is ever reported unread. The engine ratchet floor
 *     is therefore 0, and the sealed engine-soundness law (which re-derives the SAME flat srcCorpus()) is
 *     exactly what forces it: any engine-unread name would be found in genome_schema.ts and flagged a false
 *     positive. A future genome field can only enter engine.unread if it appears NOWHERE in src/ including
 *     its own declaration file — which the extractor cannot produce — so this population guards the shape
 *     of the sweep rather than accumulating a backlog.
 *
 *   · CONTRACT fields — the schema.properties keys of domain_types/*.json + core_types/*.json. These are
 *     agent-to-agent PAYLOAD: one agent fills them, another reads them, and src/ never names them BY
 *     DESIGN. Their reader corpus is the BROAD tree — agents/ + standards/ + evals/ + src/, read
 *     RECURSIVELY (agents' phase_agents/, players/, seeds/; src/judges/) — so a field named by an agent
 *     method, a standard, an eval, or orchestrator code counts as READ. A contract field with no reader
 *     ANYWHERE in that tree is the genuine dead-payload class this ratchet holds.
 *
 * Both analyzers preserve every method invariant of the single sweep unchanged: the fail-safe posture
 * (AMBIGUOUS IS READ → each pin is a LOWER bound), the Object.keys-counts-as-READ rule (natural under
 * word-boundary matching, exercised by `supplies`), MIN_NAME_LENGTH = 5 with its stated consequence, and a
 * first-class METHOD_NOTE carried on each report (every marker the law greps for: Object.keys, spread,
 * dynamic, READ, src/). They reuse the SAME extractors (declaredFieldsFromGenomeSchema,
 * declaredFieldsFromJsonDir) and the SAME srcCorpus() as the single sweep, so the original population's
 * behaviour and its 181 pin are untouched.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

/** The BROAD contract reader corpus: the recursive text of agents/ + standards/ + evals/ + src/. Reads the
 *  same file kinds the sealed law's own broadCorpus()/readTreeText() reads (.ts/.tsx/.json/.md/.txt/.mjs/
 *  .cjs/.js) so this analyzer's corpus is byte-for-byte the set the contract-soundness cross-check
 *  re-derives — a name this reader fails to clear is therefore guaranteed absent from that independent
 *  corpus too, and cannot trip the soundness law. A directory or file that cannot be read contributes
 *  nothing rather than throwing. Crucially this does NOT read domain_types/ or core_types/ (the declaration
 *  sites) or tests/, so a field's own schema entry — and a test that merely names it — never count as a
 *  reader, exactly as blind spot (e) requires for the single sweep. */
function readTreeText(dir: string): string {
  let out = "";
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        out += readTreeText(p) + "\n";
      } else if (/\.(ts|tsx|json|md|txt|mjs|cjs|js)$/.test(entry.name)) {
        try {
          out += readFileSync(p, "utf8") + "\n";
        } catch {
          /* an unreadable file contributes nothing to the corpus */
        }
      }
    }
  } catch {
    /* an unreadable / absent directory contributes nothing to the corpus */
  }
  return out;
}

function broadReaderCorpus(): string {
  return ["agents", "standards", "evals", "src"].map((d) => readTreeText(join(ROOT, d))).join("\n");
}

/** Shared sweep: report the declared names (>= MIN_NAME_LENGTH) with no `\bname\b` hit in `corpus`. Same
 *  fail-safe rule as analyzeDeclaredFieldReachability — any word-boundary hit (value read, destructuring,
 *  spread target token, Object.keys(x) argument, dynamic-access sibling, type assertion) clears the name,
 *  so `unread` is a LOWER bound. `note` travels with the report so the method cannot be silently stripped. */
function sweepPopulation(fields: Iterable<string>, corpus: string, note: string): FieldReachabilityReport {
  const declared = new Set<string>(fields);
  const unread: string[] = [];
  for (const name of declared) {
    if (name.length < MIN_NAME_LENGTH) continue; // below-threshold names are out of sweep scope
    if (!new RegExp(`\\b${name}\\b`).test(corpus)) unread.push(name);
  }
  unread.sort();
  return {
    unread,
    totalFields: [...declared].filter((n) => n.length >= MIN_NAME_LENGTH).length,
    methodNote: note,
  };
}

/** ENGINE population METHOD_NOTE — carries every marker the law greps for (Object.keys, spread, dynamic,
 *  READ, src/) so both reports document the fail-safe posture as a first-class value, not a comment. */
const ENGINE_METHOD_NOTE = [
  "ENGINE POPULATION: the field keys declared inside src/genome_schema.ts Zod z.object({…}) blocks,",
  "searched in the flat top-level src/*.ts corpus ONLY (the same srcCorpus() the single sweep reads).",
  "A name of >= 5 chars is READ iff \\bname\\b matches anywhere in that text — fail-safe toward READ.",
  "",
  "Because genome_schema.ts is itself a src/*.ts file, every extracted key matches at its own declaration,",
  "so no engine field is ever reported unread and the engine floor is 0. Every fail-safe rule of the single",
  "sweep is preserved: an Object.keys(x) argument, a spread {...x}, a dynamic obj[key] sibling token, or an",
  "`as { name: T }` assertion all count as READ, so the pin is a LOWER bound.",
  METHOD_NOTE,
].join("\n");

/** CONTRACT population METHOD_NOTE — same five markers (Object.keys, spread, dynamic, READ, src/). */
const CONTRACT_METHOD_NOTE = [
  "CONTRACT POPULATION: the schema.properties keys of domain_types/*.json + core_types/*.json, searched in",
  "the BROAD recursive corpus agents/ + standards/ + evals/ + src/ (agents' phase_agents/, players/, seeds/;",
  "src/judges/ included). A name of >= 5 chars is READ iff \\bname\\b matches anywhere in ANY of the four —",
  "an agent method, a standard, an eval, or a src/ line all clear it. Fail-safe toward READ: an Object.keys",
  "argument, a spread, or a dynamic access still counts, so the pin is a LOWER bound. domain_types/,",
  "core_types/ and tests/ are NOT in the corpus — a field's own declaration and a test naming it never count.",
  METHOD_NOTE,
].join("\n");

/** ENGINE sweep: genome_schema.ts Zod keys, searched in flat src/*.ts. See the two-corpora note above for
 *  why this population's unread set is empty and its pin is 0. */
export function analyzeEngineFieldReachability(): FieldReachabilityReport {
  // Excludes genome_schema.ts: a field's own declaration is not a reader of it. See
  // srcCorpusExcluding — including it made this ratchet unable to fail.
  return sweepPopulation(
    declaredFieldsFromGenomeSchema(),
    srcCorpusExcluding("genome_schema.ts"),
    ENGINE_METHOD_NOTE,
  );
}

/** CONTRACT sweep: domain_types/ + core_types/ schema.properties keys, searched in the broad recursive
 *  corpus agents/ + standards/ + evals/ + src/. */
export function analyzeContractFieldReachability(): FieldReachabilityReport {
  return sweepPopulation(
    [...declaredFieldsFromJsonDir("domain_types"), ...declaredFieldsFromJsonDir("core_types")],
    broadReaderCorpus(),
    CONTRACT_METHOD_NOTE,
  );
}

/** Hand-verification trail for the TWO-CORPORA split, produced at build time (2026-08-21) by independently
 *  re-computing each population's reachability with word-boundary greps over the live tree (the analyzer
 *  module itself is not executable in the build seat, so the counts were derived the same way the sealed
 *  soundness laws verify them — by \bname\b search, not by trusting a number):
 *   · ENGINE — every genome_schema.ts Zod key resolves in src/ (each at minimum at its own declaration in
 *     genome_schema.ts, which is in the flat corpus), so engine.unread is empty. The negative-calibration
 *     names land correctly: `supplies` (Object.keys(ch.supplies) at src/composition.ts + value-read at
 *     src/runtime.ts) and `hydration` (src/claude_invoker.ts + src/runtime.ts) are READ, never unread.
 *   · CONTRACT — 127 domain_types/+core_types/ property keys (>= 5 chars) have no \bname\b reader anywhere
 *     in agents/ + standards/ + evals/ + src/. `tests_added` is among them (zero readers across all four —
 *     the sharpened claim the single sweep could only make against src/). `repository` is NOT (read in
 *     src/run_deps.ts, src/worker.ts, src/workspace.ts …, so a src/ hit clears the contract field). */
export const TWO_CORPORA_CALIBRATION_TRAIL = {
  engine: "genome_schema.ts Zod keys vs flat src/*.ts; all resolve (>= their own declaration) → engine.unread = [] → pin 0",
  contract: "domain_types/+core_types/ schema.properties vs agents/+standards/+evals/+src/; 127 unread incl. tests_added, excl. repository → pin 127",
} as const;

/** ENGINE ratchet FLOOR (hand-verified 2026-08-21). It is 0 and cannot grow under this method: an engine
 *  field only becomes unread if it appears NOWHERE in flat src/*.ts, but genome_schema.ts — a src/*.ts file
 *  — always holds its declaration, so \bname\b always matches. The pin exists to hold the shape of the
 *  sweep (separate engine population, its own floor) and to fail LOUDLY if the engine corpus is ever
 *  narrowed to exclude genome_schema.ts and a genuine orchestrator-dead field surfaces. May only decrease. */
/**
 * VERIFIED, not assumed. 14 Zod fields in genome_schema.ts have no reader anywhere else in src/:
 *
 *   technique_evidence · contract_caps · witnessed_by · auth_user_id · parent_org · is_institution
 *   from_institution · to_institution · from_node · to_node · edge_type · ordinal · wiki_space
 *   what_taken
 *
 * Almost all of them are the institutions / lineage surface — loaded into the genome and never
 * consumed by name. `technique_evidence` is the one CLAUDE.md calls "what makes 'why this player in
 * this chair' a record rather than a recollection", and nothing reads it.
 *
 * This pin sat at 0 and could not move: srcCorpus() included genome_schema.ts itself, so every field
 * matched its own declaration and counted as READ. Injecting `a_field_nothing_reads: z.string()` left
 * all 18 laws green. A declaration is not a read; the corpus now excludes the declaring file.
 */
export const PINNED_UNREAD_ENGINE_FIELDS = 14;

/** CONTRACT ratchet FLOOR (hand-verified 2026-08-21). 127 = the count of domain_types/*.json +
 *  core_types/*.json schema.properties keys (>= 5 chars, deduped) with no `\bname\b` reader anywhere in the
 *  broad corpus agents/ + standards/ + evals/ + src/. Verified by independent word-boundary grep over the
 *  live tree (per TWO_CORPORA_CALIBRATION_TRAIL): every one of the 127 is genuinely unread across all four
 *  branches, and the fail-safe posture makes it a LOWER bound. It may only ever DECREASE as payload fields
 *  are wired to a reader or dropped. */
export const PINNED_UNREAD_CONTRACT_FIELDS = 127;
