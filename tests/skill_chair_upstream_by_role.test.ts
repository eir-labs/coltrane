// RED-first — a skill chair receives its upstream outputs INDIVIDUALLY, by role.
//
// THE DEFECT. runtime.ts builds a skill chair's input as `Object.assign({}, ...inputs.map(i => i.data))`.
// Two upstream chairs sealing the SAME domain type — two adjudicators grading one line, two judges,
// two scouts — collapse to one object: the later record's keys overwrite the earlier's, silently,
// and the skill cannot even tell it happened. Measured live (cognition bench, debate school, gig
// fce34aeb, 2026-09-16): two Opus adjudicators DISAGREED (refuted vs survived) and the fold skill
// received exactly one of them, so the parliament reading it exists to compute was null. The
// runtime, not the models, produced "one voice in coats" — the failure the D1 law names.
//
// An absence that is not an error, which is what makes it dangerous: the merge SUCCEEDS.
//
// THE CONTRACT. The merge stays (every existing skill reads it). ADDITIONALLY the runner calls
// `run(input, context)` with `context.upstream = [{role, domain_type, data}, ...]` — one entry per
// upstream output in dependency order — so a skill that needs N same-type inputs can have them, and
// a skill that never looks at `context` is byte-identical to before.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  defineAgent,
  composeStandard,
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type Chair,
  type PhaseDef,
  type AgentInvoker,
} from "../src";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const UPSTREAM_ECHO = join(REPO_ROOT, "tests/_support/skills/upstream-echo");

function skillChair(role: string, skill_slug: string, opts: Partial<Chair> = {}): Chair {
  return {
    role, agent_slug: "", skill_slug,
    depends_on: opts.depends_on ?? [],
    input_contract: opts.input_contract ?? [],
    output_contract: opts.output_contract ?? ["Signal"],
    required_skills: [],
  };
}

function twoJudgesThenFold() {
  const judge = defineAgent({ ...TEST_BEHAVIOR,
    slug: "judge", primitives: ["JUDGE"], input_types: ["Signal"], output_types: ["Judgment"], skill_slugs: [],
  });
  const std = composeStandard({
    slug: "two-judges-one-fold",
    domain: "test",
    agents: [judge],
    input_types: ["Signal"],
    phases: [
      { name: "judge", chairs: [
        { role: "judge-a", agent_slug: "judge", depends_on: [], input_contract: ["Signal"], output_contract: ["Judgment"], required_skills: [] },
        { role: "judge-b", agent_slug: "judge", depends_on: [], input_contract: ["Signal"], output_contract: ["Judgment"], required_skills: [] },
      ] } as PhaseDef,
      { name: "fold", chairs: [
        skillChair("fold", "upstream-echo", { depends_on: ["judge-a", "judge-b"], input_contract: ["Judgment"], output_contract: ["Signal"] }),
      ] } as PhaseDef,
    ],
  });
  const registry = createRegistry();
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { std, outputs, ledger };
}

describe("a skill chair receives its upstream outputs by role, not only as one merged object", () => {
  it("RED: two same-type upstream outputs reach the skill as TWO entries in context.upstream", async () => {
    const { std, outputs, ledger } = twoJudgesThenFold();
    let n = 0;
    const invoke: AgentInvoker = () => ({ value: `verdict-${++n}`, criteria: ["c"], verdicts: [], reasoning_chain: [] });
    const res = await runGig(std, { Signal: { value: "seed" } }, {
      outputs, ledger, invoke, skill_dirs: new Map([["upstream-echo", UPSTREAM_ECHO]]),
    });
    expect(res.status).toBe("complete");
    const fold = res.outputs.find((o) => o.from_role === "fold")!;
    expect(fold, "the fold chair sealed nothing").toBeTruthy();
    // THE CLAIM. Today this is 0: the runner calls run(input) with no context at all.
    expect(fold.data.upstream_count, "the skill saw only the merge — two judges collapsed to one").toBe(2);
    expect(fold.data.upstream_roles).toEqual(["judge-a", "judge-b"]);
    expect(fold.data.upstream_values).toEqual(["verdict-1", "verdict-2"]);
  });

  it("the merged input is unchanged — a skill that ignores context is byte-identical to before", async () => {
    const { std, outputs, ledger } = twoJudgesThenFold();
    let n = 0;
    const invoke: AgentInvoker = () => ({ value: `verdict-${++n}`, criteria: ["c"], verdicts: [], reasoning_chain: [] });
    const res = await runGig(std, { Signal: { value: "seed" } }, {
      outputs, ledger, invoke, skill_dirs: new Map([["upstream-echo", UPSTREAM_ECHO]]),
    });
    const fold = res.outputs.find((o) => o.from_role === "fold")!;
    // the merge still carries the later judge's keys — one `value`, as before
    expect(fold.data.merged_keys).toContain("value");
  });

  it("CONTROL: a skill with NO upstream (root chair) gets an empty context.upstream, not a crash", async () => {
    const std = composeStandard({
      slug: "echo-root", domain: "test", agents: [],
      phases: [{ name: "compute", chairs: [skillChair("echo", "upstream-echo")] } as PhaseDef],
    });
    const registry = createRegistry();
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();
    const res = await runGig(std, { value: 1 }, { outputs, ledger, invoke: () => ({}), skill_dirs: new Map([["upstream-echo", UPSTREAM_ECHO]]) });
    expect(res.status).toBe("complete");
    expect(res.outputs[0]!.data.upstream_count).toBe(0);
  });
});

import { runSkillFixtures } from "../src/skill_subprocess.js";

describe("a fixture can pre-register the per-role path", () => {
  it("runSkillFixtures passes fixture.context as run()'s second argument", () => {
    const report = runSkillFixtures(UPSTREAM_ECHO);
    const withCtx = report.results.find((r) => r.id === "with-context");
    expect(withCtx, "with-context fixture missing").toBeTruthy();
    expect(withCtx!.passed, `with-context fixture failed: ${JSON.stringify(withCtx)}`).toBe(true);
    expect(report.results.find((r) => r.id === "basic")!.passed, "legacy fixture regressed").toBe(true);
    expect(report.deterministic).toBe(true);
  });
});
