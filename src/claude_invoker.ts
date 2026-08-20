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
import { resolveAgentGrants, hostBuiltinDenials, toolBaseName, ENGINE_MCP_SERVER, type ToolProviderRegistry } from "./tool_providers.js";
import { venueEffectiveTools } from "./chart.js";
import { CORE_TYPES } from "./core_types.js";

const EMPTY_TOOL_REGISTRY: ToolProviderRegistry = new Map();

/** The tool name a chair's in-band `output_write` seal is advertised under in the spawn. */
const OUTPUT_WRITE_TOOL = `mcp__${ENGINE_MCP_SERVER}__output_write`;

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

// The code tools code_tool_access affirmatively KEEPS available — the inverse of codeToolDenials over
// the four CODE_TOOLS. This is the allow signal the host-builtin complement must respect: those four
// tools are governed by the code_tool_access LADDER, so the complement must not re-deny one the access
// level grants (a "full" agent keeps Read/Write/Edit/Bash even when it lists none in allowed_tools —
// host builtins are allowed-by-default and code_tool_access is their deny layer).
//
// UNSET is distinct from "full": an agent that declares NO code access and grants no code tool keeps
// NONE — that is what lets the ceiling bind on the default agent (gig 782e89d8, room-prober had no
// code_tool_access yet reached Bash and Read). codeToolDenials returns [] for unset, so it cannot
// carry this distinction; this function does.
function codeToolsKept(access: CodeToolAccess | undefined): string[] {
  if (access === undefined) return [];
  const denied = new Set(codeToolDenials(access));
  return CODE_TOOLS.filter((t) => !denied.has(t));
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

/**
 * When set, the Task layer tells the chair to seal each output IN-BAND by calling `output_write`
 * (the write-boundary tool) rather than printing final-text JSON for the invoker to parse. The
 * tool runs the full seal predicate and returns its verdict in-band, so the agent self-corrects
 * within its own single run — there is no invoker re-prompt. Absent → the legacy text-seal Task
 * (unchanged, so every buildPrompt fixture stays stable).
 */
export interface OutputWriteSeal {
  via: "output_write";
  gig_id: string;
  agent_slug: string;
  phase: string;
  /** domain_type slug → its core_type, so the agent passes the right `core_type` to output_write. */
  core_by_type: Record<string, string>;
}

export function buildPrompt(
  ctx: AgentInvocationContext,
  outputSchema?: Record<string, unknown>,
  // Per-type schemas for a MULTI-output agent (slug → schema). When the agent declares
  // more than one output type, the Task layer asks for a blob keyed by type rather than a
  // single object — the runtime then seals one record per key.
  outputSchemas?: Record<string, Record<string, unknown> | undefined>,
  seal?: OutputWriteSeal,
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
        // THE FILLED SLOTS. A skill declares `hydration` slots; the institution fills the
        // institution-bound ones at SEAT time (the chair's `supplies`, arriving as ctx.hydration) and
        // the gig fills the gig-bound ones at DISPATCH time (the run's own payload). Until this
        // rendered, both were validated and then discarded — a skill instructing its agent to "read
        // the constraints supplied in the `house-style` slot" found nothing there, on every run.
        //
        // Only slots the skill DECLARES are rendered. A chair that supplies a key no skill declares
        // is supplying nothing, and must not get a free channel into the prompt through it.
        const slots = (s as { hydration?: Record<string, { binding?: string }> }).hydration ?? {};
        const slotLines = Object.entries(slots).map(([name, spec]) => {
          const fromSeat = (ctx.hydration ?? {})[name];
          const fromGig = (ctx.gig_input ?? {})[name];
          const value = (spec?.binding ?? "institution") === "gig" ? fromGig : fromSeat;
          if (value === undefined) {
            // Named as unfilled rather than omitted. A skill cannot follow its own rule for an
            // unfilled slot if the prompt does not say which slots are empty — and silence here is
            // exactly what let a severed wire read as an optional input.
            return `- \`${name}\`: (unfilled — no value supplied)`;
          }
          return `- \`${name}\`: ${typeof value === "string" ? value : JSON.stringify(value)}`;
        });
        const slotBlock = slotLines.length > 0 ? `\n\n### Supplied\n${slotLines.join("\n")}` : "";
        return `## ${s.slug}${text ? `\n${text}` : ""}${slotBlock}`;
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
  if (seal) {
    // IN-BAND WRITE-BOUNDARY SEAL. Each output is sealed by an `output_write` call whose payload
    // the engine adjudicates against the FULL contract; a rejection returns in-band and the agent
    // fixes `data` and calls again — its own single run self-corrects, no invoker re-prompt.
    const perType = sealTypes
      .map((t) => {
        const s = outputSchemas?.[t] ?? (sealTypes.length === 1 ? outputSchema : undefined);
        const core = seal.core_by_type[t] ?? "";
        return (
          `- output_write({ "core_type": "${core}", "domain_type": "${t}", ` +
          `"gig_id": "${seal.gig_id}", "phase": "${seal.phase}", "agent_slug": "${seal.agent_slug}", ` +
          `"data": <object${s ? ` matching ${JSON.stringify(s)}` : ""}> })`
        );
      })
      .join("\n");
    layers.push(
      `# Task\nSeal each of your output types by calling the \`output_write\` tool — one call per type:\n${perType}\n\n` +
        `The tool validates your \`data\` against the complete output contract and returns ` +
        `\`{ ok: false, error }\` if it does not pass. When that happens, read the error, correct the ` +
        `\`data\`, and call \`output_write\` again — repeat until it returns \`ok: true\`. The successful ` +
        `call IS the seal; do NOT print the output as text, and do not stop until every type is sealed.`,
    );
  } else if (sealTypes.length > 1) {
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
 * A chair completed its run but sealed NONE of its promised outputs through `output_write`.
 * Distinct from ModelOutputParseError (a text-seal chair that emitted no parseable answer): this
 * is the output_write-seal path, where the boundary that adjudicates a payload against its full
 * output contract is the chair's own in-band `output_write` call (validated by the engine's
 * checkWritable, corrected in-band by the agent), NOT a re-prompt from this invoker. A chair that
 * never gets a single write past that boundary produced nothing this invoker can hand back.
 *
 * The runtime's own floor check (executeChair, `missingRequired`) also catches a shortfall and is
 * the authority on which promised types were merely optional; this error is the earlier, chair-
 * local signal that the write boundary sealed nothing at all.
 */
/** Turns given to a channel repair. It needs to make a tool call it already has the answer for —
 *  enough to seal each promised type and stop, not enough to restart the work. */
const SEAL_REPAIR_TURNS = 4;

export class ModelOutputContractError extends Error {
  readonly slug: string;
  readonly reason: string;
  constructor(slug: string, reason: string) {
    super(`chair "${slug}" sealed no output through its write boundary: ${reason}`);
    this.name = "ModelOutputContractError";
    this.slug = slug;
    this.reason = reason;
  }
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

// ───────────────────── output_write capture (the write-boundary seal path) ─────────────────────
//
// A model chair on the output_write-seal path does NOT print a final-text answer — it SEALS each
// output in-band by calling `output_write`, whose payload the engine adjudicates against the full
// contract (validate-mode, returning the verdict in-band so the agent self-corrects). This reads
// those calls back out of the child's stream-json stdout: the payload of each SUCCESSFUL
// output_write call (a tool_use whose tool_result was not an error) is what the chair sealed, and
// the runtime's own boundary seals it exactly once. Because the agent corrects a rejected write by
// calling again, the LAST non-errored call per type is the one that passed.

/** The name a chair's `output_write` grant is advertised under in the spawn (mcp__<server>__<tool>),
 *  plus the bare slug for a legacy pass-through invoker. Matched by suffix so either resolves. */
function isOutputWriteToolName(name: string): boolean {
  return name === "output_write" || name.endsWith("__output_write");
}

/**
 * Did the chair ever ATTEMPT the write boundary — a call that was made, whether or not it passed?
 *
 * This is the line between two failures that look identical in the blob and are not the same defect:
 *   · ATTEMPTED and rejected → the in-band loop DID engage. The engine told the agent what was wrong
 *     and it gave up anyway. Re-prompting that is the bounded repair loop the governor rejected
 *     twice (tests/output_write_boundary.test.ts) — the agent already had its correction.
 *   · NEVER ATTEMPTED → the loop never engaged, because the agent never knocked. It produced its
 *     answer as text or a file and finished. There was no in-band frame in which to correct it.
 * Only the second is repairable, and only that one is repaired.
 */
function attemptedWriteBoundary(stdout: string): boolean {
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const type = typeof e["type"] === "string" ? (e["type"] as string) : "";
    const msg = e["message"];
    if ((type === "assistant" || type === "user") && msg && typeof msg === "object") {
      const content = (msg as { content?: Array<Record<string, unknown>> }).content ?? [];
      for (const b of content) {
        if (String(b["type"] ?? "") === "tool_use" && isOutputWriteToolName(String(b["name"] ?? ""))) return true;
      }
    }
  }
  return false;
}

/**
 * Extract the chair's sealed payloads from a stream-json stdout, keyed by the chair's seal types.
 * Returns the blob shape the runtime already consumes (a key per domain_type, or the bare data for
 * a lone single-output write), so executeChair seals it through its one boundary unchanged.
 */
/** A child that exited non-zero, carrying the stdout it produced before dying.
 *
 *  The stream is not incidental to the error — for a chair stopped by its tool budget it holds
 *  validated payloads, and discarding it destroys work the engine had already adjudicated as good.
 *  Exported because the injected-run seam (`opts.run`) is how tests reproduce a non-zero exit. */
export class ChildExitError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
  ) {
    super(message);
    this.name = "ChildExitError";
  }
}

