// NODE < 26 IS REFUSED AT START, WHERE A COLTRANE PROCESS COULD RUN A SKILL (26 Sep 2026).
// The sovereign: "22 is no starter given lack of network controls, full stop." The floor was first
// enforced at INSTALL too (package.json preinstall → scripts/node_floor.cjs); the founder ruling of
// 26 Sep moved it to where skills run, so a library consumer on Node 24 (coltrane-ui) can install and
// import. The install laws that lived here are gone; their replacements — the install is NOT refused,
// the library imports, skill execution refuses by name — are tests/node_floor_where_skills_run.test.ts.
// What stays: the floor is set by the network grant, and every bin entry point refuses first.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { belowFloor, NODE_FLOOR } from "../src/runtime_floor.js";
import { NODE_WITH_ALLOW_NET } from "../src/skill_subprocess.js";

describe("Node < 26 is refused at start, by every bin entry point", () => {
  it("the floor is at or above the runtime that can back a network grant", () => {
    // --allow-net arrived in Node 25 (NOT 24: Node 24 rejects it as a bad option — the constant
    // was written as 24 and nothing probed it; the non-author review of #552 caught it).
    expect(NODE_WITH_ALLOW_NET).toBe(25);
    expect(NODE_FLOOR).toBeGreaterThanOrEqual(NODE_WITH_ALLOW_NET);
  });

  it("THIS runtime accepts --allow-net — probed, not read from a constant", () => {
    // The constant said 24 and was wrong: Node 24 rejects --allow-net as a bad option. So the
    // running runtime is asked directly. (The fetch-level proof — ungranted denied, granted
    // allowed — lives in tests/security/skill_network_grant.spec.ts, the band that may open a
    // socket; the root suite may not import a network module.)
    const r = spawnSync(process.execPath, ["--permission", "--allow-net", "-e", "0"], { encoding: "utf8" });
    expect(r.status, `this Node (${process.versions.node}) rejected --allow-net: ${r.stderr}`).toBe(0);
  });

  it("the start check refuses 22, 24 and 25 and admits 26", () => {
    expect(belowFloor("22.9.0")).toBe(true);
    expect(belowFloor("24.21.0")).toBe(true);
    expect(belowFloor("25.9.0")).toBe(true);
    expect(belowFloor("26.0.0")).toBe(false);
  });

  it("every entry point imports the start check first", () => {
    for (const f of ["src/cli_entry.ts", "src/server_entry.ts"]) {
      const firstImport = readFileSync(new URL(`../${f}`, import.meta.url), "utf8").match(/^import .*$/m)?.[0] ?? "";
      expect(firstImport, `${f}'s first import is not the floor check`).toMatch(/runtime_floor\.js/);
    }
  });
});
