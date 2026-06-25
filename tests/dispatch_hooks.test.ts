// #206 — the dispatchTool interception seam. A wrapping layer injects pre/post hooks that
// gate/observe/rewrite tool calls in-process. The engine ships ZERO hooks + ZERO policy — only the
// loop and the types. These tests pin the CONTRACT: no-hooks is byte-identical to today; before can
// rewrite-or-halt; after folds; a thrown hook fails the call CLOSED; the guards keep unknown/
// not-implemented slugs from ever reaching a hook.
//
// The dispatch path is real: type_resolve calls deps.registry.resolveType, so a spy registry lets a
// test observe whether the IMPL actually ran (not just the returned shape).
import { describe, it, expect, vi } from "vitest";
import { dispatchTool, type ServerDeps, type ToolResult } from "../src/server.js";
import type { ToolHook } from "../src/hooks.js";

// Minimal deps: type_resolve only touches deps.registry.resolveType. The spy records its args so a
// test can assert the impl ran (or didn't) and saw the (possibly rewritten) args.
function depsWith(hooks?: readonly ToolHook[]): { deps: ServerDeps; resolveType: ReturnType<typeof vi.fn> } {
  const resolveType = vi.fn((q: unknown) => ({ resolved: true, query: q }));
  const deps = { registry: { resolveType } } as unknown as ServerDeps;
  return { deps: { ...deps, ...(hooks ? { hooks } : {}) }, resolveType };
}

const RESOLVE_ARGS = { core_type: "Signal", domain: "demo", required_fields: ["x"] };

describe("#206 — dispatchTool interception seam", () => {
  it("no hooks → byte-identical to no seam (undefined vs [])", async () => {
    const a = await dispatchTool("type_resolve", { ...RESOLVE_ARGS }, depsWith(undefined).deps);
    const b = await dispatchTool("type_resolve", { ...RESOLVE_ARGS }, depsWith([]).deps);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  });

  it("before: halt short-circuits — impl + after-hooks skipped, halt result returned verbatim", async () => {
    const afterSpy = vi.fn((_c, r: ToolResult) => r);
    const halt: ToolResult = { ok: false, requires_approval: true, error: "blocked: needs promotion review" };
    const hook: ToolHook = {
      name: "gate",
      before: () => ({ action: "halt", result: halt }),
      after: afterSpy,
    };
    const { deps, resolveType } = depsWith([hook]);
    const r = await dispatchTool("type_resolve", { ...RESOLVE_ARGS }, deps);
    expect(r).toBe(halt); // returned verbatim
    expect(resolveType, "impl must not run when a before-hook halts").not.toHaveBeenCalled();
    expect(afterSpy, "after-hooks are skipped on halt").not.toHaveBeenCalled();
  });

  it("before: continue may rewrite args, threaded to the impl", async () => {
    const hook: ToolHook = {
      name: "rewriter",
      before: (ctx) => ({ action: "continue", args: { ...ctx.args, domain: "rewritten" } }),
    };
    const { deps, resolveType } = depsWith([hook]);
    await dispatchTool("type_resolve", { ...RESOLVE_ARGS }, deps);
    expect(resolveType).toHaveBeenCalledTimes(1);
    expect(resolveType.mock.calls[0]![0]).toMatchObject({ domain: "rewritten" });
  });

  it("a rewrite is threaded across before-hooks in array order (last writer wins into the impl)", async () => {
    const h1: ToolHook = { name: "h1", before: (ctx) => ({ action: "continue", args: { ...ctx.args, domain: "from-h1" } }) };
    const h2: ToolHook = {
      name: "h2",
      before: (ctx) => {
        expect(ctx.args["domain"], "h2 sees h1's rewrite").toBe("from-h1");
        return { action: "continue", args: { ...ctx.args, domain: "from-h2" } };
      },
    };
    const { deps, resolveType } = depsWith([h1, h2]);
    await dispatchTool("type_resolve", { ...RESOLVE_ARGS }, deps);
    expect(resolveType.mock.calls[0]![0]).toMatchObject({ domain: "from-h2" });
  });

  it("after: folds over the result — each hook sees the prior's output", async () => {
    const tag = (t: string): ToolHook => ({
      name: t,
      // fold: each after-hook appends to what the PRIOR hook produced (impl's object data → []).
      after: (_c, r) => ({ ...r, data: [...(Array.isArray(r.data) ? r.data : []), t] }),
    });
    const { deps } = depsWith([tag("a"), tag("b")]);
    const r = await dispatchTool("type_resolve", { ...RESOLVE_ARGS }, deps);
    expect(r.data).toEqual(["a", "b"]); // a saw the impl's object (→ []); b saw a's ["a"]
  });

  it("hooks fire in array order across before AND after", async () => {
    const order: string[] = [];
    const mk = (n: string): ToolHook => ({
      name: n,
      before: () => { order.push(`before:${n}`); return { action: "continue" }; },
      after: (_c, r) => { order.push(`after:${n}`); return r; },
    });
    const { deps } = depsWith([mk("1"), mk("2")]);
    await dispatchTool("type_resolve", { ...RESOLVE_ARGS }, deps);
    expect(order).toEqual(["before:1", "before:2", "after:1", "after:2"]);
  });

  it("before throws → fail closed: {ok:false} naming the hook, impl never runs", async () => {
    const hook: ToolHook = { name: "boom", before: () => { throw new Error("policy unreachable"); } };
    const { deps, resolveType } = depsWith([hook]);
    const r = await dispatchTool("type_resolve", { ...RESOLVE_ARGS }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boom.*before|before.*boom/i);
    expect(r.error).toMatch(/policy unreachable/);
    expect(resolveType, "a gate that errors must never let the call through").not.toHaveBeenCalled();
  });

  it("after throws → fail closed: the result is discarded", async () => {
    const hook: ToolHook = { name: "afterboom", after: () => { throw new Error("mirror down"); } };
    const { deps, resolveType } = depsWith([hook]);
    const r = await dispatchTool("type_resolve", { ...RESOLVE_ARGS }, deps);
    expect(resolveType, "the impl still ran").toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/afterboom.*after|after.*afterboom/i);
  });

  it("unknown slug never reaches a hook (guarded before the seam)", async () => {
    const before = vi.fn(() => ({ action: "continue" as const }));
    const after = vi.fn((_c, r: ToolResult) => r);
    const { deps } = depsWith([{ name: "spy", before, after }]);
    const r = await dispatchTool("totally_unknown_tool", {}, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown tool/i);
    expect(before, "a guard-rejected slug must not reach before()").not.toHaveBeenCalled();
    expect(after, "a guard-rejected slug must not reach after()").not.toHaveBeenCalled();
  });
});
