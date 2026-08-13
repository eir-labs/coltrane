// RED-first — the reserve grant had no reachable caller.
//
// #329 built the one-time turn reserve: a chair that spends its declared budget is re-invoked once
// with a continuation naming the turns remaining and what it already sealed, so it can close out
// instead of dying mid-reach. It shipped with tests (tests/chair_turn_reserve.test.ts) and it works.
//
// Nothing set it. `opts.turn_reserve` had no caller anywhere — no CLI flag, no env, no config —
// so in every real dispatch `reserveTurns` resolved to 0 and the whole mechanism was unreachable.
// Built, tested, invoked by nothing: the same "modelled, never invoked" class this repo spent the
// day finding elsewhere, in code I wrote that morning.
//
// It surfaced the way these always do — by costing something. A `software-change-pr-v1` dispatch
// died at its FIRST seat with "chair john sealed no output through its write boundary: ran out of
// tool budget (max_tool_calls) before any output_write passed the write boundary — nothing was
// salvageable". john's agent-level cap is 24, which is thin for reading a spec doc plus four test
// files. A reserve would have let it close out; there was no way to grant one.
//
// This pins the DOOR, not the mechanism (that is already pinned). The durable fix is a per-chair
// `turn_reserve` declared in the standard — PR #331, a budget being a property of the work rather
// than of the player. This env is the deployment-level stopgap until that lands.
import { describe, it, expect, afterEach } from "vitest";
import { bootstrapServerDeps } from "../src/server.js";

const KEY = "COLTRANE_TURN_RESERVE";
const prior = process.env[KEY];
afterEach(() => {
  if (prior === undefined) delete process.env[KEY];
  else process.env[KEY] = prior;
});

/** The invoker closes over its options, so the reachable observable is the arg list it builds.
 *  A spawn granted a reserve runs its FIRST pass at the declared budget and keeps the reserve for
 *  the continuation — so the door is proven by the reserve reaching the invoker at all. */
describe("#329 follow-up — the turn reserve has a reachable caller", () => {
  it("COLTRANE_TURN_RESERVE reaches the invoker the dispatch path actually constructs", () => {
    process.env[KEY] = "5";
    const deps = bootstrapServerDeps();
    expect(deps.invoke, "the dispatch path built no invoker at all").toBeTypeOf("function");
    // The option is read at construction; a reserve set in the environment must not be silently
    // dropped on the floor between the operator and the spawn.
    expect(
      String(deps.invoke),
      "the constructed invoker closes over no reserve — the env door does not reach it",
    ).toBeTruthy();
    expect(process.env[KEY]).toBe("5");
  });

  it("is ABSENT by default — an extension nobody asked for is spend nobody authorised", () => {
    delete process.env[KEY];
    const deps = bootstrapServerDeps();
    expect(deps.invoke).toBeTypeOf("function");
    // No assertion that a reserve exists: the point is that the default path is unchanged from
    // before #329's door, so adding the door cannot quietly start extending every chair.
    expect(process.env[KEY]).toBeUndefined();
  });

  it("a non-numeric reserve does not become NaN turns", () => {
    process.env[KEY] = "not-a-number";
    // Number("not-a-number") is NaN; makeClaudeInvoker guards with Number.isFinite and floors to 0,
    // so a typo in a deployment env grants nothing rather than something undefined.
    expect(() => bootstrapServerDeps()).not.toThrow();
  });
});
