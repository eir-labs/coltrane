// A CHAIR'S WRITE IS JUDGED ONCE — the in-turn gate and the seal agree; null is absence.
//
// THE DEFECT (live, 26 Sep 2026 — gig cde960ea on the drain, @eir-labs/coltrane@0.24.20):
//   chair "review-change" cannot seal "change-verdict": output rejected: change-verdict failed schema
//   validation — type at /decision_ref: must be string. Nothing was written — a chair's outputs are
//   all-or-nothing.
// `decision_ref` is an OPTIONAL string (domain_types/change-verdict.json). The model sent null — the
// exact message above is reproduced by `validateWrite` on {…, decision_ref: null} (R below). The seal
// is the SECOND gate over one predicate (checkWritable, src/outputs.ts); the first is the in-turn
// output_write in validate mode (src/server.ts), which hands the reason back to the chair so it can
// repair. A seal-time rejection therefore means the chair was never judged in-turn by the same gate.
//
// WHICH SUSPECT IS REAL (read from source, reproduced in G1):
//   (iii) A PATH THAT SKIPS VALIDATE MODE — CONFIRMED. `drainChairInvoker` (src/cli.ts) builds the
//         Claude seat as `makeClaudeInvoker({ registry, model, timeout_ms })`: no `sealVia`, no
//         `mcpServerConfigs`. So a drained Claude seat is a TEXT seat — its per-gig mcp-config holds
//         no engine server, it is offered no output_write, and its final text goes straight to the
//         seal. There is no in-turn gate at all; the seal is the first and only judgment, and its
//         rejection kills the gig with no repair turn. (The drain's completions seats DO seal through
//         a validate-pinned source over the store registry — src/invoker_selection.ts — so the gates
//         agree there by construction.)
//   (i)   The engine MCP child holding a different genome — LATENT, and the fix for (iii) walks into
//         it: the child's genome is `bootstrapServerDeps(COLTRANE_GENOME ?? cwd)`, i.e. the FILE
//         genome, while the drain seals against the ORG STORE's types. Bridging the server door's
//         engine config into the drain unchanged would put a gate in-turn that disagrees with the
//         seal. G1 pins both halves with a store type that differs from the file type.
//   (ii)  A rejection returned without is_error — the MCP wrapper does set `isError: !result.ok`
//         (src/server.ts createColtraneServer), so not the live cause; but captureOutputWrites keys
//         ONLY on is_error and never reads the {ok:false} the server wrote. G2 closes that.
//
// THE LAWS
//   law  kind         drives                                              plant (→ red)
//   G1   behavioural  drainChairInvoker (src/cli.ts) → makeClaudeInvoker's  the drain's engine child built
//                     real spawn + mcp-config → the engine server entry     from the file genome (cwd)
//                     (dist/src/server_entry.js) output_write, validate     instead of the run's registry
//   G2   behavioural  captureOutputWrites — src/claude_invoker.ts          capture keyed only on is_error
//   G3   behavioural  createOutputStore(...).write / validateWrite —       strip for validation only /
//                     src/outputs.ts checkWritable                          strip required fields too
//   G4   behavioural  buildPrompt — src/claude_invoker.ts (shared by the   the absence sentence removed
//                     completions invoker)
//   R    behavioural  runGig → executeChair seal gate — src/runtime.ts     (red now: the live failure)
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync, cpSync, symlinkSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { loadRegistry, createRegistry, domainTypeDefect, type Registry } from "../src/registry.js";
import { bootstrapServerDeps } from "../src/server.js";
import { createOutputStore } from "../src/outputs.js";
import { reconstructGenome } from "../src/genome_store.js";
import { drainChairInvoker } from "../src/cli.js";
import { workOnce } from "../src/worker.js";
import { captureOutputWrites, buildPrompt } from "../src/claude_invoker.js";
import { runGig, MemoryLedger, type Standard, type AgentInvoker } from "../src/index.js";
import { testAgent } from "./_support/agents.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE = fileURLToPath(new URL("./_support/gate_fake_claude.mjs", import.meta.url));
const fileGenome = loadGenome(REPO_ROOT);
const fileRegistry = loadRegistry(fileGenome);

// The live payload's shape: a change-verdict valid in every field but one optional one sent as null.
const VERDICT = {
  checks: [{ method: "ran the law file", target_ref: "tests/x.test.ts", result: "12 passed" }],
  target_ref: "change-set-1",
  pass: true,
  inferred_not_run: [],
  criteria_unmet: [],
  failures_verbatim: [],
  scope_drift: [],
  recommendation: "accept",
} as const;
const LIVE = { ...VERDICT, decision_ref: null };
// Every law hands production its OWN deep copy (`clone`), and the shared fixtures are deep-frozen: a
// store that mutates a caller's object cannot reach another law's input, and the snapshot G3e compares
// against is a string no law can touch. (Round 1's G3e compared a mutated LIVE with a mutated LIVE —
// G3a had handed the shared object to validateWrite uncopied — and could not fail in a full-file run.)
const deepFreeze = <T>(x: T): T => {
  if (x && typeof x === "object") { for (const v of Object.values(x)) deepFreeze(v); Object.freeze(x); }
  return x;
};
deepFreeze(VERDICT);
deepFreeze(LIVE);
const LIVE_SNAPSHOT = JSON.stringify(LIVE);
const clone = <T>(x: T): T => structuredClone(x) as T;

/** What the stand-in claude reports: whether it was offered an engine server, the root that server was
 *  pinned to, and what each output_write answered. */
type Report = {
  offered: boolean; servers?: string[]; genomeRoot?: string; isError?: boolean; crashed?: string;
  result?: { ok?: boolean; error?: string };
  results?: { domain_type: string; isError: boolean; result: { ok?: boolean; error?: string } }[];
};

