// genome_hash drift across builds is DIAGNOSED, not opaquely refused.
//
// The live symptom: a gig checkpointed under build A is resumed under build B. The schema
// evolved between the two versions, so `genome_hash`/`producers_sha` moved and the resume
// (correctly) refuses — a genuinely-changed genome must not be spliced. But the refusal
// handed the operator two raw 64-hex hashes and no way to know WHICH build would have matched.
//
// The fix is diagnostic honesty: the checkpoint records the engine_version that WROTE it, and
// the refusal names that build plus the action ("resume from a <version> build, or re-dispatch
// cold"). A pre-field checkpoint still refuses cleanly, naming "(engine version unrecorded)".
//
// These assertions read the THROWN MESSAGE — the actual operator-facing artifact — not a parse.

import { describe, it, expect } from "vitest";
import { runGig, ResumeRefused, RuntimeError, type AgentInvoker, type RunDeps } from "../src/runtime.js";
import {
  createRegistry, createOutputStore, MemoryLedger,
  type DomainType, type Agent, type Standard, type OutputStore, type Ledger, type Registry,
} from "../src/index.js";
import { createMemoryCheckpointStore, type GigCheckpoint } from "../src/reuse.js";
import { COLTRANE_VERSION } from "../src/version.js";
import { testAgent } from "./_support/agents.js";

const SIGNAL = { source: "fixture://rfp" };
const INTERPRETATION = { claims: [{ claim: "the fixture asserts one claim" }] };
const JUDGMENT = { criteria: ["the fixture asserts one criterion"] };

const seedT: DomainType = { slug: "seed-t", extends: "Signal", domain: "demo", schema: { properties: { s: { type: "string" } } }, required_fields: ["s"] };
const midT: DomainType = { slug: "mid-t", extends: "Interpretation", domain: "demo", schema: { properties: { m: { type: "string" } } }, required_fields: ["m"] };
const endT: DomainType = { slug: "end-t", extends: "Judgment", domain: "demo", schema: { properties: { e: { type: "string" } } }, required_fields: ["e"] };

const scout: Agent = testAgent({ slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["seed-t"], domain: "demo" });
const reader: Agent = testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: ["seed-t"], output_types: ["mid-t"], domain: "demo" });
const judge: Agent = testAgent({ slug: "judge", primitives: ["JUDGE"], input_types: ["mid-t"], output_types: ["end-t"], domain: "demo" });

function pipeline(over?: Partial<Standard>): Standard {
  return {
    slug: "line", domain: "demo", agents: [scout, reader, judge],
    phases: [
      { name: "p1", chairs: [{ role: "r1", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["seed-t"], required_skills: [] }] },
      { name: "p2", chairs: [{ role: "r2", agent_slug: "reader", depends_on: ["r1"], input_contract: ["seed-t"], output_contract: ["mid-t"], required_skills: [] }] },
      { name: "p3", chairs: [{ role: "r3", agent_slug: "judge", depends_on: ["r2"], input_contract: ["mid-t"], output_contract: ["end-t"], required_skills: [] }] },
    ],
    ...over,
  } as Standard;
}

interface Bench { outputs: OutputStore; ledger: Ledger; registry: Registry }
function bench(): Bench {
  const registry = createRegistry();
  for (const t of [seedT, midT, endT]) registry.registerType(t);
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger(), registry };
}

const GIG = "gig-drift-0001";
const invoke: AgentInvoker = (ctx) => {
  switch (ctx.agent.slug) {
    case "scout": return { s: "seeded", ...SIGNAL };
    case "reader": return { m: "read", ...INTERPRETATION };
    default: return { e: "judged", ...JUDGMENT };
  }
};
function failJudgeOnce(): AgentInvoker {
  let left = 1;
  return (ctx) => {
    if (ctx.agent.slug === "judge" && left > 0) { left--; throw new Error("stub failure in judge"); }
    return invoke(ctx);
  };
}

const run = (b: Bench, inv: AgentInvoker, extra?: Partial<RunDeps>): RunDeps =>
  ({ outputs: b.outputs, ledger: b.ledger, invoke: inv, gig_id: GIG, ...extra });

// The genome moves: the judge now also consumes the seed — a different pipeline, so genome_hash
// moves and the resume must refuse. This stands in for "the schema evolved between builds".
const movedJudge = testAgent({ slug: "judge", primitives: ["JUDGE"], input_types: ["mid-t", "seed-t"], output_types: ["end-t"], domain: "demo" });

async function refusalMessage(cpMutate: (cp: GigCheckpoint) => void): Promise<string> {
  const b = bench();
  const checkpoints = createMemoryCheckpointStore();
  // Attempt 1: phases 1-2 seal, phase 3 dies → a checkpoint is written for r1, r2.
  await expect(runGig(pipeline(), {}, run(b, failJudgeOnce(), { checkpoints }))).rejects.toThrow(RuntimeError);
  const cp = checkpoints.read(GIG);
  expect(cp, "attempt 1 must have written a checkpoint").toBeDefined();
  cpMutate(cp!);
  checkpoints.write(cp!);
  // Attempt 2: resume into the moved genome → refuse.
  let msg = "";
  try {
    await runGig(pipeline({ agents: [scout, reader, movedJudge] }), {}, run(bench(), invoke, { checkpoints, resume_from: GIG }));
  } catch (e) {
    expect(e).toBeInstanceOf(ResumeRefused);
    msg = (e as Error).message;
  }
  expect(msg, "resume must have refused").not.toBe("");
  return msg;
}

describe("genome_hash drift across builds is diagnosed with the producing version", () => {
  it("a checkpoint written by build X — the refusal names X and the re-dispatch-cold action", async () => {
    const msg = await refusalMessage((cp) => { cp.engine_version = "0.7.0"; });
    // Leads with the producing build and the action.
    expect(msg, "names the build that wrote the checkpoint").toContain("coltrane 0.7.0");
    expect(msg, "names the current build").toContain(`coltrane ${COLTRANE_VERSION}`);
    expect(msg, "gives the actionable resume path").toContain("Resume from a 0.7.0 build");
    expect(msg.toLowerCase(), "gives the cold-dispatch escape").toContain("re-dispatch cold");
    // The raw hashes still ride along for a builder.
    expect(msg, "keeps genome_hash for a builder who wants it").toMatch(/genome_hash/);
  });

  it("a pre-field checkpoint (no engine_version) refuses cleanly with '(engine version unrecorded)'", async () => {
    const msg = await refusalMessage((cp) => { delete cp.engine_version; });
    expect(msg, "does not crash and names the unrecorded case").toContain("engine version unrecorded");
    expect(msg.toLowerCase(), "still gives the cold-dispatch escape").toContain("re-dispatch cold");
    // Must NOT invent a version it does not have.
    expect(msg, "does not fabricate a producing version").not.toMatch(/written by coltrane \d/);
  });

  it("every fresh checkpoint now records the running engine_version", async () => {
    const b = bench();
    const checkpoints = createMemoryCheckpointStore();
    await expect(runGig(pipeline(), {}, run(b, failJudgeOnce(), { checkpoints }))).rejects.toThrow(RuntimeError);
    expect(checkpoints.read(GIG)?.engine_version).toBe(COLTRANE_VERSION);
  });
});
