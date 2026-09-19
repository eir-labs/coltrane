// RED — contract-seat-ask-v1: a past seat can be asked WHY, on the conversation it actually held,
// and cannot act while answering.
//
// THE MEASURED PROBLEM (operator, 2026-09-19). Reconciliation is a discussion with a reconciliation
// agent, not an agent grading itself ("an agent writing its own memory will drift toward excuses").
// The RECONCILER holds the deterministic record (gig census: chairs, amend rounds, failed verdicts,
// departures, spend); the WORKER holds the memory of WHY. But today the engine has no way to ask a
// past seat anything: a chair's session is DERIVED from (gig_id, role) and the Claude invoker can
// resume it (contract-chair-session-continuity-v1), yet nothing exposes that as a VERB — so the only
// way to get a worker's reasoning into a reconciliation is to ask a FRESH seat to IMAGINE it, which
// is exactly the invented story the ledger must never accrue. Resuming the seat's own session is the
// cheap half (measured this session: ~540k cache-read tokens/turn to re-read a context cold).
//
// THE CONTRACT.
//   O1: a new engine tool seat_ask({ gig_id, role, question, max_turns? }) RESUMES that seat's own
//       session — the uuid sessionUuidFor(gig_id, role), the SAME derivation the amend loop uses —
//       and returns { answer, session_id, resumed: true }. The QUESTION is the only thing sent: no
//       gig input, no identity layer, no method. The conversation already holds them.
//   O2: the asked seat is given NO TOOLS — an empty allow list, every host builtin and every MCP
//       tool refused by construction, so a seat being interrogated cannot write a file, seal an
//       output, or touch the record it is being asked about. The turn cap defaults to 2, never
//       unbounded.
//   O3: the verb is advertised on the MCP surface like every other engine verb, its arguments in the
//       generated schema, so a reconciler agent can be granted it by name.
//   I1: an answer is always attributed to the conversation that produced it (session_id ===
//       sessionUuidFor(gig_id, role); the spawn carries --resume with that same uuid).
//   I2: asking changes nothing — no output sealed, no ledger row written by the ask itself.
//   F1: no conversation for that (gig_id, role) → a TYPED refusal naming gig and role, and NO fresh
//       seat is spawned; the refusal is RETURNED, never thrown.
//   F2: the resumed seat answers with nothing → the empty answer is returned AS an empty answer with
//       resumed: true, never a refusal and never filled in with a guess.
//
// THESE LAWS ARE RED BY DESIGN: seat_ask does not exist. dispatchTool("seat_ask", …) returns
// `{ ok:false, error:'unknown tool "seat_ask"' }` today (KNOWN_SLUGS is built from MCP_TOOLS, which
// carries no seat_ask), so the tool never reaches the invoker and the run seam below never fires.
// Each law fails on that ABSENCE, stating the contract's reason.
//
// HOW THE LAWS OBSERVE (acceptance #2). The tool is driven through the engine's own dispatch path
// (dispatchTool), exactly as every other engine-tool suite does. The spawn is observed through
// makeClaudeInvoker's injected `run` seam — the same seam invoker_cage.test.ts reads — which captures
// the argument list (and, for a short prompt, the `-p <question>` positional) without a real CLI. The
// seat's answer is the seam's return value verbatim: a hands-off seat replies in prose, and the verb
// returns that prose (never re-parsed as JSON — the rationale is in docs/specs/seat-ask.red-spec.md).
import { describe, it, expect } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { makeClaudeInvoker, sessionUuidFor } from "../src/claude_invoker.js";
import { MCP_TOOLS } from "../src/mcp.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";

// ── the seat under interrogation ─────────────────────────────────────────────────────────────────
const GIG = "gig-6b1e9d2f";
const ROLE = "security-reviewer";
const QUESTION = "why did you fail the deploy chair's verdict?";
const UUID = sessionUuidFor(GIG, ROLE)!; // the seat's own session id, derived from (gig_id, role)

// The prose a resumed seat replies with. Returned by the injected run seam and, per the contract,
// carried back verbatim as the answer — the reasoning the reconciliation exists to hear.
const ANSWER = "I failed it because the rollback plan named a migration that the forward step never wrote.";

// ── observation harness ─────────────────────────────────────────────────────────────────────────
interface RunCall { args: string[]; }
/** Build ServerDeps whose invoke is a makeClaudeInvoker with an injected run seam that RECORDS every
 *  spawn and returns `reply(args)` as the child's stdout. The tool is then driven via dispatchTool. */
function harness(reply: (args: string[]) => string) {
  const calls: RunCall[] = [];
  const invoke = makeClaudeInvoker({
    run: (_bin, args) => { calls.push({ args }); return reply(args); },
  });
  const registry = createRegistry();
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  const deps: ServerDeps = { registry, outputs, ledger, invoke };
  return { deps, calls, outputs, ledger };
}

