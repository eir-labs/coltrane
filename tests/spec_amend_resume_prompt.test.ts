// RED — contract-amend-resume-prompt-v1: a RESUMED amend spawn carries ONLY what is new (decision 3
// of contract-chair-session-continuity-v1, operator 2026-09-17). Today the amend re-sends the FULL
// buildPrompt to the resumed maker, duplicating the round-one prompt the resume exists to avoid.
// These laws FAIL today, on assertions that state the contract's reason (the trimming does not exist):
//   O1  carries the failing verdict + a "this is an amend round" statement;
//   O2  re-sends none of the original prompt — no layer headers, no gig input JSON;
//   I1  is a small fraction (< 1/4) of a round-one prompt over 4KB;
//   I2  a cold amend (a resume the seam reports no session for) falls back to the FULL prompt;
//   F1  that fallback never fails the chair, and chair_complete records resume_fallback.
// Every law observes spawns through makeClaudeInvoker's injected `run` seam and runs runGig's REAL
// examine⇄amend loop — the amend re-invocation is the true callsite.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, sessionUuidFor } from "../src/claude_invoker.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type DomainType, type PhaseDef, type Chair, type GigProgressEvent,
} from "../src";

// A valid RFC 4122 UUID (any version 1–5), the shape a derived session id takes.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const after = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionOf = (args: readonly string[]): string | undefined =>
  after(args, "--session-id") ?? after(args, "--resume");

