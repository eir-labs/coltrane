import type { Primitive } from "./core_types.js";
import { PRIMITIVE_OUTPUT_TYPE } from "./core_types.js";
import type { ModelTier, Depth } from "./pricing.js";
import { AgentSchema, type AgentInput, type AgentOutput, type StandardInput, type StandardOutput } from "./genome_schema.js";

// The per-agent code-tool exposure gate (old AgentPermissions.code_tool_access). Scales
// the agent's access to Claude Code's built-in file/exec tools, independent of MCP grant.
export type CodeToolAccess = "none" | "read" | "write" | "full";

// The Belbin cognitive-role pairing (exactly 2, held "in tension") — the agent's
// DISPOSITION. This is a DIFFERENT axis from `primitives` (the process step that resolves
// output type). The old runtime rendered this as Layer 1; the new engine dropped it.
export type BelbinRole =
  | "explorer" | "analyst" | "critic" | "synthesizer" | "planner" | "executor" | "audience_modeler";

// AgentDef + Agent are now DERIVED from the single source (genome_schema.ts `AgentSchema`):
// AgentDef = z.input (what you author — optionals allowed), Agent = z.output (after parse). The
// hand-written interfaces that drifted from the schema/MCP-surface/constructor are gone — add a
// field once in AgentSchema and the type, the validator (defineAgent), and the MCP input_schema all
// follow. ModelTier/Depth/Primitive/BelbinRole are imported above only for other uses in this file.
export type AgentDef = AgentInput;

export type Agent = AgentOutput;

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
  /**
   * #243 — which promised outputs MAY legitimately be absent.
   *
   * The output_contract is a floor: a chair that seals fewer types than it promised fails
   * the run. Conditional outputs are real — patent-triage's judge emits a provisional draft
   * only when the verdict is FILEABLE — so they need a way to say so, and this is it.
   *
   * DENY-BY-DEFAULT: absent from this list means required. Opt-in enforcement would leave
   * every existing silent under-producer silent, which is the bug. Opt-out makes the
   * conditional case state itself in the genome, where a reader and an auditor can both see
   * it — an undeclared conditional output is indistinguishable from a chair that failed.
   *
   * Must be a subset of output_contract; enforced at compose time.
   */
  optional_outputs?: readonly string[];
  required_skills: readonly string[];
  // Skills-as-first-class (docs/skills-as-first-class.md): a chair MAY be backed by a
  // skill package instead of an agent. Mutually exclusive with a non-empty agent_slug —
  // a skill-backed chair runs the skill's deterministic code half (no model invocation),
  // which is how the "an LLM should not babysit a deterministic command" path is fixed.
  // Declared here; compose-time validation + runtime routing land in Phase 1.
  skill_slug?: string;
  /** The human seat: an approval office held by a person. No agent, no skill; the runtime
   *  PARKS at this chair until the incumbent's verdict is supplied, then seals it. */
  human?: boolean;
}

export interface PhaseDef {
  name: string;
  chairs: readonly Chair[];
}

// StandardDef (compose input) + Standard (runtime output) DERIVE from the single source
// (genome_schema.ts `StandardSchema`) — add a passthrough field there (eval_slugs, input_types,
// output_types, max_examine_rounds, description, the #177 gig contract …) and it appears on both
// types automatically, so composeStandard can't silently drop it again. Only the two authoring-time
// agent fields are overridden: the schema's `agents` (unknown[] — slugs/objects) and `agent_slugs`
// (the file shape) are replaced by the RESOLVED `Agent[]` the composer produces, and `phases` is the
// runtime PhaseDef (chairs with a required agent_slug). That file→resolved transform is the only
// reason these stay derived types here rather than `z.output<StandardSchema>` directly.
export type StandardDef = Omit<StandardInput, "agents" | "agent_slugs" | "phases"> & {
  agents: readonly Agent[];
  phases: readonly PhaseDef[];
};

