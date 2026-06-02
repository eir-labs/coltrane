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
 * The harness pre-generates a session_id and pins Claude to it (--session-id) so
 * the MCP server child receives the same id via env (COLTRANE_SESSION_ID) and
 * its recorder writes are keyed on it. Resume calls reuse the original sid.
 */
export async function spawnClaudeSubthread(
  args: string[],
  opts: { cwd?: string; mcpConfigPath?: string; timeoutMs?: number; sessionId?: string; parentSessionId?: string; apiVersion?: string } = {},
): Promise<SubthreadResult> {
  const fullArgs = [...args];
  const isResume = args.includes("--resume");
  // Pin a session id for non-resume invocations so the MCP server child can be
  // wired with the same id via env (otherwise we'd lose the seam between Claude's
  // assigned session and the recorder's session key).
  const pinnedSid = opts.sessionId ?? (isResume ? extractResumeSid(args) : randomUUID());
  if (!isResume && opts.sessionId === undefined && !args.includes("--session-id")) {
    fullArgs.push("--session-id", pinnedSid);
  }
  let effectiveMcpConfig = opts.mcpConfigPath;
  if (effectiveMcpConfig) {
    // Rewrite the mcp-config into a per-spawn copy that bakes in the session id
    // and (optionally) parent_session_id + api_version. This is how the MCP
    // server child learns which Claude session it's serving.
    effectiveMcpConfig = writePerSpawnMcpConfig(effectiveMcpConfig, {
      session_id: pinnedSid,
      parent_session_id: opts.parentSessionId,
      api_version: opts.apiVersion,
    });
    fullArgs.push("--mcp-config", effectiveMcpConfig, "--strict-mcp-config");
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
  opts: { cwd?: string; mcpConfigPath?: string; timeoutMs?: number; parentSessionId?: string; apiVersion?: string } = {},
): Promise<SubthreadResult> {
  return spawnClaudeSubthread(["--resume", sessionId, "-p", prompt], {
    ...opts,
    sessionId,
  });
}

function extractResumeSid(args: readonly string[]): string {
  const i = args.indexOf("--resume");
  if (i >= 0 && i + 1 < args.length) return args[i + 1]!;
  return randomUUID();
}

/**
 * Write a per-spawn mcp-config that injects COLTRANE_SESSION_ID + optional
 * COLTRANE_PARENT_SESSION_ID + COLTRANE_API_VERSION into every server's env. We
 * do this per spawn (not once at setup) because each Claude invocation gets its
 * own session id; the MCP server needs that id to key its recorder writes.
 */
function writePerSpawnMcpConfig(
  baseConfigPath: string,
  inject: { session_id: string; parent_session_id?: string | undefined; api_version?: string | undefined },
): string {
  const base = JSON.parse(readFileSync(baseConfigPath, "utf-8")) as { mcpServers: Record<string, { env?: Record<string, string> } & Record<string, unknown>> };
  const next = { ...base, mcpServers: { ...base.mcpServers } };
  for (const [name, def] of Object.entries(next.mcpServers)) {
    const baseEnv = (def.env ?? {}) as Record<string, string>;
    const env: Record<string, string> = {
      ...baseEnv,
      COLTRANE_SESSION_ID: inject.session_id,
    };
    if (!env["COLTRANE_RECORDER_PATH"] && baseEnv["COLTRANE_GENOME"]) {
      env["COLTRANE_RECORDER_PATH"] = join(baseEnv["COLTRANE_GENOME"]!, ".coltrane-recorder.jsonl");
    }
    if (inject.parent_session_id) env["COLTRANE_PARENT_SESSION_ID"] = inject.parent_session_id;
    if (inject.api_version) env["COLTRANE_API_VERSION"] = inject.api_version;
    next.mcpServers[name] = { ...def, env };
  }
  const outPath = baseConfigPath.replace(/\.json$/, "") + `.spawn-${randomUUID().slice(0, 8)}.json`;
  writeFileSync(outPath, JSON.stringify(next, null, 2));
  return outPath;
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

/**
 * Stable hash scoped to deterministic provenance fields only — excludes session_id
 * (varies per Claude session), timestamps, and observability payloads. Two runs
 * over the same source tree with the same prompt should produce equal hashes when
 * the model's tool-call sequence is also identical.
 */
export function hashRecorderDeterministicFields(recorderPath: string): string {
  if (!existsSync(recorderPath)) return "EMPTY";
  const lines = readFileSync(recorderPath, "utf-8").split("\n").filter(Boolean);
  const scoped: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      scoped.push({
        turn_idx: e["turn_idx"],
        api_version: e["api_version"],
        genome_hash: e["genome_hash"],
        run_fingerprint: e["run_fingerprint"],
        tool_call_sequence: e["tool_call_sequence"],
        parent_present: e["parent_session_id"] !== null && e["parent_session_id"] !== undefined,
      });
    } catch {
      /* skip malformed */
    }
  }
  if (scoped.length === 0) return "EMPTY";
  scoped.sort((a, b) => (Number(a["turn_idx"]) - Number(b["turn_idx"])));
  return createHash("sha256").update(JSON.stringify(scoped)).digest("hex");
}

/** True iff the recorder file contains any api_version_mismatch error entry. */
export function recorderContainsApiVersionMismatch(recorderPath: string): boolean {
  if (!existsSync(recorderPath)) return false;
  const lines = readFileSync(recorderPath, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      const err = e["error"];
      if (typeof err === "string" && err.toLowerCase().includes("api_version_mismatch")) return true;
    } catch {
      /* skip */
    }
  }
  return false;
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
