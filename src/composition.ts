import type { Primitive } from "./core_types.js";
import { PRIMITIVE_OUTPUT_TYPE } from "./core_types.js";

export interface AgentDef {
  slug: string;
  primitives: readonly Primitive[];
  input_types?: readonly string[];
  output_types?: readonly string[];
  domain?: string;
  // Blast-radius cage: the tool whitelist/blacklist the spawned claude is held to.
  // Empty/absent = no per-agent tool grant (with --strict-mcp-config, the spawn gets
  // NO ambient MCP tools — deny-by-default; declare allowed_tools to grant scope).
  allowed_tools?: readonly string[];
  disallowed_tools?: readonly string[];
}

export interface Agent {
  slug: string;
  primitives: readonly Primitive[];
  input_types: readonly string[];
  output_types: readonly string[];
  domain: string | null;
  // Cage grant — optional so hand-built Agent literals stay valid; defineAgent always
  // sets them ([] = no grant). The invoker treats absent/empty as deny-by-default.
  allowed_tools?: readonly string[];
  disallowed_tools?: readonly string[];
}

export interface PhaseDef {
  name: string;
  agent: string;
}

export interface StandardDef {
  slug: string;
  domain: string;
  agents: readonly Agent[];
  phases: readonly PhaseDef[];
  // 5th-class evals: judge-shapes evaluated against the gig's produced outputs.
  // Names declared here are looked up in the loaded genome's evals registry at
  // runGig time; their scores land in run_fingerprint.eval_scores.
  eval_slugs?: readonly string[];
}

export interface Standard {
  slug: string;
  domain: string;
  agents: readonly Agent[];
  phases: readonly PhaseDef[];
  eval_slugs?: readonly string[];
}

export class CompositionError extends Error {}

const ROOT_PRIMITIVES = new Set<Primitive>(["SENSE"]);
const NEEDS_UPSTREAM_REASONING = new Set<Primitive>(["CREATE"]);
const NEEDS_TARGET = new Set<Primitive>(["VERIFY"]);
const REASONING = new Set<Primitive>(["INTERPRET", "PLAN", "SENSE"]);

export function defineAgent(def: AgentDef): Agent {
  const prims = def.primitives;
  if (prims.length === 0) {
    throw new CompositionError(`agent ${def.slug} has no primitives`);
  }

  // Per-agent sanity: when multiple primitives are bundled in a single agent
  // (e.g. [PLAN, CREATE]), an inner CREATE position needs an inner PLAN or
  // INTERPRET upstream of it. Standalone CREATE/[CREATE] is admitted at this
  // layer; the cross-phase §3 gate enforces "upstream reasoning" across phases
  // in composeStandard. This split lets a CREATE-only agent compose into a
  // standard where the upstream phase supplies the reasoning.
  for (let i = 1; i < prims.length; i++) {
    const p = prims[i]!;
    if (NEEDS_UPSTREAM_REASONING.has(p)) {
      const upstream = prims.slice(0, i);
      const hasReasoning = upstream.some((u) => u === "INTERPRET" || u === "PLAN");
      if (!hasReasoning) {
        throw new CompositionError(
          `agent ${def.slug}: CREATE at position ${i} has no upstream INTERPRET or PLAN`,
        );
      }
    }
    if (NEEDS_TARGET.has(p)) {
      const upstream = prims.slice(0, i);
      if (upstream.length === 0) {
        throw new CompositionError(`agent ${def.slug}: VERIFY has no upstream target`);
      }
    }
  }

  return {
    slug: def.slug,
    primitives: prims,
    input_types: def.input_types ?? [],
    output_types:
      def.output_types ?? prims.map((p) => PRIMITIVE_OUTPUT_TYPE[p]).slice(-1),
    domain: def.domain ?? null,
    allowed_tools: def.allowed_tools ?? [],
    disallowed_tools: def.disallowed_tools ?? [],
  };
}

