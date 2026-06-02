import { describe, it, expect } from "vitest";
import { dispatchTool, createRegistry, createOutputStore, MemoryLedger, type ServerDeps } from "../src";

function deps(): ServerDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), model_version: "test" };
}

const finding = {
  slug: "finding",
  extends: "Interpretation",
  domain: "eirtests",
  schema: { type: "object", properties: { pattern_key: { type: "string" } } },
  required_fields: ["pattern_key"],
};

describe("type tools through the MCP router", () => {
  it("type_register registers a domain type (not a stub)", async () => {
    const res = await dispatchTool("type_register", finding, deps());
    expect(res.ok).toBe(true);
  });

  it("type_resolve returns 'use' for a registered type", async () => {
    const d = deps();
    await dispatchTool("type_register", finding, d);
    const res = await dispatchTool(
      "type_resolve",
      { core_type: "Interpretation", domain: "eirtests", required_fields: ["pattern_key"] },
      d,
    );
    expect(res.ok).toBe(true);
    expect((res.data as { action: string }).action).toBe("use");
  });

  it("type_browse lists registered types through the router", async () => {
    const d = deps();
    await dispatchTool("type_register", finding, d);
    const res = await dispatchTool("type_browse", {}, d);
    const types = (res.data as { types: { slug: string }[] }).types;
    expect(types.map((t) => t.slug)).toContain("finding");
  });

  it("type_register rejects a duplicate (reuse enforcement)", async () => {
    const d = deps();
    await dispatchTool("type_register", finding, d);
    let rejected = false;
    try {
      const res = await dispatchTool("type_register", { ...finding, slug: "finding-2" }, d);
      rejected = res.ok === false;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
