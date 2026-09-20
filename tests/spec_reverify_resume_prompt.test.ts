// RED — contract-reverify-carries-amendment-v1 (operator eugene, 2026-09-19): a resumed re-verify
// CARRIES every chair input that is new or amended since the round being re-judged, and NOTHING the
// resumed conversation already holds. It supersedes the O1/I1 of contract-reverify-resume-prompt-v1,
// whose trim was too aggressive: it dropped the amended records ENTIRELY, so a tool-less verify seat —
// one whose evidence arrives as sealed inputs and which grants no tool that can reach a working tree —
// re-judged round one blind (measured live: session-review-v0's round-two verdict cited round 1 three
// times and wrote 'amendment unreadable' while its own input_refs named the amended record).
//
// THE CONTRACT. buildReverifyResumePrompt (src/claude_invoker.ts:356) must carry the AMENDED set: the
// current chair inputs whose content_sha is ABSENT from the verify chair's own round-one sealed record's
// input_shas. The runtime computes that set at chair prep (prepareChair, src/runtime.ts:2472) from
// engine-stamped content_sha / input_shas only, and threads it onto the invocation context; the prompt
// renders what it is handed and computes nothing. It carries NOTHING already covered (a current input
// whose sha is in round one's input_shas is not re-sent — the trim the prior contract bought is kept).
// The working-tree instruction is sent ONLY to a verify seat whose effective tool set contains a tool
// that can read the tree; a seat granted none is told the carried records are its evidence and that it
// holds no tool reaching the tree. That tree-reading predicate lives in ONE named home in
// src/tool_providers.ts, reachable only through an accessor (the discipline HOST_BUILTINS keeps).
//
// THE LAWS (contract-reverify-carries-amendment-v1). Each drives runGig's REAL examine⇄amend loop with
// a verifier that fails once, and reads the prompt the re-verify spawn actually receives through
// makeClaudeInvoker's injected `run` seam — the true re-verify callsite. The maker re-seals its
// artifact under the SAME record id but a CHANGED content_sha, so identity for the amended comparison
// is the content_sha, never the record id (F3).
//   I1  when every current input is already covered by round one's input_shas, the re-verify carries NO
//       amended-records section; when one input is amended, the section appears;
//   I2  a two-input re-verify carries the AMENDED record's payload and DROPS the one already covered;
//   I3  with exactly one input amended the re-verify still stays under HALF a round-one prompt over 4KB;
//   I4  the 'current working tree' instruction reaches a tree-reading verify seat only — a tool-less
//       seat gets the carried-evidence statement in its place;
//   I5  the stateless chat-completions door STILL builds the FULL prompt on a keep-prompt resume,
//       carrying seat identity and every gig input (the kept O2 law of contract-reverify-resume-prompt-v1);
//   F2  a re-verify whose --resume finds no conversation falls back COLD (full prompt, fresh session),
//       records resume_fallback, and never fails the chair (the kept F1 law, unchanged).
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, sessionUuidFor } from "../src/claude_invoker.js";
import { makeCompletionsInvoker } from "../src/completions_invoker.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type DomainType, type PhaseDef, type Chair, type GigProgressEvent,
} from "../src";

const after = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionOf = (args: readonly string[]): string | undefined =>
  after(args, "--session-id") ?? after(args, "--resume");
const promptOf = (args: readonly string[]): string => args[args.indexOf("-p") + 1] ?? "";

// The verify seat's identity marker: it is what the FULL prompt carries and the stateless completions
// door must keep (I5) — the same signal LAW 6 routes on.
const VERIFY_ID = "SEAT-VERIFY-4f1a";
const PLAN_ID = "SEAT-PLAN-1a2b";
const MAKE_ID = "SEAT-MAKE-9d8c";
// Failing-verdict content; a gig-input slice the resumed re-verify must NOT re-carry.
const FAILCHECK = "reverify-failcheck-marker-8b2d";
const GIG_MARKER = "gig-input-marker-reverify-do-not-recarry-3e9c";
// A distinctive slice of the AMENDED artifact — present in the re-verify only once the amended record
// is carried; and of the UNCHANGED plan input — never carried, its sha already in round one's input_shas.
const AMEND_MARKER = "artifact-amended-payload-marker-7c1f";
const PLAN_INPUT_MARKER = "plan-input-payload-marker-2a4e";
// A ~6KB gig input: round one is over 4KB (so I3 bites), under the 16KB arg limit (so the seam sees the
// -p positional rather than a stdin-delivered prompt).
const bigGigInput = (): Record<string, unknown> => ({ marker: GIG_MARKER, filler: "x".repeat(6000) });

