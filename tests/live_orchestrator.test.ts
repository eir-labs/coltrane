// orchestrator tests — discover + spawn + restart-on-crash semantics,
// using a stub spawner that returns an EventEmitter mimicking ChildProcess.

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootOrchestrator, discoverSteves } from "../src/live/orchestrator.js";
import { materializeScaffold } from "../src/live/scaffold.js";

function makeFakeChild(): EventEmitter & {
  pid: number;
  kill: (sig?: string) => boolean;
  stdout: null;
  stderr: null;
} {
  const ee = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: (sig?: string) => boolean;
    stdout: null;
    stderr: null;
  };
  ee.pid = Math.floor(Math.random() * 100000);
  ee.kill = () => true;
  ee.stdout = null;
  ee.stderr = null;
  return ee;
}

describe("discoverSteves", () => {
  it("returns empty when .coltrane is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-disc-"));
    const specs = await discoverSteves(dir, {});
    expect(specs).toEqual([]);
  });

  it("reads seed.json + binds env tokens by 1-based index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-disc-"));
    await materializeScaffold({
      root: dir,
      uuids: ["a", "b", "c", "d"],
    });
    const env = {
      SLACK_BOT_TOKEN_1: "xoxb-1",
      SLACK_APP_TOKEN_1: "xapp-1",
      SLACK_BOT_TOKEN_2: "xoxb-2",
      SLACK_APP_TOKEN_2: "xapp-2",
      SLACK_BOT_TOKEN_3: "xoxb-3",
      SLACK_APP_TOKEN_3: "xapp-3",
      SLACK_BOT_TOKEN_4: "xoxb-4",
      SLACK_APP_TOKEN_4: "xapp-4",
    };
    const specs = await discoverSteves(dir, env);
    expect(specs).toHaveLength(4);
    expect(specs.map((s) => s.steve_uuid).sort()).toEqual(["a", "b", "c", "d"]);
    const first = specs[0]!;
    expect(first.bot_token).toBe("xoxb-1");
    expect(first.app_token).toBe("xapp-1");
  });

  it("returns empty-string tokens when env vars are missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-disc-"));
    await materializeScaffold({ root: dir, uuids: ["a", "b", "c", "d"] });
    const specs = await discoverSteves(dir, {});
    expect(specs[0]!.bot_token).toBe("");
    expect(specs[0]!.app_token).toBe("");
  });
});

describe("bootOrchestrator", () => {
  it("spawns one child per steve and records lifecycle to the log sink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-orch-"));
    await materializeScaffold({ root: dir, uuids: ["a", "b", "c", "d"] });
    const bookPath = join(dir, "CLAUDE.md");
    await writeFile(bookPath, "# book\n", "utf8");

    const children: EventEmitter[] = [];
    const spawner = vi.fn(() => {
      const child = makeFakeChild();
      children.push(child);
      return child as never;
    });

    const logs: string[] = [];
    const handle = await bootOrchestrator({
      root: dir,
      book_path: bookPath,
      env: {},
      spawner: spawner as never,
      worker_command: "/bin/true",
      worker_args: [],
      log_sink: async (line) => {
        logs.push(line);
      },
    });

    expect(spawner).toHaveBeenCalledTimes(4);
    expect(handle.steves).toHaveLength(4);
    const events = logs.map((l) => JSON.parse(l).event);
    expect(events).toContain("discover");
    expect(events.filter((e) => e === "child_spawn")).toHaveLength(4);

    await handle.shutdown();
    expect(logs.some((l) => JSON.parse(l).event === "shutdown")).toBe(true);
  });

  it("restarts a child on non-zero exit (bounded)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-orch-"));
    await materializeScaffold({ root: dir, uuids: ["a", "b", "c", "d"] });
    const bookPath = join(dir, "CLAUDE.md");
    await writeFile(bookPath, "# book\n", "utf8");

    let spawnCount = 0;
    const spawner = vi.fn(() => {
      spawnCount++;
      const child = makeFakeChild();
      return child as never;
    });

    const logs: string[] = [];
    const handle = await bootOrchestrator({
      root: dir,
      book_path: bookPath,
      env: {},
      spawner: spawner as never,
      worker_command: "/bin/true",
      worker_args: [],
      max_restarts: 2,
      log_sink: async (line) => {
        logs.push(line);
      },
    });

    expect(spawnCount).toBe(4);
    // crash the first steve once
    const firstChild = handle.steves[0]!.child as unknown as EventEmitter;
    firstChild.emit("exit", 1, null);
    // give the synchronous emit a tick to propagate restart spawn
    await new Promise((res) => setTimeout(res, 5));
    expect(spawnCount).toBe(5);

    await handle.shutdown();
  });

  it("does not restart on clean exit (code 0)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-orch-"));
    await materializeScaffold({ root: dir, uuids: ["a", "b", "c", "d"] });
    const bookPath = join(dir, "CLAUDE.md");
    await writeFile(bookPath, "# book\n", "utf8");

    let spawnCount = 0;
    const spawner = vi.fn(() => {
      spawnCount++;
      return makeFakeChild() as never;
    });

    const logs: string[] = [];
    const handle = await bootOrchestrator({
      root: dir,
      book_path: bookPath,
      env: {},
      spawner: spawner as never,
      worker_command: "/bin/true",
      worker_args: [],
      log_sink: async (line) => {
        logs.push(line);
      },
    });

    const firstChild = handle.steves[0]!.child as unknown as EventEmitter;
    firstChild.emit("exit", 0, null);
    await new Promise((res) => setTimeout(res, 5));
    expect(spawnCount).toBe(4); // no restart

    await handle.shutdown();
  });
});

describe("integration: scaffold → discover", () => {
  it("end-to-end: scaffold produces dirs discover can read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-e2e-"));
    await mkdir(join(dir, "coltrane"), { recursive: true });
    await materializeScaffold({ root: dir });
    const specs = await discoverSteves(dir, {});
    expect(specs).toHaveLength(4);
    expect(new Set(specs.map((s) => s.steve_uuid)).size).toBe(4); // unique
  });
});
