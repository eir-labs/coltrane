// Runtime accounting + provenance integrity — #232 #233 #235 #236 #240 #243 #245 #246.
//
// One theme runs through all eight: the runtime asserts a number (or a hash, or a status)
// that it does not actually know. A budget charges chairs that never ran; the cost basis
// measures UUIDs instead of content; `usage` says "$0.00 spent" when the truth is "not
// captured"; a failed gig reports zero dollars after burning real ones; backfillShas attaches
// a REAL content_sha belonging to the WRONG predecessor; a chair that under-delivers its
// promised outputs completes silently; a chair with an empty input_contract seals a
// hallucination; a typo'd eval slug scores 0.0 as though it had been judged and found wanting.
//
// Every test here runs the real runGig path with a stubbed invoker (the same template as
// tests/runtime_usage_and_provenance.test.ts) — no `claude` subprocess is ever spawned.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, runGig, BudgetExhausted,
  runFingerprint, CANONICAL_FORM_VERSION, outputContentHash,
  type AgentInvoker, type DomainType, type Chair, type Standard, type Agent, type OutputRecord,
  type GigProgressEvent, type BudgetState, type EvalRecord,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";

// ── shared substrate ────────────────────────────────────────────────────────────────────────
function store(types: DomainType[]) {
  const registry = createRegistry();
  for (const t of types) registry.registerType(t);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}
const T = {
  note: { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] } as DomainType,
  bulk: { slug: "bulk", extends: "Signal", domain: "demo", schema: { properties: { payload: { type: "string" } } }, required_fields: ["payload"] } as DomainType,
  read: { slug: "read", extends: "Interpretation", domain: "demo", schema: { properties: { summary: { type: "string" } } }, required_fields: ["summary"] } as DomainType,
};

// The substance every sealed output carries by virtue of its CORE type. `outputs.write`
// enforces one floor per core on every seal — bare core or domain subtype (#227 ruling) — so
// a stub payload that omits it aborts the CHAIR, and the gig never reaches the phase the test
// is actually about. Held as named constants so a run that fails here fails loudly on the
// fixture, not silently in whatever the assertion happened to be measuring.
const SIGNAL = { source: "fixture://demo/deterministic-invoker" };
const CLAIMS = { claims: ["fixture: the deterministic invoker produced this reading"] };
const CRITERIA = { criteria: ["fixture: the deterministic invoker evaluated this"] };
const VALIDATION = { validation_criteria: ["fixture: the artifact matches its declared type"] };
const CHECKS = { checks: [{ method: "deterministic-invoker", target_ref: "fixture", result: "pass" }] };