/** The result subtype the CLI reports when `--max-turns` cut the run off.
 *
 *  This is the ONE non-success subtype whose stream is still worth reading, and the distinction is
 *  the whole of the policy: a budget stop says "the agent was interrupted", while every other error
 *  subtype says "what the agent produced is unreliable". Writes survive the first and must not
 *  survive the second. */
const BUDGET_STOP_SUBTYPE = "error_max_turns";

/** Rewrite `--max-turns` to the reserve. The continuation gets the EXTENSION as its whole budget,
 *  not a second full allowance — otherwise the grant silently doubles the chair's cost ceiling. */
function withMaxTurns(args: readonly string[], turns: number): string[] {
  const out = [...args];
  const i = out.indexOf("--max-turns");
  if (i >= 0 && i + 1 < out.length) out[i + 1] = String(turns);
  else out.push("--max-turns", String(turns));
  return out;
}

/** Swap the prompt a built arg list carries.
 *
 *  `-p` is a boolean flag with the prompt as a POSITIONAL that follows it — except on the
 *  large-prompt path, where the positional is dropped and the text goes to stdin instead. A
 *  continuation has to replace whichever form is in play, and the two are not interchangeable:
 *  editing only the stdin text would re-send the ORIGINAL prompt to a small-prompt chair, which
 *  reads as the engine ignoring its own grant. */
function withPrompt(args: readonly string[], prompt: string): string[] {
  const out = [...args];
  const i = out.indexOf("-p");
  if (i < 0) return out;
  const positionalFollows = i + 1 < out.length && !out[i + 1]!.startsWith("-");
  if (positionalFollows) out[i + 1] = prompt;
  return out;
}

// The bound on how many records ONE chair may seal for ONE declared output type. The seal path
// carries its own stated cap so the ledger guarantee is self-contained and auditable independently
// of the invocation-layer `max_tool_calls` (which is owned by a different layer and can change
// without the seal path knowing).
//
// The evidence and the choice: gig 8baced9d (lineage-deepen-v0, chair identify-external) made 15
// accepted output_write calls and sealed 1 — the observed cardinality of a legitimate high-gather
// chair is 15. The cap sits well above it (>4x headroom) so real gathering is never refused, and
// stays FINITE so a runaway seat cannot write unbounded records — an unbounded seal path is a
// denial-of-service on the ledger. Tune here, at the single declaration site, if real runs exceed
// the headroom; the (cap+1)th same-type write is refused loudly (a throw the gig surfaces), never
// dropped silently — a silent drop is exactly the "ok for a discarded record" lie this closes.
export const MAX_SEALED_RECORDS_PER_TYPE = 64;

