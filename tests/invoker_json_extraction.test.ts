// RED-first — the JSON extraction contract on the critical path of every sealed output.
//
// Issues under test:
//   #221 extractJson is string-blind and first-brace-anchored — it can silently seal
//        the wrong object.
//   #226 user_flow_judge carries a duplicate half-fixed extractor.
//
// Approved selection policy (deliberate contract change, blessed by the maintainer):
//   1. Enumerate candidates at EVERY `{` start position, walking with inString/escaped state.
//   2. Score: prefer a fenced candidate → then one matching `expectKeys` → then the LAST.
//   3. Throw a TYPED error carrying candidate count + a bounded excerpt of the raw text.
//   4. Accept a single-element top-level array; REJECT a multi-element one explicitly.
//   5. One shared implementation consumed by all four production call sites.
//
// `expectKeys` is derived from the RESOLVED OUTPUT SCHEMA'S PROPERTY NAMES (available at
// claude_invoker.ts:287, `schemaOf(outType)`), unioned with the output type slugs. Deriving
// it from type slugs ALONE is inert for a single-output chair: buildPrompt:148-155 asks such
// a chair for the bare data object, never wrapped in {"<type-slug>": …}; only a multi-output
// chair gets the type-keyed blob (:138-147). Both shapes are covered below.
//
// Every "today" note was verified empirically against the compiled function.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { extractJson, makeClaudeInvoker } from "../src/claude_invoker.js";
import * as invokerModule from "../src/claude_invoker.js";
import * as judgeModule from "../src/judges/user_flow_judge.js";
import { makeClaudeInferer } from "../src/document_factory.js";
import { createRegistry, type DomainType } from "../src/registry.js";
import { testAgent } from "./_support/agents.js";
import {
  FAKE_BIN,
  ensureFakeClaudeExecutable,
  scriptFakeClaude,
  resetFakeClaude,
  successResultLine,
} from "./_support/fake_claude.js";

// The typed error does not exist yet. Probe it as a namespace property rather than a named
// import: a missing named import fails the whole FILE at link time, masking every other red.
const ModelOutputParseError = (invokerModule as unknown as Record<string, unknown>)[
  "ModelOutputParseError"
] as (new (...a: never[]) => Error) | undefined;

// #226 resolves EITHER by re-exporting the shared function OR by deleting the judge's copy
// outright (importing without re-exporting). A named import would hard-fail the file under
// the second, likelier resolution — so probe the namespace and accept either.
const judgeExtractJson = (judgeModule as unknown as Record<string, unknown>)["extractJson"] as
  | typeof extractJson
  | undefined;

// `expectKeys` is not in the signature yet. Call through a locally-typed alias so
// `tsc --noEmit` stays clean — the red must come from the assertion, not the compiler.
type ExtractWithOpts = (
  text: string,
  opts?: { expectKeys?: readonly string[] },
) => Record<string, unknown>;
const extractWithOpts = extractJson as unknown as ExtractWithOpts;

