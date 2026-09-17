// RED — a chair's second use in a gig RESUMES its own conversation instead of re-reading cold.
//
// contract-chair-session-continuity-v1 (operator direction 2026-09-17). The Claude invoker spawns
// `claude -p` fresh on every use: buildInvokerArgs emits no `--session-id`, and the turn-budget
// reserve continuation (src/claude_invoker.ts, `const continuation = ... ${prompt}`) re-sends the
// whole original prompt to a brand-new spawn. A build seat spends ~86% of its wall time generating
// across ~50 turns before its first write, so a warm second round is the saving. These laws pin the
// contract and FAIL today on the missing enforcement, never on a collection or import error:
//
//   O1/I1/I2  every spawn names a session derived deterministically from (gig_id, role);
//   O2        the reserve continuation --resume's that session, carrying only the new text;
//   O3        the examine⇄amend loop --resume's the maker's own session on an amend round;
//   O4        chair_complete records session_id + resumed;
//   O5        a resumed (amend) invocation is never served from the reuse cache;
//   F1        a resume whose session is gone falls back cold and loud, never failing the chair.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, ChildExitError, sessionUuidFor } from "../src/claude_invoker.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { createMemoryReuseStore } from "../src/reuse.js";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type DomainType, type PhaseDef, type Chair, type AgentInvoker, type AgentInvocationContext,
  type GigProgressEvent,
} from "../src";

// A valid RFC 4122 UUID (any version 1–5), the shape O1 requires of a derived session id.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const after = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

// ── the injected spawn seam, text path: capture the arg list, hand back a bare JSON answer ──
const textCapture = () => {
  const calls: string[][] = [];
  const run = (_b: string, args: string[]): string => { calls.push(args); return '{"note":"ok"}'; };
  return { calls, run };
};
const scout = () => testAgent({ slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["raw-note"] });
const dctx = (gig_id: string | undefined, role: string | undefined): AgentInvocationContext =>
  ({ agent: scout(), phase: "scan", ...(gig_id ? { gig_id } : {}), ...(role ? { role } : {}),
     inputs: [], gig_input: {}, output_types: ["raw-note"] }) as AgentInvocationContext;

describe("every Claude chair spawn names a deterministic session", () => {
  it("O1 — the spawn carries --session-id <uuid>; a gig-less invocation carries no session flag", async () => {
    const c = textCapture();
    await makeClaudeInvoker({ run: c.run })(dctx("gig-o1", "scan"));
    expect(after(c.calls[0]!, "--session-id"),
      "no --session-id on the spawn: the chair's conversation is never named, so it can never be resumed").toMatch(UUID);

    const g = textCapture();
    await makeClaudeInvoker({ run: g.run })(dctx(undefined, "scan"));
    expect(g.calls[0], "a gig-less invocation must pass no session flag").not.toContain("--session-id");
    expect(g.calls[0], "a gig-less invocation must pass no session flag").not.toContain("--resume");
  });

  it("I1 — the session uuid is deterministic in (gig_id, role) and isolates every other pair", async () => {
    const sidFor = async (gid: string, role: string): Promise<string | undefined> => {
      const c = textCapture();
      await makeClaudeInvoker({ run: c.run })(dctx(gid, role));
      return after(c.calls[0]!, "--session-id");
    };
    const [a1, a2, b, g2] = await Promise.all([sidFor("g1", "a"), sidFor("g1", "a"), sidFor("g1", "b"), sidFor("g2", "a")]);
    expect(a1, "no session uuid was derived at all").toMatch(UUID);
    expect(a2, "the same (gig_id, role) must yield the same session uuid").toBe(a1);
    expect(b, "two roles in one gig must not share a session").not.toBe(a1);
    expect(g2, "one role across two gigs must not share a session").not.toBe(a1);
  });

  it("I2 — a first invocation opens a session, it never resumes one", async () => {
    const c = textCapture();
    await makeClaudeInvoker({ run: c.run })(dctx("gig-i2", "scan"));
    expect(c.calls[0], "round one must open a session with --session-id").toContain("--session-id");
    expect(c.calls[0], "round one must never --resume — there is nothing yet to resume").not.toContain("--resume");
  });
});

// ── the injected spawn seam, output_write path: scripted stream-json per call ──
const owWrite = (id: string, source: string): string => JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { domain_type: "lineage-hit", data: { source } } }] },
});
const budgetStop = (...w: string[]): string => [...w, JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true })].join("\n");
const clean = (...w: string[]): string => [...w, JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" })].join("\n");
const sessionLost = (): string => JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "No conversation found with session ID" });
const TASK_MARK = "Seal each of your output types by calling"; // a distinctive slice of the original prompt's Task layer