export function captureOutputWrites(
  stdout: string,
  sealTypes: readonly string[],
): Record<string, unknown[]> {
  interface Write { id: string; domain_type: string; data: unknown; }
  const writes: Write[] = [];
  const errored = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const type = typeof e["type"] === "string" ? (e["type"] as string) : "";
    const msg = e["message"];
    if ((type === "assistant" || type === "user") && msg && typeof msg === "object") {
      const content = (msg as { content?: Array<Record<string, unknown>> }).content ?? [];
      for (const b of content) {
        const bt = String(b["type"] ?? "");
        if (bt === "tool_use" && isOutputWriteToolName(String(b["name"] ?? ""))) {
          const input = (b["input"] && typeof b["input"] === "object" ? b["input"] : {}) as Record<string, unknown>;
          writes.push({ id: String(b["id"] ?? ""), domain_type: String(input["domain_type"] ?? ""), data: input["data"] });
        } else if (bt === "tool_result" && b["is_error"] === true) {
          errored.add(String(b["tool_use_id"] ?? ""));
        }
      }
    }
  }
  const passed = writes.filter((w) => !w.id || !errored.has(w.id));
  // Accumulate a LIST per type — a chair may seal MANY records of one declared type (a lineage
  // scout's whole job is gathering many external hits). The old code did `byType.set(type, data)`,
  // a last-wins overwrite that kept one record and discarded the rest while every call had already
  // returned ok — the discard the change request measured. Every accepted write is now kept, up to
  // the stated cap, above which the surplus is refused loudly rather than dropped.
  const refuse = (t: string): never => {
    throw new Error(
      `chair sealed more than MAX_SEALED_RECORDS_PER_TYPE (${MAX_SEALED_RECORDS_PER_TYPE}) records ` +
        `of type "${t}" — refusing the surplus loudly. A record is being written that no seat could ` +
        `be honestly told was kept; raise MAX_SEALED_RECORDS_PER_TYPE at its declaration site if a ` +
        `real run legitimately gathers this many.`,
    );
  };
  const byType = new Map<string, unknown[]>();
  for (const w of passed) {
    const list = byType.get(w.domain_type) ?? [];
    if (list.length >= MAX_SEALED_RECORDS_PER_TYPE) refuse(w.domain_type);
    list.push(w.data);
    byType.set(w.domain_type, list);
  }
  const blob: Record<string, unknown[]> = {};
  for (const t of sealTypes) {
    if (byType.has(t)) blob[t] = byType.get(t)!;
  }
  // Single-output chairs may seal with an empty/other domain_type (buildPrompt names it, but a
  // model can still omit it). If nothing matched by name and outputs were sealed, those payloads
  // ARE the single output — key the FULL list under the promised type (carrying every one, not just
  // the last, so this branch does not silently collapse the way the whole path used to).
  if (sealTypes.length === 1 && blob[sealTypes[0]!] === undefined && passed.length > 0) {
    if (passed.length > MAX_SEALED_RECORDS_PER_TYPE) refuse(sealTypes[0]!);
    blob[sealTypes[0]!] = passed.map((w) => w.data);
  }
  return blob;
}

// The wall-clock bound on one chair's spawn. A tool-granted child has no inherent
// terminus (it can search/loop), and the gig runs the spawn synchronously — so without
// this bound one wedged child wedges the whole server. SIGKILL, not SIGTERM: a
// signal-trapping child can't outlive its budget. Long enough for a tool-using chair
// (a capped search agent runs minutes), far below an operator-visible hang.
//
// RAISED FROM TEN MINUTES, from measurement rather than preference. A reading seat over a
// 1000-line specification and its test suite was killed here twice, both times mid
// `output_write` — the bound was cutting the WRITE, not the reading, and the two sibling seats
// that survived cleared it by 57s and 85s. A seat that dies at the wall seals nothing and, worse,
// reports no usage, so the spend is real and the ledger never sees it. Ten minutes was under the
// honest cost of a chair that reads a corpus and then writes a structured document about it.
//
// Twenty and not more: `tests/invoker_timeout.test.ts` fences this value between five and twenty
// minutes on the argument that the default must stay "far below an operator-visible hang", and
// that band is a deliberate guard rather than an accident. This sits at its ceiling. A deployment
// that genuinely needs longer has the per-chair override (`COLTRANE_CHAIR_TIMEOUT_MS`) and does
// not need the shipped default moved. Note the cost of raising it: `src/runtime.ts:1135` observes
// that a standard with P sequential phases can burn P x this value after `gig_abort` returns, so
// doubling the bound doubles that worst-case drag.
export const DEFAULT_CHAIR_TIMEOUT_MS = 20 * 60_000;

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
  /**
   * Turns granted ONCE, as a reserve, to a chair that exhausted its declared turn budget.
   *
   * `--max-turns` is a hard CLI bound with no callback, so without this a chair learns its budget
   * only by dying at it — cut off mid-reach, before it can write the boundary record that says what
   * it did NOT get to. The reserve turns that silent truncation into a stated one: the chair is told
   * it is in reserve, how many turns remain, and what it already sealed, and is asked to close out.
   *
   * It cannot be delivered in-band. A chair's tools are typically HOST tools (WebSearch, WebFetch)
   * that the child's own coltrane server never sees, so the engine surface cannot count turns. The
   * parent sees every turn in the stream, and its only channel into a running child is a new
   * invocation — hence a continuation rather than a signal.
   *
   * ONE extension, never a loop: an unbounded "just a bit more" is not a budget. Unset = the prior
   * behaviour exactly (keep whatever passed the write boundary, grant nothing).
   */
  turn_reserve?: number | undefined;
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
  // Injectable spawn (tests). The venue → dispatch wire feeds the constructed child env as the 4th
  // argument; a venue-less dispatch passes `undefined` (the child inherits the ambient env).
  run?: ((bin: string, args: string[], spawn: SpawnBounds, env?: Record<string, string>) => string | Promise<string>) | undefined;
  // Per-deployment override of the per-chair wall-clock bound.
  timeout_ms?: number | undefined;
  // Grace between SIGTERM and SIGKILL when a chair is cancelled. Override in tests.
  abort_grace_ms?: number | undefined;
  // When set, the spawned child receives COLTRANE_PARENT_SESSION_ID so its first
  // recorded turn seals the lineage edge to its parent.
  parent_session_id?: string | undefined;
  /**
   * How a model chair produces its sealed output.
   *  - "output_write" (production): the chair SEALS IN-BAND by calling `output_write` during its
   *    run. The spawn advertises `mcp__coltrane__output_write` and its coltrane server runs in
   *    validate-mode (COLTRANE_OUTPUT_WRITE_MODE=validate), so each call adjudicates the payload
   *    against the FULL seal predicate and returns the verdict in-band — the agent self-corrects
   *    within its single run. The invoker captures the validated payload from the chair's
   *    successful output_write calls; the runtime (executeChair) is the ONE sealer.
   *  - "text" (default, and every injected-run test): the chair prints final-text JSON, which the
   *    invoker extracts and hands back for the runtime to seal at its boundary. Unchanged legacy
   *    behaviour, so a bare/test invoker is unaffected.
   */
  sealVia?: "text" | "output_write" | undefined;
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
  // The OTHER half of that floor, and it was missing. A seat's cwd is a freshly cloned repository
  // (drain-loop.sh clones per gig and runs the engine inside it), so anything the repo carries is
  // untrusted input. Verified against the CLI rather than assumed:
  //
  //   .claude/settings.json  hooks EXECUTE — arbitrary commands, no model in the loop
  //   CLAUDE.md              is obeyed — repo text becomes instructions in the seat's context
  //
  // Both are real today and both stop with `--setting-sources user`, confirmed by running it.
  //
  // `user` and not `user,project`: project settings are exactly the untrusted half. Coltrane loses
  // nothing by excluding them — an agent's identity, method and constraints come from the GENOME,
  // loaded from the store, never from a file in the working tree. A repo that could redefine the
  // agent reading it would be editing the genome through the back door.
  //
  // This is what makes one gig's write to a repo stop being every later gig's execution.
  args.push("--setting-sources", "user");
  if (opts.allowed_tools && opts.allowed_tools.length > 0) args.push("--allowedTools", opts.allowed_tools.join(","));
  if (opts.disallowed_tools && opts.disallowed_tools.length > 0) args.push("--disallowedTools", opts.disallowed_tools.join(","));
  return args;
}

