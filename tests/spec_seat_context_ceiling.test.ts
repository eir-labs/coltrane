// RED — contract-seat-context-ceiling-v1. A seat's context ceiling is DECLARED like its effort:
// dispatch ▷ agent ▷ none — absent means NONE, never a guessed default. The declared ceiling reaches
// the invocation context (O2), the chat-completions invoker hands it to runTurn as `max_context_tokens`
// (O3), and when runTurn stops `context_limit` the chair fails with a TYPED `context_limit` refusal
// that names the tokens reached and the ceiling — never sealing a partial answer as complete (O4).
// Spec: docs/specs/seat-context-ceiling.red-spec.md.
//
// WHY. Since 0685280 runTurn stops `context_limit` after the round whose context crosses
// TurnLoopOptions.max_context_tokens — but NOTHING sets it: no agent field, no dispatch argument, and
// the chat-completions invoker never passes one. So no turn-loop (DeepSeek) seat has a ceiling, and
// measured the same week a seat's cost is turns × context with contexts climbing 27k → 300k+ tokens.
// The turn loop already carries the seam (tests/spec_turn_loop.test.ts, tests/spec_seat_metrics.test.ts
// are its GREEN controls); every law below fails today because the WIRING to that seam does not exist.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runGig, createRegistry, createOutputStore, MemoryLedger, loadGenome,
  type AgentInvoker, type AgentInvocationContext, type DomainType, type Agent, type Standard,
} from "../src/index.js";
import { AgentSchema } from "../src/genome_schema.js";
import { defineAgent } from "../src/composition.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { runCli, type CliIO } from "../src/cli.js";
import { MCP_TOOLS } from "../src/mcp.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { loadCompletions, fakeCompletions, recordingTools, type McpToolDef } from "./spec_completions_fixtures.js";

// ctx-note is Signal-cored, so a seal carries { source } beside its payload.
const ctxNote: DomainType = { slug: "ctx-note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: ["value"] };
const SEAL = { value: "c", source: "fixture://demo/ctx" };

// A full Agent literal (bypasses defineAgent stripping, so a declared `max_context_tokens` survives
// for the resolver). model_tier defaults to economy so a completions seat resolves a model.
const seat = (over: Record<string, unknown>): Agent =>
  ({ ...TEST_BEHAVIOR, slug: "seat", primitives: ["SENSE"], input_types: [], output_types: ["ctx-note"], domain: "demo", model_tier: "economy", ...over }) as unknown as Agent;
const oneChair = (agent: Agent): Standard =>
  ({ slug: "ctx-demo", domain: "demo", agents: [agent],
     phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: agent.slug, depends_on: [], input_contract: [], output_contract: ["ctx-note"], required_skills: [] }] }] }) as unknown as Standard;
const runDeps = (invoke: AgentInvoker, extra: Record<string, unknown> = {}) => {
  const registry = createRegistry();
  registry.registerType(ctxNote);
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, ...extra } as unknown as Parameters<typeof runGig>[2];
};
const doorDeps = (agent: Agent, invoke: AgentInvoker): ServerDeps => {
  const registry = createRegistry();
  registry.registerType(ctxNote);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
           standards: new Map([["ctx-demo", oneChair(agent)]]), invoke, gig_runs: new Map() } as unknown as ServerDeps;
};

// ── wire fixtures for the completions door (the port converts prompt_tokens → context tokens) ──────
const ENGINE_TOOLS: McpToolDef[] = [{ name: "mcp__coltrane__output_query", inputSchema: { type: "object" } }];
const toolTurn = (name: string, id: string, usage: Record<string, unknown>) => ({
  choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] }, finish_reason: "tool_calls" }],
  model: "served-x", usage,
});
const jsonTurn = (obj: unknown, usage: Record<string, unknown>) => ({
  choices: [{ message: { role: "assistant", content: JSON.stringify(obj) }, finish_reason: "stop" }],
  model: "served-x", usage,
});
const wire = (prompt_tokens: number, completion_tokens: number) => ({ prompt_tokens, completion_tokens });
function ctxFor(agent: Agent, over: Partial<AgentInvocationContext> = {}): AgentInvocationContext {
  return { agent, phase: "sense", inputs: [], gig_input: {}, output_types: ["ctx-note"], ...over } as AgentInvocationContext;
}
/** A completions invoker over a fake endpoint whose transport is supplied per-law. */
async function completionsInvoker(fetchFn: typeof fetch, tools = recordingTools(ENGINE_TOOLS).source) {
  const C = await loadCompletions();
  const registry = createRegistry();
  registry.registerType(ctxNote);
  return C.makeCompletionsInvoker({ baseUrl: "https://endpoint.test/v1", apiKey: "k", registry, tierMap: { economy: "served-x" }, fetchFn, tools });
}

