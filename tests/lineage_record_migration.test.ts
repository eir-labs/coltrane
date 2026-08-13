// RED SPEC — lineage-record-typing-v1 (migration): tightening a SHIPPED type must not make
// sealed history unreadable or retroactively invalid. The genome holds 10 sealed lineage-records
// and 2 sealed lineage-verdicts; outputs carry domain_type_version. Records sealed under version 1
// are historical fact — they must remain readable and traceable; they simply were not held to the
// new bar.
//
// This is nearly free because validation is WRITE-TIME ONLY: checkWritable runs inside write()
// (src/outputs.ts:634-639); the read path hydrateGig (src/outputs.ts:593-607) reads rows straight
// into the map with NO re-validation, and domain_type_version is folded into content_sha
// (src/outputs.ts:653) so old hashes are untouched by the bump. So a v1 record — loose, prose-
// grounded, and INVALID under v2 — must still hydrate, trace, and report domain_type_version:1.
//
// RED trigger: the invariant references the v2 bump, and the type is still version 1 on disk, so
// `version === 2` fails until domain_types/lineage-record.json is bumped. The readability half is
// the golden-master: the historical BYTES are the oracle, exercised through the exact read path
// that guarantees they survive.
//
// CAVEAT (honest): the 10 real sealed records live in the organization's genome STORE, not in this
// public repo tree, so they are not reachable from a worktree checkout. The fixtures below
// faithfully reproduce the two records the brief names — 03cacf6a (nine connections, one grounded
// "fully", eight "conceptual") and c2000367 (grounded:None on all nine) — as raw historical bytes.
// They are deliberately in the LOOSE v1 shape that v2 would reject, so a read path that re-validated
// would break on them; that is precisely the property under test. When run against the real store
// (COLTRANE_LINEAGE_STORE pointing at the org outputs dir), swap the fixture for the real bytes.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome, loadRegistry, createOutputStore, type OutputStore } from "../src";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A full OutputRecord row as it was appended to <gig>.jsonl under the v1 type. */
function v1RecordRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "rec-03cacf6a",
    core_type: "Artifact",
    domain_type: "lineage-record",
    domain_type_version: 1,
    domain: "lineage",
    gig_id: "eb1f7b05",
    agent_slug: "lineage-scribe",
    primitive: "CREATE",
    content_sha: "sha-03cacf6a",
    input_refs: [],
    input_shas: [],
    created_at: "2026-08-14T00:00:00.000Z",
    data: {},
    ...over,
  };
}

/** Nine connections in the LOOSE v1 shape: grounding as a free-prose `grounded` field, no typed
 *  strength. This is exactly what the v2 item schema forbids. */
function v1Connections(grounded: (i: number) => unknown): Record<string, unknown>[] {
  return Array.from({ length: 9 }, (_unused, i) => ({
    internal_ref: `internal/rep-${i}`,
    external_ref: `external/source-${i}`,
    relation: "aligns-with",
    grounded: grounded(i),
  }));
}

