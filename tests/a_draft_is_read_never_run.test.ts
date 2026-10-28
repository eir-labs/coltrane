// A DRAFT IS READ, NEVER RUN — one resolver turns a standard's name into its record.
//
// spec.coltrane.simulate-and-inspect-drafts (v2). Drafts were partitioned out of `standards` so the
// drain would not run them (tests/spec_drafts_do_not_load.test.ts), and `standard_promote` was taught to
// look in `draft_standards` too. Inspect and simulate were not: both answered "unknown standard" for a
// definition that sits in the store, so the author of a draft could neither read it back nor price it
// before asking for its promotion. And the hosted door QUEUED a draft — no `standards` hit, so it
// queued unvalidated, and the store's own check admits draft rows — leaving the drain to refuse it at
// claim (measured live, 17 Oct: gig 0cf1b557, claimed and failed, agents_run null).
//
// THE NAME IS RESOLVED ONCE. Every handler that took a standard's slug used to look it up by hand, and
// teaching two more about drafts the same way would have made six hand-kept answers to "which record
// does this name mean". A slug is a name; the store's real key is (org, slug, version, status). So one
// function in server.ts resolves the name (resolveStandard), the loader threads the record's identity
// through so there is something to resolve TO, and every answer carries the record's ADDRESS: slug,
// version, status, org, content_hash, and the genome_hash a gig of it would record.
//
// THE ONE NON-OBVIOUS RULE: drafts are loaded leniently and never checked, so simulating a draft
// composes it first, through the loader's own gate. A draft that does not compose returns the loader's
// refusal, never a cost estimate.
//
// Titled SD-n: the conformance contract coltrane-drafts (SDC-5) runs these at the graded ref.
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dispatchTool, createToolSurface, type ServerDeps, type ToolSurfaceDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { composeStandard } from "../src/composition.js";
import { canonStructuralJson, sha256Hex } from "../src/canonical_form.js";
import { genomeHash } from "../src/runtime.js";
import { loadGenome } from "../src/loader.js";
import { reconstructGenome, Q } from "../src/genome_store.js";
import { testAgent } from "./_support/agents.js";

// The content hash a definition SHOULD carry, computed here from its defining fields — never by the
// engine's own helper, so the law is not the implementation agreeing with itself.
type Def = { slug: string; domain?: unknown; phases?: unknown; input_types?: unknown; output_types?: unknown;
  eval_slugs?: unknown; max_examine_rounds?: unknown; reserve_pool?: unknown; description?: unknown; refuse_when_unresolved?: unknown };
const contentHash = (d: Def) => sha256Hex(canonStructuralJson({
  slug: d.slug, domain: d.domain ?? null, phases: d.phases ?? [], input_types: d.input_types, output_types: d.output_types,
  eval_slugs: d.eval_slugs, max_examine_rounds: d.max_examine_rounds, reserve_pool: d.reserve_pool, description: d.description,
  // DS-7: the refusal policy decides how a gig ends, so it is a defining field (absent folds as before)
  refuse_when_unresolved: d.refuse_when_unresolved,
}));

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HEX64 = /^[0-9a-f]{64}$/;
const ORG = "c0000000-0000-4000-8000-00000000e17a";

const scout = testAgent({ slug: "scout", primitives: ["SENSE"], input_types: ["raw-note"], output_types: ["Signal"] });
const chair = (input: string) => ({
  role: "scout-seat", agent_slug: "scout", depends_on: [],
  input_contract: [input], output_contract: ["Signal"], optional_outputs: [], required_skills: [],
});

