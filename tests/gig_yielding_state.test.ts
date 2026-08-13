// RED-first — Item 3, WIRE `yielding`: BudgetState.agent_state declares the member "yielding" with
// its own comment ("below cost-of-next-append, paused (used when partial)"), and grep of the whole
// tree finds it in exactly two places — that comment (runtime.ts:402) and the type union
// (runtime.ts:413). Nothing sets it, nothing reads it, no gig has ever been told it is yielding. It
// is a declared rule with no enforcement — the exact defect class lineage-record 03cacf6a names.
//
// THE DECISION THIS SPEC FIXES (D1): a chair-in-reserve and a gig-that-is-yielding are ONE condition
// seen at two scales, not two concepts. A gig is `yielding` IFF at least one seated chair is
// currently drawing its reserve. It enters yielding the moment a seated chair crosses from its
// budget into a granted reserve draw (budget_reserve_granted fires), clears back to `active` when
// that chair lands within its reserve, and moves to `depleted` when the chair spends its reserve
// (and the pool) without landing. This is the gig-scale projection of Item 2's chair-scale draw —
// the reactive observed state (Kubernetes' memory-limit shape), never an in-band gate.
//
// Covers contract INV14, INV15, INV16, INV17 and F8, plus the written D1 decision made executable
// as the INV15 biconditional. RED because agent_state only ever reaches active/depleted/settled in
// code today; the draw event is forwarded as an opaque agent_event and never moves the state.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  partialBudgetState,
  type AgentInvoker,
  type AgentStreamEvent,
  type DomainType,
  type Agent,
  type Standard,
  type GigProgressEvent,
} from "../src";
import { TEST_BEHAVIOR } from "./_support/agents.js";

const hit: DomainType = {
  slug: "lineage-hit", extends: "Signal", domain: "eirtests",
  schema: { properties: { source: { type: "string" } } }, required_fields: ["source"],
};
const scout: Agent = {
  ...TEST_BEHAVIOR, slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["lineage-hit"],
  domain: "eirtests",
};

/** Any progress event that carries a budget agent_state — the operator-facing read of the state. */
const stateOf = (ev: GigProgressEvent): string | undefined => {
  const e = ev as unknown as Record<string, unknown>;
  if (typeof e["agent_state"] === "string") return e["agent_state"] as string;
  const raw = (e["event"] as Record<string, unknown> | undefined)?.["raw"] as Record<string, unknown> | undefined;
  return typeof raw?.["agent_state"] === "string" ? (raw["agent_state"] as string) : undefined;
};

/**
 * Run a gig whose single chair hits its budget and draws a reserve (`draws: true`), OR draws and
 * then fails to land (`land: false` → a second budget stop inside the reserve). Captures every
 * progress event so a test can read what state the operator would have observed, in order.
 */
const runYieldingGig = async (opts: { draws: boolean; land: boolean }): Promise<{
  progress: GigProgressEvent[];
  budget_state: Record<string, unknown> | undefined;
  error: unknown;
}> => {
  const progress: GigProgressEvent[] = [];
  const invoke: AgentInvoker = (c) => {
    if (opts.draws) {
      c.onEvent?.({ type: "budget_reserve_granted", raw: { agent: c.agent.slug, role: c.phase, reserve_turns: 5, sealed_before_grant: [] } } as AgentStreamEvent);
    }
    if (!opts.land) {
      // Spent the reserve and the pool without landing — the chair did not close out.
      throw new Error(`chair "${c.agent.slug}" exhausted its reserve without landing`);
    }
    return { source: "https://example.com" };
  };
  const standard = {
    slug: "sweep", domain: "eirtests", agents: [scout],
    phases: [{ name: "sense", chairs: [{
      role: "sense", agent_slug: "scout", depends_on: [], input_contract: [],
      output_contract: ["lineage-hit"], required_skills: [], turn_reserve: 5,
    }] }],
  } as unknown as Standard;
  const registry = createRegistry();
  registry.registerType(hit);
  try {
    const res = await runGig(standard, {}, {
      outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke,
      budget: { opening: 1_000_000, pool: 20 } as unknown as import("../src").BudgetInput,
      onProgress: (ev) => progress.push(ev),
    });
    return { progress, budget_state: res.budget_state as unknown as Record<string, unknown> | undefined, error: undefined };
  } catch (e) {
    return { progress, budget_state: partialBudgetState(e) as unknown as Record<string, unknown> | undefined, error: e };
  }
};

