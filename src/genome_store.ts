// genome_store.ts — the GenomeStore port. Governor ruling: GENOME IS NOT LOCAL. The hosted
// Coltrane MCP is the Coltrane MCP — the full tool surface, functioning against the Supabase
// store — so the engine needs ONE port for "where do definitions live", with two backings:
//
//   * fileGenomeStore(root)      — the existing loader/writer, unchanged behavior. Local dev
//     and the stdio server keep reading/writing genome files on disk.
//   * postgrestGenomeStore(ctx)  — loads the five genome tables over PostgREST (the caller's
//     bearer rides the Authorization header, so RLS is the scope) and reconstructs the SAME
//     in-memory genome shape the file loader produces. Every record is validated through the
//     genome_schema Zod parsers exactly as the loader does; rows that fail parse are load
//     errors (LoadedGenome.load_errors — surfaced by system_health), never silent skips.
//     Writes ride the coltrane_genome_upsert RPC as the caller.
//
// No new dependencies: plain fetch, and the Zod schemas the engine already owns.
import {
  resolveGenome,
  GenomeLoadError,
  type LoadedGenome,
  type LoadError,
  type CoreTypeRecord,
  type DomainTypeRecord,
  type SkillRecord,
  type EvalRecord,
} from "./loader.js";
import { writeGenomeFileVersioned, stageSkillPackage } from "./genome_writer.js";
import { defineAgent, composeStandard, type Agent, type Standard, type PhaseDef } from "./composition.js";
import { composeChart, chartEntrySeedTypes, type Chart, type Venue } from "./chart.js";
import { DomainTypeSchema, SkillSchema, ChartSchema, VenueSchema, venueDefect } from "./genome_schema.js";
import { domainTypeDefect } from "./registry.js";
import { CANONICAL_CORE_TYPES } from "./canonical_core_types.js";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The genome classes a store can persist. (Core types are engine-owned and immutable.)
 *
 *  `chart` and `venue` are here because the ENGINE now authors them — the file backing writes
 *  charts/<slug>.json and venues/<slug>.json, and the class rides through the PostgREST upsert
 *  unchanged. The STORE side is not yet built: `coltrane_genome_upsert` has no branch for either
 *  class and there are no chart/venue tables, so a hosted venue_define reaches the RPC and is
 *  refused BY THE STORE, loudly, with the store's own message. That refusal is the honest state —
 *  the class passes through the port it is supposed to pass through and the missing half says so
 *  itself, rather than the engine pretending the class does not exist. */
export type GenomeClass = "agent" | "standard" | "skill" | "domain_type" | "chart" | "venue" | "institution";

/** Where definitions live. load() yields the loader's genome shape; upsert() persists one
 *  definition of a class. The file impl writes genome files; the PostgREST impl rides the
 *  governed upsert RPC as the caller. */
export interface GenomeStore {
  load(): Promise<LoadedGenome>;
  /** org_slug is an OPTIONAL override — the store resolves the caller's working org
   *  (set once via org_use) when absent, so callers never track the org per call. */
  upsert(cls: GenomeClass, payload: Record<string, unknown>, org_slug?: string): Promise<void>;
}

/** The store connection a hosted caller carries — same shape as HostedToolContext:
 *  where the org store is, its public anon key, and WHO is calling (bearer). */
export interface PostgrestContext {
  baseUrl: string;
  anonKey: string;
  bearer: string;
  /**
   * WHO IS ACTING, by org UUID. RLS scopes rows to what this caller may SEE, which for a member of
   * two orgs is both — and a venue slug is unique per org, not globally. Without this, a name held
   * by two orgs resolved to neither (correctly: the engine will not pick by row order) and the room
   * simply vanished from the genome.
   *
   * A UUID, never a slug: slugs are exactly what collides. Absent means the load stays unpinned and
   * a contested name still refuses — ambient org context is a refusal condition, not a default.
   */
  acting_org_id?: string | undefined;
  /** The base under the rows; see GenomeLoadPin.base. Absent: the engine's packaged genome. */
  base?: LoadedGenome | null | undefined;
}

/** The base a store backing hands to reconstructGenome: the engine's own unless told `null`. */
function baseFor(ctx: { base?: LoadedGenome | null | undefined }): LoadedGenome | null {
  return ctx.base === null ? null : (ctx.base ?? engineBaseGenome());
}

const CLASS_SUBDIR: Record<GenomeClass, string> = {
  agent: "agents",
  standard: "standards",
  skill: "skills",
  domain_type: "domain_types",
  chart: "charts",
  venue: "venues",
  institution: "institutions",
};

/** Local-dev backing: the existing loader/writer, behavior identical. load() is
 *  resolveGenome (manifest-aware, canonical-core seeding); upsert() writes the loadable
 *  file via the versioned writer (prior bytes snapshotted, atomic replace). Ledger sealing
 *  stays where it lives today — in the MCP tools (sealDefinition / sealAgentDefinition). */
export function fileGenomeStore(root: string): GenomeStore {
  return {
    async load(): Promise<LoadedGenome> {
      return resolveGenome(root);
    },
    async upsert(cls: GenomeClass, payload: Record<string, unknown>): Promise<void> {
      const slug = typeof payload["slug"] === "string" ? payload["slug"].trim() : "";
      if (!slug) throw new Error(`genome upsert: ${cls} payload has no slug`);
      // #559 — both branches hold the boundary themselves: the slug's path must land inside the
      // class's own directory under this store's root, or the upsert is refused before any byte moves.
      if (cls === "skill") {
        // Skills are PACKAGE directories (the loader's only skill format) — the SAME stager the
        // blessed writer uses (sealSkillPackage's file half), so the two cannot drift.
        stageSkillPackage(root, { ...payload, slug }).commit();
        return;
      }
      writeGenomeFileVersioned(root, CLASS_SUBDIR[cls], slug, JSON.stringify(payload, null, 2) + "\n");
    },
  };
}

// ── PostgREST backing ─────────────────────────────────────────────────────────────

// The five genome tables and the columns the engine reads back. Row shapes are the
// round-tripped Supabase schema (org_id is RLS's concern, not the engine's).
export const Q = {
  core_types: "coltrane_core_types?select=slug,primitive,base_schema,description",
  domain_types: "coltrane_domain_types?select=slug,version,extends,domain,status,schema,required_fields",
  agents:
    "coltrane_agent_profiles?select=slug,version,status,primitives,input_types,output_types,domain," +
    "identity,method,constraints,depth_profile,permissions,behavioral_primitives,skill_slots,default_skills,carried_skills",
  // O5 — max_examine_rounds and reserve_pool ride back through the store, or the file genome and the
  // store genome are two different standards (the drain would never amend and its pool would vanish).
  // NOTE (out of scope, hosted): the hosted coltrane_standards table needs these two columns before
  // this select reaches the hosted drain; that migration lives outside this repo.
  standards: "coltrane_standards?select=slug,version,status,domain,phases,input_types,output_types,max_examine_rounds,reserve_pool",
  // Same gap venues had, one class over: no `version`, no `org_id`. coltrane_skills is
  // versioned, so skill_evolve minting v2 leaves v1 on the table — and the loader, seeing
  // two rows for one slug, threw "duplicate skill slug" and named the SLUG. A live skill
  // reporting as broken because its own history sits beside it. Found on production:
  // ledger-reconcile v1 and v2, BOTH active, same org, minted 39 minutes apart.
  skills: "coltrane_skills?select=slug,version,org_id,name,description,skill_md,tier,input_type,output_type,status",
  charts: "coltrane_charts?select=slug,definition",
  // A2 — SLUG AND DEFINITION WAS NOT ENOUGH. coltrane_venues is VERSIONED and STATUSED:
  // a repair lands as v2 and v1 stays on the table as history. Reading slug+definition
  // handed the loader every superseded row, which then failed the rules its own successor
  // was authored to satisfy — and the error named the SLUG, so a perfectly repaired room
  // reported as broken forever. Found by the verifier reading the ENGINE's oracle against
  // production after the venue-contract repair landed: 8 load errors, the three repaired
  // rooms still among them. org_id rides along so two orgs claiming one slug is a fact the
  // loader can SEE rather than a collision it discovers by row order.
  venues: "coltrane_venues?select=slug,version,status,org_id,definition",
  // The institution row rides the SAME {slug, definition} envelope charts and venues use, where
  // `definition` IS the multi-section file document the loader validates — so file and store backings
  // cannot drift (spec ITEM 4). The store backing / fetch is NOT built here (envelope string only);
  // the reconstruction has no institution branch yet, exactly as it had none for charts/venues before
  // their tables landed.
  //
  // `chancery_institution` is the CANONICAL governance table name (coltrane-ui migration
  // 20260825000000 renamed the nine coltrane_* governance tables to chancery_*; the coltrane_*
  // read-shim views are scheduled to drop). Engine reads go to the real table, never the shim.
  institutions: "chancery_institution?select=slug,definition",
} as const;

