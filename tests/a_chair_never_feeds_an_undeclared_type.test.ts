// RED-first spec for #245's COMMON case: "a chair's input_contract must be compatible with the
// seated agent's declared input_types — every type the chair feeds the agent must be one the agent
// DECLARES it consumes (input_contract ⊆ agent.input_types, subtype-aware)."
//
// THE DEFECT (Vör, WO-R01). The engine enforces a chair's input_contract against the PIPELINE (what
// upstream produced — composition.ts:505-511 and runtime.ts:2299-2314) but NEVER against the seated
// agent's declared input_types. composition.ts:557-559 makes input_contract and ag.input_types
// BRANCHES of one ternary — they are never compared. runtime.ts:2315's input_types floor sits in the
// ELSE branch, unreachable when a chair declares an input_contract — and #245 (runtime.ts:2316-2318)
// was closed ONLY for the empty-input_contract branch. So a chair can feed an agent a type it never
// declared; compose/dispatch ACCEPTS it; the agent is invoked with an input it doesn't declare,
// confabulates, and seals status:complete with full provenance.
//
// These laws are RED by design: Case A composes today (ACCEPTED) and must be REFUSED after the fix.
// Every case targets the REAL callsite (composeStandard / runGig), so it can only pass once the
// comparison is built — never for a tautological reason.
//
// Vör's four controls are baked in:
//   A (the defect)   — input_contract feeds a type the agent does NOT declare → REFUSE (was ACCEPT).
//   B (negative)     — a genuinely mis-wired pipeline (input_contract needs an unproduced type) →
//                      still REFUSE (don't break existing pipeline enforcement).
//   C (matched)      — input_contract ⊆ agent.input_types → still ACCEPT (don't over-refuse).
//   D (harness)      — a chair seating a nonexistent agent → REFUSE (proves the harness sees refusals).
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import {
  composeStandard,
  defineAgent,
  loadGenome,
  runGig,
  CompositionError,
  RuntimeError,
  type Agent,
  type Standard,
} from "../src";
import { loadRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── Fixtures ────────────────────────────────────────────────────────────────
function testAgentBase(slug: string) {
  return {
    slug,
    identity: "test agent",
    method: "perform the test task",
    constraints: [] as string[],
    behavioral_primitives: ["executor", "critic"] as ["executor", "critic"],
  };
}

// A PLAN chair upstream so the CREATE writer passes the §3 reasoning check, and so "change-plan" is
// genuinely produced upstream. Keeps the synthetic standard valid on every OTHER composition law, so
// the ONLY thing that can make it throw is the input_contract-vs-input_types comparison under test.
const planner = () =>
  defineAgent({
    ...testAgentBase("planner"),
    primitives: ["PLAN"],
    input_types: [],
    output_types: ["change-plan"],
  });

/**
 * A two-phase standard: plan → write. The write chair seats `writer` with the given input_contract.
 * "red-spec" is a declared GIG input, so a chair MAY legitimately consume it (it is "produced"
 * upstream for the input_contract-satisfaction law) — which isolates the NEW comparison from the
 * existing pipeline check.
 */
function standardSeating(
  writer: Agent,
  writeInputContract: readonly string[],
  opts?: { writerSlug?: string; inputTypes?: readonly string[] },
) {
  return {
    slug: "syn-undeclared-input",
    domain: "eirtests",
    input_types: opts?.inputTypes ?? ["change-plan", "red-spec"],
    agents: [planner(), writer],
    phases: [
      {
        name: "plan",
        chairs: [
          {
            role: "plan",
            agent_slug: "planner",
            depends_on: [],
            input_contract: [],
            output_contract: ["change-plan"],
            required_skills: [],
          },
        ],
      },
      {
        name: "write",
        chairs: [
          {
            role: "write-change",
            agent_slug: opts?.writerSlug ?? writer.slug,
            depends_on: ["plan"],
            input_contract: writeInputContract,
            output_contract: ["change-set"],
            required_skills: [],
          },
        ],
      },
    ],
  };
}

/** Writer that declares it consumes ONLY change-plan. */
function narrowWriter(): Agent {
  return defineAgent({
    ...testAgentBase("writer"),
    primitives: ["CREATE"],
    input_types: ["change-plan"],
    output_types: ["change-set"],
  });
}

/** Writer that declares BOTH change-plan and red-spec. */
function wideWriter(): Agent {
  return defineAgent({
    ...testAgentBase("writer"),
    primitives: ["CREATE"],
    input_types: ["change-plan", "red-spec"],
    output_types: ["change-set"],
  });
}

/** Writer that declares it consumes a CORE type (Artifact) — the subtype-permissive case. */
function coreWriter(): Agent {
  return defineAgent({
    ...testAgentBase("writer"),
    primitives: ["CREATE"],
    input_types: ["change-plan", "Artifact"],
    output_types: ["change-set"],
  });
}

// ── Case A — THE DEFECT ───────────────────────────────────────────────────────
// The write chair feeds ["change-plan","red-spec"]; the seated writer declares ONLY ["change-plan"].
// red-spec is a gig input (so the pipeline law is satisfied), yet the AGENT never declared red-spec.
// Today this composes (the defect). After the fix it must be REFUSED.
describe("input_contract ⊆ agent.input_types — Case A (the defect)", () => {
  it("A-COMPOSE-REFUSES-UNDECLARED: composeStandard refuses a chair feeding a type the agent does not declare", () => {
    const bad = standardSeating(narrowWriter(), ["change-plan", "red-spec"]);
    expect(() => composeStandard(bad)).toThrow(CompositionError);
  });

  it("A-MESSAGE-NAMES-ALL: the refusal names the standard, chair, agent, offending type, and input_types", () => {
    const bad = standardSeating(narrowWriter(), ["change-plan", "red-spec"]);
    let err: unknown;
    try {
      composeStandard(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CompositionError);
    const msg = err instanceof Error ? err.message : "";
    expect(msg).toContain("syn-undeclared-input"); // standard slug
    expect(msg).toContain("write-change"); // chair role
    expect(msg).toContain("writer"); // agent slug
    expect(msg).toContain("red-spec"); // the offending fed type
    expect(msg).toContain("input_types"); // the agent's declaration named in the fix
  });

  it("A-RUNTIME-REFUSES-UNDECLARED (last line of defence): a compose-bypassing Standard is refused at dispatch, before invoke", async () => {
    // #245's own point: a hand-rolled Standard bypasses composition entirely, so the runtime is the
    // last line of defence. Build a VALID single-phase entry standard, then mutate the seated agent so
    // it no longer declares the type its chair feeds ("seed"). "seed" is a declared gig input supplied
    // in the payload, so the EXISTING input_contract runtime check passes (fromGig) — only the NEW
    // runtime comparison can refuse it, and it must refuse BEFORE the agent is ever invoked (the
    // matcher below asserts the specific message, so a schema/seal error cannot satisfy it spuriously).
    const reader = defineAgent({
      ...testAgentBase("reader"),
      primitives: ["INTERPRET"],
      input_types: ["seed"],
      output_types: ["change-set"],
    });
    const good = composeStandard({
      slug: "syn-runtime-undeclared",
      domain: "eirtests",
      input_types: ["seed"],
      agents: [reader],
      phases: [
        {
          name: "read",
          chairs: [
            {
              role: "read",
              agent_slug: "reader",
              depends_on: [],
              input_contract: ["seed"],
              output_contract: ["change-set"],
              required_skills: [],
            },
          ],
        },
      ],
    });
    let invoked = false;
    const tampered: Standard = {
      ...good,
      agents: good.agents.map((a) => (a.slug === "reader" ? { ...a, input_types: [] } : a)),
    };
    const g = loadGenome(REPO_ROOT);
    const registry = loadRegistry(g);
    await expect(
      runGig(tampered, { seed: { note: "x" } }, {
        outputs: createOutputStore(registry),
        ledger: new MemoryLedger(),
        invoke: () => {
          invoked = true;
          return { change: "confabulated" };
        },
        model_version: "deterministic-example",
      }),
    ).rejects.toThrow(/input_types|does not declare/);
    // The refusal is a REFUSAL, not a confabulation: the agent was never invoked.
    expect(invoked).toBe(false);
  });
});

// ── Control B — NEGATIVE (genuinely mis-wired pipeline) ───────────────────────
// input_contract requires "ghost", which the AGENT declares (so the NEW comparison is satisfied) but
// nothing upstream produces and no gig input supplies. The EXISTING pipeline check must still refuse.
// RED before AND after — proves the fix does not disturb existing pipeline enforcement.
describe("input_contract ⊆ agent.input_types — Control B (negative)", () => {
  it("B-PIPELINE-STILL-REFUSES: a type required but unproduced upstream is still refused", () => {
    const writer = defineAgent({
      ...testAgentBase("writer"),
      primitives: ["CREATE"],
      input_types: ["change-plan", "ghost"], // agent DECLARES ghost — so my new check passes …
      output_types: ["change-set"],
    });
    // … but ghost is neither produced upstream nor a gig input, so the pipeline law must refuse.
    const bad = standardSeating(writer, ["change-plan", "ghost"], { inputTypes: ["change-plan", "red-spec"] });
    expect(() => composeStandard(bad)).toThrow(CompositionError);
    let msg = "";
    try {
      composeStandard(bad);
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    // The refusal is the PIPELINE one (not produced upstream), not the new input_types one.
    expect(msg).toContain("not produced by any upstream chair");
  });
});

// ── Control C — MATCHED (must still ACCEPT) ───────────────────────────────────
// input_contract ⊆ agent.input_types. Must compose cleanly, before AND after. Two shapes: exact
// domain match, and the subtype-permissive case (agent declares CORE, chair feeds a domain subtype).
describe("input_contract ⊆ agent.input_types — Control C (matched)", () => {
  it("C-EXACT-ACCEPTS: a chair feeding exactly the agent's declared types composes", () => {
    const good = standardSeating(wideWriter(), ["change-plan", "red-spec"]);
    expect(() => composeStandard(good)).not.toThrow();
  });

  it("C-CORE-ACCEPTS: an agent declaring a core type accepts a chair feeding any type under it", () => {
    // writer declares ["change-plan","Artifact"]; the chair feeds "change-set" (a subtype of Artifact).
    // Compose is subtype-PERMISSIVE (it cannot resolve cores without the registry) — must not refuse.
    const good = standardSeating(coreWriter(), ["change-plan", "change-set"], {
      inputTypes: ["change-plan", "change-set"],
    });
    expect(() => composeStandard(good)).not.toThrow();
  });

  it("C-SUBSET-ACCEPTS: a chair consuming only PART of the agent's envelope composes", () => {
    // wideWriter declares ["change-plan","red-spec"]; the chair consumes only ["change-plan"].
    const good = standardSeating(wideWriter(), ["change-plan"]);
    expect(() => composeStandard(good)).not.toThrow();
  });
});

// ── Control D — HARNESS SANITY ────────────────────────────────────────────────
// A chair seating a nonexistent agent is refused — proves the harness can observe refusals at all.
describe("input_contract ⊆ agent.input_types — Control D (harness sanity)", () => {
  it("D-UNKNOWN-AGENT-REFUSES: a chair seating an agent not in the standard is refused", () => {
    const bad = standardSeating(wideWriter(), ["change-plan"], { writerSlug: "no-such-agent" });
    expect(() => composeStandard(bad)).toThrow(CompositionError);
  });
});

// ── Shipped-genome calibration ────────────────────────────────────────────────
// After the fix + genome corrections, the shipped genome must compose with ZERO standard load_errors.
// A standard feeding an undeclared type is the latent bug this closes; this gate proves none remain.
describe("input_contract ⊆ agent.input_types — shipped genome calibration", () => {
  it("CALIBRATION-GREEN: the shipped genome composes with no standard load_errors", () => {
    const g = loadGenome(REPO_ROOT);
    const standardErrors = g.load_errors.filter((e) => e.kind === "standard");
    expect(standardErrors).toEqual([]);
  });
});
