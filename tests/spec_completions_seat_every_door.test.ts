// RED — a deployment can seat a cheap chat-completions model at EVERY door, not only the drain.
// Spec: docs/specs/completions-seat.red-spec.md
//
// THE GOAL. The debate-school genome (cognition/bench/school/genome) runs a maker ⇄ verifier examine
// loop of up to 30 rounds, with tool-less seats that take text in and return JSON. On `claude -p`
// each round is two full Claude Code spawns. On the engine's own turn loop each round is two chat
// completions — the difference between a pilot and something that can run all day on a model priced
// in cents.
//
// THE GAP. Only `coltrane work` (the drain) chooses the completions port, from COLTRANE_COMPLETIONS_URL
// (src/cli.ts makeInvoke). `coltrane dispatch` and MCP `gig_dispatch` both go through
// bootstrapServerDeps, which ALWAYS builds makeClaudeInvoker (src/server.ts). debate-school's README
// launches with `coltrane dispatch`, so today it can never reach a cheap model. And nothing loads a
// price table, so even the drain settles such a run as unpriced.
//
// SAFETY. On today's code a dispatch here would spawn a real `claude -p`. Every door law narrows
// PATH to node's own directory while it dispatches, so the Claude path fails fast with ENOENT
// instead of running a model.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootstrapServerDeps, dispatchTool, type ServerDeps } from "../src/server.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { loadChatPort } from "./spec_turn_loop_fixtures.js";

const CORE_TYPES = ["Signal:SENSE", "Interpretation:INTERPRET", "Judgment:JUDGE", "Plan:PLAN", "Artifact:CREATE", "Verdict:VERIFY"].map(
  (s) => ({ slug: s.split(":")[0], primitive: s.split(":")[1], description: "", schema: {} }),
);

const URL_BASE = "https://completions.test/v1";
const ENV_KEYS = [
  "COLTRANE_COMPLETIONS_URL", "COLTRANE_COMPLETIONS_KEY", "COLTRANE_TIER_ECONOMY", "COLTRANE_TIER_STANDARD",
  "COLTRANE_TIER_PREMIUM", "COLTRANE_PRICES_FILE", "COLTRANE_LEDGER_PATH",
] as const;

function writeJson(dir: string, name: string, body: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
}

interface Sent { url: string; auth: string; body: { model: string; messages: { content: string }[] } }

/** A chat-completions transport. `answer` sees the parsed request and returns the reply body. */
function transport(answer: (body: Sent["body"], n: number) => unknown) {
  const sent: Sent[] = [];
  const fn = vi.fn(async (url: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
    const body = JSON.parse(String(init?.body)) as Sent["body"];
    sent.push({ url: String(url), auth: String(init?.headers?.["authorization"] ?? ""), body });
    const reply = answer(body, sent.length - 1);
    return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) };
  });
  return { fn, sent };
}

const reply = (obj: unknown, model: string, usage: Record<string, unknown>) => ({
  choices: [{ message: { role: "assistant", content: JSON.stringify(obj) }, finish_reason: "stop" }],
  model,
  usage,
});

