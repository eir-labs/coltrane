import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { domainTypeDefect } from "./registry.js";
import { join, extname, resolve, isAbsolute, dirname } from "node:path";
import { createRequire } from "node:module";
import { defineAgent, composeStandard, CompositionError, GenomeIncompleteError, type Agent, type AgentDef, type Standard, type PhaseDef } from "./composition.js";
import { loadSkillPackage, SkillLoadError } from "./skills.js";
import { SkillSchema, EvalSchema, DomainTypeSchema, VenueSchema, ChartSchema, venueDefect, type SkillOutput, type EvalOutput, type DomainTypeOutput, type ChartInput, type VenueInput } from "./genome_schema.js";
import { composeChart, chartEntrySeedTypes, type Chart, type Venue } from "./chart.js";
import type { Primitive } from "./core_types.js";
import { CANONICAL_CORE_TYPES } from "./canonical_core_types.js";
import { loadInstitutions, loadTours, type LoadedInstitution, type LoadedTour } from "./institution_loader.js";

export interface CoreTypeRecord {
  slug: string;
  primitive: string;
  description: string;
  schema: object;
}

// The persisted domain-type record derives from the single Zod source (genome_schema.ts) — the
// hand-written interface that restated the same shape is retired. version/status are present on the
// output type (the schema defaults them), so the `slug@version` key + status reads stay sound.
export type DomainTypeRecord = DomainTypeOutput;

// On-disk shapes for the remaining three definition classes. Agents are AgentDef-shaped
// (validated through defineAgent). A standard file references its agents by slug (DRY —
// agents are authored once under agents/) and is composed through composeStandard.
// An agent's on-disk genome shape IS an AgentDef (slug + primitives + behavioral
// representation + cage). defineAgent validates it; a genome agent missing the required
// behavioral fields fails to load loudly (soft per-file error) rather than running hollow.
export type AgentFileDef = AgentDef;
export interface StandardFileDef {
  slug: string;
  domain: string;
  agent_slugs: readonly string[];
  phases: readonly PhaseDef[];
  eval_slugs?: readonly string[];
  input_types?: readonly string[]; // the gig contract (#177) — types entering from outside the standard
  output_types?: readonly string[];
  max_examine_rounds?: number;
  description?: string;
  /** #203 — lifecycle. Read from the file so a deprecation survives the round trip. */
  status?: "active" | "deprecated" | "retired";
}
// Skills and evals derive their shape from the single Zod source (genome_schema.ts) — the
// {slug;[k]:unknown} bag is retired. The runtime SkillRecord is the validated meta PLUS the
// loader-resolved provenance (package_dir, code_hash) and the rendered reasoning half (the
// invoker reads `md`/`text`/`body` for the prompt's Skills layer). EvalRecord IS the schema.
export type SkillRecord = SkillOutput & {
  package_dir?: string;
  code_hash?: string | null;
  text?: string;
  body?: string;
};
export type EvalRecord = EvalOutput;

// Per-definition load failure record. Surfaced via LoadedGenome.load_errors
// so one broken file no longer blocks the whole genome (Rob #129). The strict
// gate around core_types still hard-throws — that's the minimum the system
// needs to function. Anything past that softens.
export interface LoadError {
  readonly kind: "domain_type" | "agent" | "standard" | "skill" | "eval" | "chart" | "venue" | "institution" | "tour" | "manifest";
  readonly path: string;
  readonly slug: string | null;
  readonly error: string;
}

export interface LoadedGenome {
  core_types: ReadonlyMap<string, CoreTypeRecord>;
  domain_types: ReadonlyMap<string, DomainTypeRecord>;
  agents: ReadonlyMap<string, Agent>;
  // Mutable: the live server shares this map as deps.standards so MCP write-path
  // tools (standard_compose) can make a definition dispatchable in-session.
  standards: Map<string, Standard>;
  // Mutable: shared as deps.skills so skill_define writes through to the live map.
  skills: Map<string, SkillRecord>;
  evals: Map<string, EvalRecord>;
  // Mutable, same reason as standards: chart_define / venue_define write through to the live maps
  // so a definition authored over MCP is dispatchable in the same session.
  //
  // A chart is stored as the VALIDATED CHART, not as its composed plan. The plan carries a
  // dispatch-time fact the loader cannot know (which types the payload will seed), so the
  // authoritative composition happens at dispatch against the real payload; what the genome holds
  // is the arrangement itself.
  charts: Map<string, Chart>;
  venues: Map<string, Venue>;
  // The institutions/ class — a slug-keyed map of validated, ADMITTED institution documents.
  // OPTIONAL on the interface so the store backing (genome_store.ts reconstructGenome), which is
  // out of scope here, need not carry it yet; loadGenome always populates it (empty until the
  // reader in institution_loader.ts is wired). This is the field institutions/ gains a reader for.
  institutions?: ReadonlyMap<string, LoadedInstitution>;
  // The tours/ class — a slug-keyed map of validated, ADMITTED committed-work tours. OPTIONAL for the
  // same reason as institutions (a store backing need not carry it yet); loadGenome always populates
  // it. This is where checkTourAdmissibility gains a production callsite off the load path.
  tours?: ReadonlyMap<string, LoadedTour>;
  // Rob #129 — per-definition load failures recorded here instead of throwing.
  load_errors: LoadError[];
  // Genome extension (docs/genome-extension.md): when this genome was resolved from
  // a layer stack, maps `${kind}:${slug}` → the layer root that supplied the effective
  // definition (highest layer wins on override). Absent for a single-root load.
  provenance?: ReadonlyMap<string, string>;
}