// ── G1 ─────────────────────────────────────────────────────────────────────────────────────────────
// The run's genome comes from a STORE backing (reconstructGenome — the one reconstruction both store
// backings share), and in it the org's change-verdict is NOT the file's: v2 requires `org_ticket`,
// which the file's closed v1 schema forbids. So the two genomes disagree in BOTH directions:
//   P_ORG_OK   has org_ticket  → the seal (store) accepts; a file-genome gate rejects it
//   P_FILE_OK  lacks it        → the seal (store) rejects; a file-genome gate accepts it
// A gate built from the wrong genome is caught whichever way it leans.
const fileVerdict = fileGenome.domain_types.get("change-verdict")!;
const orgVerdictRow = {
  slug: "change-verdict",
  version: 2,
  extends: "Verdict",
  domain: "software-change",
  status: "active",
  description: "the org's change-verdict: every verdict names the ticket it closes",
  schema: {
    ...(fileVerdict.schema as Record<string, unknown>),
    properties: {
      ...((fileVerdict.schema as { properties: Record<string, unknown> }).properties),
      org_ticket: { type: "string", description: "the org's ticket id" },
    },
  },
  required_fields: [...fileVerdict.required_fields, "org_ticket"],
};
const storeGenome = reconstructGenome({ core_types: [], domain_types: [orgVerdictRow], agents: [], standards: [], skills: [] } as never);
const storeRegistry = loadRegistry(storeGenome);
const P_ORG_OK = { ...clone(VERDICT), org_ticket: "OPS-7" };
const P_FILE_OK = clone(VERDICT);

