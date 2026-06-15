import type { Primitive } from "./core_types.js";
import { PRIMITIVE_OUTPUT_TYPE } from "./core_types.js";
import type { ModelTier, Depth } from "./pricing.js";

// The per-agent code-tool exposure gate (old AgentPermissions.code_tool_access). Scales
// the agent's access to Claude Code's built-in file/exec tools, independent of MCP grant.
export type CodeToolAccess = "none" | "read" | "write" | "full";

// The Belbin cognitive-role pairing (exactly 2, held "in tension") — the agent's
// DISPOSITION. This is a DIFFERENT axis from `primitives` (the process step that resolves
// output type). The old runtime rendered this as Layer 1; the new engine dropped it.
export type BelbinRole =
  | "explorer" | "analyst" | "critic" | "synthesizer" | "planner" | "executor" | "audience_modeler";

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
  // Behavioral representation — REQUIRED. An agent without identity/method/constraints/
  // disposition is the bug this whole change closes; there is no valid agent without them.
  identity: string;
  method: string;
  constraints: readonly string[];
  // EXACTLY two Belbin roles, held in equal tension — the Disposition layer. The pairing is
  // the contract: a lone role collapses to a single voice, three+ dilute the tension that
  // makes the disposition load-bearing. Typed as a 2-tuple (compile-time) AND validated for
  // cardinality at defineAgent (runtime, for the JSON-authored path that parses as `any`).
  behavioral_primitives: readonly [BelbinRole, BelbinRole];
  // Cage / economy envelope — optional, with a REAL deny-by-default / gig-fallback reason
  // (not back-compat): absent code_tool_access = deny code tools; absent model_tier = the
  // gig/invoker default model; absent max_tool_calls/max_token_budget = the gig budget
  // governs; absent depth_profile = the gig depth applies.
  model_tier?: ModelTier;
  max_tool_calls?: number;
  max_token_budget?: number;
  code_tool_access?: CodeToolAccess;
  depth_profile?: Depth;
}

export interface Agent {
  slug: string;
  primitives: readonly Primitive[];
  input_types: readonly string[];
  output_types: readonly string[];
  domain: string | null;
  // Behavioral representation — the agent's own prose, NOT capability (capability lives
  // in skills). buildPrompt renders these into the Disposition / Identity / Method /
  // Constraints layers. REQUIRED: an agent without them renders a contentless prompt and
  // the model confabulates — that is the bug this closes, so the type forbids it.
  identity: string;             // who you are — role / stance (Identity layer)
  method: string;               // how you do THIS agent's job — the step-by-step (Method layer)
  constraints: readonly string[]; // the negative space — never-invent / cite-sources (Constraints layer)
  behavioral_primitives: readonly [BelbinRole, BelbinRole]; // exactly two Belbin roles in equal tension → Disposition layer
  // Cage grant — optional so hand-built Agent literals stay valid; defineAgent always
  // sets them ([] = no grant). The invoker treats absent/empty as deny-by-default.
  allowed_tools?: readonly string[];
  disallowed_tools?: readonly string[];
  // Skill bindings (slugs) the runtime resolves into the prompt's Skills layer.
  // Optional so hand-built Agent literals stay valid; defineAgent always sets ([]).
  skill_slugs?: readonly string[];
  // Merged-type fields (the locked decision: one rich agent type absorbing the orphaned
  // AgentProfile + the Player lane). Tuning + the cage's economy/blast-radius envelope —
  // declared here so the runtime can read them; currently unwired (RED).
  model_tier?: ModelTier;          // → resolves to a concrete --model per gig (economy/standard/premium)
  max_tool_calls?: number;         // per-agent cap → --max-turns; a runaway agent can't burn the gig
  max_token_budget?: number;       // per-agent spend ceiling
  code_tool_access?: CodeToolAccess; // gates Claude Code built-in Read/Write/Edit/Bash
  depth_profile?: Depth;           // per-agent depth/tuning (skim/quick/standard/deep)
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
  // Skills-as-first-class (docs/skills-as-first-class.md): a chair MAY be backed by a
  // skill package instead of an agent. Mutually exclusive with a non-empty agent_slug —
  // a skill-backed chair runs the skill's deterministic code half (no model invocation),
  // which is how the "an LLM should not babysit a deterministic command" path is fixed.
  // Declared here; compose-time validation + runtime routing land in Phase 1.
  skill_slug?: string;
}

