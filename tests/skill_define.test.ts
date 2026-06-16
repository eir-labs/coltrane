// skill_define — skills had NO authoring tool (load-from-disk only). This adds
// the missing write-path: define a skill through the MCP surface, persist it as
// the LOADABLE PACKAGE the loader reads (skills/<slug>/{meta.json, skill.mjs?,
// skill.md?, fixtures/*.json}), and write it through to the LIVE deps.skills so a
// gig in the same session can resolve it — same discipline as standard_compose.
// (This test once asserted a flat skills/<slug>.json was "loadable" — it was not:
// the loader reads package DIRS, so a flat file silently vanished on reload. The
// audit caught that hollow-green; this now pins the real package format.)
import { describe, it, expect } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeDeps(dir: string): ServerDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), skills: new Map(), genome_dir: dir };
}

describe("skill_define", () => {
  it("defines a skill as a loadable package + writes through to the live skills map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-skill-"));
    const deps = makeDeps(dir);

    const r = await dispatchTool("skill_define", { slug: "tight-gist", md: "One tight clause. Supplied facts only.", fixtures: [{ id: "fx1", input: { text: "x" } }] }, deps);
    expect(r.ok).toBe(true);
    expect((r.data as { skill_id: string }).skill_id).toBe("tight-gist");

    // live write-through — a gig this session can resolve it
    const live = deps.skills!.get("tight-gist");
    expect(live).toBeTruthy();
    expect((live as { md?: string }).md).toContain("tight clause");

    // persisted as the loadable PACKAGE the loader reads — meta.json + skill.md (the reasoning
    // half) + the fixture — NOT a flat skills/<slug>.json the loader skips.
    expect(existsSync(join(dir, "skills", "tight-gist", "meta.json")), "no meta.json — not a package").toBe(true);
    expect(existsSync(join(dir, "skills", "tight-gist", "skill.md")), "reasoning half not written").toBe(true);
    expect(existsSync(join(dir, "skills", "tight-gist.json")), "wrote the retired flat file").toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "skills", "tight-gist", "meta.json"), "utf8")).slug).toBe("tight-gist");
  });

  it("rejects a skill_define with no slug", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-skill-"));
    const r = await dispatchTool("skill_define", { md: "no slug here" }, makeDeps(dir));
    expect(r.ok).toBe(false);
  });
});
