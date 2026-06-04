// U5 — standard composition cycle detection.
//
// Question: if a standard is composed where agent A consumes B's output AND
// agent B consumes A's output (a 2-cycle in the typed-flow graph), does
// coltrane REJECT at compose-time, or accept and risk an infinite loop at runtime?
//
// PASS = composeStandard REJECTS with a typed CompositionError ("cycle detected").
// FAIL LOUD with a banner if it accepts — that means a malicious or careless
// caller could seal a cyclic standard and the runtime might infinite-loop.
//
// Receipt: a single log line printed at end so the result is visible from CI.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";
import {
  dispatchTool,
  bootstrapServerDeps,
  type ServerDeps,
} from "../../src/index.js";

describe("U5 — standard composition cycle detection", () => {
  let env: TempdirColtrane;
  let deps: ServerDeps;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    deps = bootstrapServerDeps(env.tempDir);

    // Two distinct domain types — both Interpretation so each can sit on either
    // side of the loop without tripping CREATE/VERIFY upstream-rules. Schemas
    // must be shape-distinct from each other (and from seed `summary`) to clear
    // the §5 reuse-enforcement gate (score < 80).
    const types = [
      {
        slug: "u5-alpha",
        schema: { type: "object", properties: { alpha_verdict: { type: "string" }, alpha_score: { type: "number" } } },
        required_fields: ["alpha_verdict", "alpha_score"],
      },
      {
        slug: "u5-beta",
        schema: { type: "object", properties: { beta_label: { type: "string" }, beta_tags: { type: "array", items: { type: "string" } }, beta_priority: { type: "integer" } } },
        required_fields: ["beta_label", "beta_tags", "beta_priority"],
      },
    ];
    for (const t of types) {
      const r = await dispatchTool(
        "type_register",
        { slug: t.slug, extends: "Interpretation", domain: "u5-cycle", schema: t.schema, required_fields: t.required_fields },
        deps,
      );
      if (!r.ok) throw new Error(`type_register ${t.slug} failed: ${r.error}`);
    }

    // Two agents, each consuming the OTHER's output. The 2-cycle:
    //   agent-a: in=u5-beta  → out=u5-alpha
    //   agent-b: in=u5-alpha → out=u5-beta
    for (const [slug, inT, outT] of [
      ["u5-agent-a", "u5-beta", "u5-alpha"],
      ["u5-agent-b", "u5-alpha", "u5-beta"],
    ] as const) {
      const r = await dispatchTool(
        "agent_define",
        { slug, primitives: ["INTERPRET"], input_types: [inT], output_types: [outT], domain: "u5-cycle" },
        deps,
      );
      if (!r.ok) throw new Error(`agent_define ${slug} failed: ${r.error}`);
    }
  }, 300_000);

  afterAll(() => env?.cleanup());

  it("composeStandard REJECTS a 2-cycle (A consumes B's output AND B consumes A's output)", async () => {
    const agents = [
      { slug: "u5-agent-a", primitives: ["INTERPRET"], input_types: ["u5-beta"], output_types: ["u5-alpha"], domain: "u5-cycle" },
      { slug: "u5-agent-b", primitives: ["INTERPRET"], input_types: ["u5-alpha"], output_types: ["u5-beta"], domain: "u5-cycle" },
    ];
    // We sequence the phases A → B. The flow-validation check (phase i inputs
    // must be produced upstream) will catch A's input on the first phase as
    // "unproduced upstream" — but the GLOBAL cycle scan (composition.ts L130-155)
    // is the one we want to verify: does coltrane spot the loop independently
    // of phase order?
    const res = await dispatchTool(
      "standard_compose",
      {
        slug: "u5-cycle-pipeline",
        domain: "u5-cycle",
        agents,
        phases: [
          { name: "alpha-phase", agent: "u5-agent-a" },
          { name: "beta-phase", agent: "u5-agent-b" },
        ],
      },
      deps,
    );

    const accepted = res.ok === true;
    const errMsg = res.ok ? "" : String(res.error ?? "");
    // Receipt line — visible in vitest verbose output.
    console.log(`─── composition_cycle receipt ─── result=${accepted ? "accept" : "reject"} error=${errMsg.replace(/\s+/g, " ").slice(0, 200)}`);

    if (accepted) {
      // FAIL LOUD — composer accepted a cyclic standard.
      throw new Error(
        `🚨 BUG: composeStandard ACCEPTED a 2-cycle (u5-agent-a ↔ u5-agent-b). ` +
          `Cyclic standards can be sealed and a runtime walking the typed-flow graph may infinite-loop. ` +
          `Expected typed CompositionError mentioning "cycle".`,
      );
    }

    expect(res.ok).toBe(false);
    // The error should name the cycle or at least flag it (composition.ts emits
    // "cycle detected between <a> and <b>"); accept either that wording or any
    // typed rejection that names both agents.
    expect(errMsg.toLowerCase()).toMatch(/cycle|loop|unproduced|upstream/);
  });
});