export interface PhaseDef {
  name: string;
  chairs: readonly Chair[];
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
  // The gig contract (#177): types that enter the standard from OUTSIDE — gig input or
  // produced by another standard in a cross-standard DAG. The agent-level primitive-graph
  // gates treat these as "available upstream": a faithful agent that consumes a type produced
  // elsewhere composes, and a standalone-CREATE agent whose reasoner arrives this way is
  // admitted. The chair contracts (input_contract/depends_on) remain the authoritative
  // per-role dataflow; this only stops the coarse agent-level gate from rejecting real inputs.
  input_types?: readonly string[];
}

// Standard.phases is canonical PhaseDef (chairs). Legacy {name, agent} form is
// rejected at the composeStandard / loader / MCP boundary; it never reaches the
// runtime.
export interface Standard {
  slug: string;
  domain: string;
  agents: readonly Agent[];
  phases: readonly PhaseDef[];
  eval_slugs?: readonly string[];
  // the gig contract (#177) — types entering from outside the standard. Optional on the type so
  // hand-built Standard literals stay valid; composeStandard always populates it ([] when absent).
  input_types?: readonly string[];
}

export class CompositionError extends Error {}

// A definition that is structurally parseable but INCOMPLETE against the current schema —
// e.g. an agent missing its now-required behavioral representation. Distinct from
// CompositionError (a malformed/illegal definition): an incomplete genome must be UPGRADED
// (fill in the missing features), so the loader HARD-fails on this rather than soft-skipping
// the file. Underdeveloped is not the same as broken.
export class GenomeIncompleteError extends Error {}

const ROOT_PRIMITIVES = new Set<Primitive>(["SENSE"]);
const NEEDS_UPSTREAM_REASONING = new Set<Primitive>(["CREATE"]);
const NEEDS_TARGET = new Set<Primitive>(["VERIFY"]);
const REASONING = new Set<Primitive>(["INTERPRET", "PLAN", "SENSE"]);

export function defineAgent(def: AgentDef): Agent {
  const prims = def.primitives;
  // A string passes `.length === 0`, so a wrong-type `primitives` (e.g. "SENSE")
  // would otherwise load a broken agent silently. Reject non-arrays by field name.
  if (!Array.isArray(prims)) {
    throw new CompositionError(
      `agent ${def.slug}: "primitives" must be an array, got ${typeof prims}`,
    );
  }
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

  // Behavioral representation is mandatory — checked AFTER the structural (primitive)
  // validation so a malformed agent reports its structural defect first. Missing behavioral
  // representation is INCOMPLETE (a schema-migration gap, distinct from malformed): like any
  // invalid agent it HARD-fails the load — a genome must load cleanly to run, never hollow.
  if (typeof def.identity !== "string" || def.identity.trim() === "") {
    throw new GenomeIncompleteError(`agent ${def.slug}: identity is required (who the agent is) — fill it in to upgrade the genome`);
  }
  if (typeof def.method !== "string" || def.method.trim() === "") {
    throw new GenomeIncompleteError(`agent ${def.slug}: method is required (how the agent works) — fill it in to upgrade the genome`);
  }
  // Widen past the compile-time 2-tuple: the JSON-authored path reaches here as `any`, so the
  // disposition's arity is only really known at runtime — these guards protect that path.
  const bp = def.behavioral_primitives as readonly BelbinRole[];
  if (!Array.isArray(bp) || bp.length === 0) {
    throw new GenomeIncompleteError(`agent ${def.slug}: behavioral_primitives (disposition) is required — fill it in to upgrade the genome`);
  }
  // The disposition is a PAIRING: exactly two roles in tension. One role is a single voice;
  // three+ dilute the tension. A genome carrying a non-pair is malformed against the contract,
  // so it hard-fails the load rather than rendering a confused Disposition layer.
  if (bp.length !== 2) {
    throw new GenomeIncompleteError(
      `agent ${def.slug}: behavioral_primitives must be exactly two roles in tension, got ${bp.length} — a disposition is a pairing`,
    );
  }
  if (!Array.isArray(def.constraints)) {
    throw new GenomeIncompleteError(`agent ${def.slug}: constraints is required (use [] for none) — fill it in to upgrade the genome`);
  }

  // Conditional spread for the optional rich fields — assigning an explicit `undefined`
  // would violate exactOptionalPropertyTypes, so only include a field when it's present.
  return {
    slug: def.slug,
    primitives: prims,
    input_types: def.input_types ?? [],
    output_types:
      def.output_types ?? prims.map((p) => PRIMITIVE_OUTPUT_TYPE[p as Primitive]).slice(-1),
    domain: def.domain ?? null,
    allowed_tools: def.allowed_tools ?? [],
    disallowed_tools: def.disallowed_tools ?? [],
    skill_slugs: def.skill_slugs ?? [],
    identity: def.identity,
    method: def.method,
    constraints: def.constraints,
    behavioral_primitives: def.behavioral_primitives,
    ...(def.model_tier !== undefined ? { model_tier: def.model_tier } : {}),
    ...(def.max_tool_calls !== undefined ? { max_tool_calls: def.max_tool_calls } : {}),
    ...(def.max_token_budget !== undefined ? { max_token_budget: def.max_token_budget } : {}),
    ...(def.code_tool_access !== undefined ? { code_tool_access: def.code_tool_access } : {}),
    ...(def.depth_profile !== undefined ? { depth_profile: def.depth_profile } : {}),
  };
}