describe("a completions seat at every door", () => {
  let root: string;
  let saved: Record<string, string | undefined>;
  let savedPath: string | undefined;

  const env = (vars: Partial<Record<(typeof ENV_KEYS)[number], string>>) => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env["COLTRANE_LEDGER_PATH"] = join(root, "ledger.jsonl");
    Object.assign(process.env, vars);
  };

  /** Dispatch with PATH narrowed so a Claude spawn cannot run a real model. */
  async function dispatch(deps: ServerDeps, standard_slug: string, input: Record<string, unknown> = { topic: "t" }) {
    process.env["PATH"] = dirname(process.execPath);
    try {
      return await dispatchTool("gig_dispatch", { standard_slug, input, wait: true }, deps);
    } finally {
      process.env["PATH"] = savedPath;
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coltrane-completions-seat-"));
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    savedPath = process.env["PATH"];
    for (const c of CORE_TYPES) writeJson(join(root, "core_types"), `${c.slug}.json`, c);
    writeJson(join(root, "domain_types"), "note.json", {
      slug: "note", extends: "Signal", domain: "demo",
      schema: { type: "object", properties: { claim: { type: "string" } } }, required_fields: ["claim"],
    });
    for (const [slug, tier] of [["econ-seat", "economy"], ["prem-seat", "premium"], ["std-seat", "standard"]] as const) {
      writeJson(join(root, "agents"), `${slug}.json`, {
        ...TEST_BEHAVIOR, slug, primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", model_tier: tier,
      });
    }
    const chair = (role: string, agent: string, deps: string[] = []) => ({
      role, agent_slug: agent, depends_on: deps, input_contract: [], output_contract: ["note"], required_skills: [],
    });
    writeJson(join(root, "standards"), "one-seat.json", {
      slug: "one-seat", domain: "demo", status: "active", agent_slugs: ["std-seat"],
      phases: [{ name: "p", chairs: [chair("s", "std-seat")] }],
    });
    writeJson(join(root, "standards"), "two-tiers.json", {
      slug: "two-tiers", domain: "demo", status: "active", agent_slugs: ["econ-seat", "prem-seat"],
      phases: [{ name: "a", chairs: [chair("e", "econ-seat")] }, { name: "b", chairs: [chair("p", "prem-seat", ["e"])] }],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    process.env["PATH"] = savedPath;
    rmSync(root, { recursive: true, force: true });
  });

  it("LAW 1 — `gig_dispatch` runs a chair through the completions port when the deployment configures one", async () => {
    const { fn, sent } = transport(() => reply({ claim: "c", source: "s" }, "served-flash", { prompt_tokens: 10, completion_tokens: 5 }));
    vi.stubGlobal("fetch", fn);
    env({ COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k-test", COLTRANE_TIER_STANDARD: "model-std" });
    const deps = bootstrapServerDeps(root);

    const res = await dispatch(deps, "one-seat");
    expect(res.ok, `the gig did not complete on the completions port: ${res.error ?? ""}`).toBe(true);
    expect(sent.length, "no chat completion was requested — the door still spawns claude").toBe(1);
    expect(sent[0]!.url).toBe(`${URL_BASE}/chat/completions`);
    expect(sent[0]!.auth).toBe("Bearer k-test");
    expect(sent[0]!.body.model).toBe("model-std");
  });

  it("LAW 2 (control) — with no completions URL, the door keeps the Claude invoker and calls no endpoint", async () => {
    // Green today. A fix that routes EVERY gig to the completions port, configured or not, goes red.
    const { fn } = transport(() => reply({ claim: "c", source: "s" }, "x", {}));
    vi.stubGlobal("fetch", fn);
    env({});
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "one-seat");
    expect(fn, "an unconfigured deployment called a completions endpoint").not.toHaveBeenCalled();
    expect(res.ok, "with PATH narrowed, the Claude path should have failed to spawn").toBe(false);
  });

  it("LAW 3 — each chair's tier routes to the model the deployment mapped for it", async () => {
    const { fn, sent } = transport(() => reply({ claim: "c", source: "s" }, "served", { prompt_tokens: 10, completion_tokens: 5 }));
    vi.stubGlobal("fetch", fn);
    env({ COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k", COLTRANE_TIER_ECONOMY: "model-flash", COLTRANE_TIER_PREMIUM: "model-pro" });
    const deps = bootstrapServerDeps(root);

    const res = await dispatch(deps, "two-tiers");
    expect(res.ok, res.error ?? "").toBe(true);
    expect(sent.map((s) => s.body.model), "a chair ran on a model its tier does not map to").toEqual(["model-flash", "model-pro"]);
  });

  it("LAW 4 — a price table from deployment config prices the gig, cache hits at the cache-hit rate", async () => {
    // Usage in the shape a provider that reports hits and misses separately returns.
    const usage = { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 800_000, prompt_cache_miss_tokens: 200_000, completion_tokens: 100_000 };
    const { fn } = transport(() => reply({ claim: "c", source: "s" }, "served-flash", usage));
    vi.stubGlobal("fetch", fn);
    const prices = join(root, "prices.json");
    writeFileSync(prices, JSON.stringify({ "served-flash": { input: 0.3, output: 1.2, cache_read: 0.006 } }));
    env({ COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k", COLTRANE_TIER_STANDARD: "model-std", COLTRANE_PRICES_FILE: prices });
    const deps = bootstrapServerDeps(root);

    const res = await dispatch(deps, "one-seat");
    expect(res.ok, res.error ?? "").toBe(true);
    const usageOut = (res.data as { manifest?: { usage?: { total_cost_usd?: number; input_tokens?: number } } }).manifest?.usage;
    // 0.2M uncached × $0.30 + 0.8M cache hits × $0.006 + 0.1M output × $1.20
    expect(usageOut?.total_cost_usd, "the deployment's price table never reached the gig").toBeCloseTo(0.1848, 9);
    expect(usageOut?.input_tokens, "cache hits fell out of the settled prompt").toBe(1_000_000);
  });

  it("LAW 5 — a malformed price table refuses at startup and names the file, rather than running unpriced", () => {
    const bad = join(root, "prices.json");
    writeFileSync(bad, "{ not json");
    env({ COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k", COLTRANE_PRICES_FILE: bad });
    expect(() => bootstrapServerDeps(root), "a broken price table was accepted silently").toThrow(/prices\.json/);

    writeFileSync(bad, JSON.stringify({ m: { input: -1, output: 1 } }));
    expect(() => bootstrapServerDeps(root), "a negative price was accepted").toThrow(/prices\.json/);
  });

  it("LAW 6 — the maker ⇄ verifier examine loop debate-school runs completes on the completions port", async () => {
    // debate-school's shape, reduced: a maker seat, a verify seat over it, rounds capped. The verifier
    // fails twice and passes on the third look, so the maker is amended twice.
    writeJson(join(root, "domain_types"), "topic.json", {
      slug: "topic", extends: "Signal", domain: "demo",
      schema: { type: "object", properties: { thesis: { type: "string" } } }, required_fields: ["thesis"],
    });
    writeJson(join(root, "domain_types"), "line.json", {
      slug: "line", extends: "Artifact", domain: "demo",
      schema: { type: "object", properties: { line: { type: "string" } } }, required_fields: ["line"],
    });
    writeJson(join(root, "domain_types"), "floor.json", {
      slug: "floor", extends: "Verdict", domain: "demo",
      schema: { type: "object", properties: { pass: { type: "boolean" }, reason: { type: "string" } } }, required_fields: ["pass"],
    });
    writeJson(join(root, "agents"), "maker.json", {
      ...TEST_BEHAVIOR, slug: "maker", identity: "SEAT-MAKER. You defend the thesis, one move at a time, in a single JSON object.",
      primitives: ["CREATE"], input_types: ["topic"], output_types: ["line"], domain: "demo", model_tier: "standard",
    });
    writeJson(join(root, "agents"), "floor-keeper.json", {
      ...TEST_BEHAVIOR, slug: "floor-keeper", identity: "SEAT-VERIFY. You hold the floor and rule on the maker's line in a single JSON object.",
      primitives: ["VERIFY"], input_types: ["line"], output_types: ["floor"], domain: "demo", model_tier: "economy",
    });
    writeJson(join(root, "standards"), "mini-debate.json", {
      slug: "mini-debate", domain: "demo", status: "active", agent_slugs: ["maker", "floor-keeper"], max_examine_rounds: 3,
      input_types: ["topic"],
      phases: [
        { name: "defend", chairs: [{ role: "defend", agent_slug: "maker", depends_on: [], input_contract: ["topic"], output_contract: ["line"], required_skills: [] }] },
        { name: "floor", chairs: [{ role: "floor", agent_slug: "floor-keeper", depends_on: ["defend"], input_contract: ["line"], output_contract: ["floor"], required_skills: [] }] },
      ],
    });

    let verifies = 0;
    const { fn, sent } = transport((body) => {
      const prompt = body.messages.map((m) => m.content).join("\n");
      if (prompt.includes("SEAT-VERIFY")) {
        verifies += 1;
        return reply({ pass: verifies >= 3, reason: `look ${verifies}` }, "served-flash", { prompt_tokens: 100, completion_tokens: 10 });
      }
      return reply({ line: "red is a colour" }, "served-std", { prompt_tokens: 100, completion_tokens: 10 });
    });
    vi.stubGlobal("fetch", fn);
    env({ COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k", COLTRANE_TIER_STANDARD: "model-std", COLTRANE_TIER_ECONOMY: "model-flash" });
    const deps = bootstrapServerDeps(root);

    const res = await dispatch(deps, "mini-debate", { topic: { thesis: "whatever is a colour is red", source: "seed://colours" } });
    expect(res.ok, res.error ?? "").toBe(true);
    const makers = sent.filter((s) => !s.body.messages.map((m) => m.content).join("\n").includes("SEAT-VERIFY"));
    expect(makers.length, "the maker was not amended after each failing verdict").toBe(3);
    expect(verifies, "the verify seat did not re-rule after each amendment").toBe(3);
    const usageOut = (res.data as { manifest?: { usage?: { input_tokens?: number; output_tokens?: number } } }).manifest?.usage;
    expect(usageOut?.input_tokens, "the gig did not settle every call of the debate").toBe(600);
    expect(usageOut?.output_tokens).toBe(60);
  });

  it("LAW 7 — the port reads cache hits and misses when a provider reports them separately", async () => {
    const P = await loadChatPort();
    const fn = (async () => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], model: "served",
        usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens: 50 },
      }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const port = P.makeChatCompletionsPort({ baseUrl: URL_BASE, apiKey: "k", fetchFn: fn });
    const r = await port({ model: "m", messages: [{ role: "user", content: "x" }], tools: [], signal: new AbortController().signal });
    expect(r.usage, "cache hits were priced as uncached input").toEqual({ input_tokens: 200, cache_read_tokens: 800, output_tokens: 50 });
  });

  it("LAW 8 — every door chooses its invoker through ONE selector, so the drain and dispatch cannot drift", () => {
    const selector = join(process.cwd(), "src", "invoker_selection.ts");
    expect(existsSync(selector), "src/invoker_selection.ts does not exist yet").toBe(true);
    const cli = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
    const server = readFileSync(join(process.cwd(), "src", "server.ts"), "utf8");
    for (const [name, text] of [["src/cli.ts", cli], ["src/server.ts", server]] as const) {
      expect(text, `${name} does not choose its invoker through selectChairInvoker`).toMatch(/selectChairInvoker\(/);
      expect(text, `${name} still constructs a completions invoker itself`).not.toMatch(/makeCompletionsInvoker\(/);
    }
  });
});
