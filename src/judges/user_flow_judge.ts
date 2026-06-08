// user_flow_judge — LLM-judge module for user-flow behavioral correctness.
//
// Extends groove/phase16's soft-judge pattern (sub_thread_invocation) to score
// USER-FLOW behavioral correctness rather than sub-thread invocation. Gap-1 in the
// phase-15 ecosystem: every deterministic spec asserts hard outcomes; zero tests
// score whether claude PICKED the right coltrane tool for a fuzzy user intent.
//
// API:
//   scoreUserFlow(transcript, standard) -> JudgeVerdict
//
// The judge invokes a real `claude -p` subprocess (no mocks). It reads the
// standard's prompt_templates and feeds them — SENSE first to normalize the
// transcript, INTERPRET second to score the criteria. Returns a structured
// verdict with per-criterion score + rationale + overall pass/fail at the
// configured threshold.

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { extractJson as extractJsonShared } from "../claude_invoker.js";

/**
 * String-aware JSON extractor. The shared `extractJson` counts `{`/`}` literally,
 * which breaks when rationale strings contain braces (e.g., '{slug: ...}' in a
 * quoted error message). Strategy:
 *   1. If output is fenced (```json...```), parse that block first.
 *   2. Walk the text honoring JSON string boundaries + backslash escapes so the
 *      brace count only advances on STRUCTURAL braces; return the FIRST balanced
 *      object that parses.
 *   3. Fall back to the shared extractor only as last resort.
 */
export function extractJson(text: string): Record<string, unknown> {
  // 1. Try fenced ```json ... ``` blocks.
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch && fenceMatch[1]) {
    try { return JSON.parse(fenceMatch[1].trim()) as Record<string, unknown>; }
    catch { /* fall through */ }
  }

  // 2. String-aware brace walk: try every candidate balanced object until one parses.
  const start = text.indexOf("{");
  if (start !== -1) {
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
        if (depth === 0) {
          const slice = text.slice(start, i + 1);
          try { return JSON.parse(slice) as Record<string, unknown>; }
          catch { /* try next candidate */ }
        }
      }
    }
  }

  // 3. Last resort: the shared (literal-count) extractor.
  return extractJsonShared(text);
}

// ───────────────────────────── shapes ─────────────────────────────

/** One turn of a user-flow transcript — the raw signal the SENSE phase parses. */
export interface UserFlowTurn {
  /** What the user (Eugene's intent surrogate) actually asked for in this turn. */
  user_intent: string;
  /** Claude's natural-language response (no parsing — verbatim text). */
  claude_response: string;
  /** The coltrane MCP tools claude invoked during this turn. May be empty. */
  tool_calls: Array<{ tool_name: string; args?: Record<string, unknown> | null }>;
  /** Snapshot of the genome state AFTER this turn — null for read-only turns. */
  post_turn_genome_state?: Record<string, unknown> | null;
  /** Marker: the user_intent was deliberately malformed (typo/garbage/contradiction). */
  malformed_input?: boolean;
}

/** A full user-flow transcript — sequence of turns scored as one flow. */
export type UserFlowTranscript = UserFlowTurn[];

/** The five criteria the standard defines. Adding one here requires updating the standard. */
export const USER_FLOW_CRITERIA = [
  "tool_pick_appropriate",
  "response_faithful",
  "genome_state_valid",
  "typed_error_on_malformed",
  "multi_turn_continuity",
] as const;
export type UserFlowCriterion = (typeof USER_FLOW_CRITERIA)[number];

export interface CriterionScore {
  score: number | null;
  rationale: string;
}

export interface JudgeVerdict {
  criteria: Record<UserFlowCriterion, CriterionScore>;
  /** Sum of non-null scores, range [0.0, 5.0], or null if all null. */
  overall_score: number | null;
  /** True iff overall_score >= pass_threshold_sum (from the standard's scoring block). */
  overall_pass: boolean;
  /** The single most load-bearing observation, grounded in a specific turn. */
  top_finding: string;
  /** Raw outputs of each phase — kept for debug + REPRO comparison. */
  raw: {
    sense: Record<string, unknown> | null;
    interpret: Record<string, unknown> | null;
  };
}

/** Minimal shape of the standard JSON we read (we don't pin every key). */
export interface SoftJudgeStandard {
  slug: string;
  prompt_templates: {
    sense: string;
    interpret: string;
  };
  scoring?: {
    pass_threshold_per_criterion?: number;
    overall_pass_threshold_sum?: number;
    overall_pass_threshold_max?: number;
    noise_band_repro?: number;
  };
}

/** Options for the LLM-subprocess invocation. */
export interface ScoreUserFlowOptions {
  /** Claude CLI binary. Default "claude". */
  bin?: string;
  /** Per-phase timeout in ms. Default 240_000 (4 min — judges can take time). */
  timeoutMs?: number;
  /** Inject a custom run() to test the prompt-building path without the subprocess. */
  run?: (bin: string, args: string[]) => string;
}

// ──────────────────────────── helpers ────────────────────────────

/** Load a soft-judge standard from disk. Thin convenience over readFileSync+JSON.parse. */
export function loadStandard(path: string): SoftJudgeStandard {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as SoftJudgeStandard;
  if (!raw.prompt_templates || typeof raw.prompt_templates.sense !== "string" || typeof raw.prompt_templates.interpret !== "string") {
    throw new Error(`standard at ${path} missing prompt_templates.sense/interpret`);
  }
  return raw;
}

