// The store genome has a base — the operator ruled on 3 Oct 2026 after a measured refusal.
//
// MEASURED NEGATIVE (3 Oct 2026, one organization's drain, engine 0.25.19): a standard promoted into an org's
// layer named the engine's own agents (john, miles, bill, red-spec-drafter, …). The org held none of
// them as rows, because they ship in the PACKAGE. The drain box reconstructed the org's genome from
// its rows alone, found "references unknown agent \"john\"", and refused EVERY gig in the org at
// claim time (probe 2ebd5983 died in one second on a standard it did not use). A file genome layers
// `{ "extends": ["./coltrane"] }` over the engine; the store genome had nothing under it, so an org
// had to COPY every engine agent and type its standards name — and a copy of engine material into an
// org layer is a missing operator (point, never copy).
//
// THE OPERATOR: reconstructGenome folds the engine's packaged genome UNDER the org's rows. Org rows
// override the base BY SLUG (the file loader's fold, loadLayeredGenome). The two store backings pass
// the base by default, so the box and the hosted surface read the same effective genome without any
// wiring; `base: null` is the explicit "rows alone" a test or a diagnostic asks for.
//
// WHAT IS NOT FOLDED: venues, charts, institutions. A room and a chart are an org's statements about
// itself (values), not the engine's operators; an org's rooms are its own (WI-11). Core types are the
// canonical six either way.
import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  reconstructGenome,
  engineBaseGenome,
  engineBaseRoot,
  rpcGenomeStore,
  postgrestGenomeStore,
} from "../src/genome_store.js";

// A standard whose one chair seats the ENGINE's john — exactly the promoted shape, reduced.
const JOHN_STANDARD_ROW = {
  slug: "records-v1", version: 1, status: "active", domain: "software-change",
  input_types: ["change-request"], output_types: ["change-context"],
  phases: [{ name: "sense-context", chairs: [{
    role: "read-context", agent_slug: "john", depends_on: [], turn_reserve: 12,
    input_contract: ["change-request"], output_contract: ["change-context"], required_skills: [], optional_outputs: [],
  }] }],
};

// The ORG's own john — a valid profile under the same slug, which must OVERRIDE the base's.
const ORG_JOHN_ROW = {
  slug: "john", version: 1, status: "active",
  primitives: ["SENSE", "INTERPRET"], input_types: ["change-request"], output_types: ["change-context"],
  domain: "software-change", identity: "you are the org's own john", method: "1. read 2. report 3. stop",
  constraints: [], depth_profile: "standard",
  permissions: { allowed_tools: ["Read"], model_tier: "economy", max_tool_calls: 5 },
  behavioral_primitives: ["explorer", "critic"], skill_slots: [], default_skills: [],
};

const ROWS_JOHN_STANDARD_NO_AGENTS = { core_types: [], domain_types: [], agents: [] as unknown[], standards: [JOHN_STANDARD_ROW], skills: [] };
const asRows = (r: unknown) => r as never;

const errorsNaming = (g: { load_errors: readonly { error: string }[] }, needle: string) =>
  g.load_errors.filter((e) => e.error.includes(needle));

