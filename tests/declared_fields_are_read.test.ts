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
// NAMESPACE import (not a named import) FOR THE TWO-CORPORA SPLIT — deliberate. The engine symbols the
// laws below demand (analyzeEngineFieldReachability / analyzeContractFieldReachability and their pins)
// do NOT exist yet. A `import { analyzeEngineFieldReachability } from …` of a missing named export is a
// COMPILE error (this repo runs `tsc` before vitest, tests/_support/build_once.ts) that would block the
// whole build and drag the 7 already-green laws red for the wrong reason. The namespace import links, and
// the cast below (`as unknown as TwoCorporaEngine`) gives the not-yet-built members their FUTURE types so
// tsc stays CLEAN — while at RUNTIME each member is `undefined`, so every new law fails RED on its OWN
// assertion (calling `undefined()` throws inside its `it`) and the green laws keep running green.
import * as reachability from "./support/declared_field_reachability.js";

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

/** TWO CORPORA — THE SPLIT THIS RED SPEC DEMANDS.
 *
 *  The single sweep above unions THREE namespaces and searches ONE corpus (src/*.ts). That conflates two
 *  populations that have DIFFERENT reader obligations:
 *    · ENGINE fields  — the Zod keys of src/genome_schema.ts. src/ IS the right corpus; orchestrator code
 *      is supposed to read them. A genome field with no src/ reader is a genuine dead-contract defect.
 *    · CONTRACT fields — domain_types/*.json + core_types/*.json schema.properties. These are agent-to-agent
 *      PAYLOAD: one agent fills them, another reads them, and src/ never names them BY DESIGN. Their reader
 *      corpus is agents/ + standards/ + evals/ + src/ — a field named by an agent method or standard IS read.
 *
 *  So the enforcement this file now requires is TWO analyzers with TWO pins, reported as SEPARATE populations:
 *    twoCorpora.analyzeEngineFieldReachability()   → { unread, totalFields, methodNote }, searched in src/ only
 *    twoCorpora.analyzeContractFieldReachability() → { unread, totalFields, methodNote }, searched in the broad corpus
 *    twoCorpora.PINNED_UNREAD_ENGINE_FIELDS   : number   (engine ratchet floor)
 *    twoCorpora.PINNED_UNREAD_CONTRACT_FIELDS : number   (contract ratchet floor)
 *  None of these exist yet, so every law below is RED — the analyzers are `undefined` and calling them throws
 *  INSIDE the `it`. That absence failing loudly, per-law, IS the spec. The builder ADDS the two analyzers and
 *  the two pins to tests/support/declared_field_reachability.ts (hand-verifying the counts) — NOT by weakening
 *  anything here. The sealed fail-safe posture (AMBIGUOUS IS READ → each pin is a LOWER bound), the exported
 *  METHOD_NOTE the markers-law greps, the Object.keys-counts-as-READ rule and MIN_NAME_LENGTH survive in BOTH
 *  populations. The calibration is now SHARPER: `tests_added` must be unread against the BROAD corpus (the claim
 *  originally made — NOTHING ANYWHERE reads it), while `repository`/`supplies`/`hydration` must NOT be. */

/** MIN_NAME_LENGTH restated in the spec so the "every reported name is >= 5 chars" laws are not a tautology
 *  against a value only the engine knows. Must equal the engine's threshold; if the engine lowers it, these
 *  laws (and the sweep) change together — this constant is the contract, not a copy. */
const SPEC_MIN_NAME_LENGTH = 5;

/** The five markers METHOD_NOTE must carry, unchanged from the single-corpus law's marker set. Both the
 *  engine report and the contract report must expose a methodNote naming every one — the 60-vs-19 over-count
 *  is why the method + blind spots travel WITH each analysis rather than in a strippable comment. */
const METHOD_NOTE_MARKERS = ["Object.keys", "spread", "dynamic", "READ", "src/"] as const;

/** INDEPENDENT re-derivation of the CONTRACT reader corpus: agents/ (RECURSIVE — top-level *.json plus
 *  phase_agents/, players/, seeds/ …) + standards/ + evals/ + src/ (recursive, so src/judges/ counts too).
 *  Implemented here from scratch, NOT by importing the engine's own reader: reusing the engine's accounting
 *  would let an engine corpus bug MASK a false positive, defeating the cross-check — the same discipline by
 *  which srcCorpus() above independently re-reads what the engine sweeps. Reads every text file; a directory
 *  or file it cannot read contributes nothing rather than throwing. A CONTRACT field is READ iff `\bname\b`
 *  hits ANYWHERE in this text, so the builder's contract analyzer must read AT LEAST this set or a name it
 *  fails to clear will trip the soundness law below. */
