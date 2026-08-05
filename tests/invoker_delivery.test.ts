// RED-first — the DELIVERY half of the invoker: what text reaches the extractor at all.
//
// Issues under test:
//   #222 finalText returns "" when stdout IS the JSON answer (+ assistant concatenation)
//   #223 stream-json error results (is_error / error_max_turns) are never detected
//   #224 spawnStreaming never flushes its trailing partial line
//   #225 document_factory's execFileSync has no timeout
//
// WHY A REAL SPAWN: finalText and spawnStreaming are module-private with ZERO coverage.
// Every existing invoker test injects `opts.run`, which short-circuits at
// claude_invoker.ts:319 BEFORE the streaming path at :324-325 — so injection cannot reach
// these bugs. See tests/_support/fake_claude.ts for the harness and its provenance notes.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { makeClaudeInvoker } from "../src/claude_invoker.js";
import { makeClaudeInferer, type ClaudeInfererOptions } from "../src/document_factory.js";
import type { AgentInvocationContext, AgentStreamEvent } from "../src/runtime.js";
import { testAgent } from "./_support/agents.js";
import {
  FAKE_BIN,
  ensureFakeClaudeExecutable,
  scriptFakeClaude,
  resetFakeClaude,
  assistantLine,
  systemInitLine,
  successResultLine,
  errorResultLine,
} from "./_support/fake_claude.js";

beforeAll(ensureFakeClaudeExecutable);
afterEach(resetFakeClaude);

function ctxFor(events?: AgentStreamEvent[]): AgentInvocationContext {
  const base = {
    agent: testAgent({ slug: "deliverer", primitives: ["INTERPRET"], output_types: ["finding"] }),
    phase: "interpret",
    inputs: [],
    gig_input: {},
  };
  return events ? { ...base, onEvent: (ev: AgentStreamEvent) => void events.push(ev) } : base;
}

const invokeFake = (): ReturnType<typeof makeClaudeInvoker> => makeClaudeInvoker({ bin: FAKE_BIN });

describe("#222 finalText discards the answer", () => {
  // parsedAny (:404) is set by ANY line that parses as JSON — including the model's own
  // answer, which has no `type` field and matches neither the result branch (:405) nor the
  // assistant branch (:408). So `if (!parsedAny) return stdout` (:412) never fires for the
  // very payload the comment at :395 names ("plain -p mode").

  // SEVERITY NOTE for the first two: claude_invoker.ts:323 UNCONDITIONALLY appends
  // `--output-format stream-json --verbose`, so the production spawn never elicits plain
  // stdout, and :412's fallback looks unreachable on the only path that calls finalText.
  // These are therefore defence-in-depth on a documented-but-dead branch, NOT the live bug.
  // The live bug is the third test below.

  it("delivers a bare JSON object emitted on stdout (dead branch, defence in depth)", async () => {
    // today: finalText returns "" → extractJson throws "no JSON object in model output".
    scriptFakeClaude({ stdout: '{"title":"x"}\n' });
    await expect(invokeFake()(ctxFor())).resolves.toEqual({ title: "x" });
  });

  it("delivers a JSON object emitted after prose (dead branch, defence in depth)", async () => {
    scriptFakeClaude({ stdout: 'Here you go:\n{"title":"x"}\n' });
    await expect(invokeFake()(ctxFor())).resolves.toEqual({ title: "x" });
  });

  it("REACHABLE: a stream carrying only a system/init event must not yield an empty answer", async () => {
    // This is #222's bug through a shape the CLI actually emits under stream-json: the init
    // event parses (parsedAny true) but matches neither branch, there is no result event and
    // no assistant text, so finalText returns "" and extractJson throws a message that
    // blames the model for emitting no JSON when it emitted no ANSWER.
    // today: rejects "no JSON object in model output".
    scriptFakeClaude({ stdout: systemInitLine() + "\n", exit: 0 });
    await expect(invokeFake()(ctxFor())).rejects.toThrow(/no output|empty|no answer|no result/i);
  });

  it("does not let intermediate reasoning stand in for the answer", async () => {
    // No result event → :413 concatenates EVERY assistant text block across the whole run
    // (:408), so intermediate reasoning is glued in front of the answer.
    // today: resolves {"draft":"scaffold"} — the reasoning, not the answer.
    scriptFakeClaude({
      stdout:
        assistantLine('Considering {"draft":"scaffold"} as a shape.') +
        "\n" +
        assistantLine('{"title":"real"}') +
        "\n",
    });
    await expect(invokeFake()(ctxFor())).resolves.toEqual({ title: "real" });
  });

  it("an empty result string must not beat real assistant text", async () => {
    // :405 assigns `result` whenever it is a string — and "" IS a string — so :413's
    // `result ?? assistant.join("\n")` returns "" because "" is not nullish. The nullish
    // coalescing is the bug; `||` or an explicit emptiness check is the fix.
    // today: rejects "no JSON object in model output".
    scriptFakeClaude({
      stdout: assistantLine('{"title":"real"}') + "\n" + successResultLine("") + "\n",
    });
    await expect(invokeFake()(ctxFor())).resolves.toEqual({ title: "real" });
  });

  it("regression guard — a trailing sign-off must not become the answer (passes today)", async () => {
    // Decision-neutral guard, green today, documenting a real trap: #222's "prefer the final
    // assistant block" and #221's "prefer the LAST candidate" BOTH turn this green case red.
    // `expectKeys` only rescues it when the chair's output type resolves to a schema with
    // matching properties — for a bare-core-type or unregistered output type, schemaOf
    // returns undefined and the positional tiebreak selects the sign-off again.
    scriptFakeClaude({
      stdout:
        assistantLine('{"title":"real"}') +
        "\n" +
        assistantLine('Done — hope that helps! {"note":"sign-off"}') +
        "\n",
    });
    await expect(invokeFake()(ctxFor())).resolves.not.toEqual({ note: "sign-off" });
  });
});

