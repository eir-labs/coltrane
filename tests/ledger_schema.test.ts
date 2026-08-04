// RED — issue #212: LedgerEntry models only a completed gig.
//
// The settled schema (both independent characterizations converged on it):
//   discriminated union on `kind`: "gig" | "genome_mutation" | "governance"
//   * genome_hash / run_fingerprint exist ONLY on gig rows, validated /^[0-9a-f]{64}$/,
//     which makes the sentinel "n/a" structurally unrepresentable
//   * subject_gig_id first-class so aborts and reviews join back to their gig
//   * subject_slug + a typed `detail` payload on governance rows
//
// NAMING (negotiable, flagged for the implementer): `event` as the per-kind discriminator is a
// DECISION, not something derived from the issues. `kind` partitions rows into the three
// classes; `event` names the specific tool/mutation within a class. If the implementer prefers
// `tool`, `op`, or a flattened single-level discriminator, only the field NAME in these tests
// changes — every assertion about what must be recorded stands. `integrity()` (#211) and
// `audit_write_failed` (#218) are invented surfaces in the same category.
//   * ONE shared validateEntry called by BOTH implementations (the duplicated guard
//     triplet at src/ledger.ts:56-58 / :102-104 is how the #214 divergence crept in)
//   * count() takes an optional filter
//   * read-side upgrade for v1 files, NEVER rewriting (the file is append-only), with
//     every upgraded row carrying `legacy: true` — without that marker the upgrade
//     launders a known gap into apparent completeness, the same class of dishonesty
//     as "n/a" itself
//
// This file pins the TYPE/VALIDATOR layer. The call-site half (the 7 append sites that
// write "n/a" today) is pinned in tests/ledger_event_records.test.ts.
//
// RED technique: new API surface is probed via dynamic import + an explicit existence
// assertion rather than a static named import. A static import of a not-yet-existing
// export is a link-time SyntaxError that fails EVERY test in the file with the wrong
// message; this way each test fails with a message naming the contract it wants.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLedger, MemoryLedger } from "../src/ledger.js";

const HEX64 = /^[0-9a-f]{64}$/;

// Real-shaped 64-hex identity values (sha256 of the label). Deliberately NOT "gh1"-style
// placeholders: the settled validator rejects anything that isn't 64 lowercase hex.
const GENOME_HASH = "a".repeat(64);
const RUN_FP = "b".repeat(64);
const CONTENT_HASH = "c".repeat(64);
const EFFECTIVE_HASH = "d".repeat(64);

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ledger-schema-"));
}

/** Loose row view — the tests assert on data, not on types that don't exist yet. */
type Row = Record<string, unknown>;

function gigRow(over: Row = {}): Row {
  return {
    kind: "gig",
    schema_version: 2,
    entry_id: "gig-1",
    gig_id: "gig-1",
    standard_slug: "readiness-scan",
    genome_hash: GENOME_HASH,
    run_fingerprint: RUN_FP,
    output_hashes: ["oh1"],
    started_at: "2026-05-25T20:00:00.000Z",
    finished_at: "2026-05-25T20:01:00.000Z",
    ...over,
  };
}

function governanceRow(over: Row = {}): Row {
  return {
    kind: "governance",
    schema_version: 2,
    entry_id: "promote-1",
    event: "agent_promote",
    subject_slug: "scout",
    detail: { from_status: "draft", to_status: "active" },
    output_hashes: [],
    started_at: "2026-05-25T20:00:00.000Z",
    finished_at: "2026-05-25T20:00:00.000Z",
    ...over,
  };
}

function mutationRow(over: Row = {}): Row {
  return {
    kind: "genome_mutation",
    schema_version: 2,
    entry_id: "define-1",
    event: "agent_define",
    subject_slug: "scout",
    content_hash: CONTENT_HASH,
    effective_hash: EFFECTIVE_HASH,
    output_hashes: [CONTENT_HASH],
    started_at: "2026-05-25T20:00:00.000Z",
    finished_at: "2026-05-25T20:00:00.000Z",
    ...over,
  };
}

