// The completions port SEALS the way the Claude port does: in-band, through `output_write`, adjudicated
// against the full contract and corrected by the seat within its own run.
//
// THE GAP. selectChairInvoker built the completions invoker with no tool source, and nothing supplied
// one, so a seat with any grant refused `no_tool_source` — and a grant-less seat sealed its final TEXT,
// parsed once, with no way to be told what was wrong. Measured across the eir-drafting genome's runs on
// Claude: 88 of 126 tool calls were `output_write`, most of them corrections. A cheap model gets that
// loop or it gets nothing.
//
// THE SHAPE. On a host running coltrane in-process the bridge is NOT an MCP client: `dispatchTool` is
// already the tool surface. The engine tool source calls it with the write boundary pinned to VALIDATE
// — adjudicate, never persist — so the runtime stays the one sealer. A bridge that built deps without
// that mode would double-seal, or (on a store that refuses) seal nothing; both silent.
//
// THE RULE. A completions seat seals only by an accepted `output_write` call. A seat that answers in
// text without ever calling it gets ONE repair turn; a seat that still seals nothing is refused
// `no_seal`, and its text is never sealed in its place.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootstrapServerDeps, dispatchTool, type ServerDeps } from "../src/server.js";
import { drainChairInvoker } from "../src/cli.js";
import { createRegistry } from "../src/index.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";

const CORE_TYPES = ["Signal:SENSE", "Interpretation:INTERPRET", "Judgment:JUDGE", "Plan:PLAN", "Artifact:CREATE", "Verdict:VERIFY"].map(
  (s) => ({ slug: s.split(":")[0], primitive: s.split(":")[1], description: "", schema: {} }),
);
const URL_BASE = "https://completions.test/v1";
const ENV_KEYS = [
  "COLTRANE_COMPLETIONS_URL", "COLTRANE_COMPLETIONS_KEY", "COLTRANE_TIER_ECONOMY", "COLTRANE_TIER_STANDARD",
  "COLTRANE_TIER_PREMIUM", "COLTRANE_PRICES_FILE", "COLTRANE_LEDGER_PATH", "COLTRANE_COMPLETIONS_MAX_TOKENS",
  "COLTRANE_OUTPUTS_DIR", "COLTRANE_TRANSCRIPTS_DIR",
] as const;

function writeJson(dir: string, name: string, body: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
}

type Msg = { role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; tool_call_id?: string };
interface Body { model: string; messages: Msg[]; tools?: Array<{ function: { name: string } }>; max_tokens?: number }

/** A scripted model. `turn(body, n)` returns what the model says on its n-th request. */
function model(turn: (body: Body, n: number) => { text?: string; calls?: Array<{ tool: string; args: Record<string, unknown> }> }) {
  const sent: Body[] = [];
  const fn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Body;
    sent.push(body);
    const t = turn(body, sent.length - 1);
    const wire = (tool: string) => body.tools?.map((x) => x.function.name).find((n) => n.endsWith(tool)) ?? tool;
    const calls = (t.calls ?? []).map((c, i) => ({ id: `call_${sent.length}_${i}`, type: "function", function: { name: wire(c.tool), arguments: JSON.stringify(c.args) } }));
    const reply = {
      model: "served-cheap",
      choices: [{ message: { role: "assistant", content: t.text ?? null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    };
    return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) };
  });
  return { fn, sent };
}

const write = (data: Record<string, unknown>, domain_type = "note") => ({ tool: "output_write", args: { domain_type, data } });
const toolMessages = (b: Body) => b.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
const REPAIR = /sealed NOTHING/;

