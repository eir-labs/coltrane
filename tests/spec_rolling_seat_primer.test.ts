// RED — contract-rolling-seat-primer-v1. EVERY build primes; the NEXT forks; a primer too large to
// be worth forking is REPLACED, never forked. This rolls the standing seat-primer (contract-seat-
// primer-v1) forward: a chair may now BOTH prime an area AND fork it (same area), the fork seals a
// FRESHER primer that unions the forked reading with its own, every primer records its context size,
// and a `max_context_tokens` ceiling on fork_from stops a bloated primer from being forked at all.
// Spec: docs/specs/rolling-seat-primer.red-spec.md.
//
// The enforcement does NOT exist yet, so every law here FAILS today on an assertion stating the
// contract's reason — never on an import or a setup error. Compose refusals go through
// composeStandard; runtime behaviour is observed through makeClaudeInvoker's injected `run` seam
// (captured arg lists + prompts, and the seat's Read/usage stream) and run through runGig.
//
// TESTING METHOD — example-based, at the two real seams the contract's outputs cross:
//   · composeStandard(def) for the admissibility rule (O1, F1's premise): a specific chair shape is
//     admitted or refused, so an example chair is the exact unit.
//   · runGig over a standard whose chair carries `prime`/`fork_from`, with the spawn's argv and the
//     sealed seat-primer record read back, for the runtime obligations (O2/O3/O4/I1/F1).
// A chair that BOTH primes and forks the same area is the state O1 will ADMIT but composeStandard
// REFUSES today, so the runtime laws attach `fork_from` onto a validly-composed prime-only chair
// (post-compose) to exercise the real runtime Chair shape through runGig without the law dying on the
// compose throw that O1 itself is red against. Each such law states that reason at its callsite.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeClaudeInvoker, sessionUuidFor } from "../src/claude_invoker.js";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type DomainType, type AgentInvoker, type GigProgressEvent,
} from "../src";
import { testAgent } from "./_support/agents.js";

const REPO = process.cwd();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const after = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
type CC = GigProgressEvent & Record<string, unknown> & { role?: string };
const isCC = (e: GigProgressEvent, role: string): boolean =>
  e.type === "chair_complete" && (e as CC).role === role;

// ── the store: raw-note (the fixture seat's substance) + the seat-primer stand-in, now carrying
//    `context_tokens` so the O3/O4 rolling fields have a home the seal can hold ─────────────────────
const SEAL = { source: "fixture://rolling-seat-primer" };
const makeStore = () => {
  const r = createRegistry();
  r.registerType({ slug: "raw-note", extends: "Signal", domain: "demo", schema: { properties: { source: { type: "string" } } }, required_fields: [] } as DomainType);
  r.registerType({ slug: "seat-primer", extends: "Signal", domain: "engine", required_fields: ["agent_slug", "area", "session_id"],
    schema: { properties: {
      agent_slug: { type: "string" }, area: { type: "string" }, session_id: { type: "string" },
      commit: { type: "string" }, files: { type: "array" }, context_tokens: { type: "number" }, source: { type: "string" },
    } } } as DomainType);
  return { outputs: createOutputStore(r), ledger: new MemoryLedger() };
};
type Base = ReturnType<typeof makeStore>;

const senseAgent = (slug: string) =>
  testAgent({ slug, primitives: ["SENSE"], input_types: [], output_types: ["raw-note"], domain: "demo" });
// A single-phase, single-chair standard; chairExtra carries the prime/fork_from fields.
const chairDef = (slug: string, chairExtra: Record<string, unknown> = {}) => ({
  slug: "rolling-seat-primer-demo", domain: "demo", agents: [senseAgent(slug)],
  phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: slug, depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [], ...chairExtra }] }],
});
const oneChair = (slug: string, chairExtra: Record<string, unknown> = {}) => composeStandard(chairDef(slug, chairExtra) as any);