async function ledgerModule(): Promise<Record<string, unknown>> {
  return (await import("../src/ledger.js")) as unknown as Record<string, unknown>;
}

/** Append, converting today's outright rejection of a non-gig row into an explanatory
 *  failure instead of a bare `Error: ledger entry requires gig_id`. The rejection IS the
 *  defect — LedgerEntry (src/ledger.ts:16-29) models only a completed gig, so the guard
 *  triplet at :56-58 refuses any event that has no gig identity. */
function appendOrExplain(l: { append: (e: never) => void }, row: Row, what: string): void {
  try {
    l.append(row as never);
  } catch (e) {
    expect.fail(
      `${what}: the ledger cannot even STORE this row — "${(e as Error).message}". ` +
        "LedgerEntry models exactly one event (a gig finished), so a " +
        `kind:"${String(row["kind"])}" event is unrepresentable and every other event class ` +
        "has to be smuggled into the gig shape with \"n/a\" identity (#212).",
    );
  }
}

/** Assert a not-yet-existing export is present, with a message that names the contract. */
function requireFn(v: unknown, name: string): void {
  expect(typeof v, `${name} is not exported from src/ledger.ts — see the first test in this file`).toBe("function");
}

// ────────────────────────────────────────────────────────────────────────────
// The shared validator
// ────────────────────────────────────────────────────────────────────────────
describe("#212 — one shared validateEntry, used by both implementations", () => {
  it("src/ledger.ts exports validateEntry", async () => {
    const mod = await ledgerModule();
    expect(
      typeof mod["validateEntry"],
      "src/ledger.ts must export a shared validateEntry(entry). Today the guard triplet is " +
        "duplicated at src/ledger.ts:56-58 (FileLedger) and :102-104 (MemoryLedger) — " +
        "duplication is how the #214 semantic divergence between the two impls crept in.",
    ).toBe("function");
  });

  it('rejects the sentinel "n/a" in a gig row\'s genome_hash', async () => {
    const mod = await ledgerModule();
    const validate = mod["validateEntry"] as ((e: unknown) => void) | undefined;
    requireFn(validate, "validateEntry");
    expect(
      () => validate!(gigRow({ genome_hash: "n/a" })),
      'validateEntry accepted genome_hash:"n/a". The current guard (src/ledger.ts:57) is ' +
        '`if (!entry.genome_hash) throw` — a non-emptiness check, which is exactly weak enough ' +
        'to let 7 call sites write "n/a" (issue #212). The rule must be /^[0-9a-f]{64}$/.',
    ).toThrow();
  });

  it('rejects the sentinel "n/a" in a gig row\'s run_fingerprint', async () => {
    const mod = await ledgerModule();
    const validate = mod["validateEntry"] as ((e: unknown) => void) | undefined;
    requireFn(validate, "validateEntry");
    expect(
      () => validate!(gigRow({ run_fingerprint: "n/a" })),
      'validateEntry accepted run_fingerprint:"n/a" — must be /^[0-9a-f]{64}$/.',
    ).toThrow();
  });

  it("accepts a well-formed gig row", async () => {
    const mod = await ledgerModule();
    const validate = mod["validateEntry"] as ((e: unknown) => void) | undefined;
    requireFn(validate, "validateEntry");
    expect(
      () => validate!(gigRow()),
      "validateEntry rejected a well-formed gig row — the hex rule must accept real sha256 values",
    ).not.toThrow();
  });

  it("rejects a non-hex identity that is merely non-empty (the old guard's blind spot)", async () => {
    const mod = await ledgerModule();
    const validate = mod["validateEntry"] as ((e: unknown) => void) | undefined;
    requireFn(validate, "validateEntry");
    for (const bad of ["gh1", "unknown", "-", "A".repeat(64), "f".repeat(63)]) {
      expect(
        () => validate!(gigRow({ genome_hash: bad })),
        `validateEntry accepted genome_hash:"${bad}". Non-empty is not the contract; ` +
          "64 lowercase hex is.",
      ).toThrow();
    }
  });

  it("both implementations reject an identical bad entry identically (shared-validator parity)", () => {
    const dir = freshDir();
    try {
      const mem = new MemoryLedger();
      const file = new FileLedger(join(dir, "ledger.jsonl"));
      const bad = gigRow({ genome_hash: "n/a" }) as never;

      let memThrew: unknown = null;
      let fileThrew: unknown = null;
      try { mem.append(bad); } catch (e) { memThrew = e; }
      try { file.append(bad); } catch (e) { fileThrew = e; }

      expect(
        memThrew !== null,
        'MemoryLedger.append accepted genome_hash:"n/a"',
      ).toBe(true);
      expect(
        fileThrew !== null,
        'FileLedger.append accepted genome_hash:"n/a"',
      ).toBe(true);
      expect(
        (memThrew as Error)?.constructor?.name,
        "the two implementations must reject through the SAME shared validator, so the " +
          "error class must match",
      ).toBe((fileThrew as Error)?.constructor?.name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Identity is gig-only — "n/a" becomes unrepresentable rather than merely rejected
// ────────────────────────────────────────────────────────────────────────────
describe('#212 — identity fields exist only on gig rows ("n/a" unrepresentable)', () => {
  it("a governance row round-trips with NO genome_hash and NO run_fingerprint", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      const l = new FileLedger(path);
      appendOrExplain(l, governanceRow(), "governance round-trip");

      const reader = new FileLedger(path);
      // Without this, the test proves only that JSON.stringify/parse is lossless over fields
      // the test itself supplied — it passes against a ledger with NO schema at all.
      expect(
        (reader.query as unknown as (f: Record<string, unknown>) => unknown[])({ kind: "governance" }).length,
        "the row must be reachable BY KIND, not merely echoed back — otherwise `kind` is an " +
          "inert field the writer happened to include rather than a real discriminator",
      ).toBe(1);
      const [row] = reader.query() as unknown as Row[];
      expect(row, "governance row did not round-trip").toBeDefined();
      expect(
        row!["kind"],
        "governance rows must be discriminated by kind, not by overloading standard_slug " +
          "with a tool name (src/server.ts:1106)",
      ).toBe("governance");
      expect(
        "genome_hash" in row!,
        "a governance row carried a genome_hash field. Identity is gig-only — that is what " +
          'makes "n/a" unrepresentable rather than merely discouraged.',
      ).toBe(false);
      expect(
        "run_fingerprint" in row!,
        "a governance row carried a run_fingerprint. A promotion is not a run; " +
          "run_fingerprint is f(genome_hash, model_version, canonical_form_version, " +
          "eval_scores, output_hashes) (src/canonical_form.ts:93) — none of which exist here.",
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a governance row requires event + subject_slug", async () => {
    const mod = await ledgerModule();
    const validate = mod["validateEntry"] as ((e: unknown) => void) | undefined;
    requireFn(validate, "validateEntry");
    const { event: _e, ...noEvent } = governanceRow();
    const { subject_slug: _s, ...noSubject } = governanceRow();
    expect(
      () => validate!(noEvent),
      "a governance row with no `event` was accepted — the event kind must be typed, not " +
        "smuggled into standard_slug",
    ).toThrow();
    expect(
      () => validate!(noSubject),
      "a governance row with no `subject_slug` was accepted — issue #212: promotions today " +
        "do not record WHICH entity was promoted",
    ).toThrow();
  });

  it("a genome_mutation row carries effective_hash + content_hash, not genome_hash", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      appendOrExplain(new FileLedger(path), mutationRow(), "genome_mutation round-trip");
      const reader = new FileLedger(path);
      expect(
        (reader.query as unknown as (f: Record<string, unknown>) => unknown[])({ kind: "genome_mutation" }).length,
        "the row must be reachable BY KIND — see the governance round-trip test for why a " +
          "field-echo assertion alone is not enough",
      ).toBe(1);
      const [row] = reader.query() as unknown as Row[];
      expect(row, "genome_mutation row did not round-trip").toBeDefined();
      expect(row!["kind"]).toBe("genome_mutation");
      expect(
        row!["effective_hash"],
        "a mutation's identity is its effective_hash. src/genome_writer.ts:77-78 writes it " +
          "into BOTH genome_hash and run_fingerprint today — the second is a small lie " +
          "(an effective hash is not a run fingerprint).",
      ).toBe(EFFECTIVE_HASH);
      expect(row!["content_hash"]).toBe(CONTENT_HASH);
      expect(
        "run_fingerprint" in row!,
        "a genome_mutation row carried a run_fingerprint — a definition is not a run",
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Query + count gain the discriminator
// ────────────────────────────────────────────────────────────────────────────
describe("#212 — query/count can discriminate by kind", () => {
  it("count() accepts an optional filter", () => {
    const l = new MemoryLedger();
    appendOrExplain(l, gigRow(), "count filter setup");
    appendOrExplain(l, governanceRow(), "count filter setup");
    appendOrExplain(l, governanceRow({ entry_id: "promote-2" }), "count filter setup");

    const counted = (l.count as unknown as (f?: Record<string, unknown>) => number)({ kind: "gig" });
    expect(
      counted,
      "count() ignored its filter and returned the raw row count. src/ledger.ts:42 declares " +
        "`count(): number` with no filter, which is why system_health reports every " +
        "governance row as a gig (#216).",
    ).toBe(1);
  });

  it("query({ kind }) partitions the ledger", () => {
    const l = new MemoryLedger();
    appendOrExplain(l, gigRow(), "kind partition setup");
    appendOrExplain(l, mutationRow(), "kind partition setup");
    appendOrExplain(l, governanceRow(), "kind partition setup");

    const q = l.query as unknown as (f: Record<string, unknown>) => Row[];
    expect(q({ kind: "gig" }).length, "query({kind:'gig'}) must return only gig rows").toBe(1);
    expect(q({ kind: "genome_mutation" }).length).toBe(1);
    expect(q({ kind: "governance" }).length).toBe(1);
  });

  it("query({ event }) and query({ subject_slug }) reach governance payloads", () => {
    const l = new MemoryLedger();
    appendOrExplain(l, governanceRow({ entry_id: "p1", event: "agent_promote", subject_slug: "scout" }), "event query setup");
    appendOrExplain(l, governanceRow({ entry_id: "p2", event: "tool_register", subject_slug: "grep_tool" }), "event query setup");

    const q = l.query as unknown as (f: Record<string, unknown>) => Row[];
    expect(
      q({ event: "tool_register" }).length,
      "query({event}) must select by typed event kind. Today the only discriminator is " +
        "standard_slug overloaded with a tool name plus a String.startsWith on gig_id " +
        "(src/server.ts:1153).",
    ).toBe(1);
    expect(
      q({ subject_slug: "scout" }).length,
      "query({subject_slug}) must find the entity an event was about",
    ).toBe(1);
  });

  it("query({ subject_gig_id }) joins a governance row back to its gig", () => {
    const l = new MemoryLedger();
    appendOrExplain(l, gigRow({ entry_id: "G", gig_id: "G" }), "subject_gig_id join setup");
    appendOrExplain(l, governanceRow({ entry_id: "abort-1", event: "gig_abort", subject_slug: "G", subject_gig_id: "G" }), "subject_gig_id join setup");

    const q = l.query as unknown as (f: Record<string, unknown>) => Row[];
    const joined = q({ subject_gig_id: "G" });
    expect(
      joined.length,
      "subject_gig_id must be first-class so an operator asking 'what happened to gig G' " +
        "finds the abort. Today the abort is filed under the synthetic gig_id 'abort:G', " +
        "which exact-equality filtering (src/ledger.ts:80) can never return (#213).",
    ).toBe(1);
    expect(joined[0]!["event"]).toBe("gig_abort");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// v1 read-side upgrade — never rewrite, always mark
// ────────────────────────────────────────────────────────────────────────────
describe("#212 — v1 files upgrade on READ, are never rewritten, and are marked legacy", () => {
  // A v1 line exactly as src/runtime.ts:781 writes one today.
  const V1_GIG = JSON.stringify({
    gig_id: "old-gig",
    standard_slug: "readiness-scan",
    genome_hash: GENOME_HASH,
    run_fingerprint: RUN_FP,
    output_hashes: ["oh1"],
    started_at: "2026-05-25T20:00:00.000Z",
    finished_at: "2026-05-25T20:01:00.000Z",
  });

  // A v1 line exactly as src/server.ts:1104-1112 writes one today.
  const V1_NA = JSON.stringify({
    gig_id: "promote:11111111-2222-3333-4444-555555555555",
    standard_slug: "agent_promote",
    genome_hash: "n/a",
    run_fingerprint: "n/a",
    output_hashes: [],
    started_at: "2026-05-25T20:00:00.000Z",
    finished_at: "2026-05-25T20:00:00.000Z",
  });

  it("a v1 gig line reads back as kind:'gig' with legacy:true", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      writeFileSync(path, V1_GIG + "\n");

      const [row] = new FileLedger(path).query() as unknown as Row[];
      expect(row, "v1 line did not read back at all").toBeDefined();
      expect(
        row!["kind"],
        "a v1 line (no `kind` key) must upgrade to kind:'gig' on read — it has real hashes " +
          "and a real standard_slug",
      ).toBe("gig");
      expect(
        row!["legacy"],
        "an upgraded v1 row MUST carry legacy:true. Without the marker the upgrade launders " +
          "a known gap into apparent completeness — the same class of dishonesty as \"n/a\".",
      ).toBe(true);
      expect(row!["genome_hash"], "real v1 identity must be preserved verbatim").toBe(GENOME_HASH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a v1 "n/a" line upgrades to governance WITHOUT fabricating an identity', () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      writeFileSync(path, V1_NA + "\n");

      const [row] = new FileLedger(path).query() as unknown as Row[];
      expect(row, 'v1 "n/a" line did not read back').toBeDefined();
      expect(
        row!["kind"],
        'a v1 row whose standard_slug is a governance tool name ("agent_promote") must ' +
          "upgrade to kind:'governance'",
      ).toBe("governance");
      expect(row!["legacy"], "upgraded rows must be marked legacy:true").toBe(true);
      expect(
        row!["genome_hash"],
        'the upgrade must NOT carry "n/a" forward — identity is gig-only',
      ).not.toBe("n/a");
      const gh = row!["genome_hash"];
      expect(
        gh === undefined || gh === null,
        `the upgrade must not FABRICATE an identity for a row that never had one; got ${String(gh)}. ` +
          "Inventing a plausible hash would be worse than the gap it papers over.",
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reading a v1 file does not rewrite it (the ledger is append-only)", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      writeFileSync(path, V1_GIG + "\n" + V1_NA + "\n");
      const before = readFileSync(path, "utf-8");

      const l = new FileLedger(path);
      l.query();
      l.query({ kind: "gig" } as never);
      (l.count as unknown as (f?: Record<string, unknown>) => number)();

      expect(
        readFileSync(path, "utf-8"),
        "reading upgraded the file IN PLACE. An append-only ledger must never be rewritten — " +
          "a rewrite is indistinguishable from tampering. The upgrade is a read-side view.",
      ).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // VACUOUS until #212 lands: nothing is ever marked `legacy` today, so `undefined` satisfies
  // this. Kept as a forward-guard against an upgrade that marks every row rather than only the
  // upgraded ones — it becomes load-bearing the moment `legacy` exists. Not coverage today.
  it("a v2 row written after v1 rows is NOT marked legacy (vacuous until #212)", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      writeFileSync(path, V1_GIG + "\n");
      appendFileSync(path, JSON.stringify(gigRow({ entry_id: "new", gig_id: "new" })) + "\n");

      const rows = new FileLedger(path).query() as unknown as Row[];
      expect(rows.length).toBe(2);
      const fresh = rows.find((r) => r["gig_id"] === "new");
      expect(fresh, "the v2 row did not read back").toBeDefined();
      expect(
        fresh!["legacy"],
        "a natively-v2 row must NOT be marked legacy — the marker has to mean something",
      ).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
