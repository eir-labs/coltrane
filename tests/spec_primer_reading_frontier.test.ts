// RED — contract-primer-reading-frontier-v1. A seat-primer is forked at its READING FRONTIER: the
// primer records where the seat's reading ended (the last `user` line before the seat's first WRITE
// tool call), a fork resumes the primer's session CUT THERE (`--resume-session-at <frontier>`), the
// primer's context size and files describe the conversation AS CUT (the first-write context, the
// pre-edit blobs, the reads before the frontier only), and an unresolvable frontier falls back cold.
// Spec: docs/specs/primer-reading-frontier.red-spec.md.
//
// The enforcement does NOT exist yet (`git grep resume-session-at`/`primer_frontier` over src/ finds
// nothing but the unrelated dispatch ready-frontier), so every law here FAILS today on an assertion
// stating the contract's reason — never on an import or a setup error.
//
// TESTING METHOD — example-based, at the two real seams the contract's outputs cross, exactly as the
// standing seat-primer laws (tests/spec_seat_primer.test.ts, tests/spec_rolling_seat_primer.test.ts)
// exercise them:
//   · runGig over a PRIME chair whose invoker's injected `run` seam returns a stream-json transcript
//     whose user/assistant lines carry `uuid` fields — the SAME lines a real seat's stdout carries —
//     with the sealed seat-primer read back (O1, O3, O4, I2, I3, F1).
//   · runGig over a FORK chair whose primer is seeded with a `frontier`, with the fork spawn's argv
//     captured through the injected `run` seam (O2, F2).
// Each obligation's mechanism and callsite is in docs/specs/primer-reading-frontier.red-spec.md.
//
// The seat-primer type gains `frontier` through `type_extend` AFTER this build (out of scope). A
// permissive stand-in carrying `frontier` (and `context_tokens`) is registered here so the store the
// enforcement seals into can hold the record — the acceptance criterion's "register your own test
// type rather than editing domain_types/".
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeClaudeInvoker, ChildExitError, sessionUuidFor } from "../src/claude_invoker.js";
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
//    `frontier` and `context_tokens` so the O1/O3 fields have a home the seal can hold ──────────────
const SEAL = { source: "fixture://primer-reading-frontier" };
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
const chairDef = (slug: string, chairExtra: Record<string, unknown> = {}) => ({
  slug: "primer-reading-frontier-demo", domain: "demo", agents: [senseAgent(slug)],
  phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: slug, depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [], ...chairExtra }] }],
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oneChair = (slug: string, chairExtra: Record<string, unknown> = {}) => composeStandard(chairDef(slug, chairExtra) as any);
// A fork-ONLY chair (fork_from, no prime) — composeStandard admits it today, so the fork-arg laws run.
const forkOnly = (slug: string, area: string, forkExtra: Record<string, unknown> = {}) => {
  const std = oneChair(slug);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (std as any).phases[0].chairs[0].fork_from = { primer: area, ...forkExtra };
  return std;
};
// The shape contract-rolling-seat-primer-v1 (O1) admits — a chair that BOTH primes AND forks the same
// area — built by attaching fork_from onto a validly-composed prime-only chair (composeStandard refuses
// prime+fork today, so composing it directly would throw before the runtime law could run — the same
// post-attach the rolling laws use).
const primeAndFork = (slug: string, area: string) => {
  const std = oneChair(slug, { role: "prime", prime: { area } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (std as any).phases[0].chairs[0].fork_from = { primer: area };
  return std;
};

// ── stream-json builders: the SAME line shapes a real seat's stdout carries, each user/assistant line
//    tagged with a `uuid` (O1 derives the frontier from these) ─────────────────────────────────────
const sj = (...evts: unknown[]): string => evts.map((e) => JSON.stringify(e)).join("\n");
type Usage = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
const usage = (i: number, r: number, c: number): Usage => ({ input_tokens: i, cache_read_input_tokens: r, cache_creation_input_tokens: c });
const asst = (uuid: string, content: unknown[], u?: Usage) => ({ type: "assistant", uuid, message: u ? { content, usage: u } : { content } });
const userLine = (uuid: string, content: unknown[]) => ({ type: "user", uuid, message: { content } });
const readUse = (path: string) => ({ type: "tool_use", id: `read:${path}`, name: "Read", input: { file_path: path } });
const editUse = (path: string) => ({ type: "tool_use", id: `edit:${path}`, name: "Edit", input: { file_path: path } });
const trResult = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "ok" });
const owUse = (id: string, dt: string, data: unknown) => ({ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { domain_type: dt, data } });
const okResult = { type: "result", subtype: "success", is_error: false, result: "done" };
const budgetStop = { type: "result", subtype: "error_max_turns", is_error: true, result: "stopped at turn budget" };
const OW_MCP = { coltrane: { command: "node", args: ["server_entry.js"] } };