// Standard.phases is canonical PhaseDef (chairs). Legacy {name, agent} form is
// rejected at the composeStandard / loader / MCP boundary; it never reaches the
// runtime.
export type Standard = Omit<StandardOutput, "agents" | "agent_slugs" | "phases"> & {
  agents: readonly Agent[];
  phases: readonly PhaseDef[];
};

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

  // LOSS-FREE projection via the single-source schema (genome_schema.ts AgentSchema): parse
  // PRESERVES every field the schema declares (browser_grant, the cage grants, …) and applies
  // defaults — no hand-enumerated literal to silently drop a sealed field (the bug this whole change
  // closes). The structural + behavioral checks above already threw the precise error types; if the
  // schema rejects a shape those missed, surface it as a load-hard GenomeIncompleteError.
  let parsed: Agent;
  try {
    parsed = AgentSchema.parse(def);
  } catch (e) {
    throw new GenomeIncompleteError(`agent ${def.slug}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // output_types derives from the last primitive's output type when not declared (stays here, not
  // in the schema, because the default depends on another field). The cage arrays fill to [] to
  // match the prior runtime shape (deny-by-default = an empty grant, never undefined).
  const output_types = parsed.output_types.length > 0
    ? parsed.output_types
    : prims.map((p) => PRIMITIVE_OUTPUT_TYPE[p as Primitive]).slice(-1);
  return {
    ...parsed,
    output_types,
    allowed_tools: parsed.allowed_tools ?? [],
    disallowed_tools: parsed.disallowed_tools ?? [],
    skill_slugs: parsed.skill_slugs ?? [],
  };
}

export function composeStandard(def: {
  slug: string;
  domain: string;
  /** #203 — lifecycle, carried through so a composed standard cannot launder a deprecation. */
  status?: "active" | "deprecated" | "retired";
  agents: readonly Agent[];
  phases: readonly PhaseDef[];
  eval_slugs?: readonly string[];
  input_types?: readonly string[]; // the gig contract (#177) — types entering from outside the standard
  output_types?: readonly string[];
  max_examine_rounds?: number;
  description?: string;
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
  // #187 — optional chair array fields default to [] (the loader already tolerates omitted
  // fields; composeStandard must not be stricter than the loader it feeds). A chair that omits
  // required_skills / depends_on / input_contract / output_contract is treated as empty, not a
  // raw "ch.<field> is not iterable" TypeError.
  const phases: PhaseDef[] = def.phases.map((p) => ({
    name: p.name,
    chairs: (p.chairs as readonly Partial<Chair>[]).map((ch) => ({
      ...ch,
      role: ch.role ?? "",
      agent_slug: ch.agent_slug ?? "",
      depends_on: ch.depends_on ?? [],
      input_contract: ch.input_contract ?? [],
      output_contract: ch.output_contract ?? [],
      required_skills: ch.required_skills ?? [],
    })) as Chair[],
  }));

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
      // A HUMAN chair is an approval office: no agent, no skill — the incumbent is a person
      // and their sealed verdict is the chair's output. Agent/skill checks don't apply; the
      // type-flow below still does, and like a skill chair it seals exactly one output.
      const isHumanChair = ch.human === true && (ch.agent_slug ?? "") === "" && !ch.skill_slug;
      if (!isSkillChair && !isHumanChair) {
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
      // #243 — an optional_outputs entry naming nothing in the contract silently WIDENS the
      // floor it was meant to narrow: the typo'd name excuses nothing, and the type the author
      // meant to mark optional stays required while they believe otherwise. That is the exact
      // class of bug the floor exists to close, so it is caught where the genome is authored
      // rather than mid-run.
      for (const opt of ch.optional_outputs ?? []) {
        if (!ch.output_contract.includes(opt)) {
          throw new CompositionError(
            `standard ${def.slug}: chair "${ch.role}" marks "${opt}" optional but does not promise it — ` +
              `optional_outputs must be a subset of output_contract [${ch.output_contract.join(", ")}]`,
          );
        }
      }
      // #243 — a skill-backed chair seals exactly ONE output: its deterministic code half
      // returns a single blob, and `prepareChair` takes `output_contract[0]` and discards the
      // rest. So a multi-entry contract on a skill chair is a promise the runtime structurally
      // cannot keep — and, worse, cannot even REPORT breaking, because the floor is computed
      // over the one spec that was built. Silent since the skill path was added. Reject it
      // here, where the author can see it, rather than letting entries 2..N evaporate.
      if (ch.skill_slug && (ch.agent_slug ?? "") === "" && ch.output_contract.length > 1) {
        throw new CompositionError(
          `standard ${def.slug}: skill-backed chair "${ch.role}" promises ${ch.output_contract.length} output types ` +
            `[${ch.output_contract.join(", ")}] but a skill seals exactly one. Only "${ch.output_contract[0]}" would ` +
            `ever be produced and the rest would be silently dropped — split the work across chairs, or back this ` +
            `chair with an agent.`,
        );
      }
      // A human chair seals exactly one output for the same structural reason: one approval,
      // one sealed verdict.
      if (isHumanChair && ch.output_contract.length > 1) {
        throw new CompositionError(
          `standard ${def.slug}: human chair "${ch.role}" promises ${ch.output_contract.length} output types — ` +
            `an approval office seals exactly one verdict.`,
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
  // depends_on chairs' output_contracts — OR by the standard's declared gig inputs
  // (#156: an ENTRY chair, depends_on [], reads its typed input_contract from gigInput;
  // that contract IS the typed gig seed, validated against gigInput at start-of-run by runGig).
  const gigInputs = new Set<string>(def.input_types ?? []);
  const chairByRole = new Map<string, Chair>();
  for (const ph of phases) {
    for (const ch of ph.chairs) chairByRole.set(ch.role, ch);
  }
  for (const ph of phases) {
    for (const ch of ph.chairs) {
      if (ch.input_contract.length === 0) continue;
      const produced = new Set<string>(gigInputs); // gig inputs are available to any chair
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
      if (ch.human === true && !ch.agent_slug) continue; // human chair: no agent to domain-check
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
      if (ch.human === true && !ch.agent_slug) continue; // human chair: not in the primitive graph
      const ag = agentBySlug.get(ch.agent_slug)!;
      if (i > 0) {
        // #188: check what THIS PLACEMENT actually consumes, not the agent's GLOBAL input_types
        // (its capability envelope across all roles) — so an agent reused across chairs isn't
        // blocked at an early, lean placement by a type only a later chair needs. Mirror the
        // runtime's own input resolution (prepareChair): a chair that declares an input_contract
        // (or a depends_on) is in the faithful path — check its input_contract; a chair that
        // declares neither falls back to the agent's input_types (the legacy all-prior-outputs
        // filter the runtime uses for it). Checked against upstream-produced ∪ standard.input_types.
        const consumed = ch.input_contract.length > 0
          ? ch.input_contract
          : ch.depends_on.length === 0 ? ag.input_types : [];
        for (const it of consumed) {
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
      if ((ch.skill_slug || ch.human === true) && !ch.agent_slug) {
        // a skill-backed or human chair produces its declared output_contract types — fold
        // those into the upstream bag so a downstream agent chair can consume them.
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

  // LOSS-FREE: spread the whole def, then override the two transform outputs — `phases` (the
  // validated PhaseDef) and `input_types` (the deduped standard-input set). Every other declared
  // field (eval_slugs / output_types / max_examine_rounds / description + anything added later to
  // StandardSchema) rides through automatically, so composition can't silently drop a sealed field —
  // the bug this whole change closes. The engine doesn't yet ENFORCE max_examine_rounds (separate task).
  const std: Standard = { ...def, phases, input_types: [...standardInputs] };
  return std;
}
