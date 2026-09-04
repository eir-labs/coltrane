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
// the load SUCCEEDS. A genome missing the residency — the room every resident agent is
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
import { refuseUnlessLoaded, standardForRun } from "../src/worker.js";

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

  it("two ACTIVE rooms claiming one name is an ambiguity, REPORTED naming both claimants", () => {
    // Not a pick. Choosing between them would be a row-order coin toss wearing a determinism
    // costume — there is no caller and no org context here (org_id is RLS's concern,
    // genome_store.ts:111). RE-STATED from `toThrow`: the loader reports and the drain worker
    // refuses (see the A1 block below for why the refusal moved), so the assertion is that
    // the ambiguity is RECORDED with both claimants, and neither room is silently adopted.
    const g = load([
      { slug: "dev", version: 1, status: "active", org_id: "org-a", definition: room("dev") },
      { slug: "dev", version: 1, status: "active", org_id: "org-b", definition: room("dev") },
    ]);
    expect(g.venues.has("dev"), "neither claimant may be adopted").toBe(false);
    const e = g.load_errors.find((x) => x.slug === "dev");
    expect(e, "the ambiguity is reported").toBeDefined();
    expect(e!.error).toContain("org-a");
    expect(e!.error).toContain("org-b");
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
  it("an unloadable ACTIVE room is REPORTED, naming the slug and the rule", () => {
    // The residency is the room every resident agent is placed in. When it failed
    // VenueSchema it went into load_errors and the load returned "successfully" — so the
    // engine served a genome in which that room did not exist, and said nothing. An empty
    // result and a broken read are indistinguishable downstream, and the empty one reads as
    // healthy.
    const g = load([
      { slug: "residency", version: 2, status: "active", org_id: "org-a", definition: { slug: "residency" } },
    ]);
    const e = g.load_errors.find((x) => x.slug === "residency");
    expect(e, "an active row that cannot be loaded is reported").toBeDefined();
    expect(e!.error, "names the room").toContain("residency");
    expect(e!.error, "and the rule it broke, not just that it broke").toMatch(/could not be loaded/);
    expect(g.venues.has("residency"), "and is NOT quietly present").toBe(false);
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

describe("A1 · the loader REPORTS, the consumer REFUSES", () => {
  const src = (repoRel: string) =>
    readFileSync(fileURLToPath(new URL(`../${repoRel}`, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("the drain worker refuses to run when ANYTHING failed to load", () => {
    // DRIVEN, NOT SPELLED. The previous version of this law was a source regex — does
    // worker.ts contain "load_errors.length", does "refusing to run" appear, is one before
    // the other — and the verifier killed it by Law 3: neutering the condition to
    // `if (false)` while leaving the TEXT in place kept the law GREEN. A law that passes on
    // a fake fix is not a law, it is a description of the file. So the guard was extracted
    // and this calls it.
    //
    // THE ORDER IS PART OF THE PROPERTY, and it is asserted the only honest way: with a
    // `standards` map that DETONATES if consulted. If the refusal ever moved after the gig's
    // standard is resolved, a missing standard would mask it and the operator would be told
    // the wrong thing about why their gig died.
    const boom = {
      get(): never {
        throw new Error("standards.get was consulted before the genome was checked");
      },
    };
    const holed = {
      load_errors: [{
        kind: "venue" as const,
        path: "postgrest:coltrane_venues/residency",
        slug: "residency",
        error: 'venue "residency" is active but could not be loaded — doors: present but not an object',
      }],
      standards: boom,
    };

    let err: Error | undefined;
    try {
      refuseUnlessLoaded(holed);
    } catch (e) {
      err = e as Error;
    }
    expect(err, "a genome with a hole in it must stop the run").toBeDefined();
    expect(err!.message, "the refusal is the genome one, not the standards one")
      .toContain("refusing to run");
    expect(err!.message, "and it names the kind").toContain("venue");
    expect(err!.message, "and the room").toContain("residency");
    expect(err!.message, "and the rule it broke").toContain("doors");
  });

  it("a whole genome runs — the guard narrows to the defect and nothing else", () => {
    // Without this, `throw always` would satisfy the law above and stop every gig forever.
    expect(() => refuseUnlessLoaded({ load_errors: [], standards: { get: () => undefined } }))
      .not.toThrow();
  });

  it("the HOLE is reported before the missing standard — the story must be the true one", () => {
    // THE MUTANT THAT SURVIVED, and the law that kills it. The guard was already extracted
    // and driven with a detonating `standards` map — which proves the GUARD is standards-blind
    // and proves NOTHING about where the worker calls it. The verifier moved the call to sit
    // after `standards.get(...)`; it compiled; all ten laws stayed green.
    //
    // With that move, a gig naming a missing standard on a broken genome dies with "claimed
    // standard … is not in the org genome" — the WRONG STORY. The genome had a hole in it;
    // the standard's absence is a symptom of the hole, not the fault. An operator told the
    // wrong cause fixes the wrong thing, and this whole arc has been about oracles that
    // report the wrong cause.
    //
    // Both faults are present at once ON PURPOSE: that is the only arrangement in which the
    // ORDER is observable. With one fault, either order gives the same answer.
    const holedAndMissing = {
      load_errors: [{
        kind: "venue" as const,
        path: "postgrest:coltrane_venues/residency",
        slug: "residency",
        error: 'venue "residency" is active but could not be loaded — doors: present but not an object',
      }],
      standards: { get: (): undefined => undefined },   // the standard is ALSO absent
    };

    let err: Error | undefined;
    try {
      standardForRun(holedAndMissing, "software-change-red-first-v0");
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message, "the genome's hole is the cause, and must be the one reported")
      .toContain("refusing to run");
    expect(err!.message, "the standard's absence is a SYMPTOM and must not be blamed")
      .not.toContain("not in the org genome");
  });

  it("a whole genome still reports a genuinely missing standard", () => {
    // The other side, so the law above cannot be satisfied by always blaming the genome.
    expect(() => standardForRun({ load_errors: [], standards: { get: () => undefined } }, "nope"))
      .toThrow(/not in the org genome/);
    expect(standardForRun({ load_errors: [], standards: { get: () => ({ slug: "s" }) } }, "s"))
      .toEqual({ slug: "s" });
  });

  it("(weaker, second clause) the call site is a bare invocation with no condition to disable", () => {
    // Deliberately NOT the law — the law is the two behavioural ones above. This only pins
    // that the guard is invoked unconditionally, so the whole of it lives in one function
    // where a mutant must edit the guard itself rather than quietly neuter a call site.
    const w = readFileSync(fileURLToPath(new URL("../src/worker.ts", import.meta.url)), "utf8");
    expect(w).toMatch(/^\s*const standard = standardForRun\(genome, claim\.standard_slug\);\s*$/m);
  });

  it("no law here may claim a COMPLETE consumer set — the package boundary is real", () => {
    // The verifier's sentence, kept as a law rather than a note because I have already made
    // this mistake once: a consumer set proven by grepping one repo is a fact about that
    // repo, not about the system. This package is imported by coltrane-ui (hosted-genome.ts)
    // and reached through hosted_tools.ts; both are outside anything a test in this repo can
    // enumerate. So the property asserted is the honest one — the loader's contract must hold
    // for consumers it cannot see, which is exactly why it reports rather than throws.
    // The boundary stated as the fact that makes it real: `./genome_store` is a PUBLIC
    // subpath of this package. Anything that imports it is a consumer, and no test in this
    // repo can enumerate those. (I first tried to point this law at hosted_tools.ts, where
    // `postgrestGenomeStore` appears — and it appears only in a COMMENT there. The export
    // map is the load-bearing fact; a mention in prose is not a consumer.)
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { exports?: Record<string, unknown> };
    expect(Object.keys(pkg.exports ?? {}), "the store loader is exported to consumers we cannot see")
      .toContain("./genome_store");
    // and the loader must not have regained an unconditional throw on an active row
    expect(src("src/genome_store.ts"))
      .not.toMatch(/throw new Error\(`venue "\$\{slug/);
  });
});
