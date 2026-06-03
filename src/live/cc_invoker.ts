// cc_invoker.ts — invoke the `claude` CLI with --resume + --print, capture stdout.
//
// The Steve worker loop calls this once per inbox event: given a session_id
// (from cc_session_binding) + a formatted prompt, spawn claude, wait on stdout,
// return the text. The default implementation wraps the real CLI; tests inject
// a stubInvoker with a canned-response map keyed by prompt prefix.
//
// Failure modes are returned, not thrown:
//   - missing binary  -> { ok: false, error_kind: "binary_missing" }
//   - non-zero exit   -> { ok: false, error_kind: "exit_nonzero", stderr, exit_code }
//   - timeout         -> { ok: false, error_kind: "timeout", timeout_ms }
//
// The worker loop can then seal the failure into audit.jsonl + decide whether
// to retry or skip — it never sees a stack trace from this seam.

import { spawn } from "node:child_process";

export interface InvokeOptions {
  /** How long to wait for stdout to close before killing the process. */
  timeout_ms?: number;
  /** Override the binary name (default: "claude"). */
  binary?: string;
  /** Override the working directory passed to spawn. */
  cwd?: string;
}

export type InvokeResult =
  | { ok: true; text: string; session_id: string }
  | {
      ok: false;
      session_id: string;
      error_kind: "binary_missing" | "exit_nonzero" | "timeout" | "spawn_error";
      stderr?: string;
      exit_code?: number;
      timeout_ms?: number;
      message: string;
    };

export interface ClaudeInvoker {
  invoke(
    sessionId: string,
    prompt: string,
    options?: InvokeOptions,
  ): Promise<InvokeResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Production invoker: spawns `claude --resume <session_id> --print "<prompt>"`,
 * captures stdout, returns text. Any error path returns a structured InvokeResult
 * instead of throwing.
 */
export function defaultInvoker(): ClaudeInvoker {
  return {
    async invoke(sessionId, prompt, options) {
      const timeout = options?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const binary = options?.binary ?? "claude";
      return new Promise<InvokeResult>((resolve) => {
        let settled = false;
        const settle = (r: InvokeResult) => {
          if (settled) return;
          settled = true;
          resolve(r);
        };

        let child: ReturnType<typeof spawn>;
        try {
          const spawnOpts: { stdio: ["ignore", "pipe", "pipe"]; cwd?: string } = {
            stdio: ["ignore", "pipe", "pipe"],
          };
          if (options?.cwd !== undefined) spawnOpts.cwd = options.cwd;
          child = spawn(
            binary,
            ["--resume", sessionId, "--print", prompt],
            spawnOpts,
          );
        } catch (err) {
          settle({
            ok: false,
            session_id: sessionId,
            error_kind: "spawn_error",
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });

        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          settle({
            ok: false,
            session_id: sessionId,
            error_kind: "timeout",
            timeout_ms: timeout,
            stderr,
            message: `claude invoke timed out after ${timeout}ms`,
          });
        }, timeout);

        child.on("error", (err: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          if (err.code === "ENOENT") {
            settle({
              ok: false,
              session_id: sessionId,
              error_kind: "binary_missing",
              message: `claude binary not found on PATH (looked for: ${binary})`,
            });
            return;
          }
          settle({
            ok: false,
            session_id: sessionId,
            error_kind: "spawn_error",
            message: err.message,
          });
        });

        child.on("close", (code: number | null) => {
          clearTimeout(timer);
          if (code === 0) {
            settle({ ok: true, session_id: sessionId, text: stdout });
            return;
          }
          settle({
            ok: false,
            session_id: sessionId,
            error_kind: "exit_nonzero",
            exit_code: code ?? -1,
            stderr,
            message: `claude exited with code ${code ?? "null"}`,
          });
        });
      });
    },
  };
}

/**
 * Test invoker: matches prompts against a canned-response map (longest-prefix
 * wins). If no key matches, returns a deterministic fallback so tests can
 * still assert on the round-trip without enumerating every prompt.
 */
export function stubInvoker(
  canned: Record<string, string>,
  options?: { fallback?: string },
): ClaudeInvoker {
  const fallback = options?.fallback ?? "[stub: no canned response]";
  const keys = Object.keys(canned).sort((a, b) => b.length - a.length);
  return {
    async invoke(sessionId, prompt) {
      for (const k of keys) {
        if (prompt.includes(k)) {
          const v = canned[k];
          if (v !== undefined) {
            return { ok: true, session_id: sessionId, text: v };
          }
        }
      }
      return { ok: true, session_id: sessionId, text: fallback };
    },
  };
}