function readTreeText(dir: string): string {
  let out = "";
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        out += readTreeText(p) + "\n";
      } else if (/\.(ts|tsx|json|md|txt|mjs|cjs|js)$/.test(e.name)) {
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

function broadCorpus(): string {
  const root = process.cwd();
  return ["agents", "standards", "evals", "src"]
    .map((d) => readTreeText(join(root, d)))
    .join("\n");
}

/** The per-population report shape (same three fields as the single-corpus FieldReachabilityReport). */
interface TwoCorporaReport {
  unread: string[];
  totalFields: number;
  methodNote: string;
}

/** The FUTURE shape of the engine module after the split — the enforcement this red spec demands. It does
 *  NOT exist yet; the cast below binds these names to their intended types so tsc compiles, while at runtime
 *  each is `undefined`. The builder makes it real by ADDING these exports to
 *  tests/support/declared_field_reachability.ts (two analyzers + two hand-verified pins), never by editing
 *  the laws. When the exports exist, the `as unknown as` cast becomes a truthful description and the laws go
 *  green by describing reality. */
interface TwoCorporaEngine {
  /** ENGINE fields = genome_schema.ts Zod keys, searched in src/*.ts ONLY. */
  analyzeEngineFieldReachability(): TwoCorporaReport;
  /** CONTRACT fields = domain_types/ + core_types/ schema.properties, searched in agents/+standards/+evals/+src/. */
  analyzeContractFieldReachability(): TwoCorporaReport;
  PINNED_UNREAD_ENGINE_FIELDS: number;
  PINNED_UNREAD_CONTRACT_FIELDS: number;
}
const twoCorpora = reachability as unknown as TwoCorporaEngine;

describe("declared fields split into two corpora — engine (src/) vs contract (broad)", () => {
  it("engine population is non-vacuous and yields NAMES, not just a number", () => {
    // RED now: analyzeEngineFieldReachability is undefined → this call throws inside the `it`. GREEN once
    // the engine extracts genome_schema.ts Zod keys and sweeps src/. A stub returning { totalFields: 0 }
    // still fails here rather than passing an empty engine sweep as clean.
    const engine = twoCorpora.analyzeEngineFieldReachability();
    expect(engine.totalFields).toBeGreaterThan(0);
    expect(Array.isArray(engine.unread)).toBe(true);
    for (const name of engine.unread) {
      expect(typeof name).toBe("string");
      expect(name).toMatch(/^\w+$/);
    }
  });

  it("contract population is non-vacuous and yields NAMES, not just a number", () => {
    // RED now: analyzeContractFieldReachability is undefined. GREEN once it extracts domain_types/ +
    // core_types/ schema.properties keys and sweeps the broad corpus.
    const contract = twoCorpora.analyzeContractFieldReachability();
    expect(contract.totalFields).toBeGreaterThan(0);
    expect(Array.isArray(contract.unread)).toBe(true);
    for (const name of contract.unread) {
      expect(typeof name).toBe("string");
      expect(name).toMatch(/^\w+$/);
    }
  });

  it("two SEPARATE pins — the engine ratchet is not the contract ratchet", () => {
    // The populations are reported separately with separate ratchet floors; no single combined count
    // replaces them. RED now: both pins are undefined, so the numeric assertions fail. GREEN once the
    // builder hand-verifies each count and pins it (each may only ever DECREASE).
    const engine = twoCorpora.analyzeEngineFieldReachability();
    const contract = twoCorpora.analyzeContractFieldReachability();
    expect(typeof twoCorpora.PINNED_UNREAD_ENGINE_FIELDS).toBe("number");
    expect(typeof twoCorpora.PINNED_UNREAD_CONTRACT_FIELDS).toBe("number");
    expect(twoCorpora.PINNED_UNREAD_ENGINE_FIELDS).toBeGreaterThanOrEqual(0);
    expect(twoCorpora.PINNED_UNREAD_CONTRACT_FIELDS).toBeGreaterThanOrEqual(0);
    expect(
      engine.unread.length,
      `${engine.unread.length} genome_schema.ts fields have no src/ reader (engine pin ` +
        `${twoCorpora.PINNED_UNREAD_ENGINE_FIELDS}). If it GREW, a Zod field was declared with no ` +
        `orchestrator reader — wire it or drop it. If it SHRANK, lower PINNED_UNREAD_ENGINE_FIELDS. ` +
        `Engine unread: ${engine.unread.slice(0, 20).join(", ")}${engine.unread.length > 20 ? ", …" : ""}`,
    ).toBe(twoCorpora.PINNED_UNREAD_ENGINE_FIELDS);
    expect(
      contract.unread.length,
      `${contract.unread.length} contract fields have no reader in agents/+standards/+evals/+src/ ` +
        `(contract pin ${twoCorpora.PINNED_UNREAD_CONTRACT_FIELDS}). If it GREW, a payload field was ` +
        `declared that nothing anywhere names — wire a reader or drop it. If it SHRANK, lower ` +
        `PINNED_UNREAD_CONTRACT_FIELDS. Contract unread: ` +
        `${contract.unread.slice(0, 20).join(", ")}${contract.unread.length > 20 ? ", …" : ""}`,
    ).toBe(twoCorpora.PINNED_UNREAD_CONTRACT_FIELDS);
  });

  it("calibration+ (sharpened): `tests_added` IS unread against the BROAD corpus", () => {
    // The single-corpus sweep proved only "no src/ reader" for tests_added. The ORIGINAL finding was that
    // NOTHING ANYWHERE reads it — established by grepping src/ tests/ standards/ evals/. This law makes the
    // contract population verify that stronger claim: tests_added (change-set.json schema.properties, not in
    // required_fields) must be unread even after searching agents/ + standards/ + evals/ + src/.
    const contract = twoCorpora.analyzeContractFieldReachability();
    expect(
      contract.unread,
      `expected 'tests_added' in the CONTRACT unread set — it has zero readers across ` +
        `agents/+standards/+evals/+src/. Contract unread (${contract.unread.length}): ` +
        contract.unread.join(", "),
    ).toContain("tests_added");
  });

  it("calibration- : `repository` is unread in NEITHER population (read at src/worker.ts)", () => {
    // repository is a CONTRACT field (change-request/change-context) WITH a real src/ read (worker.ts). It
    // must be absent from the contract population (a src/ hit clears a contract field) AND, being read in
    // src/, absent from the engine population if it appears there at all. If it shows up in either set the
    // analyzer OVER-reports — fix the cross-reference, never this assertion.
    const engine = twoCorpora.analyzeEngineFieldReachability();
    const contract = twoCorpora.analyzeContractFieldReachability();
    expect(engine.unread, `'repository' is read in src/ but the ENGINE sweep reported it unread`).not.toContain(
      "repository",
    );
    expect(
      contract.unread,
      `'repository' is read in src/worker.ts but the CONTRACT sweep reported it unread (over-reports; fix ` +
        `the cross-reference, not this test)`,
    ).not.toContain("repository");
  });

  it("calibration- : `supplies` and `hydration` are NOT unread in the ENGINE population", () => {
    // Both are genome_schema.ts (ENGINE) fields with genuine src/ reads — supplies for its value at
    // runtime.ts and as keys at composition.ts (`Object.keys(ch.supplies ?? {})`, counted READ, preserving
    // the Object.keys rule); hydration at claude_invoker.ts / runtime.ts. If either appears in engine.unread
    // the engine over-reports or the Object.keys-counts-as-READ rule was weakened. Fix the engine.
    const engine = twoCorpora.analyzeEngineFieldReachability();
    const wronglyFlagged = ["supplies", "hydration"].filter((n) => engine.unread.includes(n));
    expect(
      wronglyFlagged,
      `these ENGINE fields ARE read in src/ but were reported unread (engine over-reports or the ` +
        `Object.keys-as-READ rule regressed; fix the engine): ${wronglyFlagged.join(", ")}`,
    ).toEqual([]);
  });

  it("MIN_NAME_LENGTH holds in BOTH populations — no reported name is shorter than 5 chars", () => {
    // The short-name exclusion (>= 5 chars, its stated consequence: genuinely-unread short fields are
    // silently omitted) must survive in both sweeps. Any reported name below the threshold means the
    // exclusion was dropped for that population.
    const engine = twoCorpora.analyzeEngineFieldReachability();
    const contract = twoCorpora.analyzeContractFieldReachability();
    const tooShort = [...engine.unread, ...contract.unread].filter((n) => n.length < SPEC_MIN_NAME_LENGTH);
    expect(
      tooShort,
      `names below MIN_NAME_LENGTH (${SPEC_MIN_NAME_LENGTH}) were reported unread — the short-name ` +
        `exclusion was weakened for a population: ${tooShort.join(", ")}`,
    ).toEqual([]);
  });

  it("METHOD_NOTE survives on BOTH reports with every marker — not a strippable comment", () => {
    // The fail-safe posture and blind spots must travel WITH each analysis as a first-class, testable
    // string carrying the literal markers the law greps for. Both populations expose it.
    const engine = twoCorpora.analyzeEngineFieldReachability();
    const contract = twoCorpora.analyzeContractFieldReachability();
    for (const [label, note] of [
      ["engine", engine.methodNote],
      ["contract", contract.methodNote],
    ] as const) {
      expect(typeof note, `${label}.methodNote must be a first-class string`).toBe("string");
      expect((note ?? "").length, `${label}.methodNote must be non-empty`).toBeGreaterThan(0);
      for (const marker of METHOD_NOTE_MARKERS) {
        expect(note, `${label}.methodNote must document the '${marker}' marker`).toContain(marker);
      }
    }
  });

  it("engine fail-safe soundness: every engine-unread field truly has NO word-boundary read in src/*.ts", () => {
    // Independent cross-check of the ENGINE sweep against the same flat src/*.ts corpus srcCorpus() re-reads.
    // The honesty contract is to UNDER-report: an engine field is unread only when `\bname\b` matches NOWHERE
    // in src/. Any engine.unread name this scan finds a hit for is a false positive.
    const engine = twoCorpora.analyzeEngineFieldReachability();
    const corpus = srcCorpus();
    const falsePositives = engine.unread.filter((name) => new RegExp(`\\b${name}\\b`).test(corpus));
    expect(
      falsePositives,
      `reported unread by the ENGINE sweep but DO occur in src/*.ts (over-reports; must fail safe toward ` +
        `READ): ${falsePositives.join(", ")}`,
    ).toEqual([]);
  });

  it("contract fail-safe soundness: no contract-unread field has a word-boundary hit in the BROAD corpus", () => {
    // Independent cross-check of the CONTRACT sweep against a broadCorpus() re-derived here from scratch over
    // agents/ + standards/ + evals/ + src/ — NOT the engine's own reader. A CONTRACT field is unread only
    // when `\bname\b` matches NOWHERE across those four; any contract.unread name with a hit here (an agent
    // method, a standard, an eval, an src/ line) is a false positive the engine failed to clear.
    const contract = twoCorpora.analyzeContractFieldReachability();
    const corpus = broadCorpus();
    const falsePositives = contract.unread.filter((name) => new RegExp(`\\b${name}\\b`).test(corpus));
    expect(
      falsePositives,
      `reported unread by the CONTRACT sweep but DO occur in agents/+standards/+evals/+src/ (over-reports; ` +
        `a hit in ANY of the four is READ): ${falsePositives.join(", ")}`,
    ).toEqual([]);
  });

  it("the broad corpus genuinely reaches agents/ + standards/ + evals/ — the soundness law is not vacuous", () => {
    // Guard on the cross-check itself: if broadCorpus() silently read nothing (a bad path, a wrong filter),
    // the contract soundness law would pass for the wrong reason. Prove each of the three non-src/ locations
    // contributed text, and that the whole corpus dwarfs src/ alone.
    const broad = broadCorpus();
    const src = srcCorpus();
    expect(broad.length).toBeGreaterThan(src.length);
    expect(readTreeText(join(process.cwd(), "agents")).length, "agents/ corpus is empty").toBeGreaterThan(0);
    expect(readTreeText(join(process.cwd(), "standards")).length, "standards/ corpus is empty").toBeGreaterThan(0);
    expect(readTreeText(join(process.cwd(), "evals")).length, "evals/ corpus is empty").toBeGreaterThan(0);
  });
});
