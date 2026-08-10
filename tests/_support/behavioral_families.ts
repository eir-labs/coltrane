// Behavioral families — the inheritance mechanism for genome agents, as DATA + TEST,
// not as an engine feature.
//
// The family axis is not a new taxonomy: it's derived from what each agent already
// declares — its primitives and its substrate. A SENSE agent over an external substrate
// owes retrieval discipline and a real tool grant; a JUDGE owes evidence discipline; a
// CREATE owes no-new-facts discipline; a VERIFY owes ran-vs-reasoned discipline.
//
// Inheritance works in two halves:
//   1. AUTHORING — these canonical strings are expanded VERBATIM into each agent file,
//      so every agent file remains a self-contained, fully sealed behavioral contract.
//   2. ENFORCEMENT — tests/genome_behavioral_floor.test.ts asserts every agent carries
//      the families its primitives owe. The test IS the inheritance; it cannot drift.
//
// Changing a family string here without re-authoring the agent files turns the floor
// test red — that's the point.

/** The anti-confabulation floor. Every agent, no exceptions. */
export const FLOOR = [
  "Ground every claim in your inputs or a tool result from this run; mark anything else as unverified rather than asserting it.",
  "If your inputs are insufficient for the task, say so in the output (a caveat field or equivalent) — do not fill gaps by invention.",
] as const;

/** Agents whose substrate is external (web, filesystem, registry, subprocess). */
export const RETRIEVAL = [
  "Every external fact you emit (citation, URL, date, quote, measurement) must come from a tool call in this run — never from memory alone.",
  "If you cannot retrieve it, mark it explicitly as unverified (or omit it) and record what you tried.",
  "Record the source locator (tool + path/URL/query) alongside each retrieved fact.",
] as const;

/** Verdict-producing agents (JUDGE primitive). */
export const JUDGE_FAMILY = [
  "Judge only what your inputs contain; cite the specific upstream fields or ids your verdict rests on.",
  "Report a failing verdict plainly — never soften, average away, or reframe a failure to pass.",
] as const;

/** Artifact-producing agents (CREATE primitive). */
export const MAKER = [
  "Create only from upstream inputs and the declared task context; introduce no new external facts.",
  "Where the creation makes a non-obvious choice, record the rationale alongside it.",
] as const;

/** Verification-bearing agents (VERIFY primitive). */
export const VERIFY_FAMILY = [
  "Prefer deterministic checks over reasoning; state which checks actually ran versus what was inferred.",
  "Report failures verbatim (messages, counts, names), not summaries of them.",
] as const;

/** Transforming agents (INTERPRET + PLAN, without CREATE): reshape upstream content. */
export const SHAPER = [
  "Preserve the upstream content's meaning; every transformation must be traceable to the input.",
  "Name what you removed or reshaped, and why.",
] as const;

/** Agents whose substrate is external — they owe RETRIEVAL constraints AND a tool grant.
 *  (Other SENSE agents are input-grounded: their substrate IS the gig input.) */
export const EXTERNAL_SUBSTRATE: Record<string, string> = {
  "prior-art-scout": "web + USPTO PatentsView (prior-art corpora)",
  "patent-browser-scout": "USPTO Patent Public Search (caged browser)",
  "novelty-searcher": "web (prior-art corpora)",
  "source-walker": "filesystem (local sources)",
  "domain-explorer": "coltrane registry (types, tools, charter, history)",
  "e2e-runner": "subprocess (test harness)",
  "lineage-scout": "web (formal-lineage corpora: papers, canonical texts)",
  // The default genome's reading seat: the only one of the three named seats that holds a
  // grant at all, and the reason it holds one is that its substrate is outside the run.
  // Declared here so the floor test ENFORCES retrieval discipline + a real grant on it,
  // rather than the agent file carrying those constraints voluntarily.
  john: "filesystem (the working tree or corpus under examination)",
  "provenance-scout": "filesystem (the user's own corpus)",
};

/** Agents that act through tools (grants required) even where retrieval isn't the job. */
export const GRANT_REQUIRED: readonly string[] = [
  ...Object.keys(EXTERNAL_SUBSTRATE),
  "problem-definer",
  "solution-developer",
  "delivery-finalizer",
];

/** The migration-stub shape that the re-authoring retires. A method matching this is
 *  a restatement of the agent's name, not a step-by-step. */
export const METHOD_STUB_RE = /^Carry out the .+ role:/i;
