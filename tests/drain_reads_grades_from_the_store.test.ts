// DR-1 / DR-2 (wiki spec.coltrane.the-drain-runs-a-graded-red-pass): the drain reads a spec's grades from the store it
// claimed the gig from, through chancery-os's two asks (ask_spec_grades, ask_conformance_seat; chancery-os#42), and
// passes them as RunDeps.spec_grades. Never from the gig input, a file or a flag. Any failure of the read leaves
// spec_grades ABSENT, so DS-4 refuses: never empty-and-admitting, never partial.
import { describe, it, expect } from "vitest";
import * as reader from "../src/spec_grades_reader.js";

const VOR = "f46af642-cc2f-4a64-ba50-96b8a5d65fc6";
const BLAKEY = "cc9eed18-21b7-4eda-834e-280451f00e15";
const SPEC = "spec.chancery.the-testable-charter";
const H = "e".repeat(64);
const grade = (over: Record<string, unknown> = {}, rec: Record<string, unknown> = {}) =>
  ({ id: "g1", at: "2026-10-28T06:00:00Z", record: { spec: SPEC, content_hash: H, verdict: "PASS", scope: null, by: VOR, held_seat: true, ...rec }, ...over });

type Calls = Array<{ url: string; body: unknown }>;
function store(routes: Record<string, () => { status: number; body: unknown }>): { fetchFn: typeof fetch; calls: Calls } {
  const calls: Calls = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    const name = Object.keys(routes).find((k) => String(url).endsWith(`/rest/v1/rpc/${k}`));
    const r = name ? routes[name]!() : { status: 404, body: { message: "no route" } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const ctx = { baseUrl: "http://store.test", anonKey: "anon" };
type Read = (c: typeof ctx, spec: string, at: string, f: typeof fetch) => Promise<{ conformance_seat: string; grades: Array<{ id: string; record: Record<string, unknown> }> } | undefined>;
const readSpecGrades = (reader as unknown as { readSpecGrades?: Read }).readSpecGrades;

describe("DR-1 — the drain's grades come from the store it claimed from, through the asks", () => {
  it("DR-1 twin — Vör's PASS, Vör holding the seat: read through ask_spec_grades and ask_conformance_seat, shaped as RunDeps.spec_grades", async () => {
    expect(typeof readSpecGrades, "src/spec_grades_reader.ts exports no readSpecGrades").toBe("function");
    const s = store({ ask_spec_grades: () => ({ status: 200, body: [grade()] }), ask_conformance_seat: () => ({ status: 200, body: [VOR] }) });
    const got = await readSpecGrades!(ctx, SPEC, "2026-10-28T07:00:00Z", s.fetchFn);
    expect(got).toEqual({ conformance_seat: VOR, grades: [{ id: "g1", record: { spec: SPEC, content_hash: H, verdict: "PASS", scope: null, by: VOR, held_seat: true } }] });
    expect(s.calls.find((c) => c.url.endsWith("/ask_spec_grades"))?.body).toEqual({ p_spec: SPEC });
    expect(s.calls.find((c) => c.url.endsWith("/ask_conformance_seat"))?.body).toEqual({ p_at: "2026-10-28T07:00:00Z" });
    expect(s.calls.every((c) => c.url.startsWith("http://store.test/rest/v1/rpc/")), "only the store's asks are read: no table select").toBe(true);
  });

  it("DR-1 — the grades keep the ask's order (DS-4 refuses a superseded grade by position)", async () => {
    const s = store({
      ask_spec_grades: () => ({ status: 200, body: [grade({ id: "old" }, { verdict: "HOLD" }), grade({ id: "new" })] }),
      ask_conformance_seat: () => ({ status: 200, body: [VOR] }),
    });
    const got = await readSpecGrades!(ctx, SPEC, "2026-10-28T07:00:00Z", s.fetchFn);
    expect(got?.grades.map((g) => g.id)).toEqual(["old", "new"]);
  });

  it("DR-2 plant (Vör) — rows out of order in `at`: DS-4's supersession is positional, so an unverified order is refused", async () => {
    const s = store({
      ask_spec_grades: () => ({ status: 200, body: [grade({ id: "new", at: "2026-10-28T06:00:00Z" }), grade({ id: "old", at: "2026-10-27T06:00:00Z" }, { verdict: "HOLD" })] }),
      ask_conformance_seat: () => ({ status: 200, body: [VOR] }),
    });
    expect(await readSpecGrades!(ctx, SPEC, "2026-10-28T07:00:00Z", s.fetchFn)).toBeUndefined();
  });

  it("DR-2 plant — a grade with no `at`: absent", async () => {
    const s = store({ ask_spec_grades: () => ({ status: 200, body: [grade({ at: undefined })] }), ask_conformance_seat: () => ({ status: 200, body: [VOR] }) });
    expect(await readSpecGrades!(ctx, SPEC, "2026-10-28T07:00:00Z", s.fetchFn)).toBeUndefined();
  });

  it("DR-1 plant — no grade for the spec: an empty list, so DS-4 refuses (absence of a PASS, not absence of the read)", async () => {
    const s = store({ ask_spec_grades: () => ({ status: 200, body: [] }), ask_conformance_seat: () => ({ status: 200, body: [VOR] }) });
    expect(await readSpecGrades!(ctx, SPEC, "2026-10-28T07:00:00Z", s.fetchFn)).toEqual({ conformance_seat: VOR, grades: [] });
  });

  it("DR-1 plant — the seat is held by someone else: the read reports that holder, and Vör's grade will not admit", async () => {
    const s = store({ ask_spec_grades: () => ({ status: 200, body: [grade()] }), ask_conformance_seat: () => ({ status: 200, body: [BLAKEY] }) });
    expect((await readSpecGrades!(ctx, SPEC, "2026-10-28T07:00:00Z", s.fetchFn))?.conformance_seat).toBe(BLAKEY);
  });
});

describe("DR-2 — the read fails closed: absent, never empty-and-admitting, never partial", () => {
  const cases: Array<[string, Record<string, () => { status: number; body: unknown }>]> = [
    ["a 500 on ask_spec_grades", { ask_spec_grades: () => ({ status: 500, body: { message: "boom" } }), ask_conformance_seat: () => ({ status: 200, body: [VOR] }) }],
    ["a 500 on ask_conformance_seat", { ask_spec_grades: () => ({ status: 200, body: [grade()] }), ask_conformance_seat: () => ({ status: 500, body: {} }) }],
    ["a grade missing its verdict", { ask_spec_grades: () => ({ status: 200, body: [grade({}, { verdict: undefined })] }), ask_conformance_seat: () => ({ status: 200, body: [VOR] }) }],
    ["a grade whose grader is not a principal id", { ask_spec_grades: () => ({ status: 200, body: [grade({}, { by: "vor" })] }), ask_conformance_seat: () => ({ status: 200, body: [VOR] }) }],
    ["a grade whose hash is not a sha256", { ask_spec_grades: () => ({ status: 200, body: [grade({}, { content_hash: "abc" })] }), ask_conformance_seat: () => ({ status: 200, body: [VOR] }) }],
    ["one good grade beside one malformed (never partial)", { ask_spec_grades: () => ({ status: 200, body: [grade(), grade({ id: "bad" }, { verdict: "MAYBE" })] }), ask_conformance_seat: () => ({ status: 200, body: [VOR] }) }],
    ["a grade carrying no held_seat attestation (the ask's seat-at-its-moment)", { ask_spec_grades: () => ({ status: 200, body: [grade({}, { held_seat: undefined })] }), ask_conformance_seat: () => ({ status: 200, body: [VOR] }) }],
    ["no one seated in the conformance seat", { ask_spec_grades: () => ({ status: 200, body: [grade()] }), ask_conformance_seat: () => ({ status: 200, body: [] }) }],
    ["two principals seated in the conformance seat", { ask_spec_grades: () => ({ status: 200, body: [grade()] }), ask_conformance_seat: () => ({ status: 200, body: [VOR, BLAKEY] }) }],
    ["the ask does not exist on this store (404)", { ask_conformance_seat: () => ({ status: 200, body: [VOR] }) }],
  ];
  for (const [name, routes] of cases) {
    it(`DR-2 plant — ${name}: spec_grades absent`, async () => {
      const s = store(routes);
      expect(await readSpecGrades!(ctx, SPEC, "2026-10-28T07:00:00Z", s.fetchFn)).toBeUndefined();
    });
  }
  it("DR-2 plant — a fetch that throws (the store is down): absent", async () => {
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await readSpecGrades!(ctx, SPEC, "2026-10-28T07:00:00Z", down)).toBeUndefined();
  });
});
