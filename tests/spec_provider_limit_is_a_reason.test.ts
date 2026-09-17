// RED — a chair stopped by the provider's usage limit fails WITH that reason.
//
// THE DEFECT. When the Claude CLI hits the account's usage limit it does not write to stderr. It
// emits the notice as an assistant message (model `<synthetic>`) and exits 1. The invoker builds
// its failure from stderr alone (`claude exited ${code}: ${stderr}` in the default runner), so the
// operator is told `claude exited 1: ` — an empty reason for a failure that has a precise one,
// including when it ends.
//
// MEASURED on 2026-09-16. Build gig 13ea0d99's verify seat failed with
// `verify-change: claude exited 1: `. Its session transcript (47bb5216) ends on the assistant text
// "You've hit your session limit · resets 10:50pm (Asia/Tokyo)". Debate-school gigs on the same
// account were running at the same time. Nothing in the gig's failure said the account was out.
//
// The stream below is modelled on that transcript. The exact fields of the CLI's final `result`
// event on this path were not captured, so the fixture carries the notice in BOTH the synthetic
// assistant message and an error result; a fix that reads either one passes.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, ChildExitError, defineAgent } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";

const NOTICE = "You've hit your session limit · resets 10:50pm (Asia/Tokyo)";

const agent = () =>
  defineAgent({
    slug: "limited-seat",
    primitives: ["VERIFY"],
    input_types: [],
    output_types: ["change-verdict"],
    identity: "a verify seat that never gets to run",
    method: "run the checks and seal the verdict",
    constraints: ["report failures verbatim"],
    behavioral_primitives: ["critic", "executor"],
  });

const ctx = (): AgentInvocationContext =>
  ({ agent: agent(), phase: "verify", gig_id: "gig-limit", inputs: [], gig_input: {}, output_types: ["change-verdict"] }) as AgentInvocationContext;

const limitStream = (): string =>
  [
    JSON.stringify({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: NOTICE }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: true, result: NOTICE }),
  ].join("\n");

async function failureOf(stdout: string, stderr = ""): Promise<string> {
  const invoke = makeClaudeInvoker({
    model: "claude-sonnet-4-6",
    sealVia: "output_write",
    run: () => {
      throw new ChildExitError(`claude exited 1: ${stderr}`, stdout);
    },
  });
  try {
    await invoke(ctx());
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe("a provider usage limit is reported as the reason the chair failed", () => {
  it("LAW 1 — the chair's failure carries the provider's limit notice, including when it resets", async () => {
    const msg = await failureOf(limitStream());
    expect(msg, "the chair did not fail at all").not.toBe("");
    expect(msg, "the failure dropped the provider's notice and reported a bare exit").toContain("session limit");
    expect(msg, "the failure dropped when the limit resets").toContain("resets 10:50pm");
  });

  it("LAW 2 (control) — an ordinary non-zero exit still reports what the child wrote to stderr", async () => {
    // Green today. A fix that replaces stderr with the stream's text must not lose stderr when the
    // stream says nothing.
    const msg = await failureOf("", "spawn failed: permission denied");
    expect(msg).toContain("permission denied");
  });
});
