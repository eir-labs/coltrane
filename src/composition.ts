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
  // Skill bindings — slugs the runtime resolves against the genome's skills map
  // and injects as the prompt's Skills layer (layer 3 of 5). Absent/empty = no
  // skills attach; the prompt skips the Skills section entirely.
  skill_slugs?: readonly string[];
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
  // Skill bindings (slugs) the runtime resolves into the prompt's Skills layer.
  // Optional so hand-built Agent literals stay valid; defineAgent always sets ([]).
  skill_slugs?: readonly string[];
}

// A chair is one named seat in a phase. It binds a role-name within the standard
// to an agent (by slug), declares the upstream roles it depends on (depends_on),
// what types it expects to see on input (input_contract), what types it promises
// to produce (output_contract), and any skills the bound agent must declare.
export interface Chair {
  role: string;
  agent_slug: string;
  depends_on: readonly string[];
  input_contract: readonly string[];
  output_contract: readonly string[];
  required_skills: readonly string[];
}

export interface PhaseDef {
  name: string;
  chairs: readonly Chair[];
}

// Legacy single-agent phase shape. Accepted at the composeStandard / loader / MCP
// input boundary and normalized to a single-chair PhaseDef internally. Authored
// standards (JSON files, test literals) that still use {name, agent} keep working
// until the migration codemod lands. The stored Standard.phases always carries
// the new chairs shape — legacy form never reaches the runtime.
//
// PhaseDefInput is intentionally a single shape with BOTH fields optional
// (rather than a tagged union) so TypeScript's excess-property check stays
// quiet on legacy object literals authored as `{ name, agent }`. The runtime
// discriminates on whether `chairs` is present (see normalizePhase).
export interface PhaseDefInput {
  name: string;
  agent?: string;
  chairs?: readonly Chair[];
}

export interface StandardDef {
  slug: string;
  domain: string;
  agents: readonly Agent[];
  phases: readonly PhaseDefInput[];
  // 5th-class evals: judge-shapes evaluated against the gig's produced outputs.
  // Names declared here are looked up in the loaded genome's evals registry at
  // runGig time; their scores land in run_fingerprint.eval_scores.
  eval_slugs?: readonly string[];
}

// Standard.phases is canonical PhaseDef (chairs) post-composeStandard. Hand-rolled
// Standard literals in tests / adversarial scenarios that bypass composeStandard
// may still author the legacy {name, agent} shape; the field type stays wide as
// PhaseDefInput to accept both. Runtime normalizes per phase before iterating.
export interface Standard {
  slug: string;
  domain: string;
  agents: readonly Agent[];
  phases: readonly PhaseDefInput[];
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
    skill_slugs: def.skill_slugs ?? [],
  };
}

// Detect the legacy {name, agent} shape and lift it into a single-chair PhaseDef.
// The synthesized chair uses the phase name as its role, leaves depends_on +
// input_contract empty (the legacy primitive-graph / upstreamOutputs pass below
// handles type-flow for legacy standards), and uses the bound agent's
// output_types as output_contract so downstream chairs can satisfy their
// declared input_contracts off a legacy upstream phase. Required_skills empty.
export function normalizePhase(
  p: PhaseDefInput,
  agentBySlug: ReadonlyMap<string, Agent>,
): PhaseDef {
  if (p.chairs !== undefined) return { name: p.name, chairs: p.chairs };
  const legacyAgent = p.agent ?? "";
  const ag = agentBySlug.get(legacyAgent);
  // Output_contract falls back to ["Interpretation"] when the agent is
  // unresolvable, so the "empty output_contract" rule doesn't fire on a
  // bad-agent-slug phase before the agent-unknown error has a chance to
  // surface. Same idea: agent-unknown wins over output-empty.
  const output_contract = (ag?.output_types && ag.output_types.length > 0)
    ? ag.output_types
    : ["__legacy_synth__"];
  return {
    name: p.name,
    chairs: [
      {
        role: p.name,
        agent_slug: legacyAgent,
        depends_on: [],
        input_contract: [],
        output_contract,
        required_skills: [],
      },
    ],
  };
}

