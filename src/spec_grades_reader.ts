// DR-1 / DR-2 (wiki spec.coltrane.the-drain-runs-a-graded-red-pass) — a spec's grades, read from the store the drain
// claimed the gig from, through chancery-os's two asks (ask_spec_grades, ask_conformance_seat; chancery-os#42). The
// serving role reads no table, so the asks are the whole read: a definer each, the grader read from the grade's own
// make act, never from the record. The result is RunDeps.spec_grades, which DS-4 (runtime.ts specGradeRefusal) judges.
//
// FAIL CLOSED. Any failure of the read (a non-2xx, a thrown fetch, a malformed row, a seat held by no one or by
// several) returns undefined: spec_grades absent, so DS-4 refuses before any seat. Never an empty-and-admitting
// value, never a partial list (one malformed grade voids the read). An empty list is returned only when the ask
// answered cleanly with no grade, which DS-4 refuses as "no PASS".

export interface SpecGradesRead {
  conformance_seat: string;
  grades: Array<{ id: string; record: { spec: string; content_hash: string; verdict: "PASS" | "HOLD"; scope: string[] | null; by: string; held_seat: boolean } }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

async function ask(ctx: { baseUrl: string; anonKey: string }, fn: string, body: unknown, fetchFn: typeof fetch): Promise<unknown[] | undefined> {
  try {
    const res = await fetchFn(`${ctx.baseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: ctx.anonKey, Authorization: `Bearer ${ctx.anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return undefined;
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? rows : undefined;
  } catch {
    return undefined;
  }
}

function asGrade(row: unknown, spec: string): SpecGradesRead["grades"][number] | undefined {
  if (!row || typeof row !== "object") return undefined;
  const r = row as { id?: unknown; record?: unknown };
  if (typeof r.id !== "string" || r.id.length === 0 || !r.record || typeof r.record !== "object") return undefined;
  const g = r.record as Record<string, unknown>;
  if (g["spec"] !== spec) return undefined;
  if (typeof g["content_hash"] !== "string" || !SHA256.test(g["content_hash"])) return undefined;
  if (g["verdict"] !== "PASS" && g["verdict"] !== "HOLD") return undefined;
  const scope = g["scope"];
  if (!(scope === null || scope === undefined || (Array.isArray(scope) && scope.every((x) => typeof x === "string")))) return undefined;
  if (typeof g["by"] !== "string" || !UUID.test(g["by"])) return undefined;
  // whether the grader held the conformance seat at the grade's own moment (the ask's attestation); required
  if (typeof g["held_seat"] !== "boolean") return undefined;
  return { id: r.id, record: { spec, content_hash: g["content_hash"], verdict: g["verdict"], scope: (scope ?? null) as string[] | null, by: g["by"], held_seat: g["held_seat"] } };
}

export async function readSpecGrades(
  ctx: { baseUrl: string; anonKey: string },
  spec: string,
  at: string,
  fetchFn: typeof fetch = fetch,
): Promise<SpecGradesRead | undefined> {
  const [rows, seats] = await Promise.all([
    ask(ctx, "ask_spec_grades", { p_spec: spec }, fetchFn),
    ask(ctx, "ask_conformance_seat", { p_at: at }, fetchFn),
  ]);
  if (!rows || !seats) return undefined;
  if (seats.length !== 1 || typeof seats[0] !== "string" || !UUID.test(seats[0])) return undefined;
  const grades: SpecGradesRead["grades"] = [];
  // DS-4 refuses a superseded grade by POSITION, so the order is verified, not trusted: every row carries the `at` of its
  // make act, and the rows are non-decreasing in it. An out-of-order or undated row voids the read (Vör, at fb32460).
  let last = -Infinity;
  for (const row of rows) {
    const g = asGrade(row, spec);
    if (!g) return undefined; // never partial
    const at = Date.parse(String((row as { at?: unknown }).at ?? ""));
    if (!Number.isFinite(at) || at < last) return undefined;
    last = at;
    grades.push(g);
  }
  return { conformance_seat: seats[0], grades };
}
