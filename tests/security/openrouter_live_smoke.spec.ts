// LIVE SMOKE — a maker ⇄ verifier gig completes through OpenRouter, its tokens settle, and its cost is
// recorded (or marked unpriced), never $0. Spec: docs/specs/openrouter-reference.red-spec.json (L4).
//
// THIS LAW SPENDS REAL MONEY, so it runs only when the machine is configured for it: the named skip
// below holds unless COLTRANE_COMPLETIONS_URL points at openrouter.ai AND COLTRANE_COMPLETIONS_KEY is
// set. Skipped, it prints UNVERIFIED — a skipped live law is not a passing one, and the run says so.
// It lives in the security band because a band may reach out and the root suite may not
// (tests/suite_reaches_no_remote.test.ts).
//
// Run it (the one-line flip, then the band):
//   COLTRANE_COMPLETIONS_URL=https://openrouter.ai/api/v1 COLTRANE_COMPLETIONS_KEY=sk-or-... \
//   COLTRANE_MODEL=deepseek/deepseek-v4.1-flash npm run test:security -- openrouter_live_smoke
//
// When it runs, it RECORDS what OpenRouter actually returned and writes it — dated — over
// tests/fixtures/completions_usage/openrouter_chat_completion.json, replacing the documented example
// the offline laws (tests/openrouter_reference.test.ts) read today. It writes only a response that
// carries a cache read, because the offline cached_tokens law needs one to exercise the mapping.
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapServerDeps, dispatchTool } from "../../src/server.js";
import { TEST_BEHAVIOR } from "../_support/agents.js";

const URL_SET = process.env["COLTRANE_COMPLETIONS_URL"] ?? "";
const KEY_SET = process.env["COLTRANE_COMPLETIONS_KEY"] ?? "";
const LIVE = /^https:\/\/openrouter\.ai(\/|$)/.test(URL_SET) && KEY_SET !== "";
if (!LIVE) {
  console.warn(
    "UNVERIFIED: the OpenRouter live smoke did not run — set COLTRANE_COMPLETIONS_URL=https://openrouter.ai/api/v1, " +
      "COLTRANE_COMPLETIONS_KEY and COLTRANE_MODEL to run it. Nothing about OpenRouter has been verified live by this run.",
  );
}

const FIXTURE = fileURLToPath(new URL("../fixtures/completions_usage/openrouter_chat_completion.json", import.meta.url));
const CORE_TYPES = ["Signal:SENSE", "Interpretation:INTERPRET", "Judgment:JUDGE", "Plan:PLAN", "Artifact:CREATE", "Verdict:VERIFY"].map(
  (s) => ({ slug: s.split(":")[0], primitive: s.split(":")[1], description: "", schema: {} }),
);
function writeJson(dir: string, name: string, body: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
}

