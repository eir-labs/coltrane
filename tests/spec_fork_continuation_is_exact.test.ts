// RED — contract-fork-continuation-is-exact-v1. A seat's LATER spawns continue the conversation that
// seat is actually in, and a primer describes EXACTLY the conversation a fork resumes. Three confirmed
// defects in src/claude_invoker.ts (read at cfc3da2), one law per obligation/invariant/failure-mode,
// each FAILING today on an assertion that states the contract's reason:
//
//   O1  A spawn that CONTINUES a chair's own session — the turn-budget reserve continuation AND the
//       seal-repair spawn — carries exactly one --resume naming the chair's OWN session, and neither
//       --resume-session-at nor --fork-session. Today the reserve continuation is `withResume(baseArgs)`
//       (:2022) which drops only `--session-id <own>`, so a fork chair's warm-start (`--resume <primer>
//       --resume-session-at <frontier> --fork-session --session-id <own>`) becomes `--resume <primer>
//       --resume-session-at <frontier> --fork-session --resume <own>` — two --resume, the primer's
//       frontier uuid, and a --fork-session that branches AGAIN. The seal-repair spawn (:2166) reuses
//       baseArgs verbatim, so the same leftover reaches it.
//   O2  A usage reporting NONE of input_tokens/cache_read_input_tokens/cache_creation_input_tokens
//       contributes NO reading (undefined, never 0), so the first-write context falls back to the last
//       reported reading. Today `assistantContextOf` (:1013) returns `(input??0)+(cache_read??0)+
//       (cache_creation??0)` = 0, and `firstWriteContext = usage ?? lastUsageBefore` keeps the 0.
//   O3  A primer's files are the reads BEFORE its frontier line. Today the read scan (:1061) records a
//       Read from ANY assistant line before the first WRITE line — including a Read in the write's OWN
//       turn, after the frontier — so the primer names a file the cut conversation does not hold.
//
// TESTING METHOD — example-based, at the two real seams the contract's outputs cross, exactly as the
// standing seat-primer / turn-reserve laws exercise them:
//   · the O1/F1 arg-list laws INVOKE makeClaudeInvoker directly through its injected `run` seam and
//     CAPTURE each spawn's argv — the reserve laws drive a first spawn that stops at its turn budget
//     (the CLI's error_max_turns result), so the reserve continuation really runs (the shape
//     tests/the_reserve_fires_on_the_subtype.test.ts drives), over a FORK ctx (ctx.fork threaded, as
//     runGig threads it) with the chair's own (gig,role) session derived by sessionUuidFor.
//   · the O2/O3 primer laws run through runGig over a PRIME chair whose invoker's injected `run` seam
//     returns a stream-json transcript carrying user/assistant lines with `uuid`/`usage` — the SAME
//     lines a real seat's stdout carries — and read the sealed seat-primer back (the shape
//     tests/spec_primer_reading_frontier.test.ts drives).
// Each obligation's mechanism and callsite is in docs/specs/fork-continuation-is-exact.red-spec.md.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeClaudeInvoker, sessionUuidFor } from "../src/claude_invoker.js";
import { defineAgent } from "../src/composition.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type DomainType,
} from "../src";
import { testAgent } from "./_support/agents.js";

const REPO = process.cwd();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const after = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const countOf = (args: readonly string[], flag: string): number => args.filter((a) => a === flag).length;

// ── stream-json builders: the SAME line shapes a real seat's stdout carries ──────────────────────────
const sj = (...evts: unknown[]): string => evts.map((e) => JSON.stringify(e)).join("\n");
const asst = (uuid: string, content: unknown[], usage?: Record<string, number>) =>
  ({ type: "assistant", uuid, message: usage ? { content, usage } : { content } });