describe("agent_state actually reaches 'yielding' when a seated chair draws reserve, and is READ", () => {
  it("INV14/INV17 — a drawing chair drives an operator-observable 'yielding' state (was 'active' before)", async () => {
    const { progress } = await runYieldingGig({ draws: true, land: true });
    const states = progress.map(stateOf).filter((s): s is string => s !== undefined);
    expect(
      states.includes("yielding"),
      "a chair crossed into its reserve and NOTHING surfaced 'yielding' — the state is still a term " +
        "that appears only in a comment and a type union",
    ).toBe(true);
    // it was active before the draw — yielding is the transition, not the resting state.
    const firstYield = states.indexOf("yielding");
    expect(states.slice(0, firstYield).every((s) => s !== "yielding"), "the gig was 'yielding' before any chair drew").toBe(true);
  });

  it("INV15 (D1) — a gig is 'yielding' IFF a seated chair is currently drawing reserve", async () => {
    const drew = await runYieldingGig({ draws: true, land: true });
    const idle = await runYieldingGig({ draws: false, land: true });
    const drewStates = drew.progress.map(stateOf).filter(Boolean);
    const idleStates = idle.progress.map(stateOf).filter(Boolean);
    // ⇒ a drawing chair makes the gig yielding.
    expect(drewStates.includes("yielding"), "a drawing chair did NOT put the gig in yielding — the biconditional fails one way").toBe(true);
    // ⇐ no draw, no yielding: a gig where no chair reaches for reserve is never yielding.
    expect(idleStates.includes("yielding"), "a gig with NO chair drawing reserve reported yielding anyway — the biconditional fails the other way").toBe(false);
  });

  it("INV16 — yielding clears to 'active' when the drawing chair LANDS within its reserve", async () => {
    const { budget_state } = await runYieldingGig({ draws: true, land: true });
    expect(
      budget_state?.["agent_state"],
      "the chair landed within its reserve but the gig was left stuck in 'yielding' — the exit transition is missing",
    ).not.toBe("yielding");
    // a landed reserve resolves back to a solvent state, not a stuck one.
    expect(["active", "settled"].includes(budget_state?.["agent_state"] as string), "a landed reserve did not clear back to a solvent state").toBe(true);
  });

  it("INV16 — yielding moves to 'depleted' when the chair spends reserve+pool WITHOUT landing", async () => {
    const { budget_state, error } = await runYieldingGig({ draws: true, land: false });
    expect(error, "a chair that spent its reserve without landing should still surface a failure").toBeTruthy();
    expect(
      budget_state?.["agent_state"],
      "a chair drew its reserve, never landed, and the gig did not move to 'depleted' — the depletion exit is missing",
    ).toBe("depleted");
  });
});

// ── F8 — the yielding term must be SET in executable code, not merely declared. This is the direct
// guard against the lineage-record-03cacf6a defect the item names: a union member with no set-site.
// Paired with the behavioural read-site tests above, it makes a green suite impossible unless
// something both sets AND reads yielding.
describe("F8 — 'yielding' is enforced, not just declared", () => {
  it("has a real assignment site for agent_state = 'yielding' in the runtime", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/runtime.ts", import.meta.url)), "utf8");
    // An ASSIGNMENT (not the type union `| "yielding"`, not the doc comment). RED today: zero.
    const setSites = src.match(/agent_state\s*=\s*["']yielding["']/g) ?? [];
    expect(
      setSites.length,
      "nothing in runtime.ts ever SETS agent_state to 'yielding' — it is a declared rule with no " +
        "enforcement, the exact defect class this item was opened to fix",
    ).toBeGreaterThanOrEqual(1);
  });
});
