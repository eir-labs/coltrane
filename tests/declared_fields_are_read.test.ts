/** A DECLARED FIELD NOTHING READS IS A CONTRACT THE CODE DOES NOT KEEP.
 *
 *  tests/exported_symbols_are_reachable.test.ts pins the count of EXPORTED SYMBOLS nothing calls.
 *  It is blind to a whole class of dead contract: a declared FIELD, key, or schema slot — parsed,
 *  stored, and never read. Seven defects were diagnosed in this repo on 2026-08-20; every one was a
 *  declared field with no reader, and four shipped with PASSING tests. Each of those tests proved a
 *  mechanism WORKS; none asked whether anything REACHES it:
 *    · `supplies` (ChairSchema) was read in exactly one place as `Object.keys(...)` — the KEYS,
 *      never the VALUES — so a carried skill told to "read the constraints in the house-style slot"
 *      always found nothing. The house style was supplied and never read for ten days.
 *    · `repository` (change-request / change-context) was declared 2026-08-10, arrived on every
 *      claim, and was read by NOTHING until 2026-08-20.
 *    · `dirsByState` mapped six states including `done`/`failed`; no verb ever wrote either, and a
 *      COMPLETED gig ran twice.
 *    · `tests_added` (change-set) is in the schema, is NOT in required_fields, and grep across
 *      src/ tests/ standards/ evals/ returns ZERO readers.
 *
 *  WHAT THIS LAW DOES. It enumerates every field NAME declared in (1) domain_types/*.json and
 *  core_types/*.json under `schema.properties`, and (2) every Zod `.object({ ... })` field in
 *  src/genome_schema.ts, then cross-references each name against whether ANY code in src/ reads it.
 *  A field with no reader is reported BY NAME (a bare count tells nobody what to fix) and the count
 *  is pinned so it can only go DOWN — the same ratchet shape as the exported-symbols law.
 *
 *  METHOD (identical technique to the exported-symbols ratchet — pure Node fs + regex, no AST, no
 *  dependency, no network). A field name is READ iff a word-boundary regex `\bname\b` matches
 *  anywhere in the concatenated text of the top-level src/*.ts files. Names shorter than 5 chars are
 *  excluded from the sweep (they collide with incidental substrings and common identifiers, exactly
 *  as the exported-symbols law excludes them) — this silently omits genuinely-unread short fields,
 *  an accepted limit, not a claim of completeness.
 *
 *  FAIL-SAFE: AMBIGUOUS IS READ. This law UNDER-reports. ANY word-boundary hit counts as a read,
 *  including a name that appears only inside an `Object.keys(x)` argument, only inside a spread
 *  `{...x}`, or only inside a `as { name: T }` type assertion. Precisely excluding those would need
 *  an AST (forbidden) and risks FALSE NEGATIVES — calling a value-read field dead. The hydration
 *  defect hid for ten days precisely inside an `Object.keys` read, so the honesty contract is to err
 *  toward READ and never toward UNREAD. A previous ratchet in this repo (exported_symbols) once
 *  reported 60 orphans where the true number was 19 because it could not see `export *` re-exports;
 *  that 60-vs-19 over-count is why this law states its blind spots out loud rather than trusting the
 *  number.
 *
 *  BLIND SPOTS, stated so the number is trusted for what it is and not for what it is not:
 *    (a) DYNAMIC KEY access `obj[variable]` — the field name never appears as a token, so a field
 *        reached only this way will show as UNREAD (a false positive; triage by hand before fixing).
 *    (b) WILDCARD SPREAD `{...obj}` — copies every field without naming any, so fields reached only
 *        through a spread show as UNREAD.
 *    (c) TYPE ASSERTIONS `as { field: T }` DO count as reads — the name is a token, so it matches.
 *    (d) `Object.keys(x)` reads key EXISTENCE, not values, but is counted as READ when the name
 *        appears there — the exact pattern (src/composition.ts) by which the hydration defect hid.
 *    (e) The reader corpus is src/*.ts ONLY. A field referenced only from tests/ does NOT count as
 *        read: the whole point of this law is that tests proved mechanisms WORK while nothing at
 *        RUNTIME reached them, so counting a test reference would reproduce the blind spot.
 *    (f) Zod extraction reads the CURRENT genome_schema.ts syntax. Novel patterns (`.extend`,
 *        `.merge`, `.pick`) could be missed until the extractor is taught them.
 *
 *  RED-FIRST — WHY THIS FILE IMPORTS SOMETHING THAT DOES NOT EXIST YET. This file is the SEALED
 *  LAW: the calibration, the guard, the soundness cross-check, and the pinned-count ratchet. The
 *  analysis ENGINE it demands — `analyzeDeclaredFieldReachability()` and `PINNED_UNREAD_FIELDS`,
 *  imported from ./support/declared_field_reachability.js — is the ENFORCEMENT, and it is NOT built
 *  yet. Until the builder writes that module, every assertion below is RED because the import cannot
 *  resolve. That absence failing loudly IS the spec. The builder ADDS the engine module, implements
 *  the method above, computes the true unread count, hand-verifies a sample (recording it in that
 *  module), and pins PINNED_UNREAD_FIELDS to the verified number — and may NOT edit this file. When
 *  the engine exists these laws go green by describing the truth, not by being weakened.
 *
 *  HAND-VERIFICATION OF THE CALIBRATION SET (done by grep over src/ during drafting, 2026-08-20):
 *    · `tests_added` — declared in domain_types/change-set.json schema.properties, absent from its
 *      required_fields; `grep -rn "tests_added" src/` returns ZERO lines. MUST be reported unread.
 *    · `repository`  — declared in domain_types/change-request.json + change-context.json
 *      schema.properties; read at src/worker.ts:145 as
 *      `(claim.input as { repository?: unknown })?.repository`. MUST NOT be reported unread.
 *    · `supplies`    — declared in genome_schema.ts (ChairSchema:161, OrgOfficeSchema:706); read for
 *      its VALUE at src/runtime.ts:2585 (`p.chair.supplies`) AND as keys at src/composition.ts:346
 *      (`Object.keys(ch.supplies ?? {})`). MUST NOT be reported unread.
 *    · `hydration`   — declared in genome_schema.ts (SkillSchema:82); read at
 *      src/claude_invoker.ts:183/185 and src/runtime.ts:2585. MUST NOT be reported unread.
 *  If the engine flags `repository`, `supplies`, or `hydration`, the ENGINE is wrong and must be
 *  fixed — the calibration assertions below are the sealed contract and are not to be relaxed. */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeDeclaredFieldReachability,
  PINNED_UNREAD_FIELDS,
} from "./support/declared_field_reachability.js";