describe("G1 · one gate: on the drain, what the in-turn output_write accepts the seal accepts, and what the seal rejects the chair is told in-turn", () => {
  let dir: string;
  let savedPath: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV = ["GATE_FAKE_PAYLOAD", "GATE_FAKE_PAYLOADS", "GATE_FAKE_LOG", "COLTRANE_COMPLETIONS_URL", "COLTRANE_PROMPT_MODE", "TMPDIR"];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "coltrane-one-gate-"));
    // `claude` on PATH is the gate-aware stand-in: it starts whatever engine server the invoker's
    // per-gig mcp-config names and calls its output_write, exactly as the CLI would.
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(bin, 0o755);
    savedPath = process.env["PATH"];
    process.env["PATH"] = `${dir}:${savedPath ?? ""}`;
    for (const k of ENV) savedEnv[k] = process.env[k];
    delete process.env["COLTRANE_COMPLETIONS_URL"]; // the drain's Claude seat, not its completions seat
  });
  afterAll(() => {
    process.env["PATH"] = savedPath;
    for (const k of ENV) if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seat one drained Claude chair that sends `data` to output_write; return what the in-turn gate said
   *  (the stand-in's report), what the invoker handed back for sealing, and what the seal would say. */
  async function seat(
    data: Record<string, unknown>,
    tag: string,
    door: { invoke: () => AgentInvoker; sealRegistry: Registry; cwd?: string } = {
      invoke: () => drainChairInvoker({ ...process.env, COLTRANE_COMPLETIONS_URL: undefined }, storeRegistry),
      sealRegistry: storeRegistry,
    },
  ) {
    const logPath = join(dir, `${tag}.json`);
    if (existsSync(logPath)) rmSync(logPath);
    process.env["GATE_FAKE_LOG"] = logPath;
    process.env["GATE_FAKE_PAYLOAD"] = JSON.stringify({
      core_type: "Verdict", domain_type: "change-verdict", gig_id: "gig-one-gate", phase: "review",
      agent_slug: "change-reviewer", data,
    });
    const agent = testAgent({ slug: "change-reviewer", primitives: ["VERIFY"], output_types: ["change-verdict"], domain: "software-change" });
    let returned: unknown;
    let threw: string | undefined;
    const home = process.cwd();
    try {
      if (door.cwd) process.chdir(door.cwd);
      const invoke = door.invoke();
      returned = await invoke({
        agent, phase: "review", role: "review-change", gig_id: "gig-one-gate",
        inputs: [], gig_input: {}, output_types: ["change-verdict"],
      } as never);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    } finally {
      process.chdir(home);
    }
    const report = existsSync(logPath)
      ? (JSON.parse(readFileSync(logPath, "utf8")) as Report)
      : undefined;
    const seal = createOutputStore(door.sealRegistry).validateWrite({ core_type: "Verdict", domain_type: "change-verdict", data });
    return { report, returned, threw, seal };
  }

  it("a payload the seal REJECTS is rejected in-turn first — by the engine server the drain's Claude seat is handed — and the reason reaches the chair", async () => {
    const { report, seal } = await seat(P_FILE_OK, "reject");
    expect(seal.valid, "fixture: the store genome's seal must reject a verdict without org_ticket").toBe(false);
    expect(report, "the stand-in claude was never spawned").toBeDefined();
    expect(
      report!.offered,
      `the drain's Claude seat was offered NO in-turn gate: its mcp-config named servers [${(report!.servers ?? []).join(", ")}] ` +
        `and no engine server — so its text went straight to the seal, which is the first and only judgment ` +
        `(gig cde960ea). drainChairInvoker builds makeClaudeInvoker without sealVia/mcpServerConfigs.`,
    ).toBe(true);
    expect(report!.crashed, `the engine server the seat was handed did not answer: ${report!.crashed}`).toBeUndefined();
    expect(
      report!.result?.ok,
      `the in-turn gate ACCEPTED a payload the seal rejects (${seal.reason}) — the two gates judge by different genomes`,
    ).toBe(false);
    expect(report!.isError, "the rejection must reach the chair flagged as an error").toBe(true);
    expect(String(report!.result?.error), "the chair must be told the seal's own reason").toContain("org_ticket");
  }, 90_000);

  it("a payload the in-turn gate ACCEPTS, the seal accepts — and it is what the invoker hands back for sealing", async () => {
    const { report, returned, threw, seal } = await seat(P_ORG_OK, "accept");
    expect(seal.valid, `fixture: the store genome's seal must accept a verdict with org_ticket: ${seal.reason}`).toBe(true);
    expect(report?.offered, "the drain's Claude seat was offered no in-turn gate at all").toBe(true);
    expect(report!.crashed, `the engine server the seat was handed did not answer: ${report!.crashed}`).toBeUndefined();
    expect(
      report!.result?.ok,
      `the in-turn gate REJECTED a payload the run's seal accepts: ${report!.result?.error} — the seat's engine child ` +
        `judges by a genome that is not the run's`,
    ).toBe(true);
    expect(threw, `the invoker failed a chair whose write passed: ${threw}`).toBeUndefined();
    const sealed = (returned as Record<string, unknown[]>)["change-verdict"];
    expect(sealed, "the accepted write was not handed back for sealing").toEqual([P_ORG_OK]);
  }, 90_000);

  // ── G5 · the reload check (O5) ────────────────────────────────────────────────────────────────────
  // The drain's engine child boots from a genome root WRITTEN from the run's registry and RELOADED by
  // the loader (src/run_genome_engine.ts). A registry can hold a type the loader will not load: the
  // loader runs domainTypeDefect on every file, createRegistry does not. Such a type vanishes on reload,
  // and the child's gate answers "unknown domain_type" (or worse, nothing) where the seal answers by the
  // type — the two gates disagreeing again, one layer down. The only honest answer is to refuse the
  // chair before anything is spawned, naming the type.
  it("G5 · a run-registry type the loader would DROP on reload refuses the chair loudly, naming it — and no claude, no engine child, is spawned", async () => {
    const dropped = {
      slug: "org-refusal-report", extends: "Artifact", domain: "ops",
      schema: { type: "object", properties: { ok: { type: "boolean" }, refusal: { type: "string" }, message: { type: "string" } } },
      required_fields: ["message"],
    };
    expect(domainTypeDefect(dropped), "fixture: the loader must refuse this type on reload").not.toBeNull();
    const runRegistry = createRegistry([...storeRegistry.listTypes(), dropped] as never);
    expect(runRegistry.listTypes().some((t) => t.slug === dropped.slug), "fixture: the run registry holds the type").toBe(true);
    const { report, threw } = await seat(P_ORG_OK, "reload-drop", {
      invoke: () => drainChairInvoker({ ...process.env, COLTRANE_COMPLETIONS_URL: undefined }, runRegistry),
      sealRegistry: runRegistry,
    });
    expect(
      report,
      `the chair was SEATED over a genome root that does not reload as the run's registry — claude was spawned ` +
        `(offered an engine server: ${String(report?.offered)}) with an engine child that has never heard of "${dropped.slug}"`,
    ).toBeUndefined();
    expect(threw, "the chair was neither seated nor refused").toBeDefined();
    expect(threw, `the refusal does not name the type the reload drops: ${threw}`).toContain(dropped.slug);
  }, 90_000);

  // ── G6 · the server door ──────────────────────────────────────────────────────────────────────────
  // The dispatch door (bootstrapServerDeps) bridges the engine server from .mcp.json — `node
  // dist/src/server_entry.js`, a RELATIVE entry — and the child boots `COLTRANE_GENOME ?? cwd`. Nothing
  // ties the claude child's cwd to the root the door was bootstrapped with. So a server bootstrapped on
  // one genome (its explicit root) whose process sits in another directory hands every seat an in-turn
  // gate judging by the CWD's genome — or no gate at all, when the relative entry is not there. Driven
  // exactly so: the run's genome is a root holding the org's change-verdict v2 (org_ticket required);
  // the cwd is a directory holding its OWN genome (the file v1, which forbids org_ticket).
  describe("G6 · the server door: the seat's engine child judges by the run's genome, whatever the cwd", () => {
    let runRoot: string;
    let cwdRoot: string;
    let savedGenome: string | undefined;
    let deps: ReturnType<typeof bootstrapServerDeps>;
    const genomeAt = (root: string, verdict: unknown) => {
      cpSync(join(REPO_ROOT, "core_types"), join(root, "core_types"), { recursive: true });
      cpSync(join(REPO_ROOT, "domain_types"), join(root, "domain_types"), { recursive: true });
      writeFileSync(join(root, "domain_types", "change-verdict.json"), JSON.stringify(verdict, null, 2));
    };
    beforeAll(() => {
      runRoot = mkdtempSync(join(tmpdir(), "coltrane-g6-run-"));
      cwdRoot = mkdtempSync(join(tmpdir(), "coltrane-g6-cwd-"));
      genomeAt(runRoot, orgVerdictRow);
      genomeAt(cwdRoot, JSON.parse(readFileSync(join(REPO_ROOT, "domain_types", "change-verdict.json"), "utf8")));
      // The cwd carries a build too (a checkout usually does), so the relative entry RESOLVES there and
      // the law sees which genome the child judges by — not merely that a relative path went missing.
      symlinkSync(join(REPO_ROOT, "dist"), join(cwdRoot, "dist"), "dir");
      savedGenome = process.env["COLTRANE_GENOME"];
      delete process.env["COLTRANE_GENOME"]; // the door is bootstrapped by ARGUMENT, as a host mounting it would
      deps = bootstrapServerDeps(runRoot);
    });
    afterAll(() => {
      if (savedGenome === undefined) delete process.env["COLTRANE_GENOME"]; else process.env["COLTRANE_GENOME"] = savedGenome;
      rmSync(runRoot, { recursive: true, force: true });
      rmSync(cwdRoot, { recursive: true, force: true });
    });
    const door = () => ({ invoke: () => deps.invoke!, sealRegistry: deps.registry, cwd: cwdRoot });

    it("a payload the run's seal REJECTS is rejected in-turn, with the seal's reason — not judged by the cwd's genome", async () => {
      const { report, seal } = await seat(P_FILE_OK, "g6-reject", door());
      expect(seal.valid, "fixture: the run genome's seal must reject a verdict without org_ticket").toBe(false);
      expect(report?.offered, "the server-door seat was offered no engine server").toBe(true);
      expect(report!.crashed, `the seat's engine child did not answer from cwd ${cwdRoot}: ${report!.crashed}`).toBeUndefined();
      expect(
        report!.result?.ok,
        `the in-turn gate ACCEPTED a payload the run's seal rejects (${seal.reason}) — the child judged by the cwd's genome`,
      ).toBe(false);
      expect(String(report!.result?.error)).toContain("org_ticket");
    }, 90_000);

    it("a payload the run's seal ACCEPTS is accepted in-turn and handed back for sealing", async () => {
      const { report, returned, threw, seal } = await seat(P_ORG_OK, "g6-accept", door());
      expect(seal.valid, `fixture: the run genome's seal must accept a verdict with org_ticket: ${seal.reason}`).toBe(true);
      expect(report?.offered, "the server-door seat was offered no engine server").toBe(true);
      expect(report!.crashed, `the seat's engine child did not answer from cwd ${cwdRoot}: ${report!.crashed}`).toBeUndefined();
      expect(
        report!.result?.ok,
        `the in-turn gate REJECTED a payload the run's seal accepts: ${report!.result?.error} — the child judged by the cwd's genome`,
      ).toBe(true);
      expect(threw, `the invoker failed a chair whose write passed: ${threw}`).toBeUndefined();
      expect((returned as Record<string, unknown[]>)["change-verdict"]).toEqual([P_ORG_OK]);
    }, 90_000);

    it("from a cwd holding NO build and no genome, the seat still gets a working gate that judges by the run's genome", async () => {
      const bare = mkdtempSync(join(tmpdir(), "coltrane-g6-bare-"));
      try {
        const { report, seal } = await seat(P_FILE_OK, "g6-bare", { ...door(), cwd: bare });
        expect(seal.valid, "fixture: the run genome's seal must reject a verdict without org_ticket").toBe(false);
        expect(report?.offered, "the server-door seat was offered no engine server").toBe(true);
        expect(
          report!.crashed,
          `the engine child could not start from a cwd with no dist/ — its entry is resolved against the cwd: ${report!.crashed}`,
        ).toBeUndefined();
        expect(report!.result?.ok, "the in-turn gate accepted a payload the run's seal rejects").toBe(false);
        expect(String(report!.result?.error)).toContain("org_ticket");
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    }, 90_000);
  });

  // ── G7 · the reload proof compares CONTENT, not names (round 3, item 2) ──────────────────────────
  // A type can come back from the round trip under the same slug with a different schema — here a value
  // JSON cannot carry (a Date default comes back a string). A proof over slugs alone calls that "the
  // same registry" and seats a chair whose in-turn gate judges by a schema the seal does not hold.
  it("G7 · a run-registry type whose CONTENT changes on reload refuses the chair, naming it — nothing is spawned", async () => {
    const changed = {
      slug: "org-dated-note", extends: "Verdict", domain: "ops",
      schema: { type: "object", properties: { due: { type: "string", default: new Date(0) } } },
      required_fields: [],
    };
    const runRegistry = createRegistry([...storeRegistry.listTypes(), changed] as never);
    const { report, threw } = await seat(P_ORG_OK, "reload-content", {
      invoke: () => drainChairInvoker({ ...process.env, COLTRANE_COMPLETIONS_URL: undefined }, runRegistry),
      sealRegistry: runRegistry,
    });
    expect(report, `a chair was seated over a root whose "${changed.slug}" reloads with a different schema`).toBeUndefined();
    expect(threw, "the chair was neither seated nor refused").toBeDefined();
    expect(threw, `the refusal does not name the type whose content changed: ${threw}`).toContain(changed.slug);
  }, 90_000);

  // ── G8 · a declared env cannot move the pin (round 3, item 3) ─────────────────────────────────────
  // The server door re-pins the engine entry it finds in the deployment's .mcp.json, and passes that
  // entry's own env through. A declared COLTRANE_GENOME in that env is exactly the pin; if it wins, the
  // child judges by whatever genome the file names. Refused or ignored BY NAME: the child's genome is the
  // door's root whatever the declaration says.
  describe("G8 · a declared engine env cannot override the genome pin", () => {
    let runRoot: string;
    let decoyRoot: string;
    let deps: ReturnType<typeof bootstrapServerDeps>;
    let savedGenome: string | undefined;
    beforeAll(() => {
      runRoot = mkdtempSync(join(tmpdir(), "coltrane-g8-run-"));
      decoyRoot = mkdtempSync(join(tmpdir(), "coltrane-g8-decoy-"));
      for (const [root, verdict] of [[runRoot, orgVerdictRow], [decoyRoot, JSON.parse(readFileSync(join(REPO_ROOT, "domain_types", "change-verdict.json"), "utf8"))]] as const) {
        cpSync(join(REPO_ROOT, "core_types"), join(root, "core_types"), { recursive: true });
        cpSync(join(REPO_ROOT, "domain_types"), join(root, "domain_types"), { recursive: true });
        writeFileSync(join(root, "domain_types", "change-verdict.json"), JSON.stringify(verdict, null, 2));
      }
      writeFileSync(join(runRoot, ".mcp.json"), JSON.stringify({
        mcpServers: { coltrane: { command: "node", args: ["dist/src/server_entry.js"], env: { COLTRANE_GENOME: decoyRoot, DEPLOYMENT_NOTE: "kept" } } },
      }));
      savedGenome = process.env["COLTRANE_GENOME"];
      delete process.env["COLTRANE_GENOME"];
      deps = bootstrapServerDeps(runRoot);
    });
    afterAll(() => {
      if (savedGenome === undefined) delete process.env["COLTRANE_GENOME"]; else process.env["COLTRANE_GENOME"] = savedGenome;
      rmSync(runRoot, { recursive: true, force: true });
      rmSync(decoyRoot, { recursive: true, force: true });
    });

    it("the child judges by the door's root, not the COLTRANE_GENOME the .mcp.json declares — both directions", async () => {
      const bare = mkdtempSync(join(tmpdir(), "coltrane-g8-bare-"));
      try {
        const door = { invoke: () => deps.invoke!, sealRegistry: deps.registry, cwd: bare };
        const rej = await seat(P_FILE_OK, "g8-reject", door);
        expect(rej.seal.valid, "fixture: the door's seal rejects a verdict without org_ticket").toBe(false);
        expect(rej.report?.crashed, `the seat's engine child did not answer: ${rej.report?.crashed}`).toBeUndefined();
        expect(
          rej.report?.result?.ok,
          `the in-turn gate ACCEPTED what the door's seal rejects — the declared env's COLTRANE_GENOME (${decoyRoot}) won over the pin`,
        ).toBe(false);
        expect(String(rej.report?.result?.error)).toContain("org_ticket");
        const acc = await seat(P_ORG_OK, "g8-accept", door);
        expect(acc.report?.result?.ok, `the in-turn gate REJECTED what the door's seal accepts: ${acc.report?.result?.error}`).toBe(true);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    }, 90_000);
  });

  // ── G9 · SLUGS ARE NOT IDENTIFIERS (founder ruling, 27 Sep 2026 — replaces a slug grammar) ─────────
  // The drain's run genome was written as domain_types/<slug>.json, and an org type's slug is a
  // tenant-controlled string: `../../grade556-escaped` wrote $TMPDIR/grade556-escaped.json before the
  // reload proof refused (grade, issuecomment-5847851004). The ruling: the fix is not a grammar — a slug
  // never reaches the filesystem. Every file and directory under the run genome is named by the engine
  // (a content hash or other engine-derived id), and the child finds a type by its slug through what it
  // reads INSIDE the genome, never by joining the slug into a path. Driven through the drain's real door
  // with TMPDIR pointed at a fresh directory, so "anywhere else" is a directory the law can see whole.
  it("G9 · hostile slugs never reach the filesystem: no path under the run genome or its parent carries slug text, nothing lands outside the root, and the child resolves every type", async () => {
    const HOSTILE = [
      "../../escaped-by-slug", "/abs-escaped-by-slug", "nul\u0000escaped-by-slug", "a/b-escaped-by-slug",
      "a\\b-escaped-by-slug", ".", "..", "plain-kebab-type",
    ];
    const STEMS = ["escaped-by-slug", "plain-kebab-type"];
    const hostileTypes = HOSTILE.map((slug) => ({ slug, extends: "Verdict", domain: "ops", schema: { type: "object", properties: {} }, required_fields: [] }));
    const runRegistry = createRegistry([...storeRegistry.listTypes(), ...hostileTypes] as never);
    expect(HOSTILE.every((sl) => runRegistry.listTypes().some((t) => t.slug === sl)), "fixture: the run registry holds every hostile slug").toBe(true);

    const parent = mkdtempSync(join(tmpdir(), "coltrane-g9-parent-"));
    const fresh = join(parent, "tmp");
    mkdirSync(fresh);
    process.env["TMPDIR"] = fresh;
    process.env["GATE_FAKE_PAYLOADS"] = JSON.stringify(HOSTILE.map((slug) => ({
      core_type: "Verdict", domain_type: slug, gig_id: "gig-g9", phase: "review", agent_slug: "change-reviewer",
      data: { checks: [{ method: "m" }], target_ref: "t", pass: true },
    })));
    let out: Awaited<ReturnType<typeof seat>>;
    try {
      out = await seat(P_ORG_OK, "g9", {
        invoke: () => drainChairInvoker({ ...process.env, COLTRANE_COMPLETIONS_URL: undefined }, runRegistry),
        sealRegistry: runRegistry,
      });
    } finally {
      delete process.env["GATE_FAKE_PAYLOADS"];
      if (savedEnv["TMPDIR"] === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = savedEnv["TMPDIR"];
    }
    const walk = (d: string, rel = ""): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const r = rel ? `${rel}/${e.name}` : e.name;
        return e.isDirectory() && !e.isSymbolicLink() ? [r, ...walk(join(d, e.name), r)] : [r];
      });
    try {
      const everything = walk(parent);
      const carrying = everything.filter((p) =>
        STEMS.some((st) => p.includes(st)) ||
        p.split("/").some((seg) => HOSTILE.some((sl) => seg === `${sl}.json` || seg === sl)));
      expect(carrying, `a path under ${parent} carries slug text — a slug reached the filesystem: ${carrying.join(", ")}`).toEqual([]);
      expect(readdirSync(parent), `something was written in the temp root's PARENT: ${readdirSync(parent).join(", ")}`).toEqual(["tmp"]);
      const { report, threw } = out!;
      expect(threw, `the drain refused a registry whose slugs are merely strange: ${threw}`).toBeUndefined();
      expect(report?.offered, "the chair was offered no engine server").toBe(true);
      expect(report!.crashed, `the engine child did not answer: ${report!.crashed}`).toBeUndefined();
      const root = String(report!.genomeRoot);
      expect(root.startsWith(fresh), `the child's genome root ${root} is not under the fresh temp root ${fresh}`).toBe(true);
      const outside = walk(fresh).filter((p) => {
        const abs = join(fresh, p);
        return !abs.startsWith(root) && !root.startsWith(abs) && !/^coltrane-mcp-/.test(p);
      });
      expect(outside, `files were created in the temp root outside the run genome: ${outside.join(", ")}`).toEqual([]);
      for (const r of report!.results ?? []) {
        expect(r.result?.ok, `the child does not resolve type ${JSON.stringify(r.domain_type)}: ${r.result?.error}`).toBe(true);
      }
      expect((report!.results ?? []).length, "the stand-in did not send every hostile type").toBe(HOSTILE.length);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 90_000);

  // ── G10 · an org-shaped registry seats cleanly (round 3, item 4 — read-only shape check) ───────────
  // The grade's strand risk: one type that does not round-trip fails EVERY Claude gig of that org. Before
  // any drain upgrades, a registry shaped like production's largest org (75 kebab slugs, at most 22
  // characters, all six cores, built from store rows through the store's own reconstruction — never by
  // querying production from a test) must seat a chair with a working gate.
  it("G10 · a 75-type org-shaped registry, reconstructed from store rows, seats a chair whose gate works", async () => {
    const CORES = ["Signal", "Interpretation", "Judgment", "Plan", "Artifact", "Verdict"];
    const NOUNS = ["brief", "claim", "clause", "deal", "draft", "finding", "lead", "memo", "note", "plan", "review", "risk", "scope"];
    const rows: Record<string, unknown>[] = [orgVerdictRow];
    for (let i = 0; rows.length < 75; i++) {
      const slug = `${NOUNS[i % NOUNS.length]}-${["intake", "check", "summary", "record", "map", "score"][Math.floor(i / NOUNS.length) % 6]}-${i}`;
      rows.push({
        slug, version: 1 + (i % 3), extends: CORES[i % CORES.length], domain: `org-${i % 5}`, status: "active",
        description: `org type ${i}`,
        schema: { type: "object", properties: { [`field_${i}`]: { type: "string" }, [`count_${i}`]: { type: "integer" } } },
        required_fields: [],
      });
    }
    expect(rows.every((r) => /^[a-z0-9][a-z0-9-]{0,21}$/.test(String(r["slug"]))), "fixture: every slug is production-shaped").toBe(true);
    const genome = reconstructGenome({ core_types: [], domain_types: rows, agents: [], standards: [], skills: [] } as never);
    expect(genome.load_errors, "fixture: the store reconstruction takes all 75").toEqual([]);
    const orgRegistry = loadRegistry(genome);
    expect(orgRegistry.listTypes().length).toBe(75);
    const { report, threw } = await seat(P_ORG_OK, "g10", {
      invoke: () => drainChairInvoker({ ...process.env, COLTRANE_COMPLETIONS_URL: undefined }, orgRegistry),
      sealRegistry: orgRegistry,
    });
    expect(threw, `an org-shaped registry did not seat: ${threw}`).toBeUndefined();
    expect(report?.offered).toBe(true);
    expect(report!.crashed, `the engine child did not answer: ${report!.crashed}`).toBeUndefined();
    expect(report!.result?.ok, `the gate refused a payload its seal accepts: ${report!.result?.error}`).toBe(true);
  }, 90_000);
});

// ── G2 ─────────────────────────────────────────────────────────────────────────────────────────────
// The CLI reports a tool result's `is_error` — but the ENGINE already said what happened, in the
// result's own body: {ok:false, error}. A capture that trusts only the CLI's flag seals a payload the
// gate refused whenever the flag is absent (a CLI build, a relay, a transport that drops it).
const toolUse = (id: string, data: unknown) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { core_type: "Verdict", domain_type: "change-verdict", data } }] } });
const toolResult = (id: string, body: unknown, opts: { is_error?: boolean; asString?: boolean; raw?: boolean } = {}) =>
  JSON.stringify({
    type: "user",
    message: {
      content: [{
        type: "tool_result", tool_use_id: id,
        content: opts.asString
          ? (opts.raw ? String(body) : JSON.stringify(body))
          : [{ type: "text", text: opts.raw ? String(body) : JSON.stringify(body) }],
        ...(opts.is_error !== undefined ? { is_error: opts.is_error } : {}),
      }],
    },
  });
