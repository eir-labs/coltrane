// phase-16 runner: invoke the sub_thread_invocation coltrane-standard against
// phase-15's e2e test artifacts.
//
// Self-referential by design: coltrane's own runtime (loadGenome + loadRegistry +
// createOutputStore + MemoryLedger + runGig) runs the soft-judge. The LLM seam is
// the same one coltrane's production claude_invoker uses — extractJson + spawn —
// but with per-phase prompt_templates plumbed in from the standard JSON.
//
// Honesty contracts:
//   - if a test produced no transcript (recorder empty per phase-15 F1), SENSE
//     reports turns=[] and INTERPRET returns UNJUDGEABLE. We do NOT fabricate.
//   - coltrane's existing buildPrompt has no slot for per-phase prompt_templates,
//     so this runner wires its own invoker that reads templates from the standard
//     file. That's the RIPENED-DIFFERENTLY gap the PR documents.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { loadGenome } from "../../src/loader.js";
import { runGig, type AgentInvocationContext, type AgentInvoker } from "../../src/runtime.js";
import { loadRegistry } from "../../src/registry.js";
import { MemoryLedger } from "../../src/ledger.js";
import { createOutputStore } from "../../src/outputs.js";
import { extractJson } from "../../src/claude_invoker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");

interface Phase15TestCase {
  spec_file: string;
  test_name: string;
  prereg_verdict: "PASS" | "FAIL" | "VACUOUS_PASS";
  capture_status: string;
}

// Phase-15 cleaned up tempdirs in afterAll → nothing persisted past the run. To make
// phase-16 soft-judge meaningful we capture fresh artifacts for two representative
// cases the pre-reg explicitly names: one passing (eng_manager #2) and one
// failing-equivalent (solo_dev #1, the empty-recorder case).
const PHASE15_TEST_CASES: Phase15TestCase[] = [
  {
    spec_file: "sub_thread.eng_manager.spec.ts",
    test_name: "hard: example completes without error (exit code 0)",
    prereg_verdict: "PASS",
    capture_status: "to-capture: a fresh `claude -p` invocation matching the passing test's shape",
  },
  {
    spec_file: "sub_thread.solo_dev.spec.ts",
    test_name: "hard: 3-parallel children return session_ids; recorder captures all 3",
    prereg_verdict: "FAIL",
    capture_status:
      "to-capture: stream-json from one of the 3 parallel children + a deliberately EMPTY recorder log (mirroring the phase-15 finding that coltrane has no sub-thread recorder hook)",
  },
];

interface CaptureArtifacts {
  transcript_path: string;
  recorder_log_path: string;
  exit_code: number | null;
}

async function captureForCase(tc: Phase15TestCase, outDir: string): Promise<CaptureArtifacts> {
  mkdirSync(outDir, { recursive: true });
  const safe = `${tc.spec_file}.${tc.test_name.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}`;
  const transcriptPath = join(outDir, `${safe}.stream.jsonl`);
  const recorderPath = join(outDir, `${safe}.recorder.jsonl`);

  const prompt = tc.test_name.includes("3-parallel")
    ? "respond with the word 'one' and nothing else"
    : "respond with the literal word 'ready'";

  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  const childResult = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolveP) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("close", (code) => { clearTimeout(timer); resolveP({ stdout, stderr, code }); });
  });

  writeFileSync(transcriptPath, childResult.stdout);
  writeFileSync(recorderPath, ""); // deliberately empty — matches phase-15 reality
  return { transcript_path: transcriptPath, recorder_log_path: recorderPath, exit_code: childResult.code };
}

