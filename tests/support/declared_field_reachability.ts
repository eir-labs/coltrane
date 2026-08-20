/** RED-FIRST STUB — NOT THE LAW, NOT SEALED. Scaffolding so tests/declared_fields_are_read.test.ts
 *  type-checks and its assertions run and FAIL for the right reason (the analysis does not exist
 *  yet). The builder REPLACES this whole module with the real fs+regex engine — extract field names
 *  from domain_types/*.json + core_types/*.json `schema.properties` and every Zod `.object({…})`
 *  key in src/genome_schema.ts; mark a name (>= 5 chars) READ iff `\bname\b` occurs anywhere in the
 *  concatenated top-level src/*.ts; report the rest BY NAME; compute the true count, hand-verify a
 *  sample HERE, and set PINNED_UNREAD_FIELDS to it. Fail safe toward READ (see the law's header).
 *
 *  This file is scaffolding under tests/support/ (NOT a *.test.ts, so vitest does not collect it as
 *  a suite; NOT under src/, so its text never enters the reader corpus and cannot mask a dead field).
 *  With these sentinel returns the sealed law is RED: the non-vacuity guard fails (totalFields 0),
 *  calibration+ fails (`tests_added` absent from an empty set), and the blind-spot doc test fails
 *  (methodNote empty). Those failures ARE the spec — the enforcement is unbuilt. */

export interface FieldReachabilityReport {
  /** Declared field names (>= 5 chars) with zero `\bname\b` reads in src/*.ts, sorted. */
  unread: string[];
  /** Distinct declared field names swept across the three namespaces. */
  totalFields: number;
  /** Method + blind spots, carried with the analysis so they cannot be silently stripped. */
  methodNote: string;
}

export function analyzeDeclaredFieldReachability(): FieldReachabilityReport {
  // STUB: no extraction, no cross-reference. Replace with the real engine.
  return { unread: [], totalFields: 0, methodNote: "" };
}

/** STUB pin. The builder sets this to the true, hand-verified count (may only decrease). */
export const PINNED_UNREAD_FIELDS = 0;
