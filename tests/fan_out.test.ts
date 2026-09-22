// FAN-OUT — one chair template, seated once per item of a sealed set, each instance seeing only its
// slice. The split is the ENGINE's (deterministic, from the data), never the model's, and each
// instance's seal names the exact slice it read, so "which chair saw which rules" is a record, not a
// recollection.
//
//   fan_out: { over: { type, path, key }, join?: [{ type, path, on, match }] }
//
// The motivating shape is eir-drafting's instrument chain: five hand-named compose chairs, each handed
// the WHOLE charter and the WHOLE rule-set. Fanned out, each clause family gets its own seat with only
// its family and only the rules it needs — the context a cheap model can hold.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard, runGig, sha256Hex, canonJson,
  type AgentInvoker, type DomainType, type PhaseDef, type Standard, type OutputRecord, type Chair,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { createMemoryReuseStore } from "../src/reuse.js";

const TYPES: DomainType[] = [
  { slug: "fanx-charter", extends: "Plan", domain: "demo", schema: { properties: { families: { type: "array" } } }, required_fields: [] },
  { slug: "fanx-ruleset", extends: "Interpretation", domain: "demo", schema: { properties: { rules: { type: "array" } } }, required_fields: [] },
  { slug: "fanx-clause", extends: "Artifact", domain: "demo", schema: { properties: { family: { type: "string" } } }, required_fields: ["family"] },
  { slug: "fanx-check", extends: "Verdict", domain: "demo", schema: {}, required_fields: [] },
  { slug: "fanx-bundle", extends: "Artifact", domain: "demo", schema: { properties: { bundled: { type: "string" } } }, required_fields: ["bundled"] },
];

const FAMILIES = [
  { family: "grant", needs: ["59", "61"] },
  { family: "mention", needs: ["27"] },
  { family: "moral", needs: ["59"] },
];
const RULES = [
  { id: "r59", article: "59" },
  { id: "r61", article: "61" },
  { id: "r27", article: "27" },
  { id: "r99", article: "99" }, // needed by no family
];

