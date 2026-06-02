import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { defineAgent, composeStandard, CompositionError, type Agent, type Standard, type PhaseDef } from "./composition.js";
import type { Primitive } from "./core_types.js";

export interface CoreTypeRecord {
  slug: string;
  primitive: string;
  description: string;
  schema: object;
}

export interface DomainTypeRecord {
  slug: string;
  version: number;
  extends: string;
  domain: string;
  status: "active" | "deprecated" | "retired";
  schema: object;
  required_fields: readonly string[];
}

// On-disk shapes for the remaining three definition classes. Agents are AgentDef-shaped
// (validated through defineAgent). A standard file references its agents by slug (DRY —
// agents are authored once under agents/) and is composed through composeStandard.
export interface AgentFileDef {
  slug: string;
  primitives: readonly Primitive[];
  input_types?: readonly string[];
  output_types?: readonly string[];
  domain?: string;
  allowed_tools?: readonly string[];   // blast-radius cage — declared in the genome file
  disallowed_tools?: readonly string[];
}
export interface StandardFileDef {
  slug: string;
  domain: string;
  agent_slugs: readonly string[];
  phases: readonly PhaseDef[];
}
// Skills and evals have no composer yet — load them as slug-keyed records (structurally
// validated: slug present + unique). Their richer contracts are a later layer.
export interface SkillRecord { slug: string; [k: string]: unknown }
export interface EvalRecord { slug: string; [k: string]: unknown }

export interface LoadedGenome {
  core_types: ReadonlyMap<string, CoreTypeRecord>;
  domain_types: ReadonlyMap<string, DomainTypeRecord>;
  agents: ReadonlyMap<string, Agent>;
  standards: ReadonlyMap<string, Standard>;
  skills: ReadonlyMap<string, SkillRecord>;
  evals: ReadonlyMap<string, EvalRecord>;
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const name of readdirSync(dir)) {
    if (extname(name) !== ".json") continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    out.push(JSON.parse(readFileSync(path, "utf-8")) as T);
  }
  return out;
}

const REQUIRED_CORE_SLUGS = new Set([
  "Signal",
  "Interpretation",
  "Judgment",
  "Plan",
  "Artifact",
  "Verdict",
]);

export class GenomeLoadError extends Error {}

export function loadGenome(root: string): LoadedGenome {
  const coreList = readJsonDir<CoreTypeRecord>(join(root, "core_types"));
  const domainList = readJsonDir<DomainTypeRecord>(join(root, "domain_types"));

  const core_types = new Map<string, CoreTypeRecord>();
  for (const c of coreList) {
    if (core_types.has(c.slug)) {
      throw new GenomeLoadError(`duplicate core type slug: ${c.slug}`);
    }
    core_types.set(c.slug, c);
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

  const domain_types = new Map<string, DomainTypeRecord>();
  for (const d of domainList) {
    const key = `${d.slug}@${d.version}`;
    if (domain_types.has(key)) {
      throw new GenomeLoadError(`duplicate domain type: ${key}`);
    }
    if (!core_types.has(d.extends)) {
      throw new GenomeLoadError(
        `domain type ${d.slug} extends "${d.extends}" which is not a core type`,
      );
    }
    domain_types.set(key, d);
  }

  // agents/ — each file is an AgentDef; validated through defineAgent (same path as code).
  const agents = new Map<string, Agent>();
  for (const def of readJsonDir<AgentFileDef>(join(root, "agents"))) {
    if (agents.has(def.slug)) {
      throw new GenomeLoadError(`duplicate agent slug: ${def.slug}`);
    }
    try {
      agents.set(def.slug, defineAgent(def));
    } catch (e) {
      if (e instanceof CompositionError) throw new GenomeLoadError(`agent ${def.slug}: ${e.message}`);
      throw e;
    }
  }

  // standards/ — resolve agent_slugs against loaded agents, then composeStandard.
  const standards = new Map<string, Standard>();
  for (const def of readJsonDir<StandardFileDef>(join(root, "standards"))) {
    if (standards.has(def.slug)) {
      throw new GenomeLoadError(`duplicate standard slug: ${def.slug}`);
    }
    const resolved: Agent[] = [];
    for (const slug of def.agent_slugs ?? []) {
      const a = agents.get(slug);
      if (!a) {
        throw new GenomeLoadError(`standard ${def.slug} references unknown agent "${slug}"`);
      }
      resolved.push(a);
    }
    try {
      standards.set(def.slug, composeStandard({ slug: def.slug, domain: def.domain, agents: resolved, phases: def.phases }));
    } catch (e) {
      if (e instanceof CompositionError) throw new GenomeLoadError(`standard ${def.slug}: ${e.message}`);
      throw e;
    }
  }

  // skills/ + evals/ — slug-keyed records (no composer yet; slug present + unique).
  const skills = new Map<string, SkillRecord>();
  for (const s of readJsonDir<SkillRecord>(join(root, "skills"))) {
    if (!s.slug) throw new GenomeLoadError(`skill file missing slug`);
    if (skills.has(s.slug)) throw new GenomeLoadError(`duplicate skill slug: ${s.slug}`);
    skills.set(s.slug, s);
  }
  const evals = new Map<string, EvalRecord>();
  for (const e of readJsonDir<EvalRecord>(join(root, "evals"))) {
    if (!e.slug) throw new GenomeLoadError(`eval file missing slug`);
    if (evals.has(e.slug)) throw new GenomeLoadError(`duplicate eval slug: ${e.slug}`);
    evals.set(e.slug, e);
  }

  return { core_types, domain_types, agents, standards, skills, evals };
}