describe("E1 · the store genome has a base: the engine's packaged genome sits under an org's rows", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("L0 · the engine knows its own root: a directory holding package.json and agents/", () => {
    const root = engineBaseRoot();
    expect(root, "the package root resolves from the module's own location").toBeTypeOf("string");
    expect(existsSync(join(root as string, "agents")), "agents/ ships in the package").toBe(true);
    expect(existsSync(join(root as string, "package.json"))).toBe(true);
    const base = engineBaseGenome();
    expect(base.load_errors, "the engine's own genome loads clean (the genome CI job's law, re-stated here)").toEqual([]);
    expect(base.agents.has("john"), "the base holds the quartet").toBe(true);
    expect(base.standards.has("software-change-pr-v1")).toBe(true);
  });

  it("L1 · the measured negative, pinned by name: rows alone cannot seat the engine's john", () => {
    const g = reconstructGenome(asRows(ROWS_JOHN_STANDARD_NO_AGENTS), { base: null });
    expect(errorsNaming(g, 'references unknown agent "john"').length).toBe(1);
    expect(g.standards.has("records-v1")).toBe(false);
  });

  it("L2 · with the base under it, the same rows compose: john is the engine's, the standard loads", () => {
    const g = reconstructGenome(asRows(ROWS_JOHN_STANDARD_NO_AGENTS), { base: engineBaseGenome() });
    expect(g.load_errors).toEqual([]);
    expect(g.standards.has("records-v1")).toBe(true);
    expect(g.agents.get("john")?.identity).toBe(engineBaseGenome().agents.get("john")?.identity);
    expect(g.provenance?.get("agent:john")).toBe("engine-base");
    expect(g.provenance?.get("standard:records-v1")).toBe("store");
  });

  it("L3 · an org row under a base slug OVERRIDES the base, and is not a duplicate", () => {
    const rows = asRows({ ...ROWS_JOHN_STANDARD_NO_AGENTS, agents: [ORG_JOHN_ROW] });
    const g = reconstructGenome(rows, { base: engineBaseGenome() });
    expect(errorsNaming(g, "duplicate agent slug").length, "a base slug re-stated by the org is an override, not a clash").toBe(0);
    expect(g.agents.get("john")?.identity).toBe("you are the org's own john");
    expect(g.provenance?.get("agent:john")).toBe("store");
    // and the org's standard composes against the ORG's john
    expect(g.standards.has("records-v1")).toBe(true);
  });

  it("L4 · two ORG rows claiming one slug still refuse — the base does not launder a duplicate", () => {
    const rows = asRows({ ...ROWS_JOHN_STANDARD_NO_AGENTS, agents: [ORG_JOHN_ROW, { ...ORG_JOHN_ROW, identity: "the second john" }] });
    const g = reconstructGenome(rows, { base: engineBaseGenome() });
    expect(errorsNaming(g, 'duplicate agent slug "john"').length).toBe(1);
  });

  it("L5 · the base's standards are inherited: an org with no standard rows can still run the engine's", () => {
    const g = reconstructGenome({ core_types: [], domain_types: [], agents: [], standards: [], skills: [] } as never, { base: engineBaseGenome() });
    expect(g.load_errors).toEqual([]);
    expect(g.standards.has("software-change-pr-v1"), "no promotion needed — R30's trap closes").toBe(true);
    expect(g.domain_types.has("change-request@1"), "the base's types ride too").toBe(true);
    expect(g.provenance?.get("standard:software-change-pr-v1")).toBe("engine-base");
  });

  it("L6 · a DRAFT org row under a base slug does not displace the base's standard (drafts do not load)", () => {
    const draft = { ...JOHN_STANDARD_ROW, slug: "software-change-pr-v1", status: "draft" };
    const g = reconstructGenome({ core_types: [], domain_types: [], agents: [], standards: [draft], skills: [] } as never, { base: engineBaseGenome() });
    expect(g.standards.get("software-change-pr-v1")?.phases.length, "the base's seven phases stand").toBe(7);
    expect(g.draft_standards.has("software-change-pr-v1"), "the draft is still offered for promotion").toBe(true);
  });

  it("L7 · rooms and charts are the org's own: the base's venues and charts are NOT folded", () => {
    const base = engineBaseGenome();
    expect(base.venues.size, "precondition: the engine ships example rooms").toBeGreaterThan(0);
    const g = reconstructGenome({ core_types: [], domain_types: [], agents: [], standards: [], skills: [] } as never, { base });
    expect(g.venues.size).toBe(0);
    expect(g.charts.size).toBe(0);
  });

  it("L10 · a broken packaged base is named, not inferred: its load errors ride into the effective genome", () => {
    const real = engineBaseGenome();
    const broken = { ...real, load_errors: [{ kind: "agent" as const, path: "agents/ghost.json", slug: "ghost", error: "synthetic: the base's ghost does not parse" }] };
    const g = reconstructGenome({ core_types: [], domain_types: [], agents: [], standards: [], skills: [] } as never, { base: broken });
    expect(errorsNaming(g, "synthetic: the base's ghost does not parse").length, "the base's own error is on the org genome, by name").toBe(1);
    // and the real base, which loads clean, adds none (L2/L5 already assert [] — this pins the reason)
    expect(reconstructGenome({ core_types: [], domain_types: [], agents: [], standards: [], skills: [] } as never, { base: real }).load_errors).toEqual([]);
  });

  it("L8 · the box's backing (an agent token) reads the base by default, and `base: null` is rows alone", async () => {
    const answer = { org_id: "c0000000-0000-4000-8000-00000000e17a", core_types: [], domain_types: [], agents: [], standards: [JOHN_STANDARD_ROW], skills: [] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 })));
    const ctx = { baseUrl: "https://store.example", anonKey: "anon", agentToken: "ctk_x" };
    const withBase = await rpcGenomeStore(ctx).load();
    expect(withBase.load_errors, "the drain's effective genome has the engine under it").toEqual([]);
    expect(withBase.standards.has("records-v1")).toBe(true);
    const rowsAlone = await rpcGenomeStore({ ...ctx, base: null }).load();
    expect(errorsNaming(rowsAlone, 'references unknown agent "john"').length).toBe(1);
  });

  it("L9 · the member backing (PostgREST) reads the base by default too — one effective genome for every reader", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const table = String(url).split("/rest/v1/")[1]?.split("?")[0];
      const body = table === "coltrane_standards" ? [JOHN_STANDARD_ROW] : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const g = await postgrestGenomeStore({ baseUrl: "https://store.example", anonKey: "anon", bearer: "eyJx.eyJy.zzz" }).load();
    expect(g.load_errors).toEqual([]);
    expect(g.standards.has("records-v1")).toBe(true);
    expect(g.agents.get("john")?.identity).toBe(engineBaseGenome().agents.get("john")?.identity);
  });
});
