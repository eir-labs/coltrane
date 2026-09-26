// H1–H4 — THE HOSTED DISPATCH DOOR: A RESUME IS NEVER A SILENT FRESH GIG, AND NO ARGUMENT IS DROPPED
// SILENTLY. (docs/specs/gig-runs-once.red-spec.json)
//
// Live finding: G4 covered LOCAL dispatch only. On the hosted branch (deps.hosted + deps.queueGig,
// callSurfaceTool in src/server.ts), gig_dispatch hands `args` straight to deps.queueGig. `resume_gig_id` is never
// turned into `resumes`, and the closed-gig decision is never made. The host adapter (coltrane-ui)
// then drops resume_gig_id, because nothing in its contract names it. So a hosted resume silently
// queues a FRESH, full-cost gig: the double spend #554 exists to prevent, arriving through the host's
// door.
//
// The host contract is the arguments the queue seams actually read (postgrestQueueGig and
// rpcQueueGig in src/genome_store.ts): standard_slug, mode, input, org_slug, acting_for, venue. Add
// `resumes`, which the store's claim hands back (coltrane-ui #250). Anything else the engine
// advertises on gig_dispatch, the hosted branch cannot carry today.
//
//   H1 a hosted resume of a CLOSED gig queues a new gig with `resumes: <old id>`, never with
//      resume_gig_id, and never as a fresh gig with no link.
//   H2 a hosted resume of an OPEN gig is refused with a reason. Resuming in place is the approval
//      door's job (gig_approve re-queues a parked gig), not dispatch's. Nothing is queued.
//   H3 the store can't answer (gigStatus throws, never settles, or is not wired): refused, nothing
//      queued. This is R5.2 on the local door, plus one case. With NO store the hosted door has
//      nothing else to decide from; there is no checkpoint to consult.
//   H4 no silent drop: queueGig receives only host-contract arguments. Every advertised argument the
//      hosted branch cannot honour is REFUSED at the door, by name, and never forwarded to be
//      ignored.
//
// Out of scope here, per the conductor: budget carriage (a store column) and the adapter's own
// mapping. Those are the coltrane-ui follow-up. Until then `budget` is refused, not dropped.
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRegistry, createOutputStore, MemoryLedger } from "../src/index.js";
import { createToolSurface, type ServerDeps, type ToolSurfaceDeps } from "../src/server.js";

const OLD = "abababab-1111-2222-3333-cdcdcdcdcdcd";
const HOST_CONTRACT = new Set(["standard_slug", "mode", "input", "org_slug", "acting_for", "venue", "resumes"]);

function hosted(gigStatus?: ServerDeps["gigStatus"]): { d: ToolSurfaceDeps; queued: Array<Record<string, unknown>> } {
  const registry = createRegistry();
  const queued: Array<Record<string, unknown>> = [];
  const d: ToolSurfaceDeps = {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    hosted: true,
    queueGig: async (args: Record<string, unknown>) => { queued.push({ ...args }); return { gig_id: "new-gig-id", status: "queued" }; },
    ...(gigStatus ? { gigStatus } : {}),
  };
  return { d, queued };
}

// The hosted branch lives in the SURFACE (createToolSurface → callSurfaceTool, src/server.ts), which is
// what a host mounts. dispatchTool is the local door and never reaches it.
const dispatch = (d: ToolSurfaceDeps, args: Record<string, unknown>) =>
  createToolSurface(d).find((t) => t.name === "gig_dispatch")!.call(args);

afterEach(() => vi.useRealTimers());

describe("H1 — a hosted resume of a CLOSED gig queues a new gig linked by `resumes`", () => {
  for (const status of ["failed", "aborted", "completed", "cancelled"]) {
    it(`H1 store says \`${status}\`: queueGig gets resumes:<old id> and NO resume_gig_id; it is never a fresh unlinked gig`, async () => {
      const asked: string[] = [];
      const { d, queued } = hosted(async (id) => { asked.push(id); return status; });
      const r = await dispatch(d, { standard_slug: "scan-v1", input: { a: 1 }, resume_gig_id: OLD });
      expect(r.ok, `precondition: the hosted resume is accepted: ${JSON.stringify(r)}`).toBe(true);
      expect(asked, "the hosted door never asked the store whether the gig is closed").toContain(OLD);
      expect(queued.length).toBe(1);
      expect(queued[0]!["resume_gig_id"], "resume_gig_id was forwarded to the host, which drops it: a FRESH full-cost gig").toBeUndefined();
      expect(queued[0]!["resumes"], "the queued gig does not say which gig it resumes").toBe(OLD);
      expect(queued[0]!["standard_slug"]).toBe("scan-v1");
      expect(queued[0]!["input"]).toEqual({ a: 1 });
    });
  }
});

