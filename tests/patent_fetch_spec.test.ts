// SPEC — grounded patent-fetch (HTTP corpus tier + network permission cage). RED by design:
// each it() is a structural acceptance criterion that FAILS until the genome + cage are authored
// to meet it. Plan: docs/patent-fetch-grounded-corpus.md. Contracts read off disk so the file
// always collects cleanly; a slice is done when its describe() goes green. The behavioral
// must-fire (allowlist denies a non-granted host; a real fetch yields a verified record) lives in
// tests/e2e/patent_fetch_live.spec.ts under COLTRANE_LIVE.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const readJson = (p: string): Record<string, unknown> | null =>
  existsSync(join(REPO, p)) ? (JSON.parse(readFileSync(join(REPO, p), "utf8")) as Record<string, unknown>) : null;
const domainType = (slug: string) => readJson(`domain_types/${slug}.json`);
const skillMeta = (slug: string) => readJson(`skills/${slug}/meta.json`);
const agent = (slug: string) => readJson(`agents/${slug}.json`);
const props = (t: Record<string, unknown> | null): Record<string, unknown> =>
  ((t?.["schema"] as { properties?: Record<string, unknown> })?.properties) ?? {};
const req = (t: Record<string, unknown> | null): string[] => (t?.["required_fields"] as string[]) ?? [];

// ── Slice 0 — the full record: patent-record domain type ─────────────────────────
describe("patent-fetch · Slice 0 — the patent-record full document type", () => {
  it("a patent-record domain type exists (extends Signal, patent-triage)", () => {
    const t = domainType("patent-record");
    expect(t, "domain_types/patent-record.json missing").toBeTruthy();
    expect(t?.["extends"]).toBe("Signal");
  });
  it("carries the full bibliographic record (title/abstract/inventors/dates/cpc/claims/citations)", () => {
    const p = props(domainType("patent-record"));
    for (const f of ["patent_number", "source", "title", "abstract", "inventors", "assignee",
      "priority_date", "filing_date", "grant_date", "cpc_codes", "claims", "claim_count",
      "backward_citations", "verification_method", "verified", "content_sha"]) {
      expect(p[f], `patent-record missing field ${f}`).toBeTruthy();
    }
  });
  it("grounding is non-optional: verified + verification_method + content_sha are required", () => {
    for (const f of ["patent_number", "source", "title", "verified", "verification_method", "content_sha"]) {
      expect(req(domainType("patent-record")), `patent-record must require ${f}`).toContain(f);
    }
  });
  it("verification_method is a closed enum — snippet is named but not admissible for a verdict", () => {
    const vm = (props(domainType("patent-record"))["verification_method"] as { enum?: string[] }) ?? {};
    expect(vm.enum, "verification_method must enumerate fetch/api/snippet").toEqual(
      expect.arrayContaining(["fetch", "api", "snippet"]),
    );
  });
});

