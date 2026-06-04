// ADVERSARIAL e2e: concurrent writes to the SAME gig_id from multiple in-process
// callers. Probes the racey seams in PR #98's disk-backed jsonl path + the
// in-memory outputs Map / edges array.
//
// Eugene's directive: "I WANT REDS." These probes are written to EXPOSE bugs,
// not to certify green. Each `it()` block is its own counter-claim: if the test
// goes red, the named failure mode is real and reproducible.
//
// Failure modes probed:
//   1. outputs Map race — two writes with same gig_id, different domain_type,
//      fired via Promise.all (microtask interleave through validate()).
//   2. addRef opposite-direction edges A->B AND B->A simultaneously — both share
//      a single mutable `edges: OutputRef[]` array + write to the SAME refs file
//      (keyed by from_output_id's gig_id).
//   3. Append-to-jsonl race (PR #98 seam) — N parallel writes to the same gig
//      file via appendFileSync. POSIX guarantees O_APPEND atomicity only for
//      writes <= PIPE_BUF (~512B on darwin, 4096B on linux); inflate `data` past
//      that and interleaved bytes can corrupt lines.
//   4. output_query during a concurrent write — does all() / refs() hydrate
//      half-written state, or skip the most recent records because hydratedGigs
//      memoization blinds it to file-tail growth?
//   5. Cross-store visibility — two OutputStore instances on the SAME persistDir
//      (the realistic shape: MCP server + a sidecar tool). Store A writes, store
//      B writes, store A re-reads — does it miss B's writes because its
//      hydratedGigs flag is set?
//
// Run:
//   npx vitest run --config tests/e2e/vitest.config.ts \
//     tests/e2e/concurrent_writes_same_gig.spec.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRegistry,
  createOutputStore,
  type DomainType,
  type OutputRecord,
} from "../../src/index.js";

const pageModel: DomainType = {
  slug: "page-model",
  extends: "Signal",
  domain: "eirtests",
  schema: { properties: { url: { type: "string" }, blob: { type: "string" } } },
  required_fields: ["url"],
};

const finding: DomainType = {
  slug: "finding",
  extends: "Verdict",
  domain: "eirtests",
  schema: { properties: { title: { type: "string" }, blob: { type: "string" } } },
  required_fields: ["title"],
};

function freshRegistry() {
  const r = createRegistry();
  r.registerType(pageModel);
  r.registerType(finding);
  return r;
}