describe("H2 — a hosted resume of an OPEN gig is refused; in-place resume is the approval door's job", () => {
  for (const status of ["running", "queued", "awaiting_approval"]) {
    it(`H2 store says \`${status}\`: refused with a reason naming the status, nothing queued`, async () => {
      const { d, queued } = hosted(async () => status);
      const r = await dispatch(d, { standard_slug: "scan-v1", input: {}, resume_gig_id: OLD });
      expect(queued.map((q) => Object.keys(q)), `an OPEN gig's hosted resume was queued: ${JSON.stringify(queued)}`).toEqual([]);
      expect(r.ok).toBe(false);
      expect(String(r.error ?? ""), "the refusal must say what the store answered").toContain(status);
    });
  }
});

describe("H3 — a store that cannot answer refuses the hosted resume; nothing is queued", () => {
  it("H3a gigStatus THROWS: refused naming the store's error, nothing queued", async () => {
    const { d, queued } = hosted(async () => { throw new Error("store unreachable: ECONNRESET"); });
    const r = await dispatch(d, { standard_slug: "scan-v1", input: {}, resume_gig_id: OLD });
    expect(queued, "the store could not answer and the resume was queued anyway").toEqual([]);
    expect(r.ok).toBe(false);
    expect(String(r.error ?? "")).toMatch(/ECONNRESET/);
  });

  it("H3b gigStatus NEVER ANSWERS: refused within 30 s, nothing queued", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { d, queued } = hosted(() => new Promise<string>(() => { /* silent store */ }));
    let settled: Awaited<ReturnType<typeof dispatch>> | undefined;
    const pending = dispatch(d, { standard_slug: "scan-v1", input: {}, resume_gig_id: OLD }).then((r) => { settled = r; return r; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled, "the hosted door is still waiting on a silent store").toBeDefined();
    expect(queued).toEqual([]);
    expect((await pending).ok).toBe(false);
  });

  it("H3c NO gigStatus wired: a hosted resume is refused (there is nothing to decide closed/open from), nothing queued", async () => {
    const { d, queued } = hosted(undefined);
    const r = await dispatch(d, { standard_slug: "scan-v1", input: {}, resume_gig_id: OLD });
    expect(queued, "a hosted resume with no store to ask was queued as a fresh gig").toEqual([]);
    expect(r.ok).toBe(false);
    expect(String(r.error ?? ""), "the refusal must name the missing seam").toMatch(/gigStatus|store/i);
  });
});

describe("H4 — no silent drop: only host-contract arguments reach queueGig; the rest are refused by name", () => {
  it("H4 a clean hosted dispatch forwards ONLY host-contract arguments", async () => {
    const { d, queued } = hosted();
    const r = await dispatch(d, {
      standard_slug: "scan-v1", input: { a: 1 }, acting_for: "steve-1", venue: "bare-room", mode: "live", wait: false,
    });
    expect(r.ok, `precondition: a clean dispatch queues: ${JSON.stringify(r)}`).toBe(true);
    expect(queued.length).toBe(1);
    const extra = Object.keys(queued[0]!).filter((k) => !HOST_CONTRACT.has(k));
    expect(extra, "arguments outside the host contract were forwarded, and the host will ignore them").toEqual([]);
  });

  const UNHONOURABLE: Array<[string, unknown]> = [
    ["chart_slug", "wire-set-v0"],
    ["repo_url", "https://github.com/eir-labs/example"],
    ["depth", 2],
    ["effort", "high"],
    ["max_context_tokens", 100_000],
    ["budget", { max_usd: 5 }],
    ["reuse", true],
    ["approvals", { approve: { verdict: "ok" } }],
    ["approved_by", "eugene"],
    ["wait", true],
  ];
  for (const [key, value] of UNHONOURABLE) {
    it(`H4 \`${key}\` cannot be carried by the host: refused BY NAME, nothing queued`, async () => {
      const { d, queued } = hosted();
      const r = await dispatch(d, { standard_slug: "scan-v1", input: {}, [key]: value });
      expect(queued.map((q) => q[key]), `\`${key}\` was forwarded to a host that drops it: a silent drop`).toEqual([]);
      expect(r.ok, `\`${key}\` was accepted by a door that cannot honour it`).toBe(false);
      expect(String(r.error ?? ""), `the refusal must name \`${key}\``).toContain(key);
    });
  }
});
