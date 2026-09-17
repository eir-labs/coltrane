// RED — contract-reverify-resume-prompt-v1 (operator eugene, 2026-09-17): a resumed Claude re-verify
// spawn carries ONLY what is new; a stateless chat-completions seat keeps the full prompt it needs.
//
// THE DEFECT (build gig 7332d166 / 4c1ed5e). The examine⇄amend loop's re-verify RESUMES the verifier's
// round-one Claude session (runtime.ts sets `resume: true, keep_prompt: true`) but is handed the FULL
// buildPrompt, because `keep_prompt` was introduced so the SAME buildPrompt could serve the stateless
// chat-completions door, whose examine-loop law (spec_completions_seat_every_door LAW 6) routes each
// spawn by the seat identity IN its prompt. A resumed Claude conversation already holds the whole
// round-one prompt, so every re-verify re-sends it — the exact cold read the resume exists to avoid.
//
// THE CONTRACT. The Claude door (which resumes) trims the re-verify to what is new; the chat-completions
// door (which is stateless) keeps the full prompt. These laws FAIL today on assertions that STATE the
// contract's reason — the trimming, and the divergence between the two doors, do not exist yet:
//   O1  the resumed Claude re-verify is SHORT: no buildPrompt layer, no gig input; it says the makers
//       amended and the verdict must be re-derived from the current tree, plus the chair's output contract;
//   O2  the chat-completions re-verify still carries the seat identity + gig input, and DIVERGES from the
//       trimmed Claude re-verify (the stateless door keeps the full prompt the Claude door now trims);
//   I1  the resumed Claude re-verify is under a quarter of the verifier's round-one prompt (over 4KB);
//   F1  a re-verify whose --resume finds no conversation falls back COLD (full prompt, on a fresh
//       --session-id), records resume_fallback, and never fails the chair.
// Every law runs runGig's REAL examine⇄amend loop with a verifier that fails once: the Claude laws
// observe the spawn through makeClaudeInvoker's injected `run` seam, and O2 observes the chat-completions
// door through makeCompletionsInvoker's injected `fetchFn` seam — both the true re-verify callsites.
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

// The verify seat's identity marker: it is what the FULL prompt carries and the trimmed Claude re-verify
// must drop (O1), yet the stateless completions door must keep (O2) — the same signal LAW 6 routes on.
const VERIFY_ID = "SEAT-VERIFY-4f1a";
const PLAN_ID = "SEAT-PLAN-1a2b";
const MAKE_ID = "SEAT-MAKE-9d8c";
// Failing-verdict content; a gig-input slice the resumed Claude re-verify must NOT re-carry.
const FAILCHECK = "reverify-failcheck-marker-8b2d";
const GIG_MARKER = "gig-input-marker-reverify-do-not-recarry-3e9c";
// A ~6KB gig input: round one is over 4KB (so I1 bites), under the 16KB arg limit (so the seam sees the
// -p positional rather than a stdin-delivered prompt).
const bigGigInput = (): Record<string, unknown> => ({ marker: GIG_MARKER, filler: "x".repeat(6000) });

const failingVerdict = (): string =>
  JSON.stringify({ checks: [{ method: FAILCHECK, target_ref: "art", result: "fail" }], pass: false, value: "v#1" });
const passingVerdict = (): string => JSON.stringify({ ...coreInvariantFields("Verdict"), pass: true, value: "v#2" });
const artifact = (): string => JSON.stringify({ ...coreInvariantFields("Artifact"), value: "art" });
const plan = (): string => JSON.stringify({ ...coreInvariantFields("Plan"), value: "plan" });
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

interface Spawn { args: string[]; prompt: string }

// One amend round through the CLAUDE door: round-one verify fails, the maker amends, the re-verify passes.
// When `loseReverify` is set, the re-verify's --resume finds no conversation once (the F1 fallback path).
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
      // The re-verify RESUMES (--resume). Lose it once when asked (F1); otherwise it passes.
      if (args.includes("--resume")) {
        if (opts.loseReverify && !reverifyLost) { reverifyLost = true; return sessionLost(); }
        return passingVerdict();
      }
      // --session-id opens: round one (fail), then, on the F1 path, the cold fallback (pass).
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

