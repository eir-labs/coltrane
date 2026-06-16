// Live acceptance — the browser tier (patent-search, caged Playwright) reaches a JS-walled search
// surface and returns candidate patent numbers, while the cage refuses an off-allowlist navigation.
// Gated behind COLTRANE_LIVE=1 (real browser, real network). RED until patent-search exists and the
// cage enforces the browser allowlist. Proves: search grounds, and the navigation cage bites.
//
// Run: COLTRANE_LIVE=1 npx vitest run --config tests/e2e/vitest.config.ts \
//   tests/e2e/patent_search_live.spec.ts
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { executeSkill } from "../../src/skill_subprocess.js";

const REPO = fileURLToPath(new URL("..", new URL("..", import.meta.url)));
const PATENT_SEARCH = join(REPO, "skills", "patent-search");
const LIVE = process.env["COLTRANE_LIVE"] === "1";

describe.skipIf(!LIVE)("patent-search live — caged browser search grounds + the nav allowlist bites", () => {
  it("a search on an allowlisted surface returns candidate patent numbers + a sealed trace", () => {
    const r = executeSkill(PATENT_SEARCH, { query: "integrity verification dynamic code hash" });
    expect(r.ok, `skill failed: ${r.error}`).toBe(true);
    const out = r.output as Record<string, unknown>;
    const candidates = (out["candidates"] as string[]) ?? [];
    expect(candidates.length, "search must return candidate patent numbers").toBeGreaterThan(0);
    expect(candidates.every((c) => /^[A-Z]{2}\d{6,}/.test(c)), "candidates must be patent numbers").toBe(true);
    // provenance: the browser trace is hashed and surfaced
    expect(String(out["trace_sha"]), "the search must seal its trace's content_sha").toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it("the cage DENIES a navigation off the allowlist (deny-by-default)", () => {
    // ask the skill to navigate somewhere off-allowlist; the cage must abort it, not load it.
    const r = executeSkill(PATENT_SEARCH, { query: "x", __probe_offlist_nav: "https://example.com/" });
    expect(r.ok).toBe(true);
    const out = r.output as Record<string, unknown>;
    expect(out["__probe_offlist_loaded"], "an off-allowlist navigation must be blocked by the cage").not.toBe(true);
  }, 120_000);
});