export class GenomeLoadError extends Error {}

interface LoadedJsonFile<T> { readonly path: string; readonly data: T }
interface ParseFailure { readonly path: string; readonly error: string }

/**
 * Read every *.json file in `dir`. Files that fail to read or parse are
 * accumulated into `parse_failures` instead of throwing — the caller (per
 * Rob #129) decides whether the failure is hard (core types) or soft
 * (definitions). Filesystem-level errors (readFileSync) still throw because
 * they indicate the directory itself is unreadable.
 */
function readJsonDir<T>(dir: string): { files: LoadedJsonFile<T>[]; parse_failures: ParseFailure[] } {
  if (!existsSync(dir)) return { files: [], parse_failures: [] };
  const files: LoadedJsonFile<T>[] = [];
  const parse_failures: ParseFailure[] = [];
  for (const name of readdirSync(dir)) {
    if (extname(name) !== ".json") continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new GenomeLoadError(`failed to read ${path}: ${msg}`);
    }
    try {
      files.push({ path, data: JSON.parse(raw) as T });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parse_failures.push({ path, error: `malformed JSON at ${path}: ${msg}` });
    }
  }
  return { files, parse_failures };
}

const REQUIRED_CORE_SLUGS = new Set([
  "Signal",
  "Interpretation",
  "Judgment",
  "Plan",
  "Artifact",
  "Verdict",
]);

/**
 * #241 — an `agent.skill_slugs` entry that resolves to NO skill package is a dangling
 * reference. `loadGenome` never cross-referenced the two maps, so `load_errors` stayed `[]`
 * — the pass signal operators are explicitly instructed to trust — while the agent ran
 * without the discipline it claims to hold.
 *
 * SOFT by design: the agent still loads. A non-required dangling binding degrades the prompt,
 * it does not invalidate the definition; the RUNTIME decides whether it kills a chair, via
 * `Chair.required_skills`. This only has to break the silence.
 *
 * Runs as a POST-PASS, after BOTH maps exist — and again in `loadLayeredGenome` after the
 * fold, because a base-layer agent may legitimately bind a skill a higher layer supplies.
 */
function danglingSkillBindingErrors(
  agents: ReadonlyMap<string, Agent>,
  skills: ReadonlyMap<string, unknown>,
  pathOf: (agentSlug: string) => string,
): LoadError[] {
  const out: LoadError[] = [];
  for (const [slug, agent] of agents) {
    // A slug the agent CARRIES a definition for is not dangling: the definition on the record IS
    // the package for that slug, and resolution prefers it over a repertoire package of the same
    // name (src/runtime.ts resolveSkills). Only a slug nothing answers — neither the genome's
    // skills map nor the agent's own carried set — is a dead reference.
    const carried = new Set((agent.skills ?? []).map((s) => s.slug));
    const missing = (agent.skill_slugs ?? []).filter((s) => !skills.has(s) && !carried.has(s));
    if (missing.length === 0) continue;
    out.push({
      kind: "agent",
      path: pathOf(slug),
      slug,
      error:
        `dangling skill binding: skill_slugs [${missing.join(", ")}] resolve to no skill package ` +
        `(define the package under skills/<slug>/ or drop the binding — a bound skill with no package ` +
        `contributes nothing to the prompt and is invisible in the sealed output)`,
    });
  }
  return out;
}