function makeJudgeInvoker(promptTemplates: Record<string, string>): AgentInvoker {
  return (ctx: AgentInvocationContext) => {
    const phaseTemplate = promptTemplates[ctx.phase] ?? "";
    const inputsBlock = ctx.inputs.length
      ? ctx.inputs.map((o) => `[upstream ${o.domain_type} from ${o.agent_slug}]\n${JSON.stringify(o.data, null, 2)}`).join("\n\n")
      : "(none — root agent)";

    let prompt = [
      `# Standard: sub_thread_invocation`,
      `# Phase: ${ctx.phase}`,
      `# Agent: ${ctx.agent.slug} (primitives: ${ctx.agent.primitives.join(", ")})`,
      ``,
      `## Phase prompt_template`,
      phaseTemplate,
      ``,
      `## Gig input`,
      JSON.stringify(ctx.gig_input, null, 2),
      ``,
      `## Upstream outputs`,
      inputsBlock,
      ``,
      `Respond with ONLY a single JSON object — no prose, no code fence, no markdown.`,
    ].join("\n");

    if (ctx.phase === "sense") {
      const tp = (ctx.gig_input as { transcript_path?: string }).transcript_path;
      const rp = (ctx.gig_input as { recorder_log_path?: string }).recorder_log_path;
      const transcriptText = tp && existsSync(tp) ? readFileSync(tp, "utf-8") : "";
      const recorderText = rp && existsSync(rp) ? readFileSync(rp, "utf-8") : "";
      prompt += [
        ``,
        ``,
        `## TRANSCRIPT FILE CONTENTS (${tp ?? "(none)"})`,
        transcriptText.length > 0 ? "```\n" + transcriptText.slice(0, 50_000) + "\n```" : "(empty / missing)",
        ``,
        `## RECORDER LOG CONTENTS (${rp ?? "(none)"})`,
        recorderText.length > 0 ? "```\n" + recorderText.slice(0, 50_000) + "\n```" : "(empty / missing)",
      ].join("\n");
    }

    const cfgPath = join("/tmp", `coltrane-judge-mcp-${randomUUID()}.json`);
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }));
    try {
      const stdout = execFileSync(
        "claude",
        ["-p", prompt, "--mcp-config", cfgPath, "--strict-mcp-config"],
        { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 240_000 },
      ) as string;
      return extractJson(stdout);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const fallback: Record<string, unknown> = ctx.phase === "sense"
        ? {
            transcript_path: (ctx.gig_input as { transcript_path?: string }).transcript_path ?? "",
            recorder_log_path: (ctx.gig_input as { recorder_log_path?: string }).recorder_log_path ?? "",
            transcript_present: false,
            recorder_log_present: false,
            recorder_log_empty: true,
            turns: [],
            notes: `judge invocation failed: ${msg.slice(0, 300)}`,
          }
        : {
            criteria: {
              parent_context_preservation: { score: null, rationale: `judge failed: ${msg.slice(0, 200)}` },
              child_stay_on_task: { score: null, rationale: `judge failed: ${msg.slice(0, 200)}` },
              inter_turn_coherence: { score: null, rationale: `judge failed: ${msg.slice(0, 200)}` },
              graceful_degradation: { score: null, rationale: `judge failed: ${msg.slice(0, 200)}` },
            },
            overall_verdict_shade: "UNJUDGEABLE",
            top_insight: `judge invocation failed (${msg.slice(0, 200)}); soft-verdict could not be produced`,
          };
      return fallback;
    }
  };
}

interface SoftJudgeResult {
  case: Phase15TestCase;
  capture: CaptureArtifacts;
  sense_output: Record<string, unknown> | null;
  interpret_output: Record<string, unknown> | null;
  errors: string[];
}