const REFUSED = { ok: false, requires_approval: false, error: "output rejected: change-verdict failed schema validation — type at /decision_ref: must be string" };
const PASSED = { ok: true, requires_approval: false, data: { validated: true, sealed: false, validation_result: { valid: true } } };

describe("G2 · a rejected write is never captured, however the CLI flags it", () => {
  it("an output_write whose result is {ok:false} is not captured when the CLI OMITS is_error (content as blocks, and as a string)", () => {
    for (const asString of [false, true]) {
      const stdout = [toolUse("t1", clone(LIVE)), toolResult("t1", REFUSED, { asString })].join("\n");
      expect(
        captureOutputWrites(stdout, ["change-verdict"]),
        `a write the gate REFUSED was captured for sealing because the CLI did not flag is_error (content as ${asString ? "string" : "blocks"})`,
      ).toEqual({});
    }
  });

  it("an output_write whose result is {ok:false} is not captured when the CLI says is_error:false", () => {
    const stdout = [toolUse("t1", clone(LIVE)), toolResult("t1", REFUSED, { is_error: false })].join("\n");
    expect(captureOutputWrites(stdout, ["change-verdict"]), "a refused write was captured because is_error was false").toEqual({});
  });

  it("the corrected second write after a refusal IS captured — and only it", () => {
    const stdout = [
      toolUse("t1", clone(LIVE)), toolResult("t1", REFUSED),
      toolUse("t2", clone(VERDICT)), toolResult("t2", PASSED),
    ].join("\n");
    expect(captureOutputWrites(stdout, ["change-verdict"])).toEqual({ "change-verdict": [VERDICT] });
  });

  it("an is_error result is still not captured (the flag keeps working)", () => {
    const stdout = [toolUse("t1", clone(LIVE)), toolResult("t1", REFUSED, { is_error: true })].join("\n");
    expect(captureOutputWrites(stdout, ["change-verdict"])).toEqual({});
  });

  // The flag must still count ON ITS OWN. A capture that tested only the body would keep a write whose
  // result the CLI flagged is_error but whose body says nothing parseable (a transport or MCP-layer
  // failure: the server never answered) — or, oddly, says ok:true. Round 1's G2d carried an {ok:false}
  // body beside the flag, so a body-only capture refused it anyway and the law could not see the plant.
  it("an is_error result is not captured when its body is NOT JSON, or says ok:true — the flag alone refuses it", () => {
    for (const [label, body, raw] of [
      ["a non-JSON body", "MCP error -32001: Request timed out", true],
      ["an {ok:true} body", PASSED, false],
    ] as const) {
      for (const asString of [false, true]) {
        const stdout = [toolUse("t1", clone(LIVE)), toolResult("t1", body, { is_error: true, asString, raw })].join("\n");
        expect(
          captureOutputWrites(stdout, ["change-verdict"]),
          `an is_error result with ${label} (content as ${asString ? "string" : "blocks"}) was captured — the flag was ignored`,
        ).toEqual({});
      }
    }
  });
});