export function loadGenome(
  root: string,
  opts?: {
    inheritedAgents?: ReadonlyMap<string, Agent>;
    /** Genome extension, the chart's side: a consumer chart arranges the BASE's standards and is
     *  held in the base's venues, so both have to be resolvable while this layer's charts compose.
     *  Same shape and same reason as `inheritedAgents`. */
    inheritedStandards?: ReadonlyMap<string, Standard>;
    inheritedVenues?: ReadonlyMap<string, Venue>;
    /** Set by loadLayeredGenome: defer the dangling-skill-binding post-pass to after the
     *  fold, so a base agent binding a skill the consumer layer supplies isn't false-flagged. */
    deferSkillBindingCheck?: boolean;
  },
): LoadedGenome {
  const load_errors: LoadError[] = [];

  // core_types/ stays STRICTLY hard-fail: the system can't function without
  // the six core slugs, so soft-fail would just delay the inevitable crash
  // somewhere downstream. Parse failures here throw too — same logic.
  const coreRead = readJsonDir<CoreTypeRecord>(join(root, "core_types"));
  const firstCoreFailure = coreRead.parse_failures[0];
  if (firstCoreFailure) {
    throw new GenomeLoadError(firstCoreFailure.error);
  }
  // Genome extension Phase 1 (docs/genome-extension.md): when a genome root has NO
  // core_types/ of its own, seed the canonical, immutable 6 the engine owns — so a
  // downstream consumer boots without hand-copying core substrate. A PARTIAL
  // core_types/ (some-but-not-all 6) still hard-fails the strict gate below; that's
  // a corrupt genome, not a fresh one.
  const coreList =
    coreRead.files.length > 0
      ? coreRead.files
      : CANONICAL_CORE_TYPES.map((data) => ({ path: "<engine-canonical>", data }));

  const core_types = new Map<string, CoreTypeRecord>();
  const core_type_paths = new Map<string, string>();
  for (const { path, data: c } of coreList) {
    if (core_types.has(c.slug)) {
      throw new GenomeLoadError(
        `duplicate core type slug "${c.slug}" in ${path} (first seen in ${core_type_paths.get(c.slug)})`,
      );
    }
    core_types.set(c.slug, c);
    core_type_paths.set(c.slug, path);
  }

  const missing = [...REQUIRED_CORE_SLUGS].filter((s) => !core_types.has(s));
  if (missing.length > 0) {
    throw new GenomeLoadError(
      `core_types/ missing required slugs: ${missing.join(", ")}`,
    );
  }
  if (core_types.size !== REQUIRED_CORE_SLUGS.size) {
    const extra = [...core_types.keys()].filter((s) => !REQUIRED_CORE_SLUGS.has(s));
    throw new GenomeLoadError(
      `core_types/ contains non-spec slugs: ${extra.join(", ")} (core set is immutable; v2 spec §2)`,
    );
  }

  // domain_types/ — past the core gate, soft-fail. One broken type no longer
  // kills the genome. Each parse-failure becomes a typed LoadError.
  const domainRead = readJsonDir<DomainTypeRecord>(join(root, "domain_types"));
  for (const f of domainRead.parse_failures) {
    load_errors.push({ kind: "domain_type", path: f.path, slug: null, error: f.error });
  }
  const domain_types = new Map<string, DomainTypeRecord>();
  const domain_type_paths = new Map<string, string>();
  for (const { path, data: d } of domainRead.files) {
    try {
      const key = `${d.slug}@${d.version}`;
      if (domain_types.has(key)) {
        throw new Error(
          `duplicate domain type "${key}" in ${path} (first seen in ${domain_type_paths.get(key)})`,
        );
      }
      if (!core_types.has(d.extends)) {
        throw new Error(
          `field "extends" references "${d.extends}" which is not a core type`,
        );
      }
      // The same representability rules registerType applies (#272, #264) — one owner, so a
      // type authored on disk cannot slip past a check a type registered via MCP would hit.
      const defect = domainTypeDefect(d);
      if (defect) throw new Error(defect);
      // Validate the file shape against the single Zod source (genome_schema.ts). Soft-fail per
      // the domain_types stance above — a malformed type file is a typed LoadError, not a genome kill.
      const typeCheck = DomainTypeSchema.safeParse(d);
      if (!typeCheck.success) {
        const why = typeCheck.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        throw new Error(`type schema validation failed — ${why}`);
      }
      domain_types.set(key, d);
      domain_type_paths.set(key, path);
    } catch (e) {
      load_errors.push({
        kind: "domain_type",
        path,
        slug: typeof d?.slug === "string" ? d.slug : null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // agents/ — each file is an AgentDef; validated through defineAgent. Soft-fail
  // per file: a broken agent does not block other agents from loading.
  const agentRead = readJsonDir<AgentFileDef>(join(root, "agents"));
  for (const f of agentRead.parse_failures) {
    load_errors.push({ kind: "agent", path: f.path, slug: null, error: f.error });
  }
  const agents = new Map<string, Agent>();
  const agent_paths = new Map<string, string>();
  for (const { path, data: def } of agentRead.files) {
    const slug = typeof def?.slug === "string" ? def.slug : null;
    try {
      if (!def.slug || typeof def.slug !== "string") {
        throw new Error(`missing required "slug" field`);
      }
      if (agents.has(def.slug)) {
        throw new Error(
          `duplicate agent slug "${def.slug}" (first seen in ${agent_paths.get(def.slug)})`,
        );
      }
      agents.set(def.slug, defineAgent(def));
      agent_paths.set(def.slug, path);
    } catch (e) {
      // An agent that fails to VALIDATE — malformed (bad primitives / illegal progression,
      // CompositionError) OR incomplete against the schema (missing behavioral, the
      // GenomeIncompleteError) — HARD-fails the whole load. A genome must load cleanly to
      // run; a standard with a quietly-missing chair would produce silently-wrong outputs.
      // (Non-validation issues like a duplicate-slug collision still soft-fail below.)
      if (e instanceof CompositionError || e instanceof GenomeIncompleteError) throw e;
      load_errors.push({
        kind: "agent",
        path,
        slug,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // standards/ — resolve agent_slugs against loaded agents, then composeStandard.
  // Soft-fail per file. A standard that references a missing-or-broken agent
  // gets skipped + recorded; other standards still load.
  const standardRead = readJsonDir<StandardFileDef>(join(root, "standards"));
  for (const f of standardRead.parse_failures) {
    load_errors.push({ kind: "standard", path: f.path, slug: null, error: f.error });
  }
  const standards = new Map<string, Standard>();
  const standard_paths = new Map<string, string>();
  for (const { path, data: def } of standardRead.files) {
    const slug = typeof def?.slug === "string" ? def.slug : null;
    try {
      if (!def.slug || typeof def.slug !== "string") {
        throw new Error(`missing required "slug" field`);
      }
      if (standards.has(def.slug)) {
        throw new Error(
          `duplicate standard slug "${def.slug}" (first seen in ${standard_paths.get(def.slug)})`,
        );
      }
      const resolved: Agent[] = [];
      for (const aslug of def.agent_slugs ?? []) {
        // Resolve against this layer's own agents first, then agents inherited from
        // lower layers (genome extension) — so a consumer standard can compose base
        // players it didn't define itself.
        const a = agents.get(aslug) ?? opts?.inheritedAgents?.get(aslug);
        if (!a) {
          throw new Error(`field "agent_slugs" references unknown agent "${aslug}"`);
        }
        resolved.push(a);
      }
      // Pass eval_slugs through to composeStandard when present (added in #128).
      standards.set(def.slug, composeStandard({
        slug: def.slug,
        domain: def.domain,
        agents: resolved,
        phases: def.phases,
        ...(def.eval_slugs ? { eval_slugs: def.eval_slugs } : {}),
        // #177: the gig contract — types entering from outside the standard (gig / cross-standard).
        ...(def.input_types ? { input_types: def.input_types } : {}),
        // #genome-schema: fields the file declares must reach the runtime Standard, not be dropped.
        ...(def.output_types ? { output_types: def.output_types } : {}),
        // #203 — the LOADER applies the lifecycle default. `status` is optional on the schema
        // so an in-memory Standard need not restate it, but anything read from disk carries
        // one — which is what makes "is this standard retired?" a question with an answer.
        status: def.status ?? "active",
        ...(def.max_examine_rounds !== undefined ? { max_examine_rounds: def.max_examine_rounds } : {}),
        ...(def.description ? { description: def.description } : {}),
      }));
      standard_paths.set(def.slug, path);
    } catch (e) {
      load_errors.push({
        kind: "standard",
        path,
        slug,
        error: e instanceof CompositionError || e instanceof Error ? e.message : String(e),
      });
    }
  }

  // skills/<slug>/ PACKAGE directories are the ONLY skill format (the flat {slug, md} JSON
  // is retired — no backwards-compat). A genome skill must be a COMPLETE package: meta +
  // >=1 fixture (its pre-registered contract) + >=1 half (code and/or reasoning). Malformed
  // (SkillLoadError) OR incomplete HARD-fails the load — a genome must load cleanly to run,
  // mirroring the agent behavioral gate. Only a duplicate-slug collision soft-fails.
  const skills = new Map<string, SkillRecord>();
  const skill_paths = new Map<string, string>();
  const skillsDir = join(root, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgDir = join(skillsDir, entry.name);
      if (!existsSync(join(pkgDir, "meta.json"))) continue;
      const pkg = loadSkillPackage(pkgDir); // SkillLoadError (malformed) propagates → hard-fail
      if (pkg.fixtures.length === 0) {
        throw new SkillLoadError(`skill ${pkg.meta.slug}: no fixtures — a skill must ship its pre-registered contract (fixtures capture intent at creation; deferring them loses it)`);
      }
      if (pkg.codeHash === null && pkg.mdPath === null) {
        throw new SkillLoadError(`skill ${pkg.meta.slug}: empty — needs a code half (skill.mjs) and/or a reasoning half (skill.md)`);
      }
      // Validate the meta against the single Zod source — a malformed declared field (e.g. a
      // non-numeric determinism_ratio, a malformed permission/network grant) hard-fails the load,
      // mirroring the package-completeness gate above. Shape only: this does NOT re-impose any
      // fixtures-pass-to-promote ceremony — promotion strictness is a separate, tunable policy.
      const metaCheck = SkillSchema.safeParse(pkg.meta);
      if (!metaCheck.success) {
        const why = metaCheck.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        throw new SkillLoadError(`skill ${pkg.meta.slug}: meta failed schema validation — ${why}`);
      }
      if (skills.has(pkg.meta.slug)) {
        load_errors.push({ kind: "skill", path: pkgDir, slug: pkg.meta.slug, error: `duplicate skill slug "${pkg.meta.slug}" (first seen in ${skill_paths.get(pkg.meta.slug)})` });
        continue;
      }
      // resolve the reasoning half into the record so the prompt's Skills layer renders it
      const md = pkg.mdPath ? readFileSync(pkg.mdPath, "utf-8") : undefined;
      skills.set(pkg.meta.slug, { ...pkg.meta, slug: pkg.meta.slug, package_dir: pkgDir, code_hash: pkg.codeHash, ...(md !== undefined ? { md } : {}) });
      skill_paths.set(pkg.meta.slug, pkgDir);
    }
  }

  const evalRead = readJsonDir<EvalRecord>(join(root, "evals"));
  for (const f of evalRead.parse_failures) {
    load_errors.push({ kind: "eval", path: f.path, slug: null, error: f.error });
  }
  const evals = new Map<string, EvalRecord>();
  const eval_paths = new Map<string, string>();
  for (const { path, data: e } of evalRead.files) {
    const slug = typeof e?.slug === "string" ? e.slug : null;
    try {
      if (!e.slug) throw new Error(`required field "slug" is missing`);
      if (evals.has(e.slug)) {
        throw new Error(`duplicate eval slug "${e.slug}" (first seen in ${eval_paths.get(e.slug)})`);
      }
      // Validate against the single Zod source — the {slug;[k]:unknown} bag is retired, so a
      // malformed eval (e.g. a non-array non_empty_fields) is caught at load, not at score time.
      const parsed = EvalSchema.safeParse(e);
      if (!parsed.success) {
        const why = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        throw new Error(`eval schema validation failed — ${why}`);
      }
      evals.set(e.slug, parsed.data);
      eval_paths.set(e.slug, path);
    } catch (err) {
      load_errors.push({ kind: "eval", path, slug, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // venues/ — the institution's configured performance spaces. Loaded BEFORE charts, because a
  // chart names a venue and a chart's compose refuses a venue it cannot resolve. Soft-fail per
  // file, the standards stance: one unsound room does not cost the genome its other rooms.
  // BOTH gates run, the domain_types idiom: the single Zod source for the shape, then venueDefect
  // for the cross-field rules a field cannot state — so a venue authored on disk cannot slip past a
  // check a venue registered via venue_define would hit.
  const venueRead = readJsonDir<VenueInput>(join(root, "venues"));
  for (const f of venueRead.parse_failures) {
    load_errors.push({ kind: "venue", path: f.path, slug: null, error: f.error });
  }
  const venues = new Map<string, Venue>();
  const venue_paths = new Map<string, string>();
  for (const { path, data: def } of venueRead.files) {
    const slug = typeof def?.slug === "string" ? def.slug : null;
    try {
      if (!slug) throw new Error(`missing required "slug" field`);
      if (venues.has(slug)) {
        throw new Error(`duplicate venue slug "${slug}" (first seen in ${venue_paths.get(slug)})`);
      }
      const parsed = VenueSchema.safeParse(def);
      if (!parsed.success) {
        const why = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        throw new Error(`venue schema validation failed — ${why}`);
      }
      const defect = venueDefect(parsed.data);
      if (defect) throw new Error(defect);
      venues.set(slug, parsed.data);
      venue_paths.set(slug, path);
    } catch (e) {
      load_errors.push({ kind: "venue", path, slug, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // charts/ — the ARRANGEMENTS: a chart names standards by slug and is validated the same way a
  // standard is, through the function that owns the rules. `composeChart` resolves every movement's
  // standard, every seating's agent and the named venue against what this genome actually holds, so
  // a chart naming a missing standard fails HERE, where it is a load error with the rule that fired
  // named — not at minute nine of a performance. Soft-fail per file, like standards.
  const chartRead = readJsonDir<ChartInput>(join(root, "charts"));
  for (const f of chartRead.parse_failures) {
    load_errors.push({ kind: "chart", path: f.path, slug: null, error: f.error });
  }
  const charts = new Map<string, Chart>();
  const chart_paths = new Map<string, string>();
  for (const { path, data: def } of chartRead.files) {
    const slug = typeof def?.slug === "string" ? def.slug : null;
    try {
      if (!slug) throw new Error(`missing required "slug" field`);
      if (charts.has(slug)) {
        throw new Error(`duplicate chart slug "${slug}" (first seen in ${chart_paths.get(slug)})`);
      }
      // Shape first, so the seed computation below reads a parsed chart rather than raw JSON.
      // composeChart re-runs the same parse as its R0 — idempotent, and it keeps ONE owner of the
      // rules rather than a second half-check here.
      const shape = ChartSchema.safeParse(def);
      if (!shape.success) {
        const why = shape.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        throw new Error(`R0: chart does not parse — ${why}`);
      }
      // A movement's standard (and a seating's agent, and the venue) resolves against this layer
      // first, then whatever a lower layer supplied — the same resolution order a standard's
      // agent_slugs already get, so a consumer chart may arrange base standards.
      const scopedStandards = new Map([...(opts?.inheritedStandards ?? []), ...standards]);
      const composed = composeChart({
        chart: shape.data,
        standards: scopedStandards,
        agents: new Map([...(opts?.inheritedAgents ?? []), ...agents]),
        venues: new Map([...(opts?.inheritedVenues ?? []), ...venues]),
        // The payload is a dispatch fact; at load time a boundary movement's declared gig contract
        // stands in for it. See chartEntrySeedTypes — the interior dead slot still fires.
        payload_types: chartEntrySeedTypes(shape.data, scopedStandards),
      });
      if (!composed.ok) {
        throw new Error(composed.violations.map((v) => `${v.rule}: ${v.detail}`).join(" | "));
      }
      charts.set(slug, composed.chart);
      chart_paths.set(slug, path);
    } catch (e) {
      load_errors.push({ kind: "chart", path, slug, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // #241 — post-pass, now that BOTH the agents and skills maps exist.
  if (!opts?.deferSkillBindingCheck) {
    load_errors.push(
      ...danglingSkillBindingErrors(agents, skills, (slug) => agent_paths.get(slug) ?? join(root, "agents")),
    );
  }

  // institutions/ — read LAST, after the agents/standards/venues/charts/organization maps exist:
  // institutions reference those, so the reader sits after every one of them (the venues-before-charts
  // ordering, one level out). loadInstitutions validates each present section against its per-section
  // Zod schema and invokes checkInstitutionAdmissibility fail-closed; a malformed / schema-invalid /
  // inadmissible / duplicate-slug document drops out as one "institution"-kind LoadError while the rest
  // of the genome loads. It is TOTAL — it never throws for an institution reason, so one bad document
  // cannot DoS the other classes.
  const institutionRead = loadInstitutions(root);
  load_errors.push(...institutionRead.load_errors);
  const institutions: ReadonlyMap<string, LoadedInstitution> = institutionRead.institutions;

  // tours/ — read AFTER institutions, because a tour resolves against its institution's chairs and
  // is gated by checkTourAdmissibility fail-closed. An inadmissible tour drops out as one "tour"
  // load_error exactly as an inadmissible institution does; the shipped tours/coltrane.json is
  // admissible, so this adds no error to a clean genome.
  const tourRead = loadTours(root, institutions);
  load_errors.push(...tourRead.load_errors);
  const tours: ReadonlyMap<string, LoadedTour> = tourRead.tours;

  return { core_types, domain_types, agents, standards, skills, evals, charts, venues, institutions, tours, load_errors };
}

/**
 * Resolve a LAYERED genome from a stack of roots, lowest → highest (genome extension
 * Phase 2 — docs/genome-extension.md). Each root is loaded as a normal genome, then
 * folded so a higher layer's definitions OVERRIDE a lower layer's by slug, per class.
 * A consumer extends a base by passing [baseRoot, consumerRoot]: it inherits the base,
 * adds its own, and overrides where it specializes. `provenance` records which layer
 * supplied each effective definition. core_types are the immutable 6 (every layer
 * provides them, seeded or on-disk); the top layer's are used.
 */
export function loadLayeredGenome(roots: readonly string[]): LoadedGenome {
  if (roots.length === 0) {
    throw new GenomeLoadError("loadLayeredGenome requires at least one root");
  }
  const domain_types = new Map<string, DomainTypeRecord>();
  const agents = new Map<string, Agent>();
  const standards = new Map<string, Standard>();
  const skills = new Map<string, SkillRecord>();
  const evals = new Map<string, EvalRecord>();
  const charts = new Map<string, Chart>();
  const venues = new Map<string, Venue>();
  const load_errors: LoadError[] = [];
  const provenance = new Map<string, string>();
  let core_types: ReadonlyMap<string, CoreTypeRecord> = new Map();

  const fold = <V>(into: Map<string, V>, from: ReadonlyMap<string, V>, root: string, kind: string) => {
    for (const [slug, val] of from) {
      into.set(slug, val); // higher layer overrides
      provenance.set(`${kind}:${slug}`, root);
    }
  };

  for (const root of roots) {
    // Each layer loaded normally (core types seeded), with the agents accumulated
    // from lower layers passed in — so this layer's standards can compose them.
    // #241 — the skill-binding check is deferred to the post-fold pass below: a BASE agent
    // may legitimately bind a skill a HIGHER layer supplies, so per-layer it would report a
    // dangle that the resolved genome does not have.
    const layer = loadGenome(root, {
      inheritedAgents: agents,
      inheritedStandards: standards,
      inheritedVenues: venues,
      deferSkillBindingCheck: true,
    });
    core_types = layer.core_types; // immutable 6 — top layer's (all identical)
    fold(domain_types, layer.domain_types, root, "domain_type");
    fold(agents, layer.agents, root, "agent");
    fold(standards, layer.standards, root, "standard");
    fold(skills, layer.skills, root, "skill");
    fold(evals, layer.evals, root, "eval");
    fold(venues, layer.venues, root, "venue");
    fold(charts, layer.charts, root, "chart");
    for (const e of layer.load_errors) load_errors.push(e);
  }

  // #241 — the post-fold pass. Reported once, against the resolved genome, not once per layer.
  load_errors.push(
    ...danglingSkillBindingErrors(agents, skills, (slug) => {
      const layerRoot = provenance.get(`agent:${slug}`);
      return layerRoot ? join(layerRoot, "agents") : "";
    }),
  );

  return { core_types, domain_types, agents, standards, skills, evals, charts, venues, load_errors, provenance };
}

/**
 * Manifest-aware genome load (genome extension Phase 2 — opt-in). A genome root may
 * declare the base(s) it extends in a `genome.json` manifest: `{ "extends": [<path>] }`
 * (absolute, or relative to that root). resolveGenome walks the extends chain, flattens
 * it to a layer stack (bases first, this root last, deduped + cycle-guarded), and resolves
 * it via loadLayeredGenome. No manifest → a plain single-root load. This is what the
 * running server (bootstrapServerDeps) calls, so a downstream consumer's declared base
 * is honored automatically.
 */
export function resolveGenome(root: string): LoadedGenome {
  const { roots, pinErrors } = resolveExtendsChain(root);
  const genome = roots.length === 1 ? loadGenome(root) : loadLayeredGenome(roots);
  if (pinErrors.length === 0) return genome;
  return { ...genome, load_errors: [...genome.load_errors, ...pinErrors] };
}

/**
 * Genome cascade check (genome extension Phase 3 — docs/genome-extension.md). Given a
 * consumer genome and two base versions (`fromBase` it currently validates against,
 * `toBase` a candidate), report what in the CONSUMER layer breaks when the base advances
 * — e.g. a consumer standard that composes a base player the new base removed/renamed.
 *
 * `broken` = consumer-layer load_errors present against toBase but NOT fromBase (the
 * base change broke them). `healed` = the inverse (informational). Lets a consumer
 * decide whether to adopt a new base before pinning to it.
 */
export interface CascadeReport {
  broken: LoadError[];
  healed: LoadError[];
}
export function genomeCascadeCheck(consumerRoot: string, fromBase: string, toBase: string): CascadeReport {
  const consumerReal = resolve(consumerRoot);
  const consumerLayerErrors = (base: string): LoadError[] =>
    loadLayeredGenome([base, consumerRoot]).load_errors.filter((e) =>
      resolve(e.path).startsWith(consumerReal),
    );
  const key = (e: LoadError): string => `${e.kind}:${e.slug ?? ""}:${e.error}`;
  const fromErrs = consumerLayerErrors(fromBase);
  const toErrs = consumerLayerErrors(toBase);
  const fromKeys = new Set(fromErrs.map(key));
  const toKeys = new Set(toErrs.map(key));
  return {
    broken: toErrs.filter((e) => !fromKeys.has(key(e))),
    healed: fromErrs.filter((e) => !toKeys.has(key(e))),
  };
}

function readGenomeManifest(root: string, manifestErrors: LoadError[]): readonly string[] {
  const p = join(root, "genome.json");
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch (e) {
    manifestErrors.push({
      kind: "manifest", path: p, slug: null,
      error: `cannot read genome manifest: ${e instanceof Error ? e.message : String(e)} (the declared base(s) are NOT loaded)`,
    });
    return [];
  }
  try {
    const data = JSON.parse(raw) as { extends?: unknown };
    return Array.isArray(data.extends) ? data.extends.filter((e): e is string => typeof e === "string") : [];
  } catch (e) {
    // #247 — this used to `return []` silently, which UN-EXTENDS the genome: every inherited
    // agent, standard, skill and type vanishes. The operator then gets a cascade of
    // `references unknown agent "…"` errors pointing at files that are perfectly correct —
    // the root cause destroyed and the symptom relocated. The manifest LoadError channel for
    // exactly this class already existed (resolveExtendsEntry uses it for pin errors); this
    // branch simply didn't use it. Still SOFT — one bad manifest is not a crash.
    manifestErrors.push({
      kind: "manifest", path: p, slug: null,
      error:
        `malformed genome manifest — ${e instanceof Error ? e.message : String(e)} ` +
        `(the declared base(s) are NOT loaded; every inherited definition is missing until this file parses, ` +
        `so treat any "references unknown …" errors below as downstream of this one)`,
    });
    return [];
  }
}

function resolveExtendsChain(root: string): { roots: string[]; pinErrors: LoadError[] } {
  const ordered: string[] = [];
  const pinErrors: LoadError[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();
  const visit = (r: string): void => {
    const real = resolve(r);
    if (done.has(real)) return;
    if (onStack.has(real)) throw new GenomeLoadError(`genome extends cycle detected at ${real}`);
    onStack.add(real);
    for (const spec of readGenomeManifest(real, pinErrors)) {
      const resolved = resolveExtendsEntry(spec, real, pinErrors);
      if (resolved) visit(resolved);
    }
    onStack.delete(real);
    done.add(real);
    ordered.push(real); // post-order: bases land before the root that extends them
  };
  visit(root);
  return { roots: ordered, pinErrors };
}

// Split a package spec into name + optional version pin. Handles scoped names:
//   "@scope/pkg@1.2.3" → { name: "@scope/pkg", version: "1.2.3" }
//   "@scope/pkg"       → { name: "@scope/pkg" }
//   "pkg@1.2.3"        → { name: "pkg", version: "1.2.3" }
function parsePackageSpec(spec: string): { name: string; version?: string } {
  const slash = spec.startsWith("@") ? spec.indexOf("/") : 0;
  const at = spec.indexOf("@", slash + 1);
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec };
}

// Resolve one `extends` entry to a genome root. A path (./ , / , absolute) resolves
// relative to the declaring root. Anything else is an npm package spec
// (`@scope/pkg[@version]`): resolve the installed package's dir from the declaring
// root's node_modules; if a version was pinned, warn (manifest load_error) when the
// installed version differs — the pin records "validated against vX", so a mismatch
// means re-run the cascade and re-pin. Returns null (with a recorded error) if the
// package can't be resolved.
function resolveExtendsEntry(spec: string, fromRoot: string, pinErrors: LoadError[]): string | null {
  if (spec.startsWith(".") || isAbsolute(spec) || spec.startsWith("/")) {
    return isAbsolute(spec) ? spec : join(fromRoot, spec);
  }
  const { name, version } = parsePackageSpec(spec);
  const manifestPath = join(fromRoot, "genome.json");
  try {
    const req = createRequire(join(fromRoot, "package.json"));
    const pkgJsonPath = req.resolve(`${name}/package.json`);
    const installed = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { version?: string };
    if (version && installed.version && version !== installed.version) {
      pinErrors.push({
        kind: "manifest",
        path: manifestPath,
        slug: name,
        error: `extends: base "${name}" pinned to ${version} but ${installed.version} is installed — re-run cascade + re-pin`,
      });
    }
    return dirname(pkgJsonPath);
  } catch {
    pinErrors.push({
      kind: "manifest",
      path: manifestPath,
      slug: name,
      error: `extends: cannot resolve base package "${name}" from ${fromRoot} (is it installed?)`,
    });
    return null;
  }
}