// Distinct, valid-shaped uuids for the user/assistant lines the frontier is derived from.
const FRONT_O1 = "11111111-1111-4111-8111-111111111111";
const FRONT_O3 = "22222222-2222-4222-8222-222222222222";
const FRONT_O4 = "33333333-3333-4333-8333-333333333333";
const AFTER_O4 = "3a3a3a3a-3333-4333-8333-333333333333";
const FRONT_I2 = "44444444-4444-4444-8444-444444444444";
const SEED_FRONT_O2 = "55555555-5555-4555-8555-555555555555";
const FRONT_F1 = "66666666-6666-4666-8666-666666666666";
const SEED_FRONT_F2 = "77777777-7777-4777-8777-777777777777";

// Run a PRIME chair through the real prime path, its invoker's injected `run` seam returning `stream`
// (a fixed transcript, or a function for a side-effecting / multi-spawn run). Returns the sealed primer.
const primeRun = async (
  base: Base,
  o: { agent: string; area: string; gig_id: string; run: () => string | ((bin: string, args: string[]) => string); tree_root?: string; turn_reserve?: number },
): Promise<Record<string, unknown> | undefined> => {
  const runFn = o.run();
  const invoke = makeClaudeInvoker({
    sealVia: "output_write", mcpServerConfigs: OW_MCP,
    run: typeof runFn === "function" ? (runFn as (b: string, a: string[]) => string) : () => runFn as string,
    ...(o.turn_reserve !== undefined ? { turn_reserve: o.turn_reserve } : {}),
  });
  await runGig(oneChair(o.agent, { role: "prime", prime: { area: o.area } }), {}, { ...base, invoke, gig_id: o.gig_id, tree_root: o.tree_root ?? REPO } as never);
  return base.outputs.all().filter((r) => r.domain_type === "seat-primer").map((r) => r.data as Record<string, unknown>).pop();
};

// Seed a seat-primer record DIRECTLY into the store — the input the fork wiring reads back
// (mostRecentSeatPrimer → session_id/frontier/files). Used by the fork-arg laws (O2/F2), whose subject
// is the FORK spawn over a primer of a KNOWN frontier, not the frontier's derivation (O1).
const seedPrimer = (
  base: Base,
  o: { agent_slug: string; area: string; session_id: string; frontier?: string; files?: Array<{ path: string; blob_sha: string }> },
): void => {
  base.outputs.write({
    core_type: "Signal", domain_type: "seat-primer", domain: "demo",
    gig_id: "gig-seed", agent_slug: o.agent_slug, from_role: "prime", phase: "sense", primitive: "SENSE",
    data: {
      agent_slug: o.agent_slug, area: o.area, session_id: o.session_id,
      commit: "", files: o.files ?? [], context_tokens: 1000,
      ...(o.frontier !== undefined ? { frontier: o.frontier } : {}),
      source: `seat-primer://${o.agent_slug}/${o.area}`,
    },
  });
};

