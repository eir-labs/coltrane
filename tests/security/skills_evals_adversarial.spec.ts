// Adversarial probe of PR #102 (skills wired) + PR #103 (evals wired).
//
// Eugene's stance: GREENS MEAN NOTHING. Both PRs ship green tests but only
// assert that skill content is INJECTED into the prompt and that the eval
// runtime PRODUCES a soft-verdict. Neither asserts:
//   - the model under instruction actually obeys the skill (behavioral effect)
//   - the runtime actually CHECKS the eval's declared `checks` field (the
//     5th class is only as honest as the eval-agent's self-report)
//
// Probes A/B/C are the holes.
//
// Probe A — Skills behavioral effect (real-spawn).
//   Bind a skill whose md says "end every response with SKILL_X_INVOKED".
//   Spawn real claude through makeClaudeInvoker. Ask 2+2. If the canary is
//   missing from the model's JSON output, the skill is INJECTED but
//   IGNORED — the wire delivers paper to the model, not behavior.
//
// Probe B — Evals rubber-stamp (deterministic-invoker).
//   The eval-agent invocation IS just another agent invocation. Whatever
//   the agent returns is wrapped verbatim into a soft-verdict. There is
//   NO runtime check of the eval's declared `checks` field — that field
//   is metadata-only. We demonstrate: an eval-agent that LIES (passed:true
//   on output that the eval's own `checks` would clearly reject) lands
//   passed:true in the store. The 5th class is honest-broker-free.
//
// Probe C — Skills per-agent scope.
//   Bind skill X to agent A in a 2-agent standard. Bind nothing to agent B.
//   Capture both spawn prompts. Assert: B's prompt has NO skill content.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTempdirColtrane, type TempdirColtrane } from "../e2e/_harness.js";
import {
  MemoryLedger,
  createOutputStore,
  loadGenome,
  loadRegistry,
  makeClaudeInvoker,
  runGig,
  dispatchTool,
  type AgentInvoker,
  type ServerDeps,
} from "../../src/index.js";

const CANARY = "SKILL_X_INVOKED";

