// G4 (engine half) — RESUMING A TERMINAL GIG DISPATCHES A NEW GIG. (docs/specs/gig-runs-once.red-spec.json)
//
// THE DOOR. An explicit resume is requested through gig_dispatch({ resume_gig_id }) (src/server.ts,
// `resumeArg`). `coltrane dispatch --resume <id>` sends the same thing (src/cli.ts).
//   * REFUSED resume: the door refuses and runs nothing. That case is already pinned by
//     tests/resume_reuse_dispatch.test.ts:164 and is not restated here.
//   * SUCCESSFUL resume, which is what THIS law is about. The door mints its run id as
//     `const gigId = resumeArg ?? randomUUID()`, so a resumed run seals, ledgers and drains its
//     header UNDER THE OLD GIG'S ID. For a gig that ended failed or aborted, that is now a collision.
//     The store's terminal guard (eir-labs/coltrane-ui #250) accepts only a same-status write on a
//     terminal row and refuses anything else with 23514. So the resumed run's 'completed' header can
//     never land. The old id's lease is gone too, so every write assert_lease sees is refused.
//
// Ruling (conductor, G4, terminal rows only): resuming a FAILED or ABORTED gig dispatches a NEW gig.
// It gets a new id (through the normal dispatch door, so a hosted store creates and leases it) and
// carries `resumes: <old id>`. It writes nothing under the old id.
//
// FOUNDER RULING (Eugene): "what's closed is closed. can refer to the sealed outputs on input if
// needed but reopening doesn't smell right." So the old gig's sealed outputs enter the new gig as
// INPUTS BY REFERENCE. Their content_sha appears in the new outputs' input_shas, so provenance points
// back at the old seals, and they are never re-sealed as the new gig's own work. The chair that
// already sealed is not paid for again. A PARKED gig is not terminal: its approval-resume keeps its own id, and E6b's
// cold_run_reason covers the cold case there.
//
// The drain credential is configured so the law observes the writes the store would see: every
// header this dispatch drains is recorded, and none may name the terminal gig.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard,
  type AgentInvoker, type DomainType, type PhaseDef, type Chair, type Standard,
} from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createMemoryCheckpointStore } from "../src/reuse.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const callT: DomainType = { slug: "call", extends: "Verdict", domain: "demo", schema: { properties: { v: { type: "string" } } }, required_fields: ["v"] };
const NOTE = { t: "hi", source: "fixture://demo/note" };
const CALL = { v: "go", checks: [{ method: "the fixture ran one check", result: "pass" }] };

const chairs: Chair[] = [
  { role: "s", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] },
  { role: "g", agent_slug: "gate", depends_on: ["s"], input_contract: ["note"], output_contract: ["call"], required_skills: [] },
];
const standard = (): Standard => composeStandard({
  slug: "terminal-resume-demo", domain: "demo",
  agents: [
    testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" }),
    testAgent({ slug: "gate", primitives: ["VERIFY"], input_types: ["note"], output_types: ["call"], domain: "demo" }),
  ],
  phases: [{ name: "sense", chairs: [chairs[0]!] } as PhaseDef, { name: "verify", chairs: [chairs[1]!] } as PhaseDef],
});

const headersDrained: Array<Record<string, unknown>> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["COLTRANE_DRAIN_URL"];
  delete process.env["COLTRANE_DRAIN_KEY"];
  headersDrained.length = 0;
});

type Ending = "failed" | "aborted";

/** A gig that ENDED `how`, with the sense chair sealed and the gate never sealed. */
async function endedGig(how: Ending): Promise<{ d: ServerDeps; oldId: string; calls: Record<string, number>; heal(): void }> {
  process.env["COLTRANE_DRAIN_URL"] = "https://coltrane.example";
  process.env["COLTRANE_DRAIN_KEY"] = "cdk_terminal_resume";
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (new URL(String(url)).pathname === "/rest/v1/coltrane_gigs" && init?.body) {
      headersDrained.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    }
    return new Response("null", { status: 201 });
  }));
  const registry = createRegistry();
  registry.registerType(note);
  registry.registerType(callT);
  const std = standard();
  const calls: Record<string, number> = {};
  let broken = true;
  let started!: () => void;
  const solStarted = new Promise<void>((r) => { started = r; });
  let release!: () => void;
  const solReleased = new Promise<void>((r) => { release = r; });
  const invoke: AgentInvoker = async (ctx) => {
    calls[ctx.agent.slug] = (calls[ctx.agent.slug] ?? 0) + 1;
    if (ctx.agent.slug === "solo") {
      if (how === "aborted" && broken) { started(); await solReleased; }
      return { ...NOTE };
    }
    if (how === "failed" && broken) throw new Error("stub gate failure");
    return { ...CALL };
  };
  const d: ServerDeps = {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    standards: new Map([[std.slug, std]]), invoke, gig_runs: new Map(),
    checkpoints: createMemoryCheckpointStore(),
  };
  let oldId: string;
  if (how === "failed") {
    const r1 = await dispatchTool("gig_dispatch", { standard_slug: std.slug, input: {}, wait: true }, d);
    expect(r1.ok, "precondition: attempt 1 fails at the gate").toBe(false);
    oldId = d.outputs.all()[0]!.gig_id;
  } else {
    // Aborted between phases: the sense chair is in flight when gig_abort lands, finishes and seals,
    // and the run stops before the gate (the #249/#250 cancellation checkpoint).
    const disp = await dispatchTool("gig_dispatch", { standard_slug: std.slug, input: {} }, d);
    oldId = String((disp.data as { gig_id: string }).gig_id);
    await solStarted;
    const ab = await dispatchTool("gig_abort", { gig_id: oldId, reason: "operator stop" }, d);
    expect((ab.data as { aborted?: boolean }).aborted, "precondition: the abort was delivered").toBe(true);
    release();
    const t0 = Date.now();
    for (;;) {
      const m = (await dispatchTool("gig_monitor", { gig_id: oldId }, d)).data as Record<string, unknown>;
      if (m["status"] !== "running") { expect(m["status"], "precondition: the gig ended aborted").toBe("aborted"); break; }
      if (Date.now() - t0 > 3000) throw new Error("the aborted gig never settled");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(calls, "precondition: the gate never ran on the aborted gig").toEqual({ solo: 1 });
  }
  await new Promise((r) => setTimeout(r, 20)); // let attempt 1's own header drain land
  return { d, oldId, calls, heal: () => { broken = false; for (const k of Object.keys(calls)) delete calls[k]; } };
}

