// Live acceptance — the grounded patent-fetch actually reaches a real corpus and returns a
// hash-pinned, verified patent-record. Gated behind COLTRANE_LIVE=1 (real network). RED until the
// skill is rewritten from the mock to the HTTP tier AND the cage's network grant lets the
// allowlisted host through. Proves the headline claim: prior-art search touches real patents.
//
// Run: COLTRANE_LIVE=1 npx vitest run --config tests/e2e/vitest.config.ts \
//   tests/e2e/patent_fetch_live.spec.ts
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { executeSkill } from "../../src/skill_subprocess.js";

const REPO = fileURLToPath(new URL("..", new URL("..", import.meta.url)));
const PATENT_FETCH = join(REPO, "skills", "patent-fetch");
const LIVE = process.env["COLTRANE_LIVE"] === "1";

describe.skipIf(!LIVE)("patent-fetch live — a real corpus fetch yields a verified patent-record", () => {
  it("fetches US9652599B2 from the allowlisted corpus and returns a hash-pinned record", () => {
    const r = executeSkill(PATENT_FETCH, { patent_number: "US9652599B2" });
    expect(r.ok, `skill failed: ${r.error}`).toBe(true);
    const rec = r.output as Record<string, unknown>;
    // grounding: fetched (not snippet), hash-pinned, real bibliographic content
    expect(rec["verified"]).toBe(true);
    expect(rec["verification_method"]).toBe("fetch");
    expect(String(rec["content_sha"])).toMatch(/^[0-9a-f]{64}$/);
    expect(String(rec["title"])).toMatch(/restricted code signing/i);
    expect(Array.isArray(rec["cpc_codes"]) && (rec["cpc_codes"] as unknown[]).length, "must extract CPC classes").toBeTruthy();
    expect(Array.isArray(rec["backward_citations"]), "must extract citations").toBe(true);
  }, 60_000);

  it("the network cage DENIES a host outside the allowlist (deny-by-default)", () => {
    // the grant allows patent corpora only; a fetch the skill is asked to make off-allowlist must
    // be refused by the cage, not silently performed.
    const r = executeSkill(PATENT_FETCH, { patent_number: "US9652599B2", __probe_offlist_url: "https://example.com/" });
    // the skill completes its real work; the off-allowlist probe must NOT have succeeded
    expect(r.ok).toBe(true);
    const rec = r.output as Record<string, unknown>;
    expect(rec["__probe_offlist_status"], "an off-allowlist fetch must be blocked by the cage").not.toBe(200);
  }, 60_000);
});
