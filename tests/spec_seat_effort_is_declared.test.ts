// RED — contract-seat-effort-v1. Effort is declared, resolved deterministically, always passed to the
// spawn, and recorded — never inherited from ~/.claude/settings.json. Spec + architecture:
// docs/specs/seat-effort.red-spec.md. Measured: seat ff0a0ebf ran "effort":"xhigh" on all 156 events
// because the Claude invoker never passes `--effort`. Precedence: dispatch ▷ agent ▷ tier default
// (economy low / standard medium / premium high) ▷ medium, resolved onto ctx.effort. Every law fails
// today because none of that exists yet — RED by design.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runGig, createRegistry, createOutputStore, MemoryLedger, loadGenome,
  type AgentInvoker, type AgentInvocationContext, type DomainType, type Agent, type Standard,
} from "../src/index.js";
import { buildInvokerArgs, makeClaudeInvoker } from "../src/claude_invoker.js";
import { makeCompletionsInvoker } from "../src/completions_invoker.js";
import { defineAgent } from "../src/composition.js";
import { AgentSchema } from "../src/genome_schema.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { runCli, type CliIO } from "../src/cli.js";
import { MCP_TOOLS } from "../src/mcp.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";

// eff-note is Signal-cored, so a seal carries { source } beside its payload.
const effNote: DomainType = { slug: "eff-note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const SEAL = { t: "hi", source: "fixture://demo/eff" };

// Full Agent literal (bypasses defineAgent stripping, so a declared `effort` survives for the resolver).
const seat = (over: Record<string, unknown>): Agent =>
  ({ ...TEST_BEHAVIOR, slug: "seat", primitives: ["SENSE"], input_types: [], output_types: ["eff-note"], domain: "demo", ...over }) as unknown as Agent;
const oneChair = (agent: Agent): Standard =>
  ({ slug: "eff-demo", domain: "demo", agents: [agent],
     phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: agent.slug, depends_on: [], input_contract: [], output_contract: ["eff-note"], required_skills: [] }] }] }) as unknown as Standard;
const runDeps = (invoke: AgentInvoker, extra: Record<string, unknown> = {}) => {
  const registry = createRegistry();
  registry.registerType(effNote);
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, ...extra } as unknown as Parameters<typeof runGig>[2];
};
const doorDeps = (agent: Agent, invoke: AgentInvoker): ServerDeps => {
  const registry = createRegistry();
  registry.registerType(effNote);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
           standards: new Map([["eff-demo", oneChair(agent)]]), invoke, gig_runs: new Map() } as unknown as ServerDeps;
};
// Every value that follows an `--effort` flag (so "exactly one pair" is checkable).
const effortFlags = (args: readonly string[]): string[] => args.flatMap((a, i) => (a === "--effort" ? [String(args[i + 1])] : []));
const effortOf = (args: readonly string[]): string | undefined => effortFlags(args)[0];

// ── O1 — the genome + the doors accept effort ────────────────────────────────────────────────────
describe("O1 — effort is authorable and dispatchable", () => {
  it("O1/F1 — AgentSchema keeps a valid effort and refuses an unlisted level, naming agent + field", () => {
    const parsed = defineAgent({ ...TEST_BEHAVIOR, slug: "kept", primitives: ["SENSE"] } as never);
    const withEffort = defineAgent({ ...TEST_BEHAVIOR, slug: "kept", primitives: ["SENSE"], effort: "high" } as never);
    expect((parsed as unknown as Record<string, unknown>)["effort"], "no declaration ⇒ no effort").toBeUndefined();
    expect((withEffort as unknown as Record<string, unknown>)["effort"], "a declared in-range effort must survive the parse; today it is stripped").toBe("high");
    expect(() => defineAgent({ ...TEST_BEHAVIOR, slug: "bad-seat", primitives: ["SENSE"], effort: "turbo" } as never),
      "an out-of-range effort must be refused at load, not loaded with a guess").toThrow(/effort/i);
    expect(() => defineAgent({ ...TEST_BEHAVIOR, slug: "bad-seat", primitives: ["SENSE"], effort: "turbo" } as never)).toThrow(/bad-seat/);
    expect(AgentSchema.safeParse({ ...TEST_BEHAVIOR, slug: "bad-seat", primitives: ["SENSE"], constraints: [], effort: "turbo" }).success,
      "the schema must reject an unlisted effort; today it strips and passes").toBe(false);
  });

  it("O1 — gig_dispatch advertises `effort` in its MCP input schema", () => {
    const tool = MCP_TOOLS.find((t) => t.slug === "gig_dispatch");
    expect(tool, "gig_dispatch is not advertised").toBeDefined();
    const props = (tool!.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props["effort"], "a control the handler reads must be discoverable (#234)").toBeDefined();
  });

  it("O1 — `coltrane dispatch <std> --effort high` reaches the invocation as ctx.effort", async () => {
    let seen: unknown = "unset";
    const invoke: AgentInvoker = (c) => { seen = (c as unknown as Record<string, unknown>)["effort"]; return { ...SEAL }; };
    const io = { out: () => {}, err: () => {}, deps: doorDeps(seat({ slug: "std-seat" }), invoke) } as unknown as CliIO;
    const code = await runCli(["dispatch", "eff-demo", "--effort", "high", "--wait"], io);
    expect(code, "dispatch failed").toBe(0);
    expect(seen, "the CLI drops --effort and no resolver sets ctx.effort").toBe("high");
  });
});