// ═══════════════════════════════════════════════════════════════════════════════════════════
// #232 — budget is deducted at chair-PREP, before the model runs. `.map` is eager, so in a
// batch of N ready chairs one tripping BudgetExhausted leaves chairs 1..N-1 CHARGED and never
// invoked. The docstring promises "after success, deducts cost from balance."
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe("#232 — budget charges only work that actually ran", () => {
  // Three parallel chairs in one phase, k=0 so every chair costs exactly base_cost=10.
  // opening=25 → chairs A(10) and B(10) pass the gate, chair C(10) trips at 5 < 10.
  // `prepared = ready.map(prepareChair)` throws on C, so invokeAndWriteChair runs for NOBODY.
  const parallel = (): Standard => ({
    slug: "phantom-charge", domain: "demo",
    agents: (["a", "b", "c"] as const).map((s) =>
      testAgent({ slug: `ag-${s}`, primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" })),
    phases: [{
      name: "sense",
      chairs: (["a", "b", "c"] as const).map((s): Chair => ({
        role: `r-${s}`, agent_slug: `ag-${s}`, depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [],
      })),
    }],
  });

  it("a chair that is never invoked is never charged (the phantom-charge case)", async () => {
    const { outputs, ledger } = store([T.note]);
    let invocations = 0;
    const invoke: AgentInvoker = () => { invocations++; return { t: "hi", ...SIGNAL }; };

    let caught: BudgetExhausted | null = null;
    try {
      await runGig(parallel(), {}, { outputs, ledger, invoke, budget: { opening: 25, base_cost: 10, k: 0 } });
    } catch (e) { if (e instanceof BudgetExhausted) caught = e; else throw e; }

    expect(caught, "the third chair must trip BudgetExhausted").not.toBeNull();
    expect(invocations, "the batch aborts in the synchronous prep stage — NO chair is invoked").toBe(0);
    // THE DEFECT: chairs a and b were charged 10 each at prep and then never ran. The
    // operator is shown spent=20 for zero work.
    expect(
      caught!.state.spent,
      "chairs that were prepared but never invoked must not appear as spend",
    ).toBe(0);
    expect(caught!.state.balance, "balance must equal opening when nothing settled").toBe(25);
  });

  it("a chair whose invoker throws is not charged (deduction is post-success, per the docstring)", async () => {
    // Two sequential phases: p1 succeeds (charged), p2's invoker throws (must NOT be charged).
    const std: Standard = {
      slug: "throwing-chair", domain: "demo",
      agents: [
        testAgent({ slug: "prod", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" }),
        testAgent({ slug: "cons", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["read"], domain: "demo" }),
      ],
      phases: [
        { name: "p1", chairs: [{ role: "r0", agent_slug: "prod", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] },
        { name: "p2", chairs: [{ role: "r1", agent_slug: "cons", depends_on: ["r0"], input_contract: ["note"], output_contract: ["read"], required_skills: [] }] },
      ],
    };
    const { outputs, ledger } = store([T.note, T.read]);
    const invoke: AgentInvoker = ({ agent }) => {
      if (agent.slug === "cons") throw new Error("invoker exploded");
      return { t: "hi", ...SIGNAL };
    };

    let err: unknown;
    try {
      await runGig(std, {}, { outputs, ledger, invoke, budget: { opening: 1000, base_cost: 10, k: 0 } });
    } catch (e) { err = e; }

    expect(err, "the gig must fail").toBeInstanceOf(Error);
    // Bracket access: the budget snapshot rides on the thrown error (#236's carrier), so the
    // operator can see what the failed gig actually cost. Before that carrier exists this is
    // undefined — which is itself the observability hole #236 names.
    const bs = (err as Record<string, unknown>)["budget_state"] as BudgetState | undefined;
    expect(bs, "a failed gig must still surface its budget state").toBeDefined();
    expect(
      bs!.spent,
      "only the chair that SUCCEEDED (10) is charged — the exploding chair must not be",
    ).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// #233 — the cost basis is a byte proxy over input UUIDs, not content. An upstream output
// contributes exactly 36 bytes whether it is a one-line signal or a 40-page draft.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe("#233 — cost basis measures consumed CONTENT, not identifiers", () => {
  const std = (): Standard => ({
    slug: "cost-basis", domain: "demo",
    agents: [
      testAgent({ slug: "bulker", primitives: ["SENSE"], input_types: [], output_types: ["bulk"], domain: "demo" }),
      testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: ["bulk"], output_types: ["read"], domain: "demo" }),
    ],
    phases: [
      { name: "p1", chairs: [{ role: "r0", agent_slug: "bulker", depends_on: [], input_contract: [], output_contract: ["bulk"], required_skills: [] }] },
      { name: "p2", chairs: [{ role: "r1", agent_slug: "reader", depends_on: ["r0"], input_contract: ["bulk"], output_contract: ["read"], required_skills: [] }] },
    ],
  });

  const spendFor = async (payloadBytes: number): Promise<number> => {
    const { outputs, ledger } = store([T.bulk, T.read]);
    const invoke: AgentInvoker = ({ agent }) =>
      agent.slug === "bulker" ? { payload: "x".repeat(payloadBytes), ...SIGNAL } : { summary: "read it", ...CLAIMS };
    const res = await runGig(std(), {}, { outputs, ledger, invoke, budget: { opening: 1e9, base_cost: 0, k: 1 } });
    return (res.budget_state as BudgetState).spent;
  };

  it("a chair consuming a 40-page input costs more than one consuming a one-liner", async () => {
    const small = await spendFor(10);
    const large = await spendFor(40_000);
    // THE DEFECT: both runs cost the same, because the only thing the proxy measured about
    // the upstream output was its 36-character UUID.
    expect(
      large,
      "cost-of-append must be monotonic in the bytes the invoker actually sees",
    ).toBeGreaterThan(small + 30_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// #235 — partial usage capture is indistinguishable from complete capture, and from zero
// spend. `sawUsage` is one boolean; a `result` event with no cost field asserts "$0.00 spent"
// where the truth is "unknown".
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe("#235 — usage distinguishes 'not captured' from '$0.00 spent'", () => {
  const solo = (): Standard => ({
    slug: "usage-solo", domain: "demo",
    agents: [testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" })],
    phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
  });

  it("a result event carrying NO cost and NO tokens does not assert $0.00 spent", async () => {
    const { outputs, ledger } = store([T.note]);
    const invoke: AgentInvoker = (ctx) => {
      // A real `result` event whose payload carries no usage at all — the Bifrost
      // no-cost reply and any CLI result whose usage block is missing.
      ctx.onEvent?.({ type: "result", raw: { type: "result", subtype: "success" } });
      return { t: "hi", ...SIGNAL };
    };
    const r = await runGig(solo(), {}, { outputs, ledger, invoke });
    // THE DEFECT: sawUsage flips unconditionally on any result event, so the gig reports
    // usage {total_cost_usd: 0} — "$0.00 spent" asserted where "not captured" is the truth.
    expect(
      r.usage,
      "an empty result payload captures NOTHING — it must not be reported as zero spend",
    ).toBeUndefined();
  });

  it("a gig where only some invocations reported usage is marked partial, with counts", async () => {
    const std: Standard = {
      slug: "usage-partial", domain: "demo",
      agents: [
        testAgent({ slug: "reporter", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" }),
        testAgent({ slug: "silent", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["read"], domain: "demo" }),
      ],
      phases: [
        { name: "p1", chairs: [{ role: "r0", agent_slug: "reporter", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] },
        { name: "p2", chairs: [{ role: "r1", agent_slug: "silent", depends_on: ["r0"], input_contract: ["note"], output_contract: ["read"], required_skills: [] }] },
      ],
    };
    const { outputs, ledger } = store([T.note, T.read]);
    const invoke: AgentInvoker = (ctx) => {
      if (ctx.agent.slug === "reporter") {
        ctx.onEvent?.({ type: "result", raw: { type: "result", total_cost_usd: 0.05, usage: { input_tokens: 100, output_tokens: 20 } } });
        return { t: "hi", ...SIGNAL };
      }
      // the SIGKILLed-on-the-10-minute-bound chair: it produced work, it reported nothing
      return { summary: "read it", ...CLAIMS };
    };
    const r = await runGig(std, {}, { outputs, ledger, invoke });

    expect(r.usage, "one invocation DID report — usage must be present").toBeDefined();
    const u = r.usage as unknown as Record<string, unknown>;
    expect(u["total_cost_usd"]).toBeCloseTo(0.05, 6);
    // THE DEFECT: 0.05 reads as the gig's complete settled spend. It is a LOWER BOUND —
    // one of two invocations is unaccounted for and nothing says so.
    expect(u["invocations"], "the gig started two model invocations").toBe(2);
    expect(u["unattributed_invocations"], "one of them reported no usage payload").toBe(1);
    expect(u["partial"], "the scalars are a lower bound, not a total").toBe(true);
  });

  it("a fully-reported gig is NOT marked partial", async () => {
    const { outputs, ledger } = store([T.note]);
    const invoke: AgentInvoker = (ctx) => {
      ctx.onEvent?.({ type: "result", raw: {
        type: "result", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 },
        modelUsage: { "claude-x": { inputTokens: 10, outputTokens: 5, costUSD: 0.01 } },
      } });
      return { t: "hi", ...SIGNAL };
    };
    const r = await runGig(solo(), {}, { outputs, ledger, invoke });
    const u = r.usage as unknown as Record<string, unknown>;
    expect(u["invocations"]).toBe(1);
    expect(u["unattributed_invocations"]).toBe(0);
    expect(u["partial"], "complete capture must not be flagged partial").toBeUndefined();
    expect(u["by_model_partial"], "modelUsage was present — the breakdown is complete").toBeUndefined();
  });

  it("a cost without a per-model breakdown flags by_model as a lower bound", async () => {
    const { outputs, ledger } = store([T.note]);
    const invoke: AgentInvoker = (ctx) => {
      ctx.onEvent?.({ type: "result", raw: { type: "result", total_cost_usd: 0.09, usage: { input_tokens: 10, output_tokens: 5 } } });
      return { t: "hi", ...SIGNAL };
    };
    const r = await runGig(solo(), {}, { outputs, ledger, invoke });
    const u = r.usage as unknown as Record<string, unknown>;
    expect(u["total_cost_usd"]).toBeCloseTo(0.09, 6);
    // THE DEFECT: by_model stays {} while the scalars are non-zero, and nothing checks that
    // the breakdown sums to the total.
    expect(u["by_model_partial"], "by_model {} does not account for $0.09").toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// #240 — backfillShas attaches the WRONG predecessor hash. Fuzzy token match, first hit wins,
// ordered by depends_on. A cosmetic array reorder silently rewrites the audit trail, and the
// wrong value is a REAL content_sha that passes every check.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe("#240 — provenance backfill never attaches a hash it cannot prove", () => {
  const TYPES: DomainType[] = [
    { slug: "grant-draft", extends: "Artifact", domain: "demo", schema: { properties: { body: { type: "string" } } }, required_fields: ["body"] },
    { slug: "draft-review", extends: "Judgment", domain: "demo", schema: { properties: { verdict: { type: "string" } } }, required_fields: ["verdict"] },
    // `checks` is inherited from the Verdict core (CORE_SCHEMA_PROPS) and must not be
    // redeclared here — redeclaring would overload the core's own constraint away (#230).
    { slug: "submission-verdict", extends: "Verdict", domain: "demo", schema: {
      properties: { decision: { type: "string" }, draft_sha: { type: "string" }, grant_draft_sha: { type: "string" }, review_sha: { type: "string" } },
    }, required_fields: ["decision", "checks"] },
  ];

  const std = (depends_on: string[]): Standard => ({
    slug: "prov-ambiguity", domain: "demo",
    agents: [
      testAgent({ slug: "drafter", primitives: ["CREATE"], input_types: [], output_types: ["grant-draft"], domain: "demo" }),
      testAgent({ slug: "reviewer", primitives: ["JUDGE"], input_types: ["grant-draft"], output_types: ["draft-review"], domain: "demo" }),
      testAgent({ slug: "gate", primitives: ["VERIFY"], input_types: ["grant-draft", "draft-review"], output_types: ["submission-verdict"], domain: "demo" }),
    ],
    phases: [
      { name: "create", chairs: [{ role: "r0", agent_slug: "drafter", depends_on: [], input_contract: [], output_contract: ["grant-draft"], required_skills: [] }] },
      { name: "judge", chairs: [{ role: "r1", agent_slug: "reviewer", depends_on: ["r0"], input_contract: ["grant-draft"], output_contract: ["draft-review"], required_skills: [] }] },
      { name: "verify", chairs: [{ role: "r2", agent_slug: "gate", depends_on, input_contract: ["grant-draft", "draft-review"], output_contract: ["submission-verdict"], required_skills: [] }] },
    ],
  });

  const runWith = async (depends_on: string[], verdictData: Record<string, unknown>): Promise<
    { ok: true; outputs: readonly OutputRecord[] } | { ok: false; error: string }
  > => {
    const { outputs, ledger } = store(TYPES);
    const invoke: AgentInvoker = ({ agent }) => {
      if (agent.slug === "drafter") return { body: "the draft", ...VALIDATION };
      if (agent.slug === "reviewer") return { verdict: "needs work", ...CRITERIA };
      return verdictData;
    };
    try {
      const r = await runGig(std(depends_on), {}, { outputs, ledger, invoke });
      return { ok: true, outputs: r.outputs };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  it("a cosmetic depends_on reorder cannot change the sealed audit trail", async () => {
    // THE DEFECT: first-fuzzy-hit-wins over depends_on order means flipping a JSON array
    // rewrites which real content_sha gets sealed as the predecessor. Both values look
    // completely authentic, so nothing downstream can tell the audit trail was rewritten.
    //
    // The field is `grant_draft_sha`, which resolves UNAMBIGUOUSLY (exact type-slug match for
    // `grant-draft`). That is load-bearing, not cosmetic: with the ambiguous `draft_sha` this
    // test used to carry, BOTH orders abort on the ambiguity guard, `shaOf` collapses both to
    // the same `ERROR:` string, and `ERROR:x === ERROR:x` reads green while asserting nothing
    // whatsoever about provenance. Refusing to guess is the SIBLING test's contract; this one
    // has to reach the resolved path or it is measuring nothing. Two guards keep it honest:
    // an aborted run FAILS here rather than being folded into the comparison, and the sealed
    // value is compared against the drafter's actual content_sha rather than merely to itself
    // — so a backfill that silently leaves the placeholder in place, or attaches the reviewer's
    // hash, is caught in BOTH orders instead of agreeing with itself.
    const fabricated = {
      decision: "submit",
      grant_draft_sha: "sha256:PLACEHOLDER-the-draft-i-consumed",
      ...CHECKS,
    };
    const forward = await runWith(["r0", "r1"], { ...fabricated });
    const reversed = await runWith(["r1", "r0"], { ...fabricated });

    // FAIL ON AN ERROR — never compare two error strings and call the agreement a pass.
    expect(forward.ok, `forward run aborted: ${forward.ok ? "" : forward.error}`).toBe(true);
    expect(reversed.ok, `reversed run aborted: ${reversed.ok ? "" : reversed.error}`).toBe(true);
    if (!forward.ok || !reversed.ok) return; // narrowing only; the expects above already failed

    const sealedSha = (r: { outputs: readonly OutputRecord[] }): string =>
      String((r.outputs.find((o) => o.domain_type === "submission-verdict")!.data as Record<string, unknown>)["grant_draft_sha"]);
    const draftSha = (r: { outputs: readonly OutputRecord[] }): string =>
      r.outputs.find((o) => o.domain_type === "grant-draft")!.content_sha;

    // the placeholder must have been REPLACED, in each order independently, by the real hash
    // of the grant-draft that chair actually consumed
    expect(sealedSha(forward), "forward: the sealed predecessor must be the drafter's content_sha").toBe(draftSha(forward));
    expect(sealedSha(reversed), "reversed: the sealed predecessor must be the drafter's content_sha").toBe(draftSha(reversed));
    expect(sealedSha(forward), "a placeholder that survives backfill is not provenance").toMatch(/^[0-9a-f]{64}$/);

    // ...and the two orders agree, which is #240 itself.
    expect(
      sealedSha(reversed),
      "the provenance a chair seals must not depend on the order of its depends_on array",
    ).toBe(sealedSha(forward));
  });

  it("an ambiguous *_sha field fails loudly rather than guessing a real-but-wrong hash", async () => {
    const r = await runWith(["r1", "r0"], { decision: "submit", draft_sha: "sha256:PLACEHOLDER-the-draft-i-consumed", ...CHECKS });
    expect(r.ok, "an unprovable provenance hash must abort the chair, not be invented").toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/ambiguous/i);
      expect(r.error).toMatch(/draft_sha/);
      expect(r.error, "the error must name the candidates it refused to choose between").toMatch(/grant-draft/);
      expect(r.error).toMatch(/draft-review/);
    }
  });

  it("an UNambiguous field still resolves — an exact type-slug match beats a token collision", async () => {
    const r = await runWith(["r1", "r0"], {
      decision: "submit",
      grant_draft_sha: "UNSEALED:no-hash-tool-in-seat",
      review_sha: "UNSEALED:no-hash-tool-in-seat",
      ...CHECKS,
    });
    expect(r.ok, "unambiguous fields must keep working").toBe(true);
    if (r.ok) {
      const draft = r.outputs.find((o) => o.domain_type === "grant-draft")!;
      const review = r.outputs.find((o) => o.domain_type === "draft-review")!;
      const verdict = r.outputs.find((o) => o.domain_type === "submission-verdict")!.data as Record<string, string>;
      // `grant_draft_sha` tokenizes to [grant, draft] — an exact match for `grant-draft`, even
      // though `draft-review` also shares the `draft` token and comes FIRST in depends_on.
      expect(verdict["grant_draft_sha"], "exact type-slug match must win over a partial collision").toBe(draft.content_sha);
      expect(verdict["review_sha"]).toBe(review.content_sha);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// #243, recording half — the shortfall is VISIBLE on the event and in the gig manifest.
//
// UPDATED when the enforcement half landed. This block originally asserted
// `status === "complete"` with the note "conditional outputs are legal — this must not become
// a hard failure". That reasoning was right about conditional outputs and wrong about the
// remedy: the chair had no way to DECLARE which of its promised types were conditional, so
// "legal" had to mean "legal for everyone", including chairs that simply failed to deliver.
//
// `optional_outputs` (tests/chair_output_floor.test.ts) is that way to declare it, so the
// contract is now a floor and the chair below — which declares nothing optional — fails.
// The recording assertions are the point of this test and are UNCHANGED: legitimising a
// shortfall must not stop reporting it, so the fixture simply declares its conditional type
// and everything about visibility is asserted exactly as before.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe("#243 — an under-delivered output_contract is recorded, not silent", () => {
  it("a chair promising two types and sealing one reports the shortfall", async () => {
    const types: DomainType[] = [
      { slug: "sig-a", extends: "Signal", domain: "demo", schema: { properties: { a: { type: "string" } } }, required_fields: ["a"] },
      { slug: "judg-b", extends: "Judgment", domain: "demo", schema: { properties: { b: { type: "string" } } }, required_fields: ["b"] },
    ];
    const both: Agent = testAgent({ slug: "dual", primitives: ["SENSE", "JUDGE"], input_types: [], output_types: ["sig-a", "judg-b"], domain: "demo" });
    const std: Standard = {
      slug: "under-deliver", domain: "demo", agents: [both],
      phases: [{ name: "p", chairs: [{ role: "r", agent_slug: "dual", depends_on: [], input_contract: [], output_contract: ["sig-a", "judg-b"], optional_outputs: ["judg-b"], required_skills: [] }] }],
    };
    const { outputs, ledger } = store(types);
    const events: GigProgressEvent[] = [];
    // The invoker honours only half the promise.
    const invoke: AgentInvoker = () => ({ "sig-a": { a: "made it", ...SIGNAL } });
    const res = await runGig(std, {}, { outputs, ledger, invoke, onProgress: (e) => events.push(e) });

    expect(res.status, "a DECLARED-optional absence is legal and must complete").toBe("complete");
    expect(res.outputs.map((o) => o.domain_type)).toEqual(["sig-a"]);

    // The original finding: it is not enough that the run survives — a shortfall the operator
    // cannot see is a shortfall that gets assumed away. For a TERMINAL chair no downstream
    // input_contract will ever surface it, so these two channels are the only ones there are.
    const done = events.find((e) => e.type === "chair_complete") as unknown as Record<string, unknown>;
    expect(done["promised_output_types"], "the promise must be recorded alongside what was delivered").toEqual(["sig-a", "judg-b"]);
    expect(done["missing_output_types"]).toEqual(["judg-b"]);

    const unfulfilled = (res as unknown as Record<string, unknown>)["unfulfilled_outputs"] as Array<Record<string, unknown>> | undefined;
    expect(unfulfilled, "the gig manifest must carry the shortfall").toEqual([{ role: "r", phase: "p", missing: ["judg-b"] }]);
  });

  it("a chair that delivers everything it promised reports no shortfall", async () => {
    const { outputs, ledger } = store([T.note]);
    const std: Standard = {
      slug: "full-deliver", domain: "demo",
      agents: [testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" })],
      phases: [{ name: "p", chairs: [{ role: "r", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
    };
    const res = await runGig(std, {}, { outputs, ledger, invoke: () => ({ t: "hi", ...SIGNAL }) });
    expect((res as unknown as Record<string, unknown>)["unfulfilled_outputs"]).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// #245 — a chair with an empty input_contract runs with inputs: [] and seals a hallucinated
// answer. `if (chair.input_contract.length > 0)` skips ALL input validation.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe("#245 — a chair whose agent declares inputs must actually receive them", () => {
  it("an entry chair with NOTHING to consume — no upstream, no payload — fails instead of hallucinating", async () => {
    const orphan: Agent = testAgent({ slug: "orphan", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["read"], domain: "demo" });
    const std: Standard = {
      slug: "hallucinate", domain: "demo", agents: [orphan],
      // empty input_contract → the runtime used to skip every input check
      phases: [{ name: "p", chairs: [{ role: "r", agent_slug: "orphan", depends_on: [], input_contract: [], output_contract: ["read"], required_skills: [] }] }],
    };
    const { outputs, ledger } = store([T.note, T.read]);
    let observed = -1;
    const invoke: AgentInvoker = ({ inputs }) => { observed = inputs.length; return { summary: "hallucinated", ...CLAIMS }; };

    // THE DEFECT (the issue's own reproduction — chair contract emptied, gig input entirely
    // empty): status=complete, ctx.inputs=[], one sealed record with full provenance.
    await expect(
      runGig(std, {}, { outputs, ledger, invoke }),
      "an agent that consumes `note` and receives nothing must not seal an invented answer",
    ).rejects.toThrow(/note/);
    expect(observed, "the model must never be invoked with the inputs it declared missing").toBe(-1);
    expect(outputs.all().length, "nothing invented is sealed").toBe(0);
  });

  it("a DOWNSTREAM chair whose upstream produced the wrong type fails instead of hallucinating", async () => {
    const producer: Agent = testAgent({ slug: "producer", primitives: ["SENSE"], input_types: [], output_types: ["bulk"], domain: "demo" });
    const consumer: Agent = testAgent({ slug: "consumer", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["read"], domain: "demo" });
    const std: Standard = {
      slug: "wrong-upstream", domain: "demo", agents: [producer, consumer],
      phases: [
        { name: "p1", chairs: [{ role: "r0", agent_slug: "producer", depends_on: [], input_contract: [], output_contract: ["bulk"], required_skills: [] }] },
        { name: "p2", chairs: [{ role: "r1", agent_slug: "consumer", depends_on: [], input_contract: [], output_contract: ["read"], required_skills: [] }] },
      ],
    };
    const { outputs, ledger } = store([T.note, T.bulk, T.read]);
    const invoke: AgentInvoker = ({ agent }) => (agent.slug === "producer" ? { payload: "x", ...SIGNAL } : { summary: "hallucinated", ...CLAIMS });
    // Upstream RAN and produced `bulk`; the consumer declared `note`. Handing it [] and letting
    // it answer anyway is the hallucination — and here there is no ambiguity about intent.
    await expect(
      runGig(std, { unrelated: "payload" }, { outputs, ledger, invoke }),
    ).rejects.toThrow(/note/);
    expect(outputs.all().length, "only the upstream output exists; nothing invented is sealed").toBe(1);
  });

  it("a SEEDED entry chair still runs — the half a runtime check cannot close, recorded honestly", async () => {
    // `standards/patent-triage-v0.json` ships this shape: the `cleave` chair binds an agent
    // declaring `invention-spec` and is seeded with an untyped `{description: "…"}`. The
    // runtime sees the same three facts as in a mis-wired chair — declared type, nothing
    // upstream, some payload — so it cannot discriminate without the standard declaring
    // `input_types` (#156). This pins the exemption so it can never widen by accident.
    const orphan: Agent = testAgent({ slug: "seeded-orphan", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["read"], domain: "demo" });
    const std: Standard = {
      slug: "seeded-entry", domain: "demo", agents: [orphan],
      phases: [{ name: "p", chairs: [{ role: "r", agent_slug: "seeded-orphan", depends_on: [], input_contract: [], output_contract: ["read"], required_skills: [] }] }],
    };
    const { outputs, ledger } = store([T.note, T.read]);
    let observed = -1;
    const res = await runGig(std, { description: "an untyped v0 seed" }, {
      outputs, ledger, invoke: ({ inputs }) => { observed = inputs.length; return { summary: "from the seed", ...CLAIMS }; },
    });
    expect(res.status).toBe("complete");
    expect(observed, "still invoked with empty inputs — this is the open half").toBe(0);
  });

  it("an agent declaring NO input_types still runs on an empty frontier (entry chairs are legal)", async () => {
    const { outputs, ledger } = store([T.note]);
    const std: Standard = {
      slug: "legal-entry", domain: "demo",
      agents: [testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" })],
      phases: [{ name: "p", chairs: [{ role: "r", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
    };
    const res = await runGig(std, {}, { outputs, ledger, invoke: () => ({ t: "hi", ...SIGNAL }) });
    expect(res.status).toBe("complete");
  });

  it("a declared input satisfied by the GIG PAYLOAD still runs (the entry-chair seed)", async () => {
    const { outputs, ledger } = store([T.note, T.read]);
    const std: Standard = {
      slug: "gig-seeded", domain: "demo", input_types: ["note"],
      agents: [testAgent({ slug: "seeded", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["read"], domain: "demo" })],
      phases: [{ name: "p", chairs: [{ role: "r", agent_slug: "seeded", depends_on: [], input_contract: [], output_contract: ["read"], required_skills: [] }] }],
    } as unknown as Standard;
    const res = await runGig(std, { note: { t: "seeded from the gig payload", ...SIGNAL } }, { outputs, ledger, invoke: () => ({ summary: "read it", ...CLAIMS }) });
    expect(res.status).toBe("complete");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// #246 — scoreEval conflates an unresolvable eval slug with a genuinely failing eval, and
// bakes the conflation into run_fingerprint.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe("#246 — an unresolvable eval slug is not a failing eval", () => {
  const readType = T.read;
  const std = (eval_slugs: string[]): Standard => ({
    slug: "eval-honesty", domain: "demo", eval_slugs,
    agents: [testAgent({ slug: "writer", primitives: ["INTERPRET"], input_types: [], output_types: ["read"], domain: "demo" })],
    phases: [{ name: "p", chairs: [{ role: "r", agent_slug: "writer", depends_on: [], input_contract: [], output_contract: ["read"], required_skills: [] }] }],
  } as unknown as Standard);
  const evals = new Map<string, EvalRecord>([
    ["summary-present", { slug: "summary-present", domain: "demo", on_type: "read", non_empty_fields: ["summary"] } as EvalRecord],
  ]);

  it("a dangling slug is reported as unresolved, distinct from a 0.0 score", async () => {
    const { outputs, ledger } = store([readType]);
    const res = await runGig(std(["summry-presnt"]), {}, { outputs, ledger, invoke: () => ({ summary: "ok", ...CLAIMS }), evals });
    // THE DEFECT: eval_scores = {"summry-presnt": 0} — byte-identical to a real eval that ran
    // and failed. Nothing distinguishes a typo from a judgement.
    expect(
      (res as unknown as Record<string, unknown>)["unresolved_evals"],
      "a slug that resolves to no eval definition must be named as such",
    ).toEqual(["summry-presnt"]);
  });

  it("a genuine 0.0 and a dangling slug do not produce the same run_fingerprint", async () => {
    const { outputs, ledger } = store([readType]);
    const dangling = std(["summry-presnt"]);
    const res = await runGig(dangling, {}, { outputs, ledger, invoke: () => ({ summary: "ok", ...CLAIMS }), evals });

    // Reconstruct the fingerprint the runtime WOULD produce if "summry-presnt" had been a real
    // eval that ran and scored 0.0. Today the two are identical — the typo is baked into the
    // reproducibility key as though a contract had been evaluated and found wanting.
    const asIfJudged = runFingerprint({
      genome_hash: res.genome_hash,
      model_version: "unknown",
      canonical_form_version: CANONICAL_FORM_VERSION,
      eval_scores: { "summry-presnt": 0 },
      output_hashes: res.outputs.map((o) => outputContentHash(o)),
    });
    expect(
      res.run_fingerprint,
      "an eval that was never evaluated must not fingerprint as one that was judged 0.0",
    ).not.toBe(asIfJudged);
    // sanity: the run still produced a real fingerprint over this run's genome
    expect(res.run_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(dangling.eval_slugs).toEqual(["summry-presnt"]);
  });

  it("a resolvable eval still scores normally and reports nothing unresolved", async () => {
    const { outputs, ledger } = store([readType]);
    const pass = await runGig(std(["summary-present"]), {}, { outputs, ledger, invoke: () => ({ summary: "ok", ...CLAIMS }), evals });
    expect(pass.eval_scores["summary-present"]).toBe(1.0);
    expect((pass as unknown as Record<string, unknown>)["unresolved_evals"]).toBeUndefined();

    const { outputs: o2, ledger: l2 } = store([readType]);
    const fail = await runGig(std(["summary-present"]), {}, { outputs: o2, ledger: l2, invoke: () => ({ summary: "", ...CLAIMS }), evals });
    expect(fail.eval_scores["summary-present"]).toBe(0.0);
    expect((fail as unknown as Record<string, unknown>)["unresolved_evals"]).toBeUndefined();
  });
});
