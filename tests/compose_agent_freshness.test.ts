// ux/12a-sketch-bugs — two sketch-time defects on standard_compose, each proved by one law that is
// RED against pre-fix code and GREEN after.
//
// (A) STALENESS. agent_define writes agents/<slug>.json but never refreshed deps.agents — the live
//     map standard_compose resolves slugs from. So a standard composed against an agent this very
//     session had just created was denied "agent not found in genome" until a manual genome_reload.
//     A tool must not deny a thing it just made.
//
// (B) SILENT NO-OP PARAMETER. standard_compose's input_schema advertises BOTH `agents` and
//     `agent_slugs`. The handler read only args['agents'], so passing the documented `agent_slugs`
//     (the shape the PERSISTED standards file carries) dropped every agent and failed via the same
//     misleading unknown-agent error. The documented parameter must actually compose.
//
// Neither law loosens a refusal: each makes a denial that never should have fired stop firing.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapServerDeps, dispatchTool, type ServerDeps } from "../src/server.js";

const REQUIRED_CORE_TYPES = [
  { slug: "Signal", primitive: "SENSE", description: "", schema: {} },
  { slug: "Interpretation", primitive: "INTERPRET", description: "", schema: {} },
  { slug: "Judgment", primitive: "JUDGE", description: "", schema: {} },
  { slug: "Plan", primitive: "PLAN", description: "", schema: {} },
  { slug: "Artifact", primitive: "CREATE", description: "", schema: {} },
  { slug: "Verdict", primitive: "VERIFY", description: "", schema: {} },
];

function writeJson(dir: string, name: string, body: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
}

// The agent the two laws create at RUNTIME via agent_define (not seeded on disk) — the whole point is
// that a JUST-created agent is immediately composable.
const FRESH_AGENT = {
  ...TEST_BEHAVIOR,
  slug: "fresh-scout",
  primitives: ["SENSE"],
  output_types: ["fresh-sig"],
  domain: "demo",
};

const senseChair = {
  role: "sense",
  agent_slug: "fresh-scout",
  depends_on: [],
  input_contract: [],
  output_contract: ["fresh-sig"],
  required_skills: [],
};

describe("standard_compose sees a just-defined agent with no genome_reload (ux/12a A + B)", () => {
  let root: string;
  let deps: ServerDeps;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coltrane-compose-freshness-"));
    for (const c of REQUIRED_CORE_TYPES) writeJson(join(root, "core_types"), `${c.slug}.json`, c);
    deps = bootstrapServerDeps(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ── (A) staleness ────────────────────────────────────────────────────────────────────────────
  it("an agent created via agent_define is immediately composable — NO genome_reload between them", async () => {
    const defined = await dispatchTool("agent_define", FRESH_AGENT, deps);
    expect(defined.ok, "agent_define must succeed").toBe(true);

    // No genome_reload here — this is the exact gap. Compose by the `agents` key.
    const composed = await dispatchTool("standard_compose", {
      slug: "std-agents",
      domain: "demo",
      agents: ["fresh-scout"],
      phases: [{ name: "p1", chairs: [senseChair] }],
    }, deps);

    expect(composed.ok, composed.error ?? "").toBe(true);
    // The composed standard actually carries the just-defined agent — read the persisted file, whose
    // agent_slugs is the resolved-slug list.
    const persisted = JSON.parse(readFileSync(join(root, "standards", "std-agents.json"), "utf-8")) as { agent_slugs: string[] };
    expect(persisted.agent_slugs).toContain("fresh-scout");
  });

  // ── (B) silent no-op parameter ─────────────────────────────────────────────────────────────────
  it("passing agent_slugs composes the SAME standard as passing agents (the documented key is no no-op)", async () => {
    expect((await dispatchTool("agent_define", FRESH_AGENT, deps)).ok).toBe(true);

    // Reference: the `agents` form.
    const viaAgents = await dispatchTool("standard_compose", {
      slug: "std-agents",
      domain: "demo",
      agents: ["fresh-scout"],
      phases: [{ name: "p1", chairs: [senseChair] }],
    }, deps);
    expect(viaAgents.ok).toBe(true);

    // The documented alias: `agent_slugs`, with the `agents` key ABSENT.
    const viaSlugs = await dispatchTool("standard_compose", {
      slug: "std-slugs",
      domain: "demo",
      agent_slugs: ["fresh-scout"],
      phases: [{ name: "p1", chairs: [senseChair] }],
    }, deps);
    expect(viaSlugs.ok, viaSlugs.error ?? "").toBe(true);

    // Identical composition: same resolved agents, same phases (only the slug differs by design).
    const a = JSON.parse(readFileSync(join(root, "standards", "std-agents.json"), "utf-8")) as { agent_slugs: string[]; phases: unknown };
    const b = JSON.parse(readFileSync(join(root, "standards", "std-slugs.json"), "utf-8")) as { agent_slugs: string[]; phases: unknown };
    expect(b.agent_slugs).toEqual(a.agent_slugs);
    expect(b.agent_slugs).toContain("fresh-scout");
    expect(b.phases).toEqual(a.phases);
  });
});
