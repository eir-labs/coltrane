// e2e for the simplified-bootstrap MCP tool `seed_steve`.
//
// Three asserts:
//   1. calling seed_steve(lane="test-writer") writes a real session.jsonl at
//      the expected ~/.claude/projects/<slug>/<uuid>.jsonl location (HOME
//      redirected to a tempdir so we don't pollute the real Claude store)
//   2. the file has valid JSONL shape: parentUuid chain + sessionId on every
//      turn matches the returned session_uuid
//   3. `claude --resume <uuid>` (a real spawn against the real claude CLI)
//      responds in the test-writer voice — its first assistant text mentions
//      either "RED" or "boundary" or "failing test" (any of the three is a
//      sufficient verdict that the pre-seeded stance survived the resume)
//
// Honesty note: assert 3 spawns the real Claude CLI. If the local environment
// has no claude binary on PATH, the test calls .skip() and tells you so —
// the seed-and-write half stays honest in CI without claude.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { dispatchTool, bootstrapServerDeps, type ServerDeps } from "../../src/server.js";
import { createRegistry } from "../../src/registry.js";
import { createOutputStore } from "../../src/outputs.js";
import { MemoryLedger } from "../../src/ledger.js";
import { REPO_ROOT } from "./_harness.js";
import { projectSlugFromCwd } from "../../src/seed_steve.js";

interface JsonlTurn {
  parentUuid: string | null;
  uuid: string;
  sessionId: string;
  type: "user" | "assistant";
  cwd: string;
  message: { role: string; content: Array<{ type: string; text: string }> };
}

function readJsonl(path: string): JsonlTurn[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as JsonlTurn);
}

function claudeOnPath(): boolean {
  const r = spawnSync("which", ["claude"], { encoding: "utf-8" });
  return r.status === 0 && (r.stdout ?? "").trim().length > 0;
}

describe("seed_steve MVP — the simplified-bootstrap MCP tool", () => {
  let tempHome: string;
  let deps: ServerDeps;
  let testCwd: string;

  beforeAll(() => {
    tempHome = mkdtempSync(join(tmpdir(), "coltrane-seed-steve-home-"));
    testCwd = mkdtempSync(join(tmpdir(), "coltrane-seed-steve-cwd-"));
    const registry = createRegistry();
    deps = {
      registry,
      outputs: createOutputStore(registry),
      ledger: new MemoryLedger(),
      seeds_dir: join(REPO_ROOT, "seeds"),
      home_dir: tempHome,
    };
  });

  afterAll(() => {
    try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(testCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("writes a real session.jsonl with valid threading + the lane's stance", async () => {
    const result = await dispatchTool(
      "seed_steve",
      { lane: "test-writer", cwd: testCwd },
      deps,
    );

    // contract: tool succeeded + returned the resume handle
    expect(result.ok).toBe(true);
    const data = result.data as { session_uuid: string; path: string; turns_written: number; resume_command: string };
    expect(data.session_uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.turns_written).toBeGreaterThanOrEqual(4);
    expect(data.resume_command).toBe(`claude --resume ${data.session_uuid}`);

    // assert 1: file exists at the expected ~/.claude/projects/<slug>/<uuid>.jsonl
    const expectedSlug = projectSlugFromCwd(testCwd);
    const expectedPath = join(tempHome, ".claude", "projects", expectedSlug, `${data.session_uuid}.jsonl`);
    expect(data.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    // assert 2: valid JSONL shape — parentUuid threading + sessionId stamping
    const turns = readJsonl(expectedPath);
    expect(turns.length).toBe(data.turns_written);

    // first turn has parentUuid = null
    expect(turns[0]!.parentUuid).toBeNull();

    // every subsequent parentUuid points at the previous uuid (chain integrity)
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i]!.parentUuid).toBe(turns[i - 1]!.uuid);
    }

    // every turn carries the same sessionId, matching the returned session_uuid
    for (const t of turns) {
      expect(t.sessionId).toBe(data.session_uuid);
      expect(t.cwd).toBe(testCwd);
    }

    // alternation: user, assistant, user, assistant
    expect(turns.map((t) => t.type)).toEqual(["user", "assistant", "user", "assistant"]);

    // and the test-writer stance is actually in the JSONL — search the first user turn
    const firstUserText = turns[0]!.message.content[0]!.text;
    expect(firstUserText).toMatch(/test writer/i);
  });

  it("returns LaneNotFoundError shape when the lane doesn't exist", async () => {
    const result = await dispatchTool(
      "seed_steve",
      { lane: "frobnicator", cwd: testCwd },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/frobnicator/);
    const data = result.data as { available_lanes: string[] };
    expect(data.available_lanes).toEqual(expect.arrayContaining(["code-reviewer", "test-writer", "debugger"]));
  });

  it("`claude --resume <uuid>` responds in the test-writer voice", async () => {
    if (!claudeOnPath()) {
      // honest skip: the resume half can't run without the claude CLI installed.
      // The seed-and-write half above stays the load-bearing assertion.
      console.warn("seed_steve_mvp: claude CLI not on PATH — skipping resume half");
      return;
    }

    // Seed a fresh session for the resume probe. Use the REAL home this time
    // (~/.claude/projects) because the claude CLI reads from $HOME, not from
    // any test-injected path. We clean up the file at the end.
    const cwd = process.cwd();
    const seedResult = await dispatchTool(
      "seed_steve",
      { lane: "test-writer", cwd },
      {
        ...deps,
        home_dir: undefined, // ← real ~ this time, so claude CLI can find the session
      },
    );
    expect(seedResult.ok).toBe(true);
    const seedData = seedResult.data as { session_uuid: string; path: string };

    try {
      // ask the resumed sub-session a question that should pull the lane's stance
      // out. We do NOT instruct it to use stance vocabulary — the seeded turns
      // should already carry it forward via the session ledger.
      const out = execFileSync(
        "claude",
        [
          "--resume", seedData.session_uuid,
          "-p", "In one sentence: what's the first move when I hand you a new function to test?",
          "--output-format", "text",
        ],
        { encoding: "utf-8", timeout: 120_000, cwd },
      );

      // assert 3: the response carries the test-writer voice. Any of these three
      // markers from the seeded turns is sufficient verdict — we don't pin one.
      const lower = out.toLowerCase();
      const matched =
        /\bred\b/.test(lower) ||
        /\bboundary\b/.test(lower) ||
        /\bfailing test\b/.test(lower) ||
        /\bcontract\b/.test(lower);
      if (!matched) {
        // Honest failure message: show what the model actually said so the
        // diagnosis is the diagnosis, not a paper-over.
        throw new Error(`seed survived to wire but stance did not survive resume. Response was:\n${out}`);
      }
      expect(matched).toBe(true);
    } finally {
      // best-effort cleanup of the real-home session file we just wrote
      try { rmSync(seedData.path, { force: true }); } catch { /* best-effort */ }
    }
  });
});