// The production AgentInvoker. Writes a per-gig mcp-config (the permitted servers only),
// spawns `claude -p` inside the cage, parses the JSON. The spawn is the non-deterministic
// seam (inject `run` to test the cage args + parse without the CLI). When a
// parent_session_id is provided, every spawned MCP server in this child receives it via
// env so the recorder seals the parent → child lineage edge on the child's first turn.
/**
 * Names a seat must never see, whatever else it inherits.
 *
 * A DENY-list, deliberately, even though deny-lists are the weaker construction — the allowlist in
 * `SeatRealization.env` is the real control and this exists only for the paths that do not reach
 * it. A floor is worth having precisely because it protects the case nobody remembered to declare.
 *
 * The rule for adding a name: would possession of this let the holder act AS THE BOX, rather than
 * as the work the box was given? `COLTRANE_DRAIN_KEY` is the clearest case — it is the venue's
 * whole identity. `CLAUDE_CODE_OAUTH_TOKEN` deliberately is NOT here: a seat is a `claude -p`
 * process and that is how it authenticates to run at all.
 */
const BOX_CREDENTIAL_ENV = [
  "COLTRANE_DRAIN_KEY",        // the venue's identity: claims gigs, reads the org's whole Vault
  "COLTRANE_DRAIN_URL",        // paired with it; together they are the provisioning endpoint
  "COLTRANE_PROVISIONER_KEY",  // mints drain keys — strictly more authority than the drain key
  "SUPABASE_SERVICE_ROLE_KEY", // bypasses RLS entirely
  "SUPABASE_SECRET_KEY",
  "FLY_API_TOKEN",             // creates and destroys machines
  "GITHUB_APP_PRIVATE_KEY_B64",
] as const;

/** Everything except the box's own credentials. Returns a plain object, so the spawn is given an
 *  explicit environment rather than inheriting one — the difference matters when a new secret is
 *  added to the container and nobody revisits this file. */