const scripted = (replies: Array<{ stdout: string; exit1: boolean }>) => {
  const calls: string[][] = [];
  const run = (_b: string, args: string[]): string => {
    const r = replies[Math.min(calls.length, replies.length - 1)]!;
    calls.push(args);
    if (r.exit1) throw new ChildExitError("claude exited 1: ", r.stdout);
    return r.stdout;
  };
  return { calls, run };
};
const sweepCtx = (): AgentInvocationContext =>
  ({ agent: testAgent({ slug: "budget-scout", primitives: ["SENSE"], input_types: [], output_types: ["lineage-hit"] }),
     phase: "identify", role: "sweep", gig_id: "gig-reserve", inputs: [], gig_input: {}, output_types: ["lineage-hit"] }) as AgentInvocationContext;

describe("a chair's second reach resumes its own conversation", () => {
  it("O2 — the turn-budget reserve continuation RESUMES the chair's session, carrying only what is new", async () => {
    const s = scripted([
      { stdout: budgetStop(owWrite("w1", "a")), exit1: true },
      { stdout: clean(owWrite("w2", "b")), exit1: false },
    ]);
    await makeClaudeInvoker({ model: "claude-sonnet-4-6", sealVia: "output_write", turn_reserve: 5, run: s.run })(sweepCtx());
    expect(s.calls.length, "the reserve continuation never spawned").toBe(2);

    const second = s.calls[1]!;
    expect(second, "the continuation started a NEW run instead of resuming the chair's own session").toContain("--resume");
    expect(after(second, "--resume"), "the continuation must resume the SAME session round one opened").toBe(after(s.calls[0]!, "--session-id"));
    expect(second, "a resume must not also open a second session").not.toContain("--session-id");
    expect(after(second, "-p") ?? "", "the continuation must carry only the reserve text, not re-send the whole original prompt").not.toContain(TASK_MARK);
  });

  it("F1 — a resume whose session is gone falls back COLD and loud, never failing the chair", async () => {
    const s = scripted([
      { stdout: budgetStop(owWrite("w1", "a")), exit1: true }, // round one hits its budget
      { stdout: sessionLost(), exit1: true },                  // the reserve RESUME finds no such session
      { stdout: clean(owWrite("w3", "c")), exit1: false },     // the cold fallback seals
    ]);
    let threw = false;
    try {
      await makeClaudeInvoker({ model: "claude-sonnet-4-6", sealVia: "output_write", turn_reserve: 5, run: s.run })(sweepCtx());
    } catch { threw = true; }
    expect(threw, "a resume whose session cannot be found must re-run cold, not fail the chair").toBe(false);
    const cold = s.calls.slice(2).find((a) => a.includes("--session-id") && (after(a, "-p") ?? "").includes(TASK_MARK));
    expect(cold, "the fallback must re-run COLD: --session-id and the full original prompt, loudly recorded").toBeTruthy();
  });
});