// ── O1 — the field is authorable and dispatchable ─────────────────────────────────────────────────
describe("O1 — max_context_tokens is authorable on an agent and dispatchable at the door", () => {
  it("O1 — AgentSchema keeps a valid positive-integer ceiling and refuses a non-positive/non-integer, naming agent + field", () => {
    const plain = defineAgent({ ...TEST_BEHAVIOR, slug: "kept", primitives: ["SENSE"] } as never);
    const withCap = defineAgent({ ...TEST_BEHAVIOR, slug: "kept", primitives: ["SENSE"], max_context_tokens: 50_000 } as never);
    expect((plain as unknown as Record<string, unknown>)["max_context_tokens"], "no declaration ⇒ no ceiling").toBeUndefined();
    expect((withCap as unknown as Record<string, unknown>)["max_context_tokens"], "a declared positive-integer ceiling must survive the parse; today the field does not exist so it is stripped").toBe(50_000);
    expect(() => defineAgent({ ...TEST_BEHAVIOR, slug: "bad-seat", primitives: ["SENSE"], max_context_tokens: -5 } as never),
      "a negative ceiling must be refused at load, not loaded with a guess").toThrow(/max_context_tokens/i);
    expect(() => defineAgent({ ...TEST_BEHAVIOR, slug: "bad-seat", primitives: ["SENSE"], max_context_tokens: -5 } as never)).toThrow(/bad-seat/);
    expect(AgentSchema.safeParse({ ...TEST_BEHAVIOR, slug: "bad-seat", primitives: ["SENSE"], constraints: [], max_context_tokens: 3.5 }).success,
      "a non-integer ceiling must fail the schema; today the field is unknown, stripped, and passes").toBe(false);
    expect(AgentSchema.safeParse({ ...TEST_BEHAVIOR, slug: "ok-seat", primitives: ["SENSE"], constraints: [], max_context_tokens: 50_000 }).success,
      "a positive-integer ceiling must parse").toBe(true);
  });

  it("O1 — gig_dispatch advertises `max_context_tokens` in its MCP input schema", () => {
    const tool = MCP_TOOLS.find((t) => t.slug === "gig_dispatch");
    expect(tool, "gig_dispatch is not advertised").toBeDefined();
    const props = (tool!.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props["max_context_tokens"], "a control the handler reads must be discoverable (#234)").toBeDefined();
  });

  it("O1 — `coltrane dispatch <std> --max-context-tokens 50000` reaches the invocation as ctx.max_context_tokens", async () => {
    let seen: unknown = "unset";
    const invoke: AgentInvoker = (c) => { seen = (c as unknown as Record<string, unknown>)["max_context_tokens"]; return { ...SEAL }; };
    const io = { out: () => {}, err: () => {}, deps: doorDeps(seat({ slug: "std-seat" }), invoke) } as unknown as CliIO;
    const code = await runCli(["dispatch", "ctx-demo", "--max-context-tokens", "50000", "--wait"], io);
    expect(code, "dispatch failed").toBe(0);
    expect(seen, "the CLI drops --max-context-tokens and no resolver sets ctx.max_context_tokens").toBe(50_000);
  });
});

