// RED — contract-seat-memory-v1 (operator direction 2026-09-17). A seat's writes are its grants; the
// operator's auto-memory is not a seat's to write. Measured: a `claude -p` seat spawned as the Claude
// invoker spawns chairs (`--setting-sources user`) wrote ~/.claude/projects/<repo>/memory/, loaded by
// every later session in the repo. Neither `--settings '{"autoMemoryEnabled":false}'` nor
// CLAUDE_CODE_DISABLE_AUTO_MEMORY is passed today. Spec: docs/specs/seat-memory.red-spec.md.
//   O1  every Claude chair spawn passes exactly one `--settings` whose JSON sets autoMemoryEnabled false;
//   I1  it holds on every spawn kind — first run, reserve continuation, resumed amend, cold fallback.
// Every law FAILS today on the missing --settings, never on a collection/import error — RED by design.
// Controls stay GREEN (a NEW, disjoint flag): spec_seat_effort_is_declared, spec_chair_session_continuity, invoker_cage.
import { describe, it, expect } from "vitest";
import { buildInvokerArgs, makeClaudeInvoker, ChildExitError } from "../src/claude_invoker.js";
import { testAgent } from "./_support/agents.js";
import {
  runGig, createRegistry, createOutputStore, MemoryLedger,
  type DomainType, type Standard, type AgentInvocationContext,
} from "../src";

// The auto-memory verdict for one spawn's arg list: how many `--settings` it carries, and — when
// exactly one — the autoMemoryEnabled its JSON declares. Defensive so a missing flag reads as an
// ASSERTION about the contract (count 0), never a raw JSON.parse throw (which would fail wrongly).
const autoMemory = (args: readonly string[] | undefined): { count: number; enabled: unknown } => {
  const a = args ?? [];
  const vals = a.flatMap((t, i) => (t === "--settings" ? [String(a[i + 1])] : []));
  if (vals.length !== 1) return { count: vals.length, enabled: undefined };
  try { return { count: 1, enabled: (JSON.parse(vals[0]!) as Record<string, unknown>)["autoMemoryEnabled"] }; }
  catch { return { count: 1, enabled: "unparseable" }; }
};
const expectMemoryOff = (args: readonly string[] | undefined, where: string): void => {
  const m = autoMemory(args);
  expect(m.count, `${where}: the spawn must pass EXACTLY ONE --settings — the operator's auto-memory is not a seat's to write`).toBe(1);
  expect(m.enabled, `${where}: that --settings JSON must set autoMemoryEnabled to false, or the seat keeps the memory tool and writes ~/.claude/projects/<repo>/memory/`).toBe(false);
};

// ── O1 + I1(first run, resumed amend): the arg builder every spawn kind goes through ──
describe("O1 — every Claude chair spawn carries the auto-memory-off setting", () => {
  it("O1 — a first-run spawn passes exactly one --settings whose JSON sets autoMemoryEnabled false", () => {
    expectMemoryOff(buildInvokerArgs("p", "/tmp/c.json", { effort: "medium" }), "first-run spawn");
  });

  it("I1 — a resumed amend spawn (session_id + resume) still carries the single autoMemory-off setting", () => {
    // The exact opts the runtime hands buildInvokerArgs on an amend round (ctx.resume === true).
    const amend = buildInvokerArgs("p", "/tmp/c.json", { session_id: "11111111-1111-4111-8111-111111111111", resume: true, effort: "medium" });
    expectMemoryOff(amend, "resumed amend spawn");
  });
});

// ── I1(reserve continuation, cold fallback): scripted stream-json through the injected run seam ──
const owWrite = (id: string): string => JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { domain_type: "lineage-hit", data: { source: "s" } } }] },
});
const budgetStop = (...w: string[]): string => [...w, JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true })].join("\n");
const clean = (...w: string[]): string => [...w, JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" })].join("\n");
const sessionLost = (): string => JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "No conversation found with session ID" });
const scripted = (replies: Array<{ stdout: string; exit1: boolean }>) => {
  const calls: string[][] = [];
  const run = (_b: string, args: string[]): string => {
    const r = replies[Math.min(calls.length, replies.length - 1)]!;
    calls.push(args);
    if (r.exit1) throw new ChildExitError("claude exited 1: ", r.stdout);
    return r.stdout;
  };
  return { calls, run };
};
const sweepCtx = (): AgentInvocationContext =>
  ({ agent: testAgent({ slug: "budget-scout", primitives: ["SENSE"], input_types: [], output_types: ["lineage-hit"] }),
     phase: "identify", role: "sweep", gig_id: "gig-mem", inputs: [], gig_input: {}, output_types: ["lineage-hit"] }) as AgentInvocationContext;

describe("I1 — it holds on every spawn kind a chair makes", () => {
  it("I1 — the turn-budget reserve continuation carries the single autoMemory-off setting", async () => {
    // round one hits its budget (exit1), then the reserve continuation closes out.
    const s = scripted([
      { stdout: budgetStop(owWrite("w1")), exit1: true },
      { stdout: clean(owWrite("w2")), exit1: false },
    ]);
    await makeClaudeInvoker({ model: "claude-sonnet-4-6", sealVia: "output_write", turn_reserve: 5, run: s.run })(sweepCtx());
    expect(s.calls.length, "the reserve continuation never spawned").toBe(2);
    expectMemoryOff(s.calls[1], "reserve continuation spawn");
  });

  it("I1 — the cold fallback for a lost session carries the single autoMemory-off setting", async () => {
    // budget stop, then the reserve RESUME finds no such session, then the cold fallback re-spawns fresh.
    const s = scripted([
      { stdout: budgetStop(owWrite("w1")), exit1: true },
      { stdout: sessionLost(), exit1: true },
      { stdout: clean(owWrite("w3")), exit1: false },
    ]);
    await makeClaudeInvoker({ model: "claude-sonnet-4-6", sealVia: "output_write", turn_reserve: 5, run: s.run })(sweepCtx());
    expect(s.calls.length, "the cold fallback never spawned").toBe(3);
    expectMemoryOff(s.calls[2], "cold fallback spawn");
  });
});

// ── I1: at least one law observes a spawn built through the real runGig path ──
const memNote: DomainType = { slug: "mem-note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const SEAL = { t: "ok", source: "fixture://mem" };
const oneChair: Standard =
  ({ slug: "mem-demo", domain: "demo", agents: [testAgent({ slug: "mem-seat", primitives: ["SENSE"], input_types: [], output_types: ["mem-note"], domain: "demo" })],
     phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: "mem-seat", depends_on: [], input_contract: [], output_contract: ["mem-note"], required_skills: [] }] }] }) as unknown as Standard;
const runDeps = (invoke: unknown) => {
  const r = createRegistry();
  r.registerType(memNote);
  return { outputs: createOutputStore(r), ledger: new MemoryLedger(), invoke } as unknown as Parameters<typeof runGig>[2];
};

describe("I1 — a spawn built through runGig carries the auto-memory-off setting", () => {
  it("I1 — makeClaudeInvoker driven by runGig lands exactly one autoMemory-off --settings on the spawn", async () => {
    let sawArgs: string[] = [];
    const invoke = makeClaudeInvoker({ run: (_b, a) => { sawArgs = a; return JSON.stringify(SEAL); } });
    await runGig(oneChair, {}, runDeps(invoke));
    expectMemoryOff(sawArgs, "runGig spawn");
  });
});