// ── G3 ─────────────────────────────────────────────────────────────────────────────────────────────
// A model says "I have no value" as null far more often than by omission. For a property the type does
// NOT require, null and absent mean the same thing, so the ONE predicate both gates share treats them
// the same: the key is removed before validation, hashing and writing. Removed — not validated-around:
// a record whose content_sha differs from the omitted form, or whose data still carries a null against
// a string schema, is a sealed record that lies about its own shape.
const write = (data: Record<string, unknown>) =>
  createOutputStore(fileRegistry).write({
    core_type: "Verdict", domain_type: "change-verdict", domain: "software-change", gig_id: "gig-null",
    agent_slug: "change-reviewer", phase: "review", primitive: "VERIFY", data,
  });

describe("G3 · null on an optional field is absence — in the one predicate both gates share", () => {
  it("the gate accepts a change-verdict whose optional decision_ref is null (the live payload)", () => {
    const v = createOutputStore(fileRegistry).validateWrite({ core_type: "Verdict", domain_type: "change-verdict", data: clone(LIVE) });
    expect(v.valid, `the live payload is still refused: ${v.reason}`).toBe(true);
  });

  it("the SEALED record has no decision_ref key, and its content_sha equals the same payload with the key omitted", () => {
    let rec: ReturnType<typeof write> | undefined;
    expect(() => { rec = write(clone(LIVE)); }, "the live payload does not seal").not.toThrow();
    expect("decision_ref" in rec!.data, `a null was SEALED: data.decision_ref = ${JSON.stringify(rec!.data["decision_ref"])}`).toBe(false);
    const omitted = write(clone(VERDICT));
    expect(rec!.content_sha, "null and omitted seal to different content — the hash saw the null").toBe(omitted.content_sha);
  });

  it("a null on a REQUIRED field is still refused — at validate and at write", () => {
    const data = { ...clone(VERDICT), recommendation: null };
    const v = createOutputStore(fileRegistry).validateWrite({ core_type: "Verdict", domain_type: "change-verdict", data });
    expect(v.valid, "a null on the REQUIRED `recommendation` was accepted").toBe(false);
    // Stripping a required null and then refusing its ABSENCE gives the same verdict for the wrong
    // reason: the chair is told it omitted a field it sent. The refusal names what was SENT.
    expect(v.reason, "the refusal names the field").toMatch(/recommendation/);
    expect(v.reason, `the required null was stripped and the chair told it OMITTED the field: ${v.reason}`).not.toMatch(/required property/);
    expect(() => write(data), "a null on a required field sealed").toThrow(/recommendation/);
  });

  it("a null inside an array member is untouched — the member is still judged, and refused", () => {
    const data = { ...clone(VERDICT), checks: [{ method: "ran the law file", result: null }] };
    const v = createOutputStore(fileRegistry).validateWrite({ core_type: "Verdict", domain_type: "change-verdict", data });
    expect(v.valid, "a null inside checks[0] was stripped; only a top-level optional property is absence").toBe(false);
    const alsoArray = { ...clone(VERDICT), failures_verbatim: ["one", null] };
    const w = createOutputStore(fileRegistry).validateWrite({ core_type: "Verdict", domain_type: "change-verdict", data: alsoArray });
    expect(w.valid, "a null element of an array was dropped from the array").toBe(false);
  });

  it("the caller's object is not mutated by the strip — neither by validateWrite nor by write", () => {
    const asked: Record<string, unknown> = clone(LIVE);
    createOutputStore(fileRegistry).validateWrite({ core_type: "Verdict", domain_type: "change-verdict", data: asked });
    expect(asked, "validateWrite deleted a key from the caller's payload").toEqual(JSON.parse(LIVE_SNAPSHOT));
    const sealed: Record<string, unknown> = clone(LIVE);
    try { write(sealed); } catch { /* G3's other laws own the refusal */ }
    expect(sealed, "write deleted a key from the caller's payload").toEqual(JSON.parse(LIVE_SNAPSHOT));
    expect("decision_ref" in sealed, "the caller's decision_ref key is gone").toBe(true);
  });
});

