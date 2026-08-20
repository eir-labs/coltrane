// The last step of the chain, and the only one that touches a disk.
//
// Every failure mode here is a way a lineage write could quietly corrupt a genome, so each one
// fails closed and reports why rather than repairing, creating, or overwriting.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistLineageAdoption } from "../src/lineage_persist.js";
import type { LineageRecordRefOutput } from "../src/genome_schema.js";

const ref = (record_ref: string, approved_by = "eugene"): LineageRecordRefOutput =>
  ({ record_ref, approved_by, sealed_at: "2026-08-20T00:00:00.000Z" } as LineageRecordRefOutput);

let root: string;
const write = (slug: string, body: unknown) =>
  writeFileSync(join(root, "institutions", `${slug}.json`), JSON.stringify(body, null, 2) + "\n");
const read = (slug: string) =>
  JSON.parse(readFileSync(join(root, "institutions", `${slug}.json`), "utf8")) as Record<string, any>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genome-"));
  mkdirSync(join(root, "institutions"));
});

describe("persistLineageAdoption", () => {
  it("writes the ref into the institution's lineage[]", () => {
    write("studio", { institution: { slug: "studio", lineage: [] }, chairs: [] });
    const r = persistLineageAdoption(root, "studio", ref("sha-a"));
    expect(r.written).toBe(true);
    expect(read("studio").institution.lineage).toHaveLength(1);
    expect(read("studio").institution.lineage[0].approved_by).toBe("eugene");
  });

  it("creates lineage[] when the document has none", () => {
    write("studio", { institution: { slug: "studio" } });
    expect(persistLineageAdoption(root, "studio", ref("sha-a")).written).toBe(true);
    expect(read("studio").institution.lineage).toHaveLength(1);
  });

  it("leaves every other section of the document untouched", () => {
    write("studio", { institution: { slug: "studio", laws: [{ aim: "x" }], sovereign: true }, chairs: [{ id: "c1" }], forebears: [] });
    persistLineageAdoption(root, "studio", ref("sha-a"));
    const d = read("studio");
    expect(d.chairs).toEqual([{ id: "c1" }]);
    expect(d.institution.laws).toEqual([{ aim: "x" }]);
    expect(d.institution.sovereign).toBe(true);
  });

  it("is INERT on re-adoption — the first seal stands and the file is not touched", () => {
    write("studio", { institution: { slug: "studio", lineage: [] } });
    persistLineageAdoption(root, "studio", ref("sha-a", "tasha"));
    const before = readFileSync(join(root, "institutions", "studio.json"), "utf8");
    const again = persistLineageAdoption(root, "studio", ref("sha-a", "someone-else"));
    expect(again.written).toBe(false);
    expect(again.reason).toBe("already-adopted");
    expect(readFileSync(join(root, "institutions", "studio.json"), "utf8")).toBe(before);
  });

  it("refuses a DEAD NAME rather than inventing an institution to hold the lineage", () => {
    const r = persistLineageAdoption(root, "ghost", ref("sha-a"));
    expect(r.written).toBe(false);
    expect(r.reason).toBe("no-such-institution");
  });

  it("leaves a malformed document alone rather than repairing it", () => {
    write("broken", { chairs: [] });                       // no `institution` root object
    const r = persistLineageAdoption(root, "broken", ref("sha-a"));
    expect(r.written).toBe(false);
    expect(r.reason).toBe("unexpected-shape");
    expect(read("broken")).toEqual({ chairs: [] });
  });

  it("reports unreadable JSON instead of throwing", () => {
    writeFileSync(join(root, "institutions", "bad.json"), "{ not json");
    const r = persistLineageAdoption(root, "bad", ref("sha-a"));
    expect(r.written).toBe(false);
    expect(r.reason).toBe("unreadable");
  });

  it("appends rather than replaces when a second, different record is adopted", () => {
    write("studio", { institution: { slug: "studio", lineage: [] } });
    persistLineageAdoption(root, "studio", ref("sha-a"));
    persistLineageAdoption(root, "studio", ref("sha-b"));
    expect(read("studio").institution.lineage.map((r: any) => r.record_ref)).toEqual(["sha-a", "sha-b"]);
  });
});
