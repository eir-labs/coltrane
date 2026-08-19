// The Coltrane institution must declare the enforcement it actually PERFORMS, not only the
// governance it submits to.
//
// RED-first: written against an institutions/coltrane.json holding four laws, all about the git
// dev-loop — who may merge main, opening a PR, green CI before merge, a change-set branch standing
// red. Those are real and they stay. What is missing is the other half of the institution: the
// rules the ENGINE enforces on a seated agent at runtime, which CLAUDE.md states plainly under
// "Tool routing — the most common gotcha" and the "Don't" list, and which the institution is silent
// about.
//
// That silence was found by formalizing CLAUDE.md + README BLIND — with institutions/, src/ and
// tests/ excluded from the corpus — and comparing the drawn institution against the hand-written
// one. The two came back disjoint across two independent runs: four hand-written laws about the
// merge process, six drawn laws about what the engine refuses. Neither knew about the other. The
// three laws pinned here are the drawn ones that reduce to a runnable predicate.
//
// Why it matters that these three specifically land: they are ENGINE-DECIDABLE. Every operator in
// them has a reducer, so `evaluate` returns DENY from facts alone — no external forum, no test file
// standing in, no UNDECIDED. They are the only laws in the institution of which that is true, and
// an institution that enforces something at runtime and does not say so in its own laws is
// under-declaring itself in exactly the direction that matters.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstitutionSchema } from "../src/genome_schema.js";
import { evaluate, checkInstitutionAdmissibility } from "../src/institution_enforcement.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE = join(REPO_ROOT, "institutions", "coltrane.json");
const doc = JSON.parse(readFileSync(FILE, "utf8")) as {
  institution: Record<string, unknown>;
  chairs: readonly Record<string, unknown>[];
};
const laws = InstitutionSchema.parse(doc.institution).laws;

/** Every operator the evaluator KNOWS. Kept whole so the drift guard below can probe each one. */
const KNOWN = [
  "=>", "and", "or", "not", "=", "is-agent", "human-governor", "require", "allow", "deny",
  "subseteq", "forall", "resolvable", "nonempty", "declared_before", "has", "backed_by_contract",
] as const;

/** The ten operators `asBool`/the verdict reducer implement. The other seven KNOWN operators
 *  (subseteq forall resolvable nonempty declared_before has backed_by_contract) are admissible and
 *  return UNDECIDED — an honest non-decision, but a non-decision. A law is engine-decidable iff
 *  every head symbol in it is drawn from this set. */