// ── G4 ─────────────────────────────────────────────────────────────────────────────────────────────
// The engine's rule is only half the fix: a chair that is TOLD how to say "no value" does not spend a
// turn learning it from a refusal. buildPrompt is the one prompt stack — the Claude invoker and the
// completions invoker both build from it — so both branches of its Task layer carry the sentence.
describe("G4 · the brief says how to express absence", () => {
  const agent = testAgent({ slug: "change-reviewer", primitives: ["VERIFY"], output_types: ["change-verdict"], domain: "software-change" });
  const ctx = { agent, phase: "review", role: "review-change", gig_id: "gig-brief", inputs: [], gig_input: {}, output_types: ["change-verdict"] } as never;
  const schema = fileVerdict.schema as Record<string, unknown>;
  const absenceSentence = (prompt: string): string | undefined =>
    prompt.split(/(?<=[.!?])\s+|\n+/).find((s) => /\bomit/i.test(s) && /\bnull\b/i.test(s) && /optional/i.test(s));

  it("the in-band seal brief (output_write) tells the chair to omit an optional field it has no value for, never null", () => {
    const prompt = buildPrompt(ctx, schema, undefined, {
      via: "output_write", gig_id: "gig-brief", agent_slug: "change-reviewer", phase: "review", core_by_type: { "change-verdict": "Verdict" },
    } as never);
    expect(absenceSentence(prompt), "the output_write brief never says: omit an optional field you have no value for; never send null").toBeDefined();
  });

  it("the text seal brief says the same", () => {
    const prompt = buildPrompt(ctx, schema);
    expect(absenceSentence(prompt), "the text-seal brief never says: omit an optional field you have no value for; never send null").toBeDefined();
  });
});