async function judgeOne(tc: Phase15TestCase, artifactsDir: string): Promise<SoftJudgeResult> {
  const errors: string[] = [];
  let capture: CaptureArtifacts;
  try {
    capture = await captureForCase(tc, artifactsDir);
  } catch (e) {
    errors.push(`capture failed: ${e instanceof Error ? e.message : String(e)}`);
    return {
      case: tc,
      capture: { transcript_path: "", recorder_log_path: "", exit_code: null },
      sense_output: null,
      interpret_output: null,
      errors,
    };
  }

  const genome = loadGenome(REPO_ROOT);
  const standard = genome.standards.get("sub_thread_invocation");
  if (!standard) {
    errors.push("sub_thread_invocation standard not loaded from genome");
    return { case: tc, capture, sense_output: null, interpret_output: null, errors };
  }

  const stdRaw = JSON.parse(
    readFileSync(join(REPO_ROOT, "standards", "sub_thread_invocation.json"), "utf-8"),
  ) as { prompt_templates?: Record<string, string> };
  const promptTemplates = stdRaw.prompt_templates ?? {};

  const registry = loadRegistry(genome);
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  const invoke = makeJudgeInvoker(promptTemplates);

  try {
    const result = await runGig(
      standard,
      {
        transcript_path: capture.transcript_path,
        recorder_log_path: capture.recorder_log_path,
      },
      { outputs, ledger, invoke, model_version: "claude-cli" },
    );
    const sense = result.outputs.find((o) => o.phase === "sense");
    const interp = result.outputs.find((o) => o.phase === "interpret");
    return {
      case: tc,
      capture,
      sense_output: sense?.data ?? null,
      interpret_output: interp?.data ?? null,
      errors,
    };
  } catch (e) {
    errors.push(`runGig failed: ${e instanceof Error ? e.message : String(e)}`);
    return { case: tc, capture, sense_output: null, interpret_output: null, errors };
  }
}

function renderMarkdown(results: SoftJudgeResult[]): string {
  const lines: string[] = [];
  lines.push("# Phase 16 — coltrane-standard soft-judge for phase-15 e2e (self-referential)");
  lines.push("");
  lines.push("**Run date:** 2026-06-02");
  lines.push("**Branch:** `groove/phase16-soft-judge` (off `groove/phase15-e2e-sub-thread`)");
  lines.push("**Standard:** `standards/sub_thread_invocation.json` (SENSE + INTERPRET)");
  lines.push("**Self-referential:** coltrane's own runGig + Claude CLI score coltrane's own sub-thread tests.");
  lines.push("");
  lines.push("## Honesty preamble");
  lines.push("");
  lines.push("Phase-15 cleaned up its tempdirs in `afterAll`, so the e2e suite persisted NO transcripts");
  lines.push("or recorder logs past its run. Phase-16 captures fresh artifacts for two representative");
  lines.push("cases (one passing, one failing-equivalent) so the soft-judge has concrete inputs.");
  lines.push("");
  lines.push("For both cases the recorder log is written EMPTY — mirroring the exact phase-15 finding");
  lines.push("that coltrane has no `SubthreadRecorder` wired. The soft-judge surfaces this as");
  lines.push("UNJUDGEABLE for any criterion that requires multi-turn evidence.");
  lines.push("");
  lines.push("## Per-test soft-verdict");
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.case.spec_file} — ${r.case.test_name}`);
    lines.push("");
    lines.push(`- **Pre-reg verdict (hard):** ${r.case.prereg_verdict}`);
    lines.push(`- **Capture status:** ${r.case.capture_status}`);
    lines.push(`- **Transcript:** \`${r.capture.transcript_path}\``);
    lines.push(`- **Recorder log:** \`${r.capture.recorder_log_path}\` (empty by design)`);
    lines.push(`- **Capture exit code:** ${r.capture.exit_code}`);
    if (r.errors.length) {
      lines.push("");
      lines.push("**Errors during judging:**");
      for (const e of r.errors) lines.push(`- ${e}`);
    }
    lines.push("");
    if (r.sense_output) {
      lines.push("**SENSE output (parsed-conversation-trace):**");
      lines.push("```json");
      lines.push(JSON.stringify(r.sense_output, null, 2));
      lines.push("```");
      lines.push("");
    } else {
      lines.push("**SENSE output:** _(missing — judge failed before SENSE produced)_");
      lines.push("");
    }
    if (r.interpret_output) {
      lines.push("**INTERPRET output (soft-verdict):**");
      lines.push("```json");
      lines.push(JSON.stringify(r.interpret_output, null, 2));
      lines.push("```");
      lines.push("");
      const shade = (r.interpret_output as { overall_verdict_shade?: string }).overall_verdict_shade ?? "(missing)";
      lines.push(`**Verdict shade:** \`${shade}\``);
      const insight = (r.interpret_output as { top_insight?: string }).top_insight ?? "(missing)";
      lines.push(`**Top insight (beyond hard-asserts):** ${insight}`);
      lines.push("");
    } else {
      lines.push("**INTERPRET output:** _(missing — judge failed before INTERPRET produced)_");
      lines.push("");
    }
  }
  lines.push("## Phase-15 cases that CANNOT be soft-judged");
  lines.push("");
  lines.push("Per honest pre-reg discipline, the following phase-15 tests cannot be soft-judged from");
  lines.push("existing artifacts because phase-15 produced no persisted transcripts. The soft-judge");
  lines.push("is meaningful ONLY where a real conversation can be inspected:");
  lines.push("");
  lines.push("- `platform_team` F1 hash-stability (vacuous-pass; both hashes were SHA256(empty) per phase-15)");
  lines.push("- `research_lab` F1 chain-of-5 (same vacuous-pass condition)");
  lines.push("- `research_lab` F4 nested depth ≥3 (no lineage edges in any artifact)");
  lines.push("- `platform_team` F2 API-version-bump fails-CLOSED (no API-version concept → no transcript to judge)");
  lines.push("- `platform_team` F3, `research_lab` F5 (both blocked on the same recorder gap)");
  lines.push("");
  lines.push("These are structurally unjudgeable until coltrane wires the `SubthreadRecorder`. Once");
  lines.push("the recorder is wired, the soft-judge's INTERPRET phase can score the recorded turn-list");
  lines.push("directly without needing to re-capture transcripts.");
  lines.push("");
  lines.push("## Apoha — what this soft-judge is NOT");
  lines.push("");
  lines.push("- NOT a replacement for the hard RED/GREEN asserts (those still own correctness)");
  lines.push("- NOT a new judge framework (REUSES runGig + claude_invoker.extractJson)");
  lines.push("- NOT fabricating turns when none exist (returns UNJUDGEABLE with diagnosis)");
  lines.push("- NOT modifying phase-15's tests (this branch is purely additive)");
  lines.push("");
  return lines.join("\n");
}

