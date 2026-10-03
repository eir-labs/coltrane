// A SEAT IS TOLD ITS TREES — the trees the room furnished reach every seat, named in its prompt.
// (spec: wiki spec.one-write-path.a-room-furnishes-its-reach; founder's ruling R38, 3 Oct 2026)
//
// Measured on 3 Oct: Vör's lineage pass ran with coltrane-ui not mounted and john's internal read
// "dereferenced zero files: completeness 0.05". When a room furnishes four trees, a seat that is not
// told where they sit will read none of them either. So the drain's mounts (RunDeps.mounts, from
// prepareWorkspaces) reach every seat's invocation context, and buildPrompt names each one with its
// path, marking the tree a change lands in when there is one.
//
//   T1  buildPrompt names each mounted tree with its path, and marks the cwd tree
//   T2  no mounts → no "# Trees" layer: the prompt is byte-identical to before (every existing
//       prompt law stays exact)
//   T3  the runtime threads RunDeps.mounts onto EVERY seat's context (two chairs, both told)
//   T4  a reading run (no cwd tree) is told its working directory is the shared root
import { describe, it, expect } from "vitest";
import { buildPrompt } from "../src/claude_invoker.js";
import {
  runGig, createRegistry, createOutputStore, MemoryLedger,
  type AgentInvocationContext, type AgentInvoker, type DomainType, type Standard,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = { slug: "tree-note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const reader = testAgent({ slug: "tree-reader", primitives: ["SENSE"], input_types: [], output_types: ["tree-note"], domain: "demo" });
const two: Standard = {
  slug: "two-readers",
  domain: "demo",
  agents: [reader],
  phases: [{ name: "read", chairs: [
    { role: "read-a", agent_slug: "tree-reader", depends_on: [], input_contract: [], output_contract: ["tree-note"], required_skills: [] },
    { role: "read-b", agent_slug: "tree-reader", depends_on: [], input_contract: [], output_contract: ["tree-note"], required_skills: [] },
  ] }],
} as Standard;

const MOUNTS = [
  { repoUrl: "https://github.com/eir-labs/coltrane", dir: "/tmp/ws/coltrane", cwd: false },
  { repoUrl: "https://github.com/eir-labs/coltrane-ui", dir: "/tmp/ws/coltrane-ui", cwd: true },
];

const ctxWith = (extra: Partial<AgentInvocationContext>): AgentInvocationContext => ({
  agent: reader, phase: "read", role: "read-a", inputs: [], gig_input: { goal: "g" }, ...extra,
} as AgentInvocationContext);

describe("a seat is told its trees", () => {
  it("T1 buildPrompt names each mounted tree with its path, and marks the tree a change lands in", () => {
    const p = buildPrompt(ctxWith({ mounts: MOUNTS }));
    expect(p).toContain("# Trees");
    expect(p).toContain("https://github.com/eir-labs/coltrane → /tmp/ws/coltrane");
    expect(p).toContain("https://github.com/eir-labs/coltrane-ui → /tmp/ws/coltrane-ui  (your working directory; the tree a change lands in)");
  });

  it("T2 no mounts → no Trees layer; the prompt is byte-identical to a context without the field", () => {
    const without = buildPrompt(ctxWith({}));
    const empty = buildPrompt(ctxWith({ mounts: [] }));
    expect(without).not.toContain("# Trees");
    expect(empty, "an empty mounts list must change nothing").toBe(without);
  });

  it("T3 the runtime threads RunDeps.mounts onto EVERY seat's context", async () => {
    const registry = createRegistry();
    registry.registerType(note);
    const seen: AgentInvocationContext[] = [];
    const invoke: AgentInvoker = (ctx) => { seen.push(ctx); return { t: "read", source: "fixture://demo/tree" }; };
    await runGig(two, { goal: "read" }, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, mounts: MOUNTS });
    expect(seen.length).toBe(2);
    for (const c of seen) expect(c.mounts, `seat ${c.role} was not told its trees`).toEqual(MOUNTS);
  });

  it("T4 a reading run with no cwd tree is told its working directory is the shared root", () => {
    const p = buildPrompt(ctxWith({ mounts: MOUNTS.map((m) => ({ ...m, cwd: false })) }));
    expect(p).toContain("None of these is a working tree for changes");
    expect(p).not.toContain("the tree a change lands in");
  });
});