// STORE ROWS, fed through the real loader — so these laws exercise the identity the loader threads,
// not a fixture's hand-typed copy of it.
const row = (o: Record<string, unknown>) => ({
  domain: "demo", org_id: ORG, input_types: ["raw-note"], output_types: ["Signal"],
  phases: [{ name: "scan", chairs: [chair("raw-note")] }], ...o,
});
const ROWS = [
  row({ slug: "only-a-draft", version: 3, status: "draft" }),
  // The production shape: a chair feeding an agent a type its input_types never declared.
  row({ slug: "broken-draft", version: 1, status: "draft", phases: [{ name: "scan", chairs: [chair("design-question")] }] }),
  // One name, two records: an active v2 and a draft v3. Phases empty, so the live one composes with
  // no agent rows in the genome.
  row({ slug: "both", version: 2, status: "active", domain: "the-active", phases: [] }),
  row({ slug: "both", version: 3, status: "draft", domain: "the-draft" }),
];
const loaded = () =>
  reconstructGenome({ core_types: [], domain_types: [], agents: [], skills: [], charts: [], institutions: [], venues: [], standards: ROWS } as never);

const deps = (): ServerDeps => {
  const g = loaded();
  const registry = createRegistry();
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    agents: new Map([["scout", scout]]),
    standards: new Map(g.standards),
    draft_standards: new Map(g.draft_standards),
  };
};

const hostedDoor = (d: ServerDeps, queued: unknown[]) =>
  createToolSurface({ ...d, hosted: true,
    queueGig: async (a: Record<string, unknown>) => { queued.push(a); return { gig_id: "g-1", status: "queued" }; } } as unknown as ToolSurfaceDeps)
    .find((t) => t.name === "gig_dispatch")!;

// The genome_hash the draft would record once composed, computed by the loader's gate itself.
const composedHash = (slug: string) => genomeHash(composeStandard({ slug, domain: "demo", agents: [scout],
  phases: [{ name: "scan", chairs: [chair("raw-note")] }], input_types: ["raw-note"], output_types: ["Signal"], status: "active" } as never));

