// THE NAMING CEREMONY, WHEREVER IT IS PERFORMED.
//
// `AgentRecordSchema` declares the ceremony as a lifecycle — proposed → named → active — and says
// in its own comment that "named" is sealed through the naming ceremony, never self-approved. It
// declares `named_from_forebear` alongside. Neither was checked outside the quartet: the three
// laws in default_genome_quartet.test.ts run over a hardcoded NAMED_SEATS roster of the quartet's
// own three seats, so a record named in ANY OTHER institution — coltrane's own `bandleader`, or a
// downstream org's seat — could claim descent from a forebear that does not exist, or reach
// `active` having descended from nothing at all, and no law would notice.
//
// That is the shape this codebase keeps finding and closing: a field that states a governed act,
// with nothing that reads it. These laws are institution-agnostic by construction — they walk every
// document in institutions/ — so the ceremony is enforced wherever it happens rather than only
// where someone remembered to add a slug to a list.
//
// What they do NOT assert: least authority, domain-agnosticism, or which standards may seat the
// record. Those are properties of the QUARTET's three seats specifically, and conflating them with
// naming is what makes a roster-driven law refuse a legitimately-named seat of a different kind.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRecordSchema, ForebearSchema, LineageEdgeSchema } from "../src/genome_schema.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const INSTITUTIONS_DIR = join(REPO_ROOT, "institutions");

type Doc = {
  agent_records?: unknown[];
  forebears?: unknown[];
  lineage_edges?: unknown[];
};

const docs: Array<{ file: string; doc: Doc }> = existsSync(INSTITUTIONS_DIR)
  ? readdirSync(INSTITUTIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: f, doc: JSON.parse(readFileSync(join(INSTITUTIONS_DIR, f), "utf8")) as Doc }))
  : [];

const records = docs.flatMap(({ file, doc }) =>
  (doc.agent_records ?? []).map((raw) => ({ file, rec: AgentRecordSchema.parse(raw) })),
);
const forebears = new Map(
  docs.flatMap(({ doc }) => (doc.forebears ?? []).map((raw) => {
    const f = ForebearSchema.parse(raw);
    return [f.slug, f] as const;
  })),
);
const edges = docs.flatMap(({ doc }) => (doc.lineage_edges ?? []).map((raw) => LineageEdgeSchema.parse(raw)));

/** Records that CLAIM a descent — the ceremony was performed, so it must be well formed. */
const claimed = records.filter(({ rec }) => rec.named_from_forebear !== null);
/** Records at `named` — the status the ceremony itself seals, so it obliges a descent.
 *
 *  NOT `active`. The schema comment makes two claims, not one: "nothing is active until governed
 *  so" and "'named' is sealed through the naming ceremony". Governance and naming are different
 *  acts. A service seat can be governed from `proposed` straight to `active` without ever carrying
 *  a figure's disposition — `coltrane-proposer` is exactly that, and demanding it descend from
 *  someone would be a law inventing a requirement the schema never stated. What the ceremony
 *  obliges is that a seat which claims to be NAMED can say who it was named from. */
const named_status = records.filter(({ rec }) => rec.status === "named");

describe("the naming ceremony is well formed, in every institution", () => {
  it("the corpus is non-vacuous — there are institutions, records, and at least one claimed descent", () => {
    expect(docs.length, "institutions/ holds no documents").toBeGreaterThan(0);
    expect(records.length, "no agent records to hold to account").toBeGreaterThan(0);
    expect(claimed.length, "no record claims a descent — this law would pass by having nothing to check").toBeGreaterThan(0);
  });

  it("a record at `named` has been named FROM something — the ceremony is not self-granted", () => {
    for (const { file, rec } of named_status) {
      expect(
        rec.named_from_forebear,
        `"${rec.slug}" in ${file} is status "named" with named_from_forebear null — ` +
          `the ceremony seals a descent, so a seat cannot BE named having descended from nothing`,
      ).toBeTypeOf("string");
    }
  });

  it("every claimed descent RESOLVES — a name from a forebear that has no record is a dead name", () => {
    for (const { file, rec } of claimed) {
      expect(
        forebears.has(rec.named_from_forebear!),
        `"${rec.slug}" in ${file} descends from forebear "${rec.named_from_forebear}", which no institution declares`,
      ).toBe(true);
    }
  });

  it("the forebear says WHAT WAS TAKEN, with dates — a disposition, not an admiration", () => {
    for (const { file, rec } of claimed) {
      const f = forebears.get(rec.named_from_forebear!)!;
      expect(f.what_taken, `forebear "${f.slug}" (named by "${rec.slug}" in ${file}) does not say what was taken`).toBeTypeOf("string");
      expect(
        f.what_taken!.length,
        `forebear "${f.slug}" states what was taken in ${f.what_taken!.length} chars — too thin to be a working disposition`,
      ).toBeGreaterThan(120);
      expect(f.what_taken!, `forebear "${f.slug}" states no dates`).toMatch(/\b(18|19|20)\d{2}\b/);
    }
  });

  it("a typed lineage edge binds the seat to the forebear, and carries a source", () => {
    for (const { file, rec } of claimed) {
      const edge = edges.find((e) => e.from_node === `agent:${rec.slug}`);
      expect(edge, `no lineage edge from "agent:${rec.slug}" (${file}) — the descent is asserted on the record and nowhere in the chain`).toBeDefined();
      expect(edge!.edge_type).toBe("descends-from");
      expect(edge!.to_node).toBe(`forebear:${rec.named_from_forebear}`);
      expect(
        Object.keys(edge!.source ?? {}).length,
        `lineage edge for "${rec.slug}" carries no source — an uncited attribution is a claim, not a record`,
      ).toBeGreaterThan(0);
    }
  });

  it("two seats do not descend from the same figure — a name distinguishes, or it is not a name", () => {
    const byForebear = new Map<string, string[]>();
    for (const { rec } of claimed) {
      const list = byForebear.get(rec.named_from_forebear!) ?? [];
      list.push(rec.slug);
      byForebear.set(rec.named_from_forebear!, list);
    }
    for (const [forebear, slugs] of byForebear) {
      expect(slugs.length, `seats [${slugs.join(", ")}] all descend from "${forebear}"`).toBe(1);
    }
  });
});
