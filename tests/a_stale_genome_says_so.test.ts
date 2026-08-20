// RED-first — a server whose loaded genome has diverged from disk must SAY SO before it spends money
// running the stale definitions.
//
// MEASURED, TODAY. A long-running MCP server held a genome loaded hours earlier. `genome_reload`
// reported what had drifted underneath it:
//
//     modified: red-spec, change-context, prior-art-hit
//               10 standards
//               8 agents — including john, miles, bill, red-spec-drafter, pr-publisher
//     added:    bandleader, lineage-adopt-v0, studio-session-v0
//
// A gig dispatched in that window ran STALE DEFINITIONS OF ITS OWN CHAIRS for ninety minutes, and
// sealed outputs under a genome_hash that no re-run can reproduce. Nothing warned. Nothing could:
// dispatch never asks whether what it holds is what is on disk.
//
// WORSE, AND THIS IS WHY IT MATTERS: the staleness HID A LIVE OUTAGE. Commit 30d1b48 added a
// `pattern` to red-spec.diffs[].patch, which sealDrill could not satisfy, taking three standards
// undispatchable (software-change-pr-v1, software-change-red-first-v0, spec-drafting-v1 — the entire
// RED-first loop). The session that shipped it kept dispatching happily, because its server was still
// drilling the OLD schema. The breakage was invisible to the only people positioned to notice.
//
// THE HALF THAT IS ALREADY SOLVED, and the half that is not. tests/compose_agent_freshness.test.ts
// fixed staleness caused by the server's OWN writes: agent_define wrote agents/<slug>.json without
// refreshing deps.agents, so compose denied an agent it had just made. That direction is handled.
// EXTERNAL change is not: a git checkout, a branch switch, a merge, another process, a hand edit —
// the file moves under the server and dispatch is none the wiser.
//
// WHY A WARNING AND NOT A REFUSAL. Files change constantly in a dev tree; refusing every dispatch
// whose genome moved would make the engine unusable and would be a false refusal of exactly the kind
// that just took the pipeline offline. But an unreported divergence is a claim — "these are the
// definitions your gig ran" — that nothing checks. So: dispatch proceeds, and it NAMES what drifted,
// on the response the operator already reads.
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

const SCOUT = { ...TEST_BEHAVIOR, slug: "stale-scout", primitives: ["SENSE"], input_types: [], output_types: ["stale-sig"], domain: "demo" };
const SIG = { slug: "stale-sig", extends: "Signal", domain: "demo", schema: { type: "object", properties: { observation: { type: "string" } } }, required_fields: ["observation"] };
const CHAIR = { role: "sense", agent_slug: "stale-scout", depends_on: [], input_contract: [], output_contract: ["stale-sig"], required_skills: [] };