function world() {
  const registry = createRegistry();
  for (const t of TYPES) registry.registerType(t);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

const FAN: NonNullable<Chair["fan_out"]> = {
  over: { type: "fanx-charter", path: "families", key: "family" },
  join: [{ type: "fanx-ruleset", path: "rules", on: "article", match: "needs" }],
};

function standard(opts: { verify?: boolean; fan?: Chair["fan_out"]; contract?: string[] } = {}): Standard {
  const compose: Chair = {
    role: "compose", agent_slug: "composer", depends_on: ["rules"],
    input_contract: opts.contract ?? ["fanx-charter", "fanx-ruleset"], output_contract: ["fanx-clause"], required_skills: [],
    fan_out: opts.fan === undefined ? FAN : opts.fan,
  } as Chair;
  return composeStandard({
    slug: "fan", domain: "demo", input_types: ["fanx-charter"],
    ...(opts.verify ? { max_examine_rounds: 1 } : {}),
    agents: [
      testAgent({ slug: "rulesmith", primitives: ["INTERPRET"], input_types: ["fanx-charter"], output_types: ["fanx-ruleset"], domain: "demo" }),
      testAgent({ slug: "composer", primitives: ["CREATE"], input_types: ["fanx-charter", "fanx-ruleset", "fanx-check"], output_types: ["fanx-clause"], domain: "demo" }),
      testAgent({ slug: "checker", primitives: ["VERIFY"], input_types: ["fanx-clause"], output_types: ["fanx-check"], domain: "demo" }),
      testAgent({ slug: "collector", primitives: ["CREATE"], input_types: ["fanx-clause"], output_types: ["fanx-bundle"], domain: "demo" }),
    ],
    phases: [
      { name: "rules", chairs: [{ role: "rules", agent_slug: "rulesmith", depends_on: [], input_contract: ["fanx-charter"], output_contract: ["fanx-ruleset"], required_skills: [] }] },
      { name: "compose", chairs: [compose] },
      ...(opts.verify ? [{ name: "check", chairs: [{ role: "check", agent_slug: "checker", depends_on: ["compose"], input_contract: ["fanx-clause"], output_contract: ["fanx-check"], required_skills: [] }] }] : []),
      { name: "collect", chairs: [{ role: "collect", agent_slug: "collector", depends_on: ["compose"], input_contract: ["fanx-clause"], output_contract: ["fanx-bundle"], required_skills: [] }] },
    ] as PhaseDef[],
  });
}

type Seen = { role: string; gig_input: Record<string, unknown>; inputs: OutputRecord[]; resume?: boolean };

function band(opts: { rules?: unknown[]; failFirstCheck?: boolean } = {}) {
  const seen: Seen[] = [];
  let checks = 0;
  const invoke: AgentInvoker = (ctx) => {
    seen.push({ role: ctx.role ?? "", gig_input: ctx.gig_input, inputs: [...ctx.inputs], ...(ctx.resume ? { resume: true } : {}) });
    switch (ctx.agent.slug) {
      case "rulesmith": return { rules: opts.rules ?? RULES, claims: ["rules read"] };
      case "composer": {
        const fams = ((ctx.gig_input["fanx-charter"] as { families?: Array<{ family: string }> } | undefined)?.families) ?? [];
        return { ...coreInvariantFields("Artifact"), family: fams.map((f) => f.family).join("+"), content: `clause for ${ctx.role}` };
      }
      case "checker": {
        checks++;
        const pass = !(opts.failFirstCheck && checks === 1);
        return { ...coreInvariantFields("Verdict"), pass };
      }
      default: return { ...coreInvariantFields("Artifact"), bundled: "all clauses" };
    }
  };
  return { seen, invoke };
}

const composerCalls = (seen: Seen[]) => seen.filter((s) => s.role.startsWith("compose"));

// ── F1 — one instance per item, each seeing only its own item ───────────────────────────────────
describe("F1 — the over set is partitioned: every item reaches exactly one instance", () => {
  it("three families → three seats, each handed exactly its family, none dropped, none duplicated", async () => {
    const w = world();
    const b = band();
    const r = await runGig(standard(), { "fanx-charter": { families: FAMILIES } }, { ...w, invoke: b.invoke } as never);
    const calls = composerCalls(b.seen);
    expect(calls.map((c) => c.role).sort()).toEqual(["compose#grant", "compose#mention", "compose#moral"]);
    for (const c of calls) {
      const fams = (c.gig_input["fanx-charter"] as { families: Array<{ family: string }> }).families;
      expect(fams.map((f) => f.family), `${c.role} must see only its own family`).toEqual([c.role.split("#")[1]]);
    }
    // A downstream chair depending on the TEMPLATE role receives every instance's output.
    const collect = b.seen.find((s) => s.role === "collect")!;
    expect(collect.inputs.filter((i) => i.domain_type === "fanx-clause").length).toBe(3);
    expect(r.status).toBe("complete");
  });
});

// ── F2 — a join hands each instance only the items that match it; an unmatched item is reported ───
describe("F2 — join", () => {
  it("each instance receives only the rules its family needs; a rule no family needs is reported, not dropped silently", async () => {
    const w = world();
    const b = band();
    const events: Array<Record<string, unknown>> = [];
    await runGig(standard(), { "fanx-charter": { families: FAMILIES } }, { ...w, invoke: b.invoke, onProgress: (e: unknown) => events.push(e as Record<string, unknown>) } as never);
    const rulesOf = (role: string) => {
      const rs = composerCalls(b.seen).find((c) => c.role === role)!.inputs.find((i) => i.domain_type === "fanx-ruleset")!;
      return (rs.data["rules"] as Array<{ id: string }>).map((x) => x.id).sort();
    };
    expect(rulesOf("compose#grant")).toEqual(["r59", "r61"]);
    expect(rulesOf("compose#mention")).toEqual(["r27"]);
    expect(rulesOf("compose#moral")).toEqual(["r59"]);
    const unmatched = events.find((e) => e["type"] === "fan_out_unmatched");
    expect(unmatched, "an item no instance receives must be reported").toBeTruthy();
    expect(unmatched!["set_type"]).toBe("fanx-ruleset");
    expect(unmatched!["values"], "reported by the join field it failed to match on").toEqual(["99"]);
  });
});

// ── F3 — the engine stamps the slice each instance read ────────────────────────────────────────
describe("F3 — each instance's seal names its slice", () => {
  it("shard names the template role, the key and value, and the sha of the exact slice the chair was handed", async () => {
    const w = world();
    const b = band();
    const r = await runGig(standard(), { "fanx-charter": { families: FAMILIES } }, { ...w, invoke: b.invoke } as never);
    const ruleset = r.outputs.find((o) => o.domain_type === "fanx-ruleset")!;
    for (const c of composerCalls(b.seen)) {
      const clause = r.outputs.find((o) => o.from_role === c.role)!;
      expect(clause, `${c.role} sealed nothing`).toBeTruthy();
      const shard = clause.shard!;
      expect(shard.of).toBe("compose");
      expect(shard.key).toBe("family");
      expect(shard.value).toBe(c.role.split("#")[1]);
      const charterSlice = shard.slices.find((s) => s.type === "fanx-charter")!;
      expect(charterSlice.source).toBe("gig_input");
      expect(charterSlice.slice_sha).toBe(sha256Hex(canonJson(c.gig_input["fanx-charter"])));
      const ruleSlice = shard.slices.find((s) => s.type === "fanx-ruleset")!;
      expect(ruleSlice.source).toBe(ruleset.id);
      expect(ruleSlice.content_sha).toBe(ruleset.content_sha);
      const handed = c.inputs.find((i) => i.domain_type === "fanx-ruleset")!;
      expect(ruleSlice.slice_sha).toBe(sha256Hex(canonJson(handed.data)));
      // provenance still points at the WHOLE sealed record the slice was cut from
      expect(clause.input_refs).toContain(ruleset.id);
      expect(clause.input_shas[clause.input_refs.indexOf(ruleset.id)]).toBe(ruleset.content_sha);
    }
  });

  it("a set sealed in ANOTHER gig and named by $output is sliced the same way, and the slice names that record", async () => {
    const w = world();
    const charterRec = w.outputs.write({ core_type: "Plan", domain_type: "fanx-charter", domain: "demo", gig_id: "gig-charter", agent_slug: "author", primitive: "PLAN", data: { families: FAMILIES, steps: ["s"] } });
    const b = band();
    const r = await runGig(standard(), { "fanx-charter": { $output: charterRec.id } }, { ...w, invoke: b.invoke } as never);
    const calls = composerCalls(b.seen);
    expect(calls.length).toBe(3);
    const grant = r.outputs.find((o) => o.from_role === "compose#grant")!;
    const slice = grant.shard!.slices.find((s) => s.type === "fanx-charter")!;
    expect(slice.source).toBe(charterRec.id);
    expect(slice.content_sha).toBe(charterRec.content_sha);
    const handed = calls.find((c) => c.role === "compose#grant")!.inputs.find((i) => i.domain_type === "fanx-charter")!;
    expect((handed.data["families"] as unknown[]).length).toBe(1);
  });
});

// ── F4 — what cannot be split is refused, before any instance runs ─────────────────────────────
describe("F4 — refusals", () => {
  const refuses = async (input: Record<string, unknown>, re: RegExp, rules?: unknown[]) => {
    const w = world();
    const b = band(rules ? { rules } : {});
    await expect(runGig(standard(), input, { ...w, invoke: b.invoke } as never)).rejects.toThrow(re);
    expect(composerCalls(b.seen).length, "no instance may run").toBe(0);
  };
  it("an empty set", () => refuses({ "fanx-charter": { families: [] } }, /fan-out[\s\S]*no items/i));
  it("a path that is not an array", () => refuses({ "fanx-charter": { families: "grant" } }, /fan-out[\s\S]*not an array/i));
  it("two items with one key", () => refuses({ "fanx-charter": { families: [{ family: "grant", needs: [] }, { family: "grant", needs: [] }] } }, /fan-out[\s\S]*duplicate key "grant"/i));
  it("an item with no key", () => refuses({ "fanx-charter": { families: [{ needs: [] }] } }, /fan-out[\s\S]*no "family"/i));
  it("two source records of the over type — which one to split is not the engine's guess", async () => {
    const w = world();
    const mk = (g: string) => w.outputs.write({ core_type: "Plan", domain_type: "fanx-charter", domain: "demo", gig_id: g, agent_slug: "a", primitive: "PLAN", data: { families: FAMILIES, steps: ["s"] } });
    const [c1, c2] = [mk("g1"), mk("g2")];
    const b = band();
    await expect(runGig(standard(), { "fanx-charter": [{ $output: c1.id }, { $output: c2.id }] }, { ...w, invoke: b.invoke } as never)).rejects.toThrow(/fan-out[\s\S]*2 sources/i);
    expect(composerCalls(b.seen).length).toBe(0);
  });
});

// ── F5 — compose time ────────────────────────────────────────────────────────────────────────
describe("F5 — composeStandard refuses a fan-out over a type the chair does not take in", () => {
  it("over.type outside input_contract", () => {
    expect(() => standard({ contract: ["fanx-ruleset"] })).toThrow(/fan_out[\s\S]*"fanx-charter"[\s\S]*input_contract/);
  });
  it("a human seat cannot fan out — an office is held once", () => {
    const std = () => composeStandard({
      slug: "fan-human", domain: "demo", input_types: ["fanx-charter"], agents: [],
      phases: [{ name: "sign", chairs: [{ role: "sign", agent_slug: "", human: true, depends_on: [], input_contract: ["fanx-charter"], output_contract: ["fanx-check"], required_skills: [], fan_out: { over: FAN.over } }] }] as PhaseDef[],
    });
    expect(std).toThrow(/human seat and declares fan_out/);
  });

  it("a join type outside input_contract", () => {
    expect(() => standard({ fan: { over: FAN.over, join: [{ type: "fanx-check", path: "x", on: "a", match: "b" }] } })).toThrow(/fan_out[\s\S]*"fanx-check"[\s\S]*input_contract/);
  });
});

// ── F6 — the amend loop re-seats the INSTANCES, each with its own slice ─────────────────────────
describe("F6 — amend", () => {
  it("a failing verdict over a fanned-out maker re-runs every instance with its own slice, never the unexpanded template", async () => {
    const w = world();
    const b = band({ failFirstCheck: true });
    const r = await runGig(standard({ verify: true }), { "fanx-charter": { families: FAMILIES } }, { ...w, invoke: b.invoke } as never);
    const amends = composerCalls(b.seen).filter((c) => c.resume);
    expect(amends.map((c) => c.role).sort(), "each instance re-runs, under its own role").toEqual(["compose#grant", "compose#mention", "compose#moral"]);
    for (const c of amends) {
      const fams = (c.gig_input["fanx-charter"] as { families: Array<{ family: string }> }).families;
      expect(fams.length, `${c.role}'s amend must still see only its slice`).toBe(1);
      // The instance amends ITS OWN prior clause — not a sibling's, and not all three.
      const prior = c.inputs.filter((i) => i.domain_type === "fanx-clause");
      expect(prior.map((i) => i.from_role), `${c.role} must carry exactly its own prior work`).toEqual([c.role]);
    }
    const collect = b.seen.find((s) => s.role === "collect")!;
    expect(collect.inputs.filter((i) => i.domain_type === "fanx-clause").length, "downstream reads the AMENDED instances, three of them").toBe(3);
    expect(r.status).toBe("complete");
  });
});

// ── F7 — a fanned-out seat served from the reuse cache keeps its stamp ──────────────────────────
describe("F7 — reuse", () => {
  it("a recalled instance's record still names the slice it was cut from", async () => {
    const w = world();
    const reuse = createMemoryReuseStore();
    await runGig(standard(), { "fanx-charter": { families: FAMILIES } }, { ...w, invoke: band().invoke, reuse } as never);
    const b = band();
    const r = await runGig(standard(), { "fanx-charter": { families: FAMILIES } }, { ...w, invoke: b.invoke, reuse } as never);
    expect(composerCalls(b.seen).length, "the second run must be served from the cache, or this law tests nothing").toBe(0);
    const grant = r.outputs.find((o) => o.from_role === "compose#grant")!;
    expect(grant.reused_from).toBeTruthy();
    expect(grant.shard?.value).toBe("grant");
    expect(grant.shard?.slices.map((x) => x.type).sort()).toEqual(["fanx-charter", "fanx-ruleset"]);
  });
});
