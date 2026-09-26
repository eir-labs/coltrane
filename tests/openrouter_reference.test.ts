// RED — OpenRouter as a reference provider for the completions seat: the one-line flip.
// Spec: docs/specs/openrouter-reference.red-spec.json · Provider doc: docs/providers/openrouter.md
//
// THE GOAL. A founder should be able to send someone three environment lines and have Coltrane run on
// OpenRouter. invoker_selection.ts already picks the completions port when COLTRANE_COMPLETIONS_URL is
// set. What is missing, measured at origin/main 471169e:
//
//   1. ONE MODEL CANNOT SEAT EVERY TIER. The selector builds its tier map from COLTRANE_TIER_ECONOMY /
//      _STANDARD / _PREMIUM only, so a deployment naming one model must name it three times, and a
//      deployment that names it once has two tiers refused `unresolved_tier`. The codebase already has
//      a name for "the model a chair invokes": COLTRANE_MODEL (src/worker_env.ts), which the Claude
//      path uses as the FALLBACK under the tier map (resolveModel: tier wins, then the fallback). The
//      one-line mode gives the completions path the same precedence: a COLTRANE_TIER_<X> wins for its
//      tier; COLTRANE_MODEL seats every tier left unmapped; with neither, `unresolved_tier` holds and
//      nothing is sent — no silent default model.
//   2. OPENROUTER'S CACHE WRITES ARE PRICED AS UNCACHED INPUT. The port reads
//      prompt_tokens_details.cached_tokens (and DeepSeek's hit/miss split) but not
//      prompt_tokens_details.cache_write_tokens, which OpenRouter documents.
//   3. OPENROUTER'S BILLED COST IS DROPPED. OpenRouter returns usage.cost on every response (documented:
//      "always included automatically"). DECISION (red-spec, `cost_decision`): the engine USES it —
//      a round whose transport reports a cost settles at that cost; the price table prices only the
//      rounds that report none. OpenRouter routes one model slug across upstream providers at different
//      prices, so a flat per-model table cannot be exact where the provider's own charge is.
//   4. AN UNPRICED GIG READS AS $0. A chair that reports tokens but no cost seals `cost_usd: 0` on its
//      record and folds 0 into manifest.usage.total_cost_usd with nothing marking it unpriced. The fix
//      pins `usage.unpriced_invocations` and leaves the record's cost_usd absent.
//
// SAFETY. Every door law stubs the global fetch (the selector respects a host-installed fetch) and
// narrows PATH while it dispatches, so no law reaches a network or spawns `claude`.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapServerDeps, dispatchTool, type ServerDeps } from "../src/server.js";
import { makeChatCompletionsPort } from "../src/chat_completions_port.js";
import { selectChairInvoker, amendLadderFromEnv } from "../src/invoker_selection.js";
import { runCli, type CliIO } from "../src/cli.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(REPO_ROOT, "tests", "fixtures", "completions_usage");

interface OrUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  cost?: number;
  [k: string]: unknown;
}
interface OrFixture {
  _provenance: { kind: string; label: string };
  response: { model: string; usage: OrUsage; choices: unknown[] };
}
const OR: OrFixture = JSON.parse(readFileSync(join(FIXTURES, "openrouter_chat_completion.json"), "utf8"));
const DS = JSON.parse(readFileSync(join(FIXTURES, "deepseek_usage.json"), "utf8")) as { usage: Record<string, number>; usage_discriminating: Record<string, number> };

/** What the engine must read out of the OpenRouter fixture — computed from the fixture's own counts, so
 *  the live smoke's recorded response can replace it without editing this file. */
function expectedOrSplit(u: OrUsage): { input_tokens: number; cache_read_tokens: number; cache_write_tokens?: number; output_tokens: number } {
  const read = u.prompt_tokens_details?.cached_tokens ?? 0;
  const write = u.prompt_tokens_details?.cache_write_tokens;
  return {
    input_tokens: u.prompt_tokens - read - (write ?? 0),
    cache_read_tokens: read,
    ...(write !== undefined ? { cache_write_tokens: write } : {}),
    output_tokens: u.completion_tokens,
  };
}

