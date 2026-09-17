// RED — contract-seat-primer-v1. A primer is primed once per (agent, area), sealed with the blobs
// it read, and forked WARM by any later chair of that agent that names the area; staleness is decided
// by blobs, and every fork is recorded and never cached. Spec: docs/specs/seat-primer.red-spec.md.
//
// The enforcement does not exist yet, so every law here FAILS today on an assertion stating the
// contract's reason — never on an import or a setup error. The laws observe spawns through
// makeClaudeInvoker's injected `run` seam (captured arg lists + prompts) and run through runGig;
// compose-time refusals go through composeStandard. Obligation-by-obligation mechanism and callsite:
// docs/specs/seat-primer.red-spec.md.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeClaudeInvoker, sessionUuidFor } from "../src/claude_invoker.js";
import { createMemoryReuseStore } from "../src/reuse.js";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type DomainType, type AgentInvoker, type AgentInvocationContext, type GigProgressEvent,
} from "../src";
import { testAgent } from "./_support/agents.js";

const REPO = process.cwd();
// A valid RFC 4122 uuid (any version), the shape a named session carries.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const after = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
type CC = GigProgressEvent & Record<string, unknown> & { role?: string };
const isCC = (e: GigProgressEvent, role: string): boolean =>
  e.type === "chair_complete" && (e as CC).role === role;

// ── the Signal-cored output every fixture chair seals, plus the stand-in seat-primer type ──
const SEAL = { source: "fixture://seat-primer" };
const makeStore = () => {
  const r = createRegistry();
  r.registerType({ slug: "raw-note", extends: "Signal", domain: "demo", schema: { properties: { source: { type: "string" } } }, required_fields: [] } as DomainType);
  // The seat-primer type is registered through type_register AFTER this build (out of scope); a
  // permissive stand-in is registered here so the store the enforcement seals into can hold the record.
  r.registerType({ slug: "seat-primer", extends: "Signal", domain: "engine", required_fields: ["agent_slug", "area", "session_id"],
    schema: { properties: { agent_slug: { type: "string" }, area: { type: "string" }, session_id: { type: "string" }, commit: { type: "string" }, files: { type: "array" }, source: { type: "string" } } } } as DomainType);
  return { outputs: createOutputStore(r), ledger: new MemoryLedger() };
};

const senseAgent = (slug: string) =>
  testAgent({ slug, primitives: ["SENSE"], input_types: [], output_types: ["raw-note"], domain: "demo" });
// A single-phase, single-chair standard; chairExtra carries the not-yet-modelled prime/fork_from fields.
const chairDef = (slug: string, chairExtra: Record<string, unknown> = {}) => ({
  slug: "seat-primer-demo", domain: "demo", agents: [senseAgent(slug)],
  phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: slug, depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [], ...chairExtra }] }],
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oneChair = (slug: string, chairExtra: Record<string, unknown> = {}) => composeStandard(chairDef(slug, chairExtra) as any);

// ── stream-json builders: a priming seat READS files, then seals its raw-note in-band ──
const sj = (...evts: unknown[]): string => evts.map((e) => JSON.stringify(e)).join("\n");
const readEvt = (path: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: `read-${path}`, name: "Read", input: { file_path: path } }] } });
const owEvt = (id: string, dt: string, data: unknown) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { domain_type: dt, data } }] } });
const okResult = { type: "result", subtype: "success", is_error: false, result: "done" };
const lostStream = sj({ type: "result", subtype: "error_during_execution", is_error: true, result: "No conversation found with session ID" });
const OW_MCP = { coltrane: { command: "node", args: ["server_entry.js"] } };

// Seal a primer for (agentSlug, area) into a shared store, via the output_write seal path so the
// seat's Read events are on the stream the engine derives the primer's files from.
const primeInto = async (
  base: { outputs: ReturnType<typeof makeStore>["outputs"]; ledger: MemoryLedger },
  agentSlug: string, area: string, gig_id: string,
  o: { files?: string[]; tree_root?: string } = {},
): Promise<void> => {
  const files = o.files ?? ["package.json", "src/version.ts"];
  const stream = sj(...files.map(readEvt), owEvt("w1", "raw-note", SEAL), okResult);
  const invoke = makeClaudeInvoker({ sealVia: "output_write", mcpServerConfigs: OW_MCP, run: () => stream });
  await runGig(oneChair(agentSlug, { role: "prime", prime: { area } }), {}, { ...base, invoke, gig_id, tree_root: o.tree_root ?? REPO } as never);
};

