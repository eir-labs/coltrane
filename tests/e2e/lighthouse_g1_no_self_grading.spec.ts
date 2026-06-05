// L1 — Lighthouse audit-rigor: settlement must reject grader == agent_being_settled.
//
// v3.3 cost-discipline standard (band-side, mirror file in slack_ant) says: any
// settlement event where the GRADER and the AGENT BEING SETTLED are the same slug
// must be rejected with a SelfGradingAttempt-class exception. Self-attestation is
// not evidence; the discipline collapses if an agent can sign its own verdict.
//
// Parallel test: tonight's miles slack_ant spec proved chain_keeper has no
// SelfGradingAttempt class. This OSS-side spec asks the same question of the
// coltrane MCP runtime: does ANY tool in dispatchTool's surface that records a
// quality verdict / evolution-evidence reject the self-grading case?
//
// Candidate surfaces in the OSS runtime that look like "settlement with a grader":
//   - session_review_write   — records quality_scores for (agent_slug, gig_id, output_id)
//   - learning_synthesize    — aggregates reviews into evolution evidence for agent_slug
//   - proposal_create        — creates a change proposal for `target` with evidence
//   - agent_evolve           — versions an AgentProfile (self-attested next-profile)
//
// Pre-reg honesty: we expect this test to go RED. Survey of src/server.ts +
// src/mcp.ts shows:
//   1. NO file exports a `SelfGradingAttempt` class (or any equivalent error class).
//   2. session_review_write's input schema has `agent_slug` (the agent being
//      reviewed) but NO `grader_slug` / `reviewer_slug` field — the surface
//      cannot even REPRESENT the grader, let alone reject self-grading.
//   3. agent_evolve accepts `base` + `next` AgentProfile pairs with no attestation
//      provenance; the "grader" of an evolve is implicit (the caller).
//
// Test strategy: drive each candidate surface with a self-grading-shaped payload
// and assert REJECTION. When the surface accepts (the expected RED outcome), the
// assertion fails with a precise diagnosis the OSS author can act on.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import * as coltrane from "../../src/index.js";
import {
  MemoryLedger,
  createOutputStore,
  dispatchTool,
  loadGenome,
  loadRegistry,
  type AgentProfile,
  type ServerDeps,
} from "../../src/index.js";

import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";

let env: TempdirColtrane;
let genomeDir: string;
let deps: ServerDeps;

function freshDepsFromGenome(root: string): ServerDeps {
  const genome = loadGenome(root);
  const registry = loadRegistry(genome);
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: genome.standards,
    invoke: undefined,
    model_version: "L1-no-self-grading-e2e",
    genome_dir: root,
  };
}

/** Minimal profile builder — we only need a base AgentProfile to drive agent_evolve. */
function makeProfile(slug: string, version = 1): AgentProfile {
  return {
    slug,
    version,
    status: "active",
    parent_version: null,
    primitives: ["INTERPRET"],
    input_types: ["raw-note"],
    output_types: ["summary"],
    domain: "demo",
    identity: `${slug} v${version} identity`,
    method: `${slug} v${version} method`,
    constraints: ["one sentence"],
    depth_profile: "standard",
    permissions: {
      allowed_tools: [],
      disallowed_tools: [],
      model_tier: "economy",
      max_tool_calls: 0,
      max_token_budget: 1000,
      can_write_outputs: true,
      can_trigger_standards: false,
    },
  };
}