// ── I1/O2 — deterministic precedence, resolved onto the invocation context ────────────────────────
describe("I1/O2 — effort resolves dispatch ▷ agent ▷ tier ▷ medium, onto ctx.effort", () => {
  const resolvedFor = async (agent: Agent, dispatchEffort?: string): Promise<unknown> => {
    let seen: unknown = "unset";
    const invoke: AgentInvoker = (c) => { seen = (c as unknown as Record<string, unknown>)["effort"]; return { ...SEAL }; };
    await runGig(oneChair(agent), {}, runDeps(invoke, dispatchEffort ? { effort: dispatchEffort } : {}));
    return seen;
  };
  it("holds for every combination in the checkable", async () => {
    expect(await resolvedFor(seat({ slug: "p1", model_tier: "premium" })), "premium ⇒ tier default high").toBe("high");
    expect(await resolvedFor(seat({ slug: "p2", model_tier: "premium", effort: "xhigh" })), "declared beats tier").toBe("xhigh");
    expect(await resolvedFor(seat({ slug: "p3", model_tier: "premium", effort: "xhigh" }), "low"), "dispatch beats declared").toBe("low");
    expect(await resolvedFor(seat({ slug: "u1" })), "untiered ⇒ medium, never the operator's settings").toBe("medium");
  });
});

// ── O3/I2 — the Claude invoker ALWAYS passes exactly one --effort ─────────────────────────────────
describe("O3/I2 — the spawn always carries exactly one --effort", () => {
  it("I2 — buildInvokerArgs emits exactly one --effort pair alongside --max-turns", () => {
    const args = buildInvokerArgs("p", "/tmp/c.json", { effort: "high", max_tool_calls: 8 } as unknown as Parameters<typeof buildInvokerArgs>[2]);
    expect(effortFlags(args), "must carry the resolved effort as one --effort pair; today the opt is ignored").toEqual(["high"]);
  });

  it("O3 — an undeclared, untiered seat STILL spawns with an explicit --effort", async () => {
    let sawArgs: string[] = [];
    const invoke = makeClaudeInvoker({ run: (_b, a) => { sawArgs = a; return JSON.stringify(SEAL); } });
    await invoke({ agent: seat({ slug: "bare" }), phase: "sense", inputs: [], gig_input: {}, output_types: ["eff-note"] } as unknown as AgentInvocationContext);
    expect(effortFlags(sawArgs), "a bare seat must still get an explicit --effort, else it runs at the settings-file effort").toEqual(["medium"]);
  });

  it("I2 — with a skim depth AND a turn budget the spawn still carries exactly one --effort", async () => {
    let sawArgs: string[] = [];
    const invoke = makeClaudeInvoker({ run: (_b, a) => { sawArgs = a; return JSON.stringify(SEAL); } });
    await invoke({ agent: seat({ slug: "busy", max_tool_calls: 40 }), phase: "sense", inputs: [], gig_input: {}, output_types: ["eff-note"],
      depth: "skim", turn_budget: 12, effort: "high" } as unknown as AgentInvocationContext);
    expect(effortFlags(sawArgs), "depth/turn-budget must not multiply or erase the single --effort").toEqual(["high"]);
  });

  it("O3 (door) — a premium seat dispatched through gig_dispatch reaches the spawn with --effort high", async () => {
    let sawArgs: string[] = [];
    const invoke = makeClaudeInvoker({ run: (_b, a) => { sawArgs = a; return JSON.stringify(SEAL); } });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "eff-demo", input: {}, wait: true }, doorDeps(seat({ slug: "prem", model_tier: "premium" }), invoke));
    expect(r.ok, r.error).toBe(true);
    expect(effortOf(sawArgs), "gig_dispatch → runGig → the real Claude invoker must land premium⇒high on the spawn").toBe("high");
  });
});