// A text-path invoker that captures each spawn's argv and seals the raw-note.
const capturing = (calls: string[][]): AgentInvoker =>
  makeClaudeInvoker({ run: (_b, args) => { calls.push([...args]); return JSON.stringify(SEAL); } });

// ── O1 — the primer records `frontier`: the last user line before the first WRITE tool call ─────────
describe("O1 — a prime seat's primer records frontier: the uuid of the last user line before its first write", () => {
  it("frontier is the tool_result user line preceding the first Edit, derived by the engine, never typed", async () => {
    const base = makeStore();
    // The seat Reads a.ts (assistant tool_use → user tool_result FRONT_O1), THEN Edits a.ts (its first
    // write). The frontier is the user line that ended its reading: FRONT_O1.
    const primer = await primeRun(base, {
      agent: "reader", area: "amend-loop", gig_id: "gig-o1",
      run: () => sj(
        asst("a-read", [readUse("package.json")]),
        userLine(FRONT_O1, [trResult("read:package.json")]),
        asst("a-edit", [editUse("package.json")]),
        asst("a-seal", [owUse("w1", "raw-note", SEAL)]),
        okResult,
      ),
    });
    expect(primer, "a prime chair must seal a seat-primer").toBeTruthy();
    expect(primer!["frontier"], "the primer must record frontier = the uuid of the last user line before the first write (Edit); today the engine derives and seals no frontier at all")
      .toBe(FRONT_O1);
    expect(String(primer!["frontier"] ?? ""), "the frontier is a real session uuid from the seat's own stream").toMatch(UUID);
  });
});

// ── O2 — a fork of a primer WITH a frontier resumes the session CUT THERE ────────────────────────────
describe("O2 — a fork of a primer with a frontier spawns --resume-session-at <frontier>; a frontier-less primer forks as today", () => {
  it("the fork carries --resume <sid> --resume-session-at <frontier> --fork-session --session-id <own>", async () => {
    const base = makeStore();
    const seededSid = sessionUuidFor("gig-seed", "prime")!;
    seedPrimer(base, { agent_slug: "reader", area: "amend-loop", session_id: seededSid, frontier: SEED_FRONT_O2 });
    const calls: string[][] = [];
    await runGig(forkOnly("reader", "amend-loop"), {}, { ...base, invoke: capturing(calls), gig_id: "gig-fork", tree_root: REPO } as never);
    const args = calls[0]!;
    expect(args, "the fork must warm-start").toContain("--fork-session");
    expect(after(args, "--resume"), "the fork resumes the primer's own session").toBe(seededSid);
    expect(after(args, "--resume-session-at"), "the fork must CUT the resumed conversation at the primer's frontier; today no --resume-session-at is ever emitted, so the fork loads what the seat DID after its reading, not what it READ")
      .toBe(SEED_FRONT_O2);
    expect(after(args, "--session-id"), "the fork opens its own (gig, role) session").toBe(sessionUuidFor("gig-fork", "s"));
  });

  it("a primer with NO frontier forks EXACTLY as today — no --resume-session-at (control that stays green)", async () => {
    const base = makeStore();
    const seededSid = sessionUuidFor("gig-seed", "prime")!;
    seedPrimer(base, { agent_slug: "reader", area: "amend-loop", session_id: seededSid }); // no frontier
    const calls: string[][] = [];
    await runGig(forkOnly("reader", "amend-loop"), {}, { ...base, invoke: capturing(calls), gig_id: "gig-fork2", tree_root: REPO } as never);
    const args = calls[0]!;
    expect(args, "a frontier-less primer still warm-starts").toContain("--fork-session");
    expect(args, "with no frontier there is nothing to cut at, so the whole session resumes and no --resume-session-at is emitted").not.toContain("--resume-session-at");
  });
});