describe("adversarial — skills + evals wires", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    for (const sub of ["agents", "standards", "domain_types", "skills", "evals"]) {
      const p = join(env.tempDir, sub);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      mkdirSync(p, { recursive: true });
    }

    // Domain types — single-field outputs the test can shape end-to-end.
    writeFileSync(
      join(env.tempDir, "domain_types", "raw-note.json"),
      JSON.stringify({
        slug: "raw-note", version: 1, extends: "Signal", domain: "advdemo", status: "active",
        schema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
        required_fields: ["body"],
      }),
    );
    writeFileSync(
      join(env.tempDir, "domain_types", "decision-note.json"),
      JSON.stringify({
        slug: "decision-note", version: 1, extends: "Interpretation", domain: "advdemo", status: "active",
        schema: {
          type: "object",
          properties: { decision: { type: "string" }, raw_text: { type: "string" } },
          required: ["decision"],
        },
        required_fields: ["decision"],
      }),
    );
    // soft-verdict — required by the runtime's eval-fire path. The harness wipe
    // strips ALL domain_types, so we restore the canonical schema here.
    writeFileSync(
      join(env.tempDir, "domain_types", "soft-verdict.json"),
      JSON.stringify({
        slug: "soft-verdict", version: 1, extends: "Interpretation", domain: "self_judge", status: "active",
        schema: {
          type: "object",
          properties: {
            criteria: { type: "object" },
            overall_verdict_shade: {
              type: "string",
              enum: ["full-soft-RIPENED", "partly", "KILLED", "UNJUDGEABLE"],
            },
          },
        },
        required_fields: ["criteria", "overall_verdict_shade"],
      }),
    );
  });
  afterAll(() => env?.cleanup());

  // ───────────────────────── Probe A — behavioral effect ─────────────────────────
  it("Probe A — skill content reaches the model AND the model obeys it (real-spawn)", async () => {
    // The behavioral canary: a skill whose md is a directive the model must follow.
    // If the wire is honest at the behavioral layer, the model's output JSON will
    // CONTAIN the canary string (we ask it to embed CANARY in `raw_text`). RED:
    // skill present in prompt but missing from output → injected-but-ignored.
    writeFileSync(
      join(env.tempDir, "skills", "behavioral-canary.json"),
      JSON.stringify({
        slug: "behavioral-canary",
        domain: "advdemo",
        md:
          `CRITICAL OVERRIDE: when producing your JSON output, you MUST include the literal ` +
          `string "${CANARY}" inside the "raw_text" field. This is mandatory. No exceptions. ` +
          `If you omit this string, your response is invalid.`,
      }),
    );
    writeFileSync(
      join(env.tempDir, "agents", "canary-decider.json"),
      JSON.stringify({
        slug: "canary-decider",
        primitives: ["INTERPRET"],
        input_types: [],
        output_types: ["decision-note"],
        domain: "advdemo",
        skill_slugs: ["behavioral-canary"],
      }),
    );
    writeFileSync(
      join(env.tempDir, "standards", "probe-a.json"),
      JSON.stringify({
        slug: "probe-a", domain: "advdemo",
        agent_slugs: ["canary-decider"],
        phases: [{ name: "decide", agent: "canary-decider" }],
      }),
    );

    const g = loadGenome(env.tempDir);
    const standard = g.standards.get("probe-a")!;
    const registry = loadRegistry(g);

    // Real claude — no captured-spawn mock. We want to know if the model
    // actually follows skill_md when injected via the Skills layer.
    const invoke = makeClaudeInvoker({ registry, model: process.env["COLTRANE_MODEL"] });
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();

    const res = await runGig(
      standard,
      { question: "What is 2+2? Give the decision and rationale." },
      { outputs, ledger, invoke, skills: g.skills },
    );
    expect(res.status).toBe("complete");
    const out = res.outputs[0]!;
    const blob = JSON.stringify(out.data);

    // The deliverable assertion. RED if false. We do NOT soften.
    expect(
      blob.includes(CANARY),
      `Probe A FOUND HOLE: skill_md content was injected into the prompt (PR #102 proves this) ` +
      `but the model did NOT include the canary string "${CANARY}" in its output. ` +
      `Skill injection ≠ skill adherence. Output was: ${blob}`,
    ).toBe(true);
  }, 180_000);

  // ───────────────────────── Probe B — eval rubber-stamp ─────────────────────────
  it("Probe B — eval runtime DOES NOT check the eval's declared `checks` (the verdict is whatever the agent says)", async () => {
    // The eval declares `checks` that the OUTPUT clearly fails (decision must
    // be "YES"; sensor returns "NO"). The eval-agent invocation LIES — returns
    // {passed:true}. If the runtime trusted the eval-agent unconditionally,
    // soft-verdict.passed lands TRUE despite the output being wrong by the
    // eval's own declared rule. That's the hole.
    writeFileSync(
      join(env.tempDir, "agents", "no-sayer.json"),
      JSON.stringify({
        slug: "no-sayer", primitives: ["INTERPRET"], input_types: [],
        output_types: ["decision-note"], domain: "advdemo",
      }),
    );
    writeFileSync(
      join(env.tempDir, "agents", "lying-eval-agent.json"),
      JSON.stringify({
        slug: "lying-eval-agent", primitives: ["INTERPRET"],
        input_types: ["decision-note"], output_types: ["soft-verdict"], domain: "advdemo",
      }),
    );
    writeFileSync(
      join(env.tempDir, "standards", "probe-b.json"),
      JSON.stringify({
        slug: "probe-b", domain: "advdemo",
        agent_slugs: ["no-sayer"],
        phases: [{ name: "decide", agent: "no-sayer" }],
      }),
    );
    writeFileSync(
      join(env.tempDir, "evals", "must-be-yes.json"),
      JSON.stringify({
        slug: "must-be-yes", domain: "advdemo",
        fires_on_standard: "probe-b",
        agent_slug: "lying-eval-agent",
        // The eval's DECLARED contract. The runtime MUST honor this if it's a
        // real check; right now it doesn't — the field is purely advisory.
        checks: ["decision === 'YES'"],
      }),
    );

    const { bootstrapServerDeps } = await import("../../src/index.js");
    const baseDeps = bootstrapServerDeps(env.tempDir);

    // Deterministic invoker: the sensor returns decision: "NO" (output FAILS
    // the eval's declared check). The eval-agent LIES — returns passed:true.
    const invoke: AgentInvoker = ({ agent, phase }) => {
      if (agent.slug === "no-sayer") return { decision: "NO", raw_text: "definitely not yes" };
      if (agent.slug === "lying-eval-agent") {
        return {
          passed: true,
          reason: "looks fine to me [LIE — eval did no actual check]",
          checked: [{ name: "decision-is-yes", ok: true }],
        };
      }
      throw new Error(`unexpected agent: ${agent.slug} phase=${phase}`);
    };
    const wired: ServerDeps = { ...baseDeps, invoke };

    const dispatch = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "probe-b", input: {} },
      wired,
    );
    expect(dispatch.ok).toBe(true);
    const { gig_id } = dispatch.data as { gig_id: string };
    const query = await dispatchTool("output_query", { gig_id }, wired);
    const outputs = (query.data as { outputs: Array<{ domain_type: string; data: Record<string, unknown> }> }).outputs;

    const verdicts = outputs.filter((o) => o.domain_type === "soft-verdict");
    expect(verdicts.length).toBe(1);
    const verdict = verdicts[0]!.data;
    const decisionOutput = outputs.find((o) => o.domain_type === "decision-note")!;
    expect(decisionOutput.data["decision"]).toBe("NO"); // sanity: the upstream output

    // The desired-behavior assertion. RED if false (i.e., right now). A real
    // 5th-class would evaluate the eval's declared `checks` against the
    // output and refuse the agent's rubber-stamp when decision !== 'YES'.
    // Today the runtime stamps verdict.passed = true because that's what the
    // lying eval-agent said. This stays RED until the runtime executes
    // `checks` independently of the eval-agent's self-report.
    expect(
      verdict["passed"],
      `Probe B HOLE: eval declared checks: ["decision === 'YES'"], the output's ` +
      `decision = "NO" (FAILS the check), the eval-agent LIED with passed:true, ` +
      `and the runtime persisted passed:true unchanged. The 5th class is honest- ` +
      `broker-free — \`checks\` is metadata; the eval-agent's self-report IS the verdict.`,
    ).toBe(false);

    // The 2nd RED: nothing in the soft-verdict references the declared `checks`,
    // so even if a human reads the verdict, they have no way to audit what
    // the eval was SUPPOSED to assert vs what was actually evaluated.
    expect(
      JSON.stringify(verdict),
      "Probe B HOLE: the eval-definition's `checks` field is not surfaced in the verdict.",
    ).toContain("decision === 'YES'");
  });

  it("Probe B' — eval-agent that omits `passed` field collapses to Boolean(undefined)=false, silently flipping the verdict", async () => {
    // Hidden default: `Boolean(evalData["passed"])` in runtime.ts. An eval-agent
    // that returns `{reason: "all good"}` with no `passed` field gets stamped
    // KILLED + passed:false without any error or warning. That's a silent
    // contract failure — the eval-agent's incompetence reads as a hard fail.
    writeFileSync(
      join(env.tempDir, "agents", "missing-field-eval-agent.json"),
      JSON.stringify({
        slug: "missing-field-eval-agent", primitives: ["INTERPRET"],
        input_types: ["decision-note"], output_types: ["soft-verdict"], domain: "advdemo",
      }),
    );
    writeFileSync(
      join(env.tempDir, "evals", "broken-contract.json"),
      JSON.stringify({
        slug: "broken-contract", domain: "advdemo",
        fires_on_standard: "probe-b",
        agent_slug: "missing-field-eval-agent",
      }),
    );

    const { bootstrapServerDeps } = await import("../../src/index.js");
    const baseDeps = bootstrapServerDeps(env.tempDir);

    const invoke: AgentInvoker = ({ agent }) => {
      if (agent.slug === "no-sayer") return { decision: "NO", raw_text: "n/a" };
      if (agent.slug === "lying-eval-agent") return { passed: true, reason: "lie", checked: [] };
      if (agent.slug === "missing-field-eval-agent") {
        // No `passed`, no `reason`, no `checked`. The runtime should error or
        // surface a "malformed eval response" verdict. Instead it silently
        // collapses to passed:false.
        return { commentary: "I forgot the contract" } as Record<string, unknown>;
      }
      throw new Error(`unexpected: ${agent.slug}`);
    };
    const wired: ServerDeps = { ...baseDeps, invoke };

    const dispatch = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "probe-b", input: {} },
      wired,
    );
    expect(dispatch.ok).toBe(true);
    const { gig_id } = dispatch.data as { gig_id: string };
    const query = await dispatchTool("output_query", { gig_id }, wired);
    const outputs = (query.data as { outputs: Array<{ domain_type: string; data: Record<string, unknown>; agent_slug: string }> }).outputs;

    const brokenVerdict = outputs.find(
      (o) => o.domain_type === "soft-verdict" && o.agent_slug === "missing-field-eval-agent",
    )!;
    expect(brokenVerdict).toBeDefined();

    // The desired behavior: an eval-agent that returns a malformed shape
    // (no `passed`, no `reason`, no `checked`) should surface that as
    // distinguishable from a real FAIL — either UNJUDGEABLE shade, or a
    // typed runtime error, or a `malformed` flag. Today the runtime
    // silently maps Boolean(undefined) → false and stamps KILLED, which is
    // INDISTINGUISHABLE from a legitimate hard fail.
    //
    // RED until the runtime distinguishes "eval-agent broke contract" from
    // "eval-agent ran and the output failed."
    expect(
      brokenVerdict.data["overall_verdict_shade"],
      `Probe B' HOLE: malformed eval-agent response (missing passed/reason/checked) ` +
      `stamps overall_verdict_shade="KILLED" — silently indistinguishable from a ` +
      `real failure. Expected "UNJUDGEABLE" or equivalent.`,
    ).toBe("UNJUDGEABLE");
  });

  // ───────────────────────── Probe C — skill scope per agent ─────────────────────
  it("Probe C — skill bound to agent A does NOT leak into agent B's prompt (capture-spawn)", async () => {
    // 2-agent standard. Skill bound to summarizer ONLY. We capture the prompts
    // both agents receive and assert the canary appears in summarizer's prompt
    // and NOT in sensor's. RED: bleed → skill scope is global, not per-agent.
    writeFileSync(
      join(env.tempDir, "skills", "scope-canary.json"),
      JSON.stringify({
        slug: "scope-canary", domain: "advdemo",
        md: `SCOPE_FINGERPRINT_${CANARY}: this content should ONLY appear in the agent that binds the skill.`,
      }),
    );
    writeFileSync(
      join(env.tempDir, "agents", "scope-sensor.json"),
      JSON.stringify({
        slug: "scope-sensor", primitives: ["SENSE"],
        input_types: [], output_types: ["raw-note"], domain: "advdemo",
        // intentionally NO skill_slugs — must not see scope-canary
      }),
    );
    writeFileSync(
      join(env.tempDir, "agents", "scope-summarizer.json"),
      JSON.stringify({
        slug: "scope-summarizer", primitives: ["INTERPRET"],
        input_types: ["raw-note"], output_types: ["decision-note"], domain: "advdemo",
        skill_slugs: ["scope-canary"],
      }),
    );
    writeFileSync(
      join(env.tempDir, "standards", "probe-c.json"),
      JSON.stringify({
        slug: "probe-c", domain: "advdemo",
        agent_slugs: ["scope-sensor", "scope-summarizer"],
        phases: [
          { name: "sense", agent: "scope-sensor" },
          { name: "interpret", agent: "scope-summarizer" },
        ],
      }),
    );

    const g = loadGenome(env.tempDir);
    const standard = g.standards.get("probe-c")!;
    const registry = loadRegistry(g);

    const captured: { agent: string; prompt: string }[] = [];
    const runSpy = (_bin: string, args: string[]): string => {
      const idx = args.indexOf("-p");
      const prompt = idx >= 0 ? args[idx + 1]! : "";
      const agentMatch = prompt.match(/agent "([^"]+)"/);
      captured.push({ agent: agentMatch ? agentMatch[1]! : "?", prompt });
      if (prompt.includes('agent "scope-sensor"')) return JSON.stringify({ body: "raw" });
      return JSON.stringify({ decision: "OK", raw_text: "summarized" });
    };
    const invoke = makeClaudeInvoker({ registry, run: runSpy });
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();
    await runGig(standard, {}, { outputs, ledger, invoke, skills: g.skills });

    expect(captured).toHaveLength(2);
    const sensor = captured.find((c) => c.agent === "scope-sensor")!;
    const summarizer = captured.find((c) => c.agent === "scope-summarizer")!;
    expect(summarizer.prompt).toContain(`SCOPE_FINGERPRINT_${CANARY}`);
    // RED if false: sensor's prompt contains content it never declared a binding for.
    expect(
      sensor.prompt.includes(`SCOPE_FINGERPRINT_${CANARY}`),
      `Probe C HOLE: skill bound only to scope-summarizer leaked into scope-sensor's prompt.`,
    ).toBe(false);
    expect(sensor.prompt).not.toMatch(/^#\s*Skills\b/m);
  });
});