const valueAfter = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const denyList = (args: string[]): string[] => (valueAfter(args, "--disallowedTools") ?? "").split(",").filter(Boolean);
const promptArg = (args: string[]): string | undefined => valueAfter(args, "-p");
const dataOf = (r: { data?: unknown }): { answer?: unknown; session_id?: unknown; resumed?: unknown } =>
  (r.data ?? {}) as { answer?: unknown; session_id?: unknown; resumed?: unknown };

// ── O1 ────────────────────────────────────────────────────────────────────────────────────────────
describe("seat_ask — resumes THAT seat's own session and sends only the question (O1)", () => {
  it("O1 — returns { answer, session_id, resumed: true } and the ONLY thing the spawn is sent is the question", async () => {
    const { deps, calls } = harness(() => ANSWER);
    const res = await dispatchTool("seat_ask", { gig_id: GIG, role: ROLE, question: QUESTION }, deps);

    expect(res.ok, "an answerable seat is not a refusal").toBe(true);
    const d = dataOf(res);
    expect(String(d.answer), "the seat's reasoning is returned verbatim from the resumed conversation").toContain(ANSWER);
    expect(d.session_id, "the answer is stamped with the session it came from").toBe(UUID);
    expect(d.resumed, "this is a resume, not a fresh open").toBe(true);

    // Exactly one spawn, and it carries ONLY the question — no identity, no method, no gig input. The
    // conversation already holds them, which is what makes the ask cheap (O1).
    expect(calls.length, "one resumed spawn").toBe(1);
    expect(promptArg(calls[0]!.args), "the question is the only thing sent — the seat re-reads nothing").toBe(QUESTION);
  });
});

// ── O2 (no tools) — acceptance criterion #4 ─────────────────────────────────────────────────────────
describe("seat_ask — the asked seat is given NO tools (O2)", () => {
  it("O2 — empty allow list, no MCP tool, and the write/act builtins denied by construction: a seat answering cannot change the record", async () => {
    const { deps, calls } = harness(() => ANSWER);
    await dispatchTool("seat_ask", { gig_id: GIG, role: ROLE, question: QUESTION }, deps);

    expect(calls.length, "the spawn happened so its cage is observable").toBe(1);
    const args = calls[0]!.args;

    // NOTHING is granted. An absent --allowedTools means an empty allow list; a present one must not
    // name a single tool, MCP or otherwise. A resumed seat that can act is a seat that can rewrite the
    // very record it is being asked about.
    const allowed = valueAfter(args, "--allowedTools");
    expect(allowed === undefined || allowed === "", "the asked seat is granted NO tools").toBe(true);
    expect((allowed ?? ""), "not one MCP tool is reachable").not.toMatch(/mcp__/);

    // The ceiling BINDS by enforcement (invoker_cage LAW 1): the ungranted host builtins are denied,
    // not merely omitted. A seat that could Write/Edit/Bash could touch the record mid-answer.
    const deny = denyList(args);
    for (const builtin of ["Write", "Edit", "Bash", "Read"]) {
      expect(deny, `a hands-off seat must be denied ${builtin} — it may not act while answering`).toContain(builtin);
    }
    expect(args, "ambient MCP stays denied on every spawn").toContain("--strict-mcp-config");
  });
});

// ── O2 (turn cap) ───────────────────────────────────────────────────────────────────────────────
describe("seat_ask — the turn cap defaults to 2 and is never unbounded (O2)", () => {
  it("O2 — --max-turns defaults to 2 when max_turns is omitted, honours an explicit cap, and is ALWAYS present", async () => {
    const dflt = harness(() => ANSWER);
    await dispatchTool("seat_ask", { gig_id: GIG, role: ROLE, question: QUESTION }, dflt.deps);
    expect(dflt.calls.length).toBe(1);
    expect(valueAfter(dflt.calls[0]!.args, "--max-turns"), "an omitted turn cap defaults to 2, never unbounded").toBe("2");

    const capped = harness(() => ANSWER);
    await dispatchTool("seat_ask", { gig_id: GIG, role: ROLE, question: QUESTION, max_turns: 5 }, capped.deps);
    expect(valueAfter(capped.calls[0]!.args, "--max-turns"), "an explicit cap is honoured").toBe("5");
  });
});

// ── O3 ────────────────────────────────────────────────────────────────────────────────────────────
describe("seat_ask — advertised on the MCP surface with its arguments (O3)", () => {
  it("O3 — seat_ask is a verb in MCP_TOOLS and its generated schema carries gig_id, role, question and max_turns", () => {
    const tool = MCP_TOOLS.find((t) => t.slug === "seat_ask");
    expect(tool, "seat_ask must be advertised like every other engine verb, so a reconciler can be granted it by name").toBeDefined();
    const props = (tool!.input_schema as { properties?: Record<string, { type?: unknown }> }).properties ?? {};
    expect(Object.keys(props).sort(), "the arguments the caller supplies are in the generated schema").toEqual(
      expect.arrayContaining(["gig_id", "max_turns", "question", "role"]),
    );
    expect(props["gig_id"]?.type, "gig_id is a string").toBe("string");
    expect(props["role"]?.type, "role is a string").toBe("string");
    expect(props["question"]?.type, "question is a string").toBe("string");
    expect(props["max_turns"]?.type, "max_turns is a number").toBe("number");
  });
});

