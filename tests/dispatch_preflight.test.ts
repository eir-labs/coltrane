// Preflight seal-drill gate for gig_dispatch (dispatch-preflight-seal-drill-v0).
//
// Drives dispatchTool("gig_dispatch", …) directly (same pattern as
// tests/honest_broker/gig_dispatch.test.ts) with a call-counting AgentInvoker spy.
//
// Failing case  — dispatch of an unsealable standard must return { ok:false } and
//                 invoke ZERO chairs. This is RED against current code (the chair runs
//                 before any drill is performed).
// Clean case    — a standard that drills clean must still dispatch and invoke ≥1 chair.

import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  bootstrapServerDeps,
  dispatchTool,
  type ServerDeps,
} from "../src/server.js";
import type { AgentInvoker } from "../src/runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

let invokeCalls = 0;

const invoke: AgentInvoker = (ctx) => {
  invokeCalls++;
  const slug = ctx.agent.slug;
  // raw-note (Signal) requires text + source; summary (Interpretation) requires gist + claims.
  if (slug === "sensor") return { text: "note", source: "test-source" };
  if (slug === "summarizer") return { gist: "summary", claims: ["test-claim"] };
  return {};
};

function makeDeps(): ServerDeps {
  return { ...bootstrapServerDeps(REPO_ROOT), invoke, model_version: "preflight-test-v1" };
}

beforeEach(() => {
  invokeCalls = 0;
});

describe("dispatch_preflight: seal-drill gate in gig_dispatch", () => {
  it("FAILING CASE — unsealable standard is refused before any chair runs", async () => {
    const deps = makeDeps();

    // Clone the loaded 'summarize' standard and make one chair's output_contract unsatisfiable.
    const good = deps.standards!.get("summarize")!;
    expect(good, "summarize standard must exist in the genome").toBeTruthy();

    const bad = JSON.parse(JSON.stringify(good)) as typeof good;
    bad.slug = "summarize-unsealable";
    // Overwrite the second phase's first chair output_contract with a type that cannot exist.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    bad.phases[1]!.chairs[0]!.output_contract = ["no-such-type-xyz"];
    deps.standards!.set("summarize-unsealable", bad);

    const r = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "summarize-unsealable", input: { topic: "noise" }, wait: true },
      deps,
    );

    // (a) result must be a failure naming the unsatisfiable type
    expect(r.ok).toBe(false);
    expect((r as { error?: string }).error).toMatch(/no-such-type-xyz/);

    // (b) the invoker spy must not have been called — dispatch refused before any chair ran.
    // THIS IS THE RED ANCHOR: current code dispatches to runGig, so the sensor chair runs
    // and invokeCalls is >= 1. The gate added by this change makes it 0.
    expect(invokeCalls).toBe(0);
  });

  it("CLEAN CASE — standard that drills clean still dispatches and invokes chairs", async () => {
    const deps = makeDeps();

    const r2 = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "summarize", input: { topic: "noise" }, wait: true },
      deps,
    );

    // Not refused for a drill reason — the clean standard dispatches and runs.
    expect(r2.ok).not.toBe(false);
    // At least one chair was invoked.
    expect(invokeCalls).toBeGreaterThanOrEqual(1);
  });
});
