/**
 * seed_steve.ts — pre-seed a Claude Code sub-session with a curated stance.
 *
 * The simplified coltrane bootstrap: no `coltrane init`, no install flow. Just
 * `git clone + claude`. The repo's CLAUDE.md tells Claude about a single MCP
 * tool, `seed_steve`, which:
 *
 *   1. reads a curated 4-turn conversation from seeds/<lane>.jsonl
 *   2. materializes it as a real Claude Code session.jsonl on disk under
 *      ~/.claude/projects/<slug>/<new-uuid>.jsonl with proper parentUuid
 *      threading + a fresh sessionId
 *   3. returns the session_uuid so the user can `claude --resume <uuid>`
 *      and step into a sub-claude pre-loaded with the lane's stance
 *
 * Seeds are SOURCE FORMAT — a JSONL of {role, text} pairs. This module
 * compiles them into the wire format Claude Code reads at resume.
 *
 * No external deps. Pure file I/O. Errors are typed (lane-not-found returns
 * the list of available lanes so the caller can re-route).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

/** A turn in the source seed format. The lane file is one of these per line. */
export interface SeedTurn {
  role: "user" | "assistant";
  text: string;
}

/** Result of a successful seed_steve call. */
export interface SeedSteveResult {
  session_uuid: string;
  path: string;
  lane: string;
  project_slug: string;
  turns_written: number;
}

/** Thrown when the requested lane has no file in seeds/. Includes the available lanes. */
export class LaneNotFoundError extends Error {
  readonly lane: string;
  readonly available_lanes: string[];
  constructor(lane: string, available_lanes: string[]) {
    super(`seed_steve: lane "${lane}" not found. Available lanes: ${available_lanes.join(", ") || "(none)"}`);
    this.lane = lane;
    this.available_lanes = available_lanes;
    this.name = "LaneNotFoundError";
  }
}

/** Claude Code's projects-dir convention: the project's cwd path with / replaced by -. */
export function projectSlugFromCwd(cwd: string): string {
  // matches the observed layout in ~/.claude/projects/, e.g.
  //   /home/user/eir/coltrane-oss  →  -home-user-eir-coltrane-oss
  return cwd.replace(/\//g, "-");
}

/** List the lanes available in a seeds/ directory (filenames without .jsonl). */
export function listLanes(seedsDir: string): string[] {
  if (!existsSync(seedsDir)) return [];
  return readdirSync(seedsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .sort();
}

/** Read and parse a lane file into typed SeedTurn[]. Throws if a line is malformed. */
export function readLane(seedsDir: string, lane: string): SeedTurn[] {
  const path = join(seedsDir, `${lane}.jsonl`);
  if (!existsSync(path)) {
    throw new LaneNotFoundError(lane, listLanes(seedsDir));
  }
  const raw = readFileSync(path, "utf-8");
  const turns: SeedTurn[] = [];
  let lineNo = 0;
  for (const line of raw.split("\n")) {
    lineNo += 1;
    const t = line.trim();
    if (!t) continue;
    const parsed = JSON.parse(t) as { role?: string; text?: string };
    if (parsed.role !== "user" && parsed.role !== "assistant") {
      throw new Error(`seed_steve: ${path}:${lineNo} has role "${String(parsed.role)}" (must be user|assistant)`);
    }
    if (typeof parsed.text !== "string") {
      throw new Error(`seed_steve: ${path}:${lineNo} has no text field`);
    }
    turns.push({ role: parsed.role, text: parsed.text });
  }
  return turns;
}

/**
 * Compile SeedTurn[] into Claude Code's session.jsonl wire format. Threads the
 * parentUuid chain, stamps every turn with the same sessionId, fills cwd, and
 * pins a sane version string.
 *
 * Returns the array of wire-format records, ready to be JSON-stringified one
 * per line. Each turn gets its own deterministic uuid so the chain is stable
 * for the given sessionId (uuids are NOT derived — each is a fresh randomUUID
 * for the wire format Claude expects).
 */
export function compileSeedJsonl(
  turns: readonly SeedTurn[],
  opts: { sessionId: string; cwd: string; version?: string; gitBranch?: string },
): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  let parentUuid: string | null = null;
  // anchor all turns to the same wall time bucket so resume's reconstruction
  // doesn't get confused by interleaved timestamps from concurrent threads.
  const baseMs = Date.now() - turns.length * 1000;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const uuid = randomUUID();
    const ts = new Date(baseMs + i * 1000).toISOString();
    if (turn.role === "user") {
      records.push({
        parentUuid,
        isSidechain: false,
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: turn.text }],
        },
        uuid,
        timestamp: ts,
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        userType: "external",
        entrypoint: "cli",
        version: opts.version ?? "2.1.160",
        gitBranch: opts.gitBranch ?? "",
      });
    } else {
      records.push({
        parentUuid,
        isSidechain: false,
        type: "assistant",
        message: {
          model: "claude-seed-steve",
          id: `msg_seed_${uuid.slice(0, 8)}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: turn.text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        uuid,
        timestamp: ts,
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        userType: "external",
        entrypoint: "cli",
        version: opts.version ?? "2.1.160",
        gitBranch: opts.gitBranch ?? "",
        requestId: `req_seed_${uuid.slice(0, 12)}`,
      });
    }
    parentUuid = uuid;
  }
  return records;
}

/** Compute the absolute path where Claude Code expects session JSONLs to live. */
export function sessionFilePath(opts: { projectSlug: string; sessionId: string; home?: string }): string {
  const home = opts.home ?? homedir();
  return join(home, ".claude", "projects", opts.projectSlug, `${opts.sessionId}.jsonl`);
}

/**
 * The core write path: read lane → compile JSONL → write to ~/.claude/projects/.
 * Pure dependencies as inputs so it's unit-testable with a tempdir HOME.
 */
export function seedSteve(opts: {
  lane: string;
  cwd: string;
  seedsDir: string;
  home?: string;
  projectSlug?: string;
}): SeedSteveResult {
  const turns = readLane(opts.seedsDir, opts.lane);
  if (turns.length === 0) {
    throw new Error(`seed_steve: lane "${opts.lane}" parsed to zero turns — refusing to seed an empty session`);
  }
  const sessionId = randomUUID();
  const projectSlug = opts.projectSlug ?? projectSlugFromCwd(opts.cwd);
  const records = compileSeedJsonl(turns, { sessionId, cwd: opts.cwd });
  const pathArgs: { projectSlug: string; sessionId: string; home?: string } = { projectSlug, sessionId };
  if (opts.home !== undefined) pathArgs.home = opts.home;
  const targetPath = sessionFilePath(pathArgs);
  // ensure ~/.claude/projects/<slug>/ exists
  mkdirSync(join(targetPath, ".."), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(targetPath, body);
  return {
    session_uuid: sessionId,
    path: targetPath,
    lane: opts.lane,
    project_slug: projectSlug,
    turns_written: turns.length,
  };
}