const userLine = (uuid: string, content: unknown[]) => ({ type: "user", uuid, message: { content } });
const readUse = (path: string) => ({ type: "tool_use", id: `read:${path}`, name: "Read", input: { file_path: path } });
const editUse = (path: string) => ({ type: "tool_use", id: `edit:${path}`, name: "Edit", input: { file_path: path } });
const trResult = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "ok" });
const owUse = (id: string, dt: string, data: unknown) => ({ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { domain_type: dt, data } });
const okResult = { type: "result", subtype: "success", is_error: false, result: "done" };
const budgetStop = { type: "result", subtype: "error_max_turns", is_error: true, result: "stopped at turn budget" };
const sessionLost = (sid: string) => ({ type: "result", subtype: "error_during_execution", is_error: true, result: `No conversation found with session ID ${sid}` });
const SEAL = { source: "fixture://fork-continuation-is-exact" };
const OW_MCP = { coltrane: { command: "node", args: ["server_entry.js"] } };

const SEALED = sj(asst("s-seal", [owUse("w1", "raw-note", SEAL)]), okResult);
const BUDGET = sj(budgetStop);

// Fixed, valid-shaped session/message uuids for the fork ctx the arg-list laws thread.
const PRIMER_SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FRONTIER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// O1 / I1 / I2 — the LATER spawns continue the chair's OWN session
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const arg = () =>
  defineAgent({
    slug: "fork-reader", primitives: ["SENSE"], input_types: [], output_types: ["raw-note"],
    identity: "a fork chair that reads and reserves", method: "read the area then seal",
    constraints: [], behavioral_primitives: ["explorer", "executor"], allowed_tools: ["Read"], max_tool_calls: 3,
  });

// Invoke the real invoker, capturing every spawn's argv through the injected `run` seam. `streams` is
// consumed in order (last one repeats), so a budget-stop-then-seal pair drives the reserve continuation.
const capturing = (...streams: string[]) => {
  const calls: string[][] = [];
  let n = 0;
  const inv = makeClaudeInvoker({
    sealVia: "output_write", mcpServerConfigs: OW_MCP, turn_reserve: 5,
    run: (_bin, args) => { calls.push([...args]); return streams[Math.min(n++, streams.length - 1)]!; },
  });
  return { inv, calls };
};

const plainCtx = (gig: string): AgentInvocationContext =>
  ({ agent: arg(), phase: "sense", gig_id: gig, role: "s", inputs: [], gig_input: {},
     output_types: ["raw-note"], turn_reserve: 5 }) as AgentInvocationContext;
const forkCtx = (gig: string): AgentInvocationContext =>
  ({ ...plainCtx(gig), fork: { primer_session_id: PRIMER_SID, stale_paths: [], frontier: FRONTIER } }) as AgentInvocationContext;