// The shape O1 will ADMIT — a chair that PRIMES an area AND FORKS the same area — built by attaching
// `fork_from` onto a validly-composed prime-only chair. composeStandard REFUSES prime+fork today (that
// is exactly what O1 is red against), so composing it directly would throw before the runtime law
// could run; post-attaching gives runGig the real runtime Chair without that setup throw. `forkExtra`
// carries fork_from's optional fields (e.g. `max_context_tokens`).
const primeAndFork = (slug: string, area: string, forkExtra: Record<string, unknown> = {}) => {
  const std = oneChair(slug, { prime: { area } });
  (std as any).phases[0].chairs[0].fork_from = { primer: area, ...forkExtra };
  return std;
};
// A fork-ONLY chair (post-attached fork_from, no prime) — for the ceiling laws that need no reseal.
const forkOnly = (slug: string, area: string, forkExtra: Record<string, unknown> = {}) => {
  const std = oneChair(slug);
  (std as any).phases[0].chairs[0].fork_from = { primer: area, ...forkExtra };
  return std;
};

// ── stream builders: a seat READS files, may report usage, then seals its raw-note in-band ─────────
const sj = (...evts: unknown[]): string => evts.map((e) => JSON.stringify(e)).join("\n");
const readEvt = (path: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: `read-${path}`, name: "Read", input: { file_path: path } }] } });
// A usage report the way the CLI stream carries it: the seat's context is input + cache_read +
// cache_creation (the SAME sum #seat-metrics folds), and O3 keeps the LAST one before the seal.
const usageEvt = (input: number, cacheRead: number, cacheCreation: number) => ({
  type: "assistant",
  message: { content: [], usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation } },
});
const owEvt = (id: string, dt: string, data: unknown) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { domain_type: dt, data } }] } });
const okResult = { type: "result", subtype: "success", is_error: false, result: "done" };
const OW_MCP = { coltrane: { command: "node", args: ["server_entry.js"] } };

// An output_write-seal invoker over a fixed stream that ALSO captures each spawn's argv (so a law can
// read both the sealed primer AND the fork flags off one run).
const capturingSeal = (calls: string[][], stream: string): AgentInvoker =>
  makeClaudeInvoker({ sealVia: "output_write", mcpServerConfigs: OW_MCP, run: (_b, args) => { calls.push([...args]); return stream; } });
// A text-path invoker that captures argv and seals the raw-note (no rich stream needed).
const capturing = (calls: string[][]): AgentInvoker =>
  makeClaudeInvoker({ run: (_b, args) => { calls.push([...args]); return JSON.stringify(SEAL); } });

// Seal a primer for (agentSlug, area) through the REAL prime path (runGig), so its files/session are
// derived exactly as the engine derives them. `usage` (optional) is reported before the seal so O3
// has a context size to record.
const primeInto = async (
  base: Base, agentSlug: string, area: string, gig_id: string,
  o: { files?: string[]; tree_root?: string; usage?: readonly [number, number, number] } = {},
): Promise<void> => {
  const files = o.files ?? ["package.json", "src/version.ts"];
  const stream = sj(
    ...files.map(readEvt),
    ...(o.usage ? [usageEvt(...o.usage)] : []),
    owEvt("w1", "raw-note", SEAL), okResult,
  );
  const invoke = makeClaudeInvoker({ sealVia: "output_write", mcpServerConfigs: OW_MCP, run: () => stream });
  await runGig(oneChair(agentSlug, { role: "prime", prime: { area } }), {}, { ...base, invoke, gig_id, tree_root: o.tree_root ?? REPO } as never);
};

// Write a seat-primer record DIRECTLY into the store — the input the fork wiring reads back
// (mostRecentSeatPrimer → context_tokens/session_id/files). Used by the ceiling laws (O4/I1), whose
// subject is the FORK decision over a primer of a KNOWN context size — a size O3's derivation does not
// yet stamp, so the record is seeded rather than primed.
const seedPrimer = (
  base: Base,
  o: { agent_slug: string; area: string; session_id: string; context_tokens: number; files?: Array<{ path: string; blob_sha: string }>; commit?: string },
): void => {
  base.outputs.write({
    core_type: "Signal", domain_type: "seat-primer", domain: "demo",
    gig_id: "gig-seed", agent_slug: o.agent_slug, from_role: "prime", phase: "sense", primitive: "SENSE",
    data: {
      agent_slug: o.agent_slug, area: o.area, session_id: o.session_id,
      commit: o.commit ?? "", files: o.files ?? [], context_tokens: o.context_tokens,
      source: `seat-primer://${o.agent_slug}/${o.area}`,
    },
  });
};