// ── runGig fixtures: the planner → maker → verifier amend loop ──
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
  slug: "session-continuity", domain: "test", agents: [P, M, V], max_examine_rounds: n,
  phases: [
    { name: "plan", chairs: [chair("plan", "planner", { output_contract: ["plan-in"] })] },
    { name: "make", chairs: [chair("make", "maker", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"] })] },
    { name: "check", chairs: [chair("check", "verifier", { depends_on: ["make"], input_contract: ["artifact"], output_contract: ["verdict"] })] },
  ] as PhaseDef[],
});

describe("session continuity across the examine⇄amend loop and its records", () => {
  it("O3 — an amend round RESUMES the maker's own session and feeds only the new verdict", async () => {
    const calls: Array<{ args: string[]; prompt: string }> = [];
    let verifies = 0;
    // makeClaudeInvoker IS runGig's invoker here, so the amend re-invocation flows through the real
    // spawn path. A spawn is tagged by its SESSION FLAG — the uuid after --session-id (round one) or
    // --resume (an amend), compared with sessionUuidFor(gig, role) — never by prompt text: a resumed
    // amend carries only what is new (contract-amend-resume-prompt-v1), so its prompt no longer names
    // the seat, and a filter keyed on the seat line would silently miss it.
    const sidFor = (role: string): string | undefined => sessionUuidFor("gig-o3", role);
    const sessionOf = (args: readonly string[]): string | undefined => after(args, "--session-id") ?? after(args, "--resume");
    const run = (_b: string, args: string[]): string => {
      const prompt = args[args.indexOf("-p") + 1] ?? "";
      calls.push({ args, prompt });
      const sess = sessionOf(args);
      if (sess === sidFor("plan")) return JSON.stringify({ ...coreInvariantFields("Plan"), value: "plan" });
      if (sess === sidFor("check")) { verifies++; return JSON.stringify({ ...coreInvariantFields("Verdict"), pass: verifies >= 2, value: `v#${verifies}` }); }
      return JSON.stringify({ ...coreInvariantFields("Artifact"), value: "art" });
    };
    await runGig(loop(2), {}, { ...registerTypes(), gig_id: "gig-o3", invoke: makeClaudeInvoker({ run }) });

    const sid = sidFor("make");
    const makers = calls.filter((c) => sessionOf(c.args) === sid);
    expect(makers.length, "the amend loop must re-run the maker after the failing verdict").toBe(2);
    const first = makers[0]!.args, second = makers[1]!.args;
    expect(second, "the amend spawn started the maker cold instead of resuming its round-one session").toContain("--resume");
    expect(sid, "round one must open the maker's session").toMatch(UUID);
    expect(after(first, "--session-id"), "round one must open the maker's OWN round-one session").toBe(sid);
    expect(after(second, "--resume"), "the amend must resume the maker's OWN round-one session").toBe(sid);
    expect(second, "a resumed amend must not also open a fresh session").not.toContain("--session-id");
  });

  it("O4 — chair_complete records the seat's session_id and whether it resumed", async () => {
    const std = composeStandard({
      slug: "o4", domain: "test", agents: [P, M],
      phases: [
        { name: "plan", chairs: [chair("plan", "planner", { output_contract: ["plan-in"] })] },
        { name: "make", chairs: [chair("make", "maker", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"] })] },
      ] as PhaseDef[],
    });
    const invoke: AgentInvoker = ({ agent }) =>
      agent.slug === "planner" ? { ...coreInvariantFields("Plan"), value: "plan" } : { ...coreInvariantFields("Artifact"), value: "art" };
    const events: GigProgressEvent[] = [];
    await runGig(std, {}, { ...registerTypes(), invoke, gig_id: "gig-o4", onProgress: (e: GigProgressEvent) => events.push(e) });

    const cc = events.find((e) => e.type === "chair_complete" && (e as GigProgressEvent & { role?: string }).role === "make") as (GigProgressEvent & Record<string, unknown>) | undefined;
    expect(cc, "no chair_complete for the maker").toBeTruthy();
    expect(cc!["session_id"], "chair_complete does not record the seat's session_id").toMatch(UUID);
    expect(cc!["resumed"], "chair_complete does not record whether the seat resumed a session").toBe(false);
  });

  it("O5 — a RESUMED (amend-round) invocation is never served from the reuse cache", async () => {
    const reuse = createMemoryReuseStore();
    const band = () => {
      const makerCalls: number[] = [];
      let v = 0;
      const invoke: AgentInvoker = ({ agent }) => {
        if (agent.slug === "planner") return { ...coreInvariantFields("Plan"), value: "plan" };
        if (agent.slug === "maker") { makerCalls.push(1); return { ...coreInvariantFields("Artifact"), value: `art#${makerCalls.length}` }; }
        v++; return { ...coreInvariantFields("Verdict"), pass: false, value: `v#${v}` };
      };
      return { invoke, makerCalls };
    };
    // Cold run: the verifier never passes, so the maker runs round-one AND one amend — writing a reuse
    // entry under BOTH the round-one key and the amend key. Deterministic bytes ⇒ the second run's keys
    // match exactly, so both maker invocations WOULD hit the cache.
    const cold = band();
    await runGig(loop(1), {}, { ...registerTypes(), invoke: cold.invoke, gig_id: "gig-o5-a", reuse });
    expect(cold.makerCalls.length, "cold run: the maker runs round-one and the amend").toBe(2);

    const warm = band();
    const r2 = await runGig(loop(1), {}, { ...registerTypes(), invoke: warm.invoke, gig_id: "gig-o5-b", reuse });
    expect(r2.reuse!.hits.length, "the reuse cache must be live in run two (round one is legitimately served)").toBeGreaterThan(0);
    expect(warm.makerCalls.length,
      "the resumed amend maker was served from the cache — a resume carries conversation the reuse key cannot describe").toBeGreaterThanOrEqual(1);
  });
});