export function withoutBoxCredentials(env: NodeJS.ProcessEnv): Record<string, string> {
  const denied = new Set<string>(BOX_CREDENTIAL_ENV);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (denied.has(k)) continue;
    out[k] = v;
  }
  return out;
}

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
  const sealViaOutputWrite = opts.sealVia === "output_write";
  // A reserve is a grant, so an absent or nonsensical one grants nothing rather than defaulting to
  // some house number — an extension the author did not ask for is spend they did not authorise.
  // #turn-budget — resolved PER INVOCATION so the chair-scoped reserve (ctx.turn_reserve, the pool-
  // capped offer the runtime threads) wins over the invoker-level default (opts.turn_reserve). Both
  // pass through the identical > 0 floor. ctx.turn_reserve === 0 (a declared chair whose pool was
  // dry) is a hard zero, NOT a fall-through to opts — 0 is not nullish, so `??` stops there.
  const resolveReserveTurns = (ctxReserve: number | undefined): number => {
    const src = ctxReserve ?? opts.turn_reserve;
    return Number.isFinite(src) && (src ?? 0) > 0 ? Math.floor(src!) : 0;
  };
  // The core type each domain type extends — the `core_type` the agent must pass to output_write.
  const coreTypeOf = (slug: string): string => {
    if ((CORE_TYPES as readonly string[]).includes(slug)) return slug;
    const dt = opts.registry?.listTypes().find((t) => t.slug === slug);
    return dt ? dt.extends : "";
  };
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
    // VENUE CONFINEMENT BY CONSTRUCTION. When the dispatch path resolved a room for this chair
    // (ctx.realization + ctx.venue both threaded by runGig), the spawn reflects the realization:
    //  - `--allowedTools` carries venueEffectiveTools(agent, venue) — the SAME shared oracle the
    //    compose-time R10 check refuses against (src/chart.ts), never a re-inlined intersection and
    //    never the un-intersected grant, so runtime enforcement and compose-time refusal cannot
    //    drift — with each surviving grant RESOLVED to the name its server advertises (#204). The
    //    intersection is unchanged; only the advertised name is (narrow-then-rename, never widen).
    //  - the child env is the realization's deny-by-default allowlist (SeatRealization.env, `{}` when
    //    the surface admits nothing), so an undeclared ambient credential never reaches the child.
    // Narrowed BEFORE the in-band-seal block below, so the engine's own output_write grant — engine
    // mechanism, not an optional capability — is re-added on top of the room's ceiling. Absent on
    // either field → the un-narrowed path above stands and no child env is constructed (INV10).
    let childEnv: Record<string, string> | undefined;
    if (ctx.realization && ctx.venue) {
      // NARROW then RENAME. venueEffectiveTools is the shared oracle R10 refuses against; it returns
      // the agent's RAW grant strings intersected with the room's equipment — so the CEILING decision
      // stays on raw grants and cannot drift from the compose-time check. But those raw strings are
      // still bare in-house slugs; advertising them un-resolved reopens #204 (a seat granting bare
      // `type_browse` advertises `type_browse` while the engine server advertises
      // `mcp__coltrane__type_browse`, so the call is DENIED — measured, gig 11744aa5). Resolve the
      // ALREADY-NARROWED list so only the ADVERTISED name changes; the intersection is untouched, so
      // the ceiling narrows, it never widens. Resolution off → keep the raw narrowed list (INV1/INV10).
      const narrowed = venueEffectiveTools(ctx.agent, ctx.venue);
      effectiveAllowed = resolutionEnabled
        ? resolveAgentGrants(
            { ...ctx.agent, allowed_tools: narrowed },
            opts.toolProviders ?? EMPTY_TOOL_REGISTRY,
            opts.mcpServerConfigs ?? {},
          ).effectiveAllowed
        : narrowed;
      const seat = ctx.realization.seats.find((s) => s.agent_slug === ctx.agent.slug);
      childEnv = seat?.env ?? {};
    } else {
      // THE FLOOR BENEATH THE ALLOWLIST. Above is deny-by-default and is the right answer — but it
      // only engages when a gig names a venue, and the drain names none (worker.ts passes no
      // `venue` to runGig). So on the live path every seat inherited process.env WHOLESALE.
      //
      // On a Fly drain that env holds COLTRANE_DRAIN_KEY, because Fly surfaces secrets to the whole
      // container and start.sh filters only the vault half. Seats are `claude -p` with Bash. So
      // `env | grep COLTRANE_DRAIN_KEY` from inside any seat yields the credential that IS the box:
      // it reads the org's entire Vault through coltrane_venue_provision, and under the proposed
      // git-credential design it would mint GitHub tokens too.
      //
      // That makes "the drain presents its key" mean "anything running inside the drain presents
      // its key" — which is not an authenticator at all. Stripping here does not fix the
      // authenticator, but it removes the credential from the reach of the untrusted thing.
      childEnv = withoutBoxCredentials(process.env);
    }
    // WIRE THE IN-BAND SEAL. A model chair on the output_write-seal path must be able to CALL
    // output_write regardless of what it declared in allowed_tools — the seal is engine mechanism,
    // not an optional capability. Bridge the engine's own MCP server into the spawn and add the
    // output_write grant so the child can reach it. Gated on the engine server config being wired
    // (bootstrapServerDeps always supplies it); a bare/test invoker without it captures from the
    // injected stream instead of a real spawn, so it needs no grant.
    const engineServerCfg = (opts.mcpServerConfigs ?? {})[ENGINE_MCP_SERVER];
    if (sealViaOutputWrite && engineServerCfg !== undefined) {
      resolvedMcpServers = { ...resolvedMcpServers, [ENGINE_MCP_SERVER]: engineServerCfg };
      effectiveAllowed = [...new Set([...(effectiveAllowed ?? []), OUTPUT_WRITE_TOOL])];
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
    // The in-band seal directive: present only when this invoker seals via output_write AND the
    // runtime threaded a gig_id (the write needs it). Absent → the legacy text-seal Task layer.
    const seal: OutputWriteSeal | undefined = sealViaOutputWrite && ctx.gig_id
      ? {
          via: "output_write",
          gig_id: ctx.gig_id,
          agent_slug: ctx.agent.slug,
          phase: ctx.phase,
          core_by_type: Object.fromEntries(sealTypes.map((t) => [t, coreTypeOf(t)])),
        }
      : undefined;
    const prompt = buildPrompt(ctx, schema, outputSchemas, seal);
    // #221 — the key signal for candidate selection, derived from what we just resolved.
    // Threaded into BOTH extract calls below; threading only the injected-run one would
    // leave every real chair unscored.
    const extractOpts = extractOptionsForChair(sealTypes, schema);
    // per-gig mcp-config: only the deployment-permitted servers (empty by default).
    const cfgPath = join(tmpdir(), `coltrane-mcp-${randomUUID()}.json`);
    // the base map (opts.mcpServers) + the per-agent servers its grants resolved to (#185) + the
    // SUBSTRATE transports the room was realized on (ctx.substrateMcpConfigs). The room's servers
    // come last so a realized docker-exec transport for a venue's declared server wins over any
    // grant-resolved entry of the same slug — the spawn reaches the server running INSIDE the room,
    // not merely the policy layer. Absent substrate = the prior two-way merge exactly.
    const servers = { ...(opts.mcpServers ?? {}), ...resolvedMcpServers, ...(ctx.substrateMcpConfigs ?? {}) };
    const parent = opts.parent_session_id;
    // Per-server env additions: parent_session_id into every server (so children seal lineage), and
    // COLTRANE_OUTPUT_WRITE_MODE=validate into the ENGINE server on the output_write-seal path — so
    // the child's coltrane server ADJUDICATES the chair's in-band output_write calls against the
    // full seal predicate and returns the verdict, without persisting (the runtime is the one
    // sealer, so this is what keeps the output sealed exactly once).
    const envFor = (name: string): Record<string, unknown> => ({
      ...(parent ? { COLTRANE_PARENT_SESSION_ID: parent } : {}),
      ...(sealViaOutputWrite && name === ENGINE_MCP_SERVER ? { COLTRANE_OUTPUT_WRITE_MODE: "validate" } : {}),
    });
    const enriched = Object.fromEntries(
      Object.entries(servers).map(([name, def]) => {
        const additions = envFor(name);
        if (Object.keys(additions).length === 0) return [name, def];
        const d = (def && typeof def === "object" ? def : {}) as Record<string, unknown>;
        const env = (d["env"] && typeof d["env"] === "object" ? d["env"] : {}) as Record<string, unknown>;
        return [name, { ...d, env: { ...env, ...additions } }];
      }),
    );
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: enriched }));
    try {
      const a = ctx.agent;
      // #turn-budget — the reserve the invoker will grant on a budget stop, chair-scoped first.
      const reserveTurns = resolveReserveTurns(ctx.turn_reserve);
      // #237 — a shallow run depth tightens the turn cap; it never widens the agent's own.
      const depthCap = ctx.depth ? DEPTH_MAX_TOOL_CALLS[ctx.depth] : undefined;
      // #turn-budget — resolve chair > agent > engine default, THEN let a shallow depth cap tighten
      // (never widen). `ctx.turn_budget === 0` is a deliberate hard floor and does NOT fall through
      // (0 is not nullish); absent falls to the agent's own cap, then the CLI default (undefined →
      // no --max-turns emitted at all).
      const resolvedBudget = ctx.turn_budget ?? a.max_tool_calls;
      const maxToolCalls = depthCap === undefined
        ? resolvedBudget
        : Math.min(depthCap, resolvedBudget ?? depthCap);
      // Run ONE invocation and return the child's raw stdout. Custom run (tests): the returned
      // string IS the transcript (a bare JSON blob on the text path, a stream-json transcript on
      // the output_write path). Default: stream-json so the child's tool calls / reasoning are
      // observable LIVE, teed to ctx.onEvent.
      // THE TOOL CEILING BINDS BY ENFORCEMENT, not omission. `--allowedTools` does NOT remove a host
      // builtin — a seat granted only `type_browse` still called Bash and Read, unrefused and
      // unrecorded (gig 782e89d8, room-prober, twice) — so the deny list must ENUMERATE what the seat
      // may not hold. Synthesize it from the EXISTING oracles (hostBuiltinDenials over HOST_BUILTINS;
      // venueEffectiveTools for the room ceiling), never a re-inlined universe/intersection.
      //
      // Computed HERE, AFTER OUTPUT_WRITE_TOOL joined effectiveAllowed (see the seal-wire block above):
      // synthesizing before that addition would deny every model chair the very tool it must call to
      // seal, failing every gig at the last step (asserted by LAW 2).
      //
      // The complement is scored against effectiveAllowed PLUS the code tools code_tool_access keeps:
      // those four are governed by the code_tool_access ladder (codeToolDenials), so the complement
      // must not re-deny a code tool the agent's access grants.
      const allowForComplement = [...(effectiveAllowed ?? []), ...codeToolsKept(a.code_tool_access)];
      // (d) VENUE CEILING BY DENIAL: a tool the agent grants but the room's equipment excludes.
      // venueEffectiveTools is the SAME shared oracle compose-time R10 refuses against (INV9) — never a
      // re-inlined intersection — so the room narrows by enforcement, not only by the omission from
      // --allowedTools that cannot bind. Absent a room, nothing is venue-excluded.
      const venueExcluded = ctx.realization && ctx.venue
        ? (() => {
            const kept = new Set(venueEffectiveTools(a, ctx.venue!));
            return (a.allowed_tools ?? []).filter((g) => !kept.has(g));
          })()
        : [];
      // The UNION, preserving the agent's OWN declared denials (never replaced): (a) declared
      // disallowed_tools, (b) the code_tool_access ladder, (c) the host-builtin complement, (d) the
      // venue-excluded grants.
      const denyUnion = [
        ...(a.disallowed_tools ?? []),
        ...codeToolDenials(a.code_tool_access),
        ...hostBuiltinDenials(allowForComplement),
        ...venueExcluded,
      ];
      // NO OVER-DENIAL (LAW 5, and LAW 2's structural half): nothing the seat legitimately holds may be
      // denied — most sharply OUTPUT_WRITE_TOOL, which effectiveAllowed now carries on the seal path.
      // Subtract the effective allow set — by exact name AND base name, so a scoped grant like
      // `Bash(npx …)` still protects its `Bash` — then dedupe. code_tool_access-kept tools are NOT
      // subtracted here: a venue that excludes a code tool must still deny it even under access "full".
      const allowExact = new Set(effectiveAllowed ?? []);
      const allowBase = new Set((effectiveAllowed ?? []).map(toolBaseName));
      const disallowedTools = [...new Set(denyUnion)].filter(
        (t) => !allowExact.has(t) && !allowBase.has(toolBaseName(t)),
      );
      const baseArgs = buildInvokerArgs(prompt, cfgPath, {
        model: resolveModel(a.model_tier, opts.model),
        allowed_tools: effectiveAllowed,
        disallowed_tools: disallowedTools,
        max_tool_calls: maxToolCalls,
      });
      // SEAT IN THE ROOM. When the substrate stood up a SEAT-BEARING room, ctx.seatExec names its
      // container and per-realization workspace, and the chair runs INSIDE it:
      // `docker exec -i -w <workspace> <container> claude …` — so the seat's cwd is the room's own
      // tree and two concurrent gigs (distinct rooms, distinct workspaces) cannot share a working
      // directory. This wraps ONLY the leaf spawn; it runs AFTER the confinement block above, so
      // effectiveAllowed/childEnv are already computed and the room narrows the seat but never widens
      // it. `-i` keeps stdin open so a stdin-delivered prompt flows into the in-room binary. Auth is
      // FILE-BASED inside the room (credential_surface delivered by `docker cp` to /run/secrets),
      // never a host keychain and never forwarded via `-e`, so no host credential enters the room.
      // Absent → identity, and the leaf spawns on the host exactly as before.
      const seatExec = ctx.seatExec;
      const execBin = seatExec ? "docker" : bin;
      const inRoom = (args: readonly string[]): string[] =>
        seatExec ? ["exec", "-i", "-w", seatExec.workspace, seatExec.container, bin, ...args] : [...args];
      // ONE invocation only — on the output_write path the agent self-corrects a rejected write
      // WITHIN this single run (each output_write rejection returns in-band and it calls again),
      // and on the text path there is a single answer. Either way, the invoker never re-prompts.
      // A chair stopped by its TOOL BUDGET is not a chair that failed. `--max-turns` cuts the run
      // off mid-flight, and everything it had already written through the in-band boundary was
      // adjudicated against the full seal predicate at the moment of writing — those are validated
      // payloads, not the partial reasoning the error subtypes exist to catch. Discarding them
      // destroyed real work and billed for it: one observed sweep landed nine sealed lineage-hits,
      // satisfied its output_contract, and was reported as a failure with nothing kept.
      //
      // So the budget stop is caught HERE, and only here: the stream is recovered, and the decision
      // about whether anything survives is left to the seal path below, which is the only place that
      // knows what passed. Every other non-zero exit still propagates untouched.
      const runOnce = async (args: readonly string[], text: string): Promise<string> =>
        customRun
          ? await customRun(execBin, inRoom(args), spawnBounds, childEnv)
          : await spawnStreaming(
              execBin, inRoom([...args, "--output-format", "stream-json", "--verbose"]), spawnBounds,
              ctx.onEvent, ctx.signal, abortGraceMs, promptViaStdin(text) ? text : undefined,
              childEnv,
            );

      /** Run, and hand back the stream even when the child died on its turn cap. */
      const runTolerantOfBudgetStop = async (
        args: readonly string[],
        text: string,
      ): Promise<{ stdout: string; budgetStopped: boolean }> => {
        try {
          return { stdout: await runOnce(args, text), budgetStopped: false };
        } catch (e) {
          const recoverable =
            seal !== undefined &&
            e instanceof ChildExitError &&
            finalText(e.stdout).errorSubtype === BUDGET_STOP_SUBTYPE;
          if (!recoverable) throw e;
          return { stdout: (e as ChildExitError).stdout, budgetStopped: true };
        }
      };

      let { stdout, budgetStopped } = await runTolerantOfBudgetStop(baseArgs, prompt);
      // Every stream whose writes count toward the seal. Diverges from `stdout` only when a reserve
      // was granted, which is the one case where a chair's output spans more than one invocation.
      let sealStdout = stdout;

      // THE RESERVE GRANT. The chair spent its declared budget; rather than losing whatever it was
      // mid-way through, it is told where it stands and given a bounded extension to close out.
      // Once. The continuation names what already sealed so the chair does not redo it, and says
      // plainly that nothing follows — a chair that believes another extension is coming will spend
      // this one reaching rather than landing.
      if (budgetStopped && reserveTurns > 0 && seal !== undefined) {
        const sealedSoFar = captureOutputWrites(stdout, sealTypes);
        const already = Object.keys(sealedSoFar);
        ctx.onEvent?.({
          type: "budget_reserve_granted",
          raw: { agent: a.slug, reserve_turns: reserveTurns, sealed_before_grant: already },
        } as AgentStreamEvent);
        const continuation =
          `You reached your turn budget and were stopped mid-run. You are now in RESERVE: ` +
          `${reserveTurns} turns remain and this is the LAST extension — it will not be extended ` +
          `again, so land the work rather than reaching for more.\n\n` +
          (already.length > 0
            ? `Already sealed through the write boundary, do NOT redo: [${already.join(", ")}].\n\n`
            : `Nothing sealed yet.\n\n`) +
          `Close out now: seal what you already have, and state plainly what you did NOT reach so ` +
          `the record shows the boundary instead of implying coverage.\n\n${prompt}`;
        const reserveArgs = withPrompt(withMaxTurns(baseArgs, reserveTurns), continuation);
        const second = await runTolerantOfBudgetStop(reserveArgs, continuation);
        // Two streams, two different questions, and conflating them is a bug: the OUTCOME (did the
        // run complete?) is the last pass's to answer, while the WRITES are cumulative — the first
        // pass's payloads passed the boundary too, and a continuation that sealed nothing must not
        // erase them. Concatenating for both would let the first pass's error_max_turns result event
        // outrank the second's success and fail a run that finished.
        sealStdout = `${stdout}\n${second.stdout}`;
        stdout = second.stdout;
        budgetStopped = second.budgetStopped;
      } else if (budgetStopped && reserveTurns === 0 && seal !== undefined) {
        // #turn-budget — the chair hit its budget and the pool had nothing left to extend it (an
        // empty reserve). Keep-sealed-writes below is unchanged, but the starvation is now VISIBLE:
        // emit a denial so a parent watching the stream — and the runtime's draw ledger — can
        // attribute it, rather than a silent no-op that reads like a chair that simply finished.
        ctx.onEvent?.({
          type: "budget_reserve_denied",
          raw: { agent: a.slug, requested: ctx.turn_reserve ?? opts.turn_reserve ?? 0, pool_remaining: 0 },
        } as AgentStreamEvent);
      }
      const outcome = finalText(stdout);
      // #223 — the child reported an error result. `subtype` catches a run that did not complete;
      // `is_error` catches an API-error payload riding subtype "success". The CLI exits 0 for both,
      // so without this the partial reasoning seals as if it had succeeded. Applies to both paths.
      // A recovered budget stop reaches here with its subtype still set; that is expected and is
      // not an error for the seal path. The text path gets no such reprieve — its payload IS the
      // final answer text, and a truncated run's text is exactly the partial reasoning this guards.
      if (outcome.errorSubtype !== undefined && !budgetStopped) {
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

      if (seal) {
        // THE IN-BAND WRITE BOUNDARY. The chair sealed each output by calling output_write, whose
        // payload the engine adjudicated against the FULL seal predicate (checkWritable, run in
        // validate-mode) and whose rejection it corrected in-band. Capture the payloads that
        // PASSED; the runtime (executeChair) then seals them through its own boundary exactly once.
        // A chair that got nothing past the boundary produced nothing — fail here, legibly.
        let blob = captureOutputWrites(sealStdout, sealTypes);

        // ── THE CHANNEL REPAIR ────────────────────────────────────────────────────────────────
        // The chair finished cleanly and got NOTHING past the boundary — it produced its answer as
        // final text, or a file, or a summary, and never made the call that seals. Give it one
        // corrective continuation rather than failing the phase.
        //
        // The engine's in-band loop is already good, and that is exactly what makes this gap sharp:
        // output_write "runs the full seal predicate and returns its verdict in-band, so the agent
        // self-corrects" (:124) — but only for a chair that CALLED it. Getting the payload wrong is
        // recoverable; getting the CHANNEL wrong was fatal. That is backwards. A wrong channel is the
        // cheaper mistake to fix, because the work is already done and still sitting in the agent's
        // context — one turn is enough to make the call it should have made.
        //
        // Same mechanism as the reserve grant above, for a different cause: continue once, say where
        // it stands, and say plainly that nothing follows. Bounded to ONE — a chair that ignores a
        // direct instruction to seal will not be argued into it, and the argument bills real tokens.
        //
        // NOT for a budget stop: that chair used the right channel and ran out of room, and the
        // reserve grant is its remedy. Repairing it here would continue it twice for one stop.
        //
        // AND NOT for a chair that knocked and was refused. `attemptedWriteBoundary` is the whole
        // line: a chair whose output_write was REJECTED already got its correction in-band and gave
        // up, and re-prompting it is precisely the bounded repair loop the governor rejected twice
        // (tests/output_write_boundary.test.ts, "never the old bounded repair loop"). That principle
        // is untouched here. This repairs only the chair that never knocked at all — the one the
        // in-band loop cannot see, because it never entered it.
        if (Object.keys(blob).length === 0 && !budgetStopped && !attemptedWriteBoundary(sealStdout)) {
          const calls = sealTypes
            .map(
              (t) =>
                `  output_write({ "core_type": "${seal.core_by_type[t] ?? ""}", "domain_type": "${t}", ` +
                `"gig_id": "${seal.gig_id}", "phase": "${seal.phase}", "agent_slug": "${seal.agent_slug}", ` +
                `"data": <your result> })`,
            )
            .join("\n");
          ctx.onEvent?.({
            type: "seal_boundary_repair",
            raw: {
              agent: a.slug,
              unsealed: [...sealTypes],
              note:
                "the chair completed without calling output_write; it is being continued ONCE to " +
                "seal through the write boundary",
            },
          } as AgentStreamEvent);
          const correction =
            `STOP — your run finished but sealed NOTHING. Not one output_write call passed the ` +
            `write boundary for [${sealTypes.join(", ")}].\n\n` +
            `Whatever you produced — final text, a file, a summary — is NOT sealed. It will be ` +
            `discarded and this phase will fail.\n\n` +
            `The work you already did still counts. Do NOT redo it. Seal it now, by calling ` +
            `output_write — the only channel that seals:\n${calls}\n\n` +
            `This is the LAST attempt; it will not be offered again.\n\n${prompt}`;
          const repairArgs = withPrompt(withMaxTurns(baseArgs, SEAL_REPAIR_TURNS), correction);
          const repaired = await runTolerantOfBudgetStop(repairArgs, correction);
          // Cumulative, exactly as the reserve path is: a write that passed in either pass counts.
          sealStdout = `${sealStdout}\n${repaired.stdout}`;
          blob = captureOutputWrites(sealStdout, sealTypes);
        }

        if (Object.keys(blob).length === 0) {
          throw new ModelOutputContractError(
            a.slug,
            budgetStopped
              ? `ran out of tool budget (max_tool_calls) before any output_write passed the write ` +
                `boundary for [${sealTypes.join(", ")}] — nothing was salvageable`
              : `no output_write call passed the write boundary for [${sealTypes.join(", ")}]`,
          );
        }
        // The stop is REPORTED, never swallowed. What survived is real and sealed; what the agent
        // would have gone on to find is unknown, and a caller reading this chair's output as a
        // complete sweep would be reading a truncation as a finding.
        if (budgetStopped) {
          ctx.onEvent?.({
            type: "budget_stop",
            raw: {
              agent: a.slug,
              max_tool_calls: a.max_tool_calls,
              sealed_types: Object.keys(blob),
              note:
                "the chair exhausted its tool budget; the outputs it had already passed through " +
                "the write boundary were kept, and the sweep is TRUNCATED, not complete",
            },
          } as AgentStreamEvent);
        }
        return blob;
      }

      // TEXT-SEAL PATH (default; every injected-run test). No in-band tool surface, so the payload
      // is the child's final answer text; the runtime's own seal is this path's write boundary and
      // its full checkWritable adjudicates the extracted payload.
      // #222 — the stream parsed but carried no answer at all. Report THAT, with the raw stdout as
      // evidence, rather than blaming the model for emitting no JSON.
      if (outcome.text.trim() === "") {
        throw new ModelOutputParseError(
          "the model produced no answer — the stream carried no result text and no assistant text",
          0,
          stdout,
        );
      }
      return extractJson(outcome.text, extractOpts);
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
  /** The venue → dispatch wire's deny-by-default child env. When present it REPLACES the inherited
   *  process.env (no ambient credential leaks into a confined child); absent = inherit, unchanged. */
  childEnv?: Record<string, string> | undefined,
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
    const child = spawn(bin, [...args], { stdio, ...(childEnv ? { env: childEnv } : {}) });
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
      // The stdout travels WITH the failure. A non-zero exit used to discard it, which threw away
      // the one thing a budget-stopped chair leaves behind: output_write calls that already passed
      // the engine's write boundary. Whether those are recoverable is a decision for the caller,
      // which knows the seal mode and the result subtype; it cannot make it without the stream.
      if (code !== 0) reject(new ChildExitError(`claude exited ${code}: ${stderr.slice(0, 500)}`, stdout));
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