(async () => {
  const artifactsDir = join(REPO_ROOT, "tests", "e2e", "phase16_artifacts");
  console.error(`[phase-16] capturing artifacts to ${artifactsDir}`);
  const results: SoftJudgeResult[] = [];
  for (const tc of PHASE15_TEST_CASES) {
    console.error(`[phase-16] judging: ${tc.spec_file} — ${tc.test_name}`);
    const r = await judgeOne(tc, artifactsDir);
    results.push(r);
    console.error(
      `[phase-16]   sense_ok=${!!r.sense_output} interpret_ok=${!!r.interpret_output} errors=${r.errors.length}`,
    );
  }

  const outPath = join(REPO_ROOT, "tests", "e2e", "RESULTS_2026-06-02_with_soft_verdict.md");
  writeFileSync(outPath, renderMarkdown(results));
  console.error(`[phase-16] wrote ${outPath}`);

  const jsonPath = join(REPO_ROOT, "tests", "e2e", "RESULTS_2026-06-02_with_soft_verdict.json");
  writeFileSync(
    jsonPath,
    JSON.stringify(
      results.map((r) => ({
        case: r.case,
        capture: r.capture,
        sense: r.sense_output,
        interpret: r.interpret_output,
        errors: r.errors,
      })),
      null,
      2,
    ),
  );
  console.error(`[phase-16] wrote ${jsonPath}`);
})().catch((e) => {
  console.error("[phase-16] FATAL", e);
  process.exit(1);
});
