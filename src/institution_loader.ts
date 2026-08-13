// Institution LOADER seam — the reader that makes institutions/ a loaded genome class, and the
// point at which checkInstitutionAdmissibility is INVOKED rather than merely available.
//
// The defect this closes is the enforcement PR's own thesis turned on itself: PR #335 shipped a
// four-valued s-expression evaluator and checkInstitutionAdmissibility (both green), but
// institutions/ has NO reader in src/ — grep loader.ts and the only `institution` hit is a venue
// comment — so the gate is invoked ONLY by tests. CI catches a bad document at merge; nothing
// catches one at load, from the org store, or authored through a future institution_define.
//
// RED-SEAM STATUS. This module ships the SIGNATURE and the carried-shape, with a body that THROWS —
// exactly as src/institution_enforcement.ts shipped its evaluator/admissibility seam. The GREEN PR
// fills the body (read institutions/*.json, validate each section against the existing per-section
// Zod schemas, invoke the admissibility gate fail-closed, drop an inadmissible/malformed document
// out into a load_error of kind "institution") and wires the call into loadGenome AFTER the
// agents/standards/venues/charts/organization maps exist. Until then loadGenome carries an EMPTY
// institutions map, and the red tests in tests/institution_loader.test.ts /
// tests/institution_load_gate.test.ts fail because the READER and the CALL are absent — never
// because a file fails to typecheck.
import type { LoadError } from "./loader.js";
import type {
  InstitutionOutput,
  OrganizationOutput,
  AgentRecordOutput,
  InstitutionalChairOutput,
  ChairAssignmentOutput,
  ForebearOutput,
  LineageEdgeOutput,
  NorthstarOutput,
} from "./genome_schema.js";

/** The multi-section institution document as it lives on disk (shape per institutions/quartet.json).
 *  Each present section is validated LOSS-FREE against its already-authored per-section schema in
 *  src/genome_schema.ts; an absent optional section is treated as empty, not as an error. This IS
 *  the `definition` a store row carries (see docs spec ITEM 4) — file and store backings share it so
 *  they cannot drift. */
export interface InstitutionDocumentSections {
  institution: InstitutionOutput;
  organizations?: readonly OrganizationOutput[];
  agent_records?: readonly AgentRecordOutput[];
  org_members?: readonly { org_slug: string; agent_slug: string }[];
  chairs?: readonly InstitutionalChairOutput[];
  assignments?: readonly ChairAssignmentOutput[];
  forebears?: readonly ForebearOutput[];
  lineage_edges?: readonly LineageEdgeOutput[];
  northstars?: readonly NorthstarOutput[];
}

/** A validated, ADMITTED institution carried in the loaded genome, keyed by institution slug.
 *  Only documents that (a) parse, (b) validate section-by-section, and (c) pass
 *  checkInstitutionAdmissibility appear here — an inadmissible one fails closed into a load_error. */
export interface LoadedInstitution {
  slug: string;
  document: InstitutionDocumentSections;
}

/**
 * SEAM (RED — body throws). Read every institutions/*.json under `root`, validate each present
 * section against its per-section schema, invoke checkInstitutionAdmissibility on the schema-valid
 * document, and return the admitted institutions keyed by slug PLUS one load_error of kind
 * "institution" per file that is malformed, schema-invalid, inadmissible, or a duplicate slug.
 *
 * TOTAL by contract: the GREEN body must never throw for an institution reason — a bad document is
 * a per-file load_error and drops out; the rest of the genome loads. Deliberately NOT wired into
 * loadGenome yet: wiring it (after the agent/standard/org maps exist) is the GREEN change these red
 * tests demand. Until then this throws, so the tree compiles and red is honest.
 */
export function loadInstitutions(_root: string): {
  institutions: Map<string, LoadedInstitution>;
  load_errors: LoadError[];
} {
  throw new Error(
    "loadInstitutions: institution loader not implemented (RED seam for the institution-loader + " +
      "admissibility-gate spec). GREEN must read institutions/*.json, validate each section against " +
      "the genome_schema.ts per-section schemas, invoke checkInstitutionAdmissibility fail-closed, and " +
      "record a load_error of kind \"institution\" per malformed/invalid/inadmissible/duplicate file.",
  );
}
