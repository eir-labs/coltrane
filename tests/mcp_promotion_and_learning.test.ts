// O23 — §7 MCP promotion + learning surface.
// Closes the parity gap with OG's evolution-loop: 5 tools wired through the
// real dispatcher, forward-only state machine + ledger-append learning loop.
//   agent_promote / standard_promote / skill_promote — lifecycle state machine
//   session_review_write — record quality review for a gig's output
//   learning_synthesize  — aggregate reviews into evolution evidence (+ optional proposal)
import { describe, it, expect } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import {
  MCP_TOOLS,
  checkPromotion,
  PromotionError,
  AGENT_STATUS_ORDER,
  STANDARD_STATUS_ORDER,
  SKILL_STATUS_ORDER,
} from "../src/mcp.js";

function makeDeps(): ServerDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

describe("promotion state machines — pure", () => {
  // KARMA: forward-only transitions accepted.
  it("agent: draft → review → approved → active → retired all pass", () => {
    for (let i = 0; i < AGENT_STATUS_ORDER.length - 1; i++) {
      const from = AGENT_STATUS_ORDER[i]!;
      const to = AGENT_STATUS_ORDER[i + 1]!;
      expect(() => checkPromotion(from, to, AGENT_STATUS_ORDER)).not.toThrow();
    }
  });
  it("standard: draft → active → retired passes", () => {
    expect(() => checkPromotion("draft", "active", STANDARD_STATUS_ORDER)).not.toThrow();
    expect(() => checkPromotion("active", "retired", STANDARD_STATUS_ORDER)).not.toThrow();
  });
  it("skill: includes explicit testing stage between draft and active", () => {
    expect(SKILL_STATUS_ORDER).toEqual(["draft", "testing", "active", "retired"]);
    expect(() => checkPromotion("draft", "testing", SKILL_STATUS_ORDER)).not.toThrow();
    expect(() => checkPromotion("testing", "active", SKILL_STATUS_ORDER)).not.toThrow();
  });

  // APOHA: backward / unknown transitions rejected.
  it("rejects backward transition (active → draft)", () => {
    expect(() => checkPromotion("active", "draft", AGENT_STATUS_ORDER)).toThrow(PromotionError);
  });
  it("rejects unknown target status", () => {
    expect(() => checkPromotion("draft", "limbo", AGENT_STATUS_ORDER)).toThrow(PromotionError);
  });
  it("rejects unknown current status", () => {
    expect(() => checkPromotion("limbo", "active", AGENT_STATUS_ORDER)).toThrow(PromotionError);
  });
});

describe("agent_promote / standard_promote / skill_promote — dispatched", () => {
  it.each([
    ["agent_promote", "active"],
    ["standard_promote", "active"],
    ["skill_promote", "testing"],
  ])("%s accepts a forward transition + appends a ledger event", async (slug, target) => {
    const deps = makeDeps();
    const before = deps.ledger.query({}).length;
    const r = await dispatchTool(slug, { slug: "scout", status: target }, deps);
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    const data = r.data as { slug: string; status: string; promoted: boolean };
    expect(data.slug).toBe("scout");
    expect(data.status).toBe(target);
    expect(data.promoted).toBe(true);
    expect(deps.ledger.query({}).length).toBe(before + 1);
  });

  it("agent_promote rejects backward transition when current is supplied", async () => {
    const r = await dispatchTool("agent_promote", { slug: "scout", status: "draft", current: "active" }, makeDeps());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/promote backwards/);
  });

  it("standard_promote rejects unknown target status", async () => {
    const r = await dispatchTool("standard_promote", { slug: "summarize", status: "limbo" }, makeDeps());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown target status/);
  });

  it("missing slug or status fails honestly", async () => {
    const r = await dispatchTool("agent_promote", { slug: "" }, makeDeps());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing/);
  });
});

describe("session_review_write — dispatched", () => {
  const goodReview = {
    gig_id: "gig-1",
    output_id: "out-1",
    agent_slug: "summarizer",
    agent_version: 1,
    quality_score: 87,
    quality_scores: { accuracy: 90, brevity: 80 },
    domain: "demo",
  };

  it("records a well-formed review + appends ledger event", async () => {
    const deps = makeDeps();
    const before = deps.ledger.query({}).length;
    const r = await dispatchTool("session_review_write", goodReview, deps);
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    const data = r.data as { review_id: string; recorded: boolean };
    expect(data.recorded).toBe(true);
    expect(typeof data.review_id).toBe("string");
    expect(deps.ledger.query({}).length).toBe(before + 1);
  });

  it("rejects a review missing quality_scores", async () => {
    const { quality_scores: _drop, ...bad } = goodReview;
    const r = await dispatchTool("session_review_write", bad, makeDeps());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/quality_scores/);
  });

  it("rejects a review missing gig_id", async () => {
    const r = await dispatchTool("session_review_write", { ...goodReview, gig_id: "" }, makeDeps());
    expect(r.ok).toBe(false);
  });
});

describe("learning_synthesize — dispatched", () => {
  async function seedReviews(deps: ServerDeps, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await dispatchTool("session_review_write", {
        gig_id: `gig-${i}`,
        output_id: `out-${i}`,
        agent_slug: "summarizer",
        agent_version: 1,
        quality_score: 80 + i,
        quality_scores: { accuracy: 80 + i, brevity: 75 },
        domain: "demo",
      }, deps);
    }
  }

  it("reports evidence_insufficient when reviews < min_reviews", async () => {
    const deps = makeDeps();
    await seedReviews(deps, 2);
    const r = await dispatchTool("learning_synthesize", { agent_slug: "summarizer", min_reviews: 5 }, deps);
    expect(r.ok).toBe(true);
    const d = r.data as { review_count: number; evidence_sufficient: boolean; proposal_id: string | null };
    expect(d.review_count).toBe(2);
    expect(d.evidence_sufficient).toBe(false);
    expect(d.proposal_id).toBeNull();
  });

  it("reports evidence_sufficient at threshold + auto-creates proposal when asked", async () => {
    const deps = makeDeps();
    await seedReviews(deps, 5);
    const r = await dispatchTool("learning_synthesize", { agent_slug: "summarizer", min_reviews: 5, auto_propose: true }, deps);
    expect(r.ok).toBe(true);
    const d = r.data as { review_count: number; evidence_sufficient: boolean; proposal_id: string | null };
    expect(d.review_count).toBe(5);
    expect(d.evidence_sufficient).toBe(true);
    expect(typeof d.proposal_id).toBe("string");
  });

  it("does NOT auto-create a proposal when evidence is insufficient", async () => {
    const deps = makeDeps();
    await seedReviews(deps, 1);
    const r = await dispatchTool("learning_synthesize", { agent_slug: "summarizer", min_reviews: 5, auto_propose: true }, deps);
    const d = r.data as { proposal_id: string | null };
    expect(d.proposal_id).toBeNull();
  });

  it("rejects missing agent_slug", async () => {
    const r = await dispatchTool("learning_synthesize", {}, makeDeps());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/agent_slug/);
  });
});

describe("MCP surface — 5 new tools registered", () => {
  it.each([
    "agent_promote", "standard_promote", "skill_promote",
    "session_review_write", "learning_synthesize",
  ])("%s is in MCP_TOOLS with input + output schema", (name) => {
    const t = MCP_TOOLS.find((x) => x.slug === name);
    expect(t, `tool ${name} missing from MCP_TOOLS`).toBeDefined();
    expect(t!.input_schema).toBeDefined();
    expect(t!.output_schema).toBeDefined();
  });
});