// ── O2 — the ceiling resolves dispatch ▷ agent ▷ none, onto ctx.max_context_tokens ────────────────
describe("O2 — the ceiling resolves dispatch ▷ agent ▷ none, onto the invocation context", () => {
  const resolvedFor = async (agent: Agent, dispatchCap?: number): Promise<unknown> => {
    let seen: unknown = "unset";
    const invoke: AgentInvoker = (c) => { seen = (c as unknown as Record<string, unknown>)["max_context_tokens"]; return { ...SEAL }; };
    await runGig(oneChair(agent), {}, runDeps(invoke, dispatchCap !== undefined ? { max_context_tokens: dispatchCap } : {}));
    return seen;
  };
  it("the agent's declared ceiling reaches the invoker, and a dispatch ceiling OVERRIDES it", async () => {
    expect(await resolvedFor(seat({ slug: "a1", max_context_tokens: 50_000 })), "the agent's ceiling never reached the invocation context").toBe(50_000);
    expect(await resolvedFor(seat({ slug: "a2", max_context_tokens: 50_000 }), 20_000), "the dispatch ceiling did not override the agent's").toBe(20_000);
  });
});

// ── I1 — absent means NONE: a no-ceiling seat runs to done past any context size ───────────────────
describe("I1 — with no ceiling declared, runTurn receives none and the turn runs to done past any context", () => {
  // ONE law, by CONTRAST: the SAME oversized transport (round 1's context is 5000 tokens, far past
  // any tens-of-thousands default) runs to `done` and SEALS when no ceiling is declared, and STOPS at
  // `context_limit` when one is. The done half is I1's contract reason ("absent ⇒ no guessed default");
  // the stop half is what makes the law RED today — the invoker enforces no ceiling at all yet.
  const script = () => fakeCompletions([toolTurn("mcp__coltrane__output_query", "a", wire(5000, 10)), jsonTurn(SEAL, wire(10, 5))]);
  it("no ceiling ⇒ done + sealed; a declared ceiling ⇒ context_limit — proving absent is not a default", async () => {
    const bare = script();
    const resBare = await (await completionsInvoker(bare.fn))(ctxFor(seat({ slug: "bare", allowed_tools: ["mcp__coltrane__output_query"] })));
    expect(resBare["refusal"], "an undeclared ceiling invented a default and stopped the turn").toBeUndefined();
    expect(resBare["value"], "a no-ceiling seat did not run to done and seal past a large context").toBe("c");
    expect(bare.calls, "the no-ceiling turn did not run every round to the answer").toHaveLength(2);

    const capped = script();
    const resCap = await (await completionsInvoker(capped.fn))(ctxFor(seat({ slug: "capped", allowed_tools: ["mcp__coltrane__output_query"] }), { max_context_tokens: 1000 } as Partial<AgentInvocationContext>));
    expect(resCap["refusal"], "a declared ceiling was not enforced — the same oversized turn ran on").toBe("context_limit");
  });
});

// ── O3 — the chat-completions invoker hands the resolved ceiling to runTurn ────────────────────────
describe("O3 — the invoker passes the resolved ceiling to runTurn as max_context_tokens", () => {
  it("a ceiling on the ctx stops the seat the round its context crosses it — no model call is made after", async () => {
    const t = fakeCompletions([toolTurn("mcp__coltrane__output_query", "a", wire(5000, 10)), jsonTurn(SEAL, wire(10, 5))]);
    const res = await (await completionsInvoker(t.fn))(ctxFor(seat({ slug: "over", allowed_tools: ["mcp__coltrane__output_query"] }), { max_context_tokens: 1000 } as Partial<AgentInvocationContext>));
    expect(res["refusal"], "the ceiling never reached runTurn — the seat ran past its context budget").toBe("context_limit");
    expect(t.calls, "a model call was made AFTER the context ceiling was crossed — runTurn saw no ceiling").toHaveLength(1);
  });
});

// ── O4 — a context_limit stop is a TYPED refusal that names reached + ceiling, never a sealed partial ─
describe("O4 — a context_limit stop becomes a typed refusal naming the tokens reached and the ceiling", () => {
  it("returns { ok:false, refusal:'context_limit' } naming reached (5000) and ceiling (1000), and seals no answer", async () => {
    const t = fakeCompletions([toolTurn("mcp__coltrane__output_query", "a", wire(5000, 10)), jsonTurn(SEAL, wire(10, 5))]);
    const res = await (await completionsInvoker(t.fn))(ctxFor(seat({ slug: "over", allowed_tools: ["mcp__coltrane__output_query"] }), { max_context_tokens: 1000 } as Partial<AgentInvocationContext>));
    expect(res["ok"], "a context_limit stop was not surfaced as a typed refusal").toBe(false);
    expect(res["refusal"], "the stop was not typed context_limit").toBe("context_limit");
    expect(String(res["message"] ?? ""), "the refusal does not name the ceiling reached").toContain("1000");
    expect(String(res["message"] ?? ""), "the refusal does not name the context tokens reached").toContain("5000");
    expect(res["value"], "a partial answer was sealed as complete after the context ceiling").toBeUndefined();
  });
});