const primerOf = (base: Base): Record<string, unknown> | undefined =>
  base.outputs.all().filter((r) => r.domain_type === "seat-primer").map((r) => r.data as Record<string, unknown>).pop();

// ── O1 — composeStandard admits prime+fork of the SAME area, refuses DIFFERENT areas naming both ────
describe("O1 — prime and fork_from may name the SAME area; only DIFFERENT areas are refused", () => {
  it("a chair that primes AND forks the SAME area is ADMITTED (a build primes and the next forks it)", () => {
    const same = chairDef("roller", { prime: { area: "amend-loop" }, fork_from: { primer: "amend-loop" } }) as any;
    expect(
      () => composeStandard(same),
      "prime+fork of the SAME area is the rolling primer itself — a build primes the area and forks the " +
        "prior primer of it — so composeStandard must ADMIT it; today it refuses ALL prime+fork chairs",
    ).not.toThrow();
  });

  it("prime and fork_from naming DIFFERENT areas is refused, naming the chair AND both areas", () => {
    const diff = chairDef("dual", { role: "dual", prime: { area: "area-a" }, fork_from: { primer: "area-b" } }) as any;
    expect(() => composeStandard(diff), "priming one area while forking a different one warm-starts from a reading of the wrong area — refused, naming the chair").toThrow(/dual/);
    expect(() => composeStandard(diff), "the refusal must name the primed area so the author sees the mismatch").toThrow(/area-a/);
    expect(() => composeStandard(diff), "and the forked area — naming only the chair leaves the two areas the author must reconcile unstated").toThrow(/area-b/);
  });
});

