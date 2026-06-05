// e2e — T18: recorder durability through mid-tool-call crash.
//
// Claim: when Claude crashes mid-gig (or any invoker throws between phases),
//   (a) outputs from completed phases survive in the store
//   (b) NO ledger entry exists for the crashed gig (runGig never reached its
//       deps.ledger.append() — the run is honestly un-sealed)
//   (c) gig_monitor on the crashed gig_id reports a partial state, NOT
//       "complete" (the substrate doesn't lie about a gig that didn't finish)
//   (d) a NEXT gig dispatched against the same deps runs cleanly to completion
//       — the partial state from the crash doesn't poison the next run
//   (e) execution_history_read does NOT list the crashed gig (no fake seal)
//
// This is the "lock-before-look" ratchet enforced at the runtime boundary:
// a half-finished gig must look half-finished to every read path, and the
// substrate must absorb a crash without corrupting forward-flow.
//
// Surface under test: src/runtime.ts (runGig phase loop + ledger.append at end)
// + src/outputs.ts (write-per-phase, no batch rollback) + src/server.ts
// (gig_dispatch / gig_monitor / execution_history_read).
//
// Crash simulation: inject an AgentInvoker that throws on phase 2 of a 3-phase
// standard. This is shape-equivalent to a real Claude subprocess dying mid-
// tool-call — the runtime sees a thrown error from invoke(), and we assert the
// observable state afterwards. The pre_reg honesty: this is a unit-shape test
// of the runtime's crash semantics, NOT a Claude-subprocess-killing test (the
// kill seam is non-deterministic across hosts).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  MemoryLedger,
  createOutputStore,
  dispatchTool,
  loadGenome,
  loadRegistry,
  runGig,
  type Agent,
  type AgentInvoker,
  type ServerDeps,
  type Standard,
} from "../../src/index.js";

import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";

let env: TempdirColtrane;
let deps: ServerDeps;

// A 3-phase standard so a phase-2 crash leaves phase-1 output behind AND has
// a clean phase-3 that never gets a chance to run. Each phase has its own
// agent producing its own typed output.
let threePhaseStandard: Standard;

const SENSOR: Agent = {
  slug: "sensor",
  primitives: ["SENSE"],
  input_types: [],
  output_types: ["raw-note"],
  domain: "demo",
};

const SUMMARIZER: Agent = {
  slug: "summarizer",
  primitives: ["INTERPRET"],
  input_types: ["raw-note"],
  output_types: ["summary"],
  domain: "demo",
};

const FINALIZER: Agent = {
  slug: "summarizer-2",
  primitives: ["INTERPRET"],
  input_types: ["summary"],
  output_types: ["summary"],
  domain: "demo",
};

function freshDepsFromGenome(root: string): ServerDeps {
  const genome = loadGenome(root);
  const registry = loadRegistry(genome);
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: genome.standards,
    invoke: undefined,
    model_version: "t18-crash-durability",
    genome_dir: root,
  };
}

