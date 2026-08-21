// O22 — the MCP server bootstraps from the genome FILES. Before this, runStdioServer
// started with an empty registry + no standards, so a bare `node dist/server.js` could
// never run a gig (gig_dispatch returned not_implemented — no standards wired). Now the
// server loads the on-disk genome at startup, so the shipped types/agents/standards are
// live, and gig_dispatch can run a file-defined standard end-to-end.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { bootstrapServerDeps, dispatchTool } from "../src/server.js";
import type { AgentInvoker } from "../src/runtime.js";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("server bootstraps the genome from files", () => {
  it("loads the on-disk genome: registry has the file types, standards has the file standard", () => {
    const deps = bootstrapServerDeps(REPO);
    expect(deps.registry.listTypes().some((t) => t.slug === "raw-note")).toBe(true);
    expect(deps.registry.listTypes().some((t) => t.slug === "summary")).toBe(true);
    expect(deps.standards?.get("summarize")).toBeDefined();
  });

  it("gig_dispatch runs a FILE-defined standard end-to-end (no inline defs)", async () => {
    const invoke: AgentInvoker = (ctx) =>
      ctx.agent.slug === "sensor" ? { text: "the room is loud" } : { gist: "loud room" };
    // Isolate the single-flight lock key (change c1d0c2e0): this end-to-end dispatch backs on the
    // shared REPO checkout, and dispatch_preflight.test.ts dispatches the same standard against the
    // same checkout in the parallel band — a shared genome_dir would let the two PROCESSES contend
    // for one repo lock. The genome is already loaded into deps from REPO; only the lock key moves.
    const deps = { ...bootstrapServerDeps(REPO), invoke, genome_dir: mkdtempSync(join(tmpdir(), "coltrane-bootstrap-lock-")) };
    const res = await dispatchTool("gig_dispatch", { standard_slug: "summarize", input: { topic: "noise" } }, deps);
    expect(res.ok).toBe(true);
    expect((res.data as { gig_id?: string })?.gig_id).toBeTruthy();
  });

  it("an unknown standard fails honestly (not a crash)", async () => {
    const deps = bootstrapServerDeps(REPO);
    const res = await dispatchTool("gig_dispatch", { standard_slug: "nope", input: {} }, deps);
    expect(res.ok).toBe(false);
  });
});
