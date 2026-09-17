// RED — contract-seat-primer-paths-v1. A seat-primer names its files the way the repository does, so
// ANY checkout of the primer's commit can use it. The first real seat-primer (gig 54f62153) recorded
// its files as ABSOLUTE checkout paths (/Users/…/coltrane/src/runtime.ts), because the seat's Read
// events carry absolute paths — tying the primer to one checkout's location. A clone elsewhere (a
// worktree, the drain's workspace, another machine) would find none of its files, so every path would
// compare as stale or unreadable. The laws below pin the fix:
//   · O1 — every recorded path is RELATIVE to RunDeps.tree_root (POSIX separators).
//   · O2 — at fork time, primer paths resolve against the FORKING run's own tree_root, so a primer
//          sealed under one checkout is FRESH in another checkout of the same content.
//   · I1 — the same file read absolutely and relatively appears ONCE, as its tree_root-relative path.
//   · F1 — a Read that names a file OUTSIDE tree_root is NOT recorded (never as an absolute path).
//
// The enforcement does not exist yet, so every law here FAILS today on an assertion stating the
// contract's reason — never on an import or a setup error. The seal path is exercised through the REAL
// callsites: a PRIME chair run through runGig, whose seat-primer `files` are derived (runtime.ts, the
// `chair.prime` seal) from the invoker's forwarded Read events (claude_invoker.ts `captureReadPaths`);
// and the FORK-time blob staleness comparison (runtime.ts, the `chair.fork_from` prep). The seat's
// Read events are emitted through makeClaudeInvoker's injected `run` seam with ABSOLUTE paths under a
// temporary git tree_root. Spec: docs/specs/seat-primer-paths.red-spec.md.
//
// CONTROLS (must stay green, unchanged): tests/spec_seat_primer.test.ts and
// tests/spec_rolling_seat_primer.test.ts — the standing primer/rolling-primer laws whose paths this
// contract only re-anchors; nothing here weakens them.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { makeClaudeInvoker, sessionUuidFor } from "../src/claude_invoker.js";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type DomainType, type AgentInvoker, type GigProgressEvent,
} from "../src";
import { testAgent } from "./_support/agents.js";

type CC = GigProgressEvent & Record<string, unknown> & { role?: string };
const isCC = (e: GigProgressEvent, role: string): boolean =>
  e.type === "chair_complete" && (e as CC).role === role;
type File = { path: string; blob_sha: string };

// ── the store: the fixture seat's raw-note plus a permissive seat-primer stand-in (the real type is
//    registered out of scope, via type_register) so the seal has a record to write into ──────────────
const SEAL = { source: "fixture://seat-primer-paths" };
const makeStore = () => {
  const r = createRegistry();
  r.registerType({ slug: "raw-note", extends: "Signal", domain: "demo", schema: { properties: { source: { type: "string" } } }, required_fields: [] } as DomainType);
  r.registerType({ slug: "seat-primer", extends: "Signal", domain: "engine", required_fields: ["agent_slug", "area", "session_id"],
    schema: { properties: { agent_slug: { type: "string" }, area: { type: "string" }, session_id: { type: "string" }, commit: { type: "string" }, files: { type: "array" }, source: { type: "string" } } } } as DomainType);
  return { outputs: createOutputStore(r), ledger: new MemoryLedger() };
};
type Base = ReturnType<typeof makeStore>;

const senseAgent = (slug: string) =>
  testAgent({ slug, primitives: ["SENSE"], input_types: [], output_types: ["raw-note"], domain: "demo" });
const chairDef = (slug: string, chairExtra: Record<string, unknown> = {}) => ({
  slug: "seat-primer-paths-demo", domain: "demo", agents: [senseAgent(slug)],
  phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: slug, depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [], ...chairExtra }] }],
});
const oneChair = (slug: string, chairExtra: Record<string, unknown> = {}) => composeStandard(chairDef(slug, chairExtra) as any);