const CORE_TYPES = ["Signal:SENSE", "Interpretation:INTERPRET", "Judgment:JUDGE", "Plan:PLAN", "Artifact:CREATE", "Verdict:VERIFY"].map(
  (s) => ({ slug: s.split(":")[0], primitive: s.split(":")[1], description: "", schema: {} }),
);
const URL_BASE = "https://openrouter.test/api/v1";
const ENV_KEYS = [
  "COLTRANE_COMPLETIONS_URL", "COLTRANE_COMPLETIONS_KEY", "COLTRANE_MODEL", "COLTRANE_TIER_ECONOMY", "COLTRANE_TIER_STANDARD",
  "COLTRANE_TIER_PREMIUM", "COLTRANE_TIER_LADDER", "COLTRANE_PRICES_FILE", "COLTRANE_LEDGER_PATH", "COLTRANE_TRANSCRIPTS_DIR",
  "COLTRANE_COMPLETIONS_MAX_TOKENS", "COLTRANE_CHAIR_TIMEOUT_MS",
] as const;

function writeJson(dir: string, name: string, body: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
}

interface Sent { url: string; auth: string; body: { model: string; messages: { role?: string; content: string | null }[]; tools?: { function: { name: string } }[] } }

/**
 * An OpenRouter-shaped transport. Every seat seals as a real model does on this port — an output_write
 * call carrying `{claim}` — then closes its turn after the tool result. BOTH rounds answer with the
 * `usage` the law supplies, served as `servedModel`, so every round is a real billed round.
 */
function openrouter(servedModel: string, usage: () => OrUsage) {
  const sent: Sent[] = [];
  const fn = vi.fn(async (url: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
    const body = JSON.parse(String(init?.body)) as Sent["body"];
    sent.push({ url: String(url), auth: String(init?.headers?.["authorization"] ?? ""), body });
    const respond = (r: unknown) => ({ ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) });
    const base = { id: `gen-${sent.length}`, object: "chat.completion", created: 1790467200, model: servedModel, usage: usage() };
    if (body.messages.at(-1)?.role === "tool") {
      return respond({ ...base, choices: [{ finish_reason: "stop", native_finish_reason: "stop", message: { role: "assistant", content: "sealed" } }] });
    }
    const writeTool = body.tools?.map((t) => t.function.name).find((n) => n.endsWith("output_write"));
    return respond({
      ...base,
      choices: [{
        finish_reason: "tool_calls", native_finish_reason: "tool_calls",
        message: { role: "assistant", content: null, tool_calls: [{ id: `w${sent.length}`, type: "function", function: { name: writeTool ?? "missing_output_write", arguments: JSON.stringify({ data: { claim: "c", source: "s" } }) } }] },
      }],
    });
  });
  /** The requests that opened a seat (not the close round after its output_write). */
  const opens = () => sent.filter((s) => s.body.messages.at(-1)?.role !== "tool");
  return { fn, sent, opens };
}

type Manifest = { usage?: { total_cost_usd?: number; input_tokens?: number; output_tokens?: number; invocations?: number; unpriced_invocations?: number } };