/** Run `fn`, return whatever it threw (or undefined if it didn't throw). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

beforeAll(ensureFakeClaudeExecutable);
afterEach(resetFakeClaude);

describe("#221 extractJson — SILENT wrong-object selection (the severe class)", () => {
  // These return a plausible-but-wrong object with no error. It then flows to
  // runtime.ts:729-743 and is sealed with a real content_sha and genuine provenance edges —
  // output_trace reports an intact, byte-reproducible chain over garbage.

  it("does not return an empty preamble object in place of the answer", () => {
    // today: returns {} — the `{}` in the prose is the first balanced run.
    expect(extractJson('I considered {} then produced:\n{"title":"REAL"}')).toEqual({
      title: "REAL",
    });
  });

  it("does not return an illustrative preamble object in place of the answer", () => {
    // today: returns {"foo":"bar"}. buildPrompt embeds the output schema into the prompt
    // (:150), so a model echoing the example emits a preamble object SHAPED LIKE THE REAL
    // SCHEMA — which passes seal validation and seals fabricated content.
    expect(
      extractJson('For example {"foo":"bar"} is the shape. Answer:\n{"title":"REAL"}'),
    ).toEqual({ title: "REAL" });
  });

  it("prefers the LAST complete object when a model emits scaffolding first", () => {
    // today: returns {"first":1}.
    expect(extractJson('{"first":1}\n{"second":2}')).toEqual({ second: 2 });
  });

  it("REJECTS a multi-element top-level array instead of silently truncating it", () => {
    // today: returns {"a":1} — the array framing and every later element vanish silently.
    expect(() => extractJson('[{"a":1},{"b":2}]')).toThrow();
  });

  it("accepts a single-element top-level array (forward-guard — passes today)", () => {
    expect(extractJson('[{"a":1}]')).toEqual({ a: 1 });
  });
});

describe("#221 extractJson — LOUD failures on valid model output", () => {
  // One chair's parse failure aborts the phase (runtime.ts:473-477) and kills the gig;
  // there is no retry anywhere. At ~$4-7 per full run, one stray brace burns it.

  it("tolerates an unbalanced closing brace inside a string value", () => {
    // today: SyntaxError "Unterminated string at position 7" — the `}` inside the string
    // drives depth to 0 and truncates the slice to `{"a":"}`.
    expect(extractJson('{"a":"}","b":1}')).toEqual({ a: "}", b: 1 });
  });

  it("tolerates an unbalanced opening brace inside a string value", () => {
    // today: Error "unbalanced JSON object in model output" — a message that is factually
    // FALSE (the input is balanced) and misdirects the operator into re-prompting the agent.
    expect(extractJson('{"a":"{","b":1}')).toEqual({ a: "{", b: 1 });
  });

  it("tolerates an escaped quote wrapping a brace inside a string", () => {
    // Escape-awareness — the half of a string-aware rewrite that is easiest to get wrong.
    // (This was "R2" in the characterization: a RED, not a guard. The true guards — cases
    // that pass today and must survive — are R1/R3/R4 in their own block below.)
    // today: SyntaxError "Unterminated string".
    expect(extractJson('{"q":"he said \\"}\\" then left","v":1}')).toEqual({
      q: 'he said "}" then left',
      v: 1,
    });
  });

  it("skips a non-JSON brace run in the prose and finds the real object", () => {
    // today: SyntaxError — it parses `{a,b}` and never reaches the real object, because
    // `start` is anchored to the first `{` and never re-anchors.
    expect(extractJson('The set {a,b} matters.\n{"ok":true}')).toEqual({ ok: true });
  });

  it.todo(
    "NOT COVERED BY THE APPROVED DESIGN: a literal control character inside a string " +
      "value (a model writing a real newline into a markdown field) makes EVERY candidate " +
      "fail JSON.parse. Candidate enumeration cannot recover it — it needs a repair pass " +
      "(escape control chars inside detected string spans) or an explicit non-goal. " +
      "Marked so an implementer does not assume it is handled.",
  );
});

describe("#221 extractJson — fenced candidates win", () => {
  it("prefers a fenced block over a brace run in the surrounding prose", () => {
    // today: SyntaxError — the first `{` is `{the plan}`, which is not JSON.
    expect(extractJson('Here\'s {the plan}:\n```json\n{"title":"REAL"}\n```')).toEqual({
      title: "REAL",
    });
  });

  it("prefers the LAST json-tagged fence when a model shows an example first", () => {
    // today: returns {"example":true} — silently, the example instead of the answer.
    expect(
      extractJson('```json\n{"example":true}\n```\nActual:\n```json\n{"real":1}\n```'),
    ).toEqual({ real: 1 });
  });
});

// ---------------------------------------------------------------------------
// expectKeys — the tiebreak that position cannot supply.
//
// Every text here is built so NEITHER "first" NOR "last" yields the right object: the
// intended candidate sits in the MIDDLE. Only a key signal can pick it.
// ---------------------------------------------------------------------------

/** Single-output chair shape: bare data objects, as buildPrompt:148-155 actually requests. */
const MIDDLE_IS_ANSWER =
  'Preamble {"note":"thinking"}\n{"title":"real","severity":"high"}\nDone {"status":"ok"}';

/** Multi-output chair shape: the type-keyed blob buildPrompt:138-147 requests. */
const MIDDLE_IS_KEYED_ANSWER =
  'Preamble {"note":"thinking"}\n{"grant-draft":{"body":"real"}}\nDone {"status":"ok"}';

/** A registered `finding` type — the source of the schema property names. */
const FINDING_TYPE: DomainType = {
  slug: "finding",
  extends: "Interpretation",
  domain: "eirtests",
  schema: {
    type: "object",
    properties: { title: { type: "string" }, severity: { type: "string" } },
  },
  required_fields: ["title"],
};