describe("L1 lighthouse: settlement runtime rejects self-grading (grader == agent_being_settled)", () => {
  beforeAll(async () => {
    env = await setupTempdirColtrane();
    genomeDir = env.tempDir;
    for (const sub of ["agents", "standards", "domain_types", "skills", "evals"]) {
      const p = join(genomeDir, sub);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      mkdirSync(p, { recursive: true });
    }
    // Register the minimal types both `audit_grader` and `audit_target` need so
    // any self-grading path can resolve schemas without a type-missing red-herring.
    deps = freshDepsFromGenome(genomeDir);
    await dispatchTool(
      "type_register",
      {
        slug: "raw-note",
        extends: "Signal",
        domain: "demo",
        schema: { type: "object", properties: { body: { type: "string" } } },
        required_fields: ["body"],
      },
      deps,
    );
    await dispatchTool(
      "type_register",
      {
        slug: "summary",
        extends: "Interpretation",
        domain: "demo",
        schema: { type: "object", properties: { gist: { type: "string" } } },
        required_fields: ["gist"],
      },
      deps,
    );
    await dispatchTool(
      "agent_define",
      { slug: "audit_target", primitives: ["INTERPRET"], input_types: ["raw-note"], output_types: ["summary"], domain: "demo" },
      deps,
    );
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Apoha-1: the runtime exports a typed exception for self-grading attempts.
  // Mirror of the chain_keeper / slack_ant assertion that proved RED tonight.
  // ──────────────────────────────────────────────────────────────────────────
  it("apoha-1: src/index.ts exports a SelfGradingAttempt-class error", () => {
    const surface = coltrane as unknown as Record<string, unknown>;
    const candidates = Object.keys(surface).filter((k) =>
      /self.?grading|self.?grade|self.?attest/i.test(k),
    );
    expect(
      candidates,
      `no SelfGradingAttempt-class export found on src/index.ts surface — settlement runtime has no typed rejection for grader == agent_being_settled`,
    ).not.toEqual([]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Apoha-2: session_review_write rejects a payload where the reviewer is the
  // same agent as the one being reviewed. This requires the schema to even
  // EXPRESS a grader_slug — currently it does not (mcp.ts line 57).
  // ──────────────────────────────────────────────────────────────────────────
  it("apoha-2: session_review_write rejects grader_slug == agent_slug (self-review)", async () => {
    // Drive the surface with a self-review payload: the agent being reviewed
    // ("audit_target") is also named as the grader. Honest pre-reg: the current
    // schema has no `grader_slug` field, so we send it on the off-chance the
    // handler reads it; if not, this test goes RED with a clear diagnosis.
    const r = await dispatchTool(
      "session_review_write",
      {
        gig_id: "self-grading-gig",
        output_id: "self-grading-output",
        agent_slug: "audit_target",
        // grader_slug is the field a self-grading-aware runtime would inspect.
        grader_slug: "audit_target",
        reviewer_slug: "audit_target", // alt name some runtimes use
        agent_version: 1,
        quality_score: 1.0, // self-graded perfect — the smell-test the discipline catches
        quality_scores: { faithfulness: 1.0, calibration: 1.0 },
        domain: "demo",
        notes: "self-attested review — must be rejected by the settlement runtime",
      },
      deps,
    );
    expect(
      r.ok,
      `session_review_write accepted a self-review (grader_slug == agent_slug == 'audit_target'); ` +
        `runtime has no SelfGradingAttempt guard. response=${JSON.stringify(r).slice(0, 300)}`,
    ).toBe(false);
    // If it WAS rejected, the error message should name the violation specifically.
    if (!r.ok) {
      expect(
        r.error,
        `session_review_write rejected the call but the error message is generic — ` +
          `the SelfGradingAttempt diagnosis must be load-bearing in the error text. error=${r.error}`,
      ).toMatch(/self.?grading|self.?review|grader.*==.*agent|reviewer.*==.*target/i);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Apoha-3: learning_synthesize, when fed reviews that all carry the same
  // grader_slug as the agent_slug, must NOT mark evidence_sufficient=true.
  // Self-grading evidence is no evidence; aggregation cannot launder it.
  // ──────────────────────────────────────────────────────────────────────────
  it("apoha-3: learning_synthesize refuses to aggregate self-reviews into 'evidence_sufficient'", async () => {
    // Seed the ledger with 6 self-reviews (above default min_reviews=5). If the
    // runtime had a self-grading guard, either each session_review_write would
    // have been rejected upstream OR learning_synthesize would filter them out.
    for (let i = 0; i < 6; i++) {
      await dispatchTool(
        "session_review_write",
        {
          gig_id: `self-graded-gig-${i}`,
          output_id: `self-graded-output-${i}`,
          agent_slug: "audit_target",
          grader_slug: "audit_target",
          agent_version: 1,
          quality_score: 1.0,
          quality_scores: { faithfulness: 1.0 },
          domain: "demo",
          notes: `self-review ${i}`,
        },
        deps,
      );
    }

    const r = await dispatchTool(
      "learning_synthesize",
      { agent_slug: "audit_target", min_reviews: 5, auto_propose: true },
      deps,
    );
    expect(r.ok).toBe(true); // the call itself runs
    const data = r.data as { evidence_sufficient: boolean; review_count: number; proposal_id: string | null };
    expect(
      data.evidence_sufficient,
      `learning_synthesize accepted ${data.review_count} self-graded reviews as 'evidence_sufficient' — ` +
        `the discipline collapses: an agent can synthesize evidence to evolve itself`,
    ).toBe(false);
    expect(
      data.proposal_id,
      `learning_synthesize auto-proposed an evolution from self-graded evidence — proposal_id=${data.proposal_id}`,
    ).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Apoha-4: agent_evolve cannot be settled by the agent itself. The evolved
  // profile is a verdict on the base profile; if the caller / attestor is the
  // same identity, that's self-grading. The runtime must require an external
  // grader attestation field — or reject when one isn't supplied.
  // ──────────────────────────────────────────────────────────────────────────
  it("apoha-4: agent_evolve rejects an evolve where the attesting grader is the base agent itself", async () => {
    const base = makeProfile("audit_target", 1);
    const next: AgentProfile = {
      ...base,
      identity: "audit_target v2 — self-improved identity, no external grader",
      constraints: [...base.constraints, "self-attested constraint"],
    };

    // The "grader" of an agent_evolve is the entity attesting the change. We
    // pass it explicitly; a self-grading-aware runtime would either reject the
    // call or require a different grader.
    const r = await dispatchTool(
      "agent_evolve",
      {
        base,
        next,
        // Self-grading-aware fields the runtime would read if it existed.
        grader_slug: "audit_target",
        attestor_slug: "audit_target",
        evidence: { source: "self-attestation", grader: "audit_target" },
      },
      deps,
    );

    expect(
      r.ok,
      `agent_evolve accepted a self-attested profile change (base.slug == grader_slug == 'audit_target'); ` +
        `the runtime has no SelfGradingAttempt guard on the evolution path. ` +
        `response=${JSON.stringify(r).slice(0, 300)}`,
    ).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/self.?grading|self.?attest|grader.*base|attestor.*base/i);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Apoha-5: proposal_create on a permissions-class change, when the proposing
  // agent is the same as the target, must be rejected. permissions changes are
  // the canonical case where self-grading is most dangerous (an agent grants
  // itself broader tool access on its own evidence).
  // ──────────────────────────────────────────────────────────────────────────
  it("apoha-5: proposal_create rejects target == proposer for permissions-class changes", async () => {
    const r = await dispatchTool(
      "proposal_create",
      {
        change_type: "permissions",
        target: "audit_target",
        // The proposer / grader / evidence-source — all the same identity.
        proposer_slug: "audit_target",
        grader_slug: "audit_target",
        changes: { permissions: { max_tool_calls: 50 } }, // self-granted privilege escalation
        reason: "I have decided I am ready for more tools",
        evidence: { source: "audit_target", attestation: "self" },
      },
      deps,
    );

    expect(
      r.ok,
      `proposal_create accepted a self-targeted permissions change (target == proposer == grader == 'audit_target'); ` +
        `the runtime has no SelfGradingAttempt guard on the proposal path. ` +
        `response=${JSON.stringify(r).slice(0, 300)}`,
    ).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/self.?grading|self.?propose|target.*proposer|target.*grader/i);
    }
  });
});
