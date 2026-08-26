/**
 * tool_register lands DURABLY when the deployment wires the seam — and refuses
 * to grant what it could not land.
 *
 * The registration wrote REGISTERED_TOOL_SLUGS (a process-local Set) and a
 * ledger row, and nothing else: "tool_register writes a process-local set that
 * dies with the request — durable registration is migration-only"
 * (plan.verb-library-extraction §16, store-plane gap #2). The store side now
 * has a durable writer (coltrane_tool_register, coltrane-ui 20260826120000);
 * this is the engine half, in the house seam idiom: the ENGINE defines the
 * hook, the DEPLOYMENT supplies the writer (placementResolver, queueGig,
 * hireMember — same shape). No endpoint in the engine, ever.
 *
 * ORDERING IS THE LAW HERE (#218's discipline extended): the durable write runs
 * BEFORE the slug becomes grantable. A tool granted in-session but absent from
 * the durable registry is gap #2 in reverse — a capability whose audit trail
 * dies with the process. If the durable write fails, the call fails and the
 * slug is NOT grantable.
 */
import { describe, expect, it } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";

function freshDeps(): ServerDeps {
  const registry = createRegistry([]);
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    toolProviders: new Map(),
  } as unknown as ServerDeps;
}

describe("tool_register lands durably through the deployment seam", () => {
  it("calls the wired durable writer with the full audit row, BEFORE granting", async () => {
    const deps = freshDeps();
    const landed: Record<string, unknown>[] = [];
    deps.registerToolDurable = async (row) => { landed.push(row); };

    const res = await dispatchTool("tool_register",
      { slug: "durably-landed-tool", type: "deployment", spec: { a: 1 }, category: "improve" }, deps);

    expect(res.ok, "the registration succeeds").toBe(true);
    expect(landed.length, "the durable writer was called exactly once").toBe(1);
    expect(landed[0], "the FULL audit row crosses the seam — slug, type, spec, category, registration_id").toMatchObject({
      slug: "durably-landed-tool", tool_type: "deployment", spec: { a: 1 }, category: "improve",
    });
    expect(typeof landed[0]!["registration_id"], "the registration_id ties the durable row to the ledger row").toBe("string");
    expect(deps.toolProviders?.get("durably-landed-tool"), "the slug is grantable after landing").toBeTruthy();
  });

  it("a FAILED durable write refuses the registration — nothing becomes grantable", async () => {
    const deps = freshDeps();
    deps.registerToolDurable = async () => { throw new Error("store said no"); };

    const res = await dispatchTool("tool_register",
      { slug: "never-grantable-tool", type: "deployment", spec: {}, category: "improve" }, deps);

    expect(res.ok, "the call reports the failure — never a silent local-only grant").toBe(false);
    expect(String((res as { error?: string }).error ?? ""), "the refusal names the cause").toContain("store said no");
    // The observable half of not-grantable: the provider bridge was never set.
    expect(deps.toolProviders?.get("never-grantable-tool"),
      "a tool the durable registry refused is not grantable in-session either — gap #2 in reverse is refused").toBeUndefined();
  });

  it("an UNWIRED seam keeps today's behaviour exactly (bare/OSS deployments unchanged)", async () => {
    const deps = freshDeps();
    expect(deps.registerToolDurable, "the seam is optional by absence").toBeUndefined();
    const res = await dispatchTool("tool_register",
      { slug: "local-only-tool", type: "deployment", spec: {}, category: "improve" }, deps);
    expect(res.ok).toBe(true);
    expect(deps.toolProviders?.get("local-only-tool")).toBeTruthy();
  });
});