// A text-path invoker that captures every spawn's args (and thus its -p prompt) and seals raw-note.
const capturing = (calls: string[][]): AgentInvoker =>
  makeClaudeInvoker({ run: (_b, args) => { calls.push([...args]); return JSON.stringify(SEAL); } });

// ── O1 / I2 — a prime chair seals a checkable seat-primer record ──────────────────────────────────
describe("O1/I2 — a prime chair seals a seat-primer record derived from its session and its reads", () => {
  it("O1 — the record carries {agent_slug, area, session_id, commit} for the priming seat", async () => {
    const base = makeStore();
    await primeInto(base, "reader", "amend-loop", "gig-prime");
    const primer = base.outputs.all().find((r) => r.domain_type === "seat-primer")?.data as Record<string, unknown> | undefined;
    expect(primer, "a prime chair must seal a seat-primer record; the engine seals none today").toBeTruthy();
    expect(primer!["agent_slug"], "the primer names the agent that sealed it").toBe("reader");
    expect(primer!["area"], "the primer names its area slug").toBe("amend-loop");
    expect(primer!["session_id"], "the primer records the priming seat's own (gig, role) session").toBe(sessionUuidFor("gig-prime", "prime"));
    expect(String(primer!["session_id"]), "which is a valid session uuid").toMatch(UUID);
    expect(typeof primer!["commit"], "the primer records HEAD at seal").toBe("string");
  });

  it("I2 — files is exactly the seat's reads, each with the git blob that was in the tree at seal", async () => {
    const base = makeStore();
    const reads = ["package.json", "src/version.ts"];
    await primeInto(base, "reader", "amend-loop", "gig-prime", { files: reads });
    const primer = base.outputs.all().find((r) => r.domain_type === "seat-primer")?.data as Record<string, unknown> | undefined;
    expect(primer, "no seat-primer sealed, so its files list cannot be checked").toBeTruthy();
    const blob = (p: string): string => execFileSync("git", ["-C", REPO, "hash-object", p]).toString().trim();
    expect(primer!["files"], "files must be exactly the two paths the seat Read, each with its git hash-object value")
      .toEqual(reads.map((p) => ({ path: p, blob_sha: blob(p) })));
  });
});

// ── O2 / I1 — the fork spawn warm-starts, and ONLY when fork_from is declared ──────────────────────
describe("O2/I1 — a fork_from chair warm-starts from its agent's primer; a plain chair does not", () => {
  it("O2 — the fork's first spawn carries --resume <primer sid> --fork-session --session-id <own>", async () => {
    const base = makeStore();
    await primeInto(base, "reader", "amend-loop", "gig-prime");
    const calls: string[][] = [];
    await runGig(oneChair("reader", { fork_from: { primer: "amend-loop" } }), {}, { ...base, invoke: capturing(calls), gig_id: "gig-fork", tree_root: REPO } as never);
    const args = calls[0]!;
    expect(args, "the fork must warm-start via --fork-session; today no fork wiring exists").toContain("--fork-session");
    expect(after(args, "--resume"), "the fork must --resume the primer's own session").toBe(sessionUuidFor("gig-prime", "prime"));
    expect(after(args, "--session-id"), "the fork must open its OWN (gig, role) session under --session-id").toBe(sessionUuidFor("gig-fork", "s"));
  });

  it("I1 — a plain chair (no fork_from) spawns exactly as today: no --fork-session", async () => {
    const base = makeStore();
    // Control: a plain chair never forks — holds today and must keep holding.
    const plain: string[][] = [];
    await runGig(oneChair("plain"), {}, { ...base, invoke: capturing(plain), gig_id: "gig-plain", tree_root: REPO } as never);
    expect(plain[0], "a chair without fork_from must never carry --fork-session").not.toContain("--fork-session");
    // RED half: with a primer present, the fork_from chair DOES fork — the discrimination I1 states.
    await primeInto(base, "plain", "amend-loop", "gig-prime2");
    const forked: string[][] = [];
    await runGig(oneChair("plain", { fork_from: { primer: "amend-loop" } }), {}, { ...base, invoke: capturing(forked), gig_id: "gig-fork2", tree_root: REPO } as never);
    expect(forked[0], "the fork_from chair MUST fork — only it does, and it does").toContain("--fork-session");
  });
});

