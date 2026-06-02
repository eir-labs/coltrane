// 5 easy-wire tools that have impl available — wire them out of NEEDS_RUNTIME.
// Prereg row: O9.

import { describe, it, expect, beforeEach } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";

function makeDeps(): ServerDeps {
  const registry = createRegistry();
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
  };
}

describe("tool_registry_browse", () => {
  it("returns the full MCP_TOOLS list", async () => {
    const r = await dispatchTool("tool_registry_browse", {}, makeDeps());
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    const data = r.data as { tools: Array<{ slug: string; category: string }> };
    expect(Array.isArray(data.tools)).toBe(true);
    expect(data.tools.length).toBeGreaterThan(20);
    expect(data.tools[0]).toHaveProperty("slug");
    expect(data.tools[0]).toHaveProperty("category");
  });

  it("filters by category when provided", async () => {
    const r = await dispatchTool("tool_registry_browse", { category: "understand" }, makeDeps());
    const data = r.data as { tools: Array<{ category: string }> };
    expect(data.tools.every((t) => t.category === "understand")).toBe(true);
  });
});

describe("agent_validate_pipeline", () => {
  it("accepts a valid SENSE→INTERPRET→JUDGE pipeline", async () => {
    const r = await dispatchTool(
      "agent_validate_pipeline",
      { primitives: ["SENSE", "INTERPRET", "JUDGE"] },
      makeDeps(),
    );
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    expect((r.data as { valid: boolean }).valid).toBe(true);
  });

  it("rejects CREATE without upstream INTERPRET or PLAN", async () => {
    const r = await dispatchTool(
      "agent_validate_pipeline",
      { primitives: ["SENSE", "CREATE"] },
      makeDeps(),
    );
    expect(r.ok).toBe(true);
    const data = r.data as { valid: boolean; errors: string[] };
    expect(data.valid).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);
  });
});

describe("type_extend", () => {
  it("returns a proposal for an additive change", async () => {
    const deps = makeDeps();
    deps.registry.registerType({
      slug: "finding",
      extends: "Judgment",
      domain: "test",
      schema: { type: "object", properties: { issue: { type: "string" } }, required: ["issue"] },
      required_fields: ["issue"],
    });
    const r = await dispatchTool(
      "type_extend",
      {
        slug: "finding",
        extension: { schema: { type: "object", properties: { issue: { type: "string" }, severity: { type: "string" } }, required: ["issue"] } },
      },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    const data = r.data as { change_class: string };
    expect(["additive", "modified", "breaking"]).toContain(data.change_class);
  });
});

describe("charter_read", () => {
  it("returns not-found error for missing charter (no path given)", async () => {
    const r = await dispatchTool("charter_read", {}, makeDeps());
    expect(r.ok).toBe(false);
    expect(r.not_implemented).toBeFalsy();
    expect(r.error).toContain("charter");
  });

  it("reads charter from explicit path", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "charter-"));
    const file = path.join(tmp, "charter.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        subject_name: "solo-test",
        subject_type: "solo",
        charter: "build the tool",
        north_stars: [],
        products: [],
        pain_points: [],
        tech_stack: [],
        existing_tools: [],
        access_grants: [],
      }),
    );
    const r = await dispatchTool("charter_read", { path: file }, makeDeps());
    expect(r.ok).toBe(true);
    const data = r.data as { subject_name: string };
    expect(data.subject_name).toBe("solo-test");
  });
});

describe("charter_suggest_update", () => {
  it("appends a proposal to the ledger and returns proposal_id", async () => {
    const deps = makeDeps();
    const r = await dispatchTool(
      "charter_suggest_update",
      {
        field: "charter",
        current_value: "old",
        suggested_value: "new",
        evidence: { source: "gig:abc", weight: 0.8 },
      },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    const data = r.data as { proposal_id: string };
    expect(typeof data.proposal_id).toBe("string");
    expect(data.proposal_id.length).toBeGreaterThan(0);
  });
});
