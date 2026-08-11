// The real AgentInvoker: builds the 5-layer prompt and runs cognition via the
// `claude` CLI (Claude Code IS the cognition — the prime directive's "depend on
// nothing but Claude Code"). buildPrompt is pure + testable; runClaude is the one
// non-deterministic seam (spawns the CLI, parses structured output).
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { abortReasonText, type AgentInvocationContext, type AgentInvoker, type AgentStreamEvent } from "./runtime.js";
import type { Registry } from "./registry.js";
import type { Depth, ModelTier } from "./pricing.js";
import type { CodeToolAccess } from "./composition.js";
import { resolveAgentGrants, type ToolProviderRegistry } from "./tool_providers.js";

const EMPTY_TOOL_REGISTRY: ToolProviderRegistry = new Map();

// Per-tier model resolution (the old MODEL_TIER_MAP: economy/standard/premium →
// haiku/sonnet/opus). An agent's model_tier picks the concrete spawn model; falls back to
// the invoker's static default only when the agent declares no tier.
export const MODEL_TIER_MAP: Record<ModelTier, string> = {
  economy: "claude-haiku-4-5",
  standard: "claude-sonnet-4-6",
  premium: "claude-opus-4-8",
};
/**
 * Tier → the model that actually runs. EXPORTED because the runtime must stamp the same answer
 * onto the sealed output that the invoker used to spawn. Two functions computing this
 * separately is the two-gates-one-concern shape that produced the silent wrong-resume.
 */
export function resolveModel(tier: ModelTier | undefined, fallback: string | undefined): string | undefined {
  return tier ? MODEL_TIER_MAP[tier] : fallback;
}

// code_tool_access → the built-in code tools the cage denies. none denies all; read keeps
// Read; write keeps Read/Write/Edit; full denies none; unset adds no denial layer.
const CODE_TOOLS = ["Read", "Write", "Edit", "Bash"] as const;
function codeToolDenials(access: CodeToolAccess | undefined): string[] {
  switch (access) {
    case "none": return [...CODE_TOOLS];
    case "read": return ["Write", "Edit", "Bash"];
    case "write": return ["Bash"];
    default: return []; // "full" or unset → no code-tool denial
  }
}

// Belbin cognitive-role descriptions for the Disposition layer (the agent's stance, 2
// "in tension"). Strings match the old runtime verbatim so a restored prompt reaches
// parity with the baseline fixtures. Reference data; buildPrompt wires it in.
export const BELBIN_DESCRIPTIONS: Record<string, string> = {
  explorer: "Navigates unknown territory, discovers structure, maps the landscape.",
  analyst: "Finds patterns, extracts meaning, builds structured understanding from raw data.",
  critic: "Challenges assumptions, finds weaknesses, demands evidence for every claim.",
  synthesizer: "Combines disparate inputs into coherent wholes, resolves contradictions.",
  planner: "Decomposes goals into sequences, allocates resources, designs strategies.",
  executor: "Produces concrete artifacts, writes code, builds deliverables.",
  audience_modeler: "Understands user perspectives, models personas, anticipates needs.",
};

// #237 — what a dispatch-time depth actually ASKS FOR. The prompt half of the lever.
export const DEPTH_GUIDANCE: Record<Depth, string> = {
  skim: " — this is a cheap iteration pass. Do the minimum that produces a well-formed, valid output. Do not explore, do not use tools you do not strictly need, do not elaborate.",
  quick: " — favour speed over exhaustiveness. Cover the obvious ground and stop.",
  standard: "",
  deep: " — be exhaustive. Chase the non-obvious and justify every claim.",
};

// #237 — the SPEND half of the lever. `--max-turns` is the only hard per-chair cost bound the
// cage has, so a shallow depth caps it: a skim run that can still take 100 tool turns is a full
// run wearing a label. Only ever TIGHTENS an agent's own declared cap, never widens it. Depths
// with no entry leave the agent's cap exactly as declared.
export const DEPTH_MAX_TOOL_CALLS: Partial<Record<Depth, number>> = { skim: 8, quick: 16 };

// The 5-layer prompt hierarchy: Disposition → Identity → Skills → Context → Task.
// Pure: same context in, same prompt out. Hashable, reviewable, testable.
// Layer 3 (Skills) is emitted when the AgentInvocationContext carries resolved
// SkillRecords — the runtime resolves the agent's `skill_slugs` against the
// genome's skills map and passes the records through. Empty/absent → the Skills
// section is omitted entirely (no empty header, no noise) so the model only
// sees skills the agent actually declared.
/**
 * The schema a producer is SHOWN for an output type — by construction the same object
 * the seal enforces (`Registry.effectiveSchema`), never the raw authored schema.
 *
 * 2026-08-08 — three consecutive live chair failures shared one cause: the prompt
 * rendered `dt.schema` verbatim while the seal enforced core-merged properties plus
 * `union(schema.required, required_fields)`. A producer emitting a maximally-valid
 * object against the shown contract was rejected against the enforced one, and the
 * chair failed closed. This function is the unification point: if the producer's view
 * ever needs to differ from the seal's again, that difference must be argued here.
 */
export function promptSchemaFor(
  registry: Registry | undefined,
  slug: string | undefined,
): Record<string, unknown> | undefined {
  if (!registry || !slug) return undefined;
  return registry.effectiveSchema(slug);
}

