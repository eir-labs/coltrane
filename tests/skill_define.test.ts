// skill_define — skills had NO authoring tool (load-from-disk only). This adds
// the missing write-path: define a skill through the MCP surface, persist it
// (non-destructively), and write it through to the LIVE deps.skills so a gig in
// the same session can resolve it — same discipline as standard_compose.
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
  it("defines a skill, persists it, and writes through to the live skills map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-skill-"));
    const deps = makeDeps(dir);

    const r = await dispatchTool("skill_define", { slug: "tight-gist", domain: "demo", md: "One tight clause. Supplied facts only." }, deps);
    expect(r.ok).toBe(true);
    expect((r.data as { skill_id: string }).skill_id).toBe("tight-gist");

    // live write-through — a gig this session can resolve it
    const live = deps.skills!.get("tight-gist");
    expect(live).toBeTruthy();
    expect((live as { md?: string }).md).toContain("tight clause");

    // persisted to disk as a loadable skills/<slug>.json
    const path = join(dir, "skills", "tight-gist.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).slug).toBe("tight-gist");
  });

  it("rejects a skill_define with no slug", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-skill-"));
    const r = await dispatchTool("skill_define", { md: "no slug here" }, makeDeps(dir));
    expect(r.ok).toBe(false);
  });
});
