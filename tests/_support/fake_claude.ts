// Shared harness for driving the invoker's REAL spawn path in unit tests.
//
// WHY: finalText and spawnStreaming are module-private with zero coverage. Every existing
// invoker test injects `opts.run`, which short-circuits at claude_invoker.ts:319 BEFORE the
// streaming path at :324-325. Injecting `run` therefore cannot reach those bugs — only a
// real spawn can. `fake_claude.mjs` is a scripted stand-in binary: no cost, no network, no
// dependency on the `claude` CLI.
//
// CONCURRENCY WARNING: scripting goes through process-level env vars, which is safe under
// the current vitest pool (forked, isolated, sequential tests within a file) but would
// SILENTLY RACE if anyone adds `.concurrent` to a describe/it in a file using this harness.
// Do not make these tests concurrent without moving the script into an argv/file seam.
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FAKE_BIN = fileURLToPath(new URL("./fake_claude.mjs", import.meta.url));

const ENV_KEYS = [
  "FAKE_CLAUDE_STDOUT_B64",
  "FAKE_CLAUDE_STDERR_B64",
  "FAKE_CLAUDE_EXIT",
  "FAKE_CLAUDE_SLEEP_MS",
  "FAKE_CLAUDE_TRAP_SIGTERM",
] as const;

/** Make the fixture executable — self-healing if the mode bit is lost. */
export function ensureFakeClaudeExecutable(): void {
  chmodSync(FAKE_BIN, 0o755);
}

/** Script the fake CLI's stdout byte-exactly (a trailing newline is meaningful — see #224). */
export function scriptFakeClaude(s: {
  stdout: string;
  exit?: number;
  stderr?: string;
  sleepMs?: number;
  trapSigterm?: boolean;
}): void {
  process.env["FAKE_CLAUDE_STDOUT_B64"] = Buffer.from(s.stdout, "utf8").toString("base64");
  process.env["FAKE_CLAUDE_STDERR_B64"] = Buffer.from(s.stderr ?? "", "utf8").toString("base64");
  process.env["FAKE_CLAUDE_EXIT"] = String(s.exit ?? 0);
  process.env["FAKE_CLAUDE_SLEEP_MS"] = String(s.sleepMs ?? 0);
  if (s.trapSigterm) process.env["FAKE_CLAUDE_TRAP_SIGTERM"] = "1";
}

export function resetFakeClaude(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

// ---- stream-json line builders ----
//
// PROVENANCE (re-verify if these drift): shapes read from the globally installed
// @anthropic-ai/claude-code@2.0.9 (homebrew) — sdk.d.ts:329-341 for the type union and the
// bundled emission sites in cli.js. NOTE the `claude` on PATH is the NATIVE binary
// 2.1.221, a DIFFERENT build whose bundle was not read. The evidence is strong but a
// future reader should re-verify against whichever build is actually spawned.

export const assistantLine = (text: string): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

export const systemInitLine = (): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: "s1", tools: [] });

export const successResultLine = (result: string, isError = false): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: isError,
    result,
    num_turns: 1,
    total_cost_usd: 0.42,
    usage: { input_tokens: 10, output_tokens: 5 },
  });

/**
 * The `error_max_turns` / `error_during_execution` result variant.
 *
 * VERIFIED, and both facts matter to the fix:
 *  - it carries NO `result` field at all (sdk.d.ts:329-341 gives `result: string` ONLY to
 *    the `success` variant), so finalText:405's `typeof e["result"] === "string"` never
 *    fires and :413 falls through to the concatenated assistant text;
 *  - `is_error` is emitted as `!1` (FALSE) at both cli.js emission sites, so an
 *    implementer discriminating on `is_error` alone will NOT catch either subtype.
 *    `subtype` is the required discriminator.
 *
 * Exit code: the print-mode handler sets it as `k6(result && is_error ? 1 : 0)`, so the CLI
 * exits **0** for both error subtypes — the silent path is reachable, not dead risk.
 */
export const errorResultLine = (
  subtype: "error_max_turns" | "error_during_execution",
): string =>
  JSON.stringify({
    type: "result",
    subtype,
    is_error: false,
    num_turns: 5,
    total_cost_usd: 0.31,
    usage: { input_tokens: 100, output_tokens: 50 },
  });
