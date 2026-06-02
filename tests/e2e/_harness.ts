// e2e harness — tempdir clone of coltrane-oss + Claude CLI sub-thread driver.
//
// design contracts:
//   - setupTempdirColtrane()     → fresh /tmp/coltrane-e2e-<uuid>/ with full source + build artifacts
//   - spawnClaudeSubthread(args) → fires `claude -p ... --output-format stream-json` and parses session_id
//   - resumeSubthread(sid,p)     → `claude --resume <sid> -p ...`
//   - assertRecorderCapturedTurn → asserts ledger entry for a recorded turn
//
// Intentionally no patches to coltrane. If the suite reveals coltrane has no session/resume seam,
// that's the diagnosis Eugene wants — test stays honest, doesn't paper over.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// repo root = three dirs up from tests/e2e/_harness.ts
export const REPO_ROOT = resolve(__dirname, "..", "..");

export interface TempdirColtrane {
  tempDir: string;
  mcpServerEntry: string; // path to _server_entry.mjs inside the clone
  mcpConfigPath: string; // a strict-mcp-config json file pointing at the entry
  recorderPath: string; // where ledger entries are written
  cleanup: () => void;
}

/**
 * Clones the current coltrane-oss source into a fresh tempdir and prepares the MCP server
 * to be spawned. Uses cpSync to avoid heavy `npm install` (we reuse the repo's node_modules
 * via NODE_PATH so we don't re-install on every test).
 *
 * Per pre-reg honesty: if cpSync or the build fails, the harness throws — that's the
 * kill-condition Eugene flagged.
 */