describe("a completions seat seals through output_write", () => {
  let root: string;
  let saved: Record<string, string | undefined>;
  let savedPath: string | undefined;

  const env = (vars: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env["COLTRANE_LEDGER_PATH"] = join(root, "ledger.jsonl");
    process.env["COLTRANE_OUTPUTS_DIR"] = join(root, "outputs");
    Object.assign(process.env, { COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k", COLTRANE_TIER_STANDARD: "model-std", ...vars });
  };

  async function dispatch(deps: ServerDeps, standard_slug: string) {
    process.env["PATH"] = dirname(process.execPath);
    try {
      return await dispatchTool("gig_dispatch", { standard_slug, input: {}, wait: true }, deps);
    } finally {
      process.env["PATH"] = savedPath;
    }
  }

  const sealedNotes = (deps: ServerDeps, gig_id: string) => deps.outputs.all().filter((o) => o.gig_id === gig_id && o.domain_type === "note");
  const gigOf = (res: { data?: unknown }) => String((res.data as { gig_id?: string })?.gig_id ?? "");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coltrane-completions-seal-"));
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    savedPath = process.env["PATH"];
    for (const c of CORE_TYPES) writeJson(join(root, "core_types"), `${c.slug}.json`, c);
    writeJson(join(root, "domain_types"), "note.json", {
      slug: "note", extends: "Signal", domain: "demo",
      schema: { type: "object", properties: { claim: { type: "string" } } }, required_fields: ["claim"],
    });
    const agent = (slug: string, allowed_tools: string[] = []) =>
      writeJson(join(root, "agents"), `${slug}.json`, {
        ...TEST_BEHAVIOR, slug, primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", model_tier: "standard", allowed_tools,
      });
    agent("plain");
    agent("reader", ["output_query"]);
    agent("outsider", ["mcp__elsewhere__fetch"]);
    for (const [std, a] of [["plain-std", "plain"], ["reader-std", "reader"], ["outsider-std", "outsider"]] as const) {
      writeJson(join(root, "standards"), `${std}.json`, {
        slug: std, domain: "demo", status: "active", agent_slugs: [a],
        phases: [{ name: "p", chairs: [{ role: "s", agent_slug: a, depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
      });
    }
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

  it("K1 — a seat sealing through the completions port produces EXACTLY ONE sealed record, carrying what passed the boundary", async () => {
    const m = model((_b, n) => (n === 0 ? { calls: [write({ claim: "sealed in-band", source: "s" })] } : { text: JSON.stringify({ claim: "the text answer", source: "s" }) }));
    vi.stubGlobal("fetch", m.fn);
    env();
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "plain-std");
    expect(res.ok, res.error ?? "").toBe(true);
    const notes = sealedNotes(deps, gigOf(res));
    expect(notes.length, "one chair, one output_write that passed → one sealed record").toBe(1);
    expect(notes[0]!.data["claim"], "the seal is the accepted output_write payload, never the text answer").toBe("sealed in-band");
    expect(m.sent[0]!.tools?.some((t) => t.function.name.endsWith("output_write")), "the seat must be offered output_write").toBe(true);
  });

  it("K2 — a rejected write comes back to the seat in-band with the reason, and its correction is what seals", async () => {
    const m = model((_b, n) =>
      n === 0 ? { calls: [write({ source: "s" })] }                              // missing the required `claim`
        : n === 1 ? { calls: [write({ claim: "corrected", source: "s" })] }
          : { text: "done" });
    vi.stubGlobal("fetch", m.fn);
    env();
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "plain-std");
    expect(res.ok, res.error ?? "").toBe(true);
    expect(toolMessages(m.sent[1]!).join("\n"), "the rejection, and its reason, reach the seat").toMatch(/claim/);
    const notes = sealedNotes(deps, gigOf(res));
    expect(notes.map((n) => n.data["claim"])).toEqual(["corrected"]);
  });

  it("K3 — a seat that answers in text without ever calling output_write gets ONE repair turn, and its write then seals", async () => {
    const m = model((b, n) =>
      n === 0 ? { text: JSON.stringify({ claim: "wrong channel", source: "s" }) }
        : b.messages.some((x) => x.role === "user" && REPAIR.test(String(x.content))) && n === 1 ? { calls: [write({ claim: "right channel", source: "s" })] }
          : { text: "done" });
    vi.stubGlobal("fetch", m.fn);
    env();
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "plain-std");
    expect(res.ok, res.error ?? "").toBe(true);
    expect(sealedNotes(deps, gigOf(res)).map((n) => n.data["claim"])).toEqual(["right channel"]);
    // The repair turn's rounds were spent, so they are settled: 1 round + 2 repair rounds × 100 in.
    const usage = (res.data as { manifest?: { usage?: { input_tokens?: number; by_model?: Record<string, { input_tokens?: number }> } } }).manifest?.usage;
    expect(usage?.input_tokens, "the repair turn's spend must be settled, not dropped").toBe(300);
    expect(usage?.by_model?.["served-cheap"]?.input_tokens, "…and attributed to the model that served it").toBe(300);
  });

  it("K4 — a seat that never seals is refused no_seal after exactly one repair; its valid text is not sealed in its place", async () => {
    const m = model(() => ({ text: JSON.stringify({ claim: "text only", source: "s" }) }));
    vi.stubGlobal("fetch", m.fn);
    env();
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "plain-std");
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/no_seal|sealed nothing/i);
    const repairs = m.sent.filter((b) => b.messages.filter((x) => x.role === "user" && REPAIR.test(String(x.content))).length > 0);
    expect(repairs.length, "the repair is offered once, and only once").toBe(1);
    expect(deps.outputs.all().filter((o) => o.domain_type === "note").length).toBe(0);
  });

  it("K5 — a write of a type the chair does not seal is refused in-band, naming the types it does", async () => {
    const m = model((_b, n) =>
      n === 0 ? { calls: [write({ claim: "x", source: "s" }, "some-other-type")] }
        : n === 1 ? { calls: [write({ claim: "right type", source: "s" })] }
          : { text: "done" });
    vi.stubGlobal("fetch", m.fn);
    env();
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "plain-std");
    expect(res.ok, res.error ?? "").toBe(true);
    expect(toolMessages(m.sent[1]!).join("\n")).toMatch(/seals only[\s\S]*note/);
    expect(sealedNotes(deps, gigOf(res)).map((n) => n.data["claim"])).toEqual(["right type"]);
  });

  it("K6 — a seat granted an engine tool reaches it through dispatchTool (it used to refuse no_tool_source)", async () => {
    const m = model((b, n) =>
      n === 0 ? { calls: [{ tool: "output_query", args: { domain_type: "note" } }] }
        : n === 1 ? { calls: [write({ claim: `queried: ${toolMessages(b).length} result`, source: "s" })] }
          : { text: "done" });
    vi.stubGlobal("fetch", m.fn);
    env();
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "reader-std");
    expect(res.ok, res.error ?? "").toBe(true);
    const offered = m.sent[0]!.tools!.map((t) => t.function.name);
    expect(offered.some((n) => n.endsWith("output_query")) && offered.some((n) => n.endsWith("output_write"))).toBe(true);
    expect(toolMessages(m.sent[1]!).join("\n"), "output_query answered through the engine surface").toMatch(/"ok":\s*true/);
    expect(sealedNotes(deps, gigOf(res)).length).toBe(1);
  });

  it("K7 — a granted tool the source cannot provide is refused before any model call, naming it", async () => {
    const m = model(() => ({ text: "never" }));
    vi.stubGlobal("fetch", m.fn);
    env();
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "outsider-std");
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/mcp__elsewhere__fetch/);
    expect(m.sent.length, "nothing may be spent discovering a chair that cannot run").toBe(0);
  });

  it("K10 — what the boundary accepted is kept even when the turn then runs out of rounds", async () => {
    writeJson(join(root, "agents"), "plain.json", {
      ...TEST_BEHAVIOR, slug: "plain", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", model_tier: "standard", max_tool_calls: 1,
    });
    const m = model(() => ({ calls: [write({ claim: "sealed before the cap", source: "s" })] }));
    vi.stubGlobal("fetch", m.fn);
    env();
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "plain-std");
    expect(res.ok, res.error ?? "").toBe(true);
    expect(sealedNotes(deps, gigOf(res)).map((n) => n.data["claim"])[0]).toBe("sealed before the cap");
  });

  it("K11 — an identical write accepted twice seals ONCE; different writes of one type still seal separately", async () => {
    // eir-drafting gig 3a37d808, facts-5: two records, same content_sha, 5 ms apart — one payload
    // accepted twice (two identical output_write calls in one round), sealed as two records.
    const same = { claim: "the one fact set", source: "s" };
    const m = model((_b, n) =>
      n === 0 ? { calls: [write(same), write(same)] }
        : n === 1 ? { calls: [write({ claim: "a second, different record", source: "s" })] }
          : { text: "done" });
    vi.stubGlobal("fetch", m.fn);
    env();
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "plain-std");
    expect(res.ok, res.error ?? "").toBe(true);
    expect(sealedNotes(deps, gigOf(res)).map((n) => n.data["claim"]).sort()).toEqual(["a second, different record", "the one fact set"]);
  });

  it("K8 — the deployment's output ceiling reaches the request", async () => {
    const m = model((_b, n) => (n === 0 ? { calls: [write({ claim: "c", source: "s" })] } : { text: "done" }));
    vi.stubGlobal("fetch", m.fn);
    env({ COLTRANE_COMPLETIONS_MAX_TOKENS: "1234" });
    const deps = bootstrapServerDeps(root);
    await dispatch(deps, "plain-std");
    expect(m.sent[0]!.max_tokens).toBe(1234);
  });

  it("K9 — the DRAIN door wires the same source: a worker seat seals through output_write too", async () => {
    const m = model((_b, n) => (n === 0 ? { calls: [write({ claim: "from the drain", source: "s" })] } : { text: "done" }));
    env();
    const registry = createRegistry();
    registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { type: "object", properties: { claim: { type: "string" } } }, required_fields: ["claim"] } as never);
    const invoke = drainChairInvoker({ ...process.env }, registry, m.fn as unknown as typeof fetch);
    const blob = await invoke({
      agent: { ...TEST_BEHAVIOR, slug: "plain", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", model_tier: "standard" } as never,
      phase: "p", role: "s", gig_id: "g-drain", inputs: [], gig_input: {}, output_types: ["note"],
    } as never);
    expect(blob).toEqual({ note: [{ claim: "from the drain", source: "s" }] });
  });
});

describe("the drain serves output_write only", () => {
  it("K9b — a drain seat granted a read verb is refused before any model call: the drain's local store holds nothing of the org's", async () => {
    const sent: unknown[] = [];
    const fn = (async (_u: unknown, init?: { body?: unknown }) => { sent.push(init?.body); throw new Error("must not be called"); }) as unknown as typeof fetch;
    const registry = createRegistry();
    registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { type: "object", properties: { claim: { type: "string" } } }, required_fields: ["claim"] } as never);
    const invoke = drainChairInvoker({ COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k", COLTRANE_TIER_STANDARD: "m" }, registry, fn);
    const r = await invoke({
      agent: { ...TEST_BEHAVIOR, slug: "reader", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", model_tier: "standard", allowed_tools: ["output_query"] } as never,
      phase: "p", role: "s", gig_id: "g", inputs: [], gig_input: {}, output_types: ["note"],
    } as never) as { ok?: boolean; refusal?: string; message?: string };
    expect(r.refusal).toBe("no_tool_source");
    expect(r.message).toMatch(/output_query/);
    expect(sent.length).toBe(0);
  });
});