describe("T18 — recorder durability through mid-tool-call crash", () => {
  beforeAll(async () => {
    env = await setupTempdirColtrane();

    // Keep core_types; clear other authored substrate so this test owns its surface.
    for (const sub of ["agents", "standards", "domain_types", "skills", "evals"]) {
      const p = join(env.tempDir, sub);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      mkdirSync(p, { recursive: true });
    }

    deps = freshDepsFromGenome(env.tempDir);

    // Author the two domain types + three agents + the 3-phase standard via the
    // MCP surface — same path a real caller would take.
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
    for (const a of [SENSOR, SUMMARIZER, FINALIZER]) {
      await dispatchTool(
        "agent_define",
        {
          slug: a.slug,
          primitives: a.primitives,
          input_types: a.input_types,
          output_types: a.output_types,
          domain: a.domain,
        },
        deps,
      );
    }
    const compose = await dispatchTool(
      "standard_compose",
      {
        slug: "three-phase",
        domain: "demo",
        agents: [SENSOR, SUMMARIZER, FINALIZER],
        phases: [
          { name: "sense", agent: "sensor" },
          { name: "interpret", agent: "summarizer" },
          { name: "finalize", agent: "summarizer-2" },
        ],
      },
      deps,
    );
    expect(compose.ok, `compose: ${compose.error}`).toBe(true);

    // Rebuild deps off the now-populated genome so deps.standards carries the
    // newly composed standard (loaders read from disk).
    deps = freshDepsFromGenome(env.tempDir);
    threePhaseStandard = deps.standards!.get("three-phase")!;
    expect(threePhaseStandard, "three-phase standard not loaded from disk").toBeTruthy();
  }, 600_000);

  afterAll(() => env?.cleanup());

  // ──────────────────────────────────────────────────────────────────────────
  // (a) + (b): crashing invoker leaves phase-1 output in the store + NO ledger
  //            entry. The runtime's append-after-loop discipline is the
  //            durability contract.
  // ──────────────────────────────────────────────────────────────────────────
  it("phase-2 crash: phase-1 output is in the store; ledger has no entry for the crashed gig", async () => {
    const crashingInvoker: AgentInvoker = ({ agent }) => {
      if (agent.slug === "sensor") return { body: "raw text from sensor" };
      if (agent.slug === "summarizer") {
        // Shape-equivalent to a Claude subprocess dying mid-tool-call: the
        // runtime's await deps.invoke(...) throws.
        throw new Error("simulated claude crash mid-tool-call (phase 2)");
      }
      throw new Error(`unexpected agent reached: ${agent.slug}`);
    };

    const outputsBefore = deps.outputs.all().length;
    const ledgerCountBefore = deps.ledger.count();

    await expect(
      runGig(threePhaseStandard, { source: "stdin" }, {
        outputs: deps.outputs,
        ledger: deps.ledger,
        invoke: crashingInvoker,
        model_version: "t18-crash",
      }),
    ).rejects.toThrow(/simulated claude crash/);

    // Phase 1's typed output landed BEFORE the crash — the store retained it
    // (no batch rollback at the runtime layer; per-phase writes are durable).
    const outputsAfter = deps.outputs.all();
    expect(
      outputsAfter.length - outputsBefore,
      "exactly one phase-1 output should survive the phase-2 crash",
    ).toBe(1);
    const partial = outputsAfter[outputsAfter.length - 1]!;
    expect(partial.domain_type).toBe("raw-note");
    expect(partial.agent_slug).toBe("sensor");
    expect(partial.data["body"]).toBe("raw text from sensor");

    // The ledger MUST NOT carry a seal for the crashed gig. runGig appends a
    // ledger entry only after the phase loop completes; a thrown invoker exits
    // before the append. This is the "no fake seal" half of the durability
    // contract.
    expect(
      deps.ledger.count(),
      `ledger count should be unchanged after a mid-gig crash (was ${ledgerCountBefore})`,
    ).toBe(ledgerCountBefore);
    const ledgerForPartialGig = deps.ledger.query({ gig_id: partial.gig_id });
    expect(
      ledgerForPartialGig.length,
      `ledger should have NO entry for the crashed gig_id ${partial.gig_id}`,
    ).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (c) + (e): gig_monitor + execution_history_read report the partial state
  //            honestly — running/unknown, not complete; no history row for
  //            the crashed gig.
  // ──────────────────────────────────────────────────────────────────────────
  it("gig_monitor reports the crashed gig as partial (NOT complete); execution_history excludes it", async () => {
    // Find the gig_id of the most recent crashed-phase-1 output.
    const all = deps.outputs.all();
    const partial = all[all.length - 1]!;
    const crashedGigId = partial.gig_id;

    const monitor = await dispatchTool("gig_monitor", { gig_id: crashedGigId }, deps);
    expect(monitor.ok).toBe(true);
    const m = monitor.data as {
      status: string;
      phases_complete: number;
      current_agent: string | null;
      outputs_so_far: Array<{ domain_type: string }>;
    };

    // Contract: status MUST NOT be "complete" — no ledger row means no seal.
    // gig_monitor's current impl returns "running" when outputs > 0 + no
    // ledger entry, which is the honest report for a partial state.
    expect(
      m.status,
      `gig_monitor lied about crashed gig: status="${m.status}" (must not be "complete")`,
    ).not.toBe("complete");
    expect(m.phases_complete).toBe(1);
    expect(m.current_agent).toBe("sensor");
    expect(m.outputs_so_far.length).toBe(1);
    expect(m.outputs_so_far[0]!.domain_type).toBe("raw-note");

    // execution_history_read filters by gig_id — the crashed gig must not
    // appear (its absence from the ledger IS the apoha kill for "complete").
    const history = await dispatchTool(
      "execution_history_read",
      { gig_id: crashedGigId },
      deps,
    );
    expect(history.ok).toBe(true);
    const h = history.data as { executions: Array<{ gig_id: string }>; count: number };
    expect(
      h.count,
      `execution_history_read returned ${h.count} entries for crashed gig (should be 0)`,
    ).toBe(0);
    expect(h.executions.length).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (d): a next gig dispatched against the same deps runs cleanly to
  //      completion. The crash didn't poison the substrate's forward-flow.
  // ──────────────────────────────────────────────────────────────────────────
  it("a NEXT gig dispatched after the crash runs to completion (partial state doesn't poison forward flow)", async () => {
    const healthyInvoker: AgentInvoker = ({ agent }) => {
      if (agent.slug === "sensor") return { body: "fresh sensor body after crash" };
      if (agent.slug === "summarizer") return { gist: "post-crash recovery summary" };
      if (agent.slug === "summarizer-2") return { gist: "finalized post-crash summary" };
      throw new Error(`unexpected agent: ${agent.slug}`);
    };

    const ledgerCountBefore = deps.ledger.count();
    const outputCountBefore = deps.outputs.all().length;

    const wired: ServerDeps = { ...deps, invoke: healthyInvoker };
    const dispatch = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "three-phase", input: { source: "stdin" } },
      wired,
    );
    expect(dispatch.ok, `next gig failed: ${dispatch.error}`).toBe(true);
    const data = dispatch.data as {
      gig_id: string;
      manifest: { output_count: number; genome_hash: string; run_fingerprint: string };
    };

    // All three phases ran; ledger sealed once for THIS gig only.
    expect(data.manifest.output_count).toBe(3);
    expect(deps.ledger.count()).toBe(ledgerCountBefore + 1);
    expect(deps.outputs.all().length).toBe(outputCountBefore + 3);

    const sealed = deps.ledger.query({ gig_id: data.gig_id });
    expect(sealed.length).toBe(1);
    expect(sealed[0]!.output_hashes.length).toBe(3);

    // The fresh gig's monitor reports complete — no contamination from the
    // earlier crashed gig.
    const mon = await dispatchTool("gig_monitor", { gig_id: data.gig_id }, wired);
    const monData = mon.data as { status: string; phases_complete: number };
    expect(monData.status).toBe("complete");
    expect(monData.phases_complete).toBe(3);

    // execution_history_read returns exactly the fresh gig for this gig_id —
    // the crashed gig's gig_id is a different uuid and stays absent.
    const history = await dispatchTool(
      "execution_history_read",
      { gig_id: data.gig_id },
      wired,
    );
    const h = history.data as { executions: Array<{ gig_id: string }>; count: number };
    expect(h.count).toBe(1);
    expect(h.executions[0]!.gig_id).toBe(data.gig_id);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Recovery diagnostic: output_query on the crashed gig still surfaces the
  // partial state — a future "resume" tool could read this to decide whether
  // to retry or abandon. v0 has no resume tool; the diagnostic is the seam.
  // ──────────────────────────────────────────────────────────────────────────
  it("output_query on the crashed gig_id returns the partial outputs (recovery diagnostic seam is live)", async () => {
    // Pull the crashed gig's id from the partial output written in test 1.
    // It's the raw-note that was NEVER followed by a summary in the same gig.
    const all = deps.outputs.all();
    const rawNotes = all.filter((o) => o.domain_type === "raw-note");
    expect(rawNotes.length).toBeGreaterThan(0);

    // The crashed gig is the one whose gig_id has NO matching ledger entry.
    const crashed = rawNotes.find(
      (o) => deps.ledger.query({ gig_id: o.gig_id }).length === 0,
    );
    expect(
      crashed,
      "could not find a raw-note belonging to a gig with no ledger seal (the crashed gig)",
    ).toBeTruthy();

    const q = await dispatchTool("output_query", { gig_id: crashed!.gig_id }, deps);
    expect(q.ok).toBe(true);
    const outs = (q.data as { outputs: Array<{ domain_type: string; agent_slug: string }> }).outputs;

    // Exactly one output — phase 1 only. A "resume" implementation could
    // inspect this shape (1 of 3 phases done, no ledger entry) and decide
    // whether to re-invoke from phase 2 with the surviving raw-note as input.
    expect(outs.length).toBe(1);
    expect(outs[0]!.domain_type).toBe("raw-note");
    expect(outs[0]!.agent_slug).toBe("sensor");
  });
});
