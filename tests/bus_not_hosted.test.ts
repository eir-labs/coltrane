// THE BUS IS NOT A HOSTED TOOL.
//
// bus_post / bus_read / bus_owed (wiki spec.coltrane-bus) put the local JSONL bus on the MCP surface
// so a Claude Code session on THIS machine is a member of the bus `coltrane chat` uses. The bus is a
// file under the server's own home (COLTRANE_BUS_DIR, default ~/.eir/bus). On a hosted route that is
// the HOST's home directory, shared by every org the host serves, with no org scope at all. The
// non-author grade of coltrane-ui #252 called them on a hosted surface: each returned ok:true and
// wrote under the server's home. They were never added to HOSTED_BLOCKED (src/server.ts), which is
// where every other local-process tool (skill_execute, gig_logs, charter_read…) refuses by name.
//
// The laws drive the real hosted surface — createToolSurface({... hosted: true}) — with HOME pointed at
// an empty temp directory and COLTRANE_BUS_DIR unset (the default path, the one that leaked), and
// assert both halves: a typed refusal naming the tool, and NOTHING created on disk.
//
//   law  kind         drives                                                  plant (smallest production edit → red)
//   B1   behavioural  createToolSurface({hosted}).bus_post — src/server.ts   (red today) · after: drop bus_post from HOSTED_BLOCKED
//   B2   behavioural  createToolSurface({hosted}).bus_read — src/server.ts   (red today) · after: drop bus_read from HOSTED_BLOCKED
//   B3   behavioural  createToolSurface({hosted}).bus_owed — src/server.ts   (red today) · after: drop bus_owed from HOSTED_BLOCKED
//   B4   behavioural  createToolSurface({local}).bus_* — src/server.ts       apply the hosted refusal on every surface (drop the `deps.hosted` guard)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createToolSurface, type ToolSurfaceDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";

let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["HOME", "COLTRANE_BUS_DIR"]) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), "bus-hosted-home-"));
  process.env["HOME"] = home;
  delete process.env["COLTRANE_BUS_DIR"];
  // The seam must land, or "nothing was written here" is a comfortable pass about the wrong place.
  expect(homedir(), "HOME redirect did not take — the no-write assertion would watch the wrong directory").toBe(home);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(home, { recursive: true, force: true });
});

const surface = (hosted: boolean) => {
  const registry = createRegistry();
  const deps: ToolSurfaceDeps = { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), gig_runs: new Map(), hosted };
  const tools = createToolSurface(deps);
  return (name: string) => tools.find((t) => t.name === name)!;
};

/** Everything under the temp HOME, recursively — must stay empty on the hosted surface. */
const written = (): string[] => readdirSync(home, { recursive: true }).map(String);

const ARGS: Record<string, Record<string, unknown>> = {
  bus_post: { bus: "coltrane", as: "hosted-caller", text: "@eugene hello from a hosted route" },
  bus_read: { bus: "coltrane", as: "hosted-caller" },
  bus_owed: { bus: "coltrane", as: "hosted-caller" },
};

describe("the bus verbs refuse on the hosted surface, by name, and write nothing", () => {
  for (const [n, slug] of [["B1", "bus_post"], ["B2", "bus_read"], ["B3", "bus_owed"]] as const) {
    it(`${n} — hosted ${slug} is refused (hosted_unsupported, naming ${slug}) and creates nothing on disk`, async () => {
      const r = await surface(true)(slug).call(ARGS[slug]!);
      expect(r.ok, `hosted ${slug} answered ok:true — the bus leaked onto the hosted route`).toBe(false);
      expect(r.hosted_unsupported, `hosted ${slug} was not refused as a local-process tool`).toBe(true);
      expect(String(r.error), `the refusal does not name ${slug}`).toMatch(new RegExp(slug));
      expect(written(), `hosted ${slug} wrote under the server's home`).toEqual([]);
    });
  }
});

describe("B4 — control: the local surface keeps the bus", () => {
  it("bus_post lands on the default bus file, bus_owed lists the tagged line, bus_read returns it", async () => {
    const tool = surface(false);
    const posted = await tool("bus_post").call({ bus: "coltrane", as: "eugene", text: "@claude-chair take it?" });
    expect(posted.ok, String(posted.error)).toBe(true);
    expect(existsSync(join(home, ".eir", "bus", "coltrane.jsonl")), "the local bus did not write its file").toBe(true);
    const owed = await tool("bus_owed").call({ bus: "coltrane", as: "claude-chair" });
    expect(owed.ok, String(owed.error)).toBe(true);
    expect((owed.data as { lines: Array<{ text: string }> }).lines.map((l) => l.text)).toEqual(["@claude-chair take it?"]);
    const read = await tool("bus_read").call({ bus: "coltrane", as: "claude-chair" });
    expect(read.ok, String(read.error)).toBe(true);
    expect((read.data as { lines: Array<{ text: string }> }).lines.map((l) => l.text)).toEqual(["@claude-chair take it?"]);
  });
});