// ── O4 — the completions invoker carries the resolved effort to the port ──────────────────────────
const hoisted = vi.hoisted(() => ({ turnOpts: undefined as Record<string, unknown> | undefined }));
vi.mock("../src/turn_loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/turn_loop.js")>();
  return {
    ...actual,
    // Capture the model request handed the port (runTurn's options), then answer "done".
    runTurn: async (_seed: unknown, opts: Record<string, unknown>) => {
      hoisted.turnOpts = opts;
      return { stop: "done", messages: [], text: JSON.stringify(SEAL), rounds: [],
               totals: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, rounds: 0 } };
    },
  };
});

describe("O4 — the chat-completions invoker carries the resolved effort on the model request", () => {
  it("hands runTurn the effort (the provider wire mapping is a lower layer, out of scope)", async () => {
    hoisted.turnOpts = undefined;
    const invoke = makeCompletionsInvoker({ baseUrl: "https://c.test/v1", apiKey: "k", tierMap: { premium: "m-pro" } });
    const ctx = { agent: seat({ slug: "cheap", model_tier: "premium" }), phase: "sense", inputs: [], gig_input: {},
                  output_types: ["eff-note"], effort: "high" } as unknown as AgentInvocationContext;
    await invoke(ctx);
    expect(hoisted.turnOpts, "the invoker never reached runTurn").toBeDefined();
    expect(hoisted.turnOpts!["effort"], "the resolved effort was never carried onto the model request").toBe("high");
  });
});

// ── O5 — chair_complete records the effort the seat ran at ────────────────────────────────────────
describe("O5 — chair_complete records the effort the seat ran at", () => {
  it("the resolved effort appears on the chair_complete progress event", async () => {
    let complete: Record<string, unknown> | undefined;
    const invoke: AgentInvoker = () => ({ ...SEAL });
    await runGig(oneChair(seat({ slug: "prem", model_tier: "premium" })), {}, runDeps(invoke, {
      onProgress: (ev: unknown) => { if ((ev as { type?: string }).type === "chair_complete") complete = ev as Record<string, unknown>; },
    }));
    expect(complete, "no chair_complete emitted").toBeDefined();
    expect(complete!["effort"], "chair_complete must record the effort the seat ran at (premium⇒high)").toBe("high");
  });
});

// ── F2 — an out-of-range effort at the dispatch door is refused before anything runs ──────────────
describe("F2 — gig_dispatch refuses an out-of-range effort before anything runs", () => {
  it("names the field and value, and invokes nothing", async () => {
    let invoked = false;
    const invoke: AgentInvoker = () => { invoked = true; return { ...SEAL }; };
    const r = await dispatchTool("gig_dispatch", { standard_slug: "eff-demo", input: {}, effort: "turbo", wait: true }, doorDeps(seat({ slug: "s" }), invoke));
    expect(r.ok, "an unknown effort must not quietly run").toBe(false);
    expect(String(r.error), "the refusal must name the field").toMatch(/effort/i);
    expect(invoked, "a refused dispatch runs no chair").toBe(false);
  });
});

// ── F1 — a genome agent file declaring an out-of-range effort fails the load ──────────────────────
const badEffortGenome = (): string => {
  const root = mkdtempSync(join(tmpdir(), "eff-genome-"));
  const core = join(root, "core_types");
  mkdirSync(core, { recursive: true });
  for (const [slug, primitive] of [["Signal", "SENSE"], ["Interpretation", "INTERPRET"], ["Judgment", "JUDGE"], ["Plan", "PLAN"], ["Artifact", "CREATE"], ["Verdict", "VERIFY"]] as const)
    writeFileSync(join(core, slug.toLowerCase() + ".json"), JSON.stringify({ slug, primitive, description: "", schema: { type: "object", properties: {}, required: [] } }));
  const agents = join(root, "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "bad.json"), JSON.stringify({ ...TEST_BEHAVIOR, slug: "bad-effort-seat", primitives: ["SENSE"], input_types: [], output_types: [], effort: "turbo" }));
  return root;
};

describe("F1 — the genome load refuses an out-of-range effort, naming the agent and the field", () => {
  it("reports a load error (never loads the agent with a guessed effort)", () => {
    const root = badEffortGenome();
    try {
      // Hard-throw or soft load_error — either way the message must name the field and the agent.
      let msg = "";
      try { const g = loadGenome(root); msg = JSON.stringify((g as { load_errors?: unknown }).load_errors ?? []); }
      catch (e) { msg = e instanceof Error ? e.message : String(e); }
      expect(msg, "an out-of-range effort must be refused at load; today the load names no such error").toMatch(/effort/i);
      expect(msg, "the load error must name the agent").toMatch(/bad-effort-seat/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
