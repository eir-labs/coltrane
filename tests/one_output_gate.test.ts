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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { loadRegistry, createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { reconstructGenome } from "../src/genome_store.js";
import { drainChairInvoker } from "../src/cli.js";
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
const P_ORG_OK = { ...VERDICT, org_ticket: "OPS-7" };
const P_FILE_OK = { ...VERDICT };

describe("G1 · one gate: on the drain, what the in-turn output_write accepts the seal accepts, and what the seal rejects the chair is told in-turn", () => {
  let dir: string;
  let savedPath: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV = ["GATE_FAKE_PAYLOAD", "GATE_FAKE_LOG", "COLTRANE_COMPLETIONS_URL", "COLTRANE_PROMPT_MODE"];

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
  async function seat(data: Record<string, unknown>, tag: string) {
    const logPath = join(dir, `${tag}.json`);
    if (existsSync(logPath)) rmSync(logPath);
    process.env["GATE_FAKE_LOG"] = logPath;
    process.env["GATE_FAKE_PAYLOAD"] = JSON.stringify({
      core_type: "Verdict", domain_type: "change-verdict", gig_id: "gig-one-gate", phase: "review",
      agent_slug: "change-reviewer", data,
    });
    const invoke = drainChairInvoker({ ...process.env, COLTRANE_COMPLETIONS_URL: undefined }, storeRegistry);
    const agent = testAgent({ slug: "change-reviewer", primitives: ["VERIFY"], output_types: ["change-verdict"], domain: "software-change" });
    let returned: unknown;
    let threw: string | undefined;
    try {
      returned = await invoke({
        agent, phase: "review", role: "review-change", gig_id: "gig-one-gate",
        inputs: [], gig_input: {}, output_types: ["change-verdict"],
      } as never);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    const report = existsSync(logPath)
      ? (JSON.parse(readFileSync(logPath, "utf8")) as { offered: boolean; servers?: string[]; isError?: boolean; result?: { ok?: boolean; error?: string }; crashed?: string })
      : undefined;
    const seal = createOutputStore(storeRegistry).validateWrite({ core_type: "Verdict", domain_type: "change-verdict", data });
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
});

// ── G2 ─────────────────────────────────────────────────────────────────────────────────────────────
// The CLI reports a tool result's `is_error` — but the ENGINE already said what happened, in the
// result's own body: {ok:false, error}. A capture that trusts only the CLI's flag seals a payload the
// gate refused whenever the flag is absent (a CLI build, a relay, a transport that drops it).
const toolUse = (id: string, data: unknown) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { core_type: "Verdict", domain_type: "change-verdict", data } }] } });
const toolResult = (id: string, body: unknown, opts: { is_error?: boolean; asString?: boolean } = {}) =>
  JSON.stringify({
    type: "user",
    message: {
      content: [{
        type: "tool_result", tool_use_id: id,
        content: opts.asString ? JSON.stringify(body) : [{ type: "text", text: JSON.stringify(body) }],
        ...(opts.is_error !== undefined ? { is_error: opts.is_error } : {}),
      }],
    },
  });
const REFUSED = { ok: false, requires_approval: false, error: "output rejected: change-verdict failed schema validation — type at /decision_ref: must be string" };
const PASSED = { ok: true, requires_approval: false, data: { validated: true, sealed: false, validation_result: { valid: true } } };

describe("G2 · a rejected write is never captured, however the CLI flags it", () => {
  it("an output_write whose result is {ok:false} is not captured when the CLI OMITS is_error (content as blocks, and as a string)", () => {
    for (const asString of [false, true]) {
      const stdout = [toolUse("t1", LIVE), toolResult("t1", REFUSED, { asString })].join("\n");
      expect(
        captureOutputWrites(stdout, ["change-verdict"]),
        `a write the gate REFUSED was captured for sealing because the CLI did not flag is_error (content as ${asString ? "string" : "blocks"})`,
      ).toEqual({});
    }
  });

  it("an output_write whose result is {ok:false} is not captured when the CLI says is_error:false", () => {
    const stdout = [toolUse("t1", LIVE), toolResult("t1", REFUSED, { is_error: false })].join("\n");
    expect(captureOutputWrites(stdout, ["change-verdict"]), "a refused write was captured because is_error was false").toEqual({});
  });

  it("the corrected second write after a refusal IS captured — and only it", () => {
    const stdout = [
      toolUse("t1", LIVE), toolResult("t1", REFUSED),
      toolUse("t2", VERDICT), toolResult("t2", PASSED),
    ].join("\n");
    expect(captureOutputWrites(stdout, ["change-verdict"])).toEqual({ "change-verdict": [VERDICT] });
  });

  it("an is_error result is still not captured (the flag keeps working)", () => {
    const stdout = [toolUse("t1", LIVE), toolResult("t1", REFUSED, { is_error: true })].join("\n");
    expect(captureOutputWrites(stdout, ["change-verdict"])).toEqual({});
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
    const v = createOutputStore(fileRegistry).validateWrite({ core_type: "Verdict", domain_type: "change-verdict", data: LIVE });
    expect(v.valid, `the live payload is still refused: ${v.reason}`).toBe(true);
  });

  it("the SEALED record has no decision_ref key, and its content_sha equals the same payload with the key omitted", () => {
    let rec: ReturnType<typeof write> | undefined;
    expect(() => { rec = write({ ...LIVE }); }, "the live payload does not seal").not.toThrow();
    expect("decision_ref" in rec!.data, `a null was SEALED: data.decision_ref = ${JSON.stringify(rec!.data["decision_ref"])}`).toBe(false);
    const omitted = write({ ...VERDICT });
    expect(rec!.content_sha, "null and omitted seal to different content — the hash saw the null").toBe(omitted.content_sha);
  });

  it("a null on a REQUIRED field is still refused — at validate and at write", () => {
    const data = { ...VERDICT, recommendation: null };
    const v = createOutputStore(fileRegistry).validateWrite({ core_type: "Verdict", domain_type: "change-verdict", data });
    expect(v.valid, "a null on the REQUIRED `recommendation` was accepted").toBe(false);
    // Stripping a required null and then refusing its ABSENCE gives the same verdict for the wrong
    // reason: the chair is told it omitted a field it sent. The refusal names what was SENT.
    expect(v.reason, "the refusal names the field").toMatch(/recommendation/);
    expect(v.reason, `the required null was stripped and the chair told it OMITTED the field: ${v.reason}`).not.toMatch(/required property/);
    expect(() => write(data), "a null on a required field sealed").toThrow(/recommendation/);
  });

  it("a null inside an array member is untouched — the member is still judged, and refused", () => {
    const data = { ...VERDICT, checks: [{ method: "ran the law file", result: null }] };
    const v = createOutputStore(fileRegistry).validateWrite({ core_type: "Verdict", domain_type: "change-verdict", data });
    expect(v.valid, "a null inside checks[0] was stripped; only a top-level optional property is absence").toBe(false);
    const alsoArray = { ...VERDICT, failures_verbatim: ["one", null] };
    const w = createOutputStore(fileRegistry).validateWrite({ core_type: "Verdict", domain_type: "change-verdict", data: alsoArray });
    expect(w.valid, "a null element of an array was dropped from the array").toBe(false);
  });

  it("the caller's object is not mutated by the strip", () => {
    const data: Record<string, unknown> = { ...LIVE };
    try { write(data); } catch { /* G3's other laws own the refusal */ }
    expect(data, "the store mutated the caller's payload").toEqual(LIVE);
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
    const invoke: AgentInvoker = () => ({ ...LIVE });
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