describe("G4 — a resume of a TERMINAL gig is a new gig linked to the old one", () => {
  for (const how of ["failed", "aborted"] as const) {
    const title = how === "failed"
      ? "G4 gig_dispatch({resume_gig_id}) of a FAILED gig runs under a NEW id carrying `resumes: <old id>`, takes the old seals as inputs by reference, and writes nothing under the old id"
      : "G4 gig_dispatch({resume_gig_id}) of an ABORTED gig runs under a NEW id carrying `resumes: <old id>`, takes the old seals as inputs by reference, and writes nothing under the old id";
    it(title, async () => {
      const { d, oldId, calls, heal } = await endedGig(how);
      const oldRows = d.outputs.all().filter((o) => o.gig_id === oldId).length;
      const headersBefore = headersDrained.length;

      // The explicit resume.
      heal();
      const r2 = await dispatchTool("gig_dispatch", { standard_slug: "terminal-resume-demo", input: {}, wait: true, resume_gig_id: oldId }, d);
      await new Promise((r) => setTimeout(r, 20));
      expect(r2.ok, `precondition: the resume succeeds: ${JSON.stringify(r2)}`).toBe(true);
      expect(calls, "precondition: the sealed chair is reused, not paid for again").toEqual({ gate: 1 });

      const data = r2.data as Record<string, unknown>;
      const newId = String(data["gig_id"]);
      expect(newId, `the resume of the ${how.toUpperCase()} gig ran under the OLD gig's id; the store's terminal guard refuses every write it makes`).not.toBe(oldId);
      const resumes = data["resumes"] ?? (data["manifest"] as Record<string, unknown> | undefined)?.["resumes"];
      expect(resumes, "the new gig must say which gig it resumes").toBe(oldId);

      const resumeHeaders = headersDrained.slice(headersBefore);
      expect(resumeHeaders.filter((h) => h["id"] === oldId).map((h) => h["status"]),
        "the resume drained headers onto the terminal gig (the store answers 23514)").toEqual([]);
      expect(resumeHeaders.some((h) => h["id"] === newId), "the new gig's header was never drained").toBe(true);
      expect(d.outputs.all().filter((o) => o.gig_id === oldId).length, "the resume sealed outputs into the terminal gig").toBe(oldRows);
      expect(d.ledger.query({ kind: "gig" }).filter((e) => (e as { gig_id?: string }).gig_id === oldId).length,
        "the resume wrote the terminal gig's ledger row").toBe(0);

      // WHAT'S CLOSED IS CLOSED. The old gig's sealed note enters the new gig as an INPUT BY REFERENCE:
      // the new gate's input_shas name the OLD seal's content_sha, so provenance points back at the old
      // gig. The note is never re-sealed as the new gig's own work.
      const oldNote = d.outputs.all().find((o) => o.gig_id === oldId && o.domain_type === "note")!;
      const newOutputs = d.outputs.all().filter((o) => o.gig_id === newId);
      expect(newOutputs.filter((o) => o.domain_type === "note").map((o) => o.content_sha),
        "the old gig's sealed note was RE-SEALED as the new gig's own work; it must enter by reference only").toEqual([]);
      const gate = newOutputs.find((o) => o.domain_type === "call");
      expect(gate, "the new gig sealed no gate verdict").toBeDefined();
      expect(gate!.input_shas, "the new gate's provenance does not point at the OLD gig's seal").toContain(oldNote.content_sha);
    });
  }
});
