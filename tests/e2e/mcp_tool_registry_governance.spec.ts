// e2e — T16: MCP tool registry governance.
//
// Claim: agent_define with an unregistered MCP tool slug in `allowed_tools`
// must be REJECTED. The legitimate path to grant an unknown slug is
// tool_propose → tool_register → then agent_define passes. This is the
// governance gate that keeps the cage honest: agents cannot be granted scope
// to tools the registry doesn't know about, full stop.
//
// Shape:
//   1. NEGATIVE: agent_define with allowed_tools=["mcp__totally_unknown_slug"]
//      → ok=false, error names the unknown slug.
//   2. POSITIVE-PROPOSE-ONLY: just tool_propose alone is NOT enough — the slug
//      isn't registered until tool_register lands it.
//   3. POSITIVE-FULL: tool_propose → tool_register → agent_define with the
//      same slug → ok=true.
//   4. POSITIVE-CONTROL: an agent_define WITHOUT exotic allowed_tools always
//      passes (proves the gate isn't blanket-rejecting).
//
// Honest scope: this is the in-process gate. If the dispatcher doesn't
// validate allowed_tools against KNOWN_SLUGS, this test goes RED — that's the
// real diagnosis: the cage has a hole.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTempdirColtrane,
  type TempdirColtrane,
} from "./_harness.js";
import { dispatchTool, bootstrapServerDeps, type ServerDeps } from "../../src/index.js";

const UNKNOWN_SLUG = "mcp__totally_unknown_slug_t16";

describe("T16 — MCP tool registry governance", () => {
  let env: TempdirColtrane;
  let deps: ServerDeps;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    deps = bootstrapServerDeps(env.tempDir);
  }, 120_000);
  afterAll(() => env?.cleanup());

  it("negative: agent_define with an unregistered allowed_tools slug is REJECTED", async () => {
    const result = await dispatchTool(
      "agent_define",
      {
        slug: "rogue-agent",
        primitives: ["SENSE"],
        input_types: [],
        output_types: [],
        domain: "demo",
        allowed_tools: [UNKNOWN_SLUG],
      },
      deps,
    );

    // Gate contract: the dispatcher must refuse to seal an agent whose cage
    // grants scope to a tool the registry doesn't know about.
    expect(
      result.ok,
      `agent_define accepted allowed_tools=[${UNKNOWN_SLUG}] — the governance ` +
        `gate is missing. Unknown slugs must be rejected until tool_register lands them.`,
    ).toBe(false);

    expect(typeof result.error).toBe("string");
    const errMsg = String(result.error ?? "").toLowerCase();
    // The error should name the offending slug AND signal it's an unknown/unregistered tool.
    expect(errMsg).toContain(UNKNOWN_SLUG.toLowerCase());
    expect(errMsg).toMatch(/unknown|unregistered|not registered|not found|invalid/);

    // No agent record should have been sealed.
    expect(result.data == null || (result.data as { agent_profile_id?: string }).agent_profile_id == null).toBe(true);
  });

  it("positive-propose-only: tool_propose alone does NOT register the slug — agent_define still fails", async () => {
    const propose = await dispatchTool(
      "tool_propose",
      {
        slug: UNKNOWN_SLUG,
        type: "mcp",
        spec: { description: "T16 governance probe" },
        reason: "exercise the propose→register seam",
      },
      deps,
    );
    expect(propose.ok).toBe(true);
    expect(propose.requires_approval).toBe(true);
    const proposeData = propose.data as { proposal_id: string };
    expect(proposeData.proposal_id).toMatch(/^[0-9a-f-]{36}$/);

    // Critical: tool_propose creates a PROPOSAL only. The slug isn't live in
    // the registry yet — agent_define must still reject it.
    const stillBlocked = await dispatchTool(
      "agent_define",
      {
        slug: "still-rogue-agent",
        primitives: ["SENSE"],
        input_types: [],
        output_types: [],
        domain: "demo",
        allowed_tools: [UNKNOWN_SLUG],
      },
      deps,
    );
    expect(
      stillBlocked.ok,
      `agent_define accepted ${UNKNOWN_SLUG} after only tool_propose; ` +
        `propose without register must NOT grant scope.`,
    ).toBe(false);
  });

  it("positive-full: tool_propose → tool_register → agent_define with the same slug PASSES", async () => {
    // Register the slug through the governance pipeline. The dispatcher must
    // expose tool_register; if it doesn't, this test goes RED and we learn the
    // governance loop is half-built (propose without register = no gate at all).
    const register = await dispatchTool(
      "tool_register",
      {
        slug: UNKNOWN_SLUG,
        type: "mcp",
        spec: { description: "T16 governance probe — now registered" },
        category: "improve",
      },
      deps,
    );
    expect(
      register.ok,
      `tool_register failed or is not implemented. error=${register.error}. ` +
        `Without tool_register, propose-only governance is unfinished — there is no ` +
        `path to legitimately add a tool to the registry, so the rejection gate ` +
        `becomes a permanent block instead of a gate.`,
    ).toBe(true);

    // After registration, the same agent_define call must succeed.
    const allowed = await dispatchTool(
      "agent_define",
      {
        slug: "now-legit-agent",
        primitives: ["SENSE"],
        input_types: [],
        output_types: [],
        domain: "demo",
        allowed_tools: [UNKNOWN_SLUG],
      },
      deps,
    );
    expect(
      allowed.ok,
      `agent_define rejected ${UNKNOWN_SLUG} even after tool_register: ${allowed.error}. ` +
        `The propose→register→define loop must close cleanly.`,
    ).toBe(true);

    const data = allowed.data as {
      agent: { slug: string; allowed_tools?: readonly string[] };
      agent_profile_id: string;
      effective_hash: string;
    };
    expect(data.agent_profile_id).toBe("now-legit-agent");
    expect(data.effective_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.agent.allowed_tools ?? []).toContain(UNKNOWN_SLUG);
  });

  it("positive-control: agent_define with NO exotic allowed_tools always passes (gate is not blanket-rejecting)", async () => {
    const result = await dispatchTool(
      "agent_define",
      {
        slug: "vanilla-agent",
        primitives: ["SENSE"],
        input_types: [],
        output_types: [],
        domain: "demo",
        // no allowed_tools — deny-by-default cage, no governance check needed.
      },
      deps,
    );
    expect(result.ok, `vanilla agent_define rejected: ${result.error}`).toBe(true);
    const data = result.data as { agent_profile_id: string; effective_hash: string };
    expect(data.agent_profile_id).toBe("vanilla-agent");
    expect(data.effective_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("positive-control: agent_define with a KNOWN MCP tool slug in allowed_tools passes (registry-aware)", async () => {
    // tool_propose is itself an MCP_TOOLS slug — granting an agent scope to it
    // must work without any propose/register dance.
    const result = await dispatchTool(
      "agent_define",
      {
        slug: "proposer-agent",
        primitives: ["SENSE"],
        input_types: [],
        output_types: [],
        domain: "demo",
        allowed_tools: ["tool_propose"],
      },
      deps,
    );
    expect(
      result.ok,
      `agent_define rejected a KNOWN slug (tool_propose): ${result.error}. ` +
        `The gate is over-rejecting — it should accept slugs already in MCP_TOOLS.`,
    ).toBe(true);
    const data = result.data as { agent: { allowed_tools?: readonly string[] } };
    expect(data.agent.allowed_tools ?? []).toContain("tool_propose");
  });
});
