// A PATCH FIELD CARRIES A PATCH, NOT A SENTENCE ABOUT ONE.
//
// `red-spec.diffs[].patch` was typed `{ "type": "string" }` — anything at all. The
// spec-drafting-v1 review chair reads test bodies OUT OF THOSE DIFFS: its method says "read each
// red test in the diffs and confirm it asserts the contract's behavior against a real callsite".
// So the diffs are not documentation of the change, they are the EVIDENCE the gate adjudicates.
//
// Observed on gig 34ff466b (the local-queue contract): every patch sealed as a one-line summary —
//
//   "new file mode 100644 (231 lines) — full unified diff captured from `git diff --cached` this
//    run; content present verbatim in the working tree at this path"
//
// — which is a true sentence and useless as evidence. The reviewer refused, correctly, marking
// NON-TAUTOLOGY and REDNESS "NOT RUN" because it had nothing to read. The gate did not fail; it
// was starved. And the seal accepted the starvation silently, because the type asked only for a
// string.
//
// This is the shape this codebase keeps closing: a field that exists to carry evidence, holding
// prose ABOUT the evidence, with nothing that can tell the difference. Same as an archive grade
// guarded by a well-formed date, same as `validated` being read as `sealed`.
//
// THE DISCRIMINATOR IS STRUCTURAL, NOT SEMANTIC. A unified diff of an added file has one `+` line
// per added line; the observed prose had ZERO newlines. So: a patch must contain a line beginning
// with `+` or `-`. That is checkable, cheap, and cannot be satisfied by a fluent sentence. It does
// NOT try to judge whether the diff is honest — only that a diff is what was supplied.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry } from "../src/registry.js";
import { loadGenome } from "../src/loader.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const genome = loadGenome(REPO_ROOT);
const registry = createRegistry([...genome.domain_types.values()] as never);

const REAL_PATCH =
  "new file mode 100644\n--- /dev/null\n+++ b/tests/x.test.ts\n@@ -0,0 +1,2 @@\n" +
  '+import { it } from "vitest";\n+it("x", () => { expect(1).toBe(1); });';
const PROSE_PATCH =
  "new file mode 100644 (231 lines) — full unified diff captured from `git diff --cached` this " +
  "run; content present verbatim in the working tree at this path";

const redSpec = (patch: string) => ({
  core_type: "Artifact",
  domain_type: "red-spec",
  primitive: "CREATE",
  domain: "spec-drafting",
  data: {
    validation_criteria: ["every invariant has a failing test"],
    input_refs: ["grounding-dossier-x"],
    coverage_map: [{ invariant_id: "I1", test_name: "x asserts", test_file: "tests/x.test.ts" }],
    testing_method: "property-based where universal",
    diffs: [{ path: "tests/x.test.ts", patch }],
  },
});

describe("red-spec.diffs[].patch carries a patch", () => {
  it("the type ships and the fixture is well-formed — the law is not vacuous", () => {
    const dt = genome.domain_types.get("red-spec");
    expect(dt, "domain_types/red-spec.json is not loaded").toBeDefined();
    const items = (dt!.schema as { properties?: Record<string, { items?: unknown }> })
      .properties?.["diffs"]?.items;
    expect(items, "red-spec declares no diffs[].items shape").toBeDefined();
  });

  it("ACCEPTS a real unified diff — the constraint does not reject legitimate evidence", () => {
    const v = registry.validate(redSpec(REAL_PATCH) as never);
    expect(v.valid, `a real patch was refused: ${JSON.stringify(v)}`).toBe(true);
  });

  it("REFUSES a one-line summary standing in for the diff — prose is not evidence", () => {
    const v = registry.validate(redSpec(PROSE_PATCH) as never);
    expect(
      v.valid,
      "a patch consisting of a sentence ABOUT the diff was accepted — the review chair reads test " +
        "bodies out of this field, so a summary here starves the gate rather than informing it",
    ).toBe(false);
  });
});
