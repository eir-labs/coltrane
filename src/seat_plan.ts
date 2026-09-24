// SEAT PLAN — who will actually play, and how much each one has to read, computed before anything
// is spent.
//
// A chair is not a seat. A chair with `fan_out` is a TEMPLATE that becomes N seats at run time, and
// until now nothing said so before the run: `standard_simulate` received each phase as a chair
// COUNT, so a run that seats 22 players was indistinguishable from one that seats 1 — and was
// priced as one.
//
// The plan is computed with the engine's OWN `expandFanOut`, against the dispatch payload, so it
// cannot drift from what the run will do. A split the engine would refuse is REPORTED here, in a
// successful answer, rather than thrown: a pre-flight tells you.
//
// The bytes are the point. A seat is handed the narrowed VIEW of each record — `fan_out` narrows
// the path it splits and leaves every other field of that record whole, and the invoker renders the
// whole `data` into the prompt. So a seat can be handed half a megabyte to read one provision, and
// the only honest way to see it coming is to measure the view it will receive and name the biggest
// field in it. (Measured by eir-drafting, 2026-09-24: 490,779 characters handed to a seat whose own
// item was 48,849, with 434,225 in two sibling arrays.)
import { expandFanOut, FanOutRefused } from "./fan_out.js";
import { canonJson } from "./canonical_form.js";
import type { Chair, Standard } from "./composition.js";
import type { OutputRecord } from "./outputs.js";

export interface PlannedInput {
  type: string;
  /** The record id this view is of, or "gig_input" for a payload-sourced set. */
  source: string;
  bytes: number;
  /** The single biggest field inside this view's `data`, which is usually the whole story. */
  largest_field?: { path: string; bytes: number };
}

export interface PlannedSeat {
  role: string;
  /** Everything this seat would be handed: its inputs plus the gig payload it sees. */
  input_bytes: number;
  inputs: PlannedInput[];
}

export interface PlannedChair {
  role: string;
  agent_slug?: string;
  skill_slug?: string;
  /** True when this chair is a fan-out TEMPLATE rather than a seat in its own right.
   *  NOT named `template`: tests/declared_fields_are_read sweeps src/ for whole words, so a field
   *  called `template` here would make `project-charter.template` look read by a file that has
   *  nothing to do with it, and the ratchet would drop by one for a reading that never happened. */
  is_template: boolean;
  seat_count: number;
  seats?: PlannedSeat[];
  /** Why there is no seat list: the refusal the split would raise, stated not guessed. */
  refusal?: string;
}

export interface SeatPlan {
  phases: { name: string; chairs: PlannedChair[] }[];
  /** Total seats the run would dispatch — what the estimate should price. */
  seat_count: number;
  /** True when at least one chair's seats could not be planned (no payload, or a refusal). */
  incomplete: boolean;
}

const bytesOf = (v: unknown): number => canonJson(v).length;

/** The deepest OBJECT depth a path is followed to. A field is actionable; a path of six is noise. */
const MAX_FIELD_DEPTH = 3;

/**
 * The biggest field of a record's data, followed DOWN while it is still a plain object.
 *
 * Naming the top level alone is a tautology for a whole class of record: a skill seals `{data: {…}}`,
 * so the biggest top-level field of every such record is `data`, whatever is actually wrong with it.
 * (Measured by eir-drafting: `largest_field: data (41,297)` on a 51,659-byte seat, where the answer
 * they needed was `data.expanded (20,007)` — 63 provisions the seat cannot use.)
 *
 * The descent stops at an ARRAY on purpose. `expanded.0` is an index, not a field: a caller cannot
 * carry or drop it, and the array itself is the thing they would act on.
 */
function largestField(data: unknown, depth = MAX_FIELD_DEPTH): { path: string; bytes: number } | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  let best: { path: string; bytes: number } | undefined;
  let bestValue: unknown;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const b = bytesOf(v);
    if (!best || b > best.bytes) { best = { path: k, bytes: b }; bestValue = v; }
  }
  if (!best || depth <= 1) return best;
  const deeper = largestField(bestValue, depth - 1);
  return deeper ? { path: `${best.path}.${deeper.path}`, bytes: deeper.bytes } : best;
}

function seatOf(role: string, records: readonly OutputRecord[], payload: Record<string, unknown>): PlannedSeat {
  const inputs: PlannedInput[] = records.map((r) => {
    const lf = largestField(r.data);
    return { type: r.domain_type, source: r.id, bytes: bytesOf(r.data), ...(lf ? { largest_field: lf } : {}) };
  });
  for (const [type, value] of Object.entries(payload)) {
    const lf = largestField(value);
    inputs.push({ type, source: "gig_input", bytes: bytesOf(value), ...(lf ? { largest_field: lf } : {}) });
  }
  return { role, input_bytes: inputs.reduce((n, i) => n + i.bytes, 0), inputs };
}

/**
 * Plan every chair of a standard against a dispatch payload. `records` are the sealed records the
 * payload resolved to (empty when simulating from a raw payload); `satisfies` is the engine's own
 * type-satisfaction test, passed in so this never re-implements subtyping.
 */
export function planSeats(opts: {
  standard: Standard;
  gig_input: Record<string, unknown>;
  records?: readonly OutputRecord[];
  satisfies: (rec: OutputRecord, type: string) => boolean;
}): SeatPlan {
  const records = opts.records ?? [];
  const phases = opts.standard.phases.map((p) => ({
    name: p.name,
    chairs: p.chairs.map((ch): PlannedChair => planChair(ch, opts.gig_input, records, opts.satisfies)),
  }));
  const seat_count = phases.reduce((n, p) => n + p.chairs.reduce((m, c) => m + c.seat_count, 0), 0);
  const incomplete = phases.some((p) => p.chairs.some((c) => c.seats === undefined));
  return { phases, seat_count, incomplete };
}

function planChair(
  ch: Chair,
  gigInput: Record<string, unknown>,
  records: readonly OutputRecord[],
  satisfies: (rec: OutputRecord, type: string) => boolean,
): PlannedChair {
  const base: PlannedChair = {
    role: ch.role,
    ...(ch.agent_slug ? { agent_slug: ch.agent_slug } : {}),
    ...(ch.skill_slug ? { skill_slug: ch.skill_slug } : {}),
    is_template: Boolean(ch.fan_out),
    seat_count: 0,
  };
  if (!ch.fan_out) {
    const mine = records.filter((r) => ch.input_contract.some((t) => satisfies(r, t)));
    const payload = pick(gigInput, ch.input_contract);
    return { ...base, seat_count: 1, seats: [seatOf(ch.role, mine, payload)] };
  }
  try {
    const { instances } = expandFanOut(ch, records, gigInput, satisfies);
    const seats = instances.map((inst) => {
      // Exactly what the seat receives: the narrowed views in place of the whole records, the
      // records the split drops left out, and the narrowed payload over the gig payload.
      const mine = records
        .filter((r) => !inst.drop.has(r.id))
        .filter((r) => ch.input_contract.some((t) => satisfies(r, t)))
        .map((r) => inst.records.get(r.id) ?? r);
      const payload = { ...pick(gigInput, ch.input_contract), ...inst.gig_input };
      return seatOf(inst.chair.role, mine, payload);
    });
    return { ...base, seat_count: seats.length, seats };
  } catch (e) {
    // A refusal is an ANSWER here, not a failure: it is the thing the operator most wants to know
    // before dispatch, and swallowing it into "1 seat" would be a plausible default standing in for
    // a real value.
    if (e instanceof FanOutRefused) return { ...base, refusal: e.message };
    throw e;
  }
}

const pick = (o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
};
