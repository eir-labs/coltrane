// THE TIER LADDER — a completions chair that cannot seal on its tier is seated again one tier up.
//
// Not a re-prompt: the governor rejected re-prompting a seat that already had its correction in-band
// (tests/output_write_boundary.test.ts). This is a DIFFERENT PLAYER in the same chair — the next model
// the deployment mapped — seated cold. The rule is deterministic and the deployment's: which tiers, in
// which order, is `COLTRANE_TIER_LADDER`; absent, nothing escalates. No model decides "try harder".
//
// Only SEAL failures climb (no_seal, round_limit, context_limit): a transport failure is the wire's
// fault, not the player's, and a better player would meet the same wire. Every attempt settles its
// spend, and the sealed record names the model and tier that actually SEALED it — not the cheap one
// that failed, and not the tier the agent declared.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootstrapServerDeps, dispatchTool, makeEngineToolSource, type ServerDeps } from "../src/server.js";
import { selectChairInvoker, withTierLadder } from "../src/invoker_selection.js";
import { createRegistry, createOutputStore, MemoryLedger } from "../src/index.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";

const CORE_TYPES = ["Signal:SENSE", "Interpretation:INTERPRET", "Judgment:JUDGE", "Plan:PLAN", "Artifact:CREATE", "Verdict:VERIFY"].map(
  (s) => ({ slug: s.split(":")[0], primitive: s.split(":")[1], description: "", schema: {} }),
);
const URL_BASE = "https://completions.test/v1";
const ENV_KEYS = [
  "COLTRANE_COMPLETIONS_URL", "COLTRANE_COMPLETIONS_KEY", "COLTRANE_TIER_ECONOMY", "COLTRANE_TIER_STANDARD",
  "COLTRANE_TIER_PREMIUM", "COLTRANE_TIER_LADDER", "COLTRANE_LEDGER_PATH", "COLTRANE_OUTPUTS_DIR", "COLTRANE_PRICES_FILE",
] as const;
const TIERS = { COLTRANE_TIER_ECONOMY: "model-eco", COLTRANE_TIER_STANDARD: "model-std", COLTRANE_TIER_PREMIUM: "model-prem" };

function writeJson(dir: string, name: string, body: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
}

interface Body { model: string; messages: Array<{ role: string; content: string | null }>; tools?: Array<{ function: { name: string } }> }

/** A model per concrete id: `sealsOn` models call output_write; the rest answer in text, forever. */
function models(sealsOn: readonly string[], opts: { failWire?: string } = {}) {
  const sent: Body[] = [];
  const fn = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Body;
    sent.push(body);
    if (opts.failWire === body.model) return { ok: false, status: 500, json: async () => ({}), text: async () => "upstream down" };
    const afterTool = body.messages.at(-1)?.role === "tool";
    const write = body.tools?.map((t) => t.function.name).find((n) => n.endsWith("output_write"));
    const seals = sealsOn.includes(body.model) && !afterTool && write;
    const message = seals
      ? { role: "assistant", content: null, tool_calls: [{ id: `c${sent.length}`, type: "function", function: { name: write, arguments: JSON.stringify({ data: { claim: `sealed by ${body.model}`, source: "s" } }) } }] }
      : { role: "assistant", content: afterTool ? "done" : "I would rather describe it in prose." };
    const reply = { model: `served-${body.model}`, choices: [{ message, finish_reason: seals ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } };
    return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) };
  });
  return { fn, sent, modelsSeen: () => [...new Set(sent.map((b) => b.model))] };
}

