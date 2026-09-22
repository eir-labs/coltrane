// CODE TOOLS — the engine's own hands for changing code, so a chair on ANY model can read, search and
// patch its repo and run its laws (wiki spec.coltrane-bus: toward coltrane editing itself). The same
// guarantees Claude Code's tools give, owned by the engine and confined to one tree:
//   - no path reaches outside the root (`..`, absolute, or a symlink that points out);
//   - secrets and git internals are never read or written (.env*, secrets/, .git/);
//   - a patch replaces text that occurs EXACTLY once, or changes nothing and says why;
//   - the only command is running laws, and only a file under tests/.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeTools } from "../src/code_tools.js";

function tree() {
  const root = mkdtempSync(join(tmpdir(), "coltrane-code-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "tests"));
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\nexport const b = 1;\n");
  writeFileSync(join(root, "tests", "a.test.ts"), "// law\n");
  writeFileSync(join(root, ".env"), "SECRET=x\n");
  writeFileSync(join(root, "node_modules", "dep", "x.ts"), "export const a = 1;\n");
  const outside = mkdtempSync(join(tmpdir(), "coltrane-outside-"));
  writeFileSync(join(outside, "private.txt"), "not yours\n");
  symlinkSync(outside, join(root, "src", "link"));
  return { root, outside };
}
const ok = (r: unknown) => (r as { ok: boolean }).ok;
const err = (r: unknown) => String((r as { error?: string }).error ?? "");

describe("code tools", () => {
  it("CT1 — read inside the root; nothing outside it, by .., absolute path, or symlink", async () => {
    const { root, outside } = tree();
    const t = codeTools({ root });
    const r = await t.call("mcp__coltrane__code_read", { path: "src/a.ts" });
    expect(ok(r)).toBe(true);
    expect((r as unknown as { data: { text: string } }).data.text).toContain("export const a = 1;");
    for (const path of ["../x", join(outside, "private.txt"), "src/link/private.txt"]) {
      const bad = await t.call("mcp__coltrane__code_read", { path });
      expect(ok(bad), `read ${path} escaped the root`).toBe(false);
    }
    // An absolute path cannot escape (it resolves under the root), but the refusal must say WHY,
    // or a model keeps retrying absolute paths it believes exist.
    expect(err(await t.call("mcp__coltrane__code_read", { path: join(root, "src", "a.ts") }))).toMatch(/absolute/);
  });

  it("CT2 — secrets and git internals are refused", async () => {
    const { root } = tree();
    const t = codeTools({ root });
    expect(ok(await t.call("mcp__coltrane__code_read", { path: ".env" }))).toBe(false);
    expect(ok(await t.call("mcp__coltrane__code_patch", { path: ".git/config", old: "a", new: "b" }))).toBe(false);
  });

  it("CT3 — a patch replaces text that occurs exactly once; otherwise nothing changes and it says why", async () => {
    const { root } = tree();
    const t = codeTools({ root });
    const twice = await t.call("mcp__coltrane__code_patch", { path: "src/a.ts", old: "= 1;", new: "= 2;" });
    expect(ok(twice)).toBe(false);
    expect(err(twice)).toMatch(/2 times/);
    const none = await t.call("mcp__coltrane__code_patch", { path: "src/a.ts", old: "nope", new: "x" });
    expect(err(none)).toMatch(/not found/);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 1;\nexport const b = 1;\n");
    expect(ok(await t.call("mcp__coltrane__code_patch", { path: "src/a.ts", old: "const b = 1", new: "const b = 2" }))).toBe(true);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("const b = 2");
  });

  it("CT4 — search finds matches in the tree, and skips dependencies and build output", async () => {
    const { root } = tree();
    const r = await codeTools({ root }).call("mcp__coltrane__code_search", { pattern: "const a" });
    const hits = (r as unknown as { data: { matches: string[] } }).data.matches;
    expect(hits).toEqual(["src/a.ts:1: export const a = 1;"]);
  });

  it("CT5 — the only command is running laws, and only a file under tests/", async () => {
    const { root } = tree();
    const ran: string[] = [];
    const t = codeTools({ root, runLaws: async (file) => { ran.push(file); return { passed: true, output: "1 passed" }; } });
    expect(ok(await t.call("mcp__coltrane__code_run_laws", { file: "tests/a.test.ts" }))).toBe(true);
    expect(ok(await t.call("mcp__coltrane__code_run_laws", { file: "src/a.ts" }))).toBe(false);
    expect(ok(await t.call("mcp__coltrane__code_run_laws", { file: "tests/../src/a.ts" }))).toBe(false);
    expect(ran).toEqual(["tests/a.test.ts"]);
    const names = (await t.list()).map((d) => d.name).sort();
    expect(names).toEqual(["mcp__coltrane__code_patch", "mcp__coltrane__code_read", "mcp__coltrane__code_run_laws", "mcp__coltrane__code_search"]);
  });
});

import { unionSources } from "../src/bus_terminal.js";
describe("a chat chair's hands are the engine surface AND the code tools", () => {
  it("U1 — the union lists both, and each call reaches the source that listed it", async () => {
    const hit: string[] = [];
    const src = (tag: string, names: string[]) => ({
      list: async () => names.map((name) => ({ name, inputSchema: {} })),
      call: async (name: string) => { hit.push(`${tag}:${name}`); return { ok: true }; },
    });
    const u = unionSources([src("engine", ["mcp__coltrane__output_write"]), src("code", ["mcp__coltrane__code_patch"])]);
    expect((await u.list()).map((d) => d.name)).toEqual(["mcp__coltrane__output_write", "mcp__coltrane__code_patch"]);
    await u.call("mcp__coltrane__code_patch", {});
    await u.call("mcp__coltrane__output_write", {});
    expect(hit).toEqual(["code:mcp__coltrane__code_patch", "engine:mcp__coltrane__output_write"]);
    expect(await u.call("mcp__coltrane__nope", {})).toMatchObject({ ok: false });
  });
});
