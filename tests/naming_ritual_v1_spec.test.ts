// RED spec — naming-ritual-v1: the naming law adopted by the Coltrane institution,
// tip-conforming (founding finding: the founder's naming-ritual-v0 is a chancery tenant
// amendment never upstreamed to canon, and its CREATE-first shape fails this engine's
// composition rules). Three legs preserved: a reader frames, the scribe composes with the
// forebear BY CONTENT ADDRESS, the human seat alone mints. RED until the standard lands.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const P = join(REPO, "standards", "naming-ritual-v1.json");
const load = () => JSON.parse(readFileSync(P, "utf8"));

describe("naming-ritual-v1 · INV-1 presence", () => {
  it("the standard file exists", () => expect(existsSync(P)).toBe(true));
});

describe("naming-ritual-v1 · INV-2 the three phases, in order", () => {
  it("read-candidate, compose-naming, seal-naming", () => {
    const d = load();
    expect(d.phases.map((p: any) => p.name)).toEqual(["read-candidate", "compose-naming", "seal-naming"]);
  });
});

describe("naming-ritual-v1 · INV-3 the reader frames, never judges", () => {
  it("context-reader seat with change-context out", () => {
    const c = load().phases[0].chairs[0];
    expect(c.agent_slug).toBe("context-reader");
    expect(c.input_contract).toEqual(["draft-agent-profile"]);
    expect(c.output_contract).toEqual(["change-context"]);
    expect(c.depends_on).toEqual([]);
  });
});

describe("naming-ritual-v1 · INV-4 the scribe composes, mints nothing", () => {
  it("lineage-scribe downstream of the reader", () => {
    const c = load().phases[1].chairs[0];
    expect(c.agent_slug).toBe("lineage-scribe");
    expect(c.depends_on).toEqual(["read-candidate"]);
    expect(c.input_contract).toEqual(["draft-agent-profile", "change-context"]);
    expect(c.output_contract).toEqual(["lineage-record"]);
  });
  it("compose intent binds the forebear to a content address, never recollection", () => {
    const i = (load().phases[1].intent || "").toLowerCase();
    expect(i).toContain("content address");
    expect(i).toContain("never by recollection");
  });
});

describe("naming-ritual-v1 · INV-5 the seal seat is human-only, by shape", () => {
  it("human chair, empty agent_slug, sole verdict producer", () => {
    const d = load();
    const seal = d.phases[2].chairs[0];
    expect(seal.human).toBe(true);
    expect(seal.agent_slug).toBe("");
    expect(seal.depends_on).toEqual(["compose-naming"]);
    expect(seal.input_contract).toEqual(["lineage-record"]);
    expect(seal.output_contract).toEqual(["lineage-verdict"]);
    for (const ph of d.phases.slice(0, 2))
      for (const c of ph.chairs)
        expect(c.output_contract).not.toContain("lineage-verdict");
  });
  it("the standard's own description says the seal alone mints", () => {
    expect((load().description || "").toLowerCase()).toContain("seal");
  });
});

describe("naming-ritual-v1 · INV-6 metadata", () => {
  it("domain lineage, active, typed", () => {
    const d = load();
    expect(d.domain).toBe("lineage");
    expect(d.status).toBe("active");
    expect(d.input_types).toEqual(["draft-agent-profile"]);
    expect(d.output_types).toEqual(["lineage-verdict"]);
  });
});
