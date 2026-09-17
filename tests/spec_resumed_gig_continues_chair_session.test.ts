// RED — contract-resumed-gig-session-v1 (2026-09-17): a resumed chair (and the examine loop's
// re-verify) re-opens `--session-id` for a session the KILLED attempt created; the CLI refuses it
// ("already in use"). The engine handles the LOST ("no conversation found") case but not this
// COLLISION case. O1 re-verify resumes; O2 a collided open re-spawns once with --resume; O3 records
// resumed+session_id; I1 first opens, only a collision resumes; F1 lost→cold.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, ChildExitError, sessionUuidFor } from "../src/claude_invoker.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { createMemoryCheckpointStore } from "../src/reuse.js";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type DomainType, type PhaseDef, type Chair, type AgentInvoker, type AgentInvocationContext,
  type GigProgressEvent, type AgentStreamEvent,
} from "../src";

const after = (a: readonly string[], f: string) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
const sessionOf = (a: readonly string[]) => after(a, "--session-id") ?? after(a, "--resume");
const FULL = "# Disposition"; // present only in the full cold prompt
const inUse = (sid: string) => JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: `Session ID ${sid} is already in use.` });
const lost = () => JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "No conversation found with session ID" });

type Step = "ok" | "inuse" | "lost";
const seam = (steps: Step[]) => {
  const calls: string[][] = [];
  const run = (_b: string, args: string[]): string => {
    calls.push(args);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    const sid = sessionOf(args) ?? "";
    if (step === "inuse") throw new ChildExitError(`claude exited 1: Error: Session ID ${sid} is already in use.`, inUse(sid));
    if (step === "lost") throw new ChildExitError("claude exited 1: ", lost());
    return '{"note":"ok"}';
  };
  return { calls, run };
};
const dctx = (gig_id: string, role: string): AgentInvocationContext =>
  ({ agent: testAgent({ slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["raw-note"] }),
     phase: "scan", gig_id, role, inputs: [], gig_input: {}, output_types: ["raw-note"] }) as AgentInvocationContext;

describe("an id collision is a RESUME, never a failure", () => {
  it("F1 — a resume after a collision that finds no conversation falls back COLD and loud", async () => {
    const s = seam(["inuse", "lost", "ok"]);
    const sid = sessionUuidFor("gig-f1", "scan")!;
    const events: AgentStreamEvent[] = [];
    let threw = false;
    try { await makeClaudeInvoker({ run: s.run })({ ...dctx("gig-f1", "scan"), onEvent: (e) => void events.push(e) }); } catch { threw = true; }
    expect(threw, "lost resume re-runs cold, never fails").toBe(false);
    expect(s.calls.length, "collision → resume → cold fallback").toBe(3);
    const cold = s.calls[2] ?? [];
    expect(after(cold, "--session-id")).toBe(sid);
    expect(after(cold, "-p") ?? "", "the fallback re-sends the full prompt").toContain(FULL);
    expect(events.some((e) => e.type === "resume_fallback"), "the fallback is recorded, not silent").toBe(true);
  });
});

