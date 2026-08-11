// Dispatch preflight — the tool-grant guard.
//
// The engine already fails closed on a dead-name tool grant: the invoker resolves each chair's
// `allowed_tools` against the execution environment and throws on a grant with no provider. BUT
// that guard fires when a chair is PREPARED/INVOKED — mid-phase, after earlier chairs already ran
// and spent real model tokens. A tool defined in the work but absent from the environment must be
// impossible to START, not merely impossible to FINISH.
//
// This drives runGig directly with a call-counting invoker + the same provider registry and mcp
// server configs bootstrapServerDeps hands the invoker. RED against pre-guard code: the sensor
// chair runs (invokeCalls >= 1) before the doomed summarizer chair's grant is ever resolved.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import {
  runGig,
  PreflightToolGrantError,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type AgentInvoker,
  type DomainType,
} from "../src";
import type { Standard, Agent } from "../src";
import type { ToolProvider } from "../src/tool_providers.js";

const note: DomainType = {
  slug: "note",
  extends: "Signal",
  domain: "demo",
  schema: { properties: { text: { type: "string" } } },
  required_fields: ["text"],
};
const summary: DomainType = {
  slug: "summary",
  extends: "Interpretation",
  domain: "demo",
  schema: { properties: { gist: { type: "string" } } },
  required_fields: ["gist"],
};

function setup() {
  const registry = createRegistry();
  registry.registerType(note);
  registry.registerType(summary);
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { outputs, ledger };
}

// The environment the runtime resolves grants against — the same shape bootstrapServerDeps builds:
// an in-house engine provider bridged through the coltrane server, plus a configured mcp server.
const toolProviders = new Map<string, ToolProvider>([
  ["output_write", { tool: "output_write", kind: "in_house", server: "coltrane" }],
]);
const mcpServerConfigs: Record<string, unknown> = {
  coltrane: { command: "node", args: ["dist/src/server_entry.js"] },
  realserver: { command: "real-mcp" },
};

