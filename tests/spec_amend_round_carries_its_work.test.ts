// RED — an amend round is a real second attempt, with its own work in hand, whoever judged it.
//
// Slice 2 of the seat-briefing plan (contract-amend-round-runs-v1, scratchpad input of 2026-09-17;
// verified defects from the briefing debate). The EXAMINE⇄AMEND block in src/runtime.ts re-prepares
// the maker from depends_on only and pushes the failing verdict in afterwards, so:
//   O1  the maker never sees what it made last round, and re-reads everything (measured: the amend
//       round of gig 2ba9b00d started cold);
//   O3  a verify seat is found by agent primitive, so a skill-backed chair sealing `pass: false`
//       never triggers an amend;
//   O4  a record recalled from the reuse cache is written without its domain_type_version.
// The reuse no-op itself (O2) is tests/amend_round_is_not_served_from_cache.test.ts.
// Not lawful to trigger yet from outside the loop, so not pinned here: F1 amend_without_predecessor.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreInvariantFields } from "./_support/specs.js";
import { testAgent } from "./_support/agents.js";
import { createMemoryReuseStore } from "../src/reuse.js";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type DomainType, type PhaseDef, type Chair, type AgentInvoker, type AgentInvocationContext,
} from "../src";

const t = (slug: string, ext: string, version?: number): DomainType => ({
  slug, extends: ext, domain: "test", schema: { properties: { value: { type: "string" } } }, required_fields: [],
  ...(version !== undefined ? { version } : {}),
} as DomainType);

const chair = (role: string, agent_slug: string, opts: Partial<Chair> = {}): Chair => ({
  role, agent_slug, depends_on: [], input_contract: [], output_contract: [], required_skills: [], ...opts,
});

const planner = testAgent({ slug: "planner", primitives: ["PLAN"], input_types: [], output_types: ["plan-in"] });
const maker = testAgent({ slug: "maker", primitives: ["CREATE"], input_types: ["plan-in"], output_types: ["artifact"] });
const verifier = testAgent({ slug: "verifier", primitives: ["VERIFY"], input_types: ["artifact"], output_types: ["verdict"] });