// ── I1 ────────────────────────────────────────────────────────────────────────────────────────────
describe("seat_ask — the answer is attributed to the conversation that produced it (I1)", () => {
  it("I1 — session_id equals sessionUuidFor(gig_id, role) AND the spawn resumes that exact uuid (never opens a fresh one)", async () => {
    const { deps, calls } = harness(() => ANSWER);
    const res = await dispatchTool("seat_ask", { gig_id: GIG, role: ROLE, question: QUESTION }, deps);

    expect(dataOf(res).session_id, "the returned id is the seat's own derived session, not an invented one").toBe(UUID);
    const args = calls[0]!.args;
    expect(valueAfter(args, "--resume"), "the spawn CONTINUES that conversation — --resume names the same uuid").toBe(UUID);
    expect(args, "a resume must never carry --session-id: that opens a FRESH session and the attribution would be a lie").not.toContain("--session-id");
  });
});

// ── I2 ────────────────────────────────────────────────────────────────────────────────────────────
describe("seat_ask — asking changes nothing (I2)", () => {
  it("I2 — a SUCCESSFUL ask seals no output and writes no ledger row: the store and ledger are byte-identical before and after", async () => {
    const { deps, outputs, ledger } = harness(() => ANSWER);
    const outputsBefore = JSON.stringify(outputs.all());
    const ledgerBefore = JSON.stringify(ledger.query());
    const ledgerCountBefore = ledger.count();

    const res = await dispatchTool("seat_ask", { gig_id: GIG, role: ROLE, question: QUESTION }, deps);
    expect(res.ok, "the ask succeeded — otherwise 'changes nothing' is vacuously true").toBe(true);
    expect(dataOf(res).resumed).toBe(true);

    expect(JSON.stringify(outputs.all()), "asking seals NO output — the reconciler holds the record, the seat only reasons").toBe(outputsBefore);
    expect(JSON.stringify(ledger.query()), "asking writes NO ledger row of its own").toBe(ledgerBefore);
    expect(ledger.count(), "the ledger row count is unchanged by the ask").toBe(ledgerCountBefore);
  });
});

// ── F1 ────────────────────────────────────────────────────────────────────────────────────────────
describe("seat_ask — no conversation to ask is a typed refusal, never an invented answer (F1)", () => {
  it("F1 — a lost/absent session returns a typed refusal naming the gig and role, spawns NO fresh seat, and never throws", async () => {
    // The seat never ran (or its session is gone): a --resume finds nothing. The CLI reports this as a
    // result event whose text matches resumeSessionLost ("No conversation found with session ID …").
    const lost = `${JSON.stringify({ type: "result", subtype: "error", is_error: true, result: `No conversation found with session ID ${UUID}` })}\n`;
    const { deps, calls } = harness(() => lost);

    let threw = false;
    const res = await dispatchTool("seat_ask", { gig_id: GIG, role: ROLE, question: QUESTION }, deps).catch((e: unknown) => {
      threw = true;
      return { ok: false, error: e instanceof Error ? e.message : String(e) } as { ok: boolean; error?: string };
    });

    expect(threw, "F1 is RETURNED, never thrown — a throw reaches the caller's surface as an opaque failure").toBe(false);
    expect(res.ok, "no conversation is a refusal, not an answer").toBe(false);
    const text = `${(res as { refusal?: string }).refusal ?? ""} ${(res as { error?: string }).error ?? ""}`;
    expect(text, "the refusal names the gig it could not find").toContain(GIG);
    expect(text, "and the role").toContain(ROLE);

    // NO FRESH SEAT. An answer from a seat that never held the conversation is exactly the invented
    // reasoning this verb exists to prevent, so the ask must NOT fall back cold — no spawn may open a
    // fresh --session-id conversation.
    for (const c of calls) {
      expect(c.args, "a lost session must not fall back to a FRESH seat — that seat would invent the reasoning").not.toContain("--session-id");
    }
  });
});

// ── F2 ────────────────────────────────────────────────────────────────────────────────────────────
describe("seat_ask — an empty answer is returned as an empty answer, never a refusal or a guess (F2)", () => {
  it("F2 — the resumed seat answering with nothing yields { answer: '', resumed: true } — not a refusal, not a filled-in guess", async () => {
    const { deps } = harness(() => ""); // the seat resumed and said nothing
    const res = await dispatchTool("seat_ask", { gig_id: GIG, role: ROLE, question: QUESTION }, deps);

    expect(res.ok, "an empty answer is still an ANSWER — the seat was reached; it is never a refusal").toBe(true);
    expect((res as { refusal?: string }).refusal, "an empty answer must not be dressed up as a refusal").toBeUndefined();
    const d = dataOf(res);
    expect(d.answer, "the empty answer is returned AS empty — never filled in with a guess").toBe("");
    expect(d.resumed, "the seat WAS resumed; the emptiness is the seat's, not the engine's").toBe(true);
  });
});
