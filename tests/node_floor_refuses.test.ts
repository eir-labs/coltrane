// NODE < 24 IS REFUSED — at install and at start, not warned about (26 Sep 2026).
// `engines` is advisory; npm installs anyway. The sovereign: "22 is no starter given lack of
// network controls, full stop." So the install refuses (package.json preinstall →
// scripts/node_floor.cjs) and every entry point refuses (src/runtime_floor.ts, imported first).
// Each law drives the real check with a Node version it must refuse, and one it must accept.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { belowFloor, NODE_FLOOR } from "../src/runtime_floor.js";
import { NODE_WITH_ALLOW_NET } from "../src/skill_subprocess.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const asNode = (v: string) =>
  spawnSync(process.execPath, ["-e",
    `Object.defineProperty(process,'versions',{value:{...process.versions,node:${JSON.stringify(v)}}});require('./scripts/node_floor.cjs')`],
    { cwd: ROOT, encoding: "utf8" });

describe("Node < 24 is refused at install and at start", () => {
  it("the floor is the runtime that can back a network grant", () => {
    expect(NODE_FLOOR).toBe(NODE_WITH_ALLOW_NET);
  });

  it("install refuses Node 22 and 23, naming the reason", () => {
    for (const v of ["22.9.0", "23.11.1"]) {
      const r = asNode(v);
      expect(r.status, `install accepted Node ${v}`).toBe(1);
      expect(r.stderr).toMatch(/requires Node 24 or newer/);
      expect(r.stderr).toMatch(/--allow-net/);
    }
  });

  it("install accepts Node 24 and newer", () => {
    for (const v of ["24.0.0", "26.1.0"]) expect(asNode(v).status, `install refused Node ${v}`).toBe(0);
  });

  it("the install check is wired: preinstall runs it and the package ships it", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as
      { scripts: Record<string, string>; files: string[] };
    expect(pkg.scripts.preinstall).toBe("node scripts/node_floor.cjs");
    expect(pkg.files).toContain("scripts/node_floor.cjs");
  });

  it("the start check agrees with the install check", () => {
    expect(belowFloor("22.9.0")).toBe(true);
    expect(belowFloor("23.11.1")).toBe(true);
    expect(belowFloor("24.0.0")).toBe(false);
  });

  it("every entry point imports the start check first", () => {
    for (const f of ["src/cli_entry.ts", "src/server_entry.ts"]) {
      const firstImport = readFileSync(new URL(`../${f}`, import.meta.url), "utf8").match(/^import .*$/m)?.[0] ?? "";
      expect(firstImport, `${f}'s first import is not the floor check`).toMatch(/runtime_floor\.js/);
    }
  });
});
