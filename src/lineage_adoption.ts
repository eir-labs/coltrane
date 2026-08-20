import type { LineageRecordRefOutput } from "./genome_schema.js";

/** Why an approved-looking verdict did NOT ground an institution. Reported rather than thrown,
 *  so a caller can log the refusal beside the gig instead of discovering silence. */
export interface AdoptionRefusal {
  reason: "not-a-pass" | "no-approver" | "no-record-ref" | "no-target";
  detail: string;
}

export interface LineageAdoptionResult {
  /** True only when every condition below held. The caller writes `ref` to institution.lineage[]. */
  adopt: boolean;
  /** Present iff adopt === true. `approved_by` is non-null by construction. */
  ref?: LineageRecordRefOutput;
  /** Present iff adopt === true. WHICH institution the ref is written into — the caller needs
   *  this to persist, and until lineage-adoption-target existed there was no answer to it. */
  institution_slug?: string;
  refusals: readonly AdoptionRefusal[];
}

/** Decide whether a sealed lineage-verdict grounds an institution, and shape the reference it
 *  would write. A PURE COLLECTOR: it does no I/O, reads no store, throws nothing, and mutates
 *  nothing. The caller owns persistence — the store-side home `coltrane_institution_lineage` is
 *  the follow-up `LineageRecordRefSchema` already names.
 *
 *  This is the WRITE half of institutional lineage. The READ half is `agentLineageGrounding`,
 *  which inherits a ref onto a seated agent only when `approved_by` is non-null — so THIS
 *  function is the only thing permitted to set that field. The two halves meet on exactly one
 *  field, and the rules below are what keeps that field honest.
 *
 *  Three refusals, none of them invented here:
 *
 *  - NOT-A-PASS. The lineage-verdict type states that a run reaching the approve office
 *    unapproved PARKS, and that nothing is adopted on an absent yes. A verdict whose `pass` is
 *    anything other than boolean true — false, absent, or a truthy non-boolean — grounds nothing.
 *    Absent is treated as refusal, never as consent.
 *
 *  - NO-APPROVER. "An unattributed approval is not an approval." A verdict that cleared its
 *    checks but names nobody is exactly the loophole wearing the costume of governance.
 *
 *  - NO-RECORD-REF. "A lineage reference that names no record references nothing"
 *    (LineageRecordRefSchema). An adoption pointing at nothing is worse than no adoption,
 *    because it reads as grounding from the outside.
 *
 *  All applicable refusals are collected rather than short-circuited: a verdict that is both
 *  unsigned and pointed at nothing should report both, so a caller fixing one does not
 *  rediscover the other on the next run. */
export function lineageAdoption(input: {
  /** The sealed verdict's data. Read structurally — `pass` lives on the Verdict core type while
   *  the lineage-verdict domain layer carries `approver` and `rationale`, and the two stores
   *  disagree on which fields the domain schema admits. Reading defensively costs nothing. */
  verdict: Record<string, unknown> | null | undefined;
  /** content_sha (or slug) of the lineage-record this adoption would ground the institution in. */
  record_ref: string;
  /** The lineage-question the record answered, carried for display without dereferencing. */
  question?: string;
  /** ISO timestamp of the seal. The caller stamps it; this function invents no clock. */
  sealed_at?: string;
  /** The institution this adoption grounds, from the lineage-adoption-target in the payload.
   *  Absent is a refusal, not a default: an adoption naming no institution grounds nothing, and
   *  guessing one would attach a lineage to a party that never approved it. */
  institution_slug?: string;
}): LineageAdoptionResult {
  const refusals: AdoptionRefusal[] = [];
  const v = input.verdict ?? {};

  if (v["pass"] !== true) {
    refusals.push({
      reason: "not-a-pass",
      detail: `verdict.pass is ${JSON.stringify(v["pass"]) ?? "undefined"}; nothing is adopted on an absent yes`,
    });
  }

  const approver = typeof v["approver"] === "string" ? v["approver"].trim() : "";
  if (approver === "") {
    refusals.push({ reason: "no-approver", detail: "an unattributed approval is not an approval" });
  }

  const record_ref = input.record_ref?.trim() ?? "";
  if (record_ref === "") {
    refusals.push({ reason: "no-record-ref", detail: "a lineage reference that names no record references nothing" });
  }

  const institution_slug = input.institution_slug?.trim() ?? "";
  if (institution_slug === "") {
    refusals.push({ reason: "no-target", detail: "an adoption that names no institution grounds nothing" });
  }

  if (refusals.length > 0) return { adopt: false, refusals };

  const ref: LineageRecordRefOutput = {
    record_ref,
    approved_by: approver,   // non-null by construction — the read half filters on exactly this
    ...(input.question === undefined ? {} : { question: input.question }),
    ...(input.sealed_at === undefined ? {} : { sealed_at: input.sealed_at }),
  } as LineageRecordRefOutput;

  return { adopt: true, ref, institution_slug, refusals: [] };
}

/** Apply an adopted reference to an institution document, returning a NEW document.
 *
 *  The missing middle of the chain. `lineageAdoption` DECIDES and the store-side home
 *  `coltrane_institution_lineage` PERSISTS; nothing turned the one into the other, so a passing
 *  verdict could be correctly judged and still leave `lineage[]` empty. This is that step, and it
 *  is pure for the same reason the decision is: the caller owns the write, whether that write is a
 *  genome file today or a table later.
 *
 *  IDEMPOTENT BY `record_ref`. Re-approving the same record must not append a second reference —
 *  a lineage[] with the same record twice would let one adoption read as two groundings, and the
 *  count is the only thing a reader has to go on. A re-adoption of an already-present record
 *  returns the document UNCHANGED rather than refreshing its approver or timestamp: the first
 *  seal is the one that happened, and overwriting it would quietly rewrite who grounded the
 *  institution and when.
 *
 *  Order is append-only and stable, so a rendered grounding does not reshuffle between loads. */
export function applyLineageAdoption<T extends { lineage?: readonly LineageRecordRefOutput[] }>(
  institution: T,
  ref: LineageRecordRefOutput,
): { institution: T; changed: boolean } {
  const existing = institution.lineage ?? [];
  if (existing.some((r) => r.record_ref === ref.record_ref)) {
    return { institution, changed: false };
  }
  return { institution: { ...institution, lineage: [...existing, ref] }, changed: true };
}