export function buildPrompt(
  ctx: AgentInvocationContext,
  outputSchema?: Record<string, unknown>,
  // Per-type schemas for a MULTI-output agent (slug → schema). When the agent declares
  // more than one output type, the Task layer asks for a blob keyed by type rather than a
  // single object — the runtime then seals one record per key.
  outputSchemas?: Record<string, Record<string, unknown> | undefined>,
): string {
  const a = ctx.agent;
  const layers: string[] = [];

  // 1. Disposition — the Belbin cognitive-role pairing, held in tension (how you think).
  const dispo = a.behavioral_primitives.map((r) => `- **${r}**: ${BELBIN_DESCRIPTIONS[r] ?? r}`).join("\n");
  layers.push(
    `# Disposition\nYou hold these cognitive modes in equal tension:\n${dispo}\nHold every mode active throughout your work; none dominates.`,
  );

  // 2. Identity — who you are: the slug line plus the agent's own prose.
  layers.push(
    `# Identity\nYou are the agent "${a.slug}"${a.domain ? ` in the "${a.domain}" domain` : ""}.\n\n${a.identity}`,
  );

  // 3. Method — how THIS agent does its job, the step-by-step.
  layers.push(`# Method\n${a.method}`);

  // 4. Skills — content the agent's bound skills contribute to the prompt. Each
  // skill renders as `## <slug>` + its text payload. We pick the first non-empty
  // string from the conventional content keys (`md`, then `text`, then `body`);
  // a slug-only SkillRecord still renders its slug so the model knows it's bound.
  const resolved = ctx.skills ?? [];
  const skillBlocks = resolved.length > 0
    ? resolved.map((s) => {
        const text =
          (typeof s["md"] === "string" && (s["md"] as string)) ||
          (typeof s["text"] === "string" && (s["text"] as string)) ||
          (typeof s["body"] === "string" && (s["body"] as string)) ||
          "";
        return `## ${s.slug}${text ? `\n${text}` : ""}`;
      })
    // No resolved content this gig — still name the bound skills so the model knows it has
    // them (matches the old runtime's skills index). #241: NEVER name a slug the runtime
    // resolved to no package. An all-dangling agent used to render `# Skills` / `## <slug>`
    // with zero content — the prompt ASSERTING to the model that it holds a discipline that
    // does not exist. An ABSENT `missing_skills` means resolution was never attempted (no
    // skills map), so nothing is known-unresolved and the legacy index behaviour stands.
    : (a.skill_slugs ?? [])
        .filter((slug) => !(ctx.missing_skills ?? []).includes(slug))
        .map((slug) => `## ${slug}`);
  if (skillBlocks.length > 0) {
    layers.push(`# Skills\n${skillBlocks.join("\n\n")}`);
  }

  // 5. Constraints — the negative space (never-invent / cite-sources). Omitted when empty.
  if (a.constraints.length > 0) {
    layers.push(`# Constraints\n${a.constraints.map((c) => `- ${c}`).join("\n")}`);
  }

  // 6. Available Tools — name every granted tool so the model knows it has them and uses
  // them (the cage grants access; the prompt must grant awareness, or the tools sit unused).
  if (a.allowed_tools && a.allowed_tools.length > 0) {
    layers.push(
      `# Available Tools\nThese tools are available to you — call them directly:\n${a.allowed_tools.map((t) => `- ${t}`).join("\n")}`,
    );
  }

  // 7. Context — the gig input + the upstream typed outputs you consume + depth tuning.
  const inputsBlock = ctx.inputs.length
    ? ctx.inputs.map((o) => `- ${o.domain_type} (from ${o.agent_slug}): ${JSON.stringify(o.data)}`).join("\n")
    : "(none — you are a root agent)";
  // #237 — a dispatch-time depth OVERRIDES the agent's static depth_profile, and carries an
  // instruction with it. A depth that only gets recorded is not a cost lever; the model has to
  // be told to do less, or "skim first" stays a slogan and every iteration pays full price.
  const runDepth = ctx.depth ?? a.depth_profile;
  const depthLine = runDepth
    ? `Depth: ${runDepth}${ctx.depth ? DEPTH_GUIDANCE[ctx.depth] : ""}\n`
    : "";
  layers.push(`# Context\n${depthLine}Gig input: ${JSON.stringify(ctx.gig_input)}\nUpstream outputs:\n${inputsBlock}`);

  // 5. Task — produce the types THIS CHAIR promises as JSON. #174: the chair's output_contract
  // (threaded as ctx.output_types) is the selector — a multi-capability agent at a single-purpose
  // chair is asked for only its promised subset, not its whole catalogue. Legacy ctx without it
  // falls back to the agent's full output_types.
  const sealTypes = ctx.output_types?.length ? ctx.output_types : a.output_types;
  if (sealTypes.length > 1) {
    // multi-output: one JSON object keyed by each output-type slug; each value is that
    // type's data. The runtime seals one record per key (a SENSE+JUDGE agent yields its
    // Signal and its Judgment in one pass).
    const perType = sealTypes
      .map((t) => {
        const s = outputSchemas?.[t];
        return `  "${t}": <object${s ? ` matching ${JSON.stringify(s)}` : ""}>`;
      })
      .join(",\n");
    layers.push(
      `# Task\nProduce one object for EACH of your output types: ${sealTypes.map((t) => `"${t}"`).join(", ")}.\n` +
        `Respond with ONLY a single JSON object keyed by output-type name — no prose, no code fence:\n{\n${perType}\n}`,
    );
  } else {
    const outType = sealTypes[0] ?? "output";
    const schemaHint = outputSchema ? `\nIt must match this JSON schema:\n${JSON.stringify(outputSchema)}` : "";
    layers.push(
      `# Task\nProduce exactly one "${outType}".${schemaHint}\n` +
        `Respond with ONLY a single JSON object (the output's data) — no prose, no code fence.`,
    );
  }

  return layers.join("\n\n");
}

// ───────────────────────── JSON extraction (#221, #226) ─────────────────────────
//
// The old implementation took "the first balanced brace run" — string-blind, anchored on
// the first `{` and never re-anchored, with exactly one candidate ever handed to
// JSON.parse. It mis-sliced valid output (a `}` inside a string value truncated the slice)
// and, worse, silently returned an illustrative preamble object in place of the answer.
// That wrong object then sealed with a real content_sha and genuine provenance edges, so
// `output_trace` reported an intact chain over garbage.
//
// This is now ONE implementation shared by all four production call sites (:319, :325,
// bifrost_invoker.ts, document_factory.ts) — see #226; the judge's half-fixed duplicate is
// gone.

/** Bound on the raw-output excerpt a parse failure carries, so no blob lands in a log line. */
const EXCERPT_MAX_CHARS = 500;

/**
 * A typed extraction failure. Carries the number of balanced JSON objects found and a
 * bounded excerpt of the raw text — previously both throws were bare `Error`s with no
 * sample, so the operator's entire diagnostic was a V8 offset into a string never
 * surfaced. The type is also the prerequisite for any future retry policy: runtime.ts
 * cannot currently tell a retryable parse failure from a non-retryable contract failure.
 */
export class ModelOutputParseError extends Error {
  readonly candidateCount: number;
  readonly excerpt: string;
  constructor(message: string, candidateCount: number, raw: string) {
    super(`${message} (candidates: ${candidateCount})`);
    this.name = "ModelOutputParseError";
    this.candidateCount = candidateCount;
    this.excerpt =
      raw.length > EXCERPT_MAX_CHARS ? `${raw.slice(0, EXCERPT_MAX_CHARS)}…` : raw;
  }
}

