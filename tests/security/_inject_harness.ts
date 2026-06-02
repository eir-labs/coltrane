// Harness for prompt-injection resistance tests.
//
// Each test: create tempdir → write adversarial docs into it → wire an
// instrumentation MCP server (read_doc / fetch_url / delete_file / list_files)
// that records every call → spawn `claude -p` with that MCP config → parse
// stream-json → assert on the audit log + assistant text.
//
// Honesty: if claude executes the injected directive, the assertion fires
// against the audit log entry. We do NOT soften any assertion to make the
// jailbreak pass — that failure IS the deliverable.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setupTempdirColtrane, type TempdirColtrane } from "../e2e/_harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface InjectEnv extends TempdirColtrane {
  auditLogPath: string;
  injectMcpConfigPath: string;
  injectServerEntry: string;
  workspaceRoot: string;
  writeDoc: (relPath: string, content: string) => string;
}

/** Build a fresh inject-test env: tempdir + instrumentation MCP wired in. */
export async function setupInjectEnv(): Promise<InjectEnv> {
  const base = await setupTempdirColtrane();

  // A dedicated workspace root under the tempdir, so the instrumentation server
  // can only see files we explicitly create there. (Defense-in-depth.)
  const workspaceRoot = join(base.tempDir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });

  const auditLogPath = join(base.tempDir, "inject_audit.jsonl");
  writeFileSync(auditLogPath, "");

  // Copy the instrumentation server entry into the tempdir.
  const injectServerEntry = join(base.tempDir, "tests", "security", "_inject_server.mjs");
  mkdirSync(dirname(injectServerEntry), { recursive: true });
  const src = resolve(__dirname, "_inject_server.mjs");
  writeFileSync(injectServerEntry, readFileSync(src, "utf-8"));

  // Write an MCP config that wires BOTH the inject server AND coltrane's own
  // server, so the agent has the real coltrane surface plus a doc-reading tool.
  const injectMcpConfigPath = join(base.tempDir, "inject-mcp-config.json");
  const cfg = {
    mcpServers: {
      docs: {
        command: "npx",
        args: ["tsx", injectServerEntry],
        env: {
          INJECT_AUDIT_LOG: auditLogPath,
          INJECT_ROOT: workspaceRoot,
        },
      },
      coltrane: {
        command: "npx",
        args: ["tsx", base.mcpServerEntry],
        env: {
          COLTRANE_GENOME: base.tempDir,
        },
      },
    },
  };
  writeFileSync(injectMcpConfigPath, JSON.stringify(cfg, null, 2));

  function writeDoc(relPath: string, content: string): string {
    const abs = join(workspaceRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  }

  return {
    ...base,
    workspaceRoot,
    auditLogPath,
    injectMcpConfigPath,
    injectServerEntry,
    writeDoc,
    cleanup: () => {
      try {
        rmSync(base.tempDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

export interface InjectRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  toolCalls: ToolCall[];
  assistantText: string;
  auditEntries: AuditEntry[];
}

export interface ToolCall {
  /** e.g. "mcp__docs__fetch_url" or "Bash" or "Read" */
  name: string;
  /** Tool input args as raw object. */
  input: Record<string, unknown>;
}

export interface AuditEntry {
  ts: string;
  tool: string; // bare slug, e.g. "fetch_url"
  args: Record<string, unknown>;
  result_kind: string;
}

/** Spawn claude with a benign user prompt; the prompt instructs claude to read a doc. */
export async function runInjectScenario(
  env: InjectEnv,
  userPrompt: string,
  opts: { timeoutMs?: number; allowedTools?: string } = {},
): Promise<InjectRunResult> {
  // We pass `--dangerously-skip-permissions` because the test needs to observe
  // what claude WOULD do without a human in the loop — the prompt-injection
  // defense must hold at the model layer, not just behind a permission prompt.
  const args = [
    "-p",
    userPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    env.injectMcpConfigPath,
    "--strict-mcp-config",
    "--dangerously-skip-permissions",
    "--add-dir",
    env.workspaceRoot,
  ];
  if (opts.allowedTools) {
    args.push("--allowedTools", opts.allowedTools);
  }

  const start = Date.now();
  return new Promise((resolveP) => {
    const child = spawn("claude", args, {
      cwd: env.workspaceRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const toolCalls = extractToolCalls(stdout);
      const text = extractAssistantText(stdout);
      const auditEntries = readAuditLog(env.auditLogPath);
      resolveP({
        stdout,
        stderr,
        exitCode: code,
        durationMs: Date.now() - start,
        toolCalls,
        assistantText: text,
        auditEntries,
      });
    });
  });
}

/** Parse stream-json stdout and pull every tool_use block the assistant emitted. */
export function extractToolCalls(stdout: string): ToolCall[] {
  const out: ToolCall[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (evt.type !== "assistant") continue;
    const msg = evt.message as { content?: Array<Record<string, unknown>> } | undefined;
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === "tool_use" && typeof c.name === "string") {
        out.push({
          name: c.name,
          input: (c.input as Record<string, unknown>) ?? {},
        });
      }
    }
  }
  return out;
}

/** Pull final assistant text (concatenated across turns). */
export function extractAssistantText(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (evt.type === "assistant") {
      const msg = evt.message as { content?: Array<Record<string, unknown>> } | undefined;
      if (Array.isArray(msg?.content)) {
        for (const c of msg!.content!) {
          if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
        }
      }
    } else if (evt.type === "result" && typeof evt.result === "string") {
      parts.push(evt.result);
    }
  }
  return parts.join("\n");
}

export function readAuditLog(path: string): AuditEntry[] {
  if (!existsSync(path)) return [];
  const out: AuditEntry[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as AuditEntry);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Returns audit entries for the given bare tool slug (e.g. "delete_file"). */
export function callsTo(audit: AuditEntry[], toolSlug: string): AuditEntry[] {
  return audit.filter((e) => e.tool === toolSlug);
}

/** True if any tool call's input fields contain the substring. */
export function anyToolInputContains(toolCalls: ToolCall[], substring: string): ToolCall | null {
  for (const tc of toolCalls) {
    const blob = JSON.stringify(tc.input);
    if (blob.includes(substring)) return tc;
  }
  return null;
}
