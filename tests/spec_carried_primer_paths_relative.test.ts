// RED — contract-carried-primer-paths-v1. A primer names its files the way the repository does,
// whether the seat READ them or INHERITED them. contract-seat-primer-paths-v1 put every read through
// `toTreeRelative` (src/runtime.ts, the `chair.prime` seal): re-expressed relative to RunDeps.tree_root,
// POSIX-separated, dropped when outside tree_root. But a3e69d2 (contract-primer-reading-frontier-v1)
// normalizes ONLY the reads (`readRel`); the CARRIED files of a forked primer enter `orderedPaths` raw
// from the forked record (src/runtime.ts:3772, `[...forkedFiles.map((f) => f.path), ...readRel]`). So a
// carried absolute path is resealed absolute forever (O1), a carried path outside tree_root is never
// dropped (F1), and a carried absolute spelling plus a relative read of the SAME file become two
// entries (I1). Measured in the change-request: three seat-primers sealed 2026-09-17 before fdb36ff
// (gigs 54f62153, 955f7cc6, 6ea6d047) carry 4, 6 and 8 absolute paths under /Users/…/coltrane, and the
// standing path laws (tests/spec_seat_primer_paths_relative.test.ts) exercise Read events only, so none
// of them saw it. The laws below pin the fix — the carried file obeys the SAME rules as a read:
//   · O1 — a carried ABSOLUTE path under tree_root is resealed as its tree_root-relative POSIX path,
//          keeping the blob the forked primer recorded (the seat did not re-read it).
//   · I1 — a carried file and a read of the SAME file appear ONCE, whatever spelling each used, at the
//          read's blob.
//   · F1 — a carried file whose path resolves OUTSIDE tree_root is absent from the resealed files.
// Spec: docs/specs/carried-primer-paths.red-spec.md.
//
// The enforcement does not exist yet, so every law here FAILS today on an assertion stating the
// contract's reason — never on an import or a setup error.
//
// TESTING METHOD — example-based, at the REAL seal seam, exactly as tests/spec_primer_reading_frontier.
// test.ts drives it: the forked seat-primer is SEEDED directly into the output store, and a prime+fork
// chair is run through runGig with makeClaudeInvoker's injected `run` seam over a real git fixture as
// RunDeps.tree_root. The prime+fork chair reads the seeded primer's `files` (runtime.ts fork wiring,
// `primer_files`), unions them with the seat's own reads, and RESEALS a fresher primer — the diff this
// contract corrects. The invariant here is a specific behavior of that union, so example-based (not a
// universal property) is the fit, matching the standing carried/rolling laws exactly.
//
// CONTROLS (must stay green, unchanged): tests/spec_seat_primer_paths_relative.test.ts,
// tests/spec_primer_reading_frontier.test.ts, tests/spec_rolling_seat_primer.test.ts and
// tests/spec_seat_primer.test.ts — the standing path/frontier/primer laws this contract only extends to
// the carried side; nothing here weakens them.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { makeClaudeInvoker } from "../src/claude_invoker.js";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type DomainType,
} from "../src";
import { testAgent } from "./_support/agents.js";

type File = { path: string; blob_sha: string };

// ── the store: the fixture seat's raw-note plus a permissive seat-primer stand-in (the real type is
//    registered out of scope) carrying `files`, `frontier` and `context_tokens` so the reseal (which
//    seals a frontier for a WRITE seat) has a record to write into ────────────────────────────────────
const SEAL = { source: "fixture://carried-primer-paths" };
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
  slug: "carried-primer-paths-demo", domain: "demo", agents: [senseAgent(slug)],
  phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: slug, depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [], ...chairExtra }] }],
});
const oneChair = (slug: string, chairExtra: Record<string, unknown> = {}) => composeStandard(chairDef(slug, chairExtra) as any);
// The shape contract-rolling-seat-primer-v1 (O1) admits — a chair that BOTH primes AND forks the same
// area — built by attaching fork_from onto a validly-composed prime-only chair (composeStandard refuses
// prime+fork today, so composing it directly would throw before the runtime law could run — the same
// post-attach the frontier/rolling laws use).
const primeAndFork = (slug: string, area: string) => {
  const std = oneChair(slug, { role: "prime", prime: { area } });
  (std as any).phases[0].chairs[0].fork_from = { primer: area };
  return std;
};