const bench = () => {
  const r = createRegistry();
  for (const [s, e] of [["plan-in", "Plan"], ["artifact", "Artifact"], ["verdict", "Verdict"]] as const)
    r.registerType({ slug: s, extends: e, domain: "test", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as DomainType);
  return { outputs: createOutputStore(r), ledger: new MemoryLedger() };
};
const chair = (role: string, agent_slug: string, o: Partial<Chair> = {}): Chair =>
  ({ role, agent_slug, depends_on: [], input_contract: [], output_contract: [], required_skills: [], ...o });
const P = testAgent({ slug: "planner", primitives: ["PLAN"], input_types: [], output_types: ["plan-in"] });
const M = testAgent({ slug: "maker", primitives: ["CREATE"], input_types: ["plan-in"], output_types: ["artifact"] });
const V = testAgent({ slug: "verifier", primitives: ["VERIFY"], input_types: ["artifact"], output_types: ["verdict"] });
const loop = (n: number) => composeStandard({
  slug: "resumed-gig-session", domain: "test", agents: [P, M, V], max_examine_rounds: n,
  phases: [
    { name: "plan", chairs: [chair("plan", "planner", { output_contract: ["plan-in"] })] },
    { name: "make", chairs: [chair("make", "maker", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"] })] },
    { name: "check", chairs: [chair("check", "verifier", { depends_on: ["make"], input_contract: ["artifact"], output_contract: ["verdict"] })] },
  ] as PhaseDef[],
});

describe("a resumed gig, and its re-verify, continue the interrupted chair's own conversation", () => {
  it("O1/I1 — the examine loop's re-verify RESUMES the verifier's session instead of colliding", async () => {
    const calls: string[][] = [];
    let verifies = 0;
    const sidFor = (role: string) => sessionUuidFor("gig-o1e", role);
    const run = (_b: string, args: string[]): string => {
      calls.push(args);
      const sess = sessionOf(args);
      if (sess === sidFor("plan")) return JSON.stringify({ ...coreInvariantFields("Plan"), value: "p" });
      if (sess === sidFor("check")) { verifies++; return JSON.stringify({ ...coreInvariantFields("Verdict"), pass: verifies >= 2, value: `v${verifies}` }); }
      return JSON.stringify({ ...coreInvariantFields("Artifact"), value: "a" });
    };
    await runGig(loop(2), {}, { ...bench(), gig_id: "gig-o1e", invoke: makeClaudeInvoker({ run }) });
    const sid = sidFor("check")!;
    const vers = calls.filter((c) => sessionOf(c) === sid);
    expect(vers.length, "verify, then re-verify").toBe(2);
    expect(after(vers[0]!, "--session-id")).toBe(sid);
    expect(vers[1]!, "the re-verify re-opened its round-one session — the CLI refuses that as 'already in use'").toContain("--resume");
    expect(after(vers[1]!, "--resume")).toBe(sid);
    expect(vers[1]!).not.toContain("--session-id");
    const plans = calls.filter((c) => sessionOf(c) === sidFor("plan")); // passes first time
    expect(plans.length, "an un-amended chair is spawned once, never resumed (I1)").toBe(1);
    expect(plans[0]).not.toContain("--resume");
  });

  it("O2/O3/I1 — a resumed chair whose killed attempt made the session RESUMES it, and records it", async () => {
    const b = bench();
    const checkpoints = createMemoryCheckpointStore();
    const GIG = "gig-resume-collide";
    // Attempt 1 (killed): plan+make seal and checkpoint; the verifier dies having CREATED its session.
    const a1: AgentInvoker = ({ agent }) =>
      agent.slug === "planner" ? { ...coreInvariantFields("Plan"), value: "p" }
      : agent.slug === "maker" ? { ...coreInvariantFields("Artifact"), value: "a" }
      : (() => { throw new Error("verifier SIGTERMed after opening its session"); })();
    await expect(runGig(loop(0), {}, { ...b, gig_id: GIG, invoke: a1, checkpoints })).rejects.toThrow();

    // Attempt 2 (resume): the verifier re-runs; its --session-id open collides and must resume.
    const sid = sessionUuidFor(GIG, "check")!;
    const calls: string[][] = [];
    const run = (_b: string, args: string[]): string => {
      calls.push(args);
      if (args.includes("--session-id")) throw new ChildExitError(`claude exited 1: Error: Session ID ${sid} is already in use.`, inUse(sid));
      return JSON.stringify({ ...coreInvariantFields("Verdict"), pass: true, value: "ok" });
    };
    const events: GigProgressEvent[] = [];
    let res: Awaited<ReturnType<typeof runGig>> | undefined, threw = false;
    try {
      res = await runGig(loop(0), {}, { ...b, gig_id: GIG, invoke: makeClaudeInvoker({ run }), checkpoints, resume_from: GIG, onProgress: (e) => void events.push(e) });
    } catch { threw = true; }
    expect(threw, "the resumed collision resumes, not fails the gig (O2)").toBe(false);
    expect(res?.status).toBe("complete");
    expect(calls.filter((c) => c.includes("--session-id")).length, "first spawn opens, collides (I1)").toBe(1);
    const resumes = calls.filter((c) => c.includes("--resume"));
    expect(resumes.length, "then retried with --resume, never resume-first (O2/I1)").toBe(1);
    expect(after(resumes[0] ?? [], "--resume")).toBe(sid);
    const rp = after(resumes[0] ?? [], "-p") ?? "";
    expect(rp, "the retry is short and says the prior attempt was interrupted, the tree authoritative (O2)")
      .toMatch(/interrupt|previous attempt|current tree|authoritative/i);
    expect(rp).not.toContain(FULL);
    const cc = events.find((e) => e.type === "chair_complete" && (e as GigProgressEvent & { role?: string }).role === "check") as (GigProgressEvent & Record<string, unknown>) | undefined;
    expect(cc!["resumed"], "chair_complete records the verifier CONTINUED a session (O3)").toBe(true);
    expect(cc!["session_id"], "and the session id it continued (O3)").toBe(sid);
  });
});