describe("#221 extractJson — expectKeys disambiguates when position cannot", () => {
  it("selects the candidate carrying the output schema's property names", () => {
    // today: returns {"note":"thinking"} (first-brace; the opts argument is ignored).
    expect(extractWithOpts(MIDDLE_IS_ANSWER, { expectKeys: ["title", "severity"] })).toEqual({
      title: "real",
      severity: "high",
    });
  });

  it("also accepts a type slug, so the multi-output keyed shape still works", () => {
    // The union half of the policy: schema property names PLUS the output type slugs.
    expect(extractWithOpts(MIDDLE_IS_KEYED_ANSWER, { expectKeys: ["grant-draft"] })).toEqual({
      "grant-draft": { body: "real" },
    });
  });

  it("threads the resolved schema's properties through — injected-run path", async () => {
    // Proves the wiring at claude_invoker.ts:287, not just the extractor in isolation.
    // A SINGLE-output chair, fed the shape buildPrompt actually asks it for.
    const invoke = makeClaudeInvoker({
      registry: createRegistry([FINDING_TYPE]),
      run: () => MIDDLE_IS_ANSWER,
    });
    const out = await invoke({
      agent: testAgent({ slug: "finder", primitives: ["INTERPRET"], output_types: ["finding"] }),
      phase: "interpret",
      inputs: [],
      gig_input: {},
      output_types: ["finding"],
    });
    expect(out).toEqual({ title: "real", severity: "high" });
  });

  it("threads the resolved schema's properties through — PRODUCTION streaming path", async () => {
    // The twin that matters: the test above goes through opts.run (:319, injected). Production
    // is :325. Without this, an implementer can thread at :319 only, pass that test, and leave
    // every real chair unthreaded.
    //
    // The candidates ride inside a stream-json `result` event on purpose. Scripting them as
    // plain stdout would make this fail through finalText's #222 bug ("no JSON object in
    // model output") instead of through the selection policy — a wrong-reason red. Delivering
    // via the result branch (:405) isolates #221.
    scriptFakeClaude({ stdout: successResultLine(MIDDLE_IS_ANSWER) + "\n" });
    const invoke = makeClaudeInvoker({
      bin: FAKE_BIN,
      registry: createRegistry([FINDING_TYPE]),
    });
    const out = await invoke({
      agent: testAgent({ slug: "finder", primitives: ["INTERPRET"], output_types: ["finding"] }),
      phase: "interpret",
      inputs: [],
      gig_input: {},
      output_types: ["finding"],
    });
    expect(out).toEqual({ title: "real", severity: "high" });
  });
});

describe("#221 policy 5 — every call site gets the same behaviour AND the same key signal", () => {
  // Behaviour propagates through the shared import; `expectKeys` does NOT unless each call
  // site passes it. Both of these sites hold the key source in scope already and ignore it.

  it("document_factory threads the response shape's fields (document_factory.ts:97)", () => {
    // `req.response_type.fields` IS the expected key set, right there at the call site.
    // The Inferer is called DIRECTLY (not through runInference) so this isolates the
    // extractJson call site at document_factory.ts:97 — no shape-check/retry in the way.
    // today: extractJson(run(...)) is called with no opts → first-brace → {"note":"thinking"}.
    const infer = makeClaudeInferer({ run: () => MIDDLE_IS_ANSWER });
    expect(
      infer({
        dataset: { fact: "one" },
        instruction: "summarize",
        response_type: { fields: { title: "string", severity: "string" } },
        constraints: [],
      }),
    ).toEqual({ title: "real", severity: "high" });
  });

  it.todo(
    "bifrost_invoker.ts:116 has the same gap — it resolves the output schema at :64 and " +
      "then calls extractJson(text) with no opts. Not asserted here because it needs a " +
      "url/deviceToken/fetchFn harness; covered by tests/bifrost_invoker.test.ts's fixtures " +
      "once the opts parameter exists.",
  );
});