const REDUCIBLE = new Set([
  "=>", "and", "or", "not", "=", "is-agent", "human-governor", "require", "allow", "deny",
]);
const heads = (predicate: string): string[] =>
  [...predicate.matchAll(/\(\s*([^\s()]+)/g)].map((m) => m[1] as string);
const engineDecidable = (predicate: string): boolean =>
  heads(predicate).every((h) => REDUCIBLE.has(h));

/** `is-agent` reads a PRINCIPAL RECORD, not a name: it reduces true only for an object carrying
 *  is_agent === true (institution_enforcement.ts). A bare string fails the guard and the law
 *  reports NOT_APPLICABLE — correct behaviour, and an easy way to write a test that passes while
 *  proving nothing, since NOT_APPLICABLE is also what an over-narrow guard returns. */
const AGENT = { is_agent: true } as const;

const byAim = (needle: string) =>
  laws.find((l) => l.aim.toLowerCase().includes(needle));

describe("institutions/coltrane.json — the institution declares the routing it enforces", () => {
  it("declares a law forbidding a coltrane-shaped operation through a non-MCP surface", () => {
    const law = byAim("mcp");
    expect(
      law,
      "CLAUDE.md: 'If you bypass the coltrane tool, the genome doesn't see your work, hashes don't " +
        "update, and the ledger goes out of sync.' That is a prohibition with a stated consequence — " +
        "the institution should hold it as law, not leave it as documentation.",
    ).toBeDefined();
    expect(law!.deontic).toBe("forbidden");
  });

  it("declares a law forbidding a direct write to core_types/ or domain_types/", () => {
    const law = byAim("core_types");
    expect(
      law,
      "CLAUDE.md Don't #1: \"Don't write to core_types/ or domain_types/ directly — use " +
        "type_register / type_extend.\"",
    ).toBeDefined();
    expect(law!.deontic).toBe("forbidden");
  });

  it("declares a law forbidding an agent DEFINITION added by dropping a file", () => {
    const law = byAim("agent definition");
    expect(
      law,
      "CLAUDE.md Don't #2: \"Don't add fake agents under agents/ — use agent_define.\"",
    ).toBeDefined();
    expect(law!.deontic).toBe("forbidden");
  });

  // Fact values are HYPHENATED, matching the vocabulary the four pre-existing dev-loop laws
  // already use ("merge-main", "open-pr"). An underscored fact silently misses the guard and the
  // law reports NOT_APPLICABLE — which is the evaluator being right about a question it was asked
  // wrong, and is why the NOT_APPLICABLE case below is asserted separately rather than trusted.
  //
  // The load-bearing pair. A law that merely PARSES has proved nothing; these two assert the
  // predicate actually decides — DENY when the guard matches, NOT_APPLICABLE when it does not.
  // Without the second, a law with a missing or over-broad guard would pass the first while
  // governing every action in the system.
  it("each routing law DENIES the bypass from facts alone — never UNDECIDED", () => {
    for (const [needle, facts] of [
      ["mcp", { actor: AGENT, operation: "coltrane-shaped", surface: "builtin" }],
      ["core_types", { actor: AGENT, action: "direct-write", target: "type-dir" }],
      ["agent definition", { actor: AGENT, action: "file-drop", target: "agent-definition" }],
    ] as const) {
      const law = byAim(needle)!;
      expect(
        engineDecidable(law.check.predicate),
        `"${needle}" law uses an operator with no reducer, so the engine can never rule on it`,
      ).toBe(true);
      expect(evaluate(law.check, { ...facts }), `"${needle}" law must DENY the bypass`).toBe("DENY");
    }
  });

  it("each routing law is NOT_APPLICABLE to an action it does not govern", () => {
    for (const [needle, facts] of [
      ["mcp", { actor: AGENT, operation: "read-source", surface: "builtin" }],
      ["core_types", { actor: AGENT, action: "read", target: "type-dir" }],
      ["agent definition", { actor: AGENT, action: "file-drop", target: "docs-dir" }],
    ] as const) {
      const law = byAim(needle)!;
      expect(
        evaluate(law.check, { ...facts }),
        `"${needle}" law governs an action it should not — its guard is too broad`,
      ).toBe("NOT_APPLICABLE");
    }
  });


  // A hard-coded REDUCIBLE set goes stale silently: the day someone implements a reducer for `has`,
  // this suite would keep reporting a decidable law as undecidable and nobody would learn it here.
  // So derive the fact from BEHAVIOUR rather than from a transcription of the switch — probe each
  // known operator and let the evaluator say which ones it can reduce. UNDECIDED is the signal: an
  // operator with a reducer returns some other verdict even when its guard does not match.
  //
  // The probe shapes are per-operator on purpose. The logical connectives take BOOLEAN
  // SUB-EXPRESSIONS, not operands — `(and a)` reduces to U for the honest reason that a bare symbol
  // is not a boolean, which says nothing about whether `and` has a reducer. Getting that wrong is
  // how this guard would report a false positive, and it is the first thing it caught.
  const PROBE: Readonly<Record<string, string>> = {
    "and": '(=> (and (= a "x") (= a "x")) deny)',
    "or": '(=> (or (= a "x") (= a "x")) deny)',
    "not": '(=> (not (= a "x")) deny)',
    "=": '(=> (= a "x") deny)',
    "is-agent": "(=> (is-agent a) deny)",
    "human-governor": "(=> (human-governor a) deny)",
    "subseteq": "(=> (subseteq a b) deny)",
    "forall": "(=> (forall x (= a x)) deny)",
    "resolvable": "(=> (resolvable a) deny)",
    "nonempty": "(=> (nonempty a) deny)",
    "declared_before": "(=> (declared_before a b) deny)",
    "has": "(=> (has a b) deny)",
    "backed_by_contract": "(=> (backed_by_contract a b) deny)",
  };

  it("REDUCIBLE matches what the evaluator actually reduces — probed, not transcribed", () => {
    // `=>` `require` `allow` `deny` are the verdict forms every probe is already built from; if any
    // of them stopped reducing, every row below would fail rather than silently pass.
    for (const [op, predicate] of Object.entries(PROBE)) {
      const verdict = evaluate(
        { predicate, inputs: { a: "t", b: "t" } },
        { a: { is_agent: true, human_governor: true }, b: "z" },
      );
      expect(
        verdict !== "UNDECIDED",
        `"${op}" reduces=${verdict !== "UNDECIDED"} (verdict ${verdict}) but REDUCIBLE says ` +
          `${REDUCIBLE.has(op)} — the operator set moved and this suite's copy of it did not. ` +
          `Update REDUCIBLE, then re-check every law's engine-decidability: a law that was ` +
          `UNDECIDED may now decide, which is a change in what the institution enforces.`,
      ).toBe(REDUCIBLE.has(op));
    }
    expect(Object.keys(PROBE).length + 4, "every KNOWN operator must be probed or excluded")
      .toBe(KNOWN.length);
  });

  // THE CASE THAT WAS MISSING, and the reason this law had to be narrowed. CLAUDE.md forbids
  // "dropping a markdown file in agents/" (:312) AND ships its base players as exactly that —
  // `agents/players/<name>.md`, markdown subagent definitions (:347). A law reading "a file under
  // agents/" therefore forbids the shipped arrangement.
  //
  // The original NOT_APPLICABLE probe used target "docs-dir", which proves only that the law does
  // not govern somewhere obviously unrelated. A guard can be wrong in the narrow band BETWEEN the
  // thing it should catch and the thing it obviously should not, and that band is exactly where
  // over-broad guards live. Probe the neighbour, not the stranger.
  it("the agent-definition law does NOT govern a base player under agents/players/", () => {
    const law = byAim("agent definition")!;
    expect(
      evaluate(law.check, { actor: AGENT, action: "file-drop", target: "base-player" }),
      "a base player IS a markdown file under agents/ by design (CLAUDE.md: `agents/players/<name>.md`). " +
        "A law that denies it forbids the arrangement the same document ships.",
    ).toBe("NOT_APPLICABLE");
  });

  it("the institution stays admissible with the routing laws added", () => {
    const verdict = checkInstitutionAdmissibility({
      institution: doc.institution,
      chairs: doc.chairs,
    });
    expect(verdict.admitted, JSON.stringify(verdict.offenders)).toBe(true);
  });

  it("the four dev-loop laws are untouched — this change ADDS, it does not replace", () => {
    for (const needle of ["merge a change", "pull request", "continuous-integration", "red"]) {
      expect(
        laws.some((l) => l.aim.toLowerCase().includes(needle)),
        `the pre-existing dev-loop law matching "${needle}" must survive`,
      ).toBe(true);
    }
  });
});
