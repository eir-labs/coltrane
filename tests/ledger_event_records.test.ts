// RED — the ledger's WRITE sites.
//
//   #212 — 7 of 12 append sites write "n/a" identity and drop the event payload entirely
//   #213 — gig_abort hides the abort from its own gig, drops the reason, appends unconditionally
//   #215 — learning_synthesize counts reviews across all agents
//   #216 — system_health reports every governance row as a gig, a dollar, and a unit of budget
//   #218 — genome_writer seals the file BEFORE the ledger append, with no rollback
//
// tests/ledger_schema.test.ts pins the type/validator layer; this file pins what the
// handlers actually record.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry, type DomainType } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger, LedgerError, type Ledger, type LedgerEntry, type LedgerQuery, type LedgerIntegrityReport } from "../src/ledger.js";
import { sealAgentDefinition, sealSkillPackage, sealDefinition } from "../src/genome_writer.js";

type Row = Record<string, unknown>;

const findingType: DomainType = {
  slug: "finding", extends: "Judgment", domain: "eirtests",
  schema: { type: "object", properties: { title: { type: "string" } } },
  required_fields: ["title"],
};

function makeDeps(over: Partial<ServerDeps> = {}): ServerDeps {
  const registry = createRegistry();
  registry.registerType(findingType);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), ...over };
}

function rows(deps: ServerDeps): Row[] {
  return deps.ledger.query({}) as unknown as Row[];
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ledger-events-"));
}

/** A ledger whose append always fails the way FileLedger does on ENOSPC/EACCES
 *  (src/ledger.ts:59-71). MemoryLedger never throws on I/O, which is the only reason
 *  #218 is dormant today. */
class ThrowingLedger implements Ledger {
  public attempts = 0;
  append(_entry: LedgerEntry): void {
    this.attempts++;
    throw new LedgerError("failed to append to ledger at /dev/full: ENOSPC: no space left on device");
  }
  query(_filter?: LedgerQuery): LedgerEntry[] { return []; }
  count(): number { return 0; }
  // #255 put integrity() on the Ledger interface. This double models a ledger whose
  // WRITES fail (ENOSPC); nothing it holds was ever parsed from bytes, so there is no
  // torn line to report and `ok: true` is the honest answer for the surface it models.
  integrity(): LedgerIntegrityReport { return { ok: true, path: "", entries: 0, corrupt: [] }; }
}

