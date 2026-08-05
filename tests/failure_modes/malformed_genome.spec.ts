// Failure mode: malformed agent profile JSON in agents/. Three variants:
//   (a) truncated JSON              → soft: recorded as a load_error naming the offending file.
//   (b) wrong type for a required field (primitives = string instead of array) → HARD.
//   (c) an agent missing required behavioral fields                            → HARD.
//
// TWO REGIMES, and the line between them is deliberate:
//
//   PARSE failure is soft (#129). A file that isn't JSON tells us nothing about the definition
//   it was meant to hold, so it is skipped and recorded and the rest of the genome still loads.
//
//   VALIDATION failure is HARD (src/loader.ts:236-241). A file that parses but describes an
//   illegal or incomplete agent HAS a definition, and it is a wrong one. Per the maintainer's
//   ruling on #254: "a single malformed agent should never be able to be in the genome in the
//   first place." A standard with a quietly-missing chair produces silently-wrong outputs, so
//   the load fails closed rather than half-loading.
//
// ── CONSCIOUSLY REWRITTEN (#254): (b) and (c) ────────────────────────────────────────────────
// Both cases previously asserted the SOFT regime — that a validation failure is recorded in
// `load_errors` while the load continues. That contradicted `src/loader.ts:236-241`, which
// hard-fails with the rationale stated in-code, AND contradicted tests/genome_cases.test.ts
// (:103,:107), which pins the hard-fail for these same two input classes and has been green
// throughout. Same inputs, opposite expectations, in one repo.
//
// It went undetected because `tests/failure_modes/` was executed by no npm script — the band
// rotted invisibly until #219 wired it into `verify`. These two cases PREDATE the #254 ruling;
// they are rewritten to assert the hard-fail rather than deleted or skipped, because the
// scenarios they cover are real and worth pinning — only their expectation was wrong.

import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupTempdirColtrane, type TempdirColtrane } from "../e2e/_harness.js";
import { loadGenome } from "../../src/loader.js";
import { CompositionError, GenomeIncompleteError } from "../../src/composition.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
void __dirname;

function seedCore(tempDir: string): void {
  const coreDir = join(tempDir, "core_types");
  mkdirSync(coreDir, { recursive: true });
  for (const [slug, primitive] of [
    ["Signal", "SENSE"],
    ["Interpretation", "INTERPRET"],
    ["Judgment", "JUDGE"],
    ["Plan", "PLAN"],
    ["Artifact", "CREATE"],
    ["Verdict", "VERIFY"],
  ] as const) {
    writeFileSync(
      join(coreDir, slug.toLowerCase() + ".json"),
      JSON.stringify({
        slug,
        primitive,
        description: "",
        schema: { type: "object", properties: {}, required: [] },
      }),
    );
  }
}

describe("failure mode: malformed agent profile JSON", () => {
  let env: TempdirColtrane;

  it("(a) truncated JSON → typed GenomeLoadError naming the file (NOT raw SyntaxError)", async () => {
    env = await setupTempdirColtrane();
    try {
      seedCore(env.tempDir);
      const agentsDir = join(env.tempDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      // missing trailing brace + closing bracket
      writeFileSync(
        join(agentsDir, "truncated.json"),
        '{ "slug": "truncated", "primitives": ["SENSE"',
      );

      const genome = loadGenome(env.tempDir);
      // soft-fail (#129): not thrown — recorded as a load_error naming the file.
      const failure = genome.load_errors.find(
        (e) => e.kind === "agent" && /truncated/i.test(e.path),
      );
      expect(failure, "malformed agent JSON should be a load_error naming the file").toBeDefined();
      expect(failure!.error, "load_error should explain the malformed JSON").toMatch(/JSON/i);
      // the broken agent must NOT have loaded
      expect(genome.agents.has("truncated")).toBe(false);
    } finally {
      env.cleanup();
    }
  }, 30_000);

  it("(b) wrong type for required field (primitives as string) → HARD-fails the load, naming the field", async () => {
    env = await setupTempdirColtrane();
    try {
      seedCore(env.tempDir);
      const agentsDir = join(env.tempDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "badtype.json"),
        JSON.stringify({ slug: "badtype", primitives: "SENSE" }),
      );

      // This file PARSES. It describes an agent whose `primitives` is a string where the
      // contract requires an array — a definition that exists and is wrong. It must not be
      // representable in a loaded genome at all, so the whole load fails closed.
      expect(() => loadGenome(env.tempDir)).toThrow(CompositionError);
      // …and the error must NAME the offending field, not just say "invalid".
      expect(() => loadGenome(env.tempDir)).toThrow(/primitives/i);
    } finally {
      env.cleanup();
    }
  }, 30_000);

  it("(c) agent missing required behavioral fields → HARD-fails the load, naming what is missing", async () => {
    env = await setupTempdirColtrane();
    try {
      seedCore(env.tempDir);
      const agentsDir = join(env.tempDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "extra.json"),
        JSON.stringify({
          slug: "extra",
          primitives: ["SENSE"],
          domain: "fwdcompat",
          // An unknown key IS forward-compatible and is dropped without complaint (asserted
          // below). What sinks this file is the absence of the REQUIRED behavioral fields —
          // identity/method/constraints/behavioral_primitives. An agent with no identity is a
          // hollow chair: it would run and seal outputs while representing nobody.
          mystery_future_field: 42,
        }),
      );

      expect(() => loadGenome(env.tempDir)).toThrow(GenomeIncompleteError);
      expect(() => loadGenome(env.tempDir)).toThrow(/identity/i);
    } finally {
      env.cleanup();
    }
  }, 30_000);

  it("(c2) forward-compat still holds: an unknown key on an OTHERWISE-VALID agent is dropped, not rejected", async () => {
    // The half of the original (c) that was right, kept and made unambiguous: rejecting a
    // definition for carrying a field a newer version understands would make the genome
    // impossible to roll forward. Only VALIDITY failures are fatal — unknown keys are not.
    env = await setupTempdirColtrane();
    try {
      seedCore(env.tempDir);
      const agentsDir = join(env.tempDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "fwd.json"),
        JSON.stringify({
          slug: "fwd",
          primitives: ["SENSE"],
          output_types: ["raw-note"],
          domain: "fwdcompat",
          identity: "a forward-compatible sensor",
          method: "sense the thing",
          constraints: [],
          behavioral_primitives: ["explorer", "analyst"],
          mystery_future_field: 42,
        }),
      );

      const g = loadGenome(env.tempDir);
      expect(g.agents.has("fwd"), "an unknown key must not sink a valid agent").toBe(true);
      expect(g.load_errors.filter((e) => e.slug === "fwd")).toEqual([]);
    } finally {
      env.cleanup();
    }
  }, 30_000);
});