// ── O2 — a prime+fork chair seals a FRESHER primer: own session, files UNION forked ∪ own reads ─────
describe("O2 — a chair that forks a primer AND primes the area seals a fresher primer unioning both", () => {
  it("the resealed primer's files are the forked primer's files ∪ its own reads, under its own session", async () => {
    const root = mkdtempSync(join(tmpdir(), "rolling-o2-"));
    try {
      writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
      const g = (...a: string[]): void => { execFileSync("git", ["-C", root, ...a], { stdio: "pipe" }); };
      g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("add", "-A"); g("commit", "-q", "-m", "seed");
      const blob = (p: string): string => execFileSync("git", ["-C", root, "hash-object", p]).toString().trim();
      const base = makeStore();
      // The prior build primed the area, reading a.ts.
      await primeInto(base, "roller", "amend-loop", "gig-prime", { files: ["a.ts"], tree_root: root });
      // This build forks that primer AND primes the area, reading b.ts.
      const calls: string[][] = [];
      const stream = sj(readEvt("b.ts"), owEvt("w1", "raw-note", SEAL), okResult);
      await runGig(primeAndFork("roller", "amend-loop"), {}, { ...base, invoke: capturingSeal(calls, stream), gig_id: "gig-roll", tree_root: root } as never);
      expect(calls[0], "the build must actually fork the prior primer, else there is nothing to union").toContain("--fork-session");
      const primer = primerOf(base);
      expect(primer, "a prime+fork chair must seal a fresh seat-primer").toBeTruthy();
      expect(primer!["session_id"], "the fresher primer carries THIS build's own (gig, role) session — the fork branch the next build resumes")
        .toBe(sessionUuidFor("gig-roll", "s"));
      expect(primer!["files"], "files must be the UNION of the forked primer's files (a.ts) and this seat's reads (b.ts); today the reseal keeps only its own reads and drops the forked reading")
        .toEqual([{ path: "a.ts", blob_sha: blob("a.ts") }, { path: "b.ts", blob_sha: blob("b.ts") }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── O3 — every seat-primer records context_tokens: the LAST usage's context before sealing ──────────
describe("O3 — a seat-primer records the context size the seat carried at seal", () => {
  it("context_tokens = input + cache_read + cache_creation of the LAST usage the seat reported", async () => {
    // Two usages: an early small one, then the last, larger one — O3 keeps the LAST, not the first or the sum.
    const base = makeStore();
    const stream = sj(
      readEvt("package.json"),
      usageEvt(10, 20, 30),        // an early report — 60, must NOT be the recorded value
      usageEvt(100_000, 40_000, 10_000), // the LAST report before sealing — 150_000
      owEvt("w1", "raw-note", SEAL), okResult,
    );
    const invoke = makeClaudeInvoker({ sealVia: "output_write", mcpServerConfigs: OW_MCP, run: () => stream });
    await runGig(oneChair("roller", { role: "prime", prime: { area: "amend-loop" } }), {}, { ...base, invoke, gig_id: "gig-ctx", tree_root: REPO } as never);
    const primer = primerOf(base);
    expect(primer, "a prime chair must seal a seat-primer").toBeTruthy();
    expect(primer!["context_tokens"], "context_tokens must be the LAST usage's input+cache_read+cache_creation (150000); today no primer records a context size at all")
      .toBe(150_000);
  });
});

// ── O4 — a fork_from ceiling: a primer over max_context_tokens is NOT forked, it runs cold ──────────
describe("O4 — fork_from.max_context_tokens: a primer larger than the ceiling is replaced, not forked", () => {
  it("a fork over a too-large primer runs COLD (--session-id, full prompt, no fork) and records fork_fallback: primer_too_large", async () => {
    const base = makeStore();
    seedPrimer(base, { agent_slug: "roller", area: "amend-loop", session_id: sessionUuidFor("gig-seed", "prime")!, context_tokens: 500_000 });
    const calls: string[][] = [];
    let cc: CC | undefined;
    await runGig(forkOnly("roller", "amend-loop", { max_context_tokens: 100_000 }), {}, {
      ...base, invoke: capturing(calls), gig_id: "gig-fork", tree_root: REPO,
      onProgress: (e: GigProgressEvent) => { if (isCC(e, "s")) cc = e as CC; },
    } as never);
    const args = calls[0]!;
    expect(args, "a primer whose context_tokens (500000) exceeds max_context_tokens (100000) must NOT be forked; today the ceiling is ignored and the fork warm-starts").not.toContain("--fork-session");
    expect(args, "a ceiling-blocked fork runs COLD — it opens its own session, it does not --resume the bloated primer").not.toContain("--resume");
    expect(after(args, "--session-id"), "the cold run opens its OWN (gig, role) session with its full prompt").toBe(sessionUuidFor("gig-fork", "s"));
    expect(String(cc?.["fork_fallback"] ?? ""), "chair_complete must record fork_fallback: primer_too_large — the ceiling refusal, stated, never a silent cold run").toMatch(/primer_too_large/);
  });

  it("a ceiling-blocked chair that ALSO primes does not fail, and its cold reads seal a fresh primer", async () => {
    const base = makeStore();
    seedPrimer(base, { agent_slug: "roller", area: "amend-loop", session_id: sessionUuidFor("gig-seed", "prime")!, context_tokens: 500_000, files: [{ path: "a.ts", blob_sha: "deadbeef" }] });
    const calls: string[][] = [];
    let cc: CC | undefined; let threw = false;
    const stream = sj(readEvt("package.json"), owEvt("w1", "raw-note", SEAL), okResult);
    try {
      await runGig(primeAndFork("roller", "amend-loop", { max_context_tokens: 100_000 }), {}, {
        ...base, invoke: capturingSeal(calls, stream), gig_id: "gig-reseal", tree_root: REPO,
        onProgress: (e: GigProgressEvent) => { if (isCC(e, "s")) cc = e as CC; },
      } as never);
    } catch { threw = true; }
    expect(threw, "a ceiling-blocked prime+fork chair runs cold, it never fails").toBe(false);
    expect(calls[0], "the bloated primer is replaced, not forked").not.toContain("--fork-session");
    expect(String(cc?.["fork_fallback"] ?? ""), "the ceiling refusal is recorded as primer_too_large").toMatch(/primer_too_large/);
    // The cold reseal is a FRESH primer from its own reads only — never the 500000-token forked reading.
    const primer = primerOf(base);
    expect(primer!["files"], "the fresh primer carries only the cold seat's own reads (package.json), not the replaced primer's files").toEqual([{ path: "package.json", blob_sha: execFileSync("git", ["-C", REPO, "hash-object", "package.json"]).toString().trim() }]);
  });
});

// ── I1 — with NO ceiling, a fork_from chair forks the latest primer whatever its size ───────────────
describe("I1 — absent max_context_tokens, the fork happens regardless of the primer's size", () => {
  it("a 500000-token primer with no ceiling is forked; a ceiling below it is the ONLY thing that suppresses the fork", async () => {
    const base = makeStore();
    const seededSession = sessionUuidFor("gig-seed", "prime")!;
    seedPrimer(base, { agent_slug: "roller", area: "amend-loop", session_id: seededSession, context_tokens: 500_000 });
    // No ceiling → the fork warm-starts whatever the size (today's behaviour, and it must keep holding).
    const noCeiling: string[][] = [];
    await runGig(forkOnly("roller", "amend-loop"), {}, { ...base, invoke: capturing(noCeiling), gig_id: "gig-nocap", tree_root: REPO } as never);
    expect(noCeiling[0], "with no max_context_tokens the fork must warm-start even a 500000-token primer").toContain("--fork-session");
    expect(after(noCeiling[0]!, "--resume"), "and resume that primer's own session").toBe(seededSession);
    expect(after(noCeiling[0]!, "--resume"), "which is a valid session uuid").toMatch(UUID);
    // The discrimination I1 makes: a ceiling BELOW the size — and only a ceiling — suppresses the fork.
    // This half is red today (O4 unbuilt), which is what pins I1 as the complement of the ceiling rather
    // than a claim that would hold whether or not max_context_tokens ever means anything.
    const withCeiling: string[][] = [];
    await runGig(forkOnly("roller", "amend-loop", { max_context_tokens: 100_000 }), {}, { ...base, invoke: capturing(withCeiling), gig_id: "gig-cap", tree_root: REPO } as never);
    expect(withCeiling[0], "the SAME primer under a ceiling below its size must NOT fork — size gates the fork ONLY through max_context_tokens").not.toContain("--fork-session");
  });
});

// ── F1 — prime+fork the same area with no primer yet: cold, primer_missing, seals the FIRST primer ──
describe("F1 — a prime+fork chair with no primer runs cold and its reads seal the first primer", () => {
  it("prime+fork of the same area is admissible, and with no primer it colds, records primer_missing, and does not fail", async () => {
    // The admissibility is F1's premise: a build that primes-and-forks its area must be composable, or
    // the missing-primer path can never be reached. Red today — composeStandard refuses prime+fork.
    const def = chairDef("roller", { prime: { area: "amend-loop" }, fork_from: { primer: "amend-loop" } }) as any;
    expect(() => composeStandard(def), "prime+fork of one area must be admissible for the no-primer-yet cold path to exist at all").not.toThrow();
    // The runtime cold-reseal: with no primer, the chair runs cold (primer_missing), seals the FIRST
    // primer from its own reads, and never fails. Exercised on the post-attached runtime chair.
    const base = makeStore();
    const calls: string[][] = [];
    let cc: CC | undefined; let threw = false;
    const stream = sj(readEvt("package.json"), owEvt("w1", "raw-note", SEAL), okResult);
    try {
      await runGig(primeAndFork("roller", "amend-loop"), {}, {
        ...base, invoke: capturingSeal(calls, stream), gig_id: "gig-first", tree_root: REPO,
        onProgress: (e: GigProgressEvent) => { if (isCC(e, "s")) cc = e as CC; },
      } as never);
    } catch { threw = true; }
    expect(threw, "a missing primer must not fail a prime+fork chair — it runs cold and seals the first primer").toBe(false);
    expect(calls[0], "with no primer there is nothing to fork").not.toContain("--fork-session");
    expect(String(cc?.["fork_fallback"] ?? ""), "chair_complete records fork_fallback: primer_missing").toMatch(/primer_missing/);
    expect(primerOf(base), "the cold reads seal the FIRST primer for this area").toBeTruthy();
  });
});
