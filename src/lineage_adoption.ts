import type { LineageRecordRefOutput } from "./genome_schema.js";

/** Why an approved-looking verdict did NOT ground an institution. Reported rather than thrown,
 *  so a caller can log the refusal beside the gig instead of discovering silence. */
export interface AdoptionRefusal {
  reason: "not-a-pass" | "no-approver" | "no-record-ref";
  detail: string;
}

export interface LineageAdoptionResult {
  /** True only when every condition below held. The caller writes `ref` to institution.lineage[]. */
  adopt: boolean;
  /** Present iff adopt === true. `approved_by` is non-null by construction. */
  ref?: LineageRecordRefOutput;
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

  if (refusals.length > 0) return { adopt: false, refusals };

  const ref: LineageRecordRefOutput = {
    record_ref,
    approved_by: approver,   // non-null by construction — the read half filters on exactly this
    ...(input.question === undefined ? {} : { question: input.question }),
    ...(input.sealed_at === undefined ? {} : { sealed_at: input.sealed_at }),
  } as LineageRecordRefOutput;

  return { adopt: true, ref, refusals: [] };
}
