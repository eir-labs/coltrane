// A1 + A2 — THE LOADER READS THE ROWS THAT ARE REAL, AND SAYS SO WHEN IT CANNOT.
//
// FOUND LIVE, not by reading: the verifier read the engine's own oracle against production
// after the venue-contract repair landed and found system_health STILL reporting 8 load
// errors — with the three repaired rooms still among them. The repair was correct; the
// LOADER was reading rows nobody meant it to read.
//
// THE DEFECT, at src/genome_store.ts:121 —
//
//     venues: "coltrane_venues?select=slug,definition"
//
// Slug and definition. No `status`, no `version`, no `org_id`. So:
//
//   · SUPERSEDED ROWS LOAD. `coltrane_venues` is versioned — a repair lands as v2 and v1
//     stays on the table as history. The loader asks for every row, hands v1's old
//     definition to VenueSchema, and v1 fails the rules v2 was authored to satisfy. The
//     error names the SLUG, so a perfectly repaired room reports as broken forever, and
//     the repair looks like it did nothing.
//   · IDENTICAL SLUGS COLLIDE. Two rows, same slug — whichever arrives second throws
//     "duplicate venue slug". Which room the genome ends up holding is a function of row
//     order, and row order is not a fact anyone declared.
//
// And A1, the shape underneath: a row that fails to load is pushed into `load_errors` and
// the load SUCCEEDS. A genome missing the residency — the room every resident Envoy is
// placed in — is not a genome with a note attached; the caller who asked for a genome got
// something that is not one, and nothing in the return value says so. The verifier's bar:
// loaded venues == active rows in scope, or the load refuses.
//
// ON BAR 2 (two orgs, same active slug) — deliberately NOT "pick the caller's org".
// genome_store.ts:111 states the design: "org_id is RLS's concern, not the engine's", and
// the fetch is scoped by the caller's own credential. At THIS layer there is no caller and
// no org context, so "the caller's org's room" is not knowable here — and inventing an org
// parameter would get ahead of the institution×venue approval relation that is still being
// specified. What IS knowable is that two active rooms claiming one name is an AMBIGUITY,
// and the honest answer to an ambiguity is a refusal that names both claimants. Picking one
// would be precisely the silent row-order pick this file exists to end. (#131 set this
// precedent for principals: "attribution is a fact, not a coin toss".)
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reconstructGenome, Q } from "../src/genome_store.js";

const room = (slug: string, tools: string[] = ["Read"]) => ({
  slug,
  institution_slug: "loader-inst",
  responsible_chair: "loader-inst.chair.host",
  doors: { ingress: [], egress: ["example.invalid"] },
  credential_surface: [],
  equipment: { tools },
  lifecycle: { policy: "ephemeral", rebuild_cadence: "per-gig" },
});

// v1 of `dev` as it really is on production: authored before the contract tightened, and
// invalid under today's rules. This is the row that was poisoning the repaired slug.
const staleRoom = { slug: "dev", institution_slug: "loader-inst" };

// reconstructGenome walks every collection; a fixture that supplies only `venues` fails on
// an unrelated undefined rather than on the rule under test. `load` names the collections
// so a fixture cannot silently omit one and pass for the wrong reason.
const load = (venues: unknown[]) =>
  reconstructGenome({
    core_types: [], domain_types: [], agents: [], standards: [], skills: [],
    charts: [], institutions: [], venues,
  } as never);

