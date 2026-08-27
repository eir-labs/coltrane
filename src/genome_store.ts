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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { writeGenomeFileVersioned } from "./genome_writer.js";
import { defineAgent, composeStandard, type Agent, type Standard, type PhaseDef } from "./composition.js";
import { composeChart, chartEntrySeedTypes, type Chart, type Venue } from "./chart.js";
import { DomainTypeSchema, SkillSchema, ChartSchema, VenueSchema, venueDefect } from "./genome_schema.js";
import { domainTypeDefect } from "./registry.js";
import { CANONICAL_CORE_TYPES } from "./canonical_core_types.js";

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
      if (cls === "skill") {
        // Skills are PACKAGE directories (the loader's only skill format) — mirror
        // sealSkillPackage's file half: meta.json + code/md halves + fixtures.
        const pkgDir = join(root, "skills", slug);
        mkdirSync(pkgDir, { recursive: true });
        const { fixtures, code, md, ...meta } = payload;
        writeFileSync(join(pkgDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
        if (typeof code === "string") writeFileSync(join(pkgDir, "skill.mjs"), code);
        if (typeof md === "string") writeFileSync(join(pkgDir, "skill.md"), md);
        if (Array.isArray(fixtures)) {
          const fxDir = join(pkgDir, "fixtures");
          mkdirSync(fxDir, { recursive: true });
          fixtures.forEach((fx, i) =>
            writeFileSync(join(fxDir, `fixture-${String(i + 1).padStart(3, "0")}.json`), JSON.stringify(fx, null, 2) + "\n"),
          );
        }
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
  standards: "coltrane_standards?select=slug,version,status,domain,phases,input_types,output_types",
  skills: "coltrane_skills?select=slug,name,description,skill_md,tier,input_type,output_type,status",
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
export function reconstructGenome(rows: GenomeRows): LoadedGenome {
  const { core_types: coreRows, domain_types: typeRows, agents: agentRows, standards: standardRows, skills: skillRows } = rows;
  const load_errors: LoadError[] = [];

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
        } catch (e) {
          load_errors.push({ kind: "domain_type", path, slug, error: e instanceof Error ? e.message : String(e) });
        }
      }

      // agents — defineAgent is the loader's own gate (schema parse + composition rules).
      // Hosted rows soft-fail per row: one broken profile is a reported load error, not a
      // dead genome for every caller behind this RLS scope.
      const agents = new Map<string, Agent>();
      for (const r of agentRows) {
        const slug = typeof r["slug"] === "string" ? r["slug"] : null;
        const path = `postgrest:coltrane_agent_profiles/${slug ?? "?"}`;
        try {
          if (!slug) throw new Error(`missing required "slug" field`);
          if (agents.has(slug)) throw new Error(`duplicate agent slug "${slug}"`);
          agents.set(slug, defineAgent(agentDefFromRow(r) as never));
        } catch (e) {
          load_errors.push({ kind: "agent", path, slug, error: e instanceof Error ? e.message : String(e) });
        }
      }

      // standards — phases jsonb is already the engine phase shape; the agents a standard
      // composes are the ones its chairs name. composeStandard is the loader's own gate.
      const standards = new Map<string, Standard>();
      for (const r of standardRows) {
        const slug = typeof r["slug"] === "string" ? r["slug"] : null;
        const path = `postgrest:coltrane_standards/${slug ?? "?"}`;
        try {
          if (!slug) throw new Error(`missing required "slug" field`);
          if (standards.has(slug)) throw new Error(`duplicate standard slug "${slug}"`);
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
            }),
          );
        } catch (e) {
          load_errors.push({ kind: "standard", path, slug, error: e instanceof Error ? e.message : String(e) });
        }
      }

      // skills — the row's skill_md IS the loaded reasoning half (`md`, the prompt's Skills
      // layer). Hosted skills carry no local package dir / code half by construction.
      const skills = new Map<string, SkillRecord>();
      for (const r of skillRows) {
        const slug = typeof r["slug"] === "string" ? r["slug"] : null;
        const path = `postgrest:coltrane_skills/${slug ?? "?"}`;
        try {
          if (!slug) throw new Error(`missing required "slug" field`);
          if (skills.has(slug)) throw new Error(`duplicate skill slug "${slug}"`);
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

  // A2 · TWO ACTIVE ROWS CLAIMING ONE NAME IS AN AMBIGUITY, NOT A RACE. Previously the
  // second arrival threw "duplicate venue slug" and which room the genome held was a
  // function of row order — a fact nobody declared. There is no caller and no org context
  // at this layer (org_id is RLS's concern, stated above), so choosing between them would
  // be a coin toss wearing a determinism costume. It refuses, naming every claimant, on the
  // precedent set for principals: attribution is a fact, not a coin toss.
  const bySlug = new Map<string, Row[]>();
  for (const r of liveVenueRows) {
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

  for (const r of liveVenueRows) {
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

  return { core_types, domain_types, agents, standards, skills, evals, charts, venues, load_errors };
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
      return reconstructGenome({ core_types, domain_types, agents, standards, skills, charts, venues });
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
export function rpcGenomeStore(ctx: { baseUrl: string; anonKey: string; agentToken: string }): GenomeStore {
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
      const rows = JSON.parse(text) as Partial<GenomeRows>;
      return reconstructGenome({
        core_types: rows.core_types ?? [],
        domain_types: rows.domain_types ?? [],
        agents: rows.agents ?? [],
        standards: rows.standards ?? [],
        skills: rows.skills ?? [],
        charts: rows.charts ?? [],
        venues: rows.venues ?? [],
      });
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

/** The agent-token gig-queue seam: queue one run through coltrane_mcp_dispatch, where the
 *  chair contract authorizes (the seat grants the standard; the token may only narrow).
 *  Same return shape as postgrestQueueGig so a host can swap them by bearer class. */
export function rpcQueueGig(
  ctx: { baseUrl: string; anonKey: string; agentToken: string },
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (args) => {
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

/** The hosted gig-queue seam for createToolSurface: queue one run through the governor-gated
 *  dispatch RPC AS THE CALLER (member JWT — RLS + the governor gate decide). Queuing only;
 *  a drain worker claims and runs it. Shape mirrors hosted_tools' member dispatch path. */
export function postgrestQueueGig(
  ctx: PostgrestContext,
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (args) => {
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
