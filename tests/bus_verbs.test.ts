// THE BUS ON THE MCP SURFACE — so a Claude Code session (or any MCP client) can be a member of the same
// bus `coltrane chat` uses (wiki spec.coltrane-bus, "Claude Code sessions as bus members").
//
//   bus_post {bus, as, text, reply_to?}   append a line as `as`
//   bus_read {bus, as, peek?}             this member's unread lines; marks them read unless peek
//   bus_owed {bus, as}                    lines tagging this member it has not answered
//
// Same file, same rules as the terminal: a tag owes a reply only its member discharges; untagged lines
// are passive. A bus name is a plain name — it cannot reach outside the bus directory.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry, createOutputStore, MemoryLedger } from "../src/index.js";
import { openBus } from "../src/bus.js";
import { busPath } from "../src/bus_terminal.js";

let saved: string | undefined;
let dir: string;
const deps = (): ServerDeps => {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), gig_runs: new Map() };
};
const call = (slug: string, args: Record<string, unknown>) => dispatchTool(slug, args, deps());

beforeEach(() => {
  saved = process.env["COLTRANE_BUS_DIR"];
  dir = mkdtempSync(join(tmpdir(), "coltrane-busverbs-"));
  process.env["COLTRANE_BUS_DIR"] = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env["COLTRANE_BUS_DIR"]; else process.env["COLTRANE_BUS_DIR"] = saved;
});

describe("the bus verbs", () => {
  it("V1 — a line posted over MCP lands on the same bus the terminal reads", async () => {
    const r = await call("bus_post", { bus: "coltrane", as: "claude-chair", text: "@eugene PR 550 is green" });
    expect(r.ok, String(r.error)).toBe(true);
    const lines = openBus(busPath("coltrane")).read(0);
    expect(lines.map((l) => [l.author, l.text])).toEqual([["claude-chair", "@eugene PR 550 is green"]]);
    expect((r.data as { mentions: string[] }).mentions).toEqual(["eugene"]);
  });

  it("V2 — bus_read returns this member's unread lines and marks them read; peek leaves them unread", async () => {
    const bus = openBus(busPath("coltrane"));
    bus.post({ author: "eugene", text: "one" });
    bus.post({ author: "eugene", text: "two" });
    const peek = await call("bus_read", { bus: "coltrane", as: "claude-chair", peek: true });
    expect((peek.data as { lines: Array<{ text: string }> }).lines.map((l) => l.text)).toEqual(["one", "two"]);
    const read = await call("bus_read", { bus: "coltrane", as: "claude-chair" });
    expect((read.data as { lines: unknown[] }).lines.length).toBe(2);
    const again = await call("bus_read", { bus: "coltrane", as: "claude-chair" });
    expect((again.data as { lines: unknown[] }).lines).toEqual([]);
  });

  it("V3 — bus_owed lists what tags this member, until it answers through bus_post with reply_to", async () => {
    const q = openBus(busPath("coltrane")).post({ author: "eugene", text: "@claude-chair take the 402 fix?" });
    const owed = await call("bus_owed", { bus: "coltrane", as: "claude-chair" });
    expect((owed.data as { lines: Array<{ id: string }> }).lines.map((l) => l.id)).toEqual([q.id]);
    await call("bus_post", { bus: "coltrane", as: "claude-chair", text: "taking it", reply_to: q.id });
    const after = await call("bus_owed", { bus: "coltrane", as: "claude-chair" });
    expect((after.data as { lines: unknown[] }).lines).toEqual([]);
  });

  it("V4 — a bus name cannot reach outside the bus directory, and the speaker must be named", async () => {
    for (const bus of ["../escape", "a/b", "", ".hidden"]) {
      const r = await call("bus_post", { bus, as: "x", text: "t" });
      expect(r.ok, `bus name ${JSON.stringify(bus)} was accepted`).toBe(false);
    }
    expect((await call("bus_post", { bus: "coltrane", text: "anonymous" })).ok).toBe(false);
    expect((await call("bus_post", { bus: "coltrane", as: "x" })).ok).toBe(false);
  });
});