/** Seat raw historical rows into a fresh persistDir-backed store and return it. */
function storeWithRows(rows: Record<string, unknown>[], gig: string): OutputStore {
  const dir = mkdtempSync(join(tmpdir(), "coltrane-lineage-v1-"));
  mkdirSync(join(dir, "outputs"), { recursive: true });
  writeFileSync(join(dir, "outputs", `${gig}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // The registry is the TIGHTENED v2 one (loaded from disk); the point is that reads never route
  // these rows through it.
  return createOutputStore(loadRegistry(loadGenome(REPO_ROOT)), { persistDir: dir });
}

describe("I10 — a v1 lineage-record stays readable and traceable after the v2 bump", () => {
  it("lineage-record is bumped to version 2 on disk", () => {
    const genome = loadGenome(REPO_ROOT);
    expect(genome.domain_types.get("lineage-record")?.version).toBe(2);
  });

  it("record 03cacf6a (nine connections, prose grounding — invalid under v2) still hydrates and reports domain_type_version:1", () => {
    const row = v1RecordRow({
      id: "rec-03cacf6a",
      gig_id: "gig-03cacf6a",
      data: {
        external_body: [{ source: "a prior body", status: "reached" }],
        internal_inventory: [{ reference: "genome/x" }],
        connections: v1Connections((i) =>
          i === 0 ? "fully — dereferenceable internal citation on both sides" : "conceptual — schema structure, no internal citation",
        ),
        gap: "thin grounding",
        alignment_recommendation: "cite",
        validation_criteria: ["grounded per-edge"],
      },
    });
    const store = storeWithRows([row], "gig-03cacf6a");
    const rec = store.get("rec-03cacf6a");
    expect(rec).toBeDefined();
    expect(rec!.domain_type_version).toBe(1);
    expect((rec!.data.connections as unknown[]).length).toBe(9);
    // traceable: it resolves in the walked store surface without a re-validation gate.
    expect(store.all().map((r) => r.id)).toContain("rec-03cacf6a");
    expect(() => store.trace("rec-03cacf6a")).not.toThrow();
  });

  it("record c2000367 (grounded:None on all nine) still hydrates unchanged", () => {
    const row = v1RecordRow({
      id: "rec-c2000367",
      gig_id: "gig-c2000367",
      data: {
        external_body: [{ source: "a prior body", status: "reached" }],
        internal_inventory: [{ reference: "genome/x" }],
        connections: v1Connections(() => null),
        gap: "thin grounding",
        alignment_recommendation: "cite",
        validation_criteria: ["grounded per-edge"],
      },
    });
    const store = storeWithRows([row], "gig-c2000367");
    const rec = store.get("rec-c2000367");
    expect(rec).toBeDefined();
    expect(rec!.domain_type_version).toBe(1);
    expect((rec!.data.connections as { grounded: unknown }[]).every((c) => c.grounded === null)).toBe(true);
  });
});

describe("I11 — the 2 sealed lineage-verdicts are unaffected by the record tightening", () => {
  it("both verdicts still hydrate, and lineage-verdict stays at version 1", () => {
    const genome = loadGenome(REPO_ROOT);
    // the migration precondition: the record type moved to v2 (RED until the bump)
    expect(genome.domain_types.get("lineage-record")?.version).toBe(2);
    // the verdict type is NOT re-typed by this change
    expect(genome.domain_types.get("lineage-verdict")?.version).toBe(1);

    const verdictRow = (id: string): Record<string, unknown> => ({
      id,
      core_type: "Verdict",
      domain_type: "lineage-verdict",
      domain_type_version: 1,
      domain: "lineage",
      gig_id: "gig-verdicts",
      agent_slug: "",
      primitive: "VERIFY",
      content_sha: `sha-${id}`,
      input_refs: [],
      input_shas: [],
      created_at: "2026-08-14T00:00:00.000Z",
      data: { rationale: "grounded on both sides", checks: [{ method: "read-both-citations" }] },
    });
    const store = storeWithRows([verdictRow("verdict-1"), verdictRow("verdict-2")], "gig-verdicts");
    expect(store.get("verdict-1")?.domain_type_version).toBe(1);
    expect(store.get("verdict-2")?.domain_type_version).toBe(1);
    expect(store.all().filter((r) => r.domain_type === "lineage-verdict").length).toBe(2);
  });
});

describe("I12 — the shipped genome still loads and composes unchanged (the compile/load guard)", () => {
  it("loadGenome reports zero load_errors and the lineage pass + its types are present", () => {
    // This is the meta-invariant: it must stay GREEN, so that every RED above comes from an
    // absent-enforcement ASSERTION and never from a genome file that failed to load or a spec that
    // did not compile. A committed broken definition would surface here as a load_error.
    const genome = loadGenome(REPO_ROOT);
    const detail = genome.load_errors.map((e) => `  [${e.kind}] ${e.path}: ${e.error}`).join("\n");
    expect(genome.load_errors, `committed genome has load_errors:\n${detail}`).toEqual([]);
    expect(genome.standards.has("lineage-pass-v1")).toBe(true);
    for (const slug of ["lineage-record", "lineage-map", "lineage-hit", "lineage-verdict"]) {
      expect(genome.domain_types.has(slug), `missing domain type ${slug}`).toBe(true);
    }
    // the registry reconstitutes from those files with no throw — the "composes unchanged" floor
    expect(() => loadRegistry(genome)).not.toThrow();
  });
});