// ────────────────────────────────────────────────────────────────────────────
// #212 — every governance write site records a typed event with a real payload
// ────────────────────────────────────────────────────────────────────────────
describe("#212 — governance handlers record a typed event, not a content-free UUID", () => {
  const CASES: Array<{
    tool: string;
    args: Record<string, unknown>;
    event: string;
    subject_slug: string;
    detail_keys: readonly string[];
    site: string;
  }> = [
    {
      tool: "charter_suggest_update",
      args: { field: "goals", current_value: "ship v0", suggested_value: "ship v1", evidence: "3 gigs" },
      event: "charter_suggest_update",
      subject_slug: "goals",
      detail_keys: ["current_value", "suggested_value", "evidence"],
      site: "src/server.ts:640",
    },
    {
      tool: "proposal_create",
      args: { change_type: "agent_retire", target: "analyst", target_kind: "permissions", reason: "superseded" },
      event: "proposal_create",
      subject_slug: "analyst",
      detail_keys: ["change_type", "reason"],
      site: "src/server.ts:812",
    },
    {
      tool: "tool_register",
      args: { slug: "issue212_probe_tool" },
      event: "tool_register",
      subject_slug: "issue212_probe_tool",
      detail_keys: [],
      site: "src/server.ts:914",
    },
    {
      tool: "agent_promote",
      args: { slug: "scout", status: "active", current: "approved" },
      event: "agent_promote",
      subject_slug: "scout",
      detail_keys: ["from_status", "to_status"],
      site: "src/server.ts:1104",
    },
    {
      tool: "standard_promote",
      args: { slug: "readiness-scan", status: "active", current: "draft" },
      event: "standard_promote",
      subject_slug: "readiness-scan",
      detail_keys: ["from_status", "to_status"],
      site: "src/server.ts:1104",
    },
    {
      tool: "skill_promote",
      args: { slug: "diffing", status: "testing", current: "draft" },
      event: "skill_promote",
      subject_slug: "diffing",
      detail_keys: ["from_status", "to_status"],
      site: "src/server.ts:1104",
    },
    {
      tool: "session_review_write",
      args: { gig_id: "gig-77", output_id: "out-77", agent_slug: "summarizer", quality_scores: { accuracy: 90 } },
      event: "session_review_write",
      subject_slug: "summarizer",
      detail_keys: ["output_id", "quality_scores"],
      site: "src/server.ts:1130",
    },
  ];

  it.each(CASES)("$tool records kind:governance with no \"n/a\"", async ({ tool, args, site }) => {
    const deps = makeDeps();
    const res = await dispatchTool(tool, args, deps);
    expect(res.ok, `${tool} failed: ${res.error}`).toBe(true);

    const appended = rows(deps);
    expect(appended.length, `${tool} appended ${appended.length} rows, expected 1`).toBe(1);
    const row = appended[0]!;

    expect(
      row["kind"],
      `${site} writes a row shaped like a completed gig. The event kind is smuggled into ` +
        "standard_slug and the event class into a ':'-prefix on gig_id.",
    ).toBe("governance");

    // Assert the fields are ABSENT, not merely that the string "n/a" is gone. Checking only
    // the sentinel would pass against an implementation that writes a real 64-hex value into a
    // governance row's genome_hash — which is still wrong (identity is gig-only) and would
    // additionally defeat any `count()` filter that discriminates on identity presence.
    // Field-level assertions also avoid a false positive from a `detail` payload that happens
    // to contain the substring "n/a" (e.g. a path or a free-text reason).
    for (const forbidden of ["genome_hash", "run_fingerprint"]) {
      expect(
        forbidden in row,
        `${site}: a governance row carried "${forbidden}". Today it is literally "n/a" — but ` +
          "the fix is to make the field UNREPRESENTABLE on a non-gig row, not to put a " +
          "plausible-looking hash there instead.",
      ).toBe(false);
    }
  });

  it.each(CASES)("$tool records the typed event + subject", async ({ tool, args, event, subject_slug, site }) => {
    const deps = makeDeps();
    const res = await dispatchTool(tool, args, deps);
    expect(res.ok, `${tool} failed: ${res.error}`).toBe(true);
    const row = rows(deps)[0]!;

    expect(row["event"], `${site}: the event kind must be a typed field`).toBe(event);
    expect(
      row["subject_slug"],
      `${site} records nothing about WHICH entity the event was about. For promotions, ` +
        "standard_slug holds the TOOL name (agent_promote), not the promoted entity. For " +
        "tool_register the registered slug is dropped entirely — and that is the capability " +
        "gate governing whether agent_define may grant a slug (src/server.ts:876-884), so the " +
        "audit trail cannot answer 'who granted this capability, and when'.",
    ).toBe(subject_slug);
  });

  it.each(CASES.filter((c) => c.detail_keys.length > 0))(
    "$tool preserves its payload in `detail`",
    async ({ tool, args, detail_keys, site }) => {
      const deps = makeDeps();
      const res = await dispatchTool(tool, args, deps);
      expect(res.ok, `${tool} failed: ${res.error}`).toBe(true);
      const detail = rows(deps)[0]!["detail"] as Row | undefined;

      expect(
        detail,
        `${site} records no payload at all — fixing only the identity fields would still ` +
          "leave a durable trail of content-free UUIDs",
      ).toBeDefined();
      for (const k of detail_keys) {
        expect(
          Object.prototype.hasOwnProperty.call(detail!, k),
          `${tool} dropped "${k}". session_review_write is the sharpest case: agent_slug, ` +
            "output_id and quality_scores are all validated at src/server.ts:1126 and then " +
            "thrown away because LedgerEntry has nowhere to put them.",
        ).toBe(true);
      }
    },
  );

  it("session_review_write's agent_slug reaches the row (root cause of #215)", async () => {
    const deps = makeDeps();
    await dispatchTool(
      "session_review_write",
      { gig_id: "gig-1", output_id: "out-1", agent_slug: "summarizer", quality_scores: { accuracy: 90 } },
      deps,
    );
    const row = rows(deps)[0]!;
    expect(
      row["subject_slug"] ?? (row["detail"] as Row | undefined)?.["agent_slug"],
      "the reviewed agent must be recoverable from the row — otherwise learning_synthesize " +
        "cannot filter by agent, which is exactly bug #215",
    ).toBe("summarizer");
  });

  it("session_review_write joins back to the gig it reviewed", async () => {
    const deps = makeDeps();
    await dispatchTool(
      "session_review_write",
      { gig_id: "gig-42", output_id: "out-1", agent_slug: "summarizer", quality_scores: { accuracy: 90 } },
      deps,
    );
    expect(
      rows(deps)[0]!["subject_gig_id"],
      "a review of gig-42 is unreachable from gig-42's own history today: the row's gig_id is " +
        "the synthetic `review:<uuid>` (src/server.ts:1131) and the reviewed gig_id is dropped",
    ).toBe("gig-42");
  });
});