type Row = Record<string, unknown>;

async function restGet(ctx: PostgrestContext, pathAndQuery: string): Promise<Row[]> {
  const res = await fetch(`${ctx.baseUrl}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: ctx.anonKey,
      // The bearer authenticates via the header; RLS scopes what this caller may load.
      Authorization: `Bearer ${ctx.bearer}`,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new GenomeLoadError(`genome load: GET ${pathAndQuery.split("?")[0]} → ${res.status}: ${text}`);
  }
  const parsed: unknown = text ? JSON.parse(text) : [];
  return Array.isArray(parsed) ? (parsed as Row[]) : [];
}

const zodWhy = (issues: { path: (string | number)[]; message: string }[]): string =>
  issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

/** Build the engine AgentDef from an agent-profile row: the permissions jsonb unpacks to the
 *  flat schema fields; default_skills is the row's skill-binding column (skill_slugs). */
function agentDefFromRow(row: Row): Record<string, unknown> {
  const perms = (row["permissions"] ?? {}) as Row;
  const def: Record<string, unknown> = {
    slug: row["slug"],
    primitives: row["primitives"],
    input_types: row["input_types"] ?? [],
    output_types: row["output_types"] ?? [],
    domain: row["domain"] ?? null,
    identity: row["identity"],
    method: row["method"],
    constraints: row["constraints"] ?? [],
    behavioral_primitives: row["behavioral_primitives"],
    allowed_tools: perms["allowed_tools"],
    disallowed_tools: perms["disallowed_tools"],
    model_tier: perms["model_tier"],
    max_tool_calls: perms["max_tool_calls"],
    code_tool_access: perms["code_tool_access"],
    depth_profile: row["depth_profile"],
    skill_slugs: row["default_skills"],
    // Carried skills travel WITH the agent row (the player's own technique, portable across
    // institutions); absent column or null → the agent simply carries none.
    skills: row["carried_skills"] ?? undefined,
  };
  for (const k of Object.keys(def)) if (def[k] === undefined || def[k] === null) delete def[k];
  // domain is honestly nullable on the schema — restore it if the row said null.
  if (!("domain" in def)) def["domain"] = null;
  return def;
}

const REQUIRED_CORE_SLUGS = ["Signal", "Interpretation", "Judgment", "Plan", "Artifact", "Verdict"];

/** The row bundle both store backings feed the reconstruction: the five genome tables,
 *  however they were fetched (PostgREST GETs under a JWT, or the coltrane_mcp_genome RPC
 *  under an agent token). */
export interface GenomeRows {
  core_types: Row[];
  domain_types: Row[];
  agents: Row[];
  standards: Row[];
  skills: Row[];
  /** Rows of {slug, definition} — the definition jsonb IS the file shape, validated through
   *  the same gates the loader runs (ChartSchema+composeChart / VenueSchema+venueDefect). */
  charts?: Row[];
  venues?: Row[];
}

/** Reconstruct the loader's in-memory genome shape from store rows — ONE reconstruction,
 *  shared by every backing, so a JWT-loaded genome and a ctk-loaded genome cannot drift. */
/**
 * Who is loading. A venue is `(org_id, slug)` in the store and was `slug` alone here — two layers
 * with different beliefs about whether a venue name is unique, and the store's answer is no.
 *
 * The org is a UUID, never a slug: slugs are exactly the thing that collides across orgs, so
 * resolving by one would move the ambiguity rather than close it.
 *
 * OPTIONAL, and absent means DECLINE. An unpinned load still refuses a contested name rather than
 * taking the first row — the PIN LAW's own rule, that ambient or defaulted org context is a
 * refusal condition, finally carried into this layer.
 */
export interface GenomeLoadPin {
  acting_org_id?: string | undefined;
  /**
   * THE BASE UNDER THE ROWS (3 Oct 2026). A file genome layers
   * `{ "extends": ["./coltrane"] }` over the engine's own agents, standards, types and skills; the
   * store genome had nothing under it, so an org had to COPY every engine definition its standards
   * named — and the day one copy was incomplete, the drain refused every gig in the org at claim
   * time ("references unknown agent \"john\"", 3 Oct 2026). A copy of engine material into an org
   * layer is a missing operator; this is the operator.
   *
   * Org rows OVERRIDE the base by slug (the file loader's fold, loadLayeredGenome). `null` means
   * rows alone — what a test or a diagnostic asks for; `undefined` means no base was handed in,
   * which is how reconstructGenome is called directly. The two store backings pass the engine's
   * packaged genome unless told `null`, so the box and the hosted surface read ONE effective genome.
   *
   * NOT folded: venues, charts, institutions. A room or a chart is an org's statement about itself,
   * and an org's rooms are its own (WI-11). Core types are the canonical six either way.
   */
  base?: LoadedGenome | null | undefined;
}

/** Where the engine's own genome lives: the directory holding package.json AND agents/, found by
 *  walking up from this module — one level up from src/ (vitest), two from dist/src/ (built). The
 *  package ships agents, standards, domain_types, skills, charts, venues, institutions (package.json
 *  `files`), so an installed engine carries its base with it. */
export function engineBaseRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "agents"))) return dir;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

let ENGINE_BASE: LoadedGenome | undefined;
/** The engine's packaged genome, loaded once per process through the manifest-aware file loader.
 *  No root found is a packaging fault and says so — a silent empty base would be exactly the
 *  "rows alone" state this operator exists to end. */
export function engineBaseGenome(): LoadedGenome {
  if (ENGINE_BASE) return ENGINE_BASE;
  const root = engineBaseRoot();
  if (!root) throw new GenomeLoadError("engine base: no package root holding package.json and agents/ above this module");
  ENGINE_BASE = resolveGenome(root);
  return ENGINE_BASE;
}

/** THE VERSION RULE, one for every class (3 Oct 2026). Among the rows that stand, the HIGHEST version
 *  per slug wins — that is what a version is. Two rows at one version are contradictory data and refuse
 *  naming both. A version that is not a number is refused by name and dropped: it must neither win nor
 *  vanish by row order (the non-author grade of the standards rule found that coin toss in every branch).
 *  Rows with no slug pass through so the class loop reports `missing required "slug" field` itself. */
function highestVersionPerSlug(rows: Row[], kind: "agent" | "standard" | "skill", table: string, load_errors: LoadError[]): Row[] {
  const best = new Map<string, Row>();
  const clash = new Map<string, Row[]>();
  const noSlug: Row[] = [];
  for (const r of rows) {
    const slug = typeof r["slug"] === "string" ? r["slug"] : null;
    if (!slug) { noSlug.push(r); continue; }
    const raw = r["version"];
    const v = raw === undefined || raw === null ? 1 : Number(raw);
    if (!Number.isFinite(v)) {
      load_errors.push({ kind, path: `postgrest:${table}/${slug}`, slug,
        error: `${kind} "${slug}": version ${JSON.stringify(raw)} is not a number — a version is a number, and the engine will not order rows it cannot compare` });
      continue;
    }
    const cur = best.get(slug);
    const cv = cur ? Number(cur["version"] ?? 1) : -Infinity;
    if (!cur || v > cv) { best.set(slug, r); clash.set(slug, [r]); }
    else if (v === cv) { clash.set(slug, [...(clash.get(slug) ?? []), r]); }
  }
  for (const [slug, rs] of clash) {
    if (rs.length <= 1) continue;
    const how = rs.map((r) => `status ${String(r["status"] ?? "active")}`).join(", ");
    load_errors.push({ kind, path: `postgrest:${table}/${slug}`, slug,
      error: `ambiguous ${kind} "${slug}": ${rs.length} rows share one version (${how}) — `
           + `a version history has one row per version, and the engine will not pick by row order` });
    best.delete(slug);
  }
  return [...best.values(), ...noSlug];
}

export function reconstructGenome(rows: GenomeRows, pin?: GenomeLoadPin): LoadedGenome {
  const { core_types: coreRows, domain_types: typeRows, agents: agentRows, standards: standardRows, skills: skillRows } = rows;
  const load_errors: LoadError[] = [];
  // The base under the rows. Seeded first; org rows override by slug below. `provenance`
  // records which layer supplied each effective definition, as loadLayeredGenome does.
  const base = pin?.base ?? undefined;
  const provenance = new Map<string, string>();
  const seed = <V>(into: Map<string, V>, from: ReadonlyMap<string, V> | undefined, kind: string) => {
    if (!from) return;
    for (const [k, v] of from) { into.set(k, v); provenance.set(`${kind}:${k}`, "engine-base"); }
  };
  // A broken packaged base is NAMED, not inferred: its load errors ride into the effective genome,
  // exactly as loadLayeredGenome carries every layer's errors. Without this a base definition that
  // failed to parse is silently a smaller base, and the org sees only the downstream symptom
  // ("references unknown agent …") — the non-author grade's note 1.
  for (const e of base?.load_errors ?? []) load_errors.push(e);

      // core types — engine-owned, immutable 6. No rows visible → seed the canonical set,
      // exactly as loadGenome does for a root with no core_types/. A PARTIAL set is a corrupt
      // store view and hard-fails, mirroring the loader's strict gate.
      const core_types = new Map<string, CoreTypeRecord>();
      if (coreRows.length === 0) {
        for (const c of CANONICAL_CORE_TYPES) core_types.set(c.slug, c);
      } else {
        for (const r of coreRows) {
          core_types.set(String(r["slug"]), {
            slug: String(r["slug"]),
            primitive: String(r["primitive"]),
            description: String(r["description"] ?? ""),
            schema: (r["base_schema"] ?? {}) as object,
          });
        }
        const missing = REQUIRED_CORE_SLUGS.filter((s) => !core_types.has(s));
        if (missing.length > 0) {
          throw new GenomeLoadError(`coltrane_core_types missing required slugs: ${missing.join(", ")}`);
        }
      }

      // domain types — the loader's three checks, in the loader's order: core-type extends,
      // representability (domainTypeDefect), then the single Zod source. Soft-fail per row.
      const domain_types = new Map<string, DomainTypeRecord>();
      seed(domain_types, base?.domain_types, "domain_type");
      for (const r of typeRows) {
        const slug = typeof r["slug"] === "string" ? r["slug"] : null;
        const path = `postgrest:coltrane_domain_types/${slug ?? "?"}`;
        try {
          if (!core_types.has(String(r["extends"]))) {
            throw new Error(`field "extends" references "${String(r["extends"])}" which is not a core type`);
          }
          const defect = domainTypeDefect(r as never);
          if (defect) throw new Error(defect);
          const check = DomainTypeSchema.safeParse(r);
          if (!check.success) throw new Error(`type schema validation failed — ${zodWhy(check.error.issues)}`);
          const rec = check.data as DomainTypeRecord;
          domain_types.set(`${rec.slug}@${rec.version}`, rec);
          provenance.set(`domain_type:${rec.slug}@${rec.version}`, "store");
        } catch (e) {
          load_errors.push({ kind: "domain_type", path, slug, error: e instanceof Error ? e.message : String(e) });
        }
      }

      // agents — defineAgent is the loader's own gate (schema parse + composition rules).
      // Hosted rows soft-fail per row: one broken profile is a reported load error, not a
      // dead genome for every caller behind this RLS scope.
      const agents = new Map<string, Agent>();
      seed(agents, base?.agents, "agent");
      // A duplicate is two ORG rows claiming one slug. An org row under a BASE slug is an override,
      // which is the whole point of a layer — so the check reads what the org stated, not the map.
      const orgAgents = new Set<string>();
      // The version rule for agents (after the grade of the standards rule): retired and superseded
      // rows are not agents; the highest standing version per slug wins; a same-version clash refuses.
      const standingAgentRows = highestVersionPerSlug(
        agentRows.filter((r) => r["status"] !== "retired" && r["status"] !== "superseded"),
        "agent", "coltrane_agent_profiles", load_errors);
      for (const r of standingAgentRows) {
        const slug = typeof r["slug"] === "string" ? r["slug"] : null;
        const path = `postgrest:coltrane_agent_profiles/${slug ?? "?"}`;
        try {
          if (!slug) throw new Error(`missing required "slug" field`);
          if (orgAgents.has(slug)) throw new Error(`duplicate agent slug "${slug}"`);
          agents.set(slug, defineAgent(agentDefFromRow(r) as never));
          orgAgents.add(slug);
          provenance.set(`agent:${slug}`, "store");
        } catch (e) {
          load_errors.push({ kind: "agent", path, slug, error: e instanceof Error ? e.message : String(e) });
        }
      }

      // standards — phases jsonb is already the engine phase shape; the agents a standard
      // composes are the ones its chairs name. composeStandard is the loader's own gate.
      const standards = new Map<string, Standard>();
      seed(standards, base?.standards, "standard");
      const orgStandards = new Set<string>();

      // A DRAFT IS NOT A PROMISE — the sovereign's ruling, and the venue rule one class over.
      //
      // Two of production's six load errors were DRAFT standards whose chairs feed an agent a
      // type its input_types never declared. That is a real composition fault and the drain
      // was right to dislike it — but it was reported as a fault of the DRAIN's genome, and it
      // held the worker closed against work that had nothing to do with either draft. A draft
      // is a thing being written. It is not part of what the drain runs, so its problems are
      // not the drain's problems.
      //
      // NOT AN EXCUSE TO STOP CHECKING THEM: the composition rule still runs at PROMOTE, where
      // it belongs. "Drafts do not load" must never quietly become "drafts are never checked",
      // and a law holds that line — a draft that fails composition cannot be promoted.
      //
      // Reported as NOTHING, deliberately: a draft that cannot compose produces no load_error,
      // because an error the operator cannot act on (they did not ask for the draft to run) is
      // noise that trains people to ignore the list.
      const isDraft = (r: Row) => r["status"] === "draft";
      // WHICH ROWS ARE STANDARDS — the skills rule, one class over (3 Oct 2026). The governed upsert
      // RETIRES the prior active version when a new one lands; this branch dropped drafts and nothing
      // else, so a retired v1 beside its active v2 was two live claimants, the second threw
      // "duplicate standard slug", and the org's drain refused every gig at claim time over a
      // version history. Retired is not a room with a problem — it is not a room. Deprecated stands
      // ("do not reach for this", not "this does not exist"). Among what stands, the HIGHEST version
      // per slug wins, because that is what a version is; two rows at ONE version is contradictory
      // data and refuses naming both — never a coin toss by row order.
      const standingStandardRows = standardRows.filter((r) => !isDraft(r) && r["status"] !== "retired" && r["status"] !== "superseded");
      const liveStandardRows = highestVersionPerSlug(standingStandardRows, "standard", "coltrane_standards", load_errors);

      // Drafts are parsed into their OWN map, not dropped: standard_promote validates against
      // the loaded genome, so a draft absent from everything would be `notFound` and could
      // never be promoted. They are parsed leniently — a draft that cannot even be read is
      // simply not offered for promotion, and promote's own check is what refuses it there.
      const draft_standards = new Map<string, Standard>();
      for (const r of standardRows.filter(isDraft)) {
        const slug = typeof r["slug"] === "string" ? r["slug"] : null;
        if (!slug) continue;
        draft_standards.set(slug, {
          slug,
          domain: r["domain"] ?? "",
          phases: (r["phases"] ?? []) as readonly PhaseDef[],
          input_types: r["input_types"] ?? [],
          output_types: r["output_types"] ?? [],
          status: "draft",
        } as unknown as Standard);
      }

      for (const r of liveStandardRows) {
        const slug = typeof r["slug"] === "string" ? r["slug"] : null;
        const path = `postgrest:coltrane_standards/${slug ?? "?"}`;
        try {
          if (!slug) throw new Error(`missing required "slug" field`);
          if (orgStandards.has(slug)) throw new Error(`duplicate standard slug "${slug}"`);
          // F2 — a malformed examine loop is a NAMED load error, never a loop silently disabled. A
          // present max_examine_rounds must be a non-negative integer; the store row keeps it (O5).
          const mer = r["max_examine_rounds"];
          if (mer !== undefined && mer !== null && (typeof mer !== "number" || !Number.isInteger(mer) || mer < 0)) {
            throw new Error(`field max_examine_rounds must be a non-negative integer, got ${JSON.stringify(mer)}`);
          }
          const rp = r["reserve_pool"];
          const phases = (r["phases"] ?? []) as readonly PhaseDef[];
          const chairAgentSlugs = [
            ...new Set(phases.flatMap((p) => (p.chairs ?? []).map((c) => c.agent_slug).filter((s): s is string => !!s))),
          ];
          const resolved: Agent[] = chairAgentSlugs.map((aslug) => {
            const a = agents.get(aslug);
            if (!a) throw new Error(`references unknown agent "${aslug}"`);
            return a;
          });
          standards.set(
            slug,
            composeStandard({
              slug,
              domain: String(r["domain"] ?? ""),
              agents: resolved,
              phases,
              status: (r["status"] as "active" | "deprecated" | "retired" | undefined) ?? "active",
              // input_types is load-bearing: it names the entry-chair contracts the GIG INPUT
              // satisfies. Dropping it fails composition at every entry chair (found live).
              ...(Array.isArray(r["input_types"]) ? { input_types: r["input_types"] as string[] } : {}),
              ...(Array.isArray(r["output_types"]) ? { output_types: r["output_types"] as string[] } : {}),
              // O5 — carry the examine loop and reserve pool through compose (loss-free `...def`
              // spread) so the reconstructed standard keeps both. Absent leaves them unset.
              ...(typeof mer === "number" ? { max_examine_rounds: mer } : {}),
              ...(typeof rp === "number" ? { reserve_pool: rp } : {}),
            }),
          );
          orgStandards.add(slug);
          provenance.set(`standard:${slug}`, "store");
        } catch (e) {
          load_errors.push({ kind: "standard", path, slug, error: e instanceof Error ? e.message : String(e) });
        }
      }

      // skills — the row's skill_md IS the loaded reasoning half (`md`, the prompt's Skills
      // layer). Hosted skills carry no local package dir / code half by construction.
      const skills = new Map<string, SkillRecord>();
      seed(skills, base?.skills, "skill");
      // WHICH ROWS ARE SKILLS — the venue rule, one class over, with one difference that
      // matters. Venues could filter to `active` alone because a superseded room is not a
      // room. Skills carry three statuses and the engine defaults a missing one to "active"
      // (see the domain_types loop above), which says a DEPRECATED skill is still meant to
      // load: deprecated means "do not reach for this", not "this does not exist". Dropping
      // deprecated rows to fix a duplicate would silently remove skills that are in use.
      // So: RETIRED is ignored; deprecated and active both stand.
      const liveSkillRows = skillRows.filter((r) => {
        const st = r["status"];
        return st === undefined || st === null || st !== "retired";
      });

      // AMONG SURVIVORS, THE HIGHEST VERSION PER (org, slug) WINS — because that is what a
      // version IS. Two rows at the SAME version claiming one slug is not a version history,
      // it is contradictory data, and it REFUSES naming both: picking would be the row-order
      // coin toss this loader has now been cured of twice.
      const bestSkill = new Map<string, Row>();
      const skillClash = new Map<string, Row[]>();
      for (const r of liveSkillRows) {
        const slug = typeof r["slug"] === "string" ? r["slug"] : null;
        if (!slug) continue;
        const key = `${String(r["org_id"] ?? "")}\u0000${slug}`;
        const cur = bestSkill.get(key);
        const v = Number(r["version"] ?? 1);
        if (!Number.isFinite(v)) {
          load_errors.push({ kind: "skill", path: `postgrest:coltrane_skills/${slug}`, slug,
            error: `skill "${slug}": version ${JSON.stringify(r["version"])} is not a number — a version is a number, and the engine will not order rows it cannot compare` });
          continue;
        }
        const cv = cur ? Number(cur["version"] ?? 1) : -Infinity;
        if (!cur || v > cv) { bestSkill.set(key, r); skillClash.set(key, [r]); }
        else if (v === cv) { skillClash.set(key, [...(skillClash.get(key) ?? []), r]); }
      }
      for (const [key, rs] of skillClash) {
        if (rs.length <= 1) continue;
        // The slug comes off the ROW, not off the composite key. Deriving it by splitting the
        // key was fragile in a way the verifier's M4 exposed: with the org dropped from the
        // key there is no separator, the split yields nothing at [1], and the error was
        // reported against slug "?" — so the same-version law died for the WRONG CAUSE under
        // that mutant. A law that dies for the wrong reason is as misleading as one that
        // survives for the wrong reason, and this is the second time today a defect has come
        // from reading a fact out of a derived string instead of off the thing itself.
        const slug = typeof rs[0]?.["slug"] === "string" ? (rs[0]["slug"] as string) : "?";
        const how = rs.map((r) => `status ${String(r["status"] ?? "active")}`).join(", ");
        load_errors.push({
          kind: "skill",
          path: `postgrest:coltrane_skills/${slug}`,
          slug,
          error: `ambiguous skill "${slug}": ${rs.length} rows share one version (${how}) — `
               + `a version history has one row per version, and the engine will not pick by row order`,
        });
        bestSkill.delete(key);
      }

      for (const r of bestSkill.values()) {
        const slug = typeof r["slug"] === "string" ? r["slug"] : null;
        const path = `postgrest:coltrane_skills/${slug ?? "?"}`;
        try {
          if (!slug) throw new Error(`missing required "slug" field`);
          const meta: Row = {
            slug,
            description: r["description"] ?? undefined,
            input_type: r["input_type"] ?? undefined,
            output_type: r["output_type"] ?? undefined,
            ...(typeof r["tier"] === "number" ? { permission: { tier: r["tier"] } } : {}),
            ...(typeof r["skill_md"] === "string" ? { md: r["skill_md"] } : {}),
          };
          for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
          const check = SkillSchema.safeParse(meta);
          if (!check.success) throw new Error(`skill schema validation failed — ${zodWhy(check.error.issues)}`);
          skills.set(slug, check.data as SkillRecord);
          provenance.set(`skill:${slug}`, "store");
        } catch (e) {
          load_errors.push({ kind: "skill", path, slug, error: e instanceof Error ? e.message : String(e) });
        }
      }

  // evals — no hosted table today; present and empty, the same shape as a genome
  // root with no evals/ directory.
  const evals = new Map<string, EvalRecord>();
  // charts + venues — likewise: the classes exist in the engine and are authorable over the file
  // backing, but the store has no coltrane_charts / coltrane_venues table to read yet. Present and
  // empty is the same shape as a genome root with no charts/ or venues/ directory, so every reader
  // (chart_browse, gig_dispatch, system_health) behaves identically against a hosted genome — it
  // finds nothing, and says nothing was found. Adding the two tables + the upsert branches is
  // store-side work; nothing here changes when they land.
  const charts = new Map<string, Chart>();
  const venues = new Map<string, Venue>();

  // venues before charts — a chart names a venue, exactly the loader's ordering.
  //
  // A2 · ONLY ACTIVE ROWS ARE ROOMS. `status` is a STORE concept: the PostgREST backing
  // selects it, the file backing has no such column. So a row that carries no status is
  // taken as standing (a file genome has no versioning to disagree with), and a row that
  // carries one must say `active`. Superseded and retired rows are not rooms with problems
  // — they are not rooms, and reading them was the whole defect.
  const liveVenueRows = (rows.venues ?? []).filter((r) => {
    const st = r["status"];
    return st === undefined || st === null || st === "active";
  });

  // WI-11 · A ROOM BELONGS TO AN ORG. The store keys venues (org_id, slug, version); this layer
  // keyed them by slug alone, and the two layers disagreed about whether a venue name is unique.
  // The store is right: `verifier-desk` in two orgs is two rooms, not a duplicate — both were
  // opened deliberately, the later one by hand.
  //
  // So a pinned load scopes to the acting org FIRST, and another org's room simply is not this
  // genome's room. What remains after scoping is a genuine same-org collision, and that still
  // refuses below.
  //
  // The pin is a UUID because slugs are precisely what collides here; accepting one would move the
  // ambiguity rather than close it. An unrecognisable pin scopes to nothing rather than silently
  // loading everything — absent and malformed must both mean DECLINE, which is the PIN LAW's own
  // rule ("ambient or defaulted context is a refusal condition") reaching this layer at last.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const actingOrg = pin?.acting_org_id;
  const scopedVenueRows =
    actingOrg === undefined
      ? liveVenueRows
      : liveVenueRows.filter((r) => UUID.test(actingOrg) && r["org_id"] === actingOrg);

  // A2 · TWO ACTIVE ROWS CLAIMING ONE NAME IS AN AMBIGUITY, NOT A RACE. Previously the
  // second arrival threw "duplicate venue slug" and which room the genome held was a
  // function of row order — a fact nobody declared. There is no caller and no org context
  // at this layer (org_id is RLS's concern, stated above), so choosing between them would
  // be a coin toss wearing a determinism costume. It refuses, naming every claimant, on the
  // precedent set for principals: attribution is a fact, not a coin toss.
  const bySlug = new Map<string, Row[]>();
  for (const r of scopedVenueRows) {
    const k = typeof r["slug"] === "string" ? r["slug"] : "?";
    bySlug.set(k, [...(bySlug.get(k) ?? []), r]);
  }
  for (const [k, rs] of bySlug) {
    if (rs.length > 1) {
      const claimants = rs.map((r) => `org ${String(r["org_id"] ?? "?")} v${String(r["version"] ?? "?")}`);
      const msg = `ambiguous venue "${k}": ${rs.length} ACTIVE rows claim this name (${claimants.join(", ")}) `
        + `— the engine will not pick one by row order`;
      load_errors.push({ kind: "venue", path: `postgrest:coltrane_venues/${k}`, slug: k, error: msg });
    }
  }

  for (const r of scopedVenueRows) {
    const slug = typeof r["slug"] === "string" ? r["slug"] : null;
    const path = `postgrest:coltrane_venues/${slug ?? "?"}`;
    if (slug !== null && (bySlug.get(slug)?.length ?? 0) > 1) continue;  // already reported
    try {
      const check = VenueSchema.safeParse(r["definition"]);
      if (!check.success) throw new Error(`venue schema validation failed — ${zodWhy(check.error.issues)}`);
      const defect = venueDefect(check.data);
      if (defect) throw new Error(defect);
      venues.set(check.data.slug, check.data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A1 · A GENOME THAT FAILED TO LOAD IS NOT A GENOME. An ACTIVE room that cannot be
      // read used to be filed in load_errors while the load returned successfully — so the
      // engine served a genome in which the residency did not exist and said nothing to the
      // caller who asked for one. An empty result and a broken read are indistinguishable
      // downstream, and the empty one reads as healthy.
      //
      // THIS LOADER REPORTS; THE CONSUMER REFUSES. Two wrong answers preceded this one.
      // First I gave reconstructGenome a `{diagnostic}` flag no caller set — dead code
      // wearing the costume of a control. Then I removed it and made the refusal
      // unconditional, on a law proving the only consumer was the drain worker: a law that
      // grepped FOUR FILES IN THIS REPO and was true of them and false of the system. The
      // consumer it could not see runs on production — coltrane-ui's src/lib/hosted-genome.ts
      // imports GenomeStore from this package, and its genomeSurfaceSlice hands
      // `load_errors` to the SERVED MCP's deps. That is where system_health is actually read.
      // Every load_error seen there carries a `postgrest:` path, which only this file builds.
      //
      // So an unconditional throw here silences production's diagnostic on the next bad
      // active room — the very hazard the dead flag was gesturing at, reintroduced by the
      // fix for it. The rule belongs where the obligation is: this loader REPORTS, and the
      // drain worker REFUSES TO RUN when anything failed to load. Fail-closed at the
      // consumer that must not proceed, reporting intact for the one that must see.
      load_errors.push({ kind: "venue", path, slug, error: `venue "${slug ?? "?"}" is active but could not be loaded — ${msg}` });
    }
  }
  for (const r of rows.charts ?? []) {
    const slug = typeof r["slug"] === "string" ? r["slug"] : null;
    const path = `postgrest:coltrane_charts/${slug ?? "?"}`;
    try {
      const check = ChartSchema.safeParse(r["definition"]);
      if (!check.success) throw new Error(`R0: chart does not parse — ${zodWhy(check.error.issues)}`);
      if (charts.has(check.data.slug)) throw new Error(`duplicate chart slug "${check.data.slug}"`);
      const composed = composeChart({
        chart: check.data,
        standards,
        agents,
        venues,
        // the loader's own load-time stand-in for the dispatch payload
        payload_types: chartEntrySeedTypes(check.data, standards),
      });
      if (!composed.ok) throw new Error(composed.violations.map((v) => `${v.rule}: ${v.detail}`).join(" | "));
      charts.set(check.data.slug, composed.chart);
    } catch (e) {
      load_errors.push({ kind: "chart", path, slug, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { core_types, domain_types, agents, standards, draft_standards, skills, evals, charts, venues, load_errors, provenance };
}

/** Hosted backing: load the genome from the store's five tables and reconstruct the SAME
 *  in-memory shape the file loader produces; upsert through the governed RPC. */
export function postgrestGenomeStore(ctx: PostgrestContext): GenomeStore {
  return {
    async load(): Promise<LoadedGenome> {
      const [core_types, domain_types, agents, standards, skills, charts, venues] = await Promise.all([
        restGet(ctx, Q.core_types),
        restGet(ctx, Q.domain_types),
        restGet(ctx, Q.agents),
        restGet(ctx, Q.standards),
        restGet(ctx, Q.skills),
        restGet(ctx, Q.charts),
        restGet(ctx, Q.venues),
      ]);
      return reconstructGenome(
        { core_types, domain_types, agents, standards, skills, charts, venues },
        { acting_org_id: ctx.acting_org_id, base: baseFor(ctx) },
      );
    },

    async upsert(cls: GenomeClass, payload: Record<string, unknown>, org_slug?: string): Promise<void> {
      const res = await fetch(`${ctx.baseUrl}/rest/v1/rpc/coltrane_genome_upsert`, {
        method: "POST",
        headers: {
          apikey: ctx.anonKey,
          Authorization: `Bearer ${ctx.bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_class: cls, p_payload: payload, p_org_slug: org_slug ?? null }),
      });
      if (!res.ok) {
        const text = await res.text();
        let message = text || `store error ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { message?: string };
          if (parsed.message) message = parsed.message;
        } catch { /* keep the raw text */ }
        throw new Error(`genome upsert (${cls}) refused: ${message}`);
      }
    },
  };
}

/** Agent-token backing: the org genome through coltrane_mcp_genome. PostgREST verifies only
 *  JWTs, so a ctk_ bearer cannot ride the REST tables — the definer RPC resolves the token's
 *  hash inside the store and returns the org's rows. Same reconstruction as every backing.
 *  Read-only by design: an agent token does not author genome (authoring is a member act,
 *  governed by the upsert RPC as auth.uid()). */
/** The agent-token backing. An agent token is issued per-agent within ONE org, so its acting org is
 *  known to whoever minted it — passed here rather than re-derived, because a second derivation is a
 *  second belief about who is acting. */
export function rpcGenomeStore(
  ctx: { baseUrl: string; anonKey: string; agentToken: string; acting_org_id?: string | undefined; base?: LoadedGenome | null | undefined },
): GenomeStore {
  return {
    async load(): Promise<LoadedGenome> {
      const res = await fetch(`${ctx.baseUrl}/rest/v1/rpc/coltrane_mcp_genome`, {
        method: "POST",
        headers: {
          apikey: ctx.anonKey,
          // The ctk bearer is NOT a JWT: it authenticates inside the definer RPC via the
          // body; the transport rides the anon key.
          Authorization: `Bearer ${ctx.anonKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_bearer: ctx.agentToken }),
      });
      const text = await res.text();
      if (!res.ok) {
        let message = text || `store error ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { message?: string };
          if (parsed.message) message = parsed.message;
        } catch { /* keep the raw text */ }
        throw new GenomeLoadError(`genome load (agent token): ${message}`);
      }
      const rows = JSON.parse(text) as Partial<GenomeRows> & { org_id?: unknown };
      // THE ANSWER NAMES ITS OWN ORG. `coltrane_mcp_genome` authenticates a `ctk_`, and
      // `coltrane_agent_token.org_id` is `uuid NOT NULL` with one row per key — so a token resolves
      // to exactly one organization BY CONSTRUCTION. Nothing selects, so nothing can select wrong.
      //
      // This is what lets the drain pin itself. Its claim carries `acting_for` (an agent slug) and
      // no org, and it does not need one: the genome answer it is already reading names the org,
      // from the authoritative source. No third repo, no second resolution path, and the caller's
      // explicit pin still wins when one was given.
      const answeredOrg = typeof rows.org_id === "string" ? rows.org_id : undefined;
      return reconstructGenome({
        core_types: rows.core_types ?? [],
        domain_types: rows.domain_types ?? [],
        agents: rows.agents ?? [],
        standards: rows.standards ?? [],
        skills: rows.skills ?? [],
        charts: rows.charts ?? [],
        venues: rows.venues ?? [],
      }, { acting_org_id: ctx.acting_org_id ?? answeredOrg, base: baseFor(ctx) });
    },
    async upsert(): Promise<void> {
      throw new Error("an agent token does not author genome — authoring is a member act through the governed upsert");
    },
  };
}

/** Set the caller's working organization — the formal switch, recorded in the store as a
 *  member act. After this, every member write resolves the org without being told. */
export function postgrestOrgUse(ctx: PostgrestContext): (org_slug: string) => Promise<string> {
  return async (org_slug) => {
    const res = await fetch(`${ctx.baseUrl}/rest/v1/rpc/coltrane_org_use`, {
      method: "POST",
      headers: {
        apikey: ctx.anonKey,
        Authorization: `Bearer ${ctx.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_org_slug: org_slug }),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text || `store error ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch { /* keep the raw text */ }
      throw new Error(message);
    }
    return JSON.parse(text) as string;
  };
}

/**
 * NO SILENT DROP at the engine's own queue clients. The hosted dispatch door may hand a queue seam
 * `resumes` (a closed gig's link) or `budget_micro_usd` (the run's ceiling). The store RPCs these
 * clients call accept neither parameter today, and PostgREST resolves a function by its exact
 * argument names — sending p_resumes / p_budget_micro_usd would fail EVERY call ("function not
 * found": the 0.24.12 p_venue outage). Dropping them would queue a fresh, unlinked, unbounded gig. So
 * a client handed either one refuses by name, before anything is sent. Absent fields send no key.
 */
function refuseUncarriedQueueFields(client: string, rpc: string, args: Record<string, unknown>): void {
  const uncarried = ["resumes", "budget_micro_usd"].filter((k) => args[k] !== undefined && args[k] !== null);
  if (uncarried.length > 0) {
    throw new Error(
      `${client}: ${rpc} cannot carry ${uncarried.map((k) => `\`${k}\``).join(" or ")} — refused before sending, ` +
        `rather than queued without it. Queue through a host that carries it (coltrane-ui's dispatchGig).`,
    );
  }
}