// ── O3 — context_tokens is the FIRST-WRITE context, not the seat's last usage ───────────────────────
describe("O3 — a primer's context_tokens is the context of the assistant line that made the first write", () => {
  it("context_tokens = the first-write assistant usage (conversation up to the frontier), never the last usage after it", async () => {
    const base = makeStore();
    // The Edit (first write) carries context 150000 — the conversation up to and including the frontier.
    // A LATER assistant line carries 900000 (what the seat grew to AFTER its reading). O3 records the
    // former; the max_context_tokens ceiling must weigh the cut conversation, not the seat's whole run.
    const primer = await primeRun(base, {
      agent: "reader", area: "amend-loop", gig_id: "gig-o3",
      run: () => sj(
        asst("a-read", [readUse("package.json")], usage(10, 20, 30)),        // reading usage — 60
        userLine(FRONT_O3, [trResult("read:package.json")]),
        asst("a-edit", [editUse("package.json")], usage(100_000, 40_000, 10_000)), // FIRST WRITE — 150000  (O3 wants this)
        asst("a-seal", [owUse("w1", "raw-note", SEAL)], usage(500_000, 300_000, 100_000)), // last usage — 900000
        okResult,
      ),
    });
    expect(primer, "a prime chair must seal a seat-primer").toBeTruthy();
    expect(primer!["context_tokens"], "context_tokens must be the first-write context (150000 = input+cache_read+cache_creation of the Edit line); today the primer records the LAST usage (900000), the seat's whole run, not the conversation a fork resumes")
      .toBe(150_000);
  });
});

