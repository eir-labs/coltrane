// THE VENUE'S WALLS — the two ACCEPTANCE GUARDS (INV12 the tree compiles; INV13 the schema change
// is additive). Unlike the enforcement invariants (INV1–INV11,INV15,INV16), these are GREEN BY
// DESIGN: they pin that the RED spec is well-formed — the seam symbols exist so every other red
// comes from an ABSENT body and never a missing symbol, and every shipped genome file loads and
// composes UNCHANGED under the extended schema. They would only RED under regression (a
// non-compiling seam, or a non-additive schema change).
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  realize, resolveAndRealize,
  strategyCapabilities, selectStrategy, isContained, sealTouchesOnlyWorkspace, allocatePorts,
} from "../../src/venue_realize.js";
import { VenueSchema, zodToMcpProps } from "../../src/genome_schema.js";
import { loadGenome } from "../../src/loader.js";
import { checkInstitutionAdmissibility } from "../../src/institution_enforcement.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

describe("venue walls — INV12: the tree compiles, so RED comes from absent bodies not missing symbols", () => {
  it("INV12 every walls-seam symbol exists and is callable (throwing-stub, not undefined)", () => {
    // If the seam had not compiled, this module would not import — reaching here proves tsc was clean.
    for (const fn of [realize, resolveAndRealize, strategyCapabilities, selectStrategy, isContained, sealTouchesOnlyWorkspace, allocatePorts]) {
      expect(typeof fn).toBe("function");
    }
    // The unimplemented walls primitives throw (RED comes from the THROW, not a ReferenceError).
    expect(() => strategyCapabilities("worktree")).toThrow(/NOT IMPLEMENTED/);
    expect(() => selectStrategy([], { id: "h", capabilities: [], strategies: [] })).toThrow(/NOT IMPLEMENTED/);
    expect(() => isContained("/ws", "/ws/a")).toThrow(/NOT IMPLEMENTED/);
    expect(() => sealTouchesOnlyWorkspace("/ws", [])).toThrow(/NOT IMPLEMENTED/);
    expect(() => allocatePorts({ count: 1 }, [])).toThrow(/NOT IMPLEMENTED/);
  });
});

describe("venue walls — INV13: the schema change is additive; shipped files load and compose unchanged", () => {
  it("INV13 both shipped venue files parse under the extended schema with workspace/ports absent (deny-by-default)", () => {
    for (const file of ["empty-room-v1.json", "ci-deploy-room-v1.json"]) {
      const raw = JSON.parse(readFileSync(join(REPO, "venues", file), "utf8"));
      const parsed = VenueSchema.safeParse(raw);
      expect(parsed.success, `${file} must still parse under the extended VenueSchema`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.workspace, `${file} declares no workspace ⇒ undefined (private ephemeral at realize time)`).toBeUndefined();
        expect(parsed.data.ports, `${file} declares no ports ⇒ undefined (none allocated)`).toBeUndefined();
      }
    }
  });

  it("INV13 the MCP venue_define surface stays generated from the schema (new fields advertised, no drift)", () => {
    const props = Object.keys(zodToMcpProps(VenueSchema));
    expect(props).toContain("workspace");
    expect(props).toContain("ports");
  });

  it("INV13 the whole genome still loads, and institutions/coltrane.json still passes admissibility", () => {
    const genome = loadGenome(REPO);
    expect(genome.venues.size).toBeGreaterThan(0);
    const coltrane = JSON.parse(readFileSync(join(REPO, "institutions", "coltrane.json"), "utf8"));
    const verdict = checkInstitutionAdmissibility({ institution: coltrane.institution, chairs: coltrane.chairs });
    expect(verdict.admitted, "coltrane.json must remain admissible under the additive schema").toBe(true);
  });
});