// ── stream-json builders: a priming seat READS files (paths as literally given), then seals in-band ──
const sj = (...evts: unknown[]): string => evts.map((e) => JSON.stringify(e)).join("\n");
const readEvt = (path: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: `read-${path}`, name: "Read", input: { file_path: path } }] } });
const owEvt = (id: string, dt: string, data: unknown) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { domain_type: dt, data } }] } });
const okResult = { type: "result", subtype: "success", is_error: false, result: "done" };
const OW_MCP = { coltrane: { command: "node", args: ["server_entry.js"] } };

// A committed git tree_root seeded with the given {relpath: content}. A real repo so the seal's
// `git rev-parse HEAD` and `git hash-object` (the SAME gitInTree seam the runtime uses) resolve.
const makeTree = (prefix: string, files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const g = (...a: string[]): void => { execFileSync("git", ["-C", root, ...a], { stdio: "pipe" }); };
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("add", "-A"); g("commit", "-q", "-m", "seed");
  return root;
};
const blobOf = (root: string, rel: string): string => execFileSync("git", ["-C", root, "hash-object", rel]).toString().trim();

// Prime a chair whose seat READS the given paths (VERBATIM — absolute or relative), sealing the
// seat-primer under `tree_root` through the real runGig prime path.
const primeReading = async (base: Base, agentSlug: string, area: string, gig_id: string, readPaths: string[], tree_root: string): Promise<void> => {
  const stream = sj(...readPaths.map(readEvt), owEvt("w1", "raw-note", SEAL), okResult);
  const invoke = makeClaudeInvoker({ sealVia: "output_write", mcpServerConfigs: OW_MCP, run: () => stream });
  await runGig(oneChair(agentSlug, { role: "prime", prime: { area } }), {}, { ...base, invoke, gig_id, tree_root } as never);
};
// A text-path invoker that captures every spawn's argv (and thus its --fork-session/--resume flags).
const capturing = (calls: string[][]): AgentInvoker =>
  makeClaudeInvoker({ run: (_b, args) => { calls.push([...args]); return JSON.stringify(SEAL); } });

const lastPrimer = (base: Base): Record<string, unknown> | undefined =>
  base.outputs.all().filter((r) => r.domain_type === "seat-primer").map((r) => r.data as Record<string, unknown>).pop();