describe("#223 stream-json error results are never detected", () => {
  // CORRECTION TO THE ISSUE TEXT, verified against the installed CLI (see the provenance
  // note in tests/_support/fake_claude.ts): the error result variant carries NO `result`
  // field and `is_error: FALSE`. So finalText:405 never fires, `result` stays undefined, and
  // :413 falls through to the concatenated assistant text — a capped/aborted run silently
  // answers with the model's PARTIAL REASONING.
  //
  // Two consequences for the implementer:
  //   - `subtype` is the required discriminator; `is_error` alone catches NEITHER subtype.
  //   - the CLI exits 0 for both (the print-mode handler sets the code as
  //     `is_error ? 1 : 0`), so this silent path is LIVE, not dead risk.

  it("does not seal partial reasoning when the TURN CAP is hit", async () => {
    // today: resolves {"draft":"partial"} — an incomplete run seals as if it succeeded.
    scriptFakeClaude({
      stdout:
        assistantLine('Working... so far {"draft":"partial"}') +
        "\n" +
        errorResultLine("error_max_turns") +
        "\n",
      exit: 0,
    });
    await expect(invokeFake()(ctxFor())).rejects.toThrow(/error_max_turns|max[_ ]?turns/i);
  });

  it("does not seal partial reasoning on error_during_execution", async () => {
    // The THIRD subtype, identical shape, identical silent failure. Without this, an
    // implementation that special-cases only `error_max_turns` satisfies the test above
    // while this path still silently seals — the exact hollow-green this closes.
    // today: resolves {"draft":"partial"}.
    scriptFakeClaude({
      stdout:
        assistantLine('Working... so far {"draft":"partial"}') +
        "\n" +
        errorResultLine("error_during_execution") +
        "\n",
      exit: 0,
    });
    await expect(invokeFake()(ctxFor())).rejects.toThrow(
      /error_during_execution|during execution/i,
    );
  });

  it("names the turn cap rather than reporting a JSON parse bug", async () => {
    // today: rejects "no JSON object in model output" — an agent that exhausted its turn cap
    // is reported to the operator as a parse failure.
    scriptFakeClaude({
      stdout:
        assistantLine("Still thinking, no object yet.") + "\n" + errorResultLine("error_max_turns") + "\n",
      exit: 0,
    });
    await expect(invokeFake()(ctxFor())).rejects.toThrow(/error_max_turns|max[_ ]?turns/i);
  });

  it("guard — a non-zero exit already fails loudly with the exit code (passes today)", async () => {
    // Pins the branch that is already safe, so the reds above are unambiguously about exit 0.
    scriptFakeClaude({ stdout: errorResultLine("error_max_turns") + "\n", exit: 1, stderr: "boom\n" });
    await expect(invokeFake()(ctxFor())).rejects.toThrow(/exited 1/);
  });

  it("does not seal an API-error payload as the answer", async () => {
    // The `success` subtype CAN carry is_error: true (cli.js sets it from isApiErrorMessage),
    // and then `result` is the API error text.
    // today: extractJson finds {"code":429} inside that text and RESOLVES with it.
    // The scripted text below is deliberately free of the words the matcher requires, so an
    // implementation that merely echoes the result text into an Error cannot match by accident.
    scriptFakeClaude({ stdout: successResultLine('Upstream overloaded {"code":429}', true) + "\n" });
    await expect(invokeFake()(ctxFor())).rejects.toThrow(/is_error|error result|flagged/i);
  });
});

