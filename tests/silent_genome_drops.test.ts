// Three ways the genome silently accepts something it should refuse. Different files, one
// disease — the loader reports `load_errors: []` and the defect only surfaces later, as a
// seal abort or a run that should never have been dispatchable.
//
//   #272  a domain type NAMED after a core inverts the core-agreement verdict, and the
//         error asserts something untrue about the registry.
//   #264  a subtype that overloads its core's floor field to an incompatible type is
//         UNSEALABLE under any payload, and nothing detects it.
//   #203  `status: "deprecated"` on a standard is dropped, so a retired standard stays
//         dispatchable and nothing says otherwise.
import { describe, it, expect } from "vitest";
import { createRegistry, CORE_TYPES, type DomainType } from "../src/index.js";
import { loadGenome } from "../src/loader.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_BEHAVIOR } from "./_support/agents.js";

/** A genome root on disk with the given files, so the LOADER is what is under test. */
function genomeRoot(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "genome-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, JSON.stringify(body, null, 2));
  }
  return root;
}

const errorText = (g: { load_errors: unknown[] }): string =>
  g.load_errors.map((e) => JSON.stringify(e)).join(" | ");

// ── #272 ────────────────────────────────────────────────────────────────────
describe("#272 — a domain type must not be named after a core type", () => {
  // `coreTypeOf` short-circuits on CORE_TYPES before consulting the registry, so a type
  // registered as `Signal` resolves to "Signal" on its NAME while the registry says it
  // extends something else. The core-agreement check (#263) then inverts: the contradicted
  // pair seals and the correct pair is refused, with an error asserting something about the
  // registry that is not true.
  //
  // Rejecting the name makes the ambiguity unrepresentable, which is cheaper than teaching
  // every resolver to disambiguate it.
  it("the loader refuses a domain type whose slug is a core name", () => {
    const root = genomeRoot({
      "domain_types/Signal.json": {
        slug: "Signal",
        version: 1,
        extends: "Interpretation",
        domain: "demo",
        schema: { properties: { t: { type: "string" } } },
        required_fields: ["t"],
      },
    });
    try {
      const g = loadGenome(root);
      expect(g.load_errors.length, "a core-named domain type must not load silently").toBeGreaterThan(0);
      expect(errorText(g)).toMatch(/Signal/);
      expect(errorText(g), "say WHY, not just that it failed").toMatch(/core type/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A self-referential alias is NOT the defect: `{slug:"Signal", extends:"Signal"}` makes
  // both resolutions agree, and several suites use it as shorthand for a bare core.
  it("allows a bare-core alias, where the name and extends agree", () => {
    const reg = createRegistry();
    expect(() =>
      reg.registerType({
        slug: "Signal", extends: "Signal", domain: "demo",
        schema: { properties: { value: { type: "string" } } }, required_fields: [],
      } as DomainType),
    ).not.toThrow();
  });

  it("registerType refuses it too — the loader is not the only door", () => {
    const reg = createRegistry();
    // Skip Interpretation itself: slug === extends there, which is the legal alias above.
    for (const core of CORE_TYPES.filter((c) => c !== "Interpretation")) {
      expect(
        () =>
          reg.registerType({
            slug: core,
            extends: "Interpretation",
            domain: "demo",
            schema: { properties: {} },
            required_fields: [],
          } as DomainType),
        `"${core}" is a core name and must not be usable as a domain slug`,
      ).toThrow();
    }
  });

  it("still accepts an ordinary domain type", () => {
    const reg = createRegistry();
    expect(() =>
      reg.registerType({
        slug: "soft-verdict",
        extends: "Interpretation",
        domain: "demo",
        schema: { properties: { t: { type: "string" } } },
        required_fields: ["t"],
      } as DomainType),
    ).not.toThrow();
  });
});

// ── #264 ────────────────────────────────────────────────────────────────────
describe("#264 — a subtype cannot overload its core's floor field into something unsealable", () => {
  // `{...baseProps, ...ownProps}` lets the subtype's declaration win silently. Overload
  // `steps` to a string and no payload can satisfy both the merged schema and the Plan
  // floor — the type is unsealable FOREVER, the genome loads clean, and the first symptom
  // is a seal abort at a terminal phase.
  it("refuses a floor field redeclared with an incompatible type", () => {
    const root = genomeRoot({
      "domain_types/fix-plan.json": {
        slug: "fix-plan",
        version: 1,
        extends: "Plan",
        domain: "demo",
        // Plan's floor `steps` is an array; a string can never satisfy it.
        schema: { properties: { steps: { type: "string" } } },
        required_fields: ["steps"],
      },
    });
    try {
      const g = loadGenome(root);
      expect(g.load_errors.length, "an unsealable type must not load clean").toBeGreaterThan(0);
      expect(errorText(g)).toMatch(/steps/);
      expect(errorText(g), "name the core it contradicts").toMatch(/Plan/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A NARROWING is legitimate and must keep working — `grant-opportunity` narrows Signal's
  // `source` to an 8-value enum, which strengthens the floor rather than voiding it.
  it("allows a redeclaration that narrows rather than contradicts", () => {
    const root = genomeRoot({
      "domain_types/scoped-signal.json": {
        slug: "scoped-signal",
        version: 1,
        extends: "Signal",
        domain: "demo",
        schema: { properties: { source: { type: "string", enum: ["nih", "nsf"] } } },
        required_fields: ["source"],
      },
    });
    try {
      const g = loadGenome(root);
      expect(errorText(g), "narrowing a floor field is not overloading it").not.toMatch(/scoped-signal/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves a subtype that does not touch its floor field alone", () => {
    const root = genomeRoot({
      "domain_types/plain.json": {
        slug: "plain",
        version: 1,
        extends: "Judgment",
        domain: "demo",
        schema: { properties: { note: { type: "string" } } },
        required_fields: ["note"],
      },
    });
    try {
      expect(errorText(loadGenome(root))).not.toMatch(/plain/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── #203 ────────────────────────────────────────────────────────────────────
describe("#203 — a deprecated standard is not silently dispatchable", () => {
  // The loader strips fields the schema does not model, so `status` on a standard vanished
  // — an operator could mark one deprecated, see it accepted, and watch it keep running.
  // The same silent-drop shape as the rest of this file.
  it("keeps `status` on a loaded standard instead of dropping it", () => {
    const root = genomeRoot({
      "domain_types/note.json": {
        slug: "note", version: 1, extends: "Signal", domain: "demo",
        schema: { properties: { t: { type: "string" } } }, required_fields: ["t"],
      },
      "agents/scout.json": {
        slug: "scout", version: 1, domain: "demo", primitives: ["SENSE"],
        input_types: [], output_types: ["note"],
        description: "d", status: "active", ...TEST_BEHAVIOR,
      },
      "standards/retired.json": {
        slug: "retired",
        domain: "demo",
        status: "deprecated",
        agent_slugs: ["scout"],
        phases: [{ name: "p", chairs: [{ role: "r", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
      },
    });
    try {
      const g = loadGenome(root);
      const std = g.standards.get("retired") as { status?: string } | undefined;
      expect(std, "the standard should still load").toBeTruthy();
      expect(
        std?.status,
        "a deprecation an author wrote down must survive the loader — dropping it is how a " +
          "retired standard stays dispatchable with nobody the wiser",
      ).toBe("deprecated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults to active when nothing is declared", () => {
    const root = genomeRoot({
      "domain_types/note.json": {
        slug: "note", version: 1, extends: "Signal", domain: "demo",
        schema: { properties: { t: { type: "string" } } }, required_fields: ["t"],
      },
      "agents/scout.json": {
        slug: "scout", version: 1, domain: "demo", primitives: ["SENSE"],
        input_types: [], output_types: ["note"],
        description: "d", status: "active", ...TEST_BEHAVIOR,
      },
      "standards/live.json": {
        slug: "live",
        domain: "demo",
        agent_slugs: ["scout"],
        phases: [{ name: "p", chairs: [{ role: "r", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
      },
    });
    try {
      const std = loadGenome(root).standards.get("live") as { status?: string } | undefined;
      expect(std?.status).toBe("active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