// ── O1 — an absolutely-named Read is recorded RELATIVE to tree_root (POSIX) ─────────────────────────
describe("O1 — a seat-primer records each file relative to RunDeps.tree_root", () => {
  it("a Read event naming an ABSOLUTE path is recorded as its tree_root-relative POSIX path", async () => {
    const root = makeTree("primer-paths-o1-", { "src/a.ts": "export const a = 1;\n" });
    try {
      const base = makeStore();
      await primeReading(base, "reader", "amend-loop", "gig-prime", [join(root, "src/a.ts")], root);
      const primer = lastPrimer(base);
      expect(primer, "a prime chair must seal a seat-primer record").toBeTruthy();
      const files = primer!["files"] as File[];
      expect(files.map((f) => f.path),
        "O1 — the seat Read an ABSOLUTE path, but the primer must record it RELATIVE to tree_root ('src/a.ts', POSIX separators) so ANY checkout of this commit can locate the file; today the absolute checkout path is stored verbatim, tying the primer to one machine")
        .toEqual(["src/a.ts"]);
      expect(files[0]!.blob_sha, "the relative entry still carries the file's git blob under tree_root").toBe(blobOf(root, "src/a.ts"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ── I1 — the same file read absolutely AND relatively appears ONCE, as src/a.ts ────────────────────
describe("I1 — the same file read absolutely and relatively appears once in files", () => {
  it("Read events for <root>/src/a.ts and src/a.ts under tree_root <root>: files has exactly one entry, src/a.ts", async () => {
    const root = makeTree("primer-paths-i1-", { "src/a.ts": "export const a = 1;\n" });
    try {
      const base = makeStore();
      // The SAME file, named both ways — the absolute form the Read tool carries and the bare relative form.
      await primeReading(base, "reader", "amend-loop", "gig-prime", [join(root, "src/a.ts"), "src/a.ts"], root);
      const primer = lastPrimer(base);
      expect(primer, "a prime chair must seal a seat-primer record").toBeTruthy();
      expect(primer!["files"],
        "I1 — <root>/src/a.ts and src/a.ts are the SAME file; once both normalize to tree_root-relative they collapse to ONE entry (src/a.ts); today they are two distinct strings and the primer records the file twice")
        .toEqual([{ path: "src/a.ts", blob_sha: blobOf(root, "src/a.ts") }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ── F1 — a Read outside tree_root is NOT recorded (never as an absolute path) ───────────────────────
describe("F1 — a Read event naming a file outside tree_root is not recorded in files", () => {
  it("a file read OUTSIDE tree_root is absent from files, never stored as an absolute path", async () => {
    const root = makeTree("primer-paths-f1-", { "src/a.ts": "export const a = 1;\n" });
    const outside = mkdtempSync(join(tmpdir(), "primer-paths-f1-out-"));
    writeFileSync(join(outside, "elsewhere.ts"), "export const x = 1;\n");
    try {
      const base = makeStore();
      await primeReading(base, "reader", "amend-loop", "gig-prime", [join(root, "src/a.ts"), join(outside, "elsewhere.ts")], root);
      const primer = lastPrimer(base);
      expect(primer, "a prime chair must seal a seat-primer record").toBeTruthy();
      const paths = (primer!["files"] as File[]).map((f) => f.path);
      expect(paths,
        "F1 — a file read OUTSIDE tree_root is not part of the area, so ONLY the in-tree file (src/a.ts) is recorded; today the outside file is folded in as well")
        .toEqual(["src/a.ts"]);
      expect(paths.some((p) => p.includes(outside)),
        "F1 — the outside file must NEVER be recorded, and above all never as an absolute path escaping the area; today it is stored verbatim as its absolute path")
        .toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
});

// ── O2 — a primer sealed under one checkout is FRESH in another checkout of the same content ─────────
describe("O2 — at fork time, primer paths resolve against the forking run's own tree_root", () => {
  it("a primer sealed under one checkout path is fresh when forked from another checkout of the same content", async () => {
    const content = "export const a = 1;\n";
    // The ORIGINAL checkout: the priming seat reads an absolute path here and seals the primer.
    const treeA = makeTree("primer-paths-o2-a-", { "src/a.ts": content });
    const base = makeStore();
    await primeReading(base, "reader", "amend-loop", "gig-prime", [join(treeA, "src/a.ts")], treeA);
    // That checkout is gone — the fork runs in a DIFFERENT checkout (another worktree/machine) whose
    // src/a.ts is byte-identical. The original absolute path no longer resolves anywhere.
    rmSync(treeA, { recursive: true, force: true });
    const treeB = makeTree("primer-paths-o2-b-", { "src/a.ts": content });
    try {
      const calls: string[][] = [];
      let cc: CC | undefined;
      await runGig(oneChair("reader", { fork_from: { primer: "amend-loop" } }), {}, {
        ...base, invoke: capturing(calls), gig_id: "gig-fork", tree_root: treeB,
        onProgress: (e: GigProgressEvent) => { if (isCC(e, "s")) cc = e as CC; },
      } as never);
      expect(calls[0], "the fork must warm-start from the primer for staleness to be computed at all").toContain("--fork-session");
      expect(cc?.["primer_stale_paths"],
        "O2 — src/a.ts is byte-identical in this checkout, so NOTHING is stale; the primer's paths must resolve against the FORKING run's own tree_root; today the primer recorded src/a.ts's ABSOLUTE path under the now-deleted original checkout, which this tree_root cannot hash, so the file is falsely reported stale")
        .toEqual([]);
    } finally { rmSync(treeB, { recursive: true, force: true }); }
  });
});