const SRC = join(process.cwd(), "src");

/** Independent, in-test re-read of the SAME corpus the engine sweeps (top-level src/*.ts, flat —
 *  the exact scope of the exported-symbols ratchet). Used to cross-check the engine's output rather
 *  than trust it: if the engine ever reports a field as unread that DOES have a word-boundary
 *  occurrence in src/, this catches the false positive without re-using the engine's own accounting. */
function srcCorpus(): string {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(SRC, f), "utf8"))
    .join("\n");
}

describe("declared fields have somewhere to be read from", () => {
  const report = analyzeDeclaredFieldReachability();
  const unread = report.unread;

  it("the sweep extracts declared fields at all — the law is not vacuous", () => {
    // Guard: proves the extractor parsed the three namespaces and did not silently no-op. A stub
    // engine returning { totalFields: 0 } fails HERE rather than passing an empty sweep as clean.
    expect(report.totalFields).toBeGreaterThan(0);
  });

  it("names the unread fields — a bare count tells nobody what to fix", () => {
    // The detector must yield NAMES, not just a number: every reported entry is a field identifier.
    expect(Array.isArray(unread)).toBe(true);
    for (const name of unread) {
      expect(typeof name).toBe("string");
      expect(name).toMatch(/^\w+$/);
    }
  });

  it("calibration+: `tests_added` (declared, zero src/ readers) IS reported unread", () => {
    // The positive calibration. tests_added is in change-set.json schema.properties, not in its
    // required_fields, and has no reader anywhere in src/ — the field meant to record that a change
    // shipped tests is itself unread. If this is NOT flagged, the sweep is failing to detect true
    // dead fields (extraction or cross-reference is broken toward over-reading).
    expect(
      unread,
      `expected 'tests_added' in the unread set — it has zero src/ readers. Unread (${unread.length}): ` +
        unread.join(", "),
    ).toContain("tests_added");
  });

  it("calibration-: `repository`, `supplies`, `hydration` (each read at runtime) are NOT unread", () => {
    // The negative calibration and the honesty teeth. Each of these has a genuine value-read in src/
    // (worker.ts:145 / runtime.ts:2585 / claude_invoker.ts:183). If any appears here the engine is
    // OVER-reporting — flagging a read field as dead — which is the failure mode this law forbids
    // (fail-safe toward READ). Fix the engine, never these assertions.
    const wronglyFlagged = ["repository", "supplies", "hydration"].filter((n) => unread.includes(n));
    expect(
      wronglyFlagged,
      `these fields ARE read in src/ but were reported unread (engine over-reports; fix the ` +
        `cross-reference, not this test): ${wronglyFlagged.join(", ")}`,
    ).toEqual([]);
  });

  it("fail-safe soundness: every reported-unread field truly has NO word-boundary read in src/*.ts", () => {
    // Cross-check the engine against an independent read of the corpus. This law's honesty contract
    // is to UNDER-report: a field is unread only when `\bname\b` matches NOWHERE in src/. Any name in
    // `unread` that this independent scan finds a hit for is a false positive — proof the engine is
    // counting something (a spread, a partial match, a skipped file) incorrectly.
    const corpus = srcCorpus();
    const falsePositives = unread.filter((name) => new RegExp(`\\b${name}\\b`).test(corpus));
    expect(
      falsePositives,
      `reported unread but DO occur in src/*.ts (engine over-reports; must fail safe toward READ): ` +
        falsePositives.join(", "),
    ).toEqual([]);
  });

  it("blind spots and method are documented on the engine, not just in a strippable comment", () => {
    // The 60-vs-19 over-count is why the method and its blind spots must travel WITH the analysis as
    // a first-class, testable artifact — so they cannot be quietly dropped. The engine exposes them.
    const note = report.methodNote ?? "";
    expect(note.length).toBeGreaterThan(0);
    for (const marker of ["Object.keys", "spread", "dynamic", "READ", "src/"]) {
      expect(note, `methodNote must document the '${marker}' blind spot / fail-safe policy`).toContain(
        marker,
      );
    }
  });

  it(`no NEW unread declared fields (pinned at ${PINNED_UNREAD_FIELDS})`, () => {
    // The ratchet. Pins the CURRENT count of declared fields with no src/ reader; fails only when the
    // number GROWS — i.e. when a new field is declared with nobody reading it. If it SHRANK because a
    // field was wired or removed, LOWER PINNED_UNREAD_FIELDS to the new count in the engine module
    // (it may only ever decrease). PINNED must be the TRUE, hand-verified count, never an estimate.
    expect(PINNED_UNREAD_FIELDS).toBeGreaterThanOrEqual(0);
    expect(
      unread.length,
      `${unread.length} declared fields have no reader in src/ (pinned at ${PINNED_UNREAD_FIELDS}). ` +
        `If this GREW, a field was declared with no reader — wire it or drop it. If it SHRANK, lower ` +
        `PINNED_UNREAD_FIELDS to ${unread.length}. Unread: ${unread.slice(0, 20).join(", ")}` +
        `${unread.length > 20 ? ", …" : ""}`,
    ).toBe(PINNED_UNREAD_FIELDS);
  });
});