export async function setupTempdirColtrane(): Promise<TempdirColtrane> {
  const tempDir = mkdtempSync(join(tmpdir(), "coltrane-e2e-"));

  // copy source + configs (skip node_modules + dist + .git for speed)
  for (const entry of ["src", "tests", "package.json", "tsconfig.json", "domain_types", "core_types", "agents", "standards", "skills"]) {
    const src = join(REPO_ROOT, entry);
    if (existsSync(src)) {
      cpSync(src, join(tempDir, entry), { recursive: true });
    }
  }

  // symlink node_modules from repo root — avoids 60s of npm install per test
  const repoNodeModules = join(REPO_ROOT, "node_modules");
  if (existsSync(repoNodeModules)) {
    try {
      // hard copy fallback (some test envs disallow symlink)
      const tempNodeModules = join(tempDir, "node_modules");
      execFileSync("ln", ["-sf", repoNodeModules, tempNodeModules]);
    } catch {
      // best-effort; tests will fail explicitly if deps are missing — that's honest
    }
  }

  // copy our entry script
  const entrySrc = join(REPO_ROOT, "tests", "e2e", "_server_entry.mjs");
  const mcpServerEntry = join(tempDir, "tests", "e2e", "_server_entry.mjs");
  mkdirSync(dirname(mcpServerEntry), { recursive: true });
  if (existsSync(entrySrc)) cpSync(entrySrc, mcpServerEntry);

  // write a strict-mcp-config pointing at the tempdir's entry
  const mcpConfigPath = join(tempDir, "mcp-config.json");
  const mcpConfig = {
    mcpServers: {
      coltrane: {
        command: "npx",
        args: ["tsx", mcpServerEntry],
        env: {
          COLTRANE_GENOME: tempDir,
        },
      },
    },
  };
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  // recorder path — coltrane's MemoryLedger doesn't persist, so we capture via env hook
  const recorderPath = join(tempDir, ".coltrane-recorder.jsonl");
  writeFileSync(recorderPath, ""); // ensure exists for assertRecorderCapturedTurn

  return {
    tempDir,
    mcpServerEntry,
    mcpConfigPath,
    recorderPath,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

export interface SubthreadResult {
  sessionId: string | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Spawn a Claude CLI sub-thread. Args are appended to the base invocation.
 * Captures stream-json output and parses session_id from the first `system` event.
 *
 * Honesty note: if the local `claude` binary's stream-json shape differs from
 * what's expected, sessionId may be null. Tests use null to assert against — that's
 * the kind of mismatch this suite is designed to surface.
 */
export async function spawnClaudeSubthread(
  args: string[],
  opts: { cwd?: string; mcpConfigPath?: string; timeoutMs?: number } = {},
): Promise<SubthreadResult> {
  const fullArgs = [...args];
  if (opts.mcpConfigPath) {
    fullArgs.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
  }
  // ensure stream-json is in args if not already
  if (!fullArgs.includes("--output-format")) {
    fullArgs.push("--output-format", "stream-json", "--verbose");
  }

  const start = Date.now();
  return new Promise((resolveP) => {
    const child = spawn("claude", fullArgs, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let sessionId: string | null = null;

    const timeoutMs = opts.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      stdout += s;
      // try to parse session_id from any line of stream-json
      if (!sessionId) {
        for (const line of s.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const evt = JSON.parse(trimmed);
            if (evt.session_id) {
              sessionId = evt.session_id;
              break;
            }
          } catch {
            /* not json line */
          }
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({
        sessionId,
        stdout,
        stderr,
        exitCode: code,
        durationMs: Date.now() - start,
      });
    });
  });
}

/** Resume a sub-thread by session_id with a follow-up prompt. */
export async function resumeSubthread(
  sessionId: string,
  prompt: string,
  opts: { cwd?: string; mcpConfigPath?: string; timeoutMs?: number } = {},
): Promise<SubthreadResult> {
  return spawnClaudeSubthread(["--resume", sessionId, "-p", prompt], opts);
}

/**
 * Reads the recorder log (jsonl) and asserts an entry exists for the given session_id
 * and turn index. Returns the entry or throws.
 *
 * Honesty note: coltrane's MemoryLedger doesn't persist by default, so this assertion
 * may always fail until coltrane wires a file-backed recorder for sub-thread turns.
 * That's the RED diagnosis we expect.
 */
export function assertRecorderCapturedTurn(
  tempDir: string,
  sessionId: string,
  turnIdx: number,
): Record<string, unknown> {
  const recorderPath = join(tempDir, ".coltrane-recorder.jsonl");
  if (!existsSync(recorderPath)) {
    throw new Error(`recorder log not found at ${recorderPath}`);
  }
  const lines = readFileSync(recorderPath, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.session_id === sessionId && entry.turn_idx === turnIdx) {
        return entry;
      }
    } catch {
      /* skip malformed */
    }
  }
  throw new Error(
    `recorder did not capture session=${sessionId} turn=${turnIdx} (found ${lines.length} total entries)`,
  );
}

/** Stable hash of a recorder log, ignoring timestamp fields (for reproducibility checks). */
export function hashRecorderIgnoringTimestamps(recorderPath: string): string {
  if (!existsSync(recorderPath)) return "EMPTY";
  const lines = readFileSync(recorderPath, "utf-8").split("\n").filter(Boolean);
  const stripped: unknown[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      delete e.started_at;
      delete e.finished_at;
      delete e.timestamp;
      delete e.ts;
      stripped.push(e);
    } catch {
      stripped.push({ raw: line });
    }
  }
  return createHash("sha256").update(JSON.stringify(stripped)).digest("hex");
}

/** Parses stream-json stdout into an array of events. */
export function parseStreamJson(stdout: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* non-json */
    }
  }
  return out;
}

/** Extract assistant text output from a stream-json event list. */
export function assistantText(events: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const ev of events) {
    if (ev.type === "assistant" && ev.message && typeof ev.message === "object") {
      const m = ev.message as { content?: Array<{ type?: string; text?: string }> };
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
        }
      }
    } else if (ev.type === "result" && typeof ev.result === "string") {
      parts.push(ev.result);
    }
  }
  return parts.join("\n");
}
