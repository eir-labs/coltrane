// RED — a seat's time is time the seat ran, never time the machine slept.
//
// contract-seat-time-monotonic-v1. Since the seat-metrics build (0685280), src/runtime.ts measures
// every chair_complete.duration_ms and first_write_ms as `Date.now() - t0` (runtime.ts:2115/2135 for a
// human seat; 2963/3275/3825 for an agent seat). Date.now() is the WALL clock: a chair that runs across
// a lid-close sleep or an NTP step reports the sleep as seat time. Seat time is how the operator reads
// where a build's minutes go, so a sleep-inflated first_write_ms reads as a seat that thought for an hour.
// performance.now() is monotonic (uv_hrtime: mach_absolute_time on macOS, CLOCK_MONOTONIC on Linux) and
// does not advance across system sleep.
//
// These laws are RED because the enforcement does not exist yet: the callsites still difference Date.now().
// The wall-clock jump is simulated by spying on Date.now ONLY (never fake timers, which also replace
// performance.now — the very clock the fix must switch to). A monotonic implementation makes them green
// without counting the jump, and still counts the real elapsed time.
import { describe, it, expect, vi } from "vitest";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  runGig,
  type Standard,
  type AgentInvoker,
  type GigProgressEvent,
} from "../src";

// ── an agent seat that produces one note ─────────────────────────────────────────────
const seat = testAgent({ slug: "writer", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" });
const agentStandard = {
  slug: "seat-time-agent", domain: "demo", agents: [seat],
  phases: [{ name: "p", chairs: [{ role: "w", agent_slug: "writer", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
} as unknown as Standard;

async function runAgentChair(invoke: AgentInvoker) {
  const registry = createRegistry();
  registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
  const events: GigProgressEvent[] = [];
  await runGig(agentStandard, {}, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, onProgress: (e: GigProgressEvent) => events.push(e) } as never);
  return events.find((e) => e.type === "chair_complete") as (GigProgressEvent & Record<string, unknown>) | undefined;
}

// The assistant-usage event shape the runtime reads (raw.message.usage), matching spec_seat_metrics.
const usage = (input: number, cache_read: number) => ({ type: "assistant", raw: { type: "assistant", message: { usage: { input_tokens: input, cache_read_input_tokens: cache_read, cache_creation_input_tokens: 0, output_tokens: 5 } } } });

// ── a single ENTRY human seat (no agent, no upstream) ────────────────────────────────
const humanStandard = {
  slug: "seat-time-human", domain: "demo", agents: [],
  phases: [{ name: "approve", chairs: [{ role: "approve", human: true, agent_slug: "", depends_on: [], input_contract: [], output_contract: ["Judgment"], optional_outputs: [], required_skills: [] }] }],
} as unknown as Standard;

const APPROVAL = {
  id: "approval-1", input_refs: [] as string[],
  criteria: ["a seat's time is time the seat ran, never time the machine slept"],
  verdicts: [{ criterion: "a seat's time is time the seat ran, never time the machine slept", verdict: "approved" }],
  reasoning_chain: ["approved to seal the human seat so its chair_complete carries a duration_ms"],
};

async function runHumanChair() {
  const registry = createRegistry();
  const events: GigProgressEvent[] = [];
  await runGig(humanStandard, {}, {
    outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    invoke: (async () => ({})) as unknown as AgentInvoker,
    approvals: { approve: APPROVAL }, approved_by: "eugene",
    onProgress: (e: GigProgressEvent) => events.push(e),
  } as never);
  return events.find((e) => e.type === "chair_complete" && (e as Record<string, unknown>)["role"] === "approve") as (GigProgressEvent & Record<string, unknown>) | undefined;
}

describe("contract-seat-time-monotonic-v1 — chair timings are measured on a monotonic clock", () => {
  it("I1 — a wall-clock jump between chair start and the first write inflates neither first_write_ms nor duration_ms", async () => {
    // Date.now spied to a controllable clock; the stub advances it by 3,600,000 ms (an hour of system
    // sleep) between chair start and its first Write. A monotonic measure ignores the jump; today's
    // Date.now difference bakes the whole hour into both numbers.
    const base = Date.now();
    let fakeNow = base;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    let done: (GigProgressEvent & Record<string, unknown>) | undefined;
    try {
      done = await runAgentChair(async (ctx) => {
        ctx.onEvent?.(usage(1_000, 26_000));
        fakeNow += 3_600_000; // lid close / NTP step: the wall clock jumps an hour mid-chair
        ctx.onEvent?.({ type: "tool_use", tool: "Write" });
        return { ...coreInvariantFields("Signal"), value: "written" };
      });
    } finally {
      spy.mockRestore();
    }
    expect(done, "no chair_complete was emitted").toBeDefined();
    expect(done!["first_write_ms"] as number, "first_write_ms counted an hour of system sleep as seat time — it is a Date.now() difference, not a monotonic (performance.now) one").toBeLessThan(60_000);
    expect(done!["duration_ms"] as number, "duration_ms counted an hour of system sleep as seat time — it is a Date.now() difference, not a monotonic (performance.now) one").toBeLessThan(60_000);
    // O1 — performance.now() is fractional; the seal must round both to whole milliseconds.
    expect(Number.isInteger(done!["first_write_ms"]), "first_write_ms must be whole milliseconds").toBe(true);
    expect(Number.isInteger(done!["duration_ms"]), "duration_ms must be whole milliseconds").toBe(true);
  });

  it("I2 — real elapsed time is still counted when the wall clock does not move", async () => {
    // Date.now frozen (the wall clock never advances); the stub does 50 ms of REAL work before its first
    // Write. A monotonic measure keeps the 50 ms; today's frozen Date.now difference erases it to 0.
    const base = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => base);
    let done: (GigProgressEvent & Record<string, unknown>) | undefined;
    try {
      done = await runAgentChair(async (ctx) => {
        ctx.onEvent?.(usage(1_000, 26_000));
        await new Promise((r) => setTimeout(r, 50)); // 50 ms of real seat time
        ctx.onEvent?.({ type: "tool_use", tool: "Write" });
        return { ...coreInvariantFields("Signal"), value: "written" };
      });
    } finally {
      spy.mockRestore();
    }
    expect(done, "no chair_complete was emitted").toBeDefined();
    expect(done!["first_write_ms"] as number, "50 ms of real seat work read as 0 — first_write_ms is a Date.now() difference and the frozen wall clock erased the elapsed time a monotonic clock would have kept").toBeGreaterThanOrEqual(40);
    expect(done!["duration_ms"] as number, "duration_ms must be at least first_write_ms").toBeGreaterThanOrEqual(done!["first_write_ms"] as number);
  });

  it("O2 — a human seat's duration_ms excludes a wall-clock jump during the seat", async () => {
    // The human seat path reads Date.now at chair start (t0) and again at chair_complete. Spy so the second
    // read lands an hour after the first (a wall-clock jump during the seat). A monotonic measure reports
    // ~0 ms; today's Date.now difference reports the whole hour.
    const base = Date.now();
    let calls = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      calls += 1;
      // Every read is an hour past the one before, so ANY two Date.now() reads differ by >= 1h, whatever
      // else in runGig reads the clock first: a Date.now()-based duration cannot stay under a minute.
      return base + calls * 3_600_000;
    });
    let done: (GigProgressEvent & Record<string, unknown>) | undefined;
    try {
      done = await runHumanChair();
    } finally {
      spy.mockRestore();
    }
    expect(done, "no chair_complete for the human seat").toBeDefined();
    expect(done!["duration_ms"] as number, "a human seat's duration_ms counted a wall-clock jump as seat time — it is a Date.now() difference, not a monotonic (performance.now) one").toBeLessThan(60_000);
  });

  it("control — with no clock spy, real elapsed is measured and no jump exists to exclude (green today, stays green)", async () => {
    const done = await runAgentChair(async (ctx) => {
      ctx.onEvent?.(usage(1_000, 26_000));
      await new Promise((r) => setTimeout(r, 50));
      ctx.onEvent?.({ type: "tool_use", tool: "Write" });
      return { ...coreInvariantFields("Signal"), value: "written" };
    });
    expect(done, "no chair_complete was emitted").toBeDefined();
    expect(done!["first_write_ms"] as number).toBeGreaterThanOrEqual(40);
    expect(done!["duration_ms"] as number).toBeLessThan(60_000);
  });
});