describe("a server whose genome drifted from disk says so at dispatch", () => {
  let root: string;
  let deps: ServerDeps;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "coltrane-stale-genome-"));
    for (const c of REQUIRED_CORE_TYPES) writeJson(join(root, "core_types"), `${c.slug}.json`, c);
    writeJson(join(root, "domain_types"), "stale-sig.json", SIG);
    writeJson(join(root, "agents"), "stale-scout.json", SCOUT);
    deps = bootstrapServerDeps(root);
    // A stub invoker: these laws are about the DISPATCH PATH (does it notice the genome moved?),
    // not about the model. Without it, wait:true tries to spawn a real chair and times out.
    (deps as unknown as { invoke: unknown }).invoke = async () => ({ source: "stub-source", observation: "stub" });
    const composed = await dispatchTool("standard_compose", {
      slug: "stale-std", domain: "demo", agent_slugs: ["stale-scout"], phases: [{ name: "p1", chairs: [CHAIR] }],
    }, deps);
    expect(composed.ok, composed.error ?? "compose must succeed").toBe(true);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("S1 — an AGENT changed on disk after load is named in the dispatch warnings", async () => {
    // The exact scenario: an external edit — a branch switch, a merge, another process — moves the
    // file under a running server. The gig will run the OLD definition; the operator must be told.
    const onDisk = JSON.parse(readFileSync(join(root, "agents", "stale-scout.json"), "utf-8")) as Record<string, unknown>;
    onDisk["identity"] = "an identity the loaded server has never seen";
    writeJson(join(root, "agents"), "stale-scout.json", onDisk);

    const res = await dispatchTool("gig_dispatch", { standard_slug: "stale-std", input: {}, wait: true }, deps);
    const warnings = ((res.data as { warnings?: string[] } | undefined)?.warnings ?? []).join(" | ");
    expect(warnings, "a drifted agent must be named, not silently run").toMatch(/stale-scout/);
    expect(warnings.toLowerCase()).toMatch(/stale|drift|disk|reload/);
  });

  it("S2 — a STANDARD whose PHASE GRAPH changed on disk is named too", async () => {
    // The phase graph is what the run IS: the chairs, their agents, their contracts, their order.
    // A chair's output_contract moving is the kind of drift that makes a sealed record describe a
    // run the files can no longer produce.
    const std = JSON.parse(readFileSync(join(root, "standards", "stale-std.json"), "utf-8")) as {
      phases: Array<{ chairs: Array<Record<string, unknown>> }>;
    };
    std.phases[0]!.chairs[0]!["output_contract"] = ["stale-sig", "stale-sig"];
    writeJson(join(root, "standards"), "stale-std.json", std);

    const res = await dispatchTool("gig_dispatch", { standard_slug: "stale-std", input: {}, wait: true }, deps);
    const warnings = ((res.data as { warnings?: string[] } | undefined)?.warnings ?? []).join(" | ");
    expect(warnings).toMatch(/stale-std/);
  });

  it("S3 — it WARNS, it does not refuse: the gig still runs", async () => {
    // A dev tree changes constantly. Refusing every dispatch whose genome moved would be a false
    // refusal of exactly the kind that just took three standards offline for an afternoon.
    const onDisk = JSON.parse(readFileSync(join(root, "agents", "stale-scout.json"), "utf-8")) as Record<string, unknown>;
    onDisk["identity"] = "changed";
    writeJson(join(root, "agents"), "stale-scout.json", onDisk);

    const res = await dispatchTool("gig_dispatch", { standard_slug: "stale-std", input: {}, wait: true }, deps);
    expect(res.ok, "a drifted genome warns; it must not block the run").toBe(true);
  });

  // ── NON-VACUITY ───────────────────────────────────────────────────────────────────────────────
  it("S4 — an UNCHANGED genome produces NO staleness warning", async () => {
    // Without this, a fix that warned unconditionally would pass S1–S3 and cry wolf on every
    // dispatch, which trains an operator to ignore the one warning that matters.
    const res = await dispatchTool("gig_dispatch", { standard_slug: "stale-std", input: {}, wait: true }, deps);
    // The control is only a control if the dispatch actually ran: an empty warnings list satisfies
    // "no staleness warning" even when nothing happened at all.
    expect(res.ok, res.error ?? "the unchanged-genome dispatch must succeed").toBe(true);
    const warnings = ((res.data as { warnings?: string[] } | undefined)?.warnings ?? []).join(" | ");
    expect(warnings.toLowerCase()).not.toMatch(/stale|drift/);
  });

  it("S5 — a definition this gig does NOT use is not reported as this gig's problem", async () => {
    // Scoped to what the gig actually runs. A dev tree always has unrelated edits in flight; naming
    // them here is noise that buries the signal.
    writeJson(join(root, "agents"), "unrelated.json", { ...TEST_BEHAVIOR, slug: "unrelated", primitives: ["SENSE"], input_types: [], output_types: ["stale-sig"], domain: "demo" });

    const res = await dispatchTool("gig_dispatch", { standard_slug: "stale-std", input: {}, wait: true }, deps);
    const warnings = ((res.data as { warnings?: string[] } | undefined)?.warnings ?? []).join(" | ");
    expect(warnings).not.toMatch(/unrelated/);
  });

  it("S6 — a COSMETIC edit is deliberately NOT reported: the scope is what the run is", async () => {
    // Scope, stated as a law rather than left as an accident of the implementation. `genome_hash` is
    // STRUCTURAL — per CLAUDE.md it covers the standard's phase graph plus each agent's slug,
    // primitives, input_types, output_types and domain. A description edit does not move it, so
    // warning "your genome_hash will not reproduce" over one would be a FALSE alarm, and a warning
    // that fires on noise is how an operator learns to skip the warning that matters.
    const std = JSON.parse(readFileSync(join(root, "standards", "stale-std.json"), "utf-8")) as Record<string, unknown>;
    std["description"] = "a purely cosmetic edit that changes nothing about the run";
    writeJson(join(root, "standards"), "stale-std.json", std);

    const res = await dispatchTool("gig_dispatch", { standard_slug: "stale-std", input: {}, wait: true }, deps);
    expect(res.ok, res.error ?? "").toBe(true);
    const warnings = ((res.data as { warnings?: string[] } | undefined)?.warnings ?? []).join(" | ");
    expect(warnings.toLowerCase()).not.toMatch(/stale|drift/);
  });
});