// ── Slice 1 — the tool addition: a network permission tier on the skill cage ──────
describe("patent-fetch · Slice 1 — the network permission grant (deny-by-default egress)", () => {
  it("patent-fetch declares a network grant with a non-empty domain allowlist", () => {
    const perm = (skillMeta("patent-fetch")?.["permission"] as Record<string, unknown>) ?? {};
    const net = (perm["network"] as Record<string, unknown>) ?? {};
    const allow = (net["allow"] as string[]) ?? [];
    expect(allow.length, "network.allow must be a non-empty allowlist").toBeGreaterThan(0);
    expect(allow.some((h) => /patents\.google\.com|ops\.epo\.org|uspto/i.test(h)), `allow: ${JSON.stringify(allow)}`).toBe(true);
  });
  it("the grant is read-only — methods are GET only (no POST/PUT/downloads)", () => {
    const net = ((skillMeta("patent-fetch")?.["permission"] as Record<string, unknown>)?.["network"] as Record<string, unknown>) ?? {};
    const methods = (net["methods"] as string[]) ?? [];
    expect(methods.length, "network.methods must be declared").toBeGreaterThan(0);
    expect(methods.map((m) => m.toUpperCase())).not.toContain("POST");
    expect(methods.map((m) => m.toUpperCase())).toEqual(expect.arrayContaining(["GET"]));
  });
  it("the grant carries an egress budget (max_requests) — a finitude bound on crawling", () => {
    const net = ((skillMeta("patent-fetch")?.["permission"] as Record<string, unknown>)?.["network"] as Record<string, unknown>) ?? {};
    expect(typeof net["max_requests"], "network.max_requests must bound egress").toBe("number");
  });
  it("the skill cage synthesizes a host allowlist into the subprocess grant (Node --allow-net)", () => {
    // cajal review (#186): an existence-grep alone can hollow-pass on a comment / TODO. So pin the
    // CONCRETE mechanism — the cage must build Node's native --allow-net allowlist from the grant —
    // and lean on the live spec for CORRECTNESS: tests/e2e/patent_fetch_live.spec.ts loads an
    // allowlisted host and DENIES an off-allowlist one (existence + correctness together).
    const runner = existsSync(join(REPO, "src/skill_subprocess.ts"))
      ? readFileSync(join(REPO, "src/skill_subprocess.ts"), "utf8") : "";
    expect(/--allow-net/.test(runner), "the cage must synthesize Node's --allow-net from network.allow").toBe(true);
  });
});

// ── Slice 2 — patent-fetch is grounded (the mock is retired) ──────────────────────
describe("patent-fetch · Slice 2 — a real fetch+extract+verify skill", () => {
  it("the patent-fetch skill produces patent-record (not the placeholder patent-hits)", () => {
    expect(skillMeta("patent-fetch")?.["output_type"], "patent-fetch must output patent-record").toBe("patent-record");
  });
  it("its corpus names a real, fetchable source (Google Patents / EPO / USPTO)", () => {
    expect(String(skillMeta("patent-fetch")?.["corpus"] ?? ""), "corpus must name a real source").toMatch(/google patents|epo|uspto|patentsview/i);
  });
  it("ships fixtures: a recorded patent document and its expected verified record (replay)", () => {
    const dir = join(REPO, "skills", "patent-fetch", "fixtures");
    expect(existsSync(dir), "patent-fetch needs fixtures").toBe(true);
    const files = existsSync(dir) ? readdirSync(dir) : [];
    // the mock fixture (patent-hits / mock_response) is NOT enough — a real fixture must replay a
    // recorded document into a verified, hash-pinned patent-record. Require that shape in a fixture.
    const blob = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(/content_sha/.test(blob), "a fixture must assert the recorded record's content_sha").toBe(true);
    expect(/verification_method|"verified"/.test(blob), "a fixture must assert the record is verified").toBe(true);
  });
  it("the skill code is no longer a mock — it does not key off a mock_response", () => {
    const code = existsSync(join(REPO, "skills/patent-fetch/skill.mjs"))
      ? readFileSync(join(REPO, "skills/patent-fetch/skill.mjs"), "utf8") : "";
    expect(code.includes("mock_response"), "patent-fetch must retire the mock_response path").toBe(false);
    expect(/content_sha|sha256|createHash/i.test(code), "the skill must hash-pin what it fetched").toBe(true);
  });
});

// ── Slice 3 — prior-art-scout wiring ──────────────────────────────────────────────
describe("patent-fetch · Slice 3 — prior-art-scout is wired to the grounded corpus", () => {
  it("prior-art-scout still binds patent-fetch + citation-verify", () => {
    const slugs = (agent("prior-art-scout")?.["skill_slugs"] as string[]) ?? [];
    for (const s of ["patent-fetch", "citation-verify"]) expect(slugs, `missing skill ${s}`).toContain(s);
  });
  it("the dead web tools (WebSearch/WebFetch) are dropped — they never reached the JS/JSON surfaces", () => {
    const tools = (agent("prior-art-scout")?.["allowed_tools"] as string[]) ?? [];
    expect(tools, "WebSearch never worked for patent corpora").not.toContain("WebSearch");
    expect(tools, "WebFetch never worked for the JS-walled surfaces").not.toContain("WebFetch");
  });
  it("prior-art-scout consumes patent-record to build its prior-art-hit / coverage-report", () => {
    const inputs = (agent("prior-art-scout")?.["input_types"] as string[]) ?? [];
    expect(inputs, "prior-art-scout must consume patent-record").toContain("patent-record");
  });
});