export function composeStandard(def: {
  slug: string;
  domain: string;
  agents: readonly Agent[];
  phases: readonly PhaseDef[];
  eval_slugs?: readonly string[];
}): Standard {
  const agentBySlug = new Map(def.agents.map((a) => [a.slug, a]));

  for (const ph of def.phases) {
    if (!agentBySlug.has(ph.agent)) {
      throw new CompositionError(
        `standard ${def.slug}: phase ${ph.name} references undefined agent ${ph.agent}`,
      );
    }
    const ag = agentBySlug.get(ph.agent)!;
    if (ag.domain !== null && ag.domain !== def.domain) {
      throw new CompositionError(
        `standard ${def.slug}: agent ${ag.slug}.domain=${ag.domain} ≠ standard.domain=${def.domain}`,
      );
    }
  }

  const upstreamOutputs = new Set<string>();
  // §3 cross-phase check: when a phase's agent uses CREATE, some upstream
  // phase (or the agent's own earlier primitives) must supply INTERPRET or
  // PLAN. VERIFY needs SOME upstream phase target. Tracks the bag of
  // primitives seen in earlier phases.
  const upstreamPhasePrimitives = new Set<Primitive>();
  for (let i = 0; i < def.phases.length; i++) {
    const ph = def.phases[i]!;
    const ag = agentBySlug.get(ph.agent)!;
    if (i > 0) {
      for (const it of ag.input_types) {
        if (it && !upstreamOutputs.has(it)) {
          throw new CompositionError(
            `standard ${def.slug}: phase ${ph.name} input ${it} not produced upstream`,
          );
        }
      }
    }
    // Cross-phase §3 enforcement on the FIRST primitive of this phase's agent.
    // If the agent bundles its own [PLAN, CREATE], the per-agent check above
    // already passed. Here we cover the case where the agent's first primitive
    // is CREATE — the previous phases must supply INTERPRET or PLAN.
    const firstPrim = ag.primitives[0];
    if (firstPrim && NEEDS_UPSTREAM_REASONING.has(firstPrim)) {
      const agentSelfHasReasoning = ag.primitives.slice(1).some((u) => u === "INTERPRET" || u === "PLAN");
      const phaseUpstreamHasReasoning = upstreamPhasePrimitives.has("INTERPRET") || upstreamPhasePrimitives.has("PLAN");
      if (!agentSelfHasReasoning && !phaseUpstreamHasReasoning) {
        throw new CompositionError(
          `standard ${def.slug}: phase ${ph.name} (${ag.slug}) starts with CREATE but no upstream phase supplies INTERPRET or PLAN`,
        );
      }
    }
    if (firstPrim && NEEDS_TARGET.has(firstPrim)) {
      if (upstreamPhasePrimitives.size === 0 && ag.primitives.length === 1) {
        throw new CompositionError(
          `standard ${def.slug}: phase ${ph.name} (${ag.slug}) starts with VERIFY but no upstream phase target`,
        );
      }
    }
    for (const p of ag.primitives) upstreamPhasePrimitives.add(p);
    for (const ot of ag.output_types) upstreamOutputs.add(ot);
  }

  const produces = new Map<string, string>();
  for (const ag of def.agents) {
    for (const ot of ag.output_types) {
      if (produces.has(ot)) continue;
      produces.set(ot, ag.slug);
    }
  }
  for (const ag of def.agents) {
    for (const it of ag.input_types) {
      if (produces.has(it)) {
        const producer = produces.get(it)!;
        const producerAgent = agentBySlug.get(producer);
        if (producerAgent) {
          for (const pIn of producerAgent.input_types) {
            for (const myOut of ag.output_types) {
              if (pIn === myOut) {
                throw new CompositionError(
                  `standard ${def.slug}: cycle detected between ${ag.slug} and ${producer}`,
                );
              }
            }
          }
        }
      }
    }
  }

  const std: Standard = { slug: def.slug, domain: def.domain, agents: def.agents, phases: def.phases };
  if (def.eval_slugs && def.eval_slugs.length > 0) {
    std.eval_slugs = def.eval_slugs;
  }
  return std;
}