// The planner → maker → verifier amend loop, self-contained.
const registerTypes = () => {
  const r = createRegistry();
  for (const [s, e] of [["plan-in", "Plan"], ["artifact", "Artifact"], ["verdict", "Verdict"]] as const) {
    r.registerType({ slug: s, extends: e, domain: "test", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as DomainType);
  }
  return { outputs: createOutputStore(r), ledger: new MemoryLedger() };
};
const chair = (role: string, agent_slug: string, opts: Partial<Chair> = {}): Chair =>
  ({ role, agent_slug, depends_on: [], input_contract: [], output_contract: [], required_skills: [], ...opts });
const P = testAgent({ slug: "planner", primitives: ["PLAN"], input_types: [], output_types: ["plan-in"] });
const M = testAgent({ slug: "maker", primitives: ["CREATE"], input_types: ["plan-in"], output_types: ["artifact"] });
const V = testAgent({ slug: "verifier", primitives: ["VERIFY"], input_types: ["artifact"], output_types: ["verdict"] });
const loop = (n: number) => composeStandard({
  slug: "resume-carry-new", domain: "test", agents: [P, M, V], max_examine_rounds: n,
  phases: [
    { name: "plan", chairs: [chair("plan", "planner", { output_contract: ["plan-in"] })] },
    { name: "make", chairs: [chair("make", "maker", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"] })] },
    { name: "check", chairs: [chair("check", "verifier", { depends_on: ["make"], input_contract: ["artifact"], output_contract: ["verdict"] })] },
  ] as PhaseDef[],
});

// Failing-verdict content the resumed amend MUST carry (O1); gig-input slice it must NOT (O2/I1),
// but the cold fallback MUST (I2). Neither contains "amend".
const FAILCHECK = "verdict-failcheck-marker-7f3a";
const GIG_MARKER = "gig-input-marker-do-not-recarry-9c2b";
const failingVerdict = () => JSON.stringify({
  checks: [{ method: FAILCHECK, target_ref: "art", result: "fail" }], pass: false, value: "v#1",
});
const passingVerdict = () => JSON.stringify({ ...coreInvariantFields("Verdict"), pass: true, value: "v#2" });
const artifact = () => JSON.stringify({ ...coreInvariantFields("Artifact"), value: "art" });
const plan = () => JSON.stringify({ ...coreInvariantFields("Plan"), value: "plan" });
// The CLI's report that a --resume target session is gone.
const sessionLost = () => JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "No conversation found with session ID" });

interface Spawn { args: string[]; prompt: string }
const promptOf = (args: string[]): string => args[args.indexOf("-p") + 1] ?? "";

// One amend round: round-one verify fails (feeding the failing verdict in), re-verify passes.
async function runAmend(gig_id: string, gigInput: Record<string, unknown>): Promise<Spawn[]> {
  const calls: Spawn[] = [];
  let verifies = 0;
  const sidFor = (role: string) => sessionUuidFor(gig_id, role);
  const run = (_b: string, args: string[]): string => {
    calls.push({ args, prompt: promptOf(args) });
    const sess = sessionOf(args);
    if (sess === sidFor("plan")) return plan();
    if (sess === sidFor("check")) { verifies++; return verifies >= 2 ? passingVerdict() : failingVerdict(); }
    return artifact();
  };
  await runGig(loop(2), gigInput, { ...registerTypes(), gig_id, invoke: makeClaudeInvoker({ run }) });
  return calls;
}

const makerSpawns = (calls: Spawn[], gig_id: string): Spawn[] =>
  calls.filter((c) => sessionOf(c.args) === sessionUuidFor(gig_id, "make"));

describe("a resumed amend spawn carries only what is new", () => {
  it("O1 — the resumed amend prompt carries the failing verdict and says it is an amend round", async () => {
    const gid = "gig-amend-o1";
    const calls = await runAmend(gid, { marker: GIG_MARKER });
    const amend = makerSpawns(calls, gid).find((c) => c.args.includes("--resume"));
    expect(amend, "the amend loop never resumed the maker's session").toBeTruthy();
    expect(amend!.prompt, "the resumed amend dropped the failing verdict's failing check").toContain(FAILCHECK);
    expect(amend!.prompt, "the resumed amend does not convey the verdict's pass:false — the fail signal is lost")
      .toMatch(/\bpass\b/i);
    expect(amend!.prompt, "the resumed amend never states it is an amend round of the same chair")
      .toMatch(/amend round/i);
  });

  it("O2 — the resumed amend prompt re-sends none of the original prompt", async () => {
    const gid = "gig-amend-o2";
    const calls = await runAmend(gid, { marker: GIG_MARKER });
    const amend = makerSpawns(calls, gid).find((c) => c.args.includes("--resume"));
    expect(amend, "the amend loop never resumed the maker's session").toBeTruthy();
    for (const header of ["# Disposition", "# Identity", "# Context"]) {
      expect(amend!.prompt, `the resumed amend re-sends the ${header} layer the resumed conversation already holds`)
        .not.toContain(header);
    }
    expect(amend!.prompt, "the resumed amend re-sends the gig input JSON — the largest layer the resume exists to avoid re-paying")
      .not.toContain(GIG_MARKER);
  });

  it("I1 — a resumed amend prompt is under a quarter of a round-one prompt over 4KB", async () => {
    const gid = "gig-amend-i1";
    // ~6KB gig input: round one is over 4KB, under the 16KB arg limit (so the seam sees the -p positional).
    const calls = await runAmend(gid, { marker: GIG_MARKER, filler: "x".repeat(6000) });
    const spawns = makerSpawns(calls, gid);
    const roundOne = spawns.find((c) => c.args.includes("--session-id"));
    const amend = spawns.find((c) => c.args.includes("--resume"));
    expect(roundOne, "no round-one maker spawn was captured").toBeTruthy();
    expect(amend, "no resumed amend maker spawn was captured").toBeTruthy();
    expect(roundOne!.prompt.length, "round one must be over 4KB for this bound to bite").toBeGreaterThan(4096);
    expect(amend!.prompt.length,
      `the resumed amend (${amend!.prompt.length} chars) is not a small fraction of round one (${roundOne!.prompt.length}) — it re-sends the original`)
      .toBeLessThan(roundOne!.prompt.length / 4);
  });
});

// An amend whose RESUME finds no session (the seam reports "no conversation found" once). The
// contract requires a COLD fallback: fresh --session-id, FULL prompt, recorded, never failing the chair.
async function runLostAmend(gig_id: string): Promise<{ threw: boolean; calls: Spawn[]; events: GigProgressEvent[] }> {
  const calls: Spawn[] = [];
  const events: GigProgressEvent[] = [];
  let verifies = 0;
  let resumeLost = false;
  const sidFor = (role: string) => sessionUuidFor(gig_id, role);
  const run = (_b: string, args: string[]): string => {
    calls.push({ args, prompt: promptOf(args) });
    const sess = sessionOf(args);
    if (sess === sidFor("plan")) return plan();
    if (sess === sidFor("check")) { verifies++; return verifies >= 2 ? passingVerdict() : failingVerdict(); }
    // The maker. The FIRST resume finds no session; a cold fallback (any later maker spawn) seals.
    if (args.includes("--resume") && !resumeLost) { resumeLost = true; return sessionLost(); }
    return artifact();
  };
  let threw = false;
  try {
    await runGig(loop(2), { marker: GIG_MARKER }, {
      ...registerTypes(), gig_id, invoke: makeClaudeInvoker({ run }),
      onProgress: (e: GigProgressEvent) => events.push(e),
    });
  } catch { threw = true; }
  return { threw, calls, events };
}

describe("a resumed amend whose session is gone falls back cold, never failing the chair", () => {
  it("I2 — the lost-session fallback re-sends the FULL prompt on a fresh session", async () => {
    const gid = "gig-amend-i2";
    const { calls } = await runLostAmend(gid);
    const spawns = makerSpawns(calls, gid);
    const amendIdx = spawns.findIndex((c) => c.args.includes("--resume"));
    expect(amendIdx, "the amend loop never resumed the maker's session").toBeGreaterThanOrEqual(0);
    const fallback = spawns.slice(amendIdx + 1).find((c) => c.args.includes("--session-id"));
    expect(fallback, "a lost amend session did not re-run COLD with a fresh --session-id spawn").toBeTruthy();
    expect(fallback!.prompt, "the cold fallback must re-send the FULL prompt (# Identity) — nothing else carries the chair's context")
      .toContain("# Identity");
    expect(fallback!.prompt, "the cold fallback must re-send the gig input — nothing else carries it once the resume fell through")
      .toContain(GIG_MARKER);
  });

  it("F1 — the lost-session fallback never fails the chair, and chair_complete records resume_fallback", async () => {
    const gid = "gig-amend-f1";
    const { threw, events } = await runLostAmend(gid);
    expect(threw, "a resume whose session cannot be found failed the chair instead of re-running cold").toBe(false);
    const makeCompletes = events.filter(
      (e) => e.type === "chair_complete" && (e as GigProgressEvent & { role?: string }).role === "make",
    ) as Array<GigProgressEvent & Record<string, unknown>>;
    const amendComplete = makeCompletes[makeCompletes.length - 1];
    expect(amendComplete, "no chair_complete for the amended maker — the fallback never completed").toBeTruthy();
    expect(amendComplete!["resume_fallback"],
      "chair_complete does not record that the resume fell back cold — it claims a resume that never happened")
      .toBe(true);
  });
});