// A sensor chair (phase 1) that resolves fine, then a summarizer chair (phase 2). We vary only the
// summarizer's grants so the RED anchor is precise: the sensor ALWAYS resolves and would run first.
function standardWithSummarizerGrants(grants: string[]): { standard: Standard; sensor: Agent; summarizer: Agent } {
  const sensor: Agent = {
    ...TEST_BEHAVIOR, slug: "sensor", primitives: ["SENSE"], input_types: [], output_types: ["note"],
    domain: "demo", allowed_tools: ["Read"],
  } as Agent;
  const summarizer: Agent = {
    ...TEST_BEHAVIOR, slug: "summarizer", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["summary"],
    domain: "demo", allowed_tools: grants,
  } as Agent;
  const standard: Standard = {
    slug: "summarize-guarded",
    domain: "demo",
    agents: [sensor, summarizer],
    phases: [
      { name: "sense", chairs: [{ role: "sense", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] },
      { name: "interpret", chairs: [{ role: "interpret", agent_slug: "summarizer", depends_on: ["sense"], input_contract: [], output_contract: ["summary"], required_skills: [] }] },
    ],
  };
  return { standard, sensor, summarizer };
}

const makeInvoke = (counter: { n: number }): AgentInvoker => ({ agent }) => {
  counter.n++;
  if (agent.slug === "sensor") return { text: "a note", source: "test" };
  return { gist: "a summary", claims: ["c"] };
};

describe("preflight tool-grant guard: a doomed gig spends ZERO model tokens", () => {
  it("(a) refuses at t=0 when a chair grants a tool with no provider — invoke called ZERO times", async () => {
    const { outputs, ledger } = setup();
    const counter = { n: 0 };
    const { standard } = standardWithSummarizerGrants(["mcp__nonexistent__tool"]);

    await expect(
      runGig(standard, { topic: "x" }, { outputs, ledger, invoke: makeInvoke(counter), toolProviders, mcpServerConfigs }),
    ).rejects.toBeInstanceOf(PreflightToolGrantError);

    // The whole point: nothing ran. Pre-guard, the sensor chair fires before the summarizer's
    // grant is resolved and this is >= 1.
    expect(counter.n, "no chair may run when the gig is doomed at preflight").toBe(0);
    // Nothing sealed either.
    expect(outputs.all().length).toBe(0);
    expect(ledger.count()).toBe(0);
  });

  it("(b) the refusal names the chair, the agent, and the dead tool", async () => {
    const { outputs, ledger } = setup();
    const { standard } = standardWithSummarizerGrants(["mcp__nonexistent__tool"]);
    let err: PreflightToolGrantError | undefined;
    try {
      await runGig(standard, {}, { outputs, ledger, invoke: makeInvoke({ n: 0 }), toolProviders, mcpServerConfigs });
    } catch (e) {
      err = e as PreflightToolGrantError;
    }
    expect(err).toBeInstanceOf(PreflightToolGrantError);
    expect(err!.message).toMatch(/interpret/); // the chair role
    expect(err!.message).toMatch(/summarizer/); // the agent slug
    expect(err!.message).toMatch(/mcp__nonexistent__tool/); // the dead tool
    // structured, not just a string: offenders names the triple
    expect(err!.offenders).toEqual([{ chair: "interpret", agent: "summarizer", tools: ["mcp__nonexistent__tool"] }]);
  });

  it("(c) a gig whose grants all resolve runs normally (regression)", async () => {
    const { outputs, ledger } = setup();
    const counter = { n: 0 };
    const { standard } = standardWithSummarizerGrants(["output_write"]); // in-house, resolves
    const res = await runGig(standard, {}, { outputs, ledger, invoke: makeInvoke(counter), toolProviders, mcpServerConfigs });
    expect(res.status).toBe("complete");
    expect(counter.n).toBe(2);
    expect(res.outputs.map((o) => o.domain_type)).toEqual(["note", "summary"]);
  });

  it("(d) a host-builtin (Read) and a properly-configured mcp server do NOT trip the guard", async () => {
    const { outputs, ledger } = setup();
    const counter = { n: 0 };
    const { standard } = standardWithSummarizerGrants(["Read", "mcp__realserver__foo"]);
    const res = await runGig(standard, {}, { outputs, ledger, invoke: makeInvoke(counter), toolProviders, mcpServerConfigs });
    expect(res.status).toBe("complete");
    expect(counter.n).toBe(2);
  });

  it("names EVERY offending chair, not just the first", async () => {
    const { outputs, ledger } = setup();
    // Both agents grant a dead name.
    const badSensor: Agent = {
      ...TEST_BEHAVIOR, slug: "sensor", primitives: ["SENSE"], input_types: [], output_types: ["note"],
      domain: "demo", allowed_tools: ["mcp__ghosta__x"],
    } as Agent;
    const badSummarizer: Agent = {
      ...TEST_BEHAVIOR, slug: "summarizer", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["summary"],
      domain: "demo", allowed_tools: ["mcp__ghostb__y"],
    } as Agent;
    const standard: Standard = {
      slug: "summarize-guarded", domain: "demo", agents: [badSensor, badSummarizer],
      phases: [
        { name: "sense", chairs: [{ role: "sense", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] },
        { name: "interpret", chairs: [{ role: "interpret", agent_slug: "summarizer", depends_on: ["sense"], input_contract: [], output_contract: ["summary"], required_skills: [] }] },
      ],
    };
    let err: PreflightToolGrantError | undefined;
    try {
      await runGig(standard, {}, { outputs, ledger, invoke: makeInvoke({ n: 0 }), toolProviders, mcpServerConfigs });
    } catch (e) { err = e as PreflightToolGrantError; }
    expect(err!.offenders.map((o) => o.chair).sort()).toEqual(["interpret", "sense"]);
  });

  it("is OFF when the runtime is not wired with a provider environment (bare/test deps)", async () => {
    // No toolProviders / mcpServerConfigs → the preflight is skipped, exactly as the invoker's own
    // resolution stays off until a deployment wires it. A dead grant simply is not checked here.
    const { outputs, ledger } = setup();
    const counter = { n: 0 };
    const { standard } = standardWithSummarizerGrants(["mcp__nonexistent__tool"]);
    const res = await runGig(standard, {}, { outputs, ledger, invoke: makeInvoke(counter) });
    expect(res.status).toBe("complete"); // ran to completion — guard not engaged
    expect(counter.n).toBe(2);
  });
});