describe("OpenRouter live smoke (spends; skipped unless configured)", () => {
  const root = mkdtempSync(join(tmpdir(), "coltrane-openrouter-live-"));
  afterAll(() => {
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!LIVE)("L4 — a maker ⇄ verifier gig completes through OpenRouter; tokens settle; cost is recorded or marked unpriced, never $0", async () => {
    for (const c of CORE_TYPES) writeJson(join(root, "core_types"), `${c.slug}.json`, c);
    writeJson(join(root, "domain_types"), "topic.json", {
      slug: "topic", extends: "Signal", domain: "demo",
      schema: { type: "object", properties: { thesis: { type: "string" } } }, required_fields: ["thesis"],
    });
    writeJson(join(root, "domain_types"), "line.json", {
      slug: "line", extends: "Artifact", domain: "demo",
      schema: { type: "object", properties: { text: { type: "string" }, validation_criteria: { type: "array" } } }, required_fields: ["text"],
    });
    writeJson(join(root, "domain_types"), "floor.json", {
      slug: "floor", extends: "Verdict", domain: "demo",
      schema: { type: "object", properties: { pass: { type: "boolean" }, reason: { type: "string" }, checks: { type: "array" } } }, required_fields: ["pass"],
    });
    writeJson(join(root, "agents"), "maker.json", {
      ...TEST_BEHAVIOR, slug: "maker",
      identity: "You defend the thesis in ONE short sentence, set as `text`, with one validation criterion.",
      primitives: ["CREATE"], input_types: ["topic"], output_types: ["line"], domain: "demo", model_tier: "standard",
    });
    writeJson(join(root, "agents"), "floor-keeper.json", {
      ...TEST_BEHAVIOR, slug: "floor-keeper",
      identity: "You rule on the maker's line. Set pass to true whenever the line is a non-empty sentence; give one check.",
      primitives: ["VERIFY"], input_types: ["line"], output_types: ["floor"], domain: "demo", model_tier: "economy",
    });
    writeJson(join(root, "standards"), "live-debate.json", {
      slug: "live-debate", domain: "demo", status: "active", agent_slugs: ["maker", "floor-keeper"], max_examine_rounds: 2,
      input_types: ["topic"],
      phases: [
        { name: "defend", chairs: [{ role: "defend", agent_slug: "maker", depends_on: [], input_contract: ["topic"], output_contract: ["line"], required_skills: [] }] },
        { name: "floor", chairs: [{ role: "floor", agent_slug: "floor-keeper", depends_on: ["defend"], input_contract: ["line"], output_contract: ["floor"], required_skills: [] }] },
      ],
    });

    // Record what the wire actually returned. The selector respects a host-installed fetch, so this
    // wrapper sees every completion; it changes nothing about the request or the reply.
    const realFetch = globalThis.fetch;
    const recorded: Array<{ at: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const res = await realFetch(input, init);
      if (res.ok) {
        try { recorded.push({ at: new Date().toISOString(), body: (await res.clone().json()) as Record<string, unknown> }); } catch { /* not JSON */ }
      }
      return res;
    });

    const savedEnv = { ledger: process.env["COLTRANE_LEDGER_PATH"], transcripts: process.env["COLTRANE_TRANSCRIPTS_DIR"] };
    process.env["COLTRANE_LEDGER_PATH"] = join(root, "ledger.jsonl");
    process.env["COLTRANE_TRANSCRIPTS_DIR"] = join(root, "transcripts");
    const savedPath = process.env["PATH"];
    process.env["PATH"] = dirname(process.execPath); // a Claude spawn cannot run: this gig must go over the wire
    let res;
    try {
      const deps = bootstrapServerDeps(root);
      res = await dispatchTool("gig_dispatch", {
        standard_slug: "live-debate", input: { topic: { thesis: "red is a colour", source: "seed://colours" } }, wait: true,
      }, deps);
      expect(res.ok, `the gig did not complete through OpenRouter: ${res.error ?? ""}`).toBe(true);
      expect(recorded.length, "no completion reached OpenRouter").toBeGreaterThan(0);

      const usage = (res.data as { manifest?: { usage?: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number; unpriced_invocations?: number } } }).manifest?.usage;
      expect(usage?.input_tokens ?? 0, "input tokens did not settle").toBeGreaterThan(0);
      expect(usage?.output_tokens ?? 0, "output tokens did not settle").toBeGreaterThan(0);
      const unpriced = usage?.unpriced_invocations ?? 0;
      if (unpriced === 0) {
        expect(usage?.total_cost_usd ?? 0, "a fully priced run settled at $0").toBeGreaterThan(0);
      }
      const gigId = String((res.data as { gig_id?: string }).gig_id ?? "");
      for (const r of deps.outputs.all().filter((o) => o.gig_id === gigId)) {
        if (r.cost_usd !== undefined) expect(r.cost_usd, `record ${r.id} claims $0`).toBeGreaterThan(0);
      }
      console.warn(`VERIFIED LIVE: ${recorded.length} OpenRouter completion(s); settled $${String(usage?.total_cost_usd)} (${unpriced} unpriced invocation(s)).`);
    } finally {
      process.env["PATH"] = savedPath;
      for (const [k, v] of [["COLTRANE_LEDGER_PATH", savedEnv.ledger], ["COLTRANE_TRANSCRIPTS_DIR", savedEnv.transcripts]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    // Replace the documented example with a RECORDED response — one that carries a cache read.
    const cachedOf = (b: Record<string, unknown>) =>
      ((b["usage"] as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)?.prompt_tokens_details?.cached_tokens) ?? 0;
    const best = [...recorded].sort((a, b) => cachedOf(b.body) - cachedOf(a.body))[0];
    if (!best || cachedOf(best.body) === 0) {
      console.warn("UNVERIFIED: no recorded OpenRouter response carried a cache read — the documented fixture was NOT replaced.");
      return;
    }
    const prior = JSON.parse(readFileSync(FIXTURE, "utf8")) as { _provenance?: { sources?: unknown }; documented_usage_example?: unknown };
    writeFileSync(FIXTURE, JSON.stringify({
      _provenance: {
        kind: "recorded",
        label: `RECORDED live response from ${URL_SET} on ${best.at.slice(0, 10)}; replaces the documented example`,
        recorded_at: best.at,
        requested_model: process.env["COLTRANE_MODEL"] ?? null,
        sources: prior._provenance?.sources ?? [],
      },
      documented_usage_example: prior.documented_usage_example,
      response: best.body,
    }, null, 2) + "\n");
  });
});