/** The agent-token gig-queue seam: queue one run through coltrane_mcp_dispatch, where the
 *  chair contract authorizes (the seat grants the standard; the token may only narrow).
 *  Same return shape as postgrestQueueGig so a host can swap them by bearer class. */
export function rpcQueueGig(
  ctx: { baseUrl: string; anonKey: string; agentToken: string },
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (args) => {
    refuseUncarriedQueueFields("rpcQueueGig", "coltrane_mcp_dispatch", args);
    const res = await fetch(`${ctx.baseUrl}/rest/v1/rpc/coltrane_mcp_dispatch`, {
      method: "POST",
      headers: {
        apikey: ctx.anonKey,
        Authorization: `Bearer ${ctx.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_bearer: ctx.agentToken,
        p_standard: args["standard_slug"],
        p_mode: args["mode"] ?? "live",
        p_input: args["input"] ?? {},
        // The room the chart names, carried NULL-not-absent for the same reason p_acting_for is
        // (postgrestQueueGig below): an omitted key and an explicit null say different things to a
        // store. Both bearer-class seams must carry it, or a control's behaviour would depend on
        // how the caller logged in.
        p_venue: args["venue"] ?? null,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text || `store error ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch { /* keep the raw text */ }
      throw new Error(message);
    }
    return { gig_id: JSON.parse(text) as string, status: "queued" };
  };
}

/** The store's answer to "what status is this gig in?" — the ServerDeps.gigStatus seam
 *  (src/server.ts), through coltrane_mcp_gig_status as the agent token. Null when the store holds no
 *  such gig. The RPC may answer with the row or a single-row array; both are the same fact. */
export function rpcGigStatus(
  ctx: { baseUrl: string; anonKey: string; agentToken: string },
): (gig_id: string) => Promise<string | null> {
  return async (gig_id) => {
    const res = await fetch(`${ctx.baseUrl}/rest/v1/rpc/coltrane_mcp_gig_status`, {
      method: "POST",
      headers: { apikey: ctx.anonKey, Authorization: `Bearer ${ctx.anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bearer: ctx.agentToken, p_gig: gig_id }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`coltrane_mcp_gig_status ${res.status}: ${text.slice(0, 200)}`);
    const out = text ? (JSON.parse(text) as unknown) : null;
    const row = Array.isArray(out) ? out[0] : out;
    const status = row && typeof row === "object" ? (row as Record<string, unknown>)["status"] : undefined;
    return typeof status === "string" ? status : null;
  };
}

/** The hosted gig-queue seam for createToolSurface: queue one run through the governor-gated
 *  dispatch RPC AS THE CALLER (member JWT — RLS + the governor gate decide). Queuing only;
 *  a drain worker claims and runs it. Shape mirrors hosted_tools' member dispatch path. */
export function postgrestQueueGig(
  ctx: PostgrestContext,
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (args) => {
    refuseUncarriedQueueFields("postgrestQueueGig", "coltrane_gig_dispatch", args);
    const res = await fetch(`${ctx.baseUrl}/rest/v1/rpc/coltrane_gig_dispatch`, {
      method: "POST",
      headers: {
        apikey: ctx.anonKey,
        Authorization: `Bearer ${ctx.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_standard: args["standard_slug"],
        p_mode: args["mode"] ?? "live",
        p_input: args["input"] ?? {},
        p_org_slug: args["org_slug"] ?? null,
        // WHO ACTS, as distinct from who asked. The store requires a SEATED player: the genome read
        // a run needs is gated on seating, so an unseated name — or none, from an unseated human —
        // produces a gig that can only fail at genome load, thirty minutes later, on a drain.
        // That is exactly what the first real gig did.
        p_acting_for: args["acting_for"] ?? null,
        // The venue the chart names, NULL-not-absent exactly as p_acting_for above: an unnamed room
        // is the statement "I have no opinion", not an absent key. Carried on both bearer-class
        // seams (rpcQueueGig too) so targeting behaves the same regardless of how one logged in.
        p_venue: args["venue"] ?? null,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text || `store error ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch { /* keep the raw text */ }
      throw new Error(message);
    }
    return { gig_id: JSON.parse(text) as string, status: "queued" };
  };
}

/** The hosted gig-cancel seam for createToolSurface: cancel one QUEUED run through the
 *  member-authenticated coltrane_gig_cancel RPC AS THE CALLER (member JWT — RLS + org
 *  membership decide). The RPC cancels only a queued row and RAISES on a claimed/running/
 *  terminal one, so a running gig fails closed (the store points the caller at gig_abort).
 *  Shape mirrors postgrestQueueGig's member dispatch path. */
export function postgrestCancelGig(
  ctx: PostgrestContext,
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (args) => {
    const res = await fetch(`${ctx.baseUrl}/rest/v1/rpc/coltrane_gig_cancel`, {
      method: "POST",
      headers: {
        apikey: ctx.anonKey,
        Authorization: `Bearer ${ctx.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_gig: args["gig_id"] }),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text || `store error ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch { /* keep the raw text */ }
      throw new Error(message);
    }
    return { gig_id: JSON.parse(text) as string, status: "cancelled" };
  };
}

/** The agent-token gig-cancel seam: cancel one QUEUED run through the security-definer
 *  coltrane_mcp_gig_cancel RPC, where the token's org + may_dispatch list scope what it may
 *  reach. Like postgrestCancelGig, the RPC cancels only a queued row and RAISES on a
 *  claimed/running/terminal one. Same return shape so a host can swap them by bearer class. */
export function rpcCancelGig(
  ctx: { baseUrl: string; anonKey: string; agentToken: string },
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (args) => {
    const res = await fetch(`${ctx.baseUrl}/rest/v1/rpc/coltrane_mcp_gig_cancel`, {
      method: "POST",
      headers: {
        apikey: ctx.anonKey,
        // The ctk bearer is NOT a JWT: it authenticates inside the definer RPC via the body;
        // the transport rides the anon key.
        Authorization: `Bearer ${ctx.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_bearer: ctx.agentToken, p_gig: args["gig_id"] }),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text || `store error ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch { /* keep the raw text */ }
      throw new Error(message);
    }
    return { gig_id: JSON.parse(text) as string, status: "cancelled" };
  };
}

// ── A FINISHED GIG'S SEALS ARE READABLE FROM THE DOOR (conformance V-7) ─────────────────────────
// The hosted read seams for createToolSurface: a gig's sealed outputs and the gig row itself, read
// FROM THE ORG STORE as the caller. A member JWT rides PostgREST and RLS decides (coutputs_org_read /
// cgigs_org_read: coltrane_is_org_member(org_id)); a ctk_ agent token takes the security-definer RPCs
// that resolve the token inside the store (coltrane_mcp_gig_outputs / coltrane_mcp_gig_status), the
// same split hosted_tools.ts drew. A store refusal is thrown with the store's words — never turned
// into an empty list, which is the very answer these seams exist to end.

function isAgentBearer(bearer: string): boolean {
  return bearer.startsWith("ctk_");
}

async function storeRead(ctx: PostgrestContext, path: string, init?: { method: "POST"; body: unknown }): Promise<unknown> {
  // THE AGENT TOKEN RIDES IN THE BODY, NEVER AS THE BEARER. PostgREST wants a JWT in Authorization; a ctk_
  // is not one, and it answered "Expected 3 parts in JWT; got 1" (401) to the reconciler's own read, live at
  // coltrane-ui cfbd57b. On the agent path the header carries the ANON key and the RPC's p_bearer carries
  // the token — the shape rpcQueueGig, rpcGigStatus and hosted_tools' rpc() have always kept.
  const authorization = isAgentBearer(ctx.bearer) ? ctx.anonKey : ctx.bearer;
  const headers: Record<string, string> = { apikey: ctx.anonKey, Authorization: `Bearer ${authorization}`, Accept: "application/json" };
  const req: RequestInit = init
    ? { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(init.body) }
    : { method: "GET", headers };
  const res = await fetch(`${ctx.baseUrl}/rest/v1/${path}`, req);
  const text = await res.text();
  if (!res.ok) {
    let message = text || `store error ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch { /* keep the raw text */ }
    throw new Error(`${path.split("?")[0]} ${res.status}: ${message}`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

const OUTPUT_COLUMNS =
  "id,gig_id,agent_slug,phase,primitive,core_type,domain_type,domain_type_version,domain,content_sha,input_refs,input_shas,created_at,cost_usd,data";

/** Hosted output read: the gig's sealed rows, oldest first, each carrying its content_sha. */
export function postgrestReadOutputs(
  ctx: PostgrestContext,
): (sel: { gig_id?: string | undefined; domain_type?: string | undefined; agent_slug?: string | undefined; output_id?: string | undefined; content_sha?: string | undefined }) => Promise<Record<string, unknown>[]> {
  return async (sel) => {
    let out: unknown;
    if (isAgentBearer(ctx.bearer)) {
      out = await storeRead(ctx, "rpc/coltrane_mcp_gig_outputs", { method: "POST", body: { p_bearer: ctx.bearer, p_gig: sel.gig_id ?? null } });
    } else {
      const q: string[] = [`select=${OUTPUT_COLUMNS}`];
      if (sel.gig_id) q.push(`gig_id=eq.${encodeURIComponent(sel.gig_id)}`);
      if (sel.domain_type) q.push(`domain_type=eq.${encodeURIComponent(sel.domain_type)}`);
      if (sel.agent_slug) q.push(`agent_slug=eq.${encodeURIComponent(sel.agent_slug)}`);
      if (sel.output_id) q.push(`id=eq.${encodeURIComponent(sel.output_id)}`);
      if (sel.content_sha) q.push(`content_sha=eq.${encodeURIComponent(sel.content_sha)}`);
      q.push("order=created_at");
      out = await storeRead(ctx, `coltrane_outputs?${q.join("&")}`);
    }
    return Array.isArray(out) ? (out as Record<string, unknown>[]) : [];
  };
}

const GIG_COLUMNS =
  "id,standard_slug,standard_version,status,mode,acting_for,dispatched_by,ran_on,attempts,resumes,work_order_id,genome_hash,run_fingerprint,total_cost_usd,total_tokens,total_duration_ms,created_at,started_at,completed_at,lease_until,manifest";

/** Hosted gig read: the row by id, or null when the store does not hold (or does not show) it. */
export function postgrestReadGig(ctx: PostgrestContext): (gig_id: string) => Promise<Record<string, unknown> | null> {
  return async (gig_id) => {
    const out = isAgentBearer(ctx.bearer)
      ? await storeRead(ctx, "rpc/coltrane_mcp_gig_status", { method: "POST", body: { p_bearer: ctx.bearer, p_gig: gig_id } })
      : await storeRead(ctx, `coltrane_gigs?select=${GIG_COLUMNS}&id=eq.${encodeURIComponent(gig_id)}`);
    const row = Array.isArray(out) ? out[0] : out;
    return row && typeof row === "object" ? (row as Record<string, unknown>) : null;
  };
}

// ── THE SOVEREIGN SEATS (RS-5) ───────────────────────────────────────────────────────────────────
/** Hosted seam for residency_seat: the member's own bearer rides PostgREST to public.coltrane_residency_seat
 *  (the wrapper over residency.seat), which authorizes on auth.uid() + org membership itself. Returns the
 *  new residency id. A store refusal is thrown with the store's words. Member JWT only — a ctk_ token is
 *  refused at the surface before this is reached (a seat does not seat seats). */
export function postgrestSeatResidency(
  ctx: PostgrestContext,
): (args: { org_slug: string; agent_slug: string; venue_slug: string; channel_id: string; hands?: string[]; repo?: string | null; may_dispatch?: string[] }) => Promise<{ residency_id: string }> {
  return async (args) => {
    const out = await storeRead(ctx, "rpc/coltrane_residency_seat", {
      method: "POST",
      body: {
        p_org_slug: args.org_slug, p_agent_slug: args.agent_slug, p_venue_slug: args.venue_slug, p_channel_id: args.channel_id,
        p_hands: args.hands ?? [], p_repo: args.repo ?? null, p_soul_output_id: null, p_may_dispatch: args.may_dispatch ?? [],
      },
    });
    if (typeof out !== "string" || !out) throw new Error("coltrane_residency_seat answered without a residency id");
    return { residency_id: out };
  };
}

// ── THE HOSTED SEAT IS A DOOR (WI-9 M1; conformance RS-5) ───────────────────────────────────────────
// THE DEPLOYMENT'S PROVIDER, SHIPPED HERE AND NOT IN THE RESIDE PATH. The engine's agnosticism law
// (tests/spec_reside_backing.test.ts) holds that reside*.ts names no store symbol and that the hosted
// backing is INJECTED by the deployment. This module is the store port — it already names /rest/v1 and
// the store's doors for queueing, cancelling and reading — so the four residency box doors live here,
// and the CLI (src/cli.ts, the deployment's edge in this package) injects the result into runReside.
// The doors are the PUBLIC wrappers of coltrane-ui 20261004090000 (the `residency` schema itself is not
// exposed over the wire), under the box's venue credential: COLTRANE_DRAIN_KEY + COLTRANE_INSTANCE. The
// wall is the store's — not_holder, stale_fence, gig_scoped_token ride up in the store's words and are
// never flattened into a null claim. THE FENCE crosses here as the store's type: the engine carries it as
// an opaque string; the doors take a bigint; a fence that is not a whole number is refused by name
// (bad_fence) before any call.
import type { ResidencyClaim } from "./reside.js";
import type { SeatBacking } from "./reside_backing.js";

export interface HostedSeatContext {
  baseUrl: string;
  anonKey: string;
  /** The venue credential (cdk_…) minted for this instance — never a member JWT, never an agent token. */
  key: string;
  /** The instance the key is bound to (COLTRANE_INSTANCE; FLY_APP_NAME is its legacy alias). */
  instance: string;
}

/** The public doors, by name. One place: a renamed wrapper is a one-line edit here and a red law. */
export const HOSTED_SEAT_DOORS = {
  claim: "coltrane_residency_claim",
  heartbeat: "coltrane_residency_heartbeat",
  release: "coltrane_residency_release",
  cursorAdvance: "coltrane_residency_cursor_advance",
} as const;

function fenceOrRefuse(fence: string): number {
  if (!/^\d+$/.test(fence)) {
    throw new Error(`bad_fence: the fence "${fence}" is not a whole number — the store's doors take a bigint fence; claim again rather than guess`);
  }
  return Number(fence);
}

async function door(ctx: HostedSeatContext, name: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${ctx.baseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: ctx.anonKey, Authorization: `Bearer ${ctx.anonKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ p_key: ctx.key, p_instance: ctx.instance, ...body }),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text || `store error ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch { /* keep the raw text */ }
    // the store's refusal names lead the message ("not_holder: …", "stale_fence: …"); they ride up as-is
    throw new Error(`${name} ${res.status}: ${message}`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

/** The store's claim row → the engine's ResidencyClaim. Keys as 20260904120000's claim returns them. */
export function claimFromRow(row: Record<string, unknown>): ResidencyClaim {
  const str = (k: string): string => (typeof row[k] === "string" ? (row[k] as string) : String(row[k] ?? ""));
  const list = (k: string): string[] => (Array.isArray(row[k]) ? (row[k] as unknown[]).map(String) : []);
  const claim: ResidencyClaim = {
    residency_id: str("residency_id"),
    agent_slug: str("agent_slug"),
    org: str("org_id"),
    venue_slug: str("venue_slug"),
    channel_id: str("channel_id"),
    session_id: typeof row["session_id"] === "string" ? (row["session_id"] as string) : null,
    cursor: Number(row["cursor"] ?? 0),
    lease_token: str("token"),
    hands: list("hands"),
    may_dispatch: list("may_dispatch"),
  };
  if (row["fence"] !== undefined && row["fence"] !== null) claim.fence = String(row["fence"]);
  if (row["gig_id"] !== undefined) claim.gig_id = row["gig_id"] === null ? null : String(row["gig_id"]);
  return claim;
}

/** The hosted SeatBacking: four doors, one credential, the store's words. */
export function postgrestSeatBacking(ctx: HostedSeatContext): SeatBacking {
  return {
    claim: async (which) => {
      const out = await door(ctx, HOSTED_SEAT_DOORS.claim, { p_residency_id: which === "any" ? null : which });
      if (out === null || typeof out !== "object") return null;
      const row = out as Record<string, unknown>;
      if (!row["residency_id"]) return null;
      return claimFromRow(row);
    },
    heartbeat: async (residencyId, fence) => {
      await door(ctx, HOSTED_SEAT_DOORS.heartbeat, { p_residency_id: residencyId, p_fence: fenceOrRefuse(fence) });
    },
    release: async (residencyId, fence, status) => {
      await door(ctx, HOSTED_SEAT_DOORS.release, { p_residency_id: residencyId, p_fence: fenceOrRefuse(fence), p_status: status });
    },
    cursorAdvance: async (residencyId, fence, n) => {
      const out = await door(ctx, HOSTED_SEAT_DOORS.cursorAdvance, { p_residency_id: residencyId, p_fence: fenceOrRefuse(fence), p_cursor: n });
      return typeof out === "number" ? out : Number(out ?? n);
    },
  };
}

/** The hosted backing from the drain environment, or the reason there is none. The same five names
 *  DRAIN_VARS marks as "hosted" (local_queue.ts); FLY_APP_NAME is COLTRANE_INSTANCE's legacy alias. */
export function hostedSeatBackingFromEnv(env: Record<string, string | undefined>): { ok: true; seat: SeatBacking } | { ok: false; missing: string[] } {
  const baseUrl = env["COLTRANE_STORE_URL"];
  const anonKey = env["COLTRANE_STORE_ANON"];
  const key = env["COLTRANE_DRAIN_KEY"];
  const instance = env["COLTRANE_INSTANCE"] ?? env["FLY_APP_NAME"];
  const missing = [
    !baseUrl ? "COLTRANE_STORE_URL" : null,
    !anonKey ? "COLTRANE_STORE_ANON" : null,
    !key ? "COLTRANE_DRAIN_KEY" : null,
    !instance ? "COLTRANE_INSTANCE" : null,
  ].filter((x): x is string => x !== null);
  if (missing.length) return { ok: false, missing };
  return { ok: true, seat: postgrestSeatBacking({ baseUrl: baseUrl!, anonKey: anonKey!, key: key!, instance: instance! }) };
}