// ── R · the replay ─────────────────────────────────────────────────────────────────────────────────
// Gig cde960ea's chair, replayed through the runtime's own seal gate: a change-verdict whose every
// field is valid but decision_ref, sent null. It must seal, and seal without the key.
describe("R · the live payload seals", () => {
  it("runGig seals a change-verdict carrying decision_ref:null, and the sealed record carries no decision_ref", async () => {
    const reviewer = testAgent({ slug: "change-reviewer", primitives: ["VERIFY"], input_types: [], output_types: ["change-verdict"], domain: "software-change" });
    const standard: Standard = {
      slug: "review-replay", domain: "software-change", agents: [reviewer],
      phases: [{ name: "review", chairs: [{ role: "review-change", agent_slug: "change-reviewer", depends_on: [], input_contract: [], output_contract: ["change-verdict"], required_skills: [] }] }],
    };
    const invoke: AgentInvoker = () => clone(LIVE) as Record<string, unknown>;
    const registry = createRegistry([...fileGenome.domain_types.values()] as never);
    let res: Awaited<ReturnType<typeof runGig>> | undefined;
    let failure: string | undefined;
    try {
      res = await runGig(standard, {}, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke });
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    expect(failure, `the live failure reproduces: ${failure}`).toBeUndefined();
    const sealed = res!.outputs.find((o) => o.domain_type === "change-verdict");
    expect(sealed, "no change-verdict was sealed").toBeDefined();
    expect("decision_ref" in sealed!.data, "the replay sealed a null").toBe(false);
  });
});