describe("A2 · the loader reads ACTIVE rows, at their current version", () => {
  it("a superseded v1 beside an active v2 yields ONE room, and it is v2", () => {
    const g = load([
        { slug: "dev", version: 1, status: "superseded", org_id: "org-a", definition: staleRoom },
        { slug: "dev", version: 2, status: "active", org_id: "org-a", definition: room("dev", ["Read", "Write"]) },
      ]);
    expect(g.load_errors, "the superseded row must not be read at all, so it cannot fail")
      .toEqual([]);
    expect(g.venues.size).toBe(1);
    expect(g.venues.get("dev")?.equipment?.tools).toEqual(["Read", "Write"]);
  });

  it("an inactive row is not a room — draft and retired rows are not loaded", () => {
    const g = load([
        { slug: "draft-room", version: 1, status: "draft", org_id: "org-a", definition: room("draft-room") },
        { slug: "gone", version: 1, status: "retired", org_id: "org-a", definition: room("gone") },
        { slug: "live", version: 1, status: "active", org_id: "org-a", definition: room("live") },
      ]);
    expect([...g.venues.keys()]).toEqual(["live"]);
    expect(g.load_errors).toEqual([]);
  });

  it("two ACTIVE rooms claiming one name is an ambiguity, and it refuses naming both", () => {
    // Not a pick. The loader has no caller and no org context (org_id is RLS's concern,
    // genome_store.ts:111), so choosing between them would be a row-order coin toss wearing
    // a determinism costume.
    expect(() =>
      load([
        { slug: "dev", version: 1, status: "active", org_id: "org-a", definition: room("dev") },
        { slug: "dev", version: 1, status: "active", org_id: "org-b", definition: room("dev") },
      ]),
    ).toThrow(/dev/);
  });

  it("THE MUTANT (verifier's law 3): with the old slug-only select, bar 1 breaks", () => {
    // The envelope is the defect. If someone restores `select=slug,definition`, the loader
    // stops receiving `status` and `version` — and a superseded row becomes indistinguishable
    // from a live one. This asserts the ENVELOPE carries what the rules above need, so the
    // fix cannot be quietly undone one field at a time.
    for (const field of ["status", "version", "org_id"]) {
      expect(Q.venues, `the venues envelope must select ${field}`)
        .toContain(field);
    }
  });
});

describe("A1 · a genome that failed to load is not a genome", () => {
  it("an unloadable ACTIVE room REFUSES the load, naming the slug and the rule", () => {
    // The residency is the room every resident Envoy is placed in. When it failed
    // VenueSchema it went into load_errors and the load returned "successfully" — so the
    // engine served a genome in which that room did not exist, and said nothing. An empty
    // result and a broken read are indistinguishable downstream, and the empty one reads as
    // healthy.
    let err: Error | undefined;
    try {
      load([
        { slug: "residency", version: 2, status: "active", org_id: "org-a", definition: { slug: "residency" } },
      ]);
    } catch (e) {
      err = e as Error;
    }
    expect(err, "an active row that cannot be loaded must REFUSE, not be filed as a note")
      .toBeDefined();
    expect(err!.message, "the refusal names the room").toContain("residency");
    expect(err!.message.length, "and names the rule it broke, not just that it broke")
      .toBeGreaterThan("residency".length + 10);
  });

  it("loaded venues == active rows in scope — the verifier's bar, stated as an equation", () => {
    const rows = [
      { slug: "a", version: 1, status: "active", org_id: "o", definition: room("a") },
      { slug: "b", version: 1, status: "active", org_id: "o", definition: room("b") },
      { slug: "b", version: 2, status: "superseded", org_id: "o", definition: staleRoom },
      { slug: "c", version: 1, status: "retired", org_id: "o", definition: room("c") },
    ];
    const g = load(rows);
    const activeSlugs = new Set(rows.filter((r) => r.status === "active").map((r) => r.slug));
    expect(g.venues.size).toBe(activeSlugs.size);
    expect(new Set(g.venues.keys())).toEqual(activeSlugs);
  });
});

describe("A1 · the refusal is unconditional because there is nobody to spare", () => {
  it("reconstructGenome has exactly ONE consumer, and it is production work", () => {
    // THE LAW THAT REPLACED A DEAD OPTION. I first gave reconstructGenome a
    // `{diagnostic}` escape so the reporting tools could still see load_errors instead of
    // throwing — and the verifier caught it DEAD: nothing passed it, so it was a comment
    // wearing the costume of a control.
    //
    // Chasing that down settled the question. THERE ARE TWO LOADERS. `system_health` and
    // `genome_reload` read `deps.load_errors`, sourced from the FILE loader (loader.ts),
    // which this change never touched. reconstructGenome's only consumer is the drain
    // worker, about to run a gig — and a worker must not run work against a genome with a
    // room missing from it.
    //
    // So this law pins the premise the unconditional refusal rests on. The day someone adds
    // a REPORTING caller on the store path, this fails and they are made to decide
    // deliberately — rather than inheriting a throw that silences the diagnostic exactly
    // when it is needed, which is the hazard the dead option was gesturing at.
    const src = (f: string) =>
      readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const importers = ["worker.ts", "server.ts", "cli.ts", "runtime.ts"]
      .filter((f) => /\b(rpcGenomeStore|fileGenomeStore|agentTokenGenomeStore)\b/.test(src(f)));
    expect(importers, "only the drain worker may construct a genome store").toEqual(["worker.ts"]);
    expect(src("server.ts"), "the reporting tools must not reach the store loader")
      .not.toMatch(/\breconstructGenome\b/);
  });
});
