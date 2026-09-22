// spec.coltrane-sealed-inputs — a standard's input can be another gig's SEALED OUTPUT, by reference,
// resolved, re-verified and provenanced by the engine. No one copies JSON between gigs.
//
// A dispatch names sealed records in its payload with a marker in place of the data:
//   { "note": { "$output": "<id | content_sha>" } }                 one record, or an array of markers
//   { "note": { "$query": { type, where?, latest_by? } } }          every matching record
// runGig resolves the markers BEFORE any chair runs (every door — CLI, MCP, worker, chart — reaches
// runGig), refuses at the door on anything it cannot prove, and delivers each record individually to
// every chair whose input_contract names the type. What those chairs seal carries the record in
// input_refs/input_shas and an engine-stamped `input_resolutions` entry — the one thing that lets
// trace() cross into another gig. A hand-authored reference still cannot.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard, runGig,
  type AgentInvoker, type DomainType, type PhaseDef, type Standard, type OutputRecord,
} from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createMemoryReuseStore } from "../src/reuse.js";
import { testAgent } from "./_support/agents.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const UPSTREAM_ECHO = join(fileURLToPath(new URL("..", import.meta.url)), "tests/_support/skills/upstream-echo");

const NOTE: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" }, family: { type: "string" } } }, required_fields: ["t"] };
const MEMO: DomainType = { slug: "memo", extends: "Signal", domain: "demo", schema: { properties: { m: { type: "string" } } }, required_fields: ["m"] };
const LINKED: DomainType = { slug: "linked", extends: "Interpretation", domain: "demo", schema: { properties: { summary: { type: "string" } } }, required_fields: [] };

function world() {
  const registry = createRegistry();
  for (const t of [NOTE, MEMO, LINKED]) registry.registerType(t);
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { registry, outputs, ledger };
}