export function composeStandard(def: {
  slug: string;
  domain: string;
  agents: readonly Agent[];
  phases: readonly PhaseDef[];
  eval_slugs?: readonly string[];
  input_types?: readonly string[]; // the gig contract (#177) — types entering from outside the standard
}): Standard {
  const agentBySlug = new Map(def.agents.map((a) => [a.slug, a]));

  // Reject legacy {name, agent} phase shape at the boundary. Chairs is the only
  // supported shape; the legacy field never reaches the runtime.
  for (const p of def.phases) {
    const legacy = p as unknown as { name: string; agent?: unknown; chairs?: unknown };
    if (legacy.agent !== undefined) {
      throw new CompositionError(
        `standard ${def.slug}: phase ${legacy.name} uses legacy phase.agent — not supported; declare chairs[] instead`,
      );
    }
    if (legacy.chairs === undefined) {
      throw new CompositionError(
        `standard ${def.slug}: phase ${legacy.name} missing chairs[] (chairs required on every phase)`,
      );
    }
  }
  const phases: PhaseDef[] = def.phases.map((p) => ({ name: p.name, chairs: p.chairs }));

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

      // A skill-backed chair (skill_slug set, no agent_slug) runs the skill's deterministic
      // code half instead of an agent — skip the agent/required-skills checks for it. The
      // type-flow (input/output_contract) below still applies.
      const isSkillChair = !!ch.skill_slug && (ch.agent_slug ?? "") === "";
      if (!isSkillChair) {
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
      if (ch.skill_slug && !ch.agent_slug) continue; // skill-backed chair: no agent to domain-check
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

  // The gig contract (#177): types entering from outside the standard count as available
  // upstream for the agent-level gates — a faithful agent consuming a cross-standard/gig input
  // is not "input from nowhere", and such an input can be a standalone-CREATE's reasoner.
  const standardInputs = new Set<string>(def.input_types ?? []);
  const upstreamOutputs = new Set<string>(standardInputs);
  const upstreamPhasePrimitives = new Set<Primitive>();
  for (let i = 0; i < phases.length; i++) {
    const ph = phases[i]!;
    // For the legacy primitive-graph check we consider each chair in turn,
    // treating prior chairs (same phase or earlier) as the upstream bag.
    for (const ch of ph.chairs) {
      if (ch.skill_slug && !ch.agent_slug) continue; // skill-backed chair: not in the primitive graph
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
        // #177: a standalone CREATE whose input arrives as a gig/cross-standard input has its
        // reasoner supplied from outside the standard — the in-standard upstream isn't the only
        // valid source of reasoning.
        const gigSuppliesReasoning = ag.input_types.some((it) => standardInputs.has(it));
        if (!agentSelfHasReasoning && !phaseUpstreamHasReasoning && !gigSuppliesReasoning) {
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
      if (ch.skill_slug && !ch.agent_slug) {
        // a skill-backed chair produces its declared output_contract types — fold those into
        // the upstream bag so a downstream agent chair can consume them.
        for (const ot of ch.output_contract) upstreamOutputs.add(ot);
        continue;
      }
      const ag = agentBySlug.get(ch.agent_slug)!;
      for (const p of ag.primitives) upstreamPhasePrimitives.add(p);
      for (const ot of ag.output_types) upstreamOutputs.add(ot);
    }
  }

  // #181 — the legacy agent-to-agent producer/consumer cycle check below reasons over
  // agent-GLOBAL input_types/output_types. That collapses a multi-chair agent (one chair
  // producing T, a later one consuming T via depends_on) into a single node and false-flags it as
  // a self-cycle. The authoritative dataflow is the chair depends_on graph — already validated
  // acyclic above (`dfs`). So defer to it: a type T that is produced AND consumed in-standard is a
  // legal PIPELINE (not a cycle) when every chair consuming T transitively depends on a chair
  // producing T. Only when that ordering is absent (the legacy no-depends_on shape, or a genuine
  // loop the role DAG didn't already reject) does the coarser agent-global check still apply.
  const transitiveDeps = new Map<string, Set<string>>();
  function depsOf(role: string): Set<string> {
    const cached = transitiveDeps.get(role);
    if (cached) return cached;
    const acc = new Set<string>();
    transitiveDeps.set(role, acc); // set before recursion; the graph is already proven acyclic
    for (const d of adj.get(role) ?? []) {
      acc.add(d);
      for (const x of depsOf(d)) acc.add(x);
    }
    return acc;
  }
  const producerRoles = new Map<string, string[]>();
  const consumerRoles = new Map<string, string[]>();
  for (const ph of phases) {
    for (const ch of ph.chairs) {
      for (const t of ch.output_contract) producerRoles.set(t, [...(producerRoles.get(t) ?? []), ch.role]);
      for (const t of ch.input_contract) consumerRoles.set(t, [...(consumerRoles.get(t) ?? []), ch.role]);
    }
  }
  // T is a clean in-standard pipeline iff a chair produces it AND every chair consuming it
  // transitively depends_on a chair that produces it (producer precedes consumer, role-scoped).
  const pipelineOrdered = (t: string): boolean => {
    const producers = producerRoles.get(t) ?? [];
    if (producers.length === 0) return false;
    const consumers = consumerRoles.get(t) ?? [];
    return consumers.every((c) => producers.some((p) => depsOf(c).has(p)));
  };

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
        // #183: the TRIGGER must be chair-scoped too, not just the #181 exoneration. `produces`
        // and the loop above read agent-GLOBAL output_types/input_types — a capability envelope.
        // A type the agent can globally read+write but which no chair in THIS standard realizes is
        // not this standard's dataflow and cannot form a cycle here. Only a type a chair both
        // produces AND consumes in-standard is a candidate; everything else is "not my problem".
        const chairProduces = (producerRoles.get(it)?.length ?? 0) > 0;
        const chairConsumes = (consumerRoles.get(it)?.length ?? 0) > 0;
        if (!chairProduces || !chairConsumes) continue;
        // #181: the chair graph orders this type's producer before its consumer → legal pipeline.
        if (pipelineOrdered(it)) continue;
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

  const std: Standard = { slug: def.slug, domain: def.domain, agents: def.agents, phases, input_types: [...standardInputs] };
  if (def.eval_slugs && def.eval_slugs.length > 0) {
    std.eval_slugs = def.eval_slugs;
  }
  return std;
}