// What the loader's own gate says about the broken draft — computed from the gate, never typed here,
// so the law asserts the refusal is the LOADER'S words rather than a paraphrase of them.
const loaderRefusal = (): string => {
  try {
    composeStandard({ slug: "broken-draft", domain: "demo", agents: [scout], phases: [{ name: "scan", chairs: [chair("design-question")] }],
      input_types: ["raw-note"], output_types: ["Signal"], status: "active" } as never);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("fixture error: the broken draft composes, so the law would prove nothing");
};

type Data = Record<string, unknown>;
type Address = { slug: string; version: number | null; status: string; org: string | null; content_hash: string; genome_hash: string | null };
const addressOf = (r: { data?: unknown }) => ((r.data ?? {}) as Data)["address"] as Address;

describe("one resolver, and the record it resolves to", () => {
  it("SD-1 a name resolves to ONE record and its address; the active record wins over a draft of the same name", async () => {
    const d = deps();
    const i = await dispatchTool("standard_inspect", { slug: "both" }, d);
    const s = await dispatchTool("standard_simulate", { standard_slug: "both" }, d);
    expect(i.ok, i.error).toBe(true);
    expect(s.ok, s.error).toBe(true);
    const a = addressOf(i);
    expect(a).toMatchObject({ slug: "both", version: 2, status: "active", org: ORG });
    expect(a.content_hash).toMatch(HEX64);
    expect((i.data as Data)["domain"]).toBe("the-active");
    expect(addressOf(s), "inspect and simulate resolve the name to the same record").toEqual(a);
    // The draft beside it is a DIFFERENT record — not reached by the name, and its address differs.
    expect((d.draft_standards!.get("both") as unknown as Data)["content_hash"]).not.toBe(a.content_hash);
    const q: unknown[] = [];
    const r = await hostedDoor(d, q).call({ standard_slug: "both", input: {} });
    expect(r.ok, "dispatch reaches the active record too").toBe(true);
    expect(q).toHaveLength(1);
  });

  it("SD-2 inspect reads a draft back: its shape, status draft, and its address", async () => {
    const r = await dispatchTool("standard_inspect", { slug: "only-a-draft" }, deps());
    expect(r.ok, r.error).toBe(true);
    const data = r.data as Data;
    expect(data["status"]).toBe("draft");
    expect((data["phases"] as Array<{ name: string; chairs: Array<{ role: string }> }>).map((p) => [p.name, p.chairs.map((c) => c.role)]))
      .toEqual([["scan", ["scout-seat"]]]);
    expect(addressOf(r)).toEqual({
      slug: "only-a-draft", version: 3, status: "draft", org: ORG,
      content_hash: contentHash(ROWS[0] as unknown as Def), genome_hash: composedHash("only-a-draft"),
    });
    expect(data["composition_error"]).toBeNull();
  });

  it("SD-2b inspect still READS a draft that does not compose — reading is how its author finds the fault", async () => {
    const r = await dispatchTool("standard_inspect", { slug: "broken-draft" }, deps());
    expect(r.ok, r.error).toBe(true);
    expect(addressOf(r).genome_hash, "a record that does not compose has no composed identity").toBeNull();
    expect(addressOf(r).content_hash, "but what it says still has a hash").toMatch(HEX64);
    expect((r.data as Data)["composition_error"]).toContain(loaderRefusal());
  });

  it("SD-3 simulate walks a draft that composes: its phases, who plays each chair, and its address", async () => {
    const d = deps();
    const r = await dispatchTool("standard_simulate", { standard_slug: "only-a-draft", mock_input: { note: "x" } }, d);
    expect(r.ok, r.error).toBe(true);
    const data = r.data as Data;
    expect((data["phases"] as Array<{ name: string }>).map((p) => p.name)).toEqual(["scan"]);
    expect(typeof data["estimated_cost"]).toBe("number");
    expect(JSON.stringify(data["seat_plan"]), "who plays, by role").toContain('"scout-seat"');
    const i = await dispatchTool("standard_inspect", { slug: "only-a-draft" }, d);
    expect(addressOf(r)).toEqual(addressOf(i));
    expect(addressOf(r).status).toBe("draft");
  });

  it("SD-4 simulate REFUSES a draft that does not compose, in the loader's words — never an estimate", async () => {
    const r = await dispatchTool("standard_simulate", { standard_slug: "broken-draft" }, deps());
    expect(r.ok, "a draft that cannot compose has no run to price").toBe(false);
    expect(r.data, "and no estimate rides along on the refusal").toBeUndefined();
    expect(r.error).toMatch(/draft/);
    expect(r.error).toMatch(/does not compose/);
    expect(r.error, "the loader's refusal, unedited").toContain(loaderRefusal());
  });
});

describe("a draft is never run — the door refuses it because the resolved record is a draft", () => {
  it("SD-5 the hosted door refuses a draft before anything is queued, naming it a draft and its address", async () => {
    const queued: unknown[] = [];
    const r = await hostedDoor(deps(), queued).call({ standard_slug: "only-a-draft", input: {} });
    expect(queued, "nothing reaches the queue — the drain must never be the first to say no").toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/is a draft/);
    expect(r.error).toContain("only-a-draft@3");
    expect(r.error).toContain(contentHash(ROWS[0] as unknown as Def));
  });

  it("SD-5b the local door refuses a draft as a draft — not as an unknown name", async () => {
    let invoked = 0;
    const d = { ...deps(), invoke: async () => { invoked++; throw new Error("must not run"); } } as unknown as ServerDeps;
    const r = await dispatchTool("gig_dispatch", { standard_slug: "only-a-draft", input: {} }, d);
    expect(invoked).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/is a draft/);
    expect(r.error).not.toMatch(/unknown standard/);
  });
});

