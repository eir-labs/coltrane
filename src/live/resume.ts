// resume — open a Steve's inner thread by reattaching to its persisted
// claude-code session.
//
// The orchestrator's worker writes session.json into the Steve's dir on
// first claude-code spawn. `coltrane resume <uuid>` reads that file and
// re-execs `claude --resume <session_id>` with inherited stdio so the
// user lands directly in the inner monologue.
//
// Failure modes are explicit:
//   - session.json missing      → user-friendly "no session yet" hint
//   - session_id malformed      → reject before exec (don't shell out garbage)
//   - claude binary missing     → surface ENOENT verbatim
//
// We deliberately do not wrap the child's stdout/stderr — the user is
// driving an interactive terminal and any buffering would break that.

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";

export interface SessionRecord {
  session_id: string;
}

export interface ResumeOptions {
  /** override of the claude binary (tests / pin) */
  claude_binary?: string;
  /** spawner override — defaults to node:child_process.spawn */
  spawner?: (
    cmd: string,
    args: readonly string[],
    opts: SpawnOptions,
  ) => ChildProcess;
}

/** session_id is the claude-code session identifier (sha-ish hex / uuid).
 * We accept hex, uuid, or dash-separated hex chunks — no whitespace, no
 * shell-special chars. This is a guard against arbitrary string injection
 * if session.json is hand-edited. */
export function isValidSessionId(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(s);
}

export async function readSessionRecord(
  root: string,
  uuid: string,
): Promise<SessionRecord> {
  const path = join(root, ".coltrane", `steve_${uuid}`, "session.json");
  try {
    await access(path);
  } catch {
    throw new Error(
      `Steve ${uuid} has no session yet — run \`coltrane play --live-slack\` first`,
    );
  }
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`session.json for ${uuid} is not valid JSON`);
  }
  const sid = (parsed as { session_id?: unknown }).session_id;
  if (!isValidSessionId(sid)) {
    throw new Error(`session.json for ${uuid} has malformed session_id`);
  }
  return { session_id: sid };
}

/** Resume a Steve's inner thread. Resolves with the child's exit code
 * once the claude process exits. */
export async function resumeSteve(
  uuid: string,
  rootPath?: string,
  opts: ResumeOptions = {},
): Promise<number> {
  const root = rootPath ?? process.cwd();
  const record = await readSessionRecord(root, uuid);
  const bin = opts.claude_binary ?? "claude";
  const spawner = opts.spawner ?? spawn;

  return new Promise<number>((resolve, reject) => {
    const child = spawner(bin, ["--resume", record.session_id], {
      stdio: "inherit",
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `claude binary not found on PATH — install claude-code CLI or pass --claude-binary`,
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("exit", (code) => {
      resolve(code ?? 0);
    });
  });
}