// ── Slice 4 — the browser tier: patent-search as a caged Playwright skill ─────────
// The JS-walled SEARCH surfaces need a browser. It is a deterministic SKILL (the model picks the
// query; the code drives the browser) — so it sidesteps #185's dead-tool problem the same way the
// HTTP tier does, and its grant resolves through the same tool→provider machinery. The cage adds a
// browser block on top of the network grant: navigation allowlist, read-only, ephemeral isolation,
// vetted (hashed) extraction scripts, a page budget, and the trace sealed as provenance.
describe("patent-fetch · Slice 4 — browser tier (patent-search, caged Playwright)", () => {
  it("a patent-search skill exists and declares a browser permission grant", () => {
    const perm = (skillMeta("patent-search")?.["permission"] as Record<string, unknown>) ?? {};
    expect(perm["browser"], "patent-search must declare permission.browser").toBeTruthy();
  });
  it("the browser grant is a deny-by-default navigation allowlist, read-only + isolated", () => {
    const b = ((skillMeta("patent-search")?.["permission"] as Record<string, unknown>)?.["browser"] as Record<string, unknown>) ?? {};
    expect(((b["allow"] as string[]) ?? []).length, "browser.allow must be a non-empty navigation allowlist").toBeGreaterThan(0);
    expect(b["read_only"], "browser must be read_only (no downloads / off-path POST)").toBe(true);
    expect(b["isolate"], "browser must isolate (ephemeral context per gig)").toBe(true);
  });
  it("only vetted, content-hashed extraction scripts run (no model-authored runtime JS)", () => {
    const b = ((skillMeta("patent-search")?.["permission"] as Record<string, unknown>)?.["browser"] as Record<string, unknown>) ?? {};
    const scripts = (b["eval_scripts_sha"] as string[]) ?? [];
    expect(scripts.length, "browser.eval_scripts_sha must pin the extraction code by hash").toBeGreaterThan(0);
    expect(scripts.every((s) => /^[0-9a-f]{64}$/.test(s)), "each pinned script must be a sha256").toBe(true);
  });
  it("the browser grant carries a page budget (max_pages) — a finitude bound on crawling", () => {
    const b = ((skillMeta("patent-search")?.["permission"] as Record<string, unknown>)?.["browser"] as Record<string, unknown>) ?? {};
    expect(typeof b["max_pages"], "browser.max_pages must bound the crawl").toBe("number");
  });
  it("the search seals its browser trace as provenance — coverage-report carries a trace_sha", () => {
    // "the search actually hit USPTO" must be a hashed artifact, not a claim.
    expect(props(domainType("coverage-report"))["trace_sha"], "coverage-report must record the search trace's content_sha").toBeTruthy();
  });
  it("the cage enforces the browser navigation allowlist (route abort off-list)", () => {
    const runner = existsSync(join(REPO, "src/skill_subprocess.ts")) ? readFileSync(join(REPO, "src/skill_subprocess.ts"), "utf8") : "";
    const cage = existsSync(join(REPO, "src/skill_runner.mjs")) ? readFileSync(join(REPO, "src/skill_runner.mjs"), "utf8") : "";
    expect(
      /browserAllow|navigationGuard|routeAllow|isNavAllowed|page\.route/.test(runner + cage),
      "the cage must implement browser navigation allowlist enforcement",
    ).toBe(true);
  });
});