describe("ADVERSARIAL: concurrent writes to the same gig_id", () => {
  let persistDir: string;

  beforeEach(() => {
    persistDir = mkdtempSync(join(tmpdir(), "coltrane-race-"));
  });

  afterEach(() => {
    rmSync(persistDir, { recursive: true, force: true });
  });

  it("PROBE 1: two simultaneous writes (different domain_type, same gig) — both rows must be on disk + in Map", async () => {
    const store = createOutputStore(freshRegistry(), { persistDir });
    const GIG = "gig-race-1";

    // Promise.all interleaves the two write() bodies through microtasks. Each
    // write() in turn calls registry.validate() — if validate is ever async or
    // yields, the Map/file state can be observed mid-flight.
    await Promise.all([
      Promise.resolve().then(() =>
        store.write({
          core_type: "Signal",
          domain_type: "page-model",
          domain: "eirtests",
          gig_id: GIG,
          agent_slug: "scout",
          primitive: "SENSE",
          data: { url: "/a" },
        }),
      ),
      Promise.resolve().then(() =>
        store.write({
          core_type: "Verdict",
          domain_type: "finding",
          domain: "eirtests",
          gig_id: GIG,
          agent_slug: "verifier",
          primitive: "VERIFY",
          data: { title: "race-finding" },
        }),
      ),
    ]);

    // In-memory: both records must be present, with unique ids and the right gigs.
    const all = store.all();
    expect(all.length).toBe(2);
    const byType = new Map(all.map((o) => [o.domain_type, o]));
    expect(byType.get("page-model")?.gig_id).toBe(GIG);
    expect(byType.get("finding")?.gig_id).toBe(GIG);

    // On disk: exactly 2 lines, both parseable, both with the right gig_id.
    const gigFile = join(persistDir, "outputs", `${GIG}.jsonl`);
    expect(existsSync(gigFile)).toBe(true);
    const text = readFileSync(gigFile, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const rec = JSON.parse(line) as OutputRecord; // throws on corruption -> RED
      expect(rec.gig_id).toBe(GIG);
      expect(rec.id).toBeTruthy();
    }
  });

  it("PROBE 2: opposite-direction edges A->B and B->A fired in parallel — both must land in edges + on disk", async () => {
    const store = createOutputStore(freshRegistry(), { persistDir });
    const GIG = "gig-race-2";

    const a = store.write({
      core_type: "Signal",
      domain_type: "page-model",
      domain: "eirtests",
      gig_id: GIG,
      agent_slug: "scout",
      primitive: "SENSE",
      data: { url: "/a" },
    });
    const b = store.write({
      core_type: "Signal",
      domain_type: "page-model",
      domain: "eirtests",
      gig_id: GIG,
      agent_slug: "scout",
      primitive: "SENSE",
      data: { url: "/b" },
    });

    // Cycle: A derives_from B, B refines A. Both addRef bodies will write to
    // the SAME refs file (refs/<GIG>.jsonl) because both endpoints share gig.
    await Promise.all([
      Promise.resolve().then(() => store.addRef(a.id, b.id, "derived_from", "SENSE")),
      Promise.resolve().then(() => store.addRef(b.id, a.id, "refines", "SENSE")),
    ]);

    const refs = store.refs();
    expect(refs.length).toBe(2);
    const directions = new Set(refs.map((r) => `${r.from_output_id}->${r.to_output_id}`));
    expect(directions.has(`${a.id}->${b.id}`)).toBe(true);
    expect(directions.has(`${b.id}->${a.id}`)).toBe(true);

    // Disk shape: refs/<GIG>.jsonl should hold exactly 2 lines, both parseable.
    const refsFile = join(persistDir, "refs", `${GIG}.jsonl`);
    expect(existsSync(refsFile)).toBe(true);
    const lines = readFileSync(refsFile, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      JSON.parse(line); // corruption => RED
    }
  });

  it("PROBE 3: 32 parallel writes with LARGE data (>PIPE_BUF) to same gig — every line on disk must parse", async () => {
    const store = createOutputStore(freshRegistry(), { persistDir });
    const GIG = "gig-race-3";
    const N = 32;

    // Inflate the payload past the POSIX PIPE_BUF atomic-append guarantee
    // (512B on darwin, 4096B on linux). If appendFileSync's underlying write()
    // ever short-writes under contention, this is where interleaved bytes show.
    const BLOB = "x".repeat(8192);

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() =>
          store.write({
            core_type: "Signal",
            domain_type: "page-model",
            domain: "eirtests",
            gig_id: GIG,
            agent_slug: "scout",
            primitive: "SENSE",
            data: { url: `/p${i}`, blob: BLOB },
          }),
        ),
      ),
    );

    // In-memory: N unique records.
    const all = store.all();
    expect(all.length).toBe(N);
    expect(new Set(all.map((o) => o.id)).size).toBe(N);

    // Disk: exactly N lines, every line a valid JSON OutputRecord with right gig.
    const gigFile = join(persistDir, "outputs", `${GIG}.jsonl`);
    const text = readFileSync(gigFile, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(N);
    const seenUrls = new Set<string>();
    for (const line of lines) {
      const rec = JSON.parse(line) as OutputRecord; // corruption => RED
      expect(rec.gig_id).toBe(GIG);
      expect(typeof rec.data["blob"]).toBe("string");
      expect((rec.data["blob"] as string).length).toBe(BLOB.length);
      seenUrls.add(rec.data["url"] as string);
    }
    expect(seenUrls.size).toBe(N);
  });

  it("PROBE 4: output_query (all/refs) interleaved with concurrent writes — must see consistent state", async () => {
    const store = createOutputStore(freshRegistry(), { persistDir });
    const GIG = "gig-race-4";
    const N = 16;

    // Interleave reads with writes. all() walks the in-memory Map; under
    // contention the iterator should never expose a partial OutputRecord.
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < N; i++) {
      ops.push(
        Promise.resolve().then(() =>
          store.write({
            core_type: "Signal",
            domain_type: "page-model",
            domain: "eirtests",
            gig_id: GIG,
            agent_slug: "scout",
            primitive: "SENSE",
            data: { url: `/q${i}` },
          }),
        ),
      );
      ops.push(
        Promise.resolve().then(() => {
          const snapshot = store.all();
          // Every observed record must be fully-formed (no undefined required fields).
          for (const rec of snapshot) {
            expect(rec.id).toBeTruthy();
            expect(rec.gig_id).toBeTruthy();
            expect(rec.core_type).toBeTruthy();
            expect(rec.domain_type).toBeTruthy();
            expect(rec.created_at).toBeTruthy();
            expect(rec.data).toBeTruthy();
          }
        }),
      );
    }
    await Promise.all(ops);

    // Final state: all N writes landed.
    expect(store.all().length).toBe(N);
  });

  it("PROBE 5: cross-store visibility — store A writes, store B writes to same gig, A's next read MUST see B's row", async () => {
    // This is the realistic MCP shape: server holds one OutputStore, a sidecar
    // (CLI / second tool) holds another. PR #98 keyed `hydratedGigs` per-store,
    // so once store A has touched gig X, subsequent hydrateGig(X) is a no-op —
    // even if store B has appended new rows to X.jsonl in the interim.
    const storeA = createOutputStore(freshRegistry(), { persistDir });
    const storeB = createOutputStore(freshRegistry(), { persistDir });
    const GIG = "gig-race-5";

    storeA.write({
      core_type: "Signal",
      domain_type: "page-model",
      domain: "eirtests",
      gig_id: GIG,
      agent_slug: "scout",
      primitive: "SENSE",
      data: { url: "/from-A" },
    });

    // Force A to hydrate (marks hydratedGigs/fullyHydrated). Now any subsequent
    // append by B is invisible to A unless the store explicitly re-reads.
    expect(storeA.all().length).toBe(1);

    storeB.write({
      core_type: "Signal",
      domain_type: "page-model",
      domain: "eirtests",
      gig_id: GIG,
      agent_slug: "scout",
      primitive: "SENSE",
      data: { url: "/from-B" },
    });

    // Disk reality check: both rows ARE in the gig file.
    const gigFile = join(persistDir, "outputs", `${GIG}.jsonl`);
    const lines = readFileSync(gigFile, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);

    // The probe: store A's view MUST reflect the on-disk reality (2 rows). If
    // the hydratedGigs memoization blinds A to B's append, this asserts 2 but
    // sees 1 — RED, and the bug is that the audit chain silently forks.
    const aSees = storeA.all();
    const urls = aSees.map((o) => o.data["url"]).sort();
    expect(aSees.length).toBe(2);
    expect(urls).toEqual(["/from-A", "/from-B"]);
  });
});