/** Gig A: seals `note` records, one per entry of `notes`. */
const producer = (): Standard => composeStandard({
  slug: "produce", domain: "demo",
  agents: [testAgent({ slug: "writer", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" })],
  phases: [{ name: "sense", chairs: [{ role: "w", agent_slug: "writer", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }] as PhaseDef[],
});

async function sealNotes(w: ReturnType<typeof world>, notes: Array<Record<string, unknown>>): Promise<OutputRecord[]> {
  const out: OutputRecord[] = [];
  for (const n of notes) {
    const r = await runGig(producer(), {}, { ...w, invoke: () => ({ ...n, source: "fixture://demo/note" }), model_version: "t" } as never);
    out.push(r.outputs.find((o) => o.domain_type === "note")!);
  }
  return out;
}

/** Gig B: declares `note` as a gig input. The entry chair and a DOWNSTREAM chair both declare it;
 *  a third chair does not. */
const consumer = (): Standard => composeStandard({
  slug: "consume", domain: "demo", input_types: ["note"],
  agents: [
    testAgent({ slug: "linker", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["linked"], domain: "demo" }),
    testAgent({ slug: "relinker", primitives: ["INTERPRET"], input_types: ["note", "linked"], output_types: ["linked"], domain: "demo" }),
    testAgent({ slug: "bystander", primitives: ["INTERPRET"], input_types: ["linked"], output_types: ["linked"], domain: "demo" }),
  ],
  phases: [
    { name: "link", chairs: [{ role: "l", agent_slug: "linker", depends_on: [], input_contract: ["note"], output_contract: ["linked"], required_skills: [] }] },
    { name: "relink", chairs: [
      { role: "r", agent_slug: "relinker", depends_on: ["l"], input_contract: ["note", "linked"], output_contract: ["linked"], required_skills: [] },
      { role: "b", agent_slug: "bystander", depends_on: ["l"], input_contract: ["linked"], output_contract: ["linked"], required_skills: [] },
    ] },
  ] as PhaseDef[],
});

/** An invoker that records what each chair was handed. */
function recorder() {
  const seen = new Map<string, OutputRecord[]>();
  const gigInputs = new Map<string, Record<string, unknown>>();
  const invoke: AgentInvoker = (ctx) => {
    seen.set(ctx.role ?? ctx.agent.slug, [...ctx.inputs]);
    gigInputs.set(ctx.role ?? ctx.agent.slug, ctx.gig_input);
    return { summary: `${ctx.agent.slug} ran`, claims: [`${ctx.agent.slug} read ${ctx.inputs.length} input(s)`] };
  };
  let calls = 0;
  const counted: AgentInvoker = (ctx) => { calls++; return invoke(ctx); };
  return { seen, gigInputs, invoke: counted, calls: () => calls };
}

const run = (w: ReturnType<typeof world>, input: Record<string, unknown>, invoke: AgentInvoker) =>
  runGig(consumer(), input, { ...w, invoke, model_version: "t" } as never);

// ── L1 — a named sealed output is delivered, byte-identical, to every chair that declares its type ──
describe("L1 — $output delivers the sealed record itself", () => {
  it("by id: the entry chair AND a downstream chair declaring the type receive it; a chair that does not declare it does not", async () => {
    const w = world();
    const [a] = await sealNotes(w, [{ t: "the disclosure" }]);
    const rec = recorder();
    const r = await run(w, { note: { $output: a!.id } }, rec.invoke);

    for (const role of ["l", "r"]) {
      const got = rec.seen.get(role)!.filter((i) => i.domain_type === "note");
      expect(got.map((i) => i.id), `chair "${role}" must receive the named record`).toEqual([a!.id]);
      expect(got[0]!.content_sha).toBe(a!.content_sha);
      expect(got[0]!.data).toEqual(a!.data);
    }
    expect(rec.seen.get("b")!.some((i) => i.domain_type === "note"), "a chair not declaring `note` must not receive it").toBe(false);
    // The marker is resolved, not passed through: no chair is handed `{"$output": …}` as data.
    for (const role of ["l", "r", "b"]) {
      expect(JSON.stringify(rec.gigInputs.get(role)), `chair "${role}" must not see the marker as gig input`).not.toContain("$output");
    }

    // what the entry chair sealed names the record in its engine-stamped provenance
    const linked = r.outputs.find((o) => o.from_role === "l")!;
    expect(linked.input_refs).toContain(a!.id);
    expect(linked.input_shas[linked.input_refs.indexOf(a!.id)]).toBe(a!.content_sha);
  });

  it("by content_sha resolves the same record", async () => {
    const w = world();
    const [a] = await sealNotes(w, [{ t: "by hash" }]);
    const rec = recorder();
    await run(w, { note: { $output: a!.content_sha } }, rec.invoke);
    expect(rec.seen.get("l")!.map((i) => i.id)).toEqual([a!.id]);
  });
});

// ── L2 / L3 / L4 — the door refuses what it cannot prove, before any chair runs ───────────────────
describe("the door refuses before any chair runs", () => {
  it("L2 — a record whose sealed type does not satisfy the declared input is refused, naming both types", async () => {
    const w = world();
    const memo = w.outputs.write({ core_type: "Signal", domain_type: "memo", domain: "demo", gig_id: "gig-m", agent_slug: "x", primitive: "SENSE", data: { m: "wrong type", source: "fixture://m" } });
    const rec = recorder();
    // Refused BY THE DOOR, naming both types — not by a later chair's input-contract check, which
    // would also mention them and would make this law pass with the door's type check cut.
    await expect(run(w, { note: { $output: memo.id } }, rec.invoke)).rejects.toThrow(/type is "memo"[\s\S]*does not satisfy the declared input "note"/);
    expect(rec.calls(), "no chair may run").toBe(0);
  });

  it("L3b — a reference under a key the standard does not declare is refused, never silently dropped", async () => {
    const w = world();
    const [a] = await sealNotes(w, [{ t: "orphan" }]);
    const rec = recorder();
    await expect(run(w, { note: { $output: a!.id }, memo: { $output: a!.id } }, rec.invoke)).rejects.toThrow(/does not declare "memo"/);
    expect(rec.calls()).toBe(0);
  });

  it("L3c — a value mixing references with plain data is refused — it is neither", async () => {
    const w = world();
    const [a] = await sealNotes(w, [{ t: "half" }]);
    const rec = recorder();
    await expect(run(w, { note: [{ $output: a!.id }, { t: "typed-in" }] }, rec.invoke)).rejects.toThrow(/mixes sealed-output references with plain data/);
    expect(rec.calls()).toBe(0);
  });

  it("L3 — a reference to no sealed record is refused", async () => {
    const w = world();
    const rec = recorder();
    await expect(run(w, { note: { $output: "no-such-output" } }, rec.invoke)).rejects.toThrow(/no-such-output/);
    expect(rec.calls()).toBe(0);
  });

  it("L4 — a record whose bytes no longer hash to its content_sha is refused at resolution", async () => {
    const w = world();
    const [a] = await sealNotes(w, [{ t: "original bytes" }]);
    // Tamper with the held record in place — the store hands back the row it holds.
    (w.outputs.get(a!.id)!.data as Record<string, unknown>)["t"] = "altered bytes";
    const rec = recorder();
    await expect(run(w, { note: { $output: a!.id } }, rec.invoke)).rejects.toThrow(/content_sha|hash/i);
    expect(rec.calls()).toBe(0);
  });
});

// ── L5 / L6 — a query resolves to every match, individually; an empty required query refuses ───────
describe("$query", () => {
  it("L5 — three matching records arrive as three inputs, never one merged object; where + latest_by select", async () => {
    const w = world();
    const notes = await sealNotes(w, [
      { t: "alpha v1", family: "alpha" },
      { t: "beta", family: "beta" },
      { t: "gamma", family: "gamma" },
      { t: "alpha v2", family: "alpha" },
    ]);
    const rec = recorder();
    await run(w, { note: { $query: { type: "note", latest_by: "family" } } }, rec.invoke);
    const got = rec.seen.get("l")!.filter((i) => i.domain_type === "note");
    expect(got.length, "one input per family, delivered individually").toBe(3);
    expect(new Set(got.map((i) => i.id))).toEqual(new Set([notes[1]!.id, notes[2]!.id, notes[3]!.id]));

    const rec2 = recorder();
    await run(w, { note: { $query: { type: "note", where: { family: "beta" } } } }, rec2.invoke);
    expect(rec2.seen.get("l")!.filter((i) => i.domain_type === "note").map((i) => i.id)).toEqual([notes[1]!.id]);
  });

  it("L6 — a query matching nothing, against a required input, is refused", async () => {
    const w = world();
    await sealNotes(w, [{ t: "only alpha", family: "alpha" }]);
    const rec = recorder();
    await expect(run(w, { note: { $query: { type: "note", where: { family: "absent" } } } }, rec.invoke)).rejects.toThrow(/matched no/i);
    expect(rec.calls()).toBe(0);
  });
});

// ── L7 / L8 — trace follows the edge the ENGINE sealed, and only that edge ─────────────────────────
describe("the cross-gig edge", () => {
  it("L7 — trace upstream from gig B's output reaches gig A's record, labelled cross_gig", async () => {
    const w = world();
    const [a] = await sealNotes(w, [{ t: "provenance root" }]);
    const r = await run(w, { note: { $output: a!.id } }, recorder().invoke);
    const linked = r.outputs.find((o) => o.from_role === "l")!;

    expect(linked.input_resolutions?.map((x) => x.output_id), "the engine stamps the resolution on what the chair sealed").toEqual([a!.id]);
    expect(linked.input_resolutions?.[0]?.from_gig).toBe(a!.gig_id);
    expect(linked.input_resolutions?.[0]?.resolved_by).toBe("dispatch");

    const nodes = w.outputs.trace(linked.id, { direction: "upstream" });
    const hop = nodes.find((n) => n.id === a!.id) as (OutputRecord & { cross_gig?: boolean }) | undefined;
    expect(hop, "the walk must reach the record gig A sealed").toBeTruthy();
    expect(hop!.cross_gig).toBe(true);

    // and the other way round
    const down = w.outputs.trace(a!.id, { direction: "downstream" });
    expect(down.some((n) => n.id === linked.id), "downstream from A reaches B's consumer").toBe(true);
  });

  it("L8 — a HAND-AUTHORED cross-gig reference through output_write is still refused by trace (PR #85)", async () => {
    const w = world();
    const [a] = await sealNotes(w, [{ t: "someone else's record" }]);
    const deps: ServerDeps = { registry: w.registry, outputs: w.outputs, ledger: w.ledger, gig_runs: new Map() };
    const forged = {
      output_id: a!.id, content_sha: a!.content_sha, from_gig: a!.gig_id,
      resolved_at: new Date().toISOString(), resolved_by: "dispatch",
    };
    const res = await dispatchTool("output_write", {
      core_type: "Interpretation", domain_type: "linked", domain: "demo", gig_id: "gig-forger",
      agent_slug: "forger", phase: "p", data: { summary: "forged", claims: ["forged"] },
      input_refs: [a!.id], input_resolutions: [forged],
    }, deps);
    expect(res.ok, String(res.error)).toBe(true);
    const id = String((res.data as Record<string, unknown>)["id"] ?? (res.data as Record<string, { id?: string }>)["output"]?.id);
    const sealed = w.outputs.get(id)!;
    expect(sealed.input_resolutions, "a caller cannot stamp a resolution").toBeUndefined();
    expect(w.outputs.trace(sealed.id, { direction: "upstream" }).some((n) => n.id === a!.id)).toBe(false);
  });
});

// ── L9 / L10 — the two other seal paths: a skill chair, and a chair served from the reuse cache ────
describe("every seal path carries the resolution", () => {
  it("L9 — a SKILL chair declaring the type receives the record, and what it seals is stamped", async () => {
    const w = world();
    const [a] = await sealNotes(w, [{ t: "for the skill" }]);
    const std = composeStandard({
      slug: "consume-skill", domain: "demo", input_types: ["note"], agents: [],
      phases: [{ name: "echo", chairs: [{ role: "echo", agent_slug: "", skill_slug: "upstream-echo", depends_on: [], input_contract: ["note"], output_contract: ["Signal"], required_skills: [] }] }] as PhaseDef[],
    });
    const r = await runGig(std, { note: { $output: a!.id } }, { ...w, invoke: () => ({}), skill_dirs: new Map([["upstream-echo", UPSTREAM_ECHO]]) } as never);
    const echo = r.outputs.find((o) => o.from_role === "echo")!;
    expect(echo.data["upstream_count"], "the skill must see the record").toBe(1);
    expect(echo.input_refs).toEqual([a!.id]);
    expect(echo.input_resolutions?.map((x) => x.output_id)).toEqual([a!.id]);
  });

  it("L10 — a chair served from the reuse cache keeps the walk into the gig that sealed its input", async () => {
    const w = world();
    const [a] = await sealNotes(w, [{ t: "reused input" }]);
    const reuse = createMemoryReuseStore();
    const once = recorder();
    await runGig(consumer(), { note: { $output: a!.id } }, { ...w, invoke: once.invoke, reuse, model_version: "t" } as never);
    const twice = recorder();
    const r2 = await runGig(consumer(), { note: { $output: a!.id } }, { ...w, invoke: twice.invoke, reuse, model_version: "t" } as never);
    expect(twice.seen.has("l"), "the second run must be served from the cache, or this law tests nothing").toBe(false);
    const recalled = r2.outputs.find((o) => o.from_role === "l")!;
    expect(recalled.reused_from, "the entry chair's record is a recall").toBeTruthy();
    expect(recalled.input_resolutions?.map((x) => x.output_id)).toEqual([a!.id]);
    expect(w.outputs.trace(recalled.id, { direction: "upstream" }).some((n) => n.id === a!.id)).toBe(true);
  });
});