describe("#221 extractJson — typed error with a bounded excerpt", () => {
  // Today both throws are bare `Error` with no sample of the offending text (:163, :175), so
  // the operator's entire diagnostic is a V8 offset into a string never surfaced. A typed
  // error is also the prerequisite for any retry policy: runtime.ts:454-477 cannot currently
  // tell a retryable parse failure from a non-retryable contract failure.
  //
  // The class's EXISTENCE is deliberately not asserted on its own — an empty
  // `export class ModelOutputParseError extends Error {}` that is never thrown would satisfy
  // that. Type and behaviour are pinned together instead.

  it("throws ModelOutputParseError with a candidate count and an excerpt", () => {
    const err = thrownBy(() => extractJson("no json here")) as {
      candidateCount?: unknown;
      excerpt?: unknown;
    };
    expect(err).toBeDefined();
    expect(
      ModelOutputParseError,
      "src/claude_invoker.ts exports no ModelOutputParseError (#221)",
    ).toBeTypeOf("function");
    expect(err).toBeInstanceOf(ModelOutputParseError!);
    expect(err.candidateCount, "no candidateCount on the thrown error (#221)").toBe(0);
    expect(String(err.excerpt ?? ""), "no excerpt on the thrown error (#221)").toContain(
      "no json here",
    );
  });

  it("bounds the excerpt rather than embedding the whole output", () => {
    // The exact bound is the implementer's choice; this asserts only that it IS bounded and
    // well under a large payload, so a 50KB blob never lands in a log line.
    const huge = "prose with no object ".repeat(2500);
    const err = thrownBy(() => extractJson(huge)) as { excerpt?: unknown };
    expect(err).toBeDefined();
    const excerpt = String(err.excerpt ?? "");
    expect(excerpt.length, "no bounded excerpt on the thrown error (#221)").toBeGreaterThan(0);
    expect(excerpt.length).toBeLessThanOrEqual(2000);
    expect(excerpt.length).toBeLessThan(huge.length);
  });
});

describe("#221 regression guards R1/R3/R4 — these pass TODAY and must survive the rewrite", () => {
  // R3 passes BY ACCIDENT (the in-string braces happen to cancel). A string-aware rewrite
  // that mishandles escapes breaks R1; one that over-corrects breaks R3.
  // (R2 from the characterization is a RED, not a guard — it lives in the LOUD block above.)

  it("R1 — an escaped backslash before a closing quote", () => {
    expect(extractJson('{"path":"C:\\\\","v":1}')).toEqual({ path: "C:\\", v: 1 });
  });

  it("R3 — a BALANCED brace pair inside a string (works by accident today)", () => {
    expect(extractJson('{"note":"use {slug} here","ok":true}')).toEqual({
      note: "use {slug} here",
      ok: true,
    });
  });

  it("R4 — the four pre-existing assertions from tests/claude_invoker.test.ts", () => {
    // Co-located so the rewrite's own suite states what it may not break. The originals stay
    // byte-identical in their own file; this is an additional guard.
    expect(extractJson('{"title":"x"}')).toEqual({ title: "x" });
    expect(
      extractJson(
        'Here is the finding:\n```json\n{"title":"missing alt","severity":"high"}\n```\nDone.',
      ),
    ).toEqual({ title: "missing alt", severity: "high" });
    expect(extractJson('prefix {"a":{"b":1},"c":2} suffix')).toEqual({ a: { b: 1 }, c: 2 });
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("#226 the judge's duplicate extractor collapses into the shared one", () => {
  // Accepts EITHER legitimate resolution: re-export the shared function, or delete the copy
  // outright (then the namespace has no `extractJson` at all).
  it("no longer defines its own extractor", () => {
    expect(
      judgeExtractJson === undefined || judgeExtractJson === extractJson,
      "src/judges/user_flow_judge.ts still defines its own extractJson (#226)",
    ).toBe(true);
  });

  // The two cases proving the judge's copy is a HALF-fix: it enumerates candidate END
  // positions from a FIXED start, so its "progressively larger candidates" strategy spans the
  // junk rather than skipping it. Anyone fixing the shared function by copy-pasting this
  // version ships a half-fix — which is why these are asserted against it directly.

  it("skips a non-JSON brace run in the prose", () => {
    // today (judge copy): throws.
    expect(judgeExtractJson?.('The set {a,b} matters.\n{"ok":true}')).toEqual({ ok: true });
  });

  it("does not return an illustrative preamble object", () => {
    // today (judge copy): returns {"foo":"bar"}.
    expect(
      judgeExtractJson?.('For example {"foo":"bar"} is the shape. Answer:\n{"title":"REAL"}'),
    ).toEqual({ title: "REAL" });
  });
});