// ── O2/O3/O4 through a DOOR — runGig with the completions invoker over a fake endpoint ─────────────
describe("O2/O3/O4 (door) — a seat whose declared ceiling is crossed fails the gig, sealing nothing", () => {
  it("runGig routes the agent's ceiling to the completions invoker; the crossed turn fails the gig with context_limit", async () => {
    const t = fakeCompletions([toolTurn("mcp__coltrane__output_query", "a", wire(5000, 10)), jsonTurn(SEAL, wire(10, 5))]);
    const invoke = await completionsInvoker(t.fn);
    const agent = seat({ slug: "door-seat", max_context_tokens: 1000, allowed_tools: ["mcp__coltrane__output_query"] });
    const deps = runDeps(invoke);
    let threw: unknown = null;
    let res: Awaited<ReturnType<typeof runGig>> | undefined;
    try { res = await runGig(oneChair(agent), {}, deps); } catch (e) { threw = e; }
    expect(threw, "the gig sealed a partial answer instead of failing on the context ceiling").not.toBeNull();
    expect(String(threw instanceof Error ? threw.message : threw), "the chair failure did not carry the typed context_limit reason").toMatch(/context_limit/);
    expect(res, "the gig completed instead of failing the chair").toBeUndefined();
  });
});

// ── F1 — a non-positive-integer ceiling is refused, at load and at the dispatch door ──────────────
const badCeilingGenome = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ctx-genome-"));
  const core = join(root, "core_types");
  mkdirSync(core, { recursive: true });
  for (const [slug, primitive] of [["Signal", "SENSE"], ["Interpretation", "INTERPRET"], ["Judgment", "JUDGE"], ["Plan", "PLAN"], ["Artifact", "CREATE"], ["Verdict", "VERIFY"]] as const)
    writeFileSync(join(core, slug.toLowerCase() + ".json"), JSON.stringify({ slug, primitive, description: "", schema: { type: "object", properties: {}, required: [] } }));
  const agents = join(root, "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "bad.json"), JSON.stringify({ ...TEST_BEHAVIOR, slug: "bad-ceiling-seat", primitives: ["SENSE"], input_types: [], output_types: [], max_context_tokens: -5 }));
  return root;
};

describe("F1 — a non-positive-integer ceiling is refused before anything runs", () => {
  it("the genome load reports a load error naming the agent and the field", () => {
    const root = badCeilingGenome();
    try {
      let msg = "";
      try { const g = loadGenome(root); msg = JSON.stringify((g as { load_errors?: unknown }).load_errors ?? []); }
      catch (e) { msg = e instanceof Error ? e.message : String(e); }
      expect(msg, "a negative ceiling must be refused at load; today the field is unknown and silently stripped").toMatch(/max_context_tokens/i);
      expect(msg, "the load error must name the agent").toMatch(/bad-ceiling-seat/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gig_dispatch refuses a non-positive-integer ceiling, naming the field and the value, and invokes nothing", async () => {
    let invoked = false;
    const invoke: AgentInvoker = () => { invoked = true; return { ...SEAL }; };
    const r = await dispatchTool("gig_dispatch", { standard_slug: "ctx-demo", input: {}, max_context_tokens: -5, wait: true }, doorDeps(seat({ slug: "s" }), invoke));
    expect(r.ok, "a non-positive-integer ceiling must not quietly run").toBe(false);
    expect(String(r.error), "the refusal must name the field").toMatch(/max_context_tokens/i);
    expect(String(r.error), "the refusal must name the offending value").toContain("-5");
    expect(invoked, "a refused dispatch runs no chair").toBe(false);
  });
});