describe("#224 spawnStreaming never flushes its trailing partial line", () => {
  // The read loop drains buf only on "\n" (:355-361); the close handler (:365-369) resolves
  // without flushing the residual. captureUsage (runtime.ts:320-343) reads total_cost_usd
  // ONLY from result events — so that chair's spend silently vanishes from GigResult.usage.
  // finalText is unaffected (it re-splits the full stdout), which is exactly why this is
  // silent: the run succeeds, only the accounting is wrong.

  const RESULT_NO_NEWLINE = successResultLine('{"ok":true}');

  it("emits the final result event even without a trailing newline", async () => {
    const events: AgentStreamEvent[] = [];
    scriptFakeClaude({ stdout: RESULT_NO_NEWLINE }); // deliberately NO trailing "\n"
    await invokeFake()(ctxFor(events));
    const result = events.find((e) => e.type === "result");
    expect(
      result,
      "no result event reached onEvent — the trailing line was never flushed (#224)",
    ).toBeDefined();
    expect((result?.raw as { total_cost_usd?: number } | undefined)?.total_cost_usd).toBe(0.42);
  });

  it("paired control — the SAME line WITH a newline does emit (passes today)", async () => {
    // Proves the red above is about the missing flush, not about events generally.
    const events: AgentStreamEvent[] = [];
    scriptFakeClaude({ stdout: RESULT_NO_NEWLINE + "\n" });
    await invokeFake()(ctxFor(events));
    expect(events.find((e) => e.type === "result")).toBeDefined();
  });

  it("still delivers the payload without a trailing newline (passes today)", async () => {
    // Guards that adding the flush does not disturb delivery.
    scriptFakeClaude({ stdout: RESULT_NO_NEWLINE });
    await expect(invokeFake()(ctxFor())).resolves.toEqual({ ok: true });
  });

  it.todo(
    "UNSPECIFIED: bound retained stdout (claude_invoker.ts:344,352-354 accumulate with no " +
      "length guard; the only bound is the 10-minute wall clock, vs document_factory.ts:93's " +
      "maxBuffer 64MB). Blocked on a spec: what is the cap, and on breach does it reject, " +
      "truncate, or SIGKILL the child? No issue states this, so any assertion here would be " +
      "inventing the contract rather than testing it.",
  );
});

describe("#225 document_factory's spawn has no timeout", () => {
  // src/document_factory.ts:93 — execFileSync(b, args, { encoding, maxBuffer }) with no
  // `timeout` and no `killSignal`. This is the exact wedge tests/invoker_timeout.test.ts was
  // written RED-first to close for the main invoker (an 8077s stuck dispatch), and which
  // claude_invoker.ts:185-189,347-350 and user_flow_judge.ts:205-209 both handle. This call
  // is synchronous, so one wedged child wedges the process.
  //
  // The child TRAPS SIGTERM, which is what makes the elapsed assertion discriminating —
  // measured on this machine:
  //   execFileSync{timeout:300}                        → ETIMEDOUT after 2063ms (waited it out)
  //   execFileSync{timeout:300, killSignal:"SIGKILL"}  → ETIMEDOUT after  305ms
  // So a fix that adds only `timeout` still throws and would pass a bare `toThrow()`, while
  // violating the discipline stated at claude_invoker.ts:186-188 ("SIGKILL, not SIGTERM: a
  // signal-trapping child can't outlive its budget"). Both assertions are required.
  //
  // NOTE: `timeout_ms` mirrors the existing ClaudeInvokerOptions.timeout_ms (:208).

  it("bounds the inference spawn's wall clock AND kills with SIGKILL", { timeout: 20_000 }, () => {
    scriptFakeClaude({ stdout: '{"gist":"ok"}\n', sleepMs: 2000, trapSigterm: true });
    const withTimeout = makeClaudeInferer as unknown as (
      o: ClaudeInfererOptions & { timeout_ms: number },
    ) => (req: Parameters<ReturnType<typeof makeClaudeInferer>>[0]) => Record<string, unknown>;
    const infer = withTimeout({ bin: FAKE_BIN, timeout_ms: 300 });

    const started = Date.now();
    let threw: unknown;
    try {
      infer({
        dataset: { fact: "one" },
        instruction: "summarize",
        response_type: { fields: { gist: "string" } },
        constraints: [],
      });
    } catch (e) {
      threw = e;
    }
    const elapsed = Date.now() - started;

    expect(
      threw,
      `no timeout at all: the 2s child ran to completion in ${elapsed}ms and returned normally (#225)`,
    ).toBeDefined();
    expect(
      elapsed,
      `the spawn was not SIGKILLed — it waited ${elapsed}ms for a SIGTERM-trapping child (#225)`,
    ).toBeLessThan(1500);
  });
});