describe("O1/I1/I2 — the turn-budget reserve continuation resumes the chair's OWN session", () => {
  it("a plain chair's reserve is unchanged (--resume <own>); a fork chair's reserve drops the warm-start it belongs to the first spawn", async () => {
    // I1 (control that stays green) — a PLAIN chair: first spawn opens --session-id <own>, and the
    // reserve continuation resumes exactly that, carrying no fork flags. This is today's behaviour and
    // the fix must not disturb it.
    const own = sessionUuidFor("gig-plain", "s")!;
    const plain = capturing(BUDGET, SEALED);
    await plain.inv(plainCtx("gig-plain"));
    expect(plain.calls.length, "a plain chair that hits its budget must be extended once").toBe(2);
    expect(after(plain.calls[0]!, "--session-id"), "the plain chair's FIRST spawn opens its own session").toBe(own);
    expect(countOf(plain.calls[1]!, "--resume"), "the plain chair's reserve continuation carries exactly one --resume").toBe(1);
    expect(after(plain.calls[1]!, "--resume"), "a plain chair's reserve resumes its own session").toBe(own);
    expect(plain.calls[1], "a plain reserve carries no --fork-session").not.toContain("--fork-session");
    expect(plain.calls[1], "a plain reserve carries no --resume-session-at").not.toContain("--resume-session-at");

    // I2 (control that stays green) — the SAME fork chair's FIRST spawn still warm-starts: it resumes
    // the primer, cuts at the frontier, forks, and names its own session.
    const forkOwn = sessionUuidFor("gig-fork", "s")!;
    const fork = capturing(BUDGET, SEALED);
    await fork.inv(forkCtx("gig-fork"));
    expect(fork.calls.length, "a fork chair that hits its budget must be extended once").toBe(2);
    expect(fork.calls[0], "the fork's FIRST spawn warm-starts").toContain("--fork-session");
    expect(after(fork.calls[0]!, "--resume"), "the first spawn resumes the primer's session").toBe(PRIMER_SID);
    expect(after(fork.calls[0]!, "--resume-session-at"), "the first spawn cuts at the primer's frontier").toBe(FRONTIER);
    expect(after(fork.calls[0]!, "--session-id"), "the first spawn opens the fork's own session").toBe(forkOwn);

    // O1 (RED today) — the fork chair's RESERVE continuation must continue the fork's OWN session, not
    // re-run the primer's warm-start. Today `withResume(baseArgs)` drops only --session-id, leaving
    // --resume <primer> --resume-session-at <frontier> --fork-session and appending a SECOND --resume
    // <own>: two --resume targets and a --fork-session that branches again.
    expect(countOf(fork.calls[1]!, "--resume"), "the reserve continuation carries EXACTLY ONE --resume; today it carries two (the primer's, kept from the warm-start, plus the chair's own appended)")
      .toBe(1);
    expect(after(fork.calls[1]!, "--resume"), "the reserve continuation resumes the fork's OWN session; today the first --resume still names the primer, so the continuation resumes a conversation the fork is not in")
      .toBe(forkOwn);
    expect(fork.calls[1], "a reserve continuation of an existing session carries NO --fork-session — the warm start belongs to the first spawn only; today --fork-session survives from baseArgs and would branch the session AGAIN")
      .not.toContain("--fork-session");
    expect(fork.calls[1], "a reserve continuation carries NO --resume-session-at — there is no frontier to cut a continuation at; today the primer's frontier uuid survives from baseArgs and names a message the fork's own session does not hold")
      .not.toContain("--resume-session-at");
    expect(after(fork.calls[1]!, "--resume"), "the resumed session is a real (gig,role) uuid, the fork's own").toMatch(UUID);
  });
});