describe("what does not change", () => {
  it("SD-6 browse lists no store draft", async () => {
    const r = await dispatchTool("standard_browse", {}, deps());
    expect((r.data as { standards: Array<{ slug: string; status: string }> }).standards.map((s) => [s.slug, s.status]))
      .toEqual([["both", "active"]]);
  });

  it("SD-6b reading a draft never moves it into the live list, nor rewrites it", async () => {
    const d = deps();
    await dispatchTool("standard_inspect", { slug: "only-a-draft" }, d);
    await dispatchTool("standard_simulate", { standard_slug: "only-a-draft" }, d);
    expect(d.standards!.has("only-a-draft")).toBe(false);
    expect(d.draft_standards!.get("only-a-draft")?.status).toBe("draft");
  });

  it("SD-7 an unknown name is refused by inspect, simulate and dispatch, in the same words as before", async () => {
    const d = deps();
    const i = await dispatchTool("standard_inspect", { slug: "nope" }, d);
    expect(i.error).toBe(`unknown standard "nope"`);
    const s = await dispatchTool("standard_simulate", { standard_slug: "nope" }, d);
    expect(s.error).toBe(`unknown standard "nope" — nothing to simulate. Check the slug, and if the standard is newly authored run genome_reload and confirm load_errors is empty.`);
    const g = await dispatchTool("gig_dispatch", { standard_slug: "nope", input: {} }, { ...d, invoke: async () => { throw new Error("must not run"); } } as unknown as ServerDeps);
    expect(g.error).toBe(`unknown standard "nope"`);
  });

  it("SD-8 the file-based engine is untouched: no drafts partition, and every standard inspects as it did", async () => {
    // The file backing has no status column, so it has nothing to partition — including the
    // standards whose JSON SAYS draft. Those load as standards and are dispatchable, as before; the
    // refusal keys on the store's partition, never on that field.
    const g = loadGenome(REPO_ROOT);
    expect(g.draft_standards.size).toBe(0);
    const d: ServerDeps = { ...deps(), agents: new Map(g.agents), standards: new Map(g.standards), draft_standards: new Map(g.draft_standards) };
    expect(g.standards.size).toBeGreaterThan(0);
    for (const s of g.standards.values()) {
      const r = await dispatchTool("standard_inspect", { slug: s.slug }, d);
      expect(r.ok, `${s.slug}: ${r.error}`).toBe(true);
      const data = r.data as Data;
      // The fields inspect returned before this change, byte for byte.
      expect({ slug: data["slug"], domain: data["domain"], status: data["status"], phases: data["phases"],
               input_types: data["input_types"], output_types: data["output_types"],
               eval_slugs: data["eval_slugs"], description: data["description"] }).toEqual({
        slug: s.slug, domain: s.domain, status: s.status ?? "active",
        phases: s.phases.map((p) => ({ name: p.name, chairs: p.chairs.map((c) => ({
          role: c.role, agent_slug: c.agent_slug ?? null, skill_slug: c.skill_slug ?? null, human: c.human ?? false,
          input_contract: c.input_contract ?? [], output_contract: c.output_contract ?? [] })) })),
        input_types: s.input_types ?? [], output_types: s.output_types ?? [],
        eval_slugs: s.eval_slugs ?? [], description: s.description ?? null,
      });
    }
  });

  it("SD-8b a file standard's address: no org, its content hashed from the record, the genome_hash a gig records", async () => {
    const g = loadGenome(REPO_ROOT);
    const d: ServerDeps = { ...deps(), agents: new Map(g.agents), standards: new Map(g.standards), draft_standards: new Map(g.draft_standards) };
    for (const s of g.standards.values()) {
      const a = addressOf(await dispatchTool("standard_inspect", { slug: s.slug }, d));
      expect(a?.org, s.slug).toBeNull();
      expect(a?.content_hash, s.slug).toBe(contentHash(s as unknown as unknown as Def));
      expect(a?.genome_hash, s.slug).toBe(genomeHash(s));
    }
  });
});

describe("the loader threads identity", () => {
  it("SD-9 the store loader carries version, org and content hash into the parsed record, drafts included", () => {
    const g = loaded();
    expect(g.load_errors).toEqual([]); // the fixture must load, or the law proves nothing
    const live = g.standards.get("both")! as unknown as Record<string, unknown>;
    expect([live["version"], live["org_id"], live["content_hash"]]).toEqual([2, ORG, contentHash(ROWS[2] as unknown as Def)]);
    for (const [slug, i, version] of [["only-a-draft", 0, 3], ["broken-draft", 1, 1], ["both", 3, 3]] as const) {
      const dr = g.draft_standards.get(slug)! as unknown as Record<string, unknown>;
      expect([dr["version"], dr["org_id"], dr["content_hash"]], slug).toEqual([version, ORG, contentHash(ROWS[i] as unknown as Def)]);
    }
    // And the member door reads the org column the identity needs (the agent door returns whole rows).
    expect(Q.standards).toMatch(/[?,]select=.*\borg_id\b/);
  });
});
