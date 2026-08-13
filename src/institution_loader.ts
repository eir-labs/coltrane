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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
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
import {
  InstitutionSchema,
  OrganizationSchema,
  AgentRecordSchema,
  OrgMemberSchema,
  InstitutionalChairSchema,
  ChairAssignmentSchema,
  ForebearSchema,
  LineageEdgeSchema,
  NorthstarSchema,
} from "./genome_schema.js";
import { checkInstitutionAdmissibility } from "./institution_enforcement.js";

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
export function loadInstitutions(root: string): {
  institutions: Map<string, LoadedInstitution>;
  load_errors: LoadError[];
} {
  const institutions = new Map<string, LoadedInstitution>();
  const load_errors: LoadError[] = [];
  const dir = join(root, "institutions");
  // Absent institutions/ is the empty class, exactly as readJsonDir treats a missing directory —
  // not an error. Nothing to read, nothing to gate.
  if (!existsSync(dir)) return { institutions, load_errors };

  // The first path a slug was admitted from, so a duplicate can name where the winner came from —
  // the venues/charts idiom (loader.ts venue_paths / chart_paths).
  const slug_paths = new Map<string, string>();

  for (const name of readdirSync(dir)) {
    if (extname(name) !== ".json") continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;

    // (a) READ + PARSE. A file that cannot be read or is malformed JSON becomes ONE institution
    // load_error and drops out; the loop keeps reading siblings (per-file soft-fail). The FS read
    // itself does not throw the whole load — it is one document's failure, not the directory's.
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (e) {
      load_errors.push({ kind: "institution", path, slug: null, error: `failed to read ${path}: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      load_errors.push({ kind: "institution", path, slug: null, error: `malformed JSON at ${path}: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    // (b) VALIDATE each present section against its per-section Zod schema (no composite schema —
    // the one-Zod-source discipline). A schema-invalid section makes the WHOLE document one
    // load_error and drops it out. A best-effort slug is read straight off the raw document so the
    // error names it even when the institution section did not validate.
    const rawSlug = readRawSlug(parsed);
    let document: InstitutionDocumentSections;
    try {
      document = validateSections(parsed);
    } catch (e) {
      load_errors.push({ kind: "institution", path, slug: rawSlug, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const slug = document.institution.slug;

    // (c) DUPLICATE slug fails closed on the collision: keep the first, record the later as one
    // load_error.
    if (slug_paths.has(slug)) {
      load_errors.push({ kind: "institution", path, slug, error: `duplicate institution slug "${slug}" (first seen in ${slug_paths.get(slug)})` });
      continue;
    }

    // (d) ADMISSIBILITY gate, fail-closed. An inadmissible document does NOT enter the map; its
    // offenders are recorded as one load_error whose message carries EVERY offender.ref (collect-all
    // — never a count or a truncation), so the operator sees the full refusal through system_health.
    const verdict = checkInstitutionAdmissibility({ institution: document.institution, chairs: document.chairs ?? [] });
    if (!verdict.admitted) {
      const detail = verdict.offenders.map((o) => `${o.ref}: ${o.reason}`).join(" | ");
      load_errors.push({ kind: "institution", path, slug, error: `institution "${slug}" is inadmissible — ${detail}` });
      continue;
    }

    // (e) ADMITTED — carried in the loaded genome, keyed by slug.
    institutions.set(slug, { slug, document });
    slug_paths.set(slug, path);
  }

  return { institutions, load_errors };
}

/** The best-effort slug read from a raw parsed document, for load_error attribution when the
 *  institution section itself failed validation (a validated slug is not yet available). */
function readRawSlug(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const inst = (parsed as Record<string, unknown>).institution;
  if (inst === null || typeof inst !== "object") return null;
  const slug = (inst as Record<string, unknown>).slug;
  return typeof slug === "string" ? slug : null;
}

const zodWhy = (issues: readonly { path: (string | number)[]; message: string }[]): string =>
  issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

/** The optional array sections, each validated element-wise against its already-authored per-section
 *  schema. Kept in one table so a new section is one row, not a new branch. */
const ARRAY_SECTIONS = [
  ["organizations", OrganizationSchema],
  ["agent_records", AgentRecordSchema],
  ["org_members", OrgMemberSchema],
  ["chairs", InstitutionalChairSchema],
  ["assignments", ChairAssignmentSchema],
  ["forebears", ForebearSchema],
  ["lineage_edges", LineageEdgeSchema],
  ["northstars", NorthstarSchema],
] as const;

/**
 * Validate a parsed institution document section-by-section against the existing per-section Zod
 * schemas (loss-free — the parsed data IS the carried view). The `institution` section is required;
 * every array section is optional and an ABSENT one is empty, not an error. Any invalid section
 * throws so the whole document drops out as one load_error — a single defective section must not
 * admit a half-validated document into the genome.
 */
function validateSections(parsed: unknown): InstitutionDocumentSections {
  const doc = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const inst = InstitutionSchema.safeParse(doc.institution);
  if (!inst.success) throw new Error(`institution section invalid — ${zodWhy(inst.error.issues)}`);
  // `institution` is present at construction so the required field is provably there — no whole-object
  // cast is needed. The optional array sections are written through a Record view because the table is
  // keyed dynamically; each value was just validated element-wise by its per-section schema.
  const out: InstitutionDocumentSections = { institution: inst.data };
  const sink = out as unknown as Record<string, unknown>;
  for (const [key, schema] of ARRAY_SECTIONS) {
    if (doc[key] === undefined) continue; // absent optional section = empty, not an error
    const arr = z.array(schema).safeParse(doc[key]);
    if (!arr.success) throw new Error(`section "${key}" invalid — ${zodWhy(arr.error.issues)}`);
    sink[key] = arr.data;
  }
  return out;
}