describe("the tier ladder", () => {
  let root: string;
  let saved: Record<string, string | undefined>;
  let savedPath: string | undefined;

  const env = (vars: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env["COLTRANE_LEDGER_PATH"] = join(root, "ledger.jsonl");
    process.env["COLTRANE_OUTPUTS_DIR"] = join(root, "outputs");
    Object.assign(process.env, { COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k", ...TIERS, ...vars });
  };
  const LADDER = { COLTRANE_TIER_LADDER: "economy,standard,premium" };

  async function dispatch(deps: ServerDeps, standard_slug: string) {
    process.env["PATH"] = dirname(process.execPath);
    try {
      return await dispatchTool("gig_dispatch", { standard_slug, input: {}, wait: true }, deps);
    } finally {
      process.env["PATH"] = savedPath;
    }
  }
  const notesOf = (deps: ServerDeps, res: { data?: unknown }) => {
    const gig = String((res.data as { gig_id?: string })?.gig_id ?? "");
    return deps.outputs.all().filter((o) => o.gig_id === gig && o.domain_type === "note");
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coltrane-tier-ladder-"));
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    savedPath = process.env["PATH"];
    for (const c of CORE_TYPES) writeJson(join(root, "core_types"), `${c.slug}.json`, c);
    writeJson(join(root, "domain_types"), "note.json", {
      slug: "note", extends: "Signal", domain: "demo", schema: { type: "object", properties: { claim: { type: "string" } } }, required_fields: ["claim"],
    });
    for (const tier of ["economy", "standard", "premium"]) {
      writeJson(join(root, "agents"), `${tier}-seat.json`, {
        ...TEST_BEHAVIOR, slug: `${tier}-seat`, primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", model_tier: tier,
      });
      writeJson(join(root, "standards"), `${tier}-std.json`, {
        slug: `${tier}-std`, domain: "demo", status: "active", agent_slugs: [`${tier}-seat`],
        phases: [{ name: "p", chairs: [{ role: "s", agent_slug: `${tier}-seat`, depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
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

  it("T1 — a chair that cannot seal on economy is seated again on standard, and the record names who SEALED it", async () => {
    const m = models(["model-std"]);
    vi.stubGlobal("fetch", m.fn);
    env(LADDER);
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "economy-std");
    expect(res.ok, res.error ?? "").toBe(true);
    expect(m.modelsSeen()).toEqual(["model-eco", "model-std"]);
    const [note] = notesOf(deps, res);
    expect(note!.data["claim"]).toBe("sealed by model-std");
    expect(note!.model, "the stamp names the model that sealed, not the one that failed").toBe("served-model-std");
    expect(note!.model_tier, "the stamp names the tier the chair sealed at, not the one it declared").toBe("standard");
  });

  it("T2 — every attempt's spend is settled: the failed economy seat's rounds are not lost", async () => {
    const m = models(["model-std"]);
    vi.stubGlobal("fetch", m.fn);
    env(LADDER);
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "economy-std");
    const usage = (res.data as { manifest?: { usage?: { input_tokens?: number; by_model?: Record<string, { input_tokens?: number }> } } }).manifest?.usage;
    expect(usage?.input_tokens).toBe(100 * m.sent.length);
    const ecoRounds = m.sent.filter((b) => b.model === "model-eco").length;
    expect(ecoRounds, "the economy seat ran its turn and its repair turn").toBeGreaterThanOrEqual(2);
    expect(usage?.by_model?.["served-model-eco"]?.input_tokens).toBe(100 * ecoRounds);
  });

  it("T3 — the ladder is climbed to its top and no further; the refusal names every tier tried", async () => {
    const m = models([]);
    vi.stubGlobal("fetch", m.fn);
    env(LADDER);
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "economy-std");
    expect(res.ok).toBe(false);
    expect(m.modelsSeen()).toEqual(["model-eco", "model-std", "model-prem"]);
    expect(String(res.error)).toMatch(/economy[\s\S]*standard[\s\S]*premium/);
  });

  it("T4 — a chair starts on its OWN tier: a standard chair's next rung is premium", async () => {
    const m = models(["model-prem"]);
    vi.stubGlobal("fetch", m.fn);
    env(LADDER);
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "standard-std");
    expect(res.ok, res.error ?? "").toBe(true);
    expect(m.modelsSeen()).toEqual(["model-std", "model-prem"]);
  });

  it("T5 — a transport failure does not climb: a better player meets the same wire", async () => {
    const m = models(["model-std"], { failWire: "model-eco" });
    vi.stubGlobal("fetch", m.fn);
    env(LADDER);
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "economy-std");
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/transport_failed/);
    expect(m.modelsSeen()).toEqual(["model-eco"]);
  });

  it("T6 — a next rung with no model mapped is not climbed, and the refusal says so", async () => {
    const m = models([]);
    vi.stubGlobal("fetch", m.fn);
    env({ ...LADDER, COLTRANE_TIER_STANDARD: "" });
    delete process.env["COLTRANE_TIER_STANDARD"];
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "economy-std");
    expect(res.ok).toBe(false);
    expect(m.modelsSeen()).toEqual(["model-eco"]);
    expect(String(res.error)).toMatch(/"standard" has no model mapped/);
  });

  it("T7 (control) — without COLTRANE_TIER_LADDER nothing climbs", async () => {
    const m = models(["model-std"]);
    vi.stubGlobal("fetch", m.fn);
    env();
    const deps = bootstrapServerDeps(root);
    const res = await dispatch(deps, "economy-std");
    expect(res.ok).toBe(false);
    expect(m.modelsSeen()).toEqual(["model-eco"]);
  });

  it("T8 — the climb is an event on the chair's stream, naming from, to and why", async () => {
    const m = models(["model-std"]);
    env(LADDER);
    const registry = createRegistry();
    registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { type: "object", properties: { claim: { type: "string" } } }, required_fields: ["claim"] } as never);
    const v: ServerDeps = { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), gig_runs: new Map() };
    const invoke = selectChairInvoker({ ...process.env }, { registry, claude: {}, fetchFn: m.fn as unknown as typeof fetch, tools: makeEngineToolSource(() => v) });
    const events: Array<{ type: string; raw?: unknown }> = [];
    await invoke({
      agent: { ...TEST_BEHAVIOR, slug: "economy-seat", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", model_tier: "economy" } as never,
      phase: "p", role: "s", gig_id: "g", inputs: [], gig_input: {}, output_types: ["note"], onEvent: (e: { type: string; raw?: unknown }) => events.push(e),
    } as never);
    const climb = events.find((e) => e.type === "tier_escalated");
    expect(climb, "the escalation must be on the record").toBeTruthy();
    expect(climb!.raw).toMatchObject({ from_tier: "economy", to_tier: "standard" });
  });

  it("T10 — the next rung is seated COLD, even mid-amend: the next player holds none of the last one's conversation", async () => {
    const seen: Array<{ tier: unknown; resume: unknown; keep: unknown }> = [];
    const inner = (async (ctx: { agent: { model_tier?: string }; resume?: boolean; resume_keep_prompt?: boolean }) => {
      seen.push({ tier: ctx.agent.model_tier, resume: ctx.resume, keep: ctx.resume_keep_prompt });
      return seen.length === 1 ? { ok: false, refusal: "no_seal", message: "nothing" } : { note: [{ claim: "c", source: "s" }] };
    }) as never;
    const invoke = withTierLadder(inner, ["economy", "standard"], { economy: "e", standard: "s" });
    await invoke({ agent: { slug: "a", model_tier: "economy" }, resume: true, resume_keep_prompt: true } as never);
    expect(seen[0]).toMatchObject({ tier: "economy", resume: true });
    expect(seen[1]).toMatchObject({ tier: "standard", resume: false, keep: false });
  });

  it("T9 — a ladder naming a tier that does not exist refuses at startup", () => {
    env({ COLTRANE_TIER_LADDER: "economy,turbo" });
    expect(() => bootstrapServerDeps(root)).toThrow(/COLTRANE_TIER_LADDER[\s\S]*turbo/);
  });
});