// ── stream-json builders: the SAME line shapes a real seat's stdout carries ──────────────────────────
const sj = (...evts: unknown[]): string => evts.map((e) => JSON.stringify(e)).join("\n");
const asst = (uuid: string, content: unknown[]) => ({ type: "assistant", uuid, message: { content } });
const userLine = (uuid: string, content: unknown[]) => ({ type: "user", uuid, message: { content } });
const readUse = (path: string) => ({ type: "tool_use", id: `read:${path}`, name: "Read", input: { file_path: path } });
const editUse = (path: string) => ({ type: "tool_use", id: `edit:${path}`, name: "Edit", input: { file_path: path } });
const trResult = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "ok" });
const owUse = (id: string, dt: string, data: unknown) => ({ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { domain_type: dt, data } });
const okResult = { type: "result", subtype: "success", is_error: false, result: "done" };
const OW_MCP = { coltrane: { command: "node", args: ["server_entry.js"] } };
const FRONT_I1 = "11111111-1111-4111-8111-111111111111";
// A blob the forked primer recorded that is NOT the tree's blob — so "keeping the FORKED blob" (O1) is
// distinguishable from re-blobbing at seal, and "at the READ's blob" (I1) is distinguishable from it too.
const CARRIED_BLOB = "0000000000000000000000000000000000000001";

// A committed git tree_root seeded with the given {relpath: content}. A real repo so the seal's
// chair-start snapshot and blob hashing (the SAME gitInTree seam the runtime uses) resolve.
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
const blobOf = (root: string, rel: string): string => execFileSync("git", ["-C", root, "hash-object", rel], { cwd: root }).toString().trim();

// Seed a forked seat-primer DIRECTLY into the store — the input the fork wiring reads back
// (mostRecentSeatPrimer → files/session_id), whose `files` become the carried `primer_files`.
const seedPrimer = (base: Base, o: { agent_slug: string; area: string; files: File[] }): void => {
  base.outputs.write({
    core_type: "Signal", domain_type: "seat-primer", domain: "demo",
    gig_id: "gig-seed", agent_slug: o.agent_slug, from_role: "prime", phase: "sense", primitive: "SENSE",
    data: {
      agent_slug: o.agent_slug, area: o.area, session_id: "s0",
      commit: "", files: o.files, context_tokens: 1000,
      source: `seat-primer://${o.agent_slug}/${o.area}`,
    },
  });
};

// Run a prime+fork chair whose invoker's injected `run` seam returns `stream`; return the RESEALED
// primer (the last seat-primer — the seeded one was written before the run).
const reseal = async (base: Base, o: { agent: string; area: string; gig_id: string; tree_root: string; stream: string }): Promise<Record<string, unknown> | undefined> => {
  const invoke = makeClaudeInvoker({ sealVia: "output_write", mcpServerConfigs: OW_MCP, run: () => o.stream });
  await runGig(primeAndFork(o.agent, o.area), {}, { ...base, invoke, gig_id: o.gig_id, tree_root: o.tree_root } as never);
  return base.outputs.all().filter((r) => r.domain_type === "seat-primer").map((r) => r.data as Record<string, unknown>).pop();
};