const failingVerdict = (): string =>
  JSON.stringify({ checks: [{ method: FAILCHECK, target_ref: "art", result: "fail" }], pass: false, value: "v#1" });
const passingVerdict = (): string => JSON.stringify({ ...coreInvariantFields("Verdict"), pass: true, value: "v#2" });
const artifact = (): string => JSON.stringify({ ...coreInvariantFields("Artifact"), value: "art" });
const plan = (): string => JSON.stringify({ ...coreInvariantFields("Plan"), value: "plan" });
// Round-one vs amended artifact: SAME record id (role "make"), DIFFERENT content (so a DIFFERENT
// content_sha). The amended one carries a distinctive marker the re-verify must render (I2/I3/F3).
const artifactV1 = (): string => JSON.stringify({ ...coreInvariantFields("Artifact"), value: "art-v1" });
const artifactV2 = (): string => JSON.stringify({ ...coreInvariantFields("Artifact"), value: `art-v2-${AMEND_MARKER}` });
// The plan input the verify chair ALSO consumes: produced once (the planner is not a maker, so it never
// re-runs), so its content_sha is stable across rounds — it stays COVERED and must never be carried.
const planInput = (): string => JSON.stringify({ ...coreInvariantFields("Plan"), value: `plan-${PLAN_INPUT_MARKER}` });
// The CLI's report that a --resume target session is gone.
const sessionLost = (): string =>
  JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "No conversation found with session ID" });

