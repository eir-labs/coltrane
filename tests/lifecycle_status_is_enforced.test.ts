// #203, the other half — a lifecycle field nothing READS.
//
// The first half of #203 was that the loader STRIPPED `status`: an author marked a standard
// deprecated, the edit was accepted, and the field vanished. That is fixed, and
// `silent_genome_drops.test.ts` holds the line.
//
// It is half a fix. `status` now survives the loader, is persisted by `standard_compose`, and
// is moved by `standard_promote` — and no code path anywhere consults it. Grep the engine for
// a read of `standard.status` and the answer is nothing. So the original SYMPTOM is untouched:
//
//   "a retired standard stays dispatchable and nothing says otherwise"
//
// An operator can now write down that a standard is retired, watch the value round-trip
// through the loader, and still dispatch it. That is arguably worse than dropping the field,
// because the round-trip is evidence the declaration took effect when it did not.
//
// The policy, decided rather than inferred from the enum's spelling:
//
//   retired    → REFUSE. This is the state's whole purpose. A retired standard is one somebody
//                decided must stop running; if it still runs, `retired` means nothing.
//   deprecated → ALLOW, and say so. "Deprecated" means "still works, stop building on it" in
//                every other system a caller has used. Refusing here would make it a synonym
//                for retired and leave no way to say the softer thing.
//   active     → unchanged.
//
// The deprecated/retired split is the substance of this file. A guard that refused both would
// pass a test that only checked "retired is refused" while quietly destroying the ability to
// deprecate anything.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard,
  type AgentInvoker, type DomainType, type PhaseDef, type Chair, type Standard,
} from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = {
  slug: "note", extends: "Signal", domain: "demo",
  schema: { properties: { t: { type: "string" } } }, required_fields: ["t"],
};
const chair: Chair = {
  role: "s", agent_slug: "solo", depends_on: [],
  input_contract: [], output_contract: ["note"], required_skills: [],
};
// Signal-cored, so the seal floor wants a `source`.
const SIGNAL = { source: "fixture://demo/note" };

const standard = (status?: "active" | "deprecated" | "retired"): Standard => composeStandard({
  slug: "lifecycle-demo", domain: "demo",
  agents: [testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" })],
  phases: [{ name: "sense", chairs: [chair] } as PhaseDef],
  ...(status ? { status } : {}),
});

function deps(status: "active" | "deprecated" | "retired" | undefined, invoke: AgentInvoker): ServerDeps {
  const registry = createRegistry();
  registry.registerType(note);
  const std = standard(status);
  return {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    standards: new Map([[std.slug, std]]), invoke, gig_runs: new Map(),
  };
}

describe("#203 — dispatch reads the lifecycle status it was told to record", () => {
  it("REFUSES to dispatch a retired standard", async () => {
    let invoked = false;
    const d = deps("retired", () => { invoked = true; return { t: "hi", ...SIGNAL }; });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "lifecycle-demo", input: {}, wait: true }, d);

    expect(r.ok, "a retired standard that still dispatches makes `retired` a decorative field").toBe(false);
    expect(String(r.error)).toMatch(/retired/i);
    expect(invoked, "and it must refuse BEFORE spending a token on the first chair").toBe(false);
  });

  it("names the standard and its status in the refusal, so the operator can act on it", async () => {
    const d = deps("retired", () => ({ t: "hi", ...SIGNAL }));
    const r = await dispatchTool("gig_dispatch", { standard_slug: "lifecycle-demo", input: {}, wait: true }, d);
    // Anchored to both facts independently: a message naming only the status could belong to
    // any standard, and one naming only the slug does not say what is wrong with it.
    expect(String(r.error)).toMatch(/lifecycle-demo/);
    expect(String(r.error)).toMatch(/retired/i);
  });

  it("ALLOWS a deprecated standard — that is the difference between the two states", async () => {
    let invoked = false;
    const d = deps("deprecated", () => { invoked = true; return { t: "hi", ...SIGNAL }; });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "lifecycle-demo", input: {}, wait: true }, d);

    expect(r.ok, r.error).toBe(true);
    expect(
      invoked,
      "deprecated must keep running. A guard that refused it too would pass the retired test " +
        "above while removing any way to say 'still works, stop building on it'.",
    ).toBe(true);
  });

  it("but a deprecated dispatch WARNS, so the caller learns without being blocked", async () => {
    const d = deps("deprecated", () => ({ t: "hi", ...SIGNAL }));
    const r = await dispatchTool("gig_dispatch", { standard_slug: "lifecycle-demo", input: {}, wait: true }, d);
    const warnings = (r.data as { warnings?: string[] }).warnings ?? [];
    expect(warnings.join(" "), "an unannounced deprecation is the silent drop wearing a new hat").toMatch(/deprecated/i);
  });

  it("the async path refuses too — not just the wait:true one", async () => {
    // The two dispatch modes have separate bodies below the guard; a check placed inside the
    // synchronous branch would leave the path the product actually uses wide open.
    let invoked = false;
    const d = deps("retired", () => { invoked = true; return { t: "hi", ...SIGNAL }; });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "lifecycle-demo", input: {} }, d);

    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/retired/i);
    // Give a background run that should not exist the chance to prove it exists.
    await new Promise((res) => setTimeout(res, 30));
    expect(invoked, "the async path is the one the product dispatches through").toBe(false);
  });

  it("an active standard is untouched, and carries no warning", async () => {
    const d = deps("active", () => ({ t: "hi", ...SIGNAL }));
    const r = await dispatchTool("gig_dispatch", { standard_slug: "lifecycle-demo", input: {}, wait: true }, d);
    expect(r.ok, r.error).toBe(true);
    expect((r.data as { warnings?: string[] }).warnings ?? []).toEqual([]);
  });

  it("a standard with NO status declared still dispatches", async () => {
    // 34 hand-rolled standards in this suite alone omit it, and every in-memory Standard built
    // by a caller may. Treating absent as retired would break all of them.
    let invoked = false;
    const d = deps(undefined, () => { invoked = true; return { t: "hi", ...SIGNAL }; });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "lifecycle-demo", input: {}, wait: true }, d);
    expect(r.ok, r.error).toBe(true);
    expect(invoked).toBe(true);
  });
});