function buildSensePrompt(template: string, transcript: UserFlowTranscript): string {
  return [
    `# Standard: user_flow_correctness`,
    `# Phase: sense`,
    ``,
    `## Phase prompt_template`,
    template,
    ``,
    `## Gig input`,
    JSON.stringify({ transcript_json: JSON.stringify(transcript) }, null, 2),
    ``,
    `## Raw transcript (already JSON; included for direct reference)`,
    "```json",
    JSON.stringify(transcript, null, 2),
    "```",
    ``,
    `Respond with ONLY a single JSON object — no prose, no code fence, no markdown.`,
  ].join("\n");
}

function buildInterpretPrompt(template: string, senseOutput: Record<string, unknown>): string {
  return [
    `# Standard: user_flow_correctness`,
    `# Phase: interpret`,
    ``,
    `## Phase prompt_template`,
    template,
    ``,
    `## Gig input`,
    JSON.stringify({ trace: senseOutput }, null, 2),
    ``,
    `## Upstream output (user-flow-transcript from SENSE)`,
    "```json",
    JSON.stringify(senseOutput, null, 2),
    "```",
    ``,
    `Respond with ONLY a single JSON object — no prose, no code fence, no markdown.`,
  ].join("\n");
}

/** Invoke claude CLI once with a prompt, return raw stdout. */
function invokeClaude(prompt: string, opts: { bin: string; timeoutMs: number; run?: (b: string, a: string[]) => string }): string {
  const cfgPath = join(tmpdir(), `coltrane-uf-judge-mcp-${randomUUID()}.json`);
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }));
  try {
    const args = ["-p", prompt, "--mcp-config", cfgPath, "--strict-mcp-config"];
    if (opts.run) return opts.run(opts.bin, args);
    return execFileSync(opts.bin, args, {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs,
    }) as string;
  } finally {
    try { unlinkSync(cfgPath); } catch { /* best-effort */ }
  }
}

/** Stash the most-recent raw stdout for each phase, for debug + REPRO inspection. */
const RAW_STDOUT_LOG: { sense: string; interpret: string } = { sense: "", interpret: "" };
export function lastRawStdout(): { sense: string; interpret: string } {
  return { ...RAW_STDOUT_LOG };
}

/** Build an empty criteria block (used when SENSE produces no turns). */
function unjudgeableCriteria(reason: string): Record<UserFlowCriterion, CriterionScore> {
  const out = {} as Record<UserFlowCriterion, CriterionScore>;
  for (const c of USER_FLOW_CRITERIA) {
    out[c] = { score: null, rationale: reason };
  }
  return out;
}

/** Normalize whatever the LLM returned into a JudgeVerdict, defensively. */
function normalizeInterpretOutput(
  raw: Record<string, unknown>,
  sense: Record<string, unknown> | null,
  passThresholdSum: number,
): JudgeVerdict {
  const rawCriteria = (raw["criteria"] ?? {}) as Record<string, { score?: unknown; rationale?: unknown }>;
  const criteria = {} as Record<UserFlowCriterion, CriterionScore>;
  let sum = 0;
  let anyNonNull = false;
  for (const c of USER_FLOW_CRITERIA) {
    const entry = rawCriteria[c] ?? {};
    const score = typeof entry.score === "number" ? entry.score : null;
    const rationale = typeof entry.rationale === "string" ? entry.rationale : "(no rationale returned)";
    criteria[c] = { score, rationale };
    if (score !== null) { sum += score; anyNonNull = true; }
  }
  const overall_score = anyNonNull ? sum : null;
  const overall_pass = overall_score !== null && overall_score >= passThresholdSum;
  const top_finding = typeof raw["top_finding"] === "string" ? (raw["top_finding"] as string) : "(no top finding returned)";
  return {
    criteria,
    overall_score,
    overall_pass,
    top_finding,
    raw: { sense, interpret: raw },
  };
}

// ───────────────────────────── public API ─────────────────────────────

/**
 * Score a user-flow transcript against a soft-judge standard. Runs SENSE + INTERPRET
 * phases via real `claude -p` subprocesses, returns a structured verdict.
 *
 * NOT mocked. Each call spawns claude twice (one per phase). Allow ~30-90s wall time.
 */
export async function scoreUserFlow(
  transcript: UserFlowTranscript,
  standard: SoftJudgeStandard,
  opts: ScoreUserFlowOptions = {},
): Promise<JudgeVerdict> {
  const bin = opts.bin ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const passThresholdSum = standard.scoring?.overall_pass_threshold_sum ?? 3.0;

  // SENSE
  const sensePrompt = buildSensePrompt(standard.prompt_templates.sense, transcript);
  let senseOut: Record<string, unknown> | null = null;
  try {
    const stdout = invokeClaude(sensePrompt, { bin, timeoutMs, ...(opts.run ? { run: opts.run } : {}) });
    RAW_STDOUT_LOG.sense = stdout;
    senseOut = extractJson(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      criteria: unjudgeableCriteria(`SENSE invocation failed: ${msg.slice(0, 200)}`),
      overall_score: null,
      overall_pass: false,
      top_finding: `SENSE phase failed: ${msg.slice(0, 200)}`,
      raw: { sense: null, interpret: null },
    };
  }

  // INTERPRET
  const interpretPrompt = buildInterpretPrompt(standard.prompt_templates.interpret, senseOut);
  let interpretOut: Record<string, unknown>;
  try {
    const stdout = invokeClaude(interpretPrompt, { bin, timeoutMs, ...(opts.run ? { run: opts.run } : {}) });
    RAW_STDOUT_LOG.interpret = stdout;
    interpretOut = extractJson(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      criteria: unjudgeableCriteria(`INTERPRET invocation failed: ${msg.slice(0, 200)}`),
      overall_score: null,
      overall_pass: false,
      top_finding: `INTERPRET phase failed: ${msg.slice(0, 200)}`,
      raw: { sense: senseOut, interpret: null },
    };
  }

  return normalizeInterpretOutput(interpretOut, senseOut, passThresholdSum);
}