export function composeStandard(def: {
  slug: string;
  domain: string;
  agents: readonly Agent[];
  phases: readonly PhaseDefInput[];
  eval_slugs?: readonly string[];
}): Standard {
  const agentBySlug = new Map(def.agents.map((a) => [a.slug, a]));

  // Normalize every phase to chairs shape up front. Legacy {name, agent} phases
  // become single-chair phases; new {name, chairs} phases pass through unchanged.
  const phases: PhaseDef[] = def.phases.map((p) => normalizePhase(p, agentBySlug));

  // ── Chair-level validation ─────────────────────────────────────────────────
  // (a) every phase has at least one chair
  // (b) role uniqueness — within phase + across phases of this standard
  // (c) every chair's agent_slug resolves to an agent in this standard
  // (d) every chair's required_skills are declared on its bound agent
  // (e) every chair's output_contract is non-empty
  const seenRoles = new Map<string, string>(); // role → phase name
  for (const ph of phases) {
    if (ph.chairs.length === 0) {
      throw new CompositionError(
        `standard ${def.slug}: phase ${ph.name} has empty chairs array (every phase needs ≥1 chair)`,
      );
    }
    const phaseRoles = new Set<string>();
    for (const ch of ph.chairs) {
      if (phaseRoles.has(ch.role)) {
        throw new CompositionError(
          `standard ${def.slug}: duplicate role "${ch.role}" within phase ${ph.name}`,
        );
      }
      phaseRoles.add(ch.role);
      if (seenRoles.has(ch.role)) {
        throw new CompositionError(
          `standard ${def.slug}: duplicate role "${ch.role}" across phases (also in ${seenRoles.get(ch.role)})`,
        );
      }
      seenRoles.set(ch.role, ph.name);

      const ag = agentBySlug.get(ch.agent_slug);
      if (!ag) {
        throw new CompositionError(
          `standard ${def.slug}: chair "${ch.role}" references unknown agent "${ch.agent_slug}" (not in standard's agents list)`,
        );
      }
      const declared = new Set(ag.skill_slugs ?? []);
      for (const sk of ch.required_skills) {
        if (!declared.has(sk)) {
          throw new CompositionError(
            `standard ${def.slug}: chair "${ch.role}" requires skill "${sk}" which agent "${ag.slug}" does not declare`,
          );
        }
      }
      if (ch.output_contract.length === 0) {
        throw new CompositionError(
          `standard ${def.slug}: chair "${ch.role}" has empty output_contract (every chair must declare ≥1 output type)`,
        );
      }
    }
  }

  // ── depends_on validation: walk roles in phase-then-chair order ────────────
  // (f) self-reference is a cycle
  // (g) forward reference (depends_on a role declared in a later phase) is rejected
  // (h) unknown role in depends_on is rejected
  // (i) cycle detection across the full role graph
  const rolePhaseIndex = new Map<string, number>(); // role → phase index
  for (let i = 0; i < phases.length; i++) {
    for (const ch of phases[i]!.chairs) {
      rolePhaseIndex.set(ch.role, i);
    }
  }
  for (let i = 0; i < phases.length; i++) {
    for (const ch of phases[i]!.chairs) {
      for (const dep of ch.depends_on) {
        if (dep === ch.role) {
          throw new CompositionError(
            `standard ${def.slug}: chair "${ch.role}" depends_on itself (self-cycle)`,
          );
        }
        const depPhase = rolePhaseIndex.get(dep);
        if (depPhase === undefined) {
          throw new CompositionError(
            `standard ${def.slug}: chair "${ch.role}" depends_on unknown role "${dep}" (undeclared in this standard)`,
          );
        }
        if (depPhase > i) {
          throw new CompositionError(
            `standard ${def.slug}: chair "${ch.role}" (phase ${phases[i]!.name}) has forward reference to "${dep}" (phase ${phases[depPhase]!.name}); depends_on must point to an earlier or same-phase role`,
          );
        }
      }
    }
  }

  // Cycle detection across the full role graph (DFS with grey/black coloring).
  // Self-cycles are already caught above; this finds longer cycles like A→B→A.
  const adj = new Map<string, readonly string[]>();
  for (const ph of phases) {
    for (const ch of ph.chairs) {
      adj.set(ch.role, ch.depends_on);
    }
  }
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const role of adj.keys()) color.set(role, WHITE);
  function dfs(role: string): void {
    color.set(role, GREY);
    for (const dep of adj.get(role) ?? []) {
      const c = color.get(dep);
      if (c === GREY) {
        throw new CompositionError(
          `standard ${def.slug}: cycle in depends_on graph involving role "${role}" → "${dep}"`,
        );
      }
      if (c === WHITE) dfs(dep);
    }
    color.set(role, BLACK);
  }
  for (const role of adj.keys()) {
    if (color.get(role) === WHITE) dfs(role);
  }

  // ── input_contract satisfaction ───────────────────────────────────────────
  // Each chair's declared input_contract must be covered by the union of its
  // depends_on chairs' output_contracts. (Phase-order alone isn't enough — a
  // chair only sees outputs from the roles it explicitly depends on.) When a
  // chair has no depends_on, an empty input_contract is required.
  const chairByRole = new Map<string, Chair>();
  for (const ph of phases) {
    for (const ch of ph.chairs) chairByRole.set(ch.role, ch);
  }
  for (const ph of phases) {
    for (const ch of ph.chairs) {
      if (ch.input_contract.length === 0) continue;
      const produced = new Set<string>();
      for (const dep of ch.depends_on) {
        const upstream = chairByRole.get(dep);
        if (!upstream) continue; // already reported above
        for (const t of upstream.output_contract) produced.add(t);
      }
      for (const need of ch.input_contract) {
        if (!produced.has(need)) {
          throw new CompositionError(
            `standard ${def.slug}: chair "${ch.role}" input_contract requires "${need}" not produced by any upstream chair (depends_on=[${ch.depends_on.join(",")}])`,
          );
        }
      }
    }
  }

  // ── Legacy primitive-graph + domain checks (operate on normalized phases) ──
  // These predate chairs; they enforce SENSE/CREATE/VERIFY positional rules
  // across the agents bound by each phase's chairs. For multi-chair phases we
  // treat the chair set as the phase's agents (order: declaration order).
  for (const ph of phases) {
    for (const ch of ph.chairs) {
      const ag = agentBySlug.get(ch.agent_slug)!; // existence verified above
      // Rob #134: agents with no explicit domain (null OR undefined) are
      // domain-agnostic — compatible with any standard. Only reject when the
      // agent declares an explicit domain that conflicts with the standard's.
      if (ag.domain != null && ag.domain !== def.domain) {
        throw new CompositionError(
          `standard ${def.slug}: agent ${ag.slug}.domain=${ag.domain} ≠ standard.domain=${def.domain}`,
        );
      }
    }
  }

  const upstreamOutputs = new Set<string>();
  const upstreamPhasePrimitives = new Set<Primitive>();
  for (let i = 0; i < phases.length; i++) {
    const ph = phases[i]!;
    // For the legacy primitive-graph check we consider each chair in turn,
    // treating prior chairs (same phase or earlier) as the upstream bag.
    for (const ch of ph.chairs) {
      const ag = agentBySlug.get(ch.agent_slug)!;
      if (i > 0) {
        for (const it of ag.input_types) {
          if (it && !upstreamOutputs.has(it)) {
            throw new CompositionError(
              `standard ${def.slug}: phase ${ph.name} input ${it} not produced upstream`,
            );
          }
        }
      }
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
    }
    // After processing all chairs in this phase, fold their primitives + outputs
    // into the upstream bag for subsequent phases.
    for (const ch of ph.chairs) {
      const ag = agentBySlug.get(ch.agent_slug)!;
      for (const p of ag.primitives) upstreamPhasePrimitives.add(p);
      for (const ot of ag.output_types) upstreamOutputs.add(ot);
    }
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

  const std: Standard = { slug: def.slug, domain: def.domain, agents: def.agents, phases };
  if (def.eval_slugs && def.eval_slugs.length > 0) {
    std.eval_slugs = def.eval_slugs;
  }
  return std;
}