/**
 * A payload that parsed cleanly but VIOLATES its output_contract, after the bounded in-loop
 * repair was exhausted. Distinct from ModelOutputParseError (which is "no answer / unparseable
 * answer"): this is a well-formed answer that does not satisfy the schema the seal enforces.
 *
 * It exists so the failure is legible at the write boundary — the earliest frame the predicate
 * is answerable and the producer could still have acted — rather than post-hoc at seal, after
 * the agent process has exited (runtime.ts validateWrite, which now only ever fires as an
 * unreachable backstop for a model chair).
 */
export class ModelOutputContractError extends Error {
  readonly slug: string;
  readonly reason: string;
  readonly attempts: number;
  constructor(slug: string, reason: string, attempts: number) {
    super(
      `chair "${slug}" did not satisfy its output_contract after ${attempts} attempt(s): ${reason}. ` +
        `The payload was adjudicated at the write boundary and rejected, so nothing was sealed.`,
    );
    this.name = "ModelOutputContractError";
    this.slug = slug;
    this.reason = reason;
    this.attempts = attempts;
  }
}

/** How many in-loop repair re-prompts a chair gets before its output fails the contract. */
export const MAX_CONTRACT_REPAIRS = 2;

/**
 * Adjudicate an EXTRACTED chair payload against its output_contract, using the SAME
 * `registry.validate` the seal runs (outputs.ts checkWritable → registry.validate). Returns a
 * human-readable reason when the payload violates the contract, or `undefined` when it satisfies
 * it — or cannot be checked here (no registry wired, or a bare-core / freeform / unregistered
 * type, all of which registry.validate itself treats as pass or defers to the seal).
 *
 * The slice logic MIRRORS the runtime's (runtime.ts ~2187): a multi-output blob is keyed by
 * type slug, so each PRESENT key is validated and an ABSENT key is skipped (optionality is the
 * seal's business via `optional_outputs`, and nothing about a run's arguments is known here); a
 * single-output blob is either keyed by its type slug or IS the bare data object. What the
 * invoker checks is therefore exactly what the seal would enforce, so the two cannot disagree.
 */
export function contractViolation(
  registry: Registry | undefined,
  sealTypes: readonly string[],
  payload: Record<string, unknown>,
): string | undefined {
  if (!registry) return undefined;
  const single = sealTypes.length === 1;
  const problems: string[] = [];
  for (const t of sealTypes) {
    const keyed = payload[t] as Record<string, unknown> | undefined;
    const slice = keyed !== undefined && keyed !== null ? keyed : single ? payload : undefined;
    if (slice === undefined || slice === null) continue; // absent → seal adjudicates optionality
    if (typeof slice !== "object" || Array.isArray(slice)) {
      problems.push(`"${t}" must be a JSON object, got ${Array.isArray(slice) ? "array" : typeof slice}`);
      continue;
    }
    const res = registry.validate({ core_type: "", domain_type: t, data: slice as Record<string, unknown> });
    if (!res.valid) problems.push(`"${t}": ${res.errors.join("; ")}`);
  }
  return problems.length > 0 ? problems.join(" | ") : undefined;
}

/**
 * The repair instruction appended to the ORIGINAL prompt for an in-loop retry. Names the exact
 * contract violation so the model corrects THIS defect — the difference between a targeted
 * repair and a blind restart.
 */
export function repairPromptAppendix(reason: string): string {
  return (
    `\n\n# Output Contract Violation — Correct And Re-emit\n` +
    `Your previous response parsed, but did NOT satisfy the output contract:\n${reason}\n` +
    `Emit a corrected JSON object that fixes exactly this. ` +
    `Respond with ONLY the corrected JSON object — no prose, no code fence.`
  );
}

export interface ExtractJsonOptions {
  /**
   * Keys the answer is expected to carry. A candidate matches only if it contains **all**
   * of them — a partial match does not score, because "closest wins" is exactly the
   * guess that produces silent corruption.
   *
   * NOTE on derivation (see `extractOptionsForChair`): the two prompt shapes are mutually
   * exclusive, so schema property names and type slugs are chosen per-shape rather than
   * merged into one set. A flat union is unsatisfiable under all-must-match semantics —
   * a single-output answer `{"title":…}` can never also contain the key `finding`.
   */
  expectKeys?: readonly string[] | undefined;
  /**
   * Set by a caller that has NO key signal at all (a bare-core output type, or a domain
   * type absent from the registry — the same short-circuit registry.ts:140-146 takes).
   * One candidate is unambiguous and safe; multiple candidates with nothing to choose
   * between them is precisely the situation that silently seals the wrong object, so it
   * fails loudly instead of guessing.
   */
  requireUnambiguous?: boolean | undefined;
}

/** A balanced, parseable JSON object found in the text, with its span. */
interface JsonCandidate {
  start: number;
  end: number;
  value: Record<string, unknown>;
}

/**
 * Walk forward from `start` (which must be a `{`) honouring JSON string literals and
 * backslash escapes, so only STRUCTURAL braces move the depth counter. Returns the index
 * of the matching `}`, or -1 if the object never closes.
 *
 * Escape handling is the half of this that is easiest to get wrong, and two guards pin
 * it: `{"path":"C:\\","v":1}` (an escaped backslash immediately before the closing quote
 * — a naive `inString = !inString` toggle breaks it) and `{"note":"use {slug} here"}`
 * (balanced in-string braces, which worked by accident before and must keep working).
 */
function scanBalanced(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every balanced, parseable JSON object in the text, in document order.
 *
 * Enumerates at EVERY `{` start position — the old code fixed `start` at the first one,
 * so a brace run in the prose (`The set {a,b} matters.`) sank the whole extraction. A
 * start that fails to parse is skipped and the scan re-anchors on the next `{`.
 *
 * Starts INSIDE an accepted candidate are skipped, so `{"a":{"b":1},"c":2}` yields the
 * outer object rather than also offering its own nested `{"b":1}` as a rival.
 */
function enumerateCandidates(text: string): JsonCandidate[] {
  const found: JsonCandidate[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") { i++; continue; }
    const end = scanBalanced(text, i);
    if (end === -1) { i++; continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(text.slice(i, end + 1)); } catch { i++; continue; }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      found.push({ start: i, end, value: parsed as Record<string, unknown> });
      i = end + 1;
      continue;
    }
    i++;
  }
  return found;
}