describe("O1 — the seal-repair continuation of a fork chair resumes its OWN session", () => {
  it("a fork chair that seals nothing is repaired with --resume <own>, never re-forked from the primer", async () => {
    const own = sessionUuidFor("gig-repair", "s")!;
    // First spawn completes cleanly but seals NOTHING (no output_write) → the seal-repair continuation
    // fires. Repair also seals nothing, so the chair ultimately fails; the argv is captured before that.
    const emptyRun = sj(asst("a", [readUse("package.json")]), okResult);
    const { inv, calls } = (() => {
      const c: string[][] = [];
      const invoker = makeClaudeInvoker({
        sealVia: "output_write", mcpServerConfigs: OW_MCP,
        run: (_bin, args) => { c.push([...args]); return emptyRun; },
      });
      return { inv: invoker, calls: c };
    })();
    let threw = false;
    try { await inv(forkCtx("gig-repair")); } catch { threw = true; }
    expect(threw, "a chair that seals nothing after its one repair still fails — the repair is bounded to once").toBe(true);
    expect(calls.length, "the fork chair must be continued once to repair the write channel").toBe(2);
    // O1 (RED today) — the repair spawn reuses baseArgs verbatim (:2166), so for a fork chair it carries
    // --session-id <own>, --resume <primer>, --resume-session-at <frontier> and --fork-session. It must
    // instead RESUME the fork's own session with a single --resume <own> and none of those.
    expect(after(calls[1]!, "--resume"), "the seal-repair continuation resumes the fork's OWN session; today baseArgs' --resume still names the primer")
      .toBe(own);
    expect(calls[1], "the seal-repair continuation does NOT open a fresh --session-id — it CONTINUES the chair's session; today baseArgs' --session-id <own> survives and would collide with the session the first spawn already opened")
      .not.toContain("--session-id");
    expect(calls[1], "the seal-repair continuation carries NO --fork-session; today it survives from baseArgs and re-forks")
      .not.toContain("--fork-session");
    expect(calls[1], "the seal-repair continuation carries NO --resume-session-at; today the primer's frontier survives from baseArgs")
      .not.toContain("--resume-session-at");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// F1 — a fork chair whose OWN-session reserve continuation cannot be resumed falls back cold
// ══════════════════════════════════════════════════════════════════════════════════════════════════

describe("F1 — the reserve continuation of a fork chair whose own session is lost falls back cold", () => {
  it("the reserve resumes the fork's own session; when that is lost the cold fallback opens --session-id and carries no --fork-session / --resume-session-at", async () => {
    const own = sessionUuidFor("gig-f1", "s")!;
    // Spawn 1: budget stop. Spawn 2: the reserve continuation reports its resume target is gone. Spawn 3:
    // the cold fallback (a fresh --session-id spawn with the full prompt) seals normally.
    const { inv, calls } = (() => {
      const c: string[][] = [];
      let n = 0;
      const streams = [BUDGET, sj(sessionLost(own)), SEALED];
      const invoker = makeClaudeInvoker({
        sealVia: "output_write", mcpServerConfigs: OW_MCP, turn_reserve: 5,
        run: (_bin, args) => { c.push([...args]); return streams[Math.min(n++, streams.length - 1)]!; },
      });
      return { inv: invoker, calls: c };
    })();
    let threw = false;
    try { await inv(forkCtx("gig-f1")); } catch { threw = true; }
    expect(threw, "an unresumable reserve continuation must fall back cold, never fail the chair").toBe(false);
    expect(calls.length, "budget stop, reserve continuation, then cold fallback — three spawns").toBe(3);
    // RED today — the reserve continuation (whose lost session triggers the fallback) must have resumed
    // the fork's OWN session. Today it resumes the primer (first --resume), so the "own session lost"
    // condition F1 describes is never actually the condition that fires.
    expect(after(calls[1]!, "--resume"), "the reserve continuation resumes the fork's OWN session; today baseArgs' --resume still names the primer")
      .toBe(own);
    // Control that stays green — the existing cold fallback: a fresh --session-id spawn, no fork flags.
    expect(after(calls[2]!, "--session-id"), "the cold fallback opens a fresh session with the full prompt").toBe(own);
    expect(calls[2], "the cold fallback carries no --fork-session").not.toContain("--fork-session");
    expect(calls[2], "the cold fallback carries no --resume-session-at").not.toContain("--resume-session-at");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// O2 / I3 / O3 — a primer describes EXACTLY the cut conversation (run through runGig, subject = primer)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const makeStore = () => {
  const r = createRegistry();
  r.registerType({ slug: "raw-note", extends: "Signal", domain: "demo", schema: { properties: { source: { type: "string" } } }, required_fields: [] } as DomainType);
  r.registerType({ slug: "seat-primer", extends: "Signal", domain: "engine", required_fields: ["agent_slug", "area", "session_id"],
    schema: { properties: {
      agent_slug: { type: "string" }, area: { type: "string" }, session_id: { type: "string" },
      commit: { type: "string" }, files: { type: "array" }, context_tokens: { type: "number" },
      frontier: { type: "string" }, source: { type: "string" },
    } } } as DomainType);
  return { outputs: createOutputStore(r), ledger: new MemoryLedger() };
};
type Base = ReturnType<typeof makeStore>;

const senseAgent = (slug: string) =>
  testAgent({ slug, primitives: ["SENSE"], input_types: [], output_types: ["raw-note"], domain: "demo" });
const oneChair = (slug: string, chairExtra: Record<string, unknown> = {}) =>
  composeStandard({
    slug: "fork-continuation-demo", domain: "demo", agents: [senseAgent(slug)],
    phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: slug, depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [], ...chairExtra }] }],
  } as any);

const primeRun = async (
  base: Base,
  o: { agent: string; area: string; gig_id: string; run: () => string | ((bin: string, args: string[]) => string); tree_root?: string },
): Promise<Record<string, unknown> | undefined> => {
  const runFn = o.run();
  const invoke = makeClaudeInvoker({
    sealVia: "output_write", mcpServerConfigs: OW_MCP,
    run: typeof runFn === "function" ? (runFn as (b: string, a: string[]) => string) : () => runFn as string,
  });
  await runGig(oneChair(o.agent, { role: "prime", prime: { area: o.area } }), {}, { ...base, invoke, gig_id: o.gig_id, tree_root: o.tree_root ?? REPO } as never);
  return base.outputs.all().filter((r) => r.domain_type === "seat-primer").map((r) => r.data as Record<string, unknown>).pop();
};

const O2_FRONT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const O3_FRONT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("O2/I3 — a usage that reports none of the three context fields contributes no reading", () => {
  it("the first-write line reports only output_tokens after an earlier 40,000-input reading: the primer records 40,000, never 0", async () => {
    const base = makeStore();
    // The Read line reports 40,000 input tokens (a real reading). The first-write (Edit) line reports
    // ONLY output_tokens — none of input/cache_read/cache_creation. The primer's context_tokens is the
    // first-write context, which must fall back to the last reported reading (40,000). Today
    // assistantContextOf sums (input??0)+(cache_read??0)+(cache_creation??0) = 0 for the write line, and
    // `usage ?? lastUsageBefore` keeps that 0 (0 is not nullish), so the primer seals 0 and runtime's
    // ceiling test (primer_context > ceiling) can never fire for it.
    const primer = await primeRun(base, {
      agent: "reader", area: "amend-loop", gig_id: "gig-o2",
      run: () => sj(
        asst("a-read", [readUse("package.json")], { input_tokens: 40_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
        userLine(O2_FRONT, [trResult("read:package.json")]),
        asst("a-edit", [editUse("package.json")], { output_tokens: 500 }), // reports NONE of the three
        asst("a-seal", [owUse("w1", "raw-note", SEAL)]),
        okResult,
      ),
    });
    expect(primer, "a prime chair must seal a seat-primer").toBeTruthy();
    expect(primer!["context_tokens"], "a usage reporting only output_tokens contributes NO reading, so the first-write context falls back to the last real reading (40,000); today it contributes 0 and the primer seals 0")
      .toBe(40_000);
  });
});

describe("O3 — a primer's files are the reads before its frontier line", () => {
  it("a file read in the write's OWN turn (after the frontier) is not recorded; a file read before the frontier is", async () => {
    const root = mkdtempSync(join(tmpdir(), "fork-o3-"));
    try {
      writeFileSync(join(root, "good.ts"), "export const good = 1;\n");
      writeFileSync(join(root, "bad.ts"), "export const bad = 2;\n");
      const g = (...a: string[]): void => { execFileSync("git", ["-C", root, ...a], { stdio: "pipe" }); };
      g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("add", "-A"); g("commit", "-q", "-m", "seed");
      const base = makeStore();
      // The seat Reads good.ts, its tool_result ends its reading (the frontier O3_FRONT), THEN — in the
      // same turn as the first write, with no user line between — it Reads bad.ts and Edits bad.ts. The
      // frontier cuts BEFORE that turn, so the cut conversation holds good.ts and NOT bad.ts. Today the
      // read scan records every Read before the first WRITE line, so bad.ts is wrongly recorded.
      const primer = await primeRun(base, {
        agent: "reader", area: "amend-loop", gig_id: "gig-o3", tree_root: root,
        run: () => sj(
          asst("g-read", [readUse("good.ts")]),
          userLine(O3_FRONT, [trResult("read:good.ts")]),
          asst("b-read", [readUse("bad.ts")]),
          asst("b-edit", [editUse("bad.ts")]),
          asst("b-seal", [owUse("w1", "raw-note", SEAL)]),
          okResult,
        ),
      });
      expect(primer, "a prime chair must seal a seat-primer").toBeTruthy();
      const paths = ((primer!["files"] as Array<{ path: string }>) ?? []).map((f) => f.path);
      expect(paths, "good.ts was read before the frontier, so the cut conversation holds it").toContain("good.ts");
      expect(paths, "bad.ts was first read in the write's OWN turn (after the frontier), so the cut conversation does NOT hold it; today the read scan records every Read before the first write line, so bad.ts is wrongly named — the fork is told it holds a file it does not")
        .not.toContain("bad.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