describe("OpenRouter as a reference provider — the one-line flip", () => {
  let root: string;
  let saved: Record<string, string | undefined>;
  let savedPath: string | undefined;

  const env = (vars: Partial<Record<(typeof ENV_KEYS)[number], string>>) => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env["COLTRANE_LEDGER_PATH"] = join(root, "ledger.jsonl");
    process.env["COLTRANE_TRANSCRIPTS_DIR"] = join(root, "transcripts");
    Object.assign(process.env, vars);
  };

  /** Dispatch with PATH narrowed so a Claude spawn cannot run a real model. */
  async function dispatch(deps: ServerDeps, standard_slug: string) {
    process.env["PATH"] = dirname(process.execPath);
    try {
      return await dispatchTool("gig_dispatch", { standard_slug, input: { topic: "t" }, wait: true }, deps);
    } finally {
      process.env["PATH"] = savedPath;
    }
  }
  const manifestOf = (res: { data?: unknown }) => (res.data as { manifest?: Manifest } | undefined)?.manifest;
  const gigIdOf = (res: { data?: unknown }) => String((res.data as { gig_id?: string } | undefined)?.gig_id ?? "");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coltrane-openrouter-"));
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    savedPath = process.env["PATH"];
    for (const c of CORE_TYPES) writeJson(join(root, "core_types"), `${c.slug}.json`, c);
    writeJson(join(root, "domain_types"), "note.json", {
      slug: "note", extends: "Signal", domain: "demo",
      schema: { type: "object", properties: { claim: { type: "string" } } }, required_fields: ["claim"],
    });
    for (const [slug, tier] of [["econ-seat", "economy"], ["std-seat", "standard"], ["prem-seat", "premium"]] as const) {
      writeJson(join(root, "agents"), `${slug}.json`, {
        ...TEST_BEHAVIOR, slug, identity: `SEAT-${tier.toUpperCase()}`, primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", model_tier: tier,
      });
    }
    const chair = (role: string, agent: string, deps: string[] = []) => ({
      role, agent_slug: agent, depends_on: deps, input_contract: [], output_contract: ["note"], required_skills: [],
    });
    writeJson(join(root, "standards"), "one-seat.json", {
      slug: "one-seat", domain: "demo", status: "active", agent_slugs: ["std-seat"],
      phases: [{ name: "p", chairs: [chair("s", "std-seat")] }],
    });
    // Three phases, one tier each, in a fixed order — so the n-th opening request IS the n-th tier.
    writeJson(join(root, "standards"), "three-tiers.json", {
      slug: "three-tiers", domain: "demo", status: "active", agent_slugs: ["econ-seat", "std-seat", "prem-seat"],
      phases: [
        { name: "a", chairs: [chair("e", "econ-seat")] },
        { name: "b", chairs: [chair("s", "std-seat", ["e"])] },
        { name: "c", chairs: [chair("p", "prem-seat", ["s"])] },
      ],
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

  // ── LAW 1 — ONE-LINE MODE ──────────────────────────────────────────────────────────────────────

  it("L1a — URL + KEY + COLTRANE_MODEL alone seat EVERY tier on that one model", async () => {
    const { fn, opens } = openrouter("qwen/qwen3.8-flash", () => ({ prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 }));
    vi.stubGlobal("fetch", fn);
    env({ COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "sk-or-test", COLTRANE_MODEL: "qwen/qwen3.8-flash" });
    const res = await dispatch(bootstrapServerDeps(root), "three-tiers");
    expect(res.ok, `the one-line flip did not seat every tier on the one model: ${res.error ?? ""}`).toBe(true);
    expect(opens().map((s) => s.body.model), "a tier ran on something other than COLTRANE_MODEL").toEqual([
      "qwen/qwen3.8-flash", "qwen/qwen3.8-flash", "qwen/qwen3.8-flash",
    ]);
    expect(opens()[0]!.url).toBe(`${URL_BASE}/chat/completions`);
    expect(opens()[0]!.auth).toBe("Bearer sk-or-test");
  });

  it("L1b — a COLTRANE_TIER_<X> override WINS for its tier; the one model seats the rest", async () => {
    const { fn, opens } = openrouter("served", () => ({ prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 }));
    vi.stubGlobal("fetch", fn);
    env({
      COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k",
      COLTRANE_MODEL: "qwen/qwen3.8-flash", COLTRANE_TIER_PREMIUM: "openai/gpt-5.6-sol",
    });
    const res = await dispatch(bootstrapServerDeps(root), "three-tiers");
    expect(res.ok, res.error ?? "").toBe(true);
    expect(opens().map((s) => s.body.model), "the single model ignored the premium override (or an override leaked to other tiers)").toEqual([
      "qwen/qwen3.8-flash", "qwen/qwen3.8-flash", "openai/gpt-5.6-sol",
    ]);
  });

  it("L1c — with NEITHER a model nor a tier map, the chair is refused `unresolved_tier` and NOTHING is sent (no silent default)", async () => {
    // Holds at origin/main; the plant is a hard-coded default model in the resolution path.
    const { fn, sent } = openrouter("served", () => ({ prompt_tokens: 10, completion_tokens: 5 }));
    vi.stubGlobal("fetch", fn);
    env({ COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k" });
    const res = await dispatch(bootstrapServerDeps(root), "one-seat");
    expect(sent.map((s) => s.body.model), "a request went out on a model nobody configured").toEqual([]);
    expect(res.ok, "an unconfigured model tier completed a gig").toBe(false);
    expect(String(res.error ?? ""), "the refusal is not the typed unresolved-tier one").toMatch(/no model configured for tier "standard"/);
  });

  it("L1d — the amend ladder sees the one model too: every rung it names is seated, none is dropped as unmapped", () => {
    const rungs = amendLadderFromEnv({
      COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_MODEL: "qwen/qwen3.8-flash", COLTRANE_TIER_LADDER: "economy,standard,premium",
    });
    expect(rungs, "the ladder dropped rungs COLTRANE_MODEL seats — it still reads only COLTRANE_TIER_*").toEqual(["economy", "standard", "premium"]);
  });

  // ── LAW 2 — USAGE MAPPING ──────────────────────────────────────────────────────────────────────
  // The gig-level laws below seat their chair through COLTRANE_TIER_STANDARD (the tier map that exists
  // today), NOT the one-line variable, so each is red for its OWN reason and not for Law 1's.

  it("L2a — the port maps OpenRouter's usage: cached_tokens → cache reads, cache_write_tokens → cache writes, the rest → input", async () => {
    expect(OR._provenance.label, "the fixture must say what it is").toMatch(/documented example, NOT a recorded live response|RECORDED live response/);
    const u = OR.response.usage;
    expect(u.prompt_tokens_details?.cached_tokens ?? 0, "the fixture exercises no cache read — the cached_tokens mapping would be untested").toBeGreaterThan(0);
    const fetchFn = (async () => ({ ok: true, status: 200, json: async () => OR.response, text: async () => "" })) as unknown as typeof fetch;
    const port = makeChatCompletionsPort({ baseUrl: URL_BASE, apiKey: "k", fetchFn });
    const r = await port({ model: OR.response.model, messages: [{ role: "user", content: "x" }], tools: [], signal: new AbortController().signal });
    expect(r.model).toBe(OR.response.model);
    expect(r.usage, "OpenRouter's cache split was not read into the engine's usage classes").toMatchObject(expectedOrSplit(u));
  });

  it("L2b — the port maps DeepSeek's prompt_cache_hit_tokens / prompt_cache_miss_tokens, EACH from its own field", async () => {
    // Holds at origin/main (the every-door law 7 shape). Round 2: the documented shape has prompt = hit + miss,
    // so dropping ONLY the miss branch (input = prompt - hit) gave the same number and survived. The
    // discriminating usage breaks that equality on purpose (see the fixture's provenance), so each branch
    // is read from its own field or the law goes red.
    const portFor = (usage: Record<string, number>) => makeChatCompletionsPort({
      baseUrl: URL_BASE, apiKey: "k",
      fetchFn: (async () => ({
        ok: true, status: 200, text: async () => "",
        json: async () => ({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], model: "deepseek/deepseek-v4.1-flash", usage }),
      })) as unknown as typeof fetch,
    });
    for (const [label, usage] of [["documented shape", DS.usage], ["discriminating shape (prompt != hit + miss)", DS.usage_discriminating]] as const) {
      const r = await portFor(usage)({ model: "m", messages: [{ role: "user", content: "x" }], tools: [], signal: new AbortController().signal });
      expect(r.usage, `${label}: the input is not the reported MISS count, or the cache reads are not the reported HIT count`).toMatchObject({
        input_tokens: usage["prompt_cache_miss_tokens"], cache_read_tokens: usage["prompt_cache_hit_tokens"], output_tokens: usage["completion_tokens"],
      });
    }
  });

  it("L2c — OpenRouter's reported usage.cost SETTLES the gig with no price table; the full prompt settles as input", async () => {
    const { fn, sent } = openrouter(OR.response.model, () => structuredClone(OR.response.usage));
    vi.stubGlobal("fetch", fn);
    env({ COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k", COLTRANE_TIER_STANDARD: OR.response.model });
    const res = await dispatch(bootstrapServerDeps(root), "one-seat");
    expect(res.ok, res.error ?? "").toBe(true);
    const usage = manifestOf(res)?.usage;
    const reported = sent.length * (OR.response.usage.cost ?? NaN);
    expect(usage?.total_cost_usd, "OpenRouter's billed cost was dropped — the run settled without it").toBeCloseTo(reported, 12);
    expect(usage?.unpriced_invocations ?? 0, "a run whose every round reported a cost was marked unpriced").toBe(0);
    expect(usage?.input_tokens, "cache reads/writes fell out of the settled prompt").toBe(sent.length * OR.response.usage.prompt_tokens);
  });

  it("L2d — where BOTH a reported cost and a price-table entry exist, the reported cost wins", async () => {
    const { fn, sent } = openrouter(OR.response.model, () => structuredClone(OR.response.usage));
    vi.stubGlobal("fetch", fn);
    const prices = join(root, "prices.json");
    // Ten times the listed rates: if the table priced these rounds the total would be ~10x the bill.
    writeFileSync(prices, JSON.stringify({ [OR.response.model]: { input: 1.5, output: 4.7, cache_read: 0.16, cache_write: 2 } }));
    env({ COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k", COLTRANE_TIER_STANDARD: OR.response.model, COLTRANE_PRICES_FILE: prices });
    const res = await dispatch(bootstrapServerDeps(root), "one-seat");
    expect(res.ok, res.error ?? "").toBe(true);
    expect(manifestOf(res)?.usage?.total_cost_usd, "the price table overrode the provider's own charge").toBeCloseTo(sent.length * (OR.response.usage.cost ?? NaN), 12);
  });

  it("L2e — no reported cost: the price table prices the round, cache reads AND cache writes at their own rates", async () => {
    const noCost = (): OrUsage => { const u = structuredClone(OR.response.usage); delete u.cost; return u; };
    const { fn, sent } = openrouter(OR.response.model, noCost);
    vi.stubGlobal("fetch", fn);
    const prices = join(root, "prices.json");
    const rate = { input: 0.15, output: 0.47, cache_read: 0.016, cache_write: 0.2 };
    writeFileSync(prices, JSON.stringify({ [OR.response.model]: rate }));
    env({ COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k", COLTRANE_TIER_STANDARD: OR.response.model, COLTRANE_PRICES_FILE: prices });
    const res = await dispatch(bootstrapServerDeps(root), "one-seat");
    expect(res.ok, res.error ?? "").toBe(true);
    const s = expectedOrSplit(OR.response.usage);
    const perRound = (s.input_tokens * rate.input + s.cache_read_tokens * rate.cache_read + (s.cache_write_tokens ?? 0) * rate.cache_write + s.output_tokens * rate.output) / 1_000_000;
    expect(manifestOf(res)?.usage?.total_cost_usd, "cache writes were priced as uncached input (or not priced at their own rate)").toBeCloseTo(sent.length * perRound, 12);
  });

  it("L2f — a model with NO known price is never reported as $0: the gig marks it unpriced and the record carries no cost", async () => {
    // What OpenRouter can really do: serve a dated variant of the slug the table is keyed by, and (for
    // a provider that reports no cost) leave the round with no price the engine knows.
    const noCost = (): OrUsage => { const u = structuredClone(OR.response.usage); delete u.cost; return u; };
    const { fn } = openrouter(`${OR.response.model}-0901`, noCost);
    vi.stubGlobal("fetch", fn);
    const prices = join(root, "prices.json");
    writeFileSync(prices, JSON.stringify({ [OR.response.model]: { input: 0.15, output: 0.47, cache_read: 0.016, cache_write: 0.2 } }));
    env({ COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k", COLTRANE_TIER_STANDARD: OR.response.model, COLTRANE_PRICES_FILE: prices });
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "one-seat");
    expect(res.ok, res.error ?? "").toBe(true);
    const usage = manifestOf(res)?.usage;
    expect(usage?.input_tokens ?? 0, "an unpriced run must still settle its tokens").toBeGreaterThan(0);
    expect(usage?.unpriced_invocations, `an unpriced chair folded into total_cost_usd=${String(usage?.total_cost_usd)} with nothing marking it unpriced`).toBe(1);
    const records = deps.outputs.all().filter((o) => o.gig_id === gigIdOf(res));
    expect(records.length, "the chair sealed nothing").toBeGreaterThan(0);
    for (const r of records) {
      expect(r.cost_usd, `sealed record ${r.id} claims cost_usd=${String(r.cost_usd)} for a chair no price was known for`).toBeUndefined();
    }
  });

  // ── ROUND 2 (on 02c591f) — survivors the implementer's plants left standing ─────────────────────

  /** A dispatch whose one chair is served `served` with `usage` on every round, under `prices` (or none). */
  async function settle(served: string, usage: () => OrUsage, prices?: Record<string, unknown>) {
    const { fn, sent } = openrouter(served, usage);
    vi.stubGlobal("fetch", fn);
    const vars: Partial<Record<(typeof ENV_KEYS)[number], string>> = { COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k", COLTRANE_TIER_STANDARD: served };
    if (prices) {
      const f = join(root, "prices.json");
      writeFileSync(f, JSON.stringify(prices));
      vars.COLTRANE_PRICES_FILE = f;
    }
    env(vars);
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "one-seat");
    expect(res.ok, res.error ?? "").toBe(true);
    return { deps, res, sent, usage: manifestOf(res)?.usage, records: deps.outputs.all().filter((o) => o.gig_id === gigIdOf(res)) };
  }
  const withCost = (cost: number | undefined) => (): OrUsage => {
    const u = structuredClone(OR.response.usage);
    if (cost === undefined) delete u.cost; else u.cost = cost;
    return u;
  };

  it("L2g — a REPORTED 0 is a known price: a :free model settles at $0 and is NOT unpriced, even over a price table", async () => {
    // Priced at a non-zero rate in the table, so a 0 treated as "missing" would fall through to the
    // table (a positive total) — and with no table it would be unpriced. Both are red.
    const free = "qwen/qwen3.8-27b:free";
    for (const prices of [undefined, { [free]: { input: 0.42, output: 3, cache_read: 0.085, cache_write: 0.5 } }]) {
      const { usage, records } = await settle(free, withCost(0), prices);
      const where = prices ? "with a price table" : "with no price table";
      expect(usage?.unpriced_invocations ?? 0, `${where}: a reported cost of 0 was treated as no cost (unpriced)`).toBe(0);
      expect(usage?.total_cost_usd, `${where}: a reported cost of 0 did not settle as $0`).toBe(0);
      expect(records.length).toBeGreaterThan(0);
      expect(records[0]!.cost_usd, `${where}: the free chair's record does not carry its known $0`).toBe(0);
    }
  });

  it("L2h — a NEGATIVE reported cost is never a credit: it is not a cost, so with no price table the round is unpriced", async () => {
    // DECISION (red-spec): a reported cost that is negative or non-finite is DISREGARDED as a cost — the
    // round falls to the price table, and with none it is unpriced. It is never settled, never subtracted.
    const { usage, records } = await settle(OR.response.model, withCost(-0.5));
    expect(usage?.total_cost_usd ?? 0, "a negative reported cost was settled as a credit").toBeGreaterThanOrEqual(0);
    expect(usage?.unpriced_invocations, "a negative reported cost was accepted as a known price").toBe(1);
    for (const r of records) expect(r.cost_usd, "a record carries a cost derived from a negative report").toBeUndefined();
  });

  it("L2i — a token class reporting 0 needs no rate: cache_write_tokens 0 on a model with no cache_write price is still priced", async () => {
    const zeroWrites = (): OrUsage => {
      const u = withCost(undefined)();
      u.prompt_tokens_details = { ...u.prompt_tokens_details, cache_write_tokens: 0 };
      return u;
    };
    const rate = { input: 0.3, output: 1.2, cache_read: 0.006 }; // deepseek-style: no cache_write rate
    const { usage, sent } = await settle(OR.response.model, zeroWrites, { [OR.response.model]: rate });
    expect(usage?.unpriced_invocations ?? 0, "a zero-token class with no rate left the round unpriced").toBe(0);
    const u = OR.response.usage;
    const read = u.prompt_tokens_details?.cached_tokens ?? 0;
    const perRound = ((u.prompt_tokens - read) * rate.input + read * rate.cache_read + u.completion_tokens * rate.output) / 1_000_000;
    expect(usage?.total_cost_usd).toBeCloseTo(sent.length * perRound, 12);
  });

  it("L2j — the per-chair chair_spend row carries the unpriced count, not a bare $0", async () => {
    const { deps, res } = await settle(`${OR.response.model}-0901`, withCost(undefined), { [OR.response.model]: { input: 0.15, output: 0.47 } });
    const rows = deps.ledger.query({ gig_id: gigIdOf(res) }).filter((e) => e.kind === "chair_spend") as Array<{ captured?: boolean; usage?: { unpriced_invocations?: number; total_cost_usd?: number } }>;
    expect(rows.length, "no chair_spend row was written for the chair").toBeGreaterThan(0);
    const unpriced = rows.reduce((n, r) => n + (r.usage?.unpriced_invocations ?? 0), 0);
    expect(unpriced, `the chair_spend row(s) settled total_cost_usd=${rows.map((r) => String(r.usage?.total_cost_usd)).join(",")} with nothing marking them unpriced`).toBe(1);
  });

  it("L2k — NEGATIVE-INPUT GUARD: cache reads + writes exceeding prompt_tokens is REFUSED loudly, naming the fields; input never goes negative", async () => {
    // DECISION (red-spec): refuse, never clamp. If OpenRouter counts cache writes OUTSIDE prompt_tokens,
    // the subset reading is wrong and every number derived from it is wrong; a clamped 0 would hide
    // exactly the fact the live smoke exists to find. The port throws, which the loop types as
    // transport_failed, and the message names the three fields and their values.
    const portWith = (usage: OrUsage) => makeChatCompletionsPort({
      baseUrl: URL_BASE, apiKey: "k",
      fetchFn: (async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ ...OR.response, usage }) })) as unknown as typeof fetch,
    });
    const req = { model: OR.response.model, messages: [{ role: "user" as const, content: "x" }], tools: [], signal: new AbortController().signal };
    const over: OrUsage = { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 50 } };
    let reply: unknown;
    let error: unknown;
    try { reply = await portWith(over)(req); } catch (e) { error = e; }
    const input = (reply as { usage?: { input_tokens?: number } } | undefined)?.usage?.input_tokens;
    expect(error, `reads 80 + writes 50 > prompt 100 was mapped (input_tokens=${String(input)}) instead of refused`).toBeInstanceOf(Error);
    const msg = String((error as Error).message);
    for (const field of ["prompt_tokens", "cached_tokens", "cache_write_tokens"]) {
      expect(msg, `the refusal does not name ${field}`).toContain(field);
    }
    // Non-vacuity: reads + writes EQUAL to the prompt is consistent — mapped, with zero uncached input.
    const exact = await portWith({ prompt_tokens: 130, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 50 } })(req);
    expect(exact.usage).toMatchObject({ input_tokens: 0, cache_read_tokens: 80, cache_write_tokens: 50 });
  });

  it("L2l — the CLI dispatch summary says \"unpriced (N …)\" whenever an invocation is unpriced, never a bare total", async () => {
    const { fn } = openrouter(`${OR.response.model}-0901`, withCost(undefined));
    vi.stubGlobal("fetch", fn);
    env({ COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k", COLTRANE_TIER_STANDARD: OR.response.model });
    const errBuf: string[] = [];
    const io: CliIO = { out: () => {}, err: (s: string) => { errBuf.push(s); }, deps: bootstrapServerDeps(root) };
    process.env["PATH"] = dirname(process.execPath);
    let code: number;
    try {
      code = await runCli(["dispatch", "one-seat", "--wait", "--input", JSON.stringify({ topic: "t" })], io);
    } finally {
      process.env["PATH"] = savedPath;
    }
    const out = errBuf.join("");
    expect(code, out).toBe(0);
    const complete = out.split("\n").find((l) => l.startsWith("complete")) ?? "";
    expect(complete, "the dispatch printed no completion summary").not.toBe("");
    expect(complete, `the summary over an unpriced run does not say unpriced: ${complete}`).toMatch(/unpriced \(1 /);
  });

  // ── LAW 3 — THE PROVIDER DOC NAMES WHAT THE DOOR READS ─────────────────────────────────────────

  it("L3 — docs/providers/openrouter.md names the flip and EVERY COLTRANE_* variable the completions door reads", () => {
    // Which variables the door reads is MEASURED, not listed: the selector and the ladder read a
    // recording env, so a variable the implementation adds is a variable the doc must name.
    const read = new Set<string>();
    const recording = new Proxy({ COLTRANE_COMPLETIONS_URL: "https://openrouter.ai/api/v1", COLTRANE_TIER_LADDER: "economy" } as Record<string, string | undefined>, {
      get(t, k) { if (typeof k === "string") read.add(k); return t[k as string]; },
    });
    selectChairInvoker(recording, { claude: {}, fetchFn: (async () => { throw new Error("no call"); }) as unknown as typeof fetch });
    amendLadderFromEnv(recording);
    const vars = [...read].filter((k) => k.startsWith("COLTRANE_")).sort();
    expect(vars, "the completions door does not read the one-line model variable").toContain("COLTRANE_MODEL");
    const docPath = join(REPO_ROOT, "docs", "providers", "openrouter.md");
    expect(existsSync(docPath), "docs/providers/openrouter.md does not exist").toBe(true);
    const doc = readFileSync(docPath, "utf8");
    expect(doc, "the doc does not give OpenRouter's base URL").toContain("COLTRANE_COMPLETIONS_URL=https://openrouter.ai/api/v1");
    const missing = vars.filter((v) => !doc.includes(v));
    expect(missing, "the provider doc omits variables the completions door reads").toEqual([]);
  });
});
