// Skills — OPEN questions (committed, unresolved). These aren't failures and they aren't
// "not yet written": each is a real question whose CONTRACT isn't grounded yet. Committing
// them in the test substrate (next to the RED pre-registration) makes the unresolved space
// formal — an LLM (or human) picking up skills sees exactly what's undecided and the shape
// of resolving it. Resolve OPEN -> RED by writing the `resolves_when` assertion; then -> GREEN.
import { describe } from "vitest";
import { open } from "./_support/open.js";

describe("skills: open questions", () => {
  open("skill runtime dependencies", {
    question: "How does a skill declare and bound a non-stdlib runtime dependency without breaking the zero-dependency-but-Claude-Code posture?",
    resolves_when: "loadSkillPackage validates a declared `runtime_deps` allowlist and the executor provisions only those — a test asserts a skill importing an undeclared module fails to load loudly.",
    grounding: "docs/skills-as-first-class.md → Open questions #2 (decision owner)",
  });

  open("determinism_ratio from sealed records", {
    question: "How does field-origin (code vs model) flow from the runtime through the output store so determinism_ratio is computable from sealed records, not stubs?",
    resolves_when: "a resolved skill appends a record whose field_origins the recorder seals, and computeDeterminismRatio reads them — skill_determinism_ratio.test.ts turns green from real records.",
    grounding: "docs/skills-as-first-class.md → Open questions #3 + Phase 3; the agent ledger's field-origin precedent",
  });

  open("fixtures for a pure-reasoning skill", {
    question: "What does a fixture assert for a v1 pure-reasoning skill whose output is model-produced (non-deterministic), so it still RUNS as a contract rather than a deterministic equals?",
    resolves_when: "a fixture carries shape/contract assertions (exists / is_type / matches), and the runner evaluates a reasoning skill's output against them in eval mode — a test runs one such fixture as a contract that fails until the output satisfies the shape.",
    grounding: "this thread (2026-06-11) + the determinism gradient (v1 ~10%, code returns null); the existing assertion ops in skill_subprocess.checkAssertion",
  });

  open("retire the flat {slug, md} skill format", {
    question: "Should every skill be a package (skills/<slug>/), with the pre-package flat {slug, md} JSON removed entirely — no backwards-compat coexistence?",
    resolves_when: "the loader loads ONLY skills/<slug>/ packages; the existing flat skills (summarize-tight, diamond-cutting-discipline) are migrated to packages; a test asserts a flat-JSON skill no longer loads.",
    grounding: "this thread (2026-06-11, Eugene: no backwards-compat) + the agent migration precedent (lean agents hard-fail, flat format retired)",
  });

  open("fixtures-mandatory completeness gate for skills", {
    question: "Does a genome skill with no fixtures (or no halves) HARD-fail the load, the way a lean agent does — fixtures being the skill's pre-registered contract, cheapest at creation?",
    resolves_when: "loadGenome hard-fails a fixture-less / empty skill package (re-thrown, not soft-skipped); a test asserts an incomplete skill blocks the load while a complete one loads.",
    grounding: "this thread + the agent GenomeIncompleteError precedent (incomplete = upgrade, not skip); docs/skills-as-first-class.md (fixtures as the skill's tests)",
  });

  open("when a skill earns determinism (auto-promotion)", {
    question: "At what evidence threshold does the evolve loop propose moving a resolved field from model to code, and who approves it?",
    resolves_when: "learning over sealed records proposes a code patch with a measured determinism delta + sample size, gated by a fixture-preserving check — a test drives N recorded resolutions and asserts a proposal is (or isn't) emitted at the threshold.",
    grounding: "docs/skills-as-first-class.md → Evolution guardrails; learning_synthesize as the loop's home",
  });
});
