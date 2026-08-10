// The human chair — the quartet's fourth seat (governor ruling, 2026-08-10 night).
//
// Humans and model agents sit on the same contract; what was missing is the chair a HUMAN
// holds inside a standard: the approval office. A chair marked `human: true` has no agent
// and no skill — the incumbent is a person, and their yes is not a message but a SEALED
// OUTPUT, written through the same gate as every other record, under the approving
// principal's name, with the input_shas of exactly what they approved.
//
// The runtime semantics: a gig that reaches an unapproved human chair PARKS — status
// "awaiting_approval", checkpoint saved, nothing hollow sealed. Supplying the approval
// (deps.approvals[role]) lets the chair seal and the run complete; with a checkpoint store
// the approved resume never re-invokes the model for chairs that already played. The human
// is heavily in the loop BEFORE dispatch (the sketching); the approval chair is the light,
// load-bearing gate where irreversibility begins.
//
// RED-first: written against an engine with no `human` seat type.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { composeStandard, defineAgent, type PhaseDef } from "../src/composition.js";
import { runGig, type AgentInvoker } from "../src/runtime.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { createCheckpointStore } from "../src/reuse.js";

const scout = defineAgent({
  slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["Signal"],
  domain: "test", identity: "you are scout", method: "1. look 2. report 3. stop",
  constraints: [], behavioral_primitives: ["explorer", "critic"],
});

const HUMAN_CHAIR = {
  role: "approve", human: true, agent_slug: "", depends_on: ["scan"],
  input_contract: [], output_contract: ["Judgment"], optional_outputs: [], required_skills: [],
};

const std = () => composeStandard({
  slug: "sense-then-approve", domain: "test", agents: [scout],
  phases: [
    { name: "scan", chairs: [{ role: "scan", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], optional_outputs: [], required_skills: [] }] },
    { name: "approve", chairs: [HUMAN_CHAIR] },
  ] as PhaseDef[],
});

const SIGNAL = { id: "sig-1", source: "test", data: { seen: true }, completeness: 1, acquisition_cost: 0 };
const APPROVAL = {
  id: "approval-1", input_refs: ["sig-1"],
  criteria: ["the scan covers the declared boundary"],
  verdicts: [{ criterion: "the scan covers the declared boundary", verdict: "approved" }],
  reasoning_chain: ["reviewed the sealed scan; boundary matches the dispatch payload"],
};

function deps(extra?: Record<string, unknown>) {
  const registry = createRegistry();
  return {
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    invoke: vi.fn(async () => SIGNAL) as unknown as AgentInvoker,
    ...extra,
  };
}

describe("composition — the human seat is a first-class chair", () => {
  it("a chair may be seated by a human: no agent, no skill, one promised output", () => {
    expect(() => std()).not.toThrow();
  });
});

describe("runtime — an unapproved human chair PARKS the gig", () => {
  it("runs the model chairs, seals nothing hollow, and reports awaiting_approval", async () => {
    const d = deps();
    const res = await runGig(std(), {}, d as never);
    expect(res.status).toBe("awaiting_approval");
    expect(res.awaiting).toEqual({ phase: "approve", role: "approve" });
    expect(res.outputs).toHaveLength(1); // the scan sealed; the approval did not
    expect((d.invoke as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("drains an awaiting_approval header so the queue row tells the truth", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201 }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    process.env["COLTRANE_DRAIN_URL"] = "https://drain.example";
    process.env["COLTRANE_DRAIN_KEY"] = "cdk_test";
    try {
      await runGig(std(), {}, deps() as never);
      await new Promise((r) => setImmediate(r));
      const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
      const call = calls.find(([u]) => String(u).includes("coltrane_gigs"));
      expect(call, "parked gig must drain its header").toBeDefined();
      const body = JSON.parse(call![1].body as string) as Record<string, unknown>;
      expect(body["status"]).toBe("awaiting_approval");
    } finally {
      vi.unstubAllGlobals();
      delete process.env["COLTRANE_DRAIN_URL"];
      delete process.env["COLTRANE_DRAIN_KEY"];
    }
  });
});

describe("runtime — the approval seals under the approving principal and completes the run", () => {
  it("approvals[role] seals through the same gate, with the upstream shas", async () => {
    const d = deps({ approvals: { approve: APPROVAL }, approved_by: "eugene" });
    const res = await runGig(std(), {}, d as never);
    expect(res.status).toBe("complete");
    expect(res.outputs).toHaveLength(2);
    const approval = res.outputs.find((o) => o.domain_type === "Judgment")!;
    expect(approval.agent_slug).toBe("eugene");
    const scan = res.outputs.find((o) => o.domain_type === "Signal")!;
    expect(approval.input_shas).toContain(scan.content_sha);
  });

  it("a parked gig resumes to completion on approval without re-invoking the model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-approval-"));
    const checkpoints = createCheckpointStore(dir);
    const invoke = vi.fn(async () => SIGNAL) as unknown as AgentInvoker;
    const registry = createRegistry();
    const base = { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, checkpoints };
    const first = await runGig(std(), {}, { ...base, gig_id: "33333333-3333-3333-3333-333333333333" } as never);
    expect(first.status).toBe("awaiting_approval");
    const second = await runGig(std(), {}, {
      ...base,
      resume_from: "33333333-3333-3333-3333-333333333333",
      approvals: { approve: APPROVAL },
      approved_by: "eugene",
    } as never);
    expect(second.status).toBe("complete");
    expect((invoke as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1); // scan restored, not replayed
    expect(second.outputs.some((o) => o.domain_type === "Judgment" && o.agent_slug === "eugene")).toBe(true);
  });
});

describe("the shipped genome carries the fourth chair and the approve phases", () => {
  const ROOT = join(new URL("..", import.meta.url).pathname);

  it("the quartet institution has a human-seated chair with NO assignment — the reader seats themselves", () => {
    const doc = JSON.parse(readFileSync(join(ROOT, "institutions", "quartet.json"), "utf-8")) as {
      chairs: Array<{ id?: string; role: string; human?: boolean }>;
      assignments: Array<{ chair_id: string }>;
    };
    const humanChairs = doc.chairs.filter((c) => c.human === true);
    expect(humanChairs, "the quartet's fourth seat is the human office").toHaveLength(1);
    const seated = new Set(doc.assignments.map((a) => a.chair_id));
    expect(seated.has(humanChairs[0]!.id ?? ""), "the human chair ships unassigned").toBe(false);
  });

  it("both default standards end in an approve phase on a human chair", () => {
    for (const slug of ["software-change-v1", "product-design-v1"]) {
      const doc = JSON.parse(readFileSync(join(ROOT, "standards", `${slug}.json`), "utf-8")) as {
        phases: Array<{ name: string; chairs: Array<{ human?: boolean; output_contract: string[] }> }>;
      };
      const last = doc.phases[doc.phases.length - 1]!;
      expect(last.chairs.some((c) => c.human === true), `${slug} final phase carries the human chair`).toBe(true);
    }
  });
});
