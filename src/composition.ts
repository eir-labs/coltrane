import type { Primitive } from "./core_types.js";
import { PRIMITIVE_OUTPUT_TYPE } from "./core_types.js";

export interface AgentDef {
  slug: string;
  primitives: readonly Primitive[];
  input_types?: readonly string[];
  output_types?: readonly string[];
  domain?: string;
  // Blast-radius cage: the tool whitelist/blacklist the spawned claude is held to.
  // - allowed_tools: empty/absent = no per-agent tool grant (with --strict-mcp-config,
  //   the spawn gets NO ambient MCP tools — deny-by-default; declare allowed_tools to
  //   grant scope). Any tool listed here is REMOVED from the deny baseline below.
  // - disallowed_tools: ADDITIVE on top of the DEFAULT_DENY_TOOLS baseline (Bash,
  //   Read/Write/Edit, Task, WebFetch/Search, etc.). defineAgent always merges the
  //   baseline in, so an agent that declares nothing still gets the sword raised.
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
}

export interface Standard {
  slug: string;
  domain: string;
  agents: readonly Agent[];
  phases: readonly PhaseDef[];
}

export class CompositionError extends Error {}

const ROOT_PRIMITIVES = new Set<Primitive>(["SENSE"]);
const NEEDS_UPSTREAM_REASONING = new Set<Primitive>(["CREATE"]);
const NEEDS_TARGET = new Set<Primitive>(["VERIFY"]);
const REASONING = new Set<Primitive>(["INTERPRET", "PLAN", "SENSE"]);

// The default-deny lower bound: tools every agent's spawn is BLOCKED from using
// unless the agent explicitly grants them in allowed_tools. Wielded like a sword —
// host-shell escapes, host-fs escapes, recursion escape, and ambient egress.
// This is the floor. Per-agent disallowed_tools EXTENDS (additive) this baseline.
// Per-agent allowed_tools WINS — any tool in allowed_tools is removed from the
// effective deny list (you can grant Bash explicitly if a standard truly needs it).
export const DEFAULT_DENY_TOOLS: readonly string[] = Object.freeze([
  // host-shell escapes
  "Bash",
  "Shell",
  "KillBash",
  "BashOutput",
  // host-fs escapes
  "Read",
  "Write",
  "Edit",
  // recursion escape
  "Task",
  // ambient egress
  "WebFetch",
  "WebSearch",
]);

// Compute the effective disallowed_tools for an agent:
//   baseline = DEFAULT_DENY_TOOLS
//   explicit = agent's declared disallowed_tools (additive on top of baseline)
//   allowed  = agent's declared allowed_tools (subtracted — explicit grant wins)
// Returns a stable, de-duplicated, allow-filtered list.
export function effectiveDisallowedTools(
  declared_disallowed: readonly string[] | undefined,
  declared_allowed: readonly string[] | undefined,
): string[] {
  const allowSet = new Set(declared_allowed ?? []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...DEFAULT_DENY_TOOLS, ...(declared_disallowed ?? [])]) {
    if (allowSet.has(t)) continue; // explicit allow_tools beats the deny baseline
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function defineAgent(def: AgentDef): Agent {
  const prims = def.primitives;
  if (prims.length === 0) {
    throw new CompositionError(`agent ${def.slug} has no primitives`);
  }

  for (let i = 0; i < prims.length; i++) {
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

  // Default-deny lower bound: every agent's effective disallowed_tools is the
  // DEFAULT_DENY_TOOLS baseline EXTENDED by any explicit declarations, with any
  // tool the agent ALSO declared in allowed_tools removed (explicit grant wins).
  // This means an agent that declares nothing still gets Bash/Read/Write/Task/
  // WebFetch/etc. blocked at spawn — the sword is always raised.
  const effective_disallowed = effectiveDisallowedTools(def.disallowed_tools, def.allowed_tools);

  return {
    slug: def.slug,
    primitives: prims,
    input_types: def.input_types ?? [],
    output_types:
      def.output_types ?? prims.map((p) => PRIMITIVE_OUTPUT_TYPE[p]).slice(-1),
    domain: def.domain ?? null,
    allowed_tools: def.allowed_tools ?? [],
    disallowed_tools: effective_disallowed,
  };
}

export function composeStandard(def: {
  slug: string;
  domain: string;
  agents: readonly Agent[];
  phases: readonly PhaseDef[];
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

  return { slug: def.slug, domain: def.domain, agents: def.agents, phases: def.phases };
}