// A self-contained plan → make → check examine loop, its three seats carrying distinct identity markers.
const makeStore = () => {
  const registry = createRegistry();
  for (const [s, e] of [["plan-in", "Plan"], ["artifact", "Artifact"], ["verdict", "Verdict"]] as const) {
    registry.registerType({ slug: s, extends: e, domain: "test", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as DomainType);
  }
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
};
const chair = (role: string, agent_slug: string, opts: Partial<Chair> = {}): Chair =>
  ({ role, agent_slug, depends_on: [], input_contract: [], output_contract: [], required_skills: [], ...opts });
const P = testAgent({ slug: "planner", primitives: ["PLAN"], input_types: [], output_types: ["plan-in"], identity: `${PLAN_ID} — you plan the work.`, model_tier: "standard" });
const M = testAgent({ slug: "maker", primitives: ["CREATE"], input_types: ["plan-in"], output_types: ["artifact"], identity: `${MAKE_ID} — you build the artifact.`, model_tier: "standard" });
const V = testAgent({ slug: "verifier", primitives: ["VERIFY"], input_types: ["artifact"], output_types: ["verdict"], identity: `${VERIFY_ID} — you rule on the maker's artifact.`, model_tier: "standard" });
const loop = (n: number) => composeStandard({
  slug: "reverify-resume-prompt", domain: "test", agents: [P, M, V], max_examine_rounds: n,
  phases: [
    { name: "plan", chairs: [chair("plan", "planner", { output_contract: ["plan-in"] })] },
    { name: "make", chairs: [chair("make", "maker", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"] })] },
    { name: "check", chairs: [chair("check", "verifier", { depends_on: ["make"], input_contract: ["artifact"], output_contract: ["verdict"] })] },
  ] as PhaseDef[],
});

// A verify seat granted a specific tool set — the I4 lever. `allowed_tools` reaches
// buildReverifyResumePrompt through ctx.agent, where the tree-reading predicate reads it.
const Vtool = (tools: string[]) => testAgent({
  slug: "verifier", primitives: ["VERIFY"], input_types: ["artifact"], output_types: ["verdict"],
  identity: `${VERIFY_ID} — you rule on the maker's artifact.`, model_tier: "standard", allowed_tools: tools,
});
const loopTool = (tools: string[], n: number) => composeStandard({
  slug: "reverify-resume-prompt", domain: "test", agents: [P, M, Vtool(tools)], max_examine_rounds: n,
  phases: [
    { name: "plan", chairs: [chair("plan", "planner", { output_contract: ["plan-in"] })] },
    { name: "make", chairs: [chair("make", "maker", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"] })] },
    { name: "check", chairs: [chair("check", "verifier", { depends_on: ["make"], input_contract: ["artifact"], output_contract: ["verdict"] })] },
  ] as PhaseDef[],
});

// A TWO-INPUT verify chair: it consumes BOTH the maker's artifact AND the planner's plan-in. When the
// maker amends, only the artifact's content_sha changes; the plan's is stable, so the amended set is
// exactly {artifact} — the clean I2 fixture (amended present, covered absent).
const Vtwo = testAgent({ slug: "verifier", primitives: ["VERIFY"], input_types: ["artifact", "plan-in"], output_types: ["verdict"], identity: `${VERIFY_ID} — you rule on the maker's artifact.`, model_tier: "standard" });
const twoInputLoop = (n: number) => composeStandard({
  slug: "reverify-resume-prompt", domain: "test", agents: [P, M, Vtwo], max_examine_rounds: n,
  phases: [
    { name: "plan", chairs: [chair("plan", "planner", { output_contract: ["plan-in"] })] },
    { name: "make", chairs: [chair("make", "maker", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"] })] },
    { name: "check", chairs: [chair("check", "verifier", { depends_on: ["make", "plan"], input_contract: ["artifact", "plan-in"], output_contract: ["verdict"] })] },
  ] as PhaseDef[],
});

interface Spawn { args: string[]; prompt: string }

type Std = ReturnType<typeof loop>;

// One amend round through the CLAUDE door for the CARRYING laws: round-one verify fails, the maker
// amends, the re-verify (a --resume) passes. When `amend` is set the maker re-seals a DIFFERENT
// artifact on its resumed round (a changed content_sha under the same record id); otherwise it re-seals
// the identical artifact, so every re-verify input stays covered.
async function carryCalls(
  gig_id: string,
  std: Std,
  gigInput: Record<string, unknown>,
  opts: { amend?: boolean } = {},
): Promise<Spawn[]> {
  const { outputs, ledger } = makeStore();
  const calls: Spawn[] = [];
  let verifyOpens = 0;
  const sidFor = (role: string) => sessionUuidFor(gig_id, role);
  const run = (_b: string, args: string[]): string => {
    calls.push({ args, prompt: promptOf(args) });
    const sess = sessionOf(args);
    if (sess === sidFor("plan")) return planInput();
    if (sess === sidFor("check")) {
      if (args.includes("--resume")) return passingVerdict();
      verifyOpens++;
      return verifyOpens >= 2 ? passingVerdict() : failingVerdict();
    }
    // the maker: round one opens (--session-id) with v1; its amend RESUMES (--resume) with v2.
    if (sess === sidFor("make")) {
      return opts.amend && args.includes("--resume") ? artifactV2() : artifactV1();
    }
    return artifactV1();
  };
  await runGig(std, gigInput, { outputs, ledger, gig_id, invoke: makeClaudeInvoker({ run }) });
  return calls;
}

// One amend round through the CLAUDE door for the KEPT F2 law (the original F1 fixture, unchanged): the
// re-verify's --resume finds no conversation once when `loseReverify` is set, and the chair falls back cold.
async function runReverifyClaude(
  gig_id: string,
  gigInput: Record<string, unknown>,
  opts: { loseReverify?: boolean } = {},
): Promise<{ calls: Spawn[]; events: GigProgressEvent[]; threw: boolean }> {
  const { outputs, ledger } = makeStore();
  const calls: Spawn[] = [];
  const events: GigProgressEvent[] = [];
  let verifyOpens = 0;
  let reverifyLost = false;
  const sidFor = (role: string) => sessionUuidFor(gig_id, role);
  const run = (_b: string, args: string[]): string => {
    calls.push({ args, prompt: promptOf(args) });
    const sess = sessionOf(args);
    if (sess === sidFor("plan")) return plan();
    if (sess === sidFor("check")) {
      // The re-verify RESUMES (--resume). Lose it once when asked (F2); otherwise it passes.
      if (args.includes("--resume")) {
        if (opts.loseReverify && !reverifyLost) { reverifyLost = true; return sessionLost(); }
        return passingVerdict();
      }
      // --session-id opens: round one (fail), then, on the F2 path, the cold fallback (pass).
      verifyOpens++;
      return verifyOpens >= 2 ? passingVerdict() : failingVerdict();
    }
    return artifact(); // the maker: round one, and its resumed amend
  };
  let threw = false;
  try {
    await runGig(loop(2), gigInput, {
      outputs, ledger, gig_id, invoke: makeClaudeInvoker({ run }),
      onProgress: (e: GigProgressEvent) => events.push(e),
    });
  } catch { threw = true; }
  return { calls, events, threw };
}

const verifySpawns = (calls: Spawn[], gig_id: string): Spawn[] =>
  calls.filter((c) => sessionOf(c.args) === sessionUuidFor(gig_id, "check"));
const reverifyOf = (calls: Spawn[], gig_id: string): Spawn | undefined =>
  verifySpawns(calls, gig_id).find((c) => c.args.includes("--resume"));

describe("a resumed re-verify carries exactly the amended chair inputs, and nothing already covered", () => {
  it("I1 — no amended-records section when every current input is covered; the section appears when one is amended", async () => {
    // COVERED: the maker's amend reproduces the SAME artifact, so every re-verify input hashes to a sha
    // the round-one verdict's input_shas already hold — the amended set is empty.
    const covered = await carryCalls("gig-carry-i1-covered", loop(2), bigGigInput(), { amend: false });
    const rvCovered = reverifyOf(covered, "gig-carry-i1-covered");
    expect(rvCovered, "the examine loop never resumed the verifier for a re-verify").toBeTruthy();
    expect(rvCovered!.prompt, "a re-verify whose inputs are ALL covered still emits an amended-records section — it over-sends a record round one already holds")
      .not.toMatch(/#\s*Amended records/i);
    // AMENDED: one input changed → the section MUST appear. RED today: no carry mechanism exists, so no
    // section is ever emitted.
    const amended = await carryCalls("gig-carry-i1-amended", loop(2), bigGigInput(), { amend: true });
    const rvAmended = reverifyOf(amended, "gig-carry-i1-amended");
    expect(rvAmended, "the examine loop never resumed the verifier for a re-verify").toBeTruthy();
    expect(rvAmended!.prompt, "an amended input produced NO amended-records section — the carry mechanism does not exist yet, so the seat re-judges round one blind")
      .toMatch(/#\s*Amended records/i);
  });

  it("I2 — a two-input re-verify carries the amended record's payload and drops the one already covered", async () => {
    // The verify chair consumes artifact + plan-in. The maker amends (artifact's content_sha changes,
    // under the SAME record id — identity is the content_sha, never the record id: F3); the plan is
    // untouched, so its sha is still in round one's input_shas and it stays covered.
    const calls = await carryCalls("gig-carry-i2", twoInputLoop(2), bigGigInput(), { amend: true });
    const rv = reverifyOf(calls, "gig-carry-i2");
    expect(rv, "the examine loop never resumed the verifier for a re-verify").toBeTruthy();
    expect(rv!.prompt, "the re-verify does NOT carry the AMENDED artifact's payload — a resumed seat re-judges round one blind, exactly the live session-review-v0 defect")
      .toContain(AMEND_MARKER);
    expect(rv!.prompt, "the re-verify re-sends the UNCHANGED plan input whose content_sha round one already holds — the trim the prior contract bought is lost")
      .not.toContain(PLAN_INPUT_MARKER);
  });

  it("I3 — with one input amended the re-verify carries it yet stays under half a round-one prompt over 4KB", async () => {
    const calls = await carryCalls("gig-carry-i3", loop(2), bigGigInput(), { amend: true });
    const spawns = verifySpawns(calls, "gig-carry-i3");
    const roundOne = spawns.find((c) => c.args.includes("--session-id"));
    const rv = spawns.find((c) => c.args.includes("--resume"));
    expect(roundOne, "no round-one verifier spawn was captured").toBeTruthy();
    expect(rv, "no resumed re-verify spawn was captured").toBeTruthy();
    // The bound is meaningful ONLY when the amendment is actually carried — otherwise "small" is small
    // because nothing was sent, not because the trim held. RED today: the amended payload is not carried.
    expect(rv!.prompt, "the re-verify carries none of the amended payload — the bound would pass for the wrong reason")
      .toContain(AMEND_MARKER);
    expect(roundOne!.prompt.length, "round one must be over 4KB for this bound to bite").toBeGreaterThan(4096);
    expect(rv!.prompt.length,
      `the re-verify (${rv!.prompt.length} chars) carrying one amended input is not under half of round one (${roundOne!.prompt.length}) — it re-sends the verifier's whole round-one prompt`)
      .toBeLessThan(roundOne!.prompt.length / 2);
  });

  it("I4 — the working-tree instruction reaches a tree-reading verify seat only; a tool-less seat gets the carried-evidence statement instead", async () => {
    const withRead = await carryCalls("gig-carry-i4-read", loopTool(["Read"], 2), bigGigInput(), { amend: true });
    const withNone = await carryCalls("gig-carry-i4-none", loopTool([], 2), bigGigInput(), { amend: true });
    const rvRead = reverifyOf(withRead, "gig-carry-i4-read");
    const rvNone = reverifyOf(withNone, "gig-carry-i4-none");
    expect(rvRead, "no resumed re-verify for the Read-granted seat").toBeTruthy();
    expect(rvNone, "no resumed re-verify for the tool-less seat").toBeTruthy();
    // A seat that CAN reach the tree is told to re-derive its verdict from it.
    expect(rvRead!.prompt, "the tree-reading (Read-granted) seat was NOT told to re-derive from the current working tree")
      .toMatch(/current working tree/i);
    // A seat that CANNOT is told the carried records are its evidence — and is NOT told to read a tree it
    // cannot reach. RED today: buildReverifyResumePrompt sends the 'current working tree' line to EVERY
    // seat, tool-less or not (the exact blinding the change request measured).
    expect(rvNone!.prompt, "the tool-less seat is STILL told to read the CURRENT WORKING TREE it holds no tool to reach")
      .not.toMatch(/current working tree/i);
    expect(rvNone!.prompt, "the tool-less seat is not told the carried records are its evidence — it is left with no stated source to rule from")
      .toMatch(/carried records are your evidence/i);
  });
});

// One amend round through the CHAT-COMPLETIONS door, observed via the injected `fetchFn` seam. The seat
// each spawn belongs to is read from the seat identity IN its prompt (as LAW 6 routes): the verifier
// fails on its first look, passes on the re-verify.
async function completionsVerifyPrompts(gig_id: string, gigInput: Record<string, unknown>): Promise<string[]> {
  const { registry, outputs, ledger } = makeStore();
  const prompts: string[] = [];
  let verifies = 0;
  const fetchFn = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const prompt = body.messages.map((m) => m.content).join("\n");
    prompts.push(prompt);
    let obj: Record<string, unknown>;
    if (prompt.includes(VERIFY_ID)) {
      verifies++;
      obj = verifies >= 2 ? { ...coreInvariantFields("Verdict"), pass: true, value: "v#2" }
                          : { checks: [{ method: FAILCHECK, target_ref: "art", result: "fail" }], pass: false, value: "v#1" };
    } else if (prompt.includes(PLAN_ID)) {
      obj = { ...coreInvariantFields("Plan"), value: "plan" };
    } else {
      obj = { ...coreInvariantFields("Artifact"), value: "art" };
    }
    const reply = {
      choices: [{ message: { role: "assistant", content: JSON.stringify(obj) }, finish_reason: "stop" }],
      model: "served", usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) };
  }) as unknown as typeof fetch;
  const invoke = makeCompletionsInvoker({ baseUrl: "https://completions.test/v1", apiKey: "k", registry, tierMap: { standard: "served-std" }, fetchFn });
  await runGig(loop(2), gigInput, { outputs, ledger, gig_id, invoke });
  return prompts.filter((p) => p.includes(VERIFY_ID));
}

describe("the stateless chat-completions re-verify keeps the full prompt the Claude door trims", () => {
  it("I5 — the completions re-verify carries the seat identity + gig input, and diverges from the trimmed Claude re-verify", async () => {
    const gigInput = bigGigInput();
    const vprompts = await completionsVerifyPrompts("gig-reverify-i5", gigInput);
    expect(vprompts.length, "the completions examine loop did not re-verify after the failing verdict").toBe(2);
    const reverifyCompletions = vprompts[1]!;
    // The stateless door holds no conversation, so its re-verify MUST still carry its whole context —
    // the seat identity (the same signal LAW 6 routes on) and the gig input.
    expect(reverifyCompletions, "the completions re-verify dropped the verify seat's identity — a stateless door can no longer place or route the seat")
      .toContain(VERIFY_ID);
    expect(reverifyCompletions, "the completions re-verify dropped the gig input — a stateless seat holds no conversation to recover it from")
      .toContain(GIG_MARKER);
    // The Claude door, on a re-verify whose inputs are all covered, trims to (near) nothing while the
    // completions door keeps the full prompt. The two DIVERGE.
    const calls = await carryCalls("gig-reverify-i5-claude", loop(2), gigInput, { amend: false });
    const reverifyClaude = reverifyOf(calls, "gig-reverify-i5-claude");
    expect(reverifyClaude, "the examine loop never resumed the verifier for a re-verify").toBeTruthy();
    expect(reverifyClaude!.prompt.length,
      `the two doors do not diverge: the Claude re-verify (${reverifyClaude!.prompt.length} chars) is not a small fraction of the completions re-verify (${reverifyCompletions.length}) — the stateless seat is indistinguishable from the resuming one`)
      .toBeLessThan(reverifyCompletions.length / 4);
  });
});

describe("a re-verify whose --resume session is gone falls back cold, never failing the chair", () => {
  it("F2 — the lost re-verify re-runs COLD with the FULL prompt on a fresh session, records resume_fallback, and does not fail", async () => {
    const gid = "gig-reverify-f2";
    const { calls, events, threw } = await runReverifyClaude(gid, bigGigInput(), { loseReverify: true });
    const spawns = verifySpawns(calls, gid);
    const resumeIdx = spawns.findIndex((c) => c.args.includes("--resume"));
    expect(resumeIdx, "the examine loop never resumed the verifier for a re-verify").toBeGreaterThanOrEqual(0);
    const reverifyResume = spawns[resumeIdx]!;
    const fallback = spawns.slice(resumeIdx + 1).find((c) => c.args.includes("--session-id"));
    expect(fallback, "a lost re-verify session did not re-run COLD with a fresh --session-id spawn").toBeTruthy();
    // The resumed re-verify (BEFORE the fallback) must be the trimmed short prompt — that trimming is
    // exactly why the cold fallback has to re-send the full prompt.
    expect(reverifyResume.prompt, "the resumed re-verify still re-sends the full # Disposition layer — the trim that makes the cold fallback necessary does not exist yet")
      .not.toContain("# Disposition");
    // The cold fallback carries the FULL prompt — a lost conversation carries nothing else.
    expect(fallback!.prompt, "the cold fallback must re-send the FULL prompt (# Disposition) — nothing else carries the verifier's context once the resume fell through")
      .toContain("# Disposition");
    expect(fallback!.prompt, "the cold fallback must re-send the gig input — nothing else carries it once the resume fell through")
      .toContain(GIG_MARKER);
    expect(threw, "a re-verify whose --resume found no conversation failed the chair instead of re-running cold").toBe(false);
    const checkCompletes = events.filter(
      (e) => e.type === "chair_complete" && (e as GigProgressEvent & { role?: string }).role === "check",
    ) as Array<GigProgressEvent & Record<string, unknown>>;
    const last = checkCompletes[checkCompletes.length - 1];
    expect(last, "no chair_complete for the re-verified chair — the cold fallback never completed").toBeTruthy();
    expect(last!["resume_fallback"],
      "chair_complete does not record that the re-verify fell back cold — it claims a resume that never happened")
      .toBe(true);
  });
});