function loop(max_examine_rounds: number, verify: Chair = chair("check", "verifier", { depends_on: ["make"], input_contract: ["artifact"], output_contract: ["verdict"] })) {
  return composeStandard({
    slug: "amend-carries", domain: "test", agents: [planner, maker, verifier], max_examine_rounds,
    phases: [
      { name: "plan", chairs: [chair("plan", "planner", { output_contract: ["plan-in"] })] },
      { name: "make", chairs: [chair("make", "maker", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"] })] },
      { name: "check", chairs: [verify] },
    ] as PhaseDef[],
  });
}

function stores() {
  const registry = createRegistry();
  for (const [s, e] of [["artifact", "Artifact"], ["verdict", "Verdict"], ["plan-in", "Plan"]] as const) registry.registerType(t(s, e));
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

/** Maker emits art#N; the verifier fails `fails` times, then passes. */
function band(fails: number) {
  const makerCalls: AgentInvocationContext[] = [];
  let verifies = 0;
  const invoke: AgentInvoker = (ctx) => {
    if (ctx.agent.slug === "planner") return { ...coreInvariantFields("Plan"), value: "plan" };
    if (ctx.agent.slug === "maker") {
      makerCalls.push(ctx);
      return { ...coreInvariantFields("Artifact"), value: `art#${makerCalls.length}` };
    }
    verifies++;
    return { ...coreInvariantFields("Verdict"), pass: verifies > fails, value: `verdict#${verifies}` };
  };
  return { invoke, makerCalls, verifies: () => verifies };
}

const valuesOf = (ctx: AgentInvocationContext, type: string): unknown[] =>
  ctx.inputs.filter((o) => o.domain_type === type).map((o) => (o.data as { value?: unknown }).value);

describe("an amend round carries the maker's own work", () => {
  it("O1 — the amend-round maker receives its previous round's artifact beside the failing verdict", async () => {
    const b = band(1);
    await runGig(loop(1), {}, { ...stores(), invoke: b.invoke });
    expect(b.makerCalls, "the verdict failed once, so the maker must run twice").toHaveLength(2);
    expect(valuesOf(b.makerCalls[1]!, "artifact"), "the amend round started cold: its own round-1 artifact was not among its inputs").toEqual(["art#1"]);
    expect(valuesOf(b.makerCalls[1]!, "verdict")).toEqual(["verdict#1"]);
  });

  it("I3 — across rounds, each amend holds exactly one prior artifact and one verdict, both the latest", async () => {
    const b = band(2);
    await runGig(loop(2), {}, { ...stores(), invoke: b.invoke });
    expect(b.makerCalls).toHaveLength(3);
    expect(valuesOf(b.makerCalls[2]!, "artifact"), "round 3 must carry art#2 only, not a pile of every draft").toEqual(["art#2"]);
    expect(valuesOf(b.makerCalls[2]!, "verdict"), "round 3 must carry the latest failing verdict only").toEqual(["verdict#2"]);
  });

  it("I1 (control) — a loop whose first verdict passes is still served whole from the cache on an identical re-run", async () => {
    // Green today. A fix that perturbs round-1 reuse keys goes red.
    const reuse = createMemoryReuseStore();
    const first = band(0);
    await runGig(loop(1), {}, { ...stores(), invoke: first.invoke, gig_id: "gig-i1-a", reuse });
    const second = band(0);
    await runGig(loop(1), {}, { ...stores(), invoke: second.invoke, gig_id: "gig-i1-b", reuse });
    expect(second.makerCalls.length + second.verifies(), "an identical passing run must invoke nothing").toBe(0);
  });
});

describe("a failing verdict amends whoever sealed it", () => {
  it("O3 — a skill-backed verify chair sealing pass:false triggers the amend exactly as an agent verifier does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-skill-verdict-"));
    try {
      writeFileSync(join(dir, "meta.json"), JSON.stringify({
        slug: "always-fails", version: 1, skill_type: "extraction", input_type: "artifact", output_type: "verdict",
        determinism_ratio: 1.0, permission: { tier: 0 }, description: "a deterministic verdict that never passes",
      }));
      writeFileSync(join(dir, "skill.mjs"),
        `export default function run() { return { checks: [{ method: "skill", target_ref: "artifact", result: "fail" }], pass: false, value: "skill-verdict" }; }\n`);
      const std = loop(1, { role: "check", agent_slug: "", skill_slug: "always-fails", depends_on: ["make"], input_contract: ["artifact"], output_contract: ["verdict"], required_skills: [] } as Chair);
      const b = band(0);
      await runGig(std, {}, { ...stores(), invoke: b.invoke, skill_dirs: new Map([["always-fails", dir]]) });
      expect(b.makerCalls, "a skill's failing verdict was sealed and ignored: the loop only amends for agents with the VERIFY primitive").toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a recalled record is the record it recalls", () => {
  it("O4 — a record served from the reuse cache keeps its domain_type_version and so its content_sha", async () => {
    const scout = testAgent({ slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["note"] });
    const std = composeStandard({
      slug: "recall-version", domain: "test", agents: [scout],
      phases: [{ name: "scan", chairs: [chair("scan", "scout", { output_contract: ["note"] })] }] as PhaseDef[],
    });
    const reuse = createMemoryReuseStore();
    const run = async (gig_id: string) => {
      const registry = createRegistry();
      registry.registerType(t("note", "Signal", 2));
      const outputs = createOutputStore(registry);
      await runGig(std, {}, { outputs, ledger: new MemoryLedger(), gig_id, reuse, invoke: () => ({ ...coreInvariantFields("Signal"), value: "seen" }) });
      return outputs.all().find((o) => o.domain_type === "note")!;
    };
    const original = await run("gig-o4-a");
    expect(original.domain_type_version, "fixture: the type is registered at version 2").toBe(2);
    const recalled = await run("gig-o4-b");
    expect(recalled.reused_from, "fixture: the second run must be a cache recall").toBeDefined();
    expect(recalled.domain_type_version, "the recall restamped the record's type version").toBe(2);
    expect(recalled.content_sha, "a recalled record must hash as the record it recalls").toBe(original.content_sha);
  });
});