// ── O3 — chair_complete of a forked chair records forked_from ──────────────────────────────────────
describe("O3 — a forked chair records where it forked from", () => {
  it("chair_complete.forked_from names the primer record's id, session_id and commit", async () => {
    const base = makeStore();
    await primeInto(base, "reader", "amend-loop", "gig-prime");
    let cc: CC | undefined;
    await runGig(oneChair("reader", { fork_from: { primer: "amend-loop" } }), {}, {
      ...base, invoke: capturing([]), gig_id: "gig-fork",
      onProgress: (e: GigProgressEvent) => { if (isCC(e, "s")) cc = e as CC; },
    } as never);
    expect(cc, "no chair_complete for the fork chair").toBeTruthy();
    const ff = cc!["forked_from"] as Record<string, unknown> | undefined;
    expect(ff, "chair_complete must record forked_from for a forked chair; today it records none").toBeTruthy();
    expect(ff!["session_id"], "forked_from names the primer's own session").toBe(sessionUuidFor("gig-prime", "prime"));
    expect(typeof ff!["id"], "forked_from names the primer record's id").toBe("string");
    expect(typeof ff!["commit"], "forked_from records the primer's sealed commit").toBe("string");
  });
});

// ── O4 — staleness is decided by blobs against the working tree ────────────────────────────────────
describe("O4 — files changed since priming are named in the fork prompt and recorded", () => {
  it("a primer file edited after seal is the sole primer_stale_paths entry, and the prompt names it", async () => {
    const root = mkdtempSync(join(tmpdir(), "seat-primer-o4-"));
    try {
      writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
      const g = (...a: string[]): void => { execFileSync("git", ["-C", root, ...a], { stdio: "pipe" }); };
      g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("add", "-A"); g("commit", "-q", "-m", "seed");
      const base = makeStore();
      await primeInto(base, "reader", "amend-loop", "gig-prime", { files: ["a.ts", "b.ts"], tree_root: root });
      // a.ts changes after priming; b.ts does not.
      writeFileSync(join(root, "a.ts"), "export const a = 999;\n");
      const calls: string[][] = [];
      let cc: CC | undefined;
      await runGig(oneChair("reader", { fork_from: { primer: "amend-loop" } }), {}, {
        ...base, invoke: capturing(calls), gig_id: "gig-fork", tree_root: root,
        onProgress: (e: GigProgressEvent) => { if (isCC(e, "s")) cc = e as CC; },
      } as never);
      expect(cc?.["primer_stale_paths"], "the fork must record exactly the paths whose blob changed since priming").toEqual(["a.ts"]);
      expect(after(calls[0]!, "-p") ?? "", "the fork prompt must name the file changed since priming").toContain("a.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── O5 — a forked invocation is never served from the reuse cache ──────────────────────────────────
describe("O5 — a forked invocation is never served from the reuse cache", () => {
  it("the fork chair still runs on a warm cache whose key would otherwise hit", async () => {
    const base = makeStore();
    const reuse = createMemoryReuseStore();
    await primeInto(base, "reader", "amend-loop", "gig-prime");
    const std = oneChair("reader", { fork_from: { primer: "amend-loop" } });
    let cold = 0, warm = 0;
    const coldInvoke: AgentInvoker = () => { cold++; return { ...SEAL }; };
    const warmInvoke: AgentInvoker = () => { warm++; return { ...SEAL }; };
    await runGig(std, {}, { ...base, invoke: coldInvoke, gig_id: "gig-warm-a", tree_root: REPO, reuse } as never);
    expect(cold, "the cold run must invoke the fork chair").toBe(1);
    const r2 = await runGig(std, {}, { ...base, invoke: warmInvoke, gig_id: "gig-warm-b", tree_root: REPO, reuse } as never);
    expect(r2.reuse?.hits.length ?? 0, "the reuse cache must be live in run two (identical bytes)").toBeGreaterThan(0);
    expect(warm, "a forked chair must NOT be served from the cache — its warm conversation is not in the reuse key").toBeGreaterThanOrEqual(1);
  });
});

// ── I3 — a primer is agent-specific ────────────────────────────────────────────────────────────────
describe("I3 — a chair never forks a primer sealed by a different agent, even for the same area", () => {
  it("agent-b's chair forks agent-b's primer, never agent-a's, for a shared area", async () => {
    const base = makeStore();
    await primeInto(base, "agent-a", "shared-area", "gig-a");
    await primeInto(base, "agent-b", "shared-area", "gig-b");
    const calls: string[][] = [];
    await runGig(oneChair("agent-b", { fork_from: { primer: "shared-area" } }), {}, { ...base, invoke: capturing(calls), gig_id: "gig-c", tree_root: REPO } as never);
    const args = calls[0]!;
    expect(args, "agent-b's chair must warm-start").toContain("--fork-session");
    expect(after(args, "--resume"), "agent-b's chair must resume agent-b's primer session").toBe(sessionUuidFor("gig-b", "prime"));
    expect(after(args, "--resume"), "and never agent-a's primer, even for the same area").not.toBe(sessionUuidFor("gig-a", "prime"));
  });
});

// ── F1 — no primer for (agent, area): cold run, recorded, the chair does not fail ──────────────────
describe("F1 — a fork_from chair with no primer runs cold and records the fallback", () => {
  it("no --fork-session, chair_complete.fork_fallback: primer_missing, and the chair does not fail", async () => {
    const base = makeStore();
    const calls: string[][] = [];
    let cc: CC | undefined; let threw = false;
    try {
      await runGig(oneChair("orphan", { fork_from: { primer: "never-primed" } }), {}, {
        ...base, invoke: capturing(calls), gig_id: "gig-orphan", tree_root: REPO,
        onProgress: (e: GigProgressEvent) => { if (isCC(e, "s")) cc = e as CC; },
      } as never);
    } catch { threw = true; }
    expect(threw, "a missing primer must not fail the chair — it runs cold").toBe(false);
    expect(calls[0], "with no primer there is nothing to fork, so no --fork-session").not.toContain("--fork-session");
    expect(String(cc?.["fork_fallback"] ?? ""), "chair_complete must record fork_fallback: primer_missing").toMatch(/primer_missing/);
  });
});

// ── F2 — the primer's session cannot be resumed: cold fallback naming the reason ───────────────────
describe("F2 — a primer whose session cannot be resumed falls back cold and records the reason", () => {
  it("the chair does not fail and chair_complete.fork_fallback names the unresumable session", async () => {
    const base = makeStore();
    await primeInto(base, "reader", "amend-loop", "gig-prime");
    const calls: string[][] = [];
    let cc: CC | undefined; let threw = false;
    // The run seam reports "no conversation" when the fork attempts --resume; a cold spawn seals.
    const invoke = makeClaudeInvoker({ run: (_b, args) => { calls.push([...args]); return args.includes("--resume") ? lostStream : JSON.stringify(SEAL); } });
    try {
      await runGig(oneChair("reader", { fork_from: { primer: "amend-loop" } }), {}, {
        ...base, invoke, gig_id: "gig-fork", tree_root: REPO,
        onProgress: (e: GigProgressEvent) => { if (isCC(e, "s")) cc = e as CC; },
      } as never);
    } catch { threw = true; }
    expect(threw, "an unresumable primer must fall back cold, never fail the chair").toBe(false);
    expect(String(cc?.["fork_fallback"] ?? ""), "chair_complete must record fork_fallback naming the unresumable session").toMatch(/resum|session/i);
  });
});

// ── F3 — composeStandard refuses an ill-formed prime/fork_from chair ───────────────────────────────
describe("F3 — composeStandard refuses prime+fork_from together, or a non-slug area, naming the chair", () => {
  it("both prime and fork_from on one chair is refused, naming the chair and the field", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const both = chairDef("dual", { role: "dual", prime: { area: "a-b" }, fork_from: { primer: "a-b" } }) as any;
    expect(() => composeStandard(both), "a chair declaring BOTH prime and fork_from must be refused").toThrow(/fork_from|prime/i);
    expect(() => composeStandard(both), "the refusal must name the chair").toThrow(/dual/);
  });

  it("a fork_from area that is not a lowercase-hyphen slug is refused", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = chairDef("seat", { fork_from: { primer: "Not A Slug" } }) as any;
    expect(() => composeStandard(bad), "a fork_from area that is not a lowercase-hyphen slug must be refused").toThrow(/fork_from|slug/i);
  });
});