// ── O4 — files describe the conversation AS CUT: pre-edit blobs, and no post-frontier read ───────────
describe("O4 — a primer's files are the conversation as cut: the reads before the frontier, at their chair-start blobs", () => {
  it("a file read-then-edited keeps its chair-start (pre-edit) blob, and a file first read after the frontier is not recorded", async () => {
    const root = mkdtempSync(join(tmpdir(), "frontier-o4-"));
    try {
      writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "c.ts"), "export const c = 3;\n");
      const g = (...a: string[]): void => { execFileSync("git", ["-C", root, ...a], { stdio: "pipe" }); };
      g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("add", "-A"); g("commit", "-q", "-m", "seed");
      const blob = (p: string): string => execFileSync("git", ["-C", root, "hash-object", p]).toString().trim();
      const aStart = blob("a.ts"); // the blob a.ts had when the chair STARTED — the pre-edit blob O4 records
      const base = makeStore();
      // The seat Reads a.ts (before its frontier), EDITS a.ts (its first write — modelled by the run
      // seam mutating a.ts on disk), THEN Reads c.ts (AFTER the frontier). O4: a.ts at its chair-start
      // blob, c.ts excluded entirely.
      const primer = await primeRun(base, {
        agent: "reader", area: "amend-loop", gig_id: "gig-o4", tree_root: root,
        run: () => (): string => {
          writeFileSync(join(root, "a.ts"), "export const a = 999;\n"); // the seat's edit lands on disk
          return sj(
            asst("a-read", [readUse("a.ts")]),
            userLine(FRONT_O4, [trResult("read:a.ts")]),
            asst("a-edit", [editUse("a.ts")]),
            asst("c-read", [readUse("c.ts")]),
            userLine(AFTER_O4, [trResult("read:c.ts")]),
            asst("a-seal", [owUse("w1", "raw-note", SEAL)]),
            okResult,
          );
        },
      });
      expect(primer, "a prime chair must seal a seat-primer").toBeTruthy();
      expect(primer!["files"], "files must be exactly [a.ts at its PRE-EDIT (chair-start) blob]: c.ts was first read AFTER the frontier so it is not part of what the fork loads, and a.ts's post-edit blob is what the seat DID, not what it READ. Today the engine re-blobs every read at seal, recording a.ts's post-edit blob and c.ts too")
        .toEqual([{ path: "a.ts", blob_sha: aStart }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── I1 — a carried file stale at fork time stays stale until a seat re-reads it before its frontier ──
describe("I1 — a carried file stale at fork time stays stale until a seat re-reads it before its frontier", () => {
  it("a prime+fork chair that never Reads x.ts reseals x.ts at its forked blob B1, and the next fork names it stale", async () => {
    const root = mkdtempSync(join(tmpdir(), "frontier-i1-"));
    try {
      writeFileSync(join(root, "x.ts"), "export const x = 1;\n");
      const g = (...a: string[]): void => { execFileSync("git", ["-C", root, ...a], { stdio: "pipe" }); };
      g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("add", "-A"); g("commit", "-q", "-m", "seed");
      const blob = (p: string): string => execFileSync("git", ["-C", root, "hash-object", p]).toString().trim();
      const B1 = blob("x.ts");
      const base = makeStore();
      // P1 primes the area reading x.ts, sealing x.ts@B1.
      await primeRun(base, {
        agent: "roller", area: "amend-loop", gig_id: "gig-p1", tree_root: root,
        run: () => sj(
          asst("x-read", [readUse("x.ts")]),
          userLine("1a1a1a1a-1111-4111-8111-111111111111", [trResult("read:x.ts")]),
          asst("x-edit", [editUse("x.ts")]),
          asst("x-seal", [owUse("w1", "raw-note", SEAL)]),
          okResult,
        ),
      });
      // The tree moves on: x.ts is now B2.
      writeFileSync(join(root, "x.ts"), "export const x = 2;\n");
      const B2 = blob("x.ts");
      expect(B2, "the tree genuinely moved on").not.toBe(B1);
      // A prime+fork chair reseals the area but NEVER Reads x.ts (it seals its raw-note and nothing else).
      const calls: string[][] = [];
      const reInvoke = makeClaudeInvoker({ sealVia: "output_write", mcpServerConfigs: OW_MCP, run: (_b, args) => { calls.push([...args]); return sj(asst("s-seal", [owUse("w1", "raw-note", SEAL)]), okResult); } });
      await runGig(primeAndFork("roller", "amend-loop"), {}, { ...base, invoke: reInvoke, gig_id: "gig-roll", tree_root: root } as never);
      const resealed = base.outputs.all().filter((r) => r.domain_type === "seat-primer").map((r) => r.data as Record<string, unknown>).pop();
      expect(resealed!["files"], "a carried file the seat did NOT re-read keeps its forked blob B1 — the primer describes the reading it inherited, unchanged. Today the reseal re-blobs the carried file against the tree, silently freshening x.ts to B2 and erasing that it is stale")
        .toEqual([{ path: "x.ts", blob_sha: B1 }]);
      // The next fork of that resealed primer therefore names x.ts stale (B1 vs the tree's B2).
      let cc: CC | undefined;
      await runGig(forkOnly("roller", "amend-loop"), {}, {
        ...base, invoke: capturing([]), gig_id: "gig-next", tree_root: root,
        onProgress: (e: GigProgressEvent) => { if (isCC(e, "s")) cc = e as CC; },
      } as never);
      expect(cc?.["primer_stale_paths"], "with x.ts kept at B1 and the tree at B2, the next fork must name x.ts stale; the reseal's silent freshening hides it").toEqual(["x.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── I2 — the frontier and first write are found across EVERY spawn the chair made, in order ──────────
describe("I2 — the frontier and first write are found across every spawn the chair made, in order", () => {
  it("a first run that only Reads and hits its turn cap, then a reserve continuation that Reads then Edits: the frontier is the continuation's Read tool_result, and its file is in files", async () => {
    const base = makeStore();
    // SPAWN 1: Reads a.ts, then hits its turn budget (error_max_turns) — no write yet.
    // SPAWN 2 (reserve continuation): Reads b.ts (tool_result FRONT_I2), THEN Edits b.ts (first write).
    // The frontier and the first write span two spawns; the frontier is FRONT_I2 and b.ts is in files.
    const spawn1 = sj(
      asst("a-read", [readUse("package.json")]),
      userLine("2a2a2a2a-2222-4222-8222-222222222222", [trResult("read:package.json")]),
      budgetStop,
    );
    const spawn2 = sj(
      asst("b-read", [readUse("src/version.ts")]),
      userLine(FRONT_I2, [trResult("read:src/version.ts")]),
      asst("b-edit", [editUse("src/version.ts")]),
      asst("b-seal", [owUse("w1", "raw-note", SEAL)]),
      okResult,
    );
    let n = 0;
    const primer = await primeRun(base, {
      agent: "reader", area: "amend-loop", gig_id: "gig-i2", turn_reserve: 5,
      run: () => (): string => (n++ === 0 ? spawn1 : spawn2),
    });
    expect(primer, "a prime chair must seal a seat-primer").toBeTruthy();
    expect(n, "the chair must have spanned two spawns — a budget stop then a reserve continuation").toBe(2);
    expect(primer!["frontier"], "the frontier must be found across BOTH spawns in order: the last user line before the first write is the CONTINUATION's Read tool_result (FRONT_I2), not a line from the first spawn. Today no frontier is derived at all")
      .toBe(FRONT_I2);
    const files = (primer!["files"] as Array<{ path: string }>) ?? [];
    expect(files.map((f) => f.path), "src/version.ts — read in the continuation, before the frontier — must be in files").toContain("src/version.ts");
  });
});

// ── I3 — a seat that called NO write tool records no frontier; its context/files are as today ────────
describe("I3 — a seat that called no write tool records no frontier, and its context_tokens and files are as today", () => {
  it("a write seat gets a frontier while a read-only seat gets none, its context is its last usage, and its next fork carries no --resume-session-at", async () => {
    // A WRITE seat DOES get a frontier — the discrimination I3 draws (red today, since no frontier is derived).
    const writeBase = makeStore();
    const writePrimer = await primeRun(writeBase, {
      agent: "writer", area: "wq", gig_id: "gig-i3w",
      run: () => sj(
        asst("a-read", [readUse("package.json")]),
        userLine("3b3b3b3b-3333-4333-8333-333333333333", [trResult("read:package.json")]),
        asst("a-edit", [editUse("package.json")]),
        asst("a-seal", [owUse("w1", "raw-note", SEAL)]),
        okResult,
      ),
    });
    expect(writePrimer!["frontier"], "a seat that called a write tool records a frontier — today none is derived, so this half is red").toBe("3b3b3b3b-3333-4333-8333-333333333333");

    // A READ-ONLY seat records NO frontier, its context_tokens is its LAST usage, its files are every read.
    const readBase = makeStore();
    const readPrimer = await primeRun(readBase, {
      agent: "reader", area: "rq", gig_id: "gig-i3r",
      run: () => sj(
        asst("a-read", [readUse("package.json")], usage(1, 2, 3)),
        asst("b-read", [readUse("src/version.ts")], usage(400, 500, 600)), // last usage — 1500
        asst("a-seal", [owUse("w1", "raw-note", SEAL)]),
        okResult,
      ),
    });
    expect(readPrimer!["frontier"], "a seat that never called a write tool records NO frontier — never one guessed from a read").toBeUndefined();
    expect(readPrimer!["context_tokens"], "with no frontier, context_tokens is the seat's LAST usage exactly as today (1500)").toBe(1500);
    // Its next fork carries no --resume-session-at — the whole (read-only) session resumes.
    const calls: string[][] = [];
    await runGig(forkOnly("reader", "rq"), {}, { ...readBase, invoke: capturing(calls), gig_id: "gig-i3f", tree_root: REPO } as never);
    expect(calls[0], "a frontier-less primer's fork resumes the whole session — no --resume-session-at").not.toContain("--resume-session-at");
  });
});

// ── F1 — no user line precedes the first write: no frontier, context_tokens is the last usage ────────
describe("F1 — no user line before the first write records no frontier; a user-preceded write does", () => {
  it("a write with a preceding user line gets that frontier; a write with none gets no frontier and last-usage context", async () => {
    // A write PRECEDED by a user line → that user line is the frontier (red today).
    const withUser = makeStore();
    const p1 = await primeRun(withUser, {
      agent: "reader", area: "wu", gig_id: "gig-f1a",
      run: () => sj(
        asst("a-read", [readUse("package.json")]),
        userLine(FRONT_F1, [trResult("read:package.json")]),
        asst("a-edit", [editUse("package.json")]),
        asst("a-seal", [owUse("w1", "raw-note", SEAL)]),
        okResult,
      ),
    });
    expect(p1!["frontier"], "a write preceded by a user line records that user line as the frontier — red today").toBe(FRONT_F1);

    // A write with NO user line before it → no frontier, context_tokens is the last usage, never a
    // frontier guessed from another line or session.
    const noUser = makeStore();
    const p2 = await primeRun(noUser, {
      agent: "reader", area: "nu", gig_id: "gig-f1b",
      run: () => sj(
        asst("a-edit", [editUse("a.ts")], usage(70_000, 5_000, 0)), // first write, no user line before it — 75000
        asst("a-seal", [owUse("w1", "raw-note", SEAL)], usage(80_000, 10_000, 0)), // last usage — 90000
        okResult,
      ),
    });
    expect(p2!["frontier"], "no user line precedes the first write, so the primer records NO frontier — never one guessed").toBeUndefined();
    expect(p2!["context_tokens"], "with no frontier the context falls back to the last usage (90000), as today").toBe(90_000);
  });
});

// ── F2 — a frontier the primer session does not hold falls back cold, never failing ─────────────────
describe("F2 — a fork whose --resume-session-at names a uuid the primer session does not hold falls back cold", () => {
  it("the chair re-runs cold (--session-id, no --fork-session), never fails, and chair_complete.fork_fallback names the unresolvable frontier", async () => {
    const base = makeStore();
    const seededSid = sessionUuidFor("gig-seed", "prime")!;
    seedPrimer(base, { agent_slug: "reader", area: "amend-loop", session_id: seededSid, frontier: SEED_FRONT_F2 });
    const calls: string[][] = [];
    let cc: CC | undefined; let threw = false;
    // The run seam fails the fork EXACTLY as claude 2.1.274 does (probed 2026-09-18): exit 1, the notice on
    // stderr (so in the exit message), and a stdout result event that carries it ONLY in `errors` — there
    // is no `result` text to match. A cold spawn (no --resume-session-at) seals normally.
    const notice = `No message found with message.uuid of: ${SEED_FRONT_F2}`;
    const invoke = makeClaudeInvoker({
      run: (_b, args) => {
        calls.push([...args]);
        if (args.includes("--resume-session-at")) {
          throw new ChildExitError(`claude exited 1: ${notice}`,
            sj({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, errors: [notice] }));
        }
        return JSON.stringify(SEAL);
      },
    });
    try {
      await runGig(forkOnly("reader", "amend-loop"), {}, {
        ...base, invoke, gig_id: "gig-fork", tree_root: REPO,
        onProgress: (e: GigProgressEvent) => { if (isCC(e, "s")) cc = e as CC; },
      } as never);
    } catch { threw = true; }
    expect(threw, "an unresolvable frontier must fall back cold, never fail the chair").toBe(false);
    expect(String(cc?.["fork_fallback"] ?? ""), "chair_complete.fork_fallback must name the unresolvable frontier; today the fork never cuts at a frontier, so this fallback path does not exist and no fork_fallback is recorded")
      .toContain(SEED_FRONT_F2);
    const cold = calls.filter((a) => !a.includes("--resume-session-at"));
    expect(cold.length, "after the unresolvable frontier the chair must spawn again, cold").toBeGreaterThan(0);
    expect(cold[cold.length - 1], "the cold fallback opens its own --session-id and never --fork-sessions").toContain("--session-id");
    expect(cold[cold.length - 1], "the cold fallback opens its own --session-id and never --fork-sessions").not.toContain("--fork-session");
  });
});
