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
  // The lineage-pass senses (lineage-pass-v1): two seats under least authority. The external
  // scout's substrate is the web (prior-art / precedent / canonical corpora); the internal scout's
  // is our own file store (the genome and working tree) — read via Read/Glob/Grep, which resolve in
  // any environment (the eir-wiki is not open source, so the OSS internal sense reads files only).
  // Both are declared here so the floor ENFORCES retrieval discipline + a real grant on each, rather
  // than the agent files carrying those constraints voluntarily. Their grants are disjoint by design
  // — neither can reach the other's substrate.
  "lineage-scout-external": "web (formal-lineage corpora: papers, precedent, canonical texts)",
  "lineage-scout-internal": "filesystem (the genome and working tree)",
  // The default genome's reading seat: the only one of the three named seats that holds a
  // grant at all, and the reason it holds one is that its substrate is outside the run.
  // Declared here so the floor test ENFORCES retrieval discipline + a real grant on it,
  // rather than the agent file carrying those constraints voluntarily.
  john: "filesystem (the working tree or corpus under examination)",
  "provenance-scout": "filesystem (the user's own corpus)",
  // The preview-deploy pair (sealed gig 0538105e): the branch reader's substrate is the
  // working tree's git refs; the deploy seat's substrate is the Vercel REST API. Declaring
  // both here makes the floor ENFORCE retrieval discipline + a real grant on each, rather
  // than the agent files carrying those constraints voluntarily.
  "deploy-scout": "filesystem (the working tree's git refs)",
  "deploy-agent": "Vercel REST API (api.vercel.com)",
  // The software-change-pr publish seat: its substrate is git and GitHub — the branch it
  // pushes and the PR it opens, every fact it seals (branch, commit sha, PR url and number)
  // coming from a git or gh call in the run. Declared here so the floor ENFORCES retrieval
  // discipline + a real grant on it, exactly as it does for deploy-agent, rather than the
  // agent file carrying those constraints voluntarily.
  "pr-publisher": "git + GitHub (gh CLI) — the branch it pushes and the PR it opens",
  // The defect-investigator (defect-investigation-v1): its substrate is the working tree and a
  // subprocess — it reproduces a failing case with Bash and reads code with Read/Glob/Grep, and
  // every location and sweep result it seals must come from a tool result in the run. Declared
  // here so the floor ENFORCES retrieval discipline + a real grant on it.
  "defect-investigator": "filesystem + subprocess (the working tree and the failing case it reproduces)",
  // The spec-drafting grounder (spec-drafting-v1): its substrate is the web AND our own file store —
  // it runs a lineage pass over prior art on the internet (how the subsystem is built, and how to
  // verify it formally) and over our codebase/records, and every source it seals must come from a
  // WebSearch/WebFetch or a file read in the run. Declared here so the floor ENFORCES retrieval
  // discipline + a real grant on it.
  grounder: "web (prior art + verification method) + filesystem (our codebase and records)",
  // The red-spec-drafter (spec-drafting-v1): reads the target codebase to write real RED tests
  // against real callsites, so every callsite and invariant it encodes is grounded in a file read
  // in the run, not recalled. Declared external so the floor enforces retrieval discipline + a grant.
  "red-spec-drafter": "filesystem (the target codebase the red tests are written against)",
  // The change-verifier (software-change-pr-v1's verify seat, re-seated from a reasoning judge to a
  // test-runner): its substrate is a subprocess and the working tree — it APPLIES the change-set and
  // RUNS the tests, and every pass/fail it seals must come from a real run (git apply + the suite),
  // never from argument. Declared external so the floor ENFORCES retrieval discipline + a real grant
  // on it — the verdict has to be executed, not reasoned. This is the fix for the hollow-verify seam:
  // the seat that says whether the change is correct is now the seat that ran it.
  "change-verifier": "filesystem + subprocess (the working tree it applies the change-set into, and the test run that grounds the verdict)",
  // The code-implementer (software-change-pr-v1's write seat, inverted from a grant-less content
  // emitter to a seat that WRITES directly): its substrate is the working tree — it writes the
  // change with Write/Edit and captures the real diff with git, so the change lands as actual
  // files rather than a hand-authored patch someone else must apply. Declared external so the
  // floor ENFORCES retrieval discipline + a real grant on it. The cage is the isolated tree, not
  // the absence of write tools.
  "code-implementer": "filesystem (the isolated working tree it writes the change into and captures the diff from)",
  // The spec-publisher (spec-drafting-v1's terminal seat): its substrate is git and GitHub — it
  // commits the RED spec the red-spec-drafter wrote and opens one PR, every fact it seals (branch,
  // commit sha, PR url and number) coming from a git or gh call in the run. The PR's CI is red by
  // design; the gate on publishing is the spec-review verdict, not the test run. Declared external
  // so the floor ENFORCES retrieval discipline + a real grant on it, exactly as for pr-publisher.
  "spec-publisher": "git + GitHub (gh CLI) — the branch it pushes and the RED-spec PR it opens",
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