describe("a resumed Claude re-verify spawn carries only what is new", () => {
  it("O1 — the resumed re-verify re-sends no buildPrompt layer and no gig input, only the amend + re-derive statement and the output contract", async () => {
    const gid = "gig-reverify-o1";
    const { calls } = await runReverifyClaude(gid, bigGigInput());
    const reverify = verifySpawns(calls, gid).find((c) => c.args.includes("--resume"));
    expect(reverify, "the examine loop never resumed the verifier's session for a re-verify").toBeTruthy();
    for (const header of ["# Disposition", "# Identity", "# Method", "# Context"]) {
      expect(reverify!.prompt, `the resumed re-verify re-sends the ${header} layer the resumed Claude conversation already holds`)
        .not.toContain(header);
    }
    expect(reverify!.prompt, "the resumed re-verify re-sends the gig input — the largest layer the resume exists to avoid re-paying")
      .not.toContain(GIG_MARKER);
    expect(reverify!.prompt, "the resumed re-verify never states the makers amended their work")
      .toMatch(/amend/i);
    expect(reverify!.prompt, "the resumed re-verify never says the verdict must be re-derived from the current tree")
      .toMatch(/current tree|re-derive|re-derived/i);
    expect(reverify!.prompt, "the resumed re-verify never carries the chair's output contract (its `verdict` output type)")
      .toMatch(/verdict/i);
  });

  it("I1 — a resumed re-verify prompt is under a quarter of a round-one verifier prompt over 4KB", async () => {
    const gid = "gig-reverify-i1";
    const spawns = verifySpawns((await runReverifyClaude(gid, bigGigInput())).calls, gid);
    const roundOne = spawns.find((c) => c.args.includes("--session-id"));
    const reverify = spawns.find((c) => c.args.includes("--resume"));
    expect(roundOne, "no round-one verifier spawn was captured").toBeTruthy();
    expect(reverify, "no resumed re-verify spawn was captured").toBeTruthy();
    expect(roundOne!.prompt.length, "round one must be over 4KB for this bound to bite").toBeGreaterThan(4096);
    expect(reverify!.prompt.length,
      `the resumed re-verify (${reverify!.prompt.length} chars) is not a small fraction of round one (${roundOne!.prompt.length}) — it re-sends the verifier's whole round-one prompt`)
      .toBeLessThan(roundOne!.prompt.length / 4);
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
  it("O2 — the completions re-verify carries the seat identity + gig input, and diverges from the trimmed Claude re-verify", async () => {
    const gigInput = bigGigInput();
    const vprompts = await completionsVerifyPrompts("gig-reverify-o2", gigInput);
    expect(vprompts.length, "the completions examine loop did not re-verify after the failing verdict").toBe(2);
    const reverifyCompletions = vprompts[1]!;
    // The stateless door holds no conversation, so its re-verify MUST still carry its whole context —
    // the seat identity (the same signal LAW 6 routes on) and the gig input.
    expect(reverifyCompletions, "the completions re-verify dropped the verify seat's identity — a stateless door can no longer place or route the seat")
      .toContain(VERIFY_ID);
    expect(reverifyCompletions, "the completions re-verify dropped the gig input — a stateless seat holds no conversation to recover it from")
      .toContain(GIG_MARKER);
    // The Claude door, on the SAME re-verify, must DIVERGE: it trims to what is new while the completions
    // door keeps the full prompt. Today both doors send the full prompt, so the two are indistinguishable.
    const { calls } = await runReverifyClaude("gig-reverify-o2-claude", gigInput);
    const reverifyClaude = verifySpawns(calls, "gig-reverify-o2-claude").find((c) => c.args.includes("--resume"));
    expect(reverifyClaude, "the examine loop never resumed the verifier for a re-verify").toBeTruthy();
    expect(reverifyClaude!.prompt.length,
      `the two doors do not diverge: the Claude re-verify (${reverifyClaude!.prompt.length} chars) is not a small fraction of the completions re-verify (${reverifyCompletions.length}) — today both send the full prompt, so the stateless seat is indistinguishable from the resuming one`)
      .toBeLessThan(reverifyCompletions.length / 4);
  });
});

describe("a re-verify whose --resume session is gone falls back cold, never failing the chair", () => {
  it("F1 — the lost re-verify re-runs COLD with the FULL prompt on a fresh session, records resume_fallback, and does not fail", async () => {
    const gid = "gig-reverify-f1";
    const { calls, events, threw } = await runReverifyClaude(gid, bigGigInput(), { loseReverify: true });
    const spawns = verifySpawns(calls, gid);
    const resumeIdx = spawns.findIndex((c) => c.args.includes("--resume"));
    expect(resumeIdx, "the examine loop never resumed the verifier for a re-verify").toBeGreaterThanOrEqual(0);
    const reverifyResume = spawns[resumeIdx]!;
    const fallback = spawns.slice(resumeIdx + 1).find((c) => c.args.includes("--session-id"));
    expect(fallback, "a lost re-verify session did not re-run COLD with a fresh --session-id spawn").toBeTruthy();
    // The resumed re-verify (BEFORE the fallback) must be the trimmed short prompt — that trimming is
    // exactly why the cold fallback has to re-send the full prompt. It does not exist yet.
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