// A fenced block, tagged (```json) or bare (```). Non-greedy so consecutive fences are
// separate spans rather than one span swallowing the prose between them.
const FENCE_RE = /```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/g;

/** Character spans of every fenced block's BODY. */
function fenceSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const body = m[1] ?? "";
    const bodyStart = m.index + m[0].length - 3 - body.length;
    spans.push({ start: bodyStart, end: bodyStart + body.length - 1 });
  }
  return spans;
}

/**
 * Extract the model's answer object from its output.
 *
 * Selection policy (a deliberate contract change from "the first balanced object"):
 *   1. A candidate inside a fenced block beats one outside; among fenced, prefer the last.
 *   2. Then `expectKeys` — a candidate must contain ALL expected keys to qualify.
 *   3. Then the LAST surviving candidate, not the first. The prompt demands a single
 *      object (buildPrompt :146/:153), so an earlier object is evidence of scaffolding.
 *
 * A whole-text top-level array is handled explicitly: one element unwraps, more than one
 * throws rather than silently discarding the array framing and every later element.
 */
export function extractJson(
  text: string,
  opts: ExtractJsonOptions = {},
): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    let arr: unknown;
    try { arr = JSON.parse(trimmed); } catch { /* not a clean array — fall through */ }
    if (Array.isArray(arr)) {
      const only = arr.length === 1 ? arr[0] : undefined;
      if (only && typeof only === "object" && !Array.isArray(only)) {
        return only as Record<string, unknown>;
      }
      throw new ModelOutputParseError(
        `model output is a ${arr.length}-element JSON array where a single object was required`,
        arr.length,
        text,
      );
    }
  }

  const candidates = enumerateCandidates(text);
  if (candidates.length === 0) {
    throw new ModelOutputParseError(
      "no JSON object in model output — the model produced no answer",
      0,
      text,
    );
  }

  // 1. Fenced candidates win outright when any exist.
  const spans = fenceSpans(text);
  const fenced = candidates.filter((c) => spans.some((s) => c.start >= s.start && c.end <= s.end));
  let pool = fenced.length > 0 ? fenced : candidates;

  // 2. Expected keys — ALL must be present. If nothing matches, the signal simply does not
  //    narrow (it never widens, and it never picks a partial match).
  const keys = opts.expectKeys ?? [];
  if (keys.length > 0) {
    const matching = pool.filter((c) =>
      keys.every((k) => Object.prototype.hasOwnProperty.call(c.value, k)),
    );
    if (matching.length > 0) pool = matching;
  }

  // 3. Refuse to guess when the caller had nothing to score against.
  if (pool.length > 1 && opts.requireUnambiguous === true) {
    throw new ModelOutputParseError(
      "ambiguous model output — several JSON objects and no output schema to choose between them",
      pool.length,
      text,
    );
  }

  return pool[pool.length - 1]!.value;
}

/** Property names declared by a resolved output schema (the single-output key signal). */
function schemaPropertyNames(schema: Record<string, unknown> | undefined): string[] {
  const props = schema?.["properties"];
  return props && typeof props === "object" ? Object.keys(props as Record<string, unknown>) : [];
}

/**
 * Build the extractor's options for a chair from what the invoker already resolved.
 * Shared by the Claude and Bifrost invokers so the key signal reaches every call site —
 * behaviour propagates through the shared import, but `expectKeys` does not unless each
 * site passes it (#221 policy 5).
 *
 * The two prompt shapes are mutually exclusive, so the derivation is per-shape:
 *  - MULTI-output chair — buildPrompt :138-147 asks for a blob keyed by type slug, so the
 *    slugs are the expected keys.
 *  - SINGLE-output chair — buildPrompt :148-155 asks for the bare data object, never
 *    wrapped in {"<type-slug>": …}. The signal is the schema's REQUIRED field names —
 *    the contract's floor, which every compliant emission must carry — falling back to
 *    property names when the schema requires nothing. Required-first became necessary
 *    with the producer/enforcer unification (2026-08-08): the schema here is now the
 *    EFFECTIVE one, whose property list includes every core-inherited optional field;
 *    under all-must-match semantics, all-props would demand keys no emission carries
 *    and the signal would never narrow. (It was also quietly too strict before — a
 *    candidate omitting a declared-optional field failed the old all-props signal.)
 *  - Neither available (bare core type, or a domain type absent from the registry) —
 *    no signal, so refuse to guess between rival candidates.
 */
export function extractOptionsForChair(
  sealTypes: readonly string[],
  schema: Record<string, unknown> | undefined,
): ExtractJsonOptions {
  if (sealTypes.length > 1) return { expectKeys: [...sealTypes] };
  const req = Array.isArray(schema?.["required"])
    ? (schema!["required"] as unknown[]).filter((k): k is string => typeof k === "string")
    : [];
  if (req.length > 0) return { expectKeys: req };
  const props = schemaPropertyNames(schema);
  return props.length > 0 ? { expectKeys: props } : { requireUnambiguous: true };
}

// The wall-clock bound on one chair's spawn. A tool-granted child has no inherent
// terminus (it can search/loop), and the gig runs the spawn synchronously — so without
// this bound one wedged child wedges the whole server. SIGKILL, not SIGTERM: a
// signal-trapping child can't outlive its budget. Long enough for a tool-using chair
// (a capped search agent runs minutes), far below an operator-visible hang.
export const DEFAULT_CHAIR_TIMEOUT_MS = 10 * 60_000;

// How long a cancelled chair child gets to shut down politely before it is killed outright.
// SIGTERM first (a `claude` child spawns its own MCP servers; a cooperative exit gives it a
// chance to take them with it), SIGKILL after. Deliberately NOT `detached: true` +
// process.kill(-pid): that is the only airtight answer to grandchild orphaning, but it takes
// children OUT of the server's process group, so an operator's Ctrl-C stops reaching them —
// which makes #252 worse, not better. Process-group kill is a separate decision.
export const DEFAULT_ABORT_GRACE_MS = 2_000;

// #250/#252 — every chair child the invoker spawns, so something can reach them.
// Before this, `child` was a const inside spawnStreaming's promise executor: never returned,
// never registered, never exposed, and the ONLY path to child.kill was the timeout closure.
// A server told to shut down could not stop its own grandchildren, which kept running,
// orphaned, still billing — with gig tracking dropped, so nothing recorded they existed.
const LIVE_CHAIR_CHILDREN = new Set<ChildProcess>();

/** How many chair children are alive right now (observability for the shutdown path). */
export function liveChairChildCount(): number {
  return LIVE_CHAIR_CHILDREN.size;
}

/** SIGTERM every live chair child, escalating to SIGKILL after `graceMs`. Returns the count
 *  signalled. Called on server shutdown so a restart is not an orphaning. */
export function killLiveChairChildren(graceMs = DEFAULT_ABORT_GRACE_MS): number {
  const victims = [...LIVE_CHAIR_CHILDREN];
  for (const c of victims) terminateChild(c, graceMs);
  return victims.length;
}

function terminateChild(child: ChildProcess, graceMs: number): void {
  const hardKill = (): void => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  if (graceMs <= 0) { hardKill(); return; }
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) hardKill();
  }, graceMs);
  // never hold the event loop open just to escalate a kill
  t.unref?.();
}

// Spawn bounds passed to the run seam (execFileSync options in the default runner).
export interface SpawnBounds {
  timeout: number;
  killSignal: "SIGKILL";
}

export interface ClaudeInvokerOptions {
  bin?: string | undefined; // default "claude"
  model?: string | undefined; // passed to --model if set
  registry?: Registry | undefined; // to resolve the output type's schema into the prompt
  // The MCP servers the cage permits the spawn to load. Empty = no MCP tools at all.
  // With --strict-mcp-config, ONLY these load — never the host's ambient servers.
  // This is the BASE map; #185 resolution adds the per-agent servers its grants require.
  mcpServers?: Record<string, unknown> | undefined;
  // #185 — tool-grant → provider resolution. `toolProviders` maps explicit tool names to
  // providers; `mcpServerConfigs` maps an MCP server slug → its --mcp-config entry (coltrane
  // ships its own "coltrane" server). Per invocation, the agent's allowed_tools resolve through
  // these into the spawn's mcp-config; a grant with no provider fails the chair closed (a dead
  // name never reaches the model). Absent = empty (only host-builtins resolve; any MCP grant fails).
  toolProviders?: ToolProviderRegistry | undefined;
  mcpServerConfigs?: Record<string, unknown> | undefined;
  run?: ((bin: string, args: string[], spawn: SpawnBounds) => string | Promise<string>) | undefined; // injectable spawn (tests)
  // Per-deployment override of the per-chair wall-clock bound.
  timeout_ms?: number | undefined;
  // Grace between SIGTERM and SIGKILL when a chair is cancelled. Override in tests.
  abort_grace_ms?: number | undefined;
  // When set, the spawned child receives COLTRANE_PARENT_SESSION_ID so its first
  // recorded turn seals the lineage edge to its parent.
  parent_session_id?: string | undefined;
}

// The blast-radius cage, PURE. Given the agent's tool grant + a per-gig mcp-config path,
// build the claude CLI args. Two halves: `--strict-mcp-config` + `--mcp-config <path>`
// means the spawn loads ONLY the servers in that file (never the host's ambient MCP) —
// deny-by-default. `--allowedTools`/`--disallowedTools` scope the tool surface to the
// agent's declared grant. Ports OG's claude-launcher 4-flag cage.
/**
 * Default ceiling for a prompt carried as a command-line argument.
 *
 * Windows caps a whole command line at ~32,767 characters. The prompt is not the only thing on
 * it — the mcp-config path, the model, and the allow/deny tool lists ride along — so the
 * threshold sits well below the cap rather than at it.
 */
export const PROMPT_ARG_LIMIT_DEFAULT = 16_000;

function promptArgLimit(): number {
  const raw = process.env["COLTRANE_PROMPT_ARG_LIMIT"];
  if (!raw) return PROMPT_ARG_LIMIT_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : PROMPT_ARG_LIMIT_DEFAULT;
}

/**
 * Whether this prompt must be delivered on the child's stdin instead of its command line.
 *
 * The engine used to put every chair prompt in argv. On Windows a strategize-phase prompt
 * (blueprint + draft + review) exceeds the command-line cap and the spawn dies with
 * ENAMETOOLONG — reported by a consumer as "broken on Windows … local dev was practically
 * unusable", and worked around downstream by monkey-patching `child_process.spawn` against
 * this module's built output. That patch is coupled to argv construction here and breaks
 * SILENTLY if it changes, so the fix belongs in the engine.
 *
 * `COLTRANE_PROMPT_MODE` forces `arg` or `stdin`; anything else, including a typo, falls back
 * to the size test rather than failing a dispatch.
 */
export function promptViaStdin(prompt: string): boolean {
  const mode = process.env["COLTRANE_PROMPT_MODE"];
  if (mode === "arg") return false;
  if (mode === "stdin") return true;
  return prompt.length > promptArgLimit();
}

export function buildInvokerArgs(
  prompt: string,
  mcpConfigPath: string,
  opts: { model?: string | undefined; allowed_tools?: readonly string[] | undefined; disallowed_tools?: readonly string[] | undefined; max_tool_calls?: number | undefined },
): string[] {
  // `-p` is a BOOLEAN flag and the prompt is a POSITIONAL argument, which is what makes the
  // large-prompt path clean: keep the flag, drop the positional, write it to stdin. The
  // downstream patch drops `-p` as well and lets the CLI infer print mode from a non-TTY
  // stdin; keeping the flag states it, and costs nothing.
  const args = promptViaStdin(prompt) ? ["-p"] : ["-p", prompt];
  if (opts.model) args.push("--model", opts.model);
  // per-agent blast-radius cap: a runaway agent can't burn past its own turn budget.
  if (opts.max_tool_calls !== undefined) args.push("--max-turns", String(opts.max_tool_calls));
  // the cage floor: no ambient MCP servers leak into the spawn, ever.
  args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  if (opts.allowed_tools && opts.allowed_tools.length > 0) args.push("--allowedTools", opts.allowed_tools.join(","));
  if (opts.disallowed_tools && opts.disallowed_tools.length > 0) args.push("--disallowedTools", opts.disallowed_tools.join(","));
  return args;
}

// The production AgentInvoker. Writes a per-gig mcp-config (the permitted servers only),
// spawns `claude -p` inside the cage, parses the JSON. The spawn is the non-deterministic
// seam (inject `run` to test the cage args + parse without the CLI). When a
// parent_session_id is provided, every spawned MCP server in this child receives it via
// env so the recorder seals the parent → child lineage edge on the child's first turn.
export function makeClaudeInvoker(opts: ClaudeInvokerOptions = {}): AgentInvoker {
  const bin = opts.bin ?? "claude";
  // Injected run (tests) short-circuits the spawn: plain mode, returns the JSON blob directly.
  // Absent → the default streaming spawn below runs the real CLI with stream-json.
  const customRun = opts.run;
  const spawnBounds: SpawnBounds = { timeout: opts.timeout_ms ?? DEFAULT_CHAIR_TIMEOUT_MS, killSignal: "SIGKILL" };
  // #185 — grant resolution is enabled once the deployment wires a provider registry (either map
  // present). Until then the invoker keeps its legacy pass-through (tools listed, no resolution) so
  // a bare/test invoker is unaffected. bootstrapServerDeps always supplies mcpServerConfigs, so the
  // running engine always resolves + fails closed.
  const resolutionEnabled = opts.toolProviders !== undefined || opts.mcpServerConfigs !== undefined;
  const abortGraceMs = opts.abort_grace_ms ?? DEFAULT_ABORT_GRACE_MS;
  return async (ctx) => {
    // #250 — a chair whose gig is already cancelled spends nothing: no prompt, no mcp-config,
    // no spawn. This is the cheapest point on the whole cancellation chain.
    if (ctx.signal?.aborted) {
      throw new Error(`chair "${ctx.agent.slug}" not started — gig aborted (${abortReasonText(ctx.signal)})`);
    }
    // Resolve THIS agent's grants → the MCP servers it needs, FIRST: a grant with no resolvable
    // provider is a dead name, so fail the chair closed before we build a prompt or spawn a child
    // that advertises a tool it can't call.
    let resolvedMcpServers: Record<string, unknown> = {};
    // The grants as the SPAWN must see them in --allowedTools. Default to the raw grant list (the
    // legacy pass-through invoker); when resolution is on, use the resolved names — an in-house engine
    // tool granted by bare slug becomes mcp__<server>__<tool>, the name its server advertises (#204).
    let effectiveAllowed: readonly string[] | undefined = ctx.agent.allowed_tools;
    if (resolutionEnabled) {
      // resolveAgentGrants folds the deny-by-default browser cage this agent's browser_grant builds
      // (an agent that grants mcp__playwright__* but declares NO browser_grant has no playwright
      // config → unresolvable → fails closed, no uncaged browser ever) and resolves every grant. It
      // is the ONE place per-agent resolution happens — shared with runGig's dispatch preflight so
      // the two resolve against the IDENTICAL environment (no drift between what preflight checks and
      // what this chair gets). This per-chair throw stays the fail-closed BACKSTOP: the preflight
      // refuses a doomed gig at t=0, but any chair reached by another path still fails closed here,
      // before a child is spawned that advertises a tool it cannot back.
      const resolved = resolveAgentGrants(
        ctx.agent,
        opts.toolProviders ?? EMPTY_TOOL_REGISTRY,
        opts.mcpServerConfigs ?? {},
      );
      if (resolved.unknown.length > 0) {
        throw new Error(
          `agent "${ctx.agent.slug}" grants unresolvable tool(s) [${resolved.unknown.join(", ")}] — no provider registered ` +
            `(a granted tool with no provider is a dead name; register a provider or remove the grant)`,
        );
      }
      resolvedMcpServers = resolved.mcpServers;
      effectiveAllowed = resolved.effectiveAllowed;
    }
    const schemaOf = (slug: string | undefined) => promptSchemaFor(opts.registry, slug);
    // #174 — schemas follow the chair's promised subset (ctx.output_types), not the agent's
    // whole catalogue; legacy ctx without it falls back to the agent's full output_types.
    const sealTypes = ctx.output_types?.length ? ctx.output_types : ctx.agent.output_types;
    const outType = sealTypes[0];
    const schema = schemaOf(outType);
    // For a multi-output chair, resolve every promised type's schema so the Task layer can
    // ask for a blob keyed by type; the runtime seals one record per key.
    const outputSchemas = sealTypes.length > 1
      ? Object.fromEntries(sealTypes.map((t) => [t, schemaOf(t)]))
      : undefined;
    const prompt = buildPrompt(ctx, schema, outputSchemas);
    // #221 — the key signal for candidate selection, derived from what we just resolved.
    // Threaded into BOTH extract calls below; threading only the injected-run one would
    // leave every real chair unscored.
    const extractOpts = extractOptionsForChair(sealTypes, schema);
    // per-gig mcp-config: only the deployment-permitted servers (empty by default).
    const cfgPath = join(tmpdir(), `coltrane-mcp-${randomUUID()}.json`);
    // the base map (opts.mcpServers) + the per-agent servers its grants resolved to (#185).
    const servers = { ...(opts.mcpServers ?? {}), ...resolvedMcpServers };
    const parent = opts.parent_session_id;
    // Inject parent_session_id env into every named server so children seal lineage.
    const enriched = parent
      ? Object.fromEntries(
          Object.entries(servers).map(([name, def]) => {
            const d = (def && typeof def === "object" ? def : {}) as Record<string, unknown>;
            const env = (d["env"] && typeof d["env"] === "object" ? d["env"] : {}) as Record<string, unknown>;
            return [name, { ...d, env: { ...env, COLTRANE_PARENT_SESSION_ID: parent } }];
          }),
        )
      : servers;
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: enriched }));
    try {
      const a = ctx.agent;
      // #237 — a shallow run depth tightens the turn cap; it never widens the agent's own.
      const depthCap = ctx.depth ? DEPTH_MAX_TOOL_CALLS[ctx.depth] : undefined;
      const maxToolCalls = depthCap === undefined
        ? a.max_tool_calls
        : Math.min(depthCap, a.max_tool_calls ?? depthCap);
      // Run ONE invocation with the given prompt and return the raw answer text. Custom run
      // (tests): plain mode, the returned string IS the JSON blob. Default: stream-json so the
      // child's tool calls / reasoning are observable LIVE, teed to ctx.onEvent.
      const runOnce = async (promptText: string): Promise<string> => {
        const baseArgs = buildInvokerArgs(promptText, cfgPath, {
          model: resolveModel(a.model_tier, opts.model),
          allowed_tools: effectiveAllowed,
          disallowed_tools: [...(a.disallowed_tools ?? []), ...codeToolDenials(a.code_tool_access)],
          max_tool_calls: maxToolCalls,
        });
        if (customRun) return await customRun(bin, baseArgs, spawnBounds);
        const args = [...baseArgs, "--output-format", "stream-json", "--verbose"];
        // #250 level 3 — the cancellation signal and grace window reach the spawn, so an
        // aborted gig actually kills its chair child (and never spawns one if already aborted).
        const stdout = await spawnStreaming(
          bin, args, spawnBounds, ctx.onEvent, ctx.signal, abortGraceMs,
          promptViaStdin(promptText) ? promptText : undefined,
        );
        const outcome = finalText(stdout);
        // #223 — the child reported an error result. Both discriminators are required, and
        // both are verified against the CLI (see the note on StreamOutcome): `subtype` for a
        // run that did not complete, `is_error` for an API-error payload riding subtype
        // "success". Neither is a chair answer, and the CLI exits 0 for the subtype cases —
        // so without this the partial reasoning seals as if it had succeeded.
        if (outcome.errorSubtype !== undefined) {
          throw new Error(
            `claude ended with result subtype "${outcome.errorSubtype}" — the run did not ` +
              `complete, so any text it emitted is partial reasoning, not an answer`,
          );
        }
        if (outcome.apiErrorText !== undefined) {
          throw new Error(
            `claude flagged its result with is_error — the payload is an error message, not an ` +
              `answer: ${outcome.apiErrorText.slice(0, 300)}`,
          );
        }
        // #222 — the stream parsed but carried no answer at all (e.g. only a system/init
        // event). Report THAT, with the raw stdout as evidence, instead of blaming the model
        // for emitting no JSON.
        if (outcome.text.trim() === "") {
          throw new ModelOutputParseError(
            "the model produced no answer — the stream carried no result text and no assistant text",
            0,
            stdout,
          );
        }
        return outcome.text;
      };

      // THE WRITE-BOUNDARY GUARD. Extract the payload, then adjudicate it against its
      // output_contract HERE — the earliest frame the predicate is answerable and the producer
      // can still act — using the same registry.validate the seal runs. On a violation, RE-PROMPT
      // the SAME agent with the exact validation error (a targeted repair, not a blind restart),
      // bounded to MAX_CONTRACT_REPAIRS. Only a persistently-invalid output fails the chair, and
      // it fails HERE with the reason rather than post-hoc at seal after the agent has exited. The
      // seal's own validateWrite stays as an unreachable backstop for this path.
      let promptForAttempt = prompt;
      let lastViolation = "";
      for (let attempt = 0; ; attempt++) {
        const payload = extractJson(await runOnce(promptForAttempt), extractOpts);
        const violation = contractViolation(opts.registry, sealTypes, payload);
        if (violation === undefined) return payload;
        lastViolation = violation;
        if (attempt >= MAX_CONTRACT_REPAIRS) {
          throw new ModelOutputContractError(a.slug, lastViolation, attempt + 1);
        }
        promptForAttempt = prompt + repairPromptAppendix(violation);
      }
    } finally {
      try { unlinkSync(cfgPath); } catch { /* best-effort cleanup */ }
    }
  };
}

// Spawn a child and stream its stdout line-by-line. Each complete line is parsed as a
// stream-json event and forwarded (granularly) to onEvent as it arrives — this is the
// agent-layer observability seam. Returns the full stdout on clean exit; rejects on
// non-zero exit (with stderr), timeout (SIGKILL, so a signal-trapping child can't survive),
// or cancellation via `signal` (SIGTERM → grace → SIGKILL).
//
// The child is REGISTERED in LIVE_CHAIR_CHILDREN for its whole lifetime (#250/#252): a handle
// nothing holds is a process nothing can stop.
function spawnStreaming(
  bin: string,
  args: readonly string[],
  bounds: SpawnBounds,
  onEvent?: (ev: AgentStreamEvent) => void,
  signal?: AbortSignal | undefined,
  abortGraceMs: number = DEFAULT_ABORT_GRACE_MS,
  /** The prompt, when it is too large for the command line. Written to the child's stdin. */
  stdinPayload?: string | undefined,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`chair child not spawned — gig aborted (${abortReasonText(signal)})`));
      return;
    }
    // stdin is a pipe ONLY when a payload is going down it. Leaving it open otherwise would
    // change the child's TTY detection for every existing caller.
    const stdio: ["ignore" | "pipe", "pipe", "pipe"] =
      [stdinPayload === undefined ? "ignore" : "pipe", "pipe", "pipe"];
    const child = spawn(bin, [...args], { stdio });
    // Slots 1 and 2 are literally "pipe" above, so both streams exist. Only slot 0 varies,
    // and widening it costs the compiler the overload that proved this.
    const childOut = child.stdout!;
    const childErr = child.stderr!;
    if (stdinPayload !== undefined) {
      // Close after writing: the CLI reads the prompt until EOF, so a stdin left open hangs
      // the child forever — a timeout rather than an answer, which is the failure this change
      // exists to remove.
      child.stdin?.on("error", () => { /* EPIPE if the child died first; the exit path reports it */ });
      child.stdin?.end(stdinPayload, "utf8");
    }
    LIVE_CHAIR_CHILDREN.add(child);
    let stdout = "";
    let stderr = "";
    let buf = "";
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const release = (): void => {
      if (timer) clearTimeout(timer);
      LIVE_CHAIR_CHILDREN.delete(child);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    };
    if (signal) {
      onAbort = () => {
        const reason = abortReasonText(signal);
        terminateChild(child, abortGraceMs);
        release();
        reject(new Error(`chair child aborted: ${reason}`));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => {
      child.kill(bounds.killSignal);
      release();
      reject(new Error(`chair child timed out after ${bounds.timeout}ms (${bounds.killSignal})`));
    }, bounds.timeout);
    const forwardLine = (line: string): void => {
      if (!line || !onEvent) return;
      try { forwardStreamEvent(JSON.parse(line), onEvent); } catch { /* non-json line */ }
    };
    childOut.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      stdout += s;
      buf += s;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        forwardLine(line);
      }
    });
    childErr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (e) => { release(); reject(e); });
    child.on("close", (code) => {
      // #250/#252 — release() subsumes the old clearTimeout: it also deregisters the child
      // from LIVE_CHAIR_CHILDREN and drops the abort listener. It runs FIRST so a throwing
      // onEvent in the flush below cannot leak the registration or the timer.
      release();
      // #224 — the read loop only drains on "\n", so a final line with no trailing newline
      // was never forwarded. The usage sink (runtime.ts makeUsageSink) reads total_cost_usd
      // ONLY from result events, so that chair's spend silently vanished from GigResult.usage
      // and the per-chair jsonl lost its last event. finalText was unaffected (it re-splits
      // the whole stdout), which is exactly why it was silent: the run succeeded and only
      // the accounting was wrong. Flush before settling, on the failure path too — a chair
      // that failed still spent money.
      const tail = buf.trim();
      buf = "";
      forwardLine(tail);
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      else resolve(stdout);
    });
  });
}

// Map a child stream-json event to granular AgentStreamEvents. assistant content explodes
// into per-block tool_use / text events (so a monitor sees each tool call); result passes
// its text; everything else passes its type + raw.
function forwardStreamEvent(evt: Record<string, unknown>, onEvent: (ev: AgentStreamEvent) => void): void {
  const type = String(evt["type"] ?? "event");
  if (type === "assistant" && evt["message"] && typeof evt["message"] === "object") {
    const content = (evt["message"] as { content?: Array<Record<string, unknown>> }).content ?? [];
    for (const b of content) {
      const bt = String(b["type"] ?? "");
      if (bt === "tool_use") onEvent({ type: "tool_use", tool: String(b["name"] ?? ""), raw: b });
      else if (bt === "text") onEvent({ type: "assistant", text: String(b["text"] ?? ""), raw: b });
    }
    return;
  }
  if (type === "result") {
    onEvent({ type: "result", text: typeof evt["result"] === "string" ? (evt["result"] as string) : undefined, raw: evt });
    return;
  }
  onEvent({ type, raw: evt });
}

// The `type` values the CLI's stream-json actually emits (SDKMessage, sdk.d.ts:370). A line
// that merely PARSES as JSON is NOT a stream event — that conflation is #222: the model's own
// answer parses and carries no `type`, which flipped the old `parsedAny` flag and made the
// raw-stdout fallback unreachable for the very payload it existed to rescue.
const STREAM_EVENT_TYPES: ReadonlySet<string> = new Set([
  "assistant",
  "user",
  "result",
  "system",
  "stream_event",
]);

/**
 * What a stream-json stdout actually carried.
 *
 * PROVENANCE for the error fields (#223) — read from `@anthropic-ai/claude-code@2.0.9`
 * (`sdk.d.ts:313-339` for the SDKResultMessage union, plus the bundled emission sites in
 * `cli.js`). NOTE the `claude` on PATH here is the NATIVE binary 2.1.221, a different
 * build whose bundle was not read; re-verify against whichever build is actually spawned.
 *
 *  - `error_max_turns` / `error_during_execution` results carry **no `result` field** and
 *    emit **`is_error: false`**. So `typeof e.result === "string"` never fired, `result`
 *    stayed undefined, and the old `result ?? assistant.join("\n")` fell through to the
 *    model's partial reasoning. `subtype` is the required discriminator — `is_error`
 *    alone catches neither.
 *  - `is_error: true` DOES occur, on `subtype: "success"`, set from `isApiErrorMessage`;
 *    there `result` holds the API error text.
 *  - Print mode sets the exit code as `is_error ? 1 : 0`, so both error subtypes exit **0**
 *    and `spawnStreaming` resolves normally. The silent path is live, not dead risk.
 */
interface StreamOutcome {
  /** The text the extractor should parse. Empty when the stream carried no answer. */
  text: string;
  /** A non-success result subtype — the run did not complete. */
  errorSubtype?: string | undefined;
  /** A result the CLI flagged with is_error (rides on subtype "success"). */
  apiErrorText?: string | undefined;
}

/**
 * Pick the assistant text block that IS the answer.
 *
 * Concatenating every block across the run (the old behaviour) glues intermediate
 * reasoning in front of the answer, and the extractor then has to choose between the
 * reasoning's objects and the real one. Prefer the LAST block that is nothing but a JSON
 * object — that is precisely what buildPrompt asks for ("Respond with ONLY a single JSON
 * object — no prose, no code fence", :153), so such a block is the model complying, while
 * a block with chatter wrapped around an object is commentary. Falls back to the final
 * block when no block is a bare object (then the extractor's own policy decides).
 */
function answerBlock(blocks: readonly string[]): string {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = (blocks[i] ?? "").trim();
    if (b.startsWith("{") && b.endsWith("}")) {
      try {
        const v: unknown = JSON.parse(b);
        if (v && typeof v === "object" && !Array.isArray(v)) return b;
      } catch { /* not a bare object — keep looking */ }
    }
  }
  return blocks.length > 0 ? (blocks[blocks.length - 1] ?? "") : "";
}

/**
 * Read a stream-json stdout into the answer text (plus any error the CLI reported).
 * Falls back to the raw stdout when no recognized stream event appeared at all — the
 * plain `-p` shape the old `parsedAny` check claimed to handle and did not.
 */
function finalText(stdout: string): StreamOutcome {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  let result: string | undefined;
  let errorSubtype: string | undefined;
  let apiErrorText: string | undefined;
  const assistant: string[] = [];
  let sawStreamEvent = false;
  for (const l of lines) {
    let e: Record<string, unknown>;
    try { e = JSON.parse(l) as Record<string, unknown>; } catch { continue; /* non-json */ }
    const type = typeof e["type"] === "string" ? (e["type"] as string) : "";
    if (!STREAM_EVENT_TYPES.has(type)) continue;
    sawStreamEvent = true;
    if (type === "result") {
      const subtype = typeof e["subtype"] === "string" ? (e["subtype"] as string) : "";
      if (subtype !== "" && subtype !== "success") { errorSubtype = subtype; continue; }
      if (e["is_error"] === true) {
        apiErrorText = typeof e["result"] === "string" ? (e["result"] as string) : "";
        continue;
      }
      if (typeof e["result"] === "string") result = e["result"] as string;
    } else if (type === "assistant" && e["message"] && typeof e["message"] === "object") {
      const content = (e["message"] as { content?: Array<Record<string, unknown>> }).content ?? [];
      for (const b of content) if (b["type"] === "text") assistant.push(String(b["text"] ?? ""));
    }
  }
  if (errorSubtype !== undefined) return { text: "", errorSubtype };
  if (apiErrorText !== undefined) return { text: "", apiErrorText };
  if (!sawStreamEvent) return { text: stdout };
  // #222 — `""` IS a string, so `result ?? assistant.join("\n")` returned the empty result
  // and beat real assistant text. Nullish coalescing was the bug; emptiness is the test.
  if (result !== undefined && result.trim() !== "") return { text: result };
  return { text: answerBlock(assistant) };
}