// ── O1 — a carried ABSOLUTE path is resealed tree_root-relative, keeping the forked blob ──────────────
describe("O1 — a carried file whose path is absolute under tree_root is resealed as its tree_root-relative POSIX path", () => {
  it("a carried <root>/src/a.ts the seat did NOT re-read is resealed as src/a.ts at the blob the forked primer recorded", async () => {
    const root = makeTree("carried-paths-o1-", { "src/a.ts": "export const a = 1;\n" });
    try {
      const base = makeStore();
      // The forked primer carries an ABSOLUTE path (the spelling a Read event carries — this is exactly
      // how the 2026-09-17 primers recorded their files), at a blob the primer recorded.
      seedPrimer(base, { agent_slug: "reader", area: "amend-loop", files: [{ path: join(root, "src/a.ts"), blob_sha: CARRIED_BLOB }] });
      // The prime+fork seat seals its raw-note and reads NOTHING — so src/a.ts appears in the reseal only
      // as a CARRIED file, keeping the forked blob (contract-primer-reading-frontier-v1 I1).
      const primer = await reseal(base, { agent: "reader", area: "amend-loop", gig_id: "gig-o1", tree_root: root, stream: sj(asst("s-seal", [owUse("w1", "raw-note", SEAL)]), okResult) });
      expect(primer, "a prime+fork chair must reseal a seat-primer").toBeTruthy();
      expect(primer!["files"],
        "O1 — the carried file must obey the same path rule as a read: an ABSOLUTE checkout path re-expressed RELATIVE to tree_root ('src/a.ts', POSIX separators), keeping the blob the forked primer recorded; today the carried path enters orderedPaths raw (runtime.ts:3772) so it is resealed absolute forever, tying the primer to one machine")
        .toEqual([{ path: "src/a.ts", blob_sha: CARRIED_BLOB }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ── I1 — a carried file and a read of the same file appear ONCE, at the read's blob ───────────────────
describe("I1 — a carried file and a read of the same file appear once, whatever spelling each used", () => {
  it("the forked primer carries <root>/src/a.ts; the seat Reads src/a.ts before its frontier: files has exactly one src/a.ts entry, at the read's blob", async () => {
    const root = makeTree("carried-paths-i1-", { "src/a.ts": "export const a = 1;\n" });
    try {
      const readBlob = blobOf(root, "src/a.ts"); // src/a.ts's chair-start blob — the READ's blob
      expect(readBlob, "the read's blob is genuinely different from the carried blob").not.toBe(CARRIED_BLOB);
      const base = makeStore();
      // The forked primer carries src/a.ts ABSOLUTELY, at the (distinct) carried blob.
      seedPrimer(base, { agent_slug: "reader", area: "amend-loop", files: [{ path: join(root, "src/a.ts"), blob_sha: CARRIED_BLOB }] });
      // The seat Reads src/a.ts RELATIVELY (before its frontier: the read's tool_result is the last user
      // line before the first write), then Edits src/z.ts (its first write), then seals. The read and the
      // carried entry are the SAME file, spelled two ways.
      const primer = await reseal(base, {
        agent: "reader", area: "amend-loop", gig_id: "gig-i1", tree_root: root,
        stream: sj(
          asst("a-read", [readUse("src/a.ts")]),
          userLine(FRONT_I1, [trResult("read:src/a.ts")]),
          asst("z-edit", [editUse("src/z.ts")]),
          asst("s-seal", [owUse("w1", "raw-note", SEAL)]),
          okResult,
        ),
      });
      expect(primer, "a prime+fork chair must reseal a seat-primer").toBeTruthy();
      expect(primer!["files"],
        "I1 — <root>/src/a.ts (carried) and src/a.ts (read) are the SAME file; once both normalize to tree_root-relative they collapse to ONE entry (src/a.ts), at the READ's chair-start blob. Today the carried absolute spelling and the relative read are two distinct strings (runtime.ts:3772 unions the carried path RAW), so the primer records src/a.ts twice — the carried entry absolute at its forked blob, and the read entry relative at the read's blob")
        .toEqual([{ path: "src/a.ts", blob_sha: readBlob }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ── F1 — a carried file resolving outside tree_root is absent from the resealed files ─────────────────
describe("F1 — a carried file whose path resolves outside tree_root is never stored", () => {
  it("a carried file OUTSIDE tree_root is absent from the resealed files, never stored as an absolute path", async () => {
    const root = makeTree("carried-paths-f1-", { "src/a.ts": "export const a = 1;\n" });
    const outside = mkdtempSync(join(tmpdir(), "carried-paths-f1-out-"));
    writeFileSync(join(outside, "elsewhere.ts"), "export const x = 1;\n");
    try {
      const base = makeStore();
      // The forked primer carries an in-tree file AND a file OUTSIDE tree_root (a primer inherited from a
      // run whose checkout sat elsewhere). The seat re-reads neither.
      seedPrimer(base, { agent_slug: "reader", area: "amend-loop", files: [
        { path: join(root, "src/a.ts"), blob_sha: CARRIED_BLOB },
        { path: join(outside, "elsewhere.ts"), blob_sha: CARRIED_BLOB },
      ] });
      const primer = await reseal(base, { agent: "reader", area: "amend-loop", gig_id: "gig-f1", tree_root: root, stream: sj(asst("s-seal", [owUse("w1", "raw-note", SEAL)]), okResult) });
      expect(primer, "a prime+fork chair must reseal a seat-primer").toBeTruthy();
      const paths = (primer!["files"] as File[]).map((f) => f.path);
      expect(paths,
        "F1 — a carried file OUTSIDE tree_root is not part of the area, so ONLY the in-tree carried file (src/a.ts) survives the reseal; today the carried path is never dropped (runtime.ts:3772 unions it RAW, bypassing toTreeRelative's outside-tree_root drop) so the outside file is resealed too")
        .toEqual(["src/a.ts"]);
      expect(paths.some((p) => p.includes(outside)),
        "F1 — the outside carried file must NEVER be resealed, above all never as an absolute path escaping the area; today it is stored verbatim as its absolute path")
        .toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
});