// ────────────────────────────────────────────────────────────────────────────
// #212 — the genome-mutation write sites
//
// These four seal helpers (src/genome_writer.ts:74, :96, :127, :170) already write a REAL
// effective_hash — they are the precedent the governance fix should copy, not instances to
// fix. What is still wrong is the SHAPE: they emit a gig-shaped row with the mutation kind
// smuggled into standard_slug, the subject into a ':'-prefix on gig_id, and the effective
// hash copied into BOTH genome_hash and run_fingerprint (an effective hash is not a run
// fingerprint). Under the settled schema they are kind:"genome_mutation" rows carrying
// effective_hash + content_hash and no gig identity at all.
//
// All six mutation tools are covered so no seal path can be fixed by omission —
// sealDefinition (type_register, standard_compose) and recordIdentity (type_extend,
// agent_evolve) are as load-bearing as the two that write agent/skill files.
// ────────────────────────────────────────────────────────────────────────────
describe("#212 — genome-mutation handlers record kind:genome_mutation", () => {
  const MUT_AGENT = {
    slug: "mut-scout", primitives: ["SENSE"], input_types: [], output_types: ["probe-note"],
    domain: "eirtests", identity: "you scan", method: "observe", constraints: [],
    behavioral_primitives: ["explorer", "analyst"],
  };

  const MUTATIONS: Array<{ tool: string; args: Record<string, unknown>; subject: string; seal: string }> = [
    {
      tool: "type_register",
      args: { slug: "mut-type", extends: "Plan", domain: "mutation-probe", schema: { type: "object", properties: { step: { type: "string" } } }, required_fields: ["step"] },
      subject: "mut-type",
      seal: "sealDefinition — src/genome_writer.ts:74",
    },
    {
      tool: "standard_compose",
      args: { slug: "mut-std", domain: "eirtests", agents: [MUT_AGENT], phases: [{ name: "p1", chairs: [{ role: "r", agent_slug: "mut-scout", depends_on: [], input_contract: [], output_contract: ["probe-note"], required_skills: [] }] }] },
      subject: "mut-std",
      seal: "sealDefinition — src/genome_writer.ts:74",
    },
    {
      tool: "agent_define",
      args: MUT_AGENT,
      subject: "mut-scout",
      seal: "sealAgentDefinition — src/genome_writer.ts:127",
    },
    {
      tool: "skill_define",
      args: { slug: "mut-skill", domain: "eirtests", code: "export default () => ({ok:true});", fixtures: [{ input: {}, output: { ok: true } }] },
      subject: "mut-skill",
      seal: "sealSkillPackage — src/genome_writer.ts:170",
    },
    {
      tool: "type_extend",
      args: { slug: "finding", domain: "eirtests", fields_to_add: { extra: { type: "string" } } },
      subject: "finding@v2",
      seal: "recordIdentity — src/genome_writer.ts:96",
    },
    {
      tool: "agent_evolve",
      args: {
        base: { ...MUT_AGENT, version: 1, status: "active" },
        next: { ...MUT_AGENT, version: 1, status: "active", identity: "you scan harder" },
        new_version: 2,
      },
      subject: "mut-scout@v2",
      seal: "recordIdentity — src/genome_writer.ts:96",
    },
  ];

  it.each(MUTATIONS)("$tool records kind:genome_mutation with a typed event + subject", async ({ tool, args, subject, seal }) => {
    const dir = freshDir();
    try {
      const deps = makeDeps({ genome_dir: dir });
      const res = await dispatchTool(tool, args, deps);
      expect(res.ok, `${tool} failed: ${res.error}`).toBe(true);

      const appended = rows(deps);
      expect(appended.length, `${tool} appended ${appended.length} rows, expected 1`).toBe(1);
      const row = appended[0]!;

      expect(
        row["kind"],
        `${seal} writes a gig-shaped row; the mutation kind lives in standard_slug and the ` +
          "subject in a ':'-prefix on gig_id",
      ).toBe("genome_mutation");
      expect(row["event"], `${seal}: the mutation kind must be a typed field`).toBe(tool);
      expect(
        row["subject_slug"],
        `${seal}: which definition was sealed must be a field, not a substring of a synthetic gig_id`,
      ).toBe(subject);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(MUTATIONS)("$tool records effective_hash, not gig identity", async ({ tool, args, seal }) => {
    const dir = freshDir();
    try {
      const deps = makeDeps({ genome_dir: dir });
      const res = await dispatchTool(tool, args, deps);
      expect(res.ok, `${tool} failed: ${res.error}`).toBe(true);
      const row = rows(deps)[0]!;

      expect(
        String(row["effective_hash"] ?? ""),
        `${seal}: the identity must live in effective_hash`,
      ).toMatch(/^[0-9a-f]{64}$/);
      expect(
        "run_fingerprint" in row,
        `${seal} copies the effective hash into run_fingerprint too. A definition is not a run; ` +
          "run_fingerprint is f(genome_hash, model_version, canonical_form_version, eval_scores, " +
          "output_hashes) (src/canonical_form.ts:93) and none of those exist for a seal.",
      ).toBe(false);
      expect(
        "genome_hash" in row,
        `${seal}: genome_hash is gig-only. Keeping it here is what makes ` +
          "query({genome_hash}) match gig rows and mutation rows with one filter though the " +
          "two values mean different things.",
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #213 — gig_abort
// ────────────────────────────────────────────────────────────────────────────
describe("#213 — gig_abort", () => {
  /** Deps holding a gig that already sealed, so abort resolves to already_complete. */
  function depsWithSealedGig(gid: string): ServerDeps {
    const deps = makeDeps();
    deps.ledger.append({
      kind: "gig", schema_version: 2, entry_id: gid, gig_id: gid,
      standard_slug: "readiness-scan",
      genome_hash: "a".repeat(64), run_fingerprint: "b".repeat(64),
      output_hashes: ["oh1"],
      started_at: "2026-05-25T20:00:00.000Z", finished_at: "2026-05-25T20:01:00.000Z",
    } as unknown as LedgerEntry);
    return deps;
  }

  it("the abort is discoverable from the gig it aborted", async () => {
    const deps = depsWithSealedGig("real-gig");
    await dispatchTool("gig_abort", { gig_id: "real-gig", reason: "budget" }, deps);

    const joined = deps.ledger.query({ subject_gig_id: "real-gig" } as never) as unknown as Row[];
    expect(
      joined.length,
      "the abort row is filed under the synthetic gig_id `abort:real-gig` (src/server.ts:848). " +
        "execution_history_read filters on exact equality (src/ledger.ts:80), so an operator " +
        "asking 'what happened to gig real-gig' gets no record that an abort was ever " +
        "attempted. The synthetic namespace HIDES the event from the only query that would " +
        "look for it.",
    ).toBe(1);
    expect(joined[0]!["event"]).toBe("gig_abort");
  });

  it("the abort reason is recorded", async () => {
    const deps = depsWithSealedGig("real-gig");
    await dispatchTool("gig_abort", { gig_id: "real-gig", reason: "over budget at phase 3" }, deps);

    const abortRow = (rows(deps) as Row[]).find((r) => r["event"] === "gig_abort" || String(r["gig_id"]).startsWith("abort:"));
    expect(abortRow, "no abort row was appended at all").toBeDefined();
    expect(
      JSON.stringify(abortRow),
      "args['reason'] is read at src/server.ts:856 for the RESPONSE only and never reaches " +
        "the ledger. The append-only record of a cancellation carries no cause.",
    ).toContain("over budget at phase 3");
  });

  it("DOES append when there is a live gig to abort", async () => {
    // The only path where an abort actually aborts something: outputs exist, no seal yet.
    // Without this, an over-correcting "never append on gig_abort" fix greens both negatives
    // below and deletes the cancellation record entirely.
    const deps = makeDeps();
    const w = await dispatchTool("output_write", {
      core_type: "Judgment", domain_type: "finding", domain: "eirtests",
      // finding is Judgment-cored: it names the criteria it evaluated against (#227 ruling).
      gig_id: "live-gig", agent_slug: "a", data: { title: "x", criteria: ["image accessibility"] },
    }, deps);
    expect(w.ok, `output_write failed: ${w.error}`).toBe(true);

    const before = deps.ledger.count();
    const res = await dispatchTool("gig_abort", { gig_id: "live-gig", reason: "operator cancel" }, deps);
    expect((res.data as { status: string }).status, "sanity: this is the running path").toBe("running");
    expect(
      deps.ledger.count() - before,
      "aborting a LIVE gig must leave a record — the cancellation is the audit event",
    ).toBe(1);

    const row = rows(deps)[0]!;
    expect(row["kind"], "the abort record must be a governance row").toBe("governance");
    expect(row["event"]).toBe("gig_abort");
    expect(
      row["subject_gig_id"],
      "the abort must name the gig it aborted, so gig live-gig's own history shows it",
    ).toBe("live-gig");
    expect(
      (row["detail"] as Row | undefined)?.["reason"],
      "the cancellation cause must be recorded",
    ).toBe("operator cancel");
  });

  it("does NOT append when the gig does not exist", async () => {
    const deps = makeDeps();
    const before = deps.ledger.count();
    const res = await dispatchTool("gig_abort", { gig_id: "ghost", reason: "typo" }, deps);

    expect((res.data as { status: string }).status, "sanity: this is the not_found path").toBe("not_found");
    expect(
      deps.ledger.count() - before,
      "status is computed at src/server.ts:846 and then :847 appends REGARDLESS — including " +
        "on not_found. A permanent, immutable row claims an abort event for a gig that never " +
        "existed.",
    ).toBe(0);
  });

  it("does NOT append when gig_id is missing entirely", async () => {
    const deps = makeDeps();
    const before = deps.ledger.count();
    await dispatchTool("gig_abort", {}, deps);
    expect(
      deps.ledger.count() - before,
      "gig_abort({}) yields gid === \"\" → a row with gig_id `abort:` that passes the " +
        "`!entry.gig_id` guard. Any client can pump content-free rows into an append-only " +
        "store with no compaction and no retention.",
    ).toBe(0);
  });

  // The correct pattern already present in the file: session_review_write validates first.
  it("charter_suggest_update does not append on invalid input", async () => {
    const deps = makeDeps();
    const before = deps.ledger.count();
    await dispatchTool("charter_suggest_update", {}, deps);
    expect(
      deps.ledger.count() - before,
      "src/server.ts:640 appends before/without argument validation — same shape as #213's " +
        "third problem. src/server.ts:1126-1130 (session_review_write) is the correct pattern " +
        "already in the file.",
    ).toBe(0);
  });

  it("proposal_create does not append on invalid input", async () => {
    const deps = makeDeps();
    const before = deps.ledger.count();
    await dispatchTool("proposal_create", {}, deps);
    expect(
      deps.ledger.count() - before,
      "src/server.ts:812 appends before validating change_type/target",
    ).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #215 — learning_synthesize
// ────────────────────────────────────────────────────────────────────────────
describe("#215 — learning_synthesize scopes evidence to one agent", () => {
  async function seedReviews(deps: ServerDeps, agent: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const r = await dispatchTool("session_review_write", {
        gig_id: `gig-${agent}-${i}`, output_id: `out-${i}`, agent_slug: agent,
        quality_scores: { accuracy: 80 + i },
      }, deps);
      expect(r.ok, `seed review failed: ${r.error}`).toBe(true);
    }
  }

  it("reviews of agent A do not count as evidence for agent B", async () => {
    const deps = makeDeps();
    await seedReviews(deps, "agent-a", 5);

    const res = await dispatchTool("learning_synthesize", { agent_slug: "agent-b", min_reviews: 5 }, deps);
    expect(res.ok).toBe(true);
    const d = res.data as { review_count: number; evidence_sufficient: boolean };

    expect(
      d.review_count,
      "agent_slug is validated at src/server.ts:1147 and then only ECHOED BACK at :1172 — it " +
        "never filters anything. src/server.ts:1152 queries every session_review_write row in " +
        "the ledger regardless of which agent it was about.",
    ).toBe(0);
    expect(
      d.evidence_sufficient,
      "the evolution gate opened for an agent with zero reviews, on evidence about a " +
        "different agent",
    ).toBe(false);
  });

  it("does not mint an evolution proposal on another agent's evidence", async () => {
    const deps = makeDeps();
    await seedReviews(deps, "agent-a", 5);

    const res = await dispatchTool(
      "learning_synthesize",
      { agent_slug: "agent-b", min_reviews: 5, auto_propose: true },
      deps,
    );
    expect(
      (res.data as { proposal_id: string | null }).proposal_id,
      "with auto_propose:true the cross-agent count mints a real evolution proposal " +
        "(src/server.ts:1157-1168) for an agent nobody reviewed. This is a governance-integrity " +
        "bug, not a reporting one.",
    ).toBeNull();
  });

  it("still counts the agent's OWN reviews (the fix must not over-filter)", async () => {
    const deps = makeDeps();
    await seedReviews(deps, "agent-a", 5);
    await seedReviews(deps, "agent-b", 2);

    const a = await dispatchTool("learning_synthesize", { agent_slug: "agent-a", min_reviews: 5 }, deps);
    expect((a.data as { review_count: number }).review_count, "agent-a's own 5 reviews must count").toBe(5);
    expect((a.data as { evidence_sufficient: boolean }).evidence_sufficient).toBe(true);

    const b = await dispatchTool("learning_synthesize", { agent_slug: "agent-b", min_reviews: 5 }, deps);
    expect((b.data as { review_count: number }).review_count, "agent-b has exactly 2").toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #216 — system_health
// ────────────────────────────────────────────────────────────────────────────
describe("#216 — system_health counts gigs, not rows", () => {
  // Seeds BOTH governance rows (which write "n/a" identity today) AND a genome-mutation seal
  // (which writes a REAL 64-hex effective_hash — src/genome_writer.ts:127-135).
  //
  // The mutation seal is what makes this suite honest. Without it, all three tests below go
  // green under a one-line sentinel filter:
  //     deps.ledger.query({}).filter((e) => e.genome_hash !== "n/a").length
  // …which is wrong twice over: every agent_define/standard_compose/type_register/skill_define
  // seal carries a real hash and would still be counted as a gig, a dollar and a unit of
  // budget; and under the target schema a governance row has no genome_hash at all, so
  // `undefined !== "n/a"` counts it right back in. Only a real `kind` discriminator passes.
  async function seedNonGigRows(deps: ServerDeps): Promise<void> {
    const g1 = await dispatchTool("agent_promote", { slug: "scout", status: "active" }, deps);
    expect(g1.ok, `agent_promote failed: ${g1.error}`).toBe(true);
    const g2 = await dispatchTool("proposal_create", { change_type: "agent_retire", target: "analyst", target_kind: "method", reason: "x" }, deps);
    expect(g2.ok, `proposal_create failed: ${g2.error}`).toBe(true);
    const g3 = await dispatchTool("session_review_write", { gig_id: "g", output_id: "o", agent_slug: "a", quality_scores: { q: 1 } }, deps);
    expect(g3.ok, `session_review_write failed: ${g3.error}`).toBe(true);

    // The genome-mutation seal — a real hash, not the "n/a" sentinel.
    const m = await dispatchTool("agent_define", {
      slug: "health-scout", primitives: ["SENSE"], input_types: [], output_types: ["probe-note"],
      domain: "eirtests", identity: "you scan", method: "observe", constraints: [],
      behavioral_primitives: ["explorer", "analyst"],
    }, deps);
    expect(m.ok, `agent_define failed: ${m.error}`).toBe(true);
    const seal = rows(deps).find((r) => String(r["gig_id"] ?? "").startsWith("define:")
      || r["event"] === "agent_define");
    expect(seal, "sanity: the agent_define seal must be in the ledger").toBeDefined();
    expect(
      String(seal!["genome_hash"] ?? seal!["effective_hash"] ?? ""),
      "sanity: the mutation seal carries a REAL 64-hex identity — this is what defeats a " +
        'filter keyed on the "n/a" sentinel',
    ).toMatch(/^[0-9a-f]{64}$/);
  }

  it("non-gig rows do not inflate gigs_run", async () => {
    const dir = freshDir();
    try {
      const deps = makeDeps({ genome_dir: dir });
      await seedNonGigRows(deps);

      const res = await dispatchTool("system_health", {}, deps);
      expect(res.ok).toBe(true);
      expect(
        (res.data as { gigs_run: number }).gigs_run,
        "src/server.ts:661 is `deps.ledger.count()` — raw ROWS. A session that runs zero gigs " +
          "but promotes an agent, files a proposal, writes a review and defines an agent " +
          "reports gigs_run: 4.",
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-gig rows do not inflate cost or budget.spent", async () => {
    const dir = freshDir();
    try {
      const deps = makeDeps({ genome_dir: dir });
      await seedNonGigRows(deps);

      const res = await dispatchTool("system_health", {}, deps);
      const d = res.data as { cost: number; budget: { spent: number } };
      expect(
        d.cost,
        "src/server.ts:672 derives cost from the same row count. With `usage` now carrying real " +
          "settled spend (src/ledger.ts:24-28), this proxy is both wrong and unnecessary.",
      ).toBe(0);
      expect(d.budget.spent, "src/server.ts:674 — budget.spent from the same row count").toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The #216 fix redefined `cost`/`budget.spent` from a ledger ROW COUNT to real settled
  // spend. That is squarely what the issue asked for ("with `usage` now carrying real settled
  // spend, this proxy is both wrong and unnecessary") — but it changes what those fields MEAN
  // to every consumer, and nothing pinned the new meaning. Without this, a later refactor
  // could quietly revert `cost` to a count and every existing assertion would still pass.
  it("cost and budget.spent report settled spend, not a row count", async () => {
    const dir = freshDir();
    try {
      const deps = makeDeps({ genome_dir: dir });
      const gig = (id: string, usage?: Record<string, unknown>) => ({
        kind: "gig", schema_version: 2, entry_id: id, gig_id: id, standard_slug: "readiness-scan",
        genome_hash: "a".repeat(64), run_fingerprint: "b".repeat(64), output_hashes: ["oh1"],
        started_at: "2026-05-25T20:00:00.000Z", finished_at: "2026-05-25T20:01:00.000Z",
        ...(usage ? { usage } : {}),
      }) as unknown as LedgerEntry;

      deps.ledger.append(gig("paid", {
        input_tokens: 100, output_tokens: 50, total_cost_usd: 1.25,
        by_model: { "claude-opus-4-7": { input_tokens: 100, output_tokens: 50, cost_usd: 1.25 } },
      }));
      deps.ledger.append(gig("free")); // skill-only gig — no model invocation, no usage

      const res = await dispatchTool("system_health", {}, deps);
      const d = res.data as { gigs_run: number; cost: number; budget: { spent: number } };
      expect(d.gigs_run, "both rows are gigs").toBe(2);
      expect(
        d.cost,
        "cost must be the SUM of settled usage.total_cost_usd (1.25 + absent), not the number " +
          "of gig rows (which would be 2). A field labelled in dollars that returns a count is " +
          "the lie #216 set out to remove.",
      ).toBe(1.25);
      expect(d.budget.spent, "budget.spent must track the same settled figure").toBe(1.25);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a real gig row DOES count (the fix must not zero everything out)", async () => {
    const dir = freshDir();
    try {
      const deps = makeDeps({ genome_dir: dir });
      await seedNonGigRows(deps);
      deps.ledger.append({
        kind: "gig", schema_version: 2, entry_id: "G", gig_id: "G", standard_slug: "readiness-scan",
        genome_hash: "a".repeat(64), run_fingerprint: "b".repeat(64), output_hashes: ["oh1"],
        started_at: "2026-05-25T20:00:00.000Z", finished_at: "2026-05-25T20:01:00.000Z",
      } as unknown as LedgerEntry);

      const res = await dispatchTool("system_health", {}, deps);
      expect(
        (res.data as { gigs_run: number }).gigs_run,
        "exactly one gig ran — the filter must select gig rows, not merely exclude the \"n/a\" " +
          "sentinel (which would still count the agent_define seed's real hash as a gig)",
      ).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #218 — seal ordering: a failed append must not leave an orphan
// ────────────────────────────────────────────────────────────────────────────
describe("#218 — a failed ledger append never leaves an orphaned genome file", () => {
  const agentDef = {
    slug: "orphan-probe",
    primitives: ["SENSE"] as const,
    output_types: ["raw-note"],
    domain: "test-218",
    identity: "you scan for signal",
    method: "observe and record one raw note",
    constraints: [],
    behavioral_primitives: ["explorer", "analyst"] as const,
  };

  it("sealAgentDefinition leaves no agents/<slug>.json when the append fails", () => {
    const dir = freshDir();
    try {
      const ledger = new ThrowingLedger();
      expect(
        () => sealAgentDefinition(agentDef as never, ledger, dir),
        "sanity: the seal must surface the ledger failure",
      ).toThrow();
      expect(ledger.attempts, "sanity: the append was actually attempted").toBe(1);

      expect(
        existsSync(join(dir, "agents", "orphan-probe.json")),
        "src/genome_writer.ts:125 writes the file, then :127 appends. On append failure the " +
          "definition is on disk and loadable by loadGenome with NO identity — precisely the " +
          "orphan the module header (:1-6) declares 'outside the substrate'. Either roll the " +
          "file back or append first; both satisfy this assertion.",
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // sealDefinition is the third file-writing seal path (src/genome_writer.ts:60) and backs
  // type_register + standard_compose — 2 of the 6 mutation tools. Covering only the agent and
  // skill helpers would let the fix be applied by omission here.
  it.each([
    ["type_register", "domain_types", "orphan-type"],
    ["standard_compose", "standards", "orphan-standard"],
  ])("sealDefinition(%s) leaves no %s/<slug>.json when the append fails", (kind, subdir, slug) => {
    const dir = freshDir();
    try {
      const ledger = new ThrowingLedger();
      expect(
        () => sealDefinition(kind, slug, { slug, domain: "test-218" }, ledger, dir, subdir),
        "sanity: the seal must surface the ledger failure",
      ).toThrow();
      expect(ledger.attempts, "sanity: the append was actually attempted").toBe(1);

      expect(
        existsSync(join(dir, subdir, `${slug}.json`)),
        "src/genome_writer.ts:72 writes the file, then :74 appends. On append failure the " +
          `definition sits in ${subdir}/ with no identity — an orphan by the module header's ` +
          "own definition (:1-6). Either roll the file back or append first.",
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sealSkillPackage leaves no partial package when the append fails", () => {
    const dir = freshDir();
    try {
      const ledger = new ThrowingLedger();
      const def = {
        slug: "orphan-skill",
        domain: "test-218",
        code: "export default () => ({ ok: true });",
        fixtures: [{ input: {}, output: { ok: true } }],
      };
      expect(() => sealSkillPackage(def as never, ledger, dir), "sanity: seal must throw").toThrow();

      const pkg = join(dir, "skills", "orphan-skill");
      const contents = existsSync(pkg) ? readdirSync(pkg) : [];
      expect(
        contents,
        "src/genome_writer.ts:155-178 writes meta.json, skill.mjs, skill.md and every fixture " +
          `BEFORE appending, so a failure leaves a partial package plus no identity. Found: ${contents.join(", ")}`,
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatchTool distinguishes 'the work failed' from 'recording the work failed'", async () => {
    const dir = freshDir();
    try {
      const deps = makeDeps({ ledger: new ThrowingLedger(), genome_dir: dir });
      const res = await dispatchTool("agent_define", agentDef, deps);

      expect(
        (res as unknown as Record<string, unknown>)["audit_write_failed"],
        "src/server.ts:1181-1183 collapses a LedgerError into a generic {ok:false, error} so " +
          "the caller believes NOTHING happened — while the genome file may have been " +
          "overwritten. A retry then produces a second history snapshot " +
          "(writeGenomeFileVersioned) and a duplicate seal.",
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tool_register does not grant the capability when its audit row fails to land", async () => {
    const probe = "issue218_phantom_tool";
    const failing = makeDeps({ ledger: new ThrowingLedger() });
    const reg = await dispatchTool("tool_register", { slug: probe }, failing);
    expect(reg.ok, "sanity: the caller is told the registration failed").toBe(false);

    // The capability gate is process-global (REGISTERED_TOOL_SLUGS, src/server.ts:123), so a
    // fresh deps still sees whatever the failed call left behind.
    const clean = makeDeps({ genome_dir: undefined });
    const define = await dispatchTool("agent_define", {
      slug: "issue218-grantee", primitives: ["SENSE"], output_types: ["raw-note"],
      domain: "test-218", identity: "i", method: "m", constraints: [],
      behavioral_primitives: ["explorer", "analyst"], allowed_tools: [probe],
    }, clean);

    expect(
      define.ok,
      "src/server.ts:909-912 mutates REGISTERED_TOOL_SLUGS and toolProviders BEFORE appending " +
        "at :914. On append failure the tool is registered and grantable, the caller is told " +
        "the call failed, and no audit row exists — the divergence-between-reality-and-record " +
        "failure mode.",
    ).toBe(false);
    expect(String(define.error)).toMatch(/unknown\/unregistered/);
  });
});