// ── G11 · an operator can see WHY (round 3, item 4) ─────────────────────────────────────────────────
// One type that does not round-trip refuses every Claude chair of its org on the drain. That is the
// correct call — the alternative is a gate that disagrees with the seal — but it is only survivable if
// the refusal says which type(s) and why, where an operator looks: the chair's error AND the gig's
// terminal record (the error the worker writes through coltrane_mcp_gig_fail). Driven through workOnce
// with a store stub; the run registry carries one type the loader DROPS on reload (the reserved
// {ok, refusal, message} triple) and one whose CONTENT changes on reload.
describe("G11 · the refusal names the offending type(s) and the reason, in the chair's error and the gig's terminal record", () => {
  const CLAIM = { gig_id: "99999999-2222-3333-4444-555555555555", standard_slug: "wire-run-v0", standard_version: null, mode: "rehearsal", input: {}, acting_for: "steve-1" };
  const ROWS = {
    core_types: [], domain_types: [orgVerdictRow], skills: [],
    agents: [{
      slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["Signal"], domain: "demo",
      identity: "you are scout", method: "1. look 2. report", constraints: [], behavioral_primitives: ["explorer", "critic"],
      permissions: {}, default_skills: [],
    }],
    standards: [{
      slug: "wire-run-v0", domain: "demo", status: "active", output_types: ["Signal"],
      phases: [{ name: "scan", chairs: [{ role: "scan", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], optional_outputs: [], required_skills: [] }] }],
    }],
  };
  const DROPPED = {
    slug: "org-refusal-report", extends: "Artifact", domain: "ops",
    schema: { type: "object", properties: { ok: { type: "boolean" }, refusal: { type: "string" }, message: { type: "string" } } },
    required_fields: ["message"],
  };
  const CHANGED = {
    slug: "org-dated-note", extends: "Verdict", domain: "ops",
    schema: { type: "object", properties: { due: { type: "string", default: new Date(0) } } },
    required_fields: [],
  };
  let stateRoot: string;
  beforeAll(() => {
    stateRoot = mkdtempSync(join(tmpdir(), "coltrane-g11-state-"));
    process.env["COLTRANE_WORKER_CHECKPOINTS"] = stateRoot;
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    delete process.env["COLTRANE_WORKER_CHECKPOINTS"];
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("workOnce fails the gig with an error naming BOTH types and each one's reason, and writes that error to the gig's terminal record", async () => {
    const failed: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (u.endsWith("/rpc/coltrane_mcp_claim")) return new Response(JSON.stringify(CLAIM), { status: 200 });
      if (u.endsWith("/rpc/coltrane_mcp_genome")) return new Response(JSON.stringify(ROWS), { status: 200 });
      if (u.endsWith("/rpc/coltrane_mcp_gig_fail")) { failed.push(String(body["p_error"])); return new Response("true", { status: 200 }); }
      if (u.endsWith("/rpc/coltrane_mcp_gig_outputs")) return new Response("[]", { status: 200 });
      return new Response("null", { status: 200 });
    }));
    const res = await workOnce(
      { baseUrl: "https://store.example", anonKey: "anon", agentToken: "ctk_test000", worker: "g11" },
      {
        makeInvoke: (registry) =>
          drainChairInvoker({ ...process.env, COLTRANE_COMPLETIONS_URL: undefined }, createRegistry([...registry.listTypes(), DROPPED, CHANGED] as never)),
        log: () => {},
      },
    );
    vi.unstubAllGlobals();
    expect((res as { status?: string }).status, "the gig did not fail").toBe("failed");
    const error = String((res as { error?: string }).error);
    for (const where of [["the chair's error", error], ["the gig's terminal record", failed[0] ?? "(nothing written)"]] as const) {
      const [label, text] = where;
      expect(text, `${label} does not name the type the reload DROPS: ${text}`).toContain(DROPPED.slug);
      expect(text, `${label} does not say why it is dropped (the loader's own reason): ${text}`).toMatch(/reserved triple/);
      expect(text, `${label} does not name the type whose CONTENT changes on reload: ${text}`).toContain(CHANGED.slug);
    }
  }, 90_000);
});
