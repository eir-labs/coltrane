// RED — a chair's ROLE reaches the prompt of the seat that holds it.
//
// THE DEFECT. runGig builds each invocation's context with the phase, the agent, the inputs and the
// gig payload, but never the chair's role (src/runtime.ts, the deps.invoke call). buildPrompt has no
// role to render. So two chairs in one phase that seat the SAME agent receive byte-identical prompts,
// and any division of labour a standard declares between them exists only in the role names.
//
// MEASURED on 2026-09-16. spec-review-and-sequence-v0 seats `john` three times in `read-the-red` to
// split one large reading across three parallel seats. In gig c539c33b all three opened the same files
// in the same order (the spec, the law file, the fixtures, completions_invoker.ts, the same runtime.ts
// ranges, the same ratchets) and sealed three overlapping change-contexts totalling ~79KB. The split
// the standard advertises did not happen, and the reading was paid for three times.
import { describe, it, expect } from "vitest";
import {
  buildPrompt,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  runGig,
  type AgentInvocationContext,
  type AgentInvoker,
  type DomainType,
  type Standard,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = {
  slug: "reading-note",
  extends: "Signal",
  domain: "demo",
  schema: { properties: { t: { type: "string" } } },
  required_fields: ["t"],
};

const reader = testAgent({ slug: "reader", primitives: ["SENSE"], input_types: [], output_types: ["reading-note"], domain: "demo" });

const twoReaders: Standard = {
  slug: "split-reading",
  domain: "demo",
  agents: [reader],
  phases: [
    {
      name: "read",
      chairs: [
        { role: "read-the-argument", agent_slug: "reader", depends_on: [], input_contract: [], output_contract: ["reading-note"], required_skills: [] },
        { role: "read-the-laws", agent_slug: "reader", depends_on: [], input_contract: [], output_contract: ["reading-note"], required_skills: [] },
      ],
    },
  ],
} as Standard;

async function capturedContexts(): Promise<AgentInvocationContext[]> {
  const registry = createRegistry();
  registry.registerType(note);
  const seen: AgentInvocationContext[] = [];
  const invoke: AgentInvoker = (ctx) => {
    seen.push(ctx);
    return { t: "read", source: "fixture://demo/reading" };
  };
  await runGig(twoReaders, { goal: "read the spec" }, {
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    invoke,
  });
  return seen;
}

describe("a chair's role reaches the seat that holds it", () => {
  it("LAW 1 — the invocation context names the chair's role", async () => {
    const seen = await capturedContexts();
    expect(seen).toHaveLength(2);
    const roles = seen.map((c) => (c as AgentInvocationContext & { role?: string }).role).sort();
    expect(roles, "the runtime never told the invoker which chair it is invoking").toEqual([
      "read-the-argument",
      "read-the-laws",
    ]);
  });

  it("LAW 2 — two chairs seating the same agent in one phase do not receive identical prompts", async () => {
    const seen = await capturedContexts();
    expect(seen).toHaveLength(2);
    const prompts = seen.map((c) => buildPrompt(c));
    expect(prompts[0], "both chairs received the same prompt — the split exists only in role names").not.toBe(prompts[1]);
  });

  it("LAW 3 — each prompt names its own chair and not the other", async () => {
    const seen = await capturedContexts();
    for (const ctx of seen) {
      const own = (ctx as AgentInvocationContext & { role?: string }).role ?? "";
      const other = own === "read-the-argument" ? "read-the-laws" : "read-the-argument";
      const prompt = buildPrompt(ctx);
      expect(own, "the context carries no role to render").not.toBe("");
      expect(prompt, `the prompt does not name its chair "${own}"`).toContain(own);
      expect(prompt, `the prompt for "${own}" names the other chair`).not.toContain(other);
    }
  });
});
