// RED — coltrane 1.0: a player is a name, a lineage, a memory and an instrument.
//
// Spec: docs/specs/coltrane-1.0.red-spec.md (revision 5). Six laws are EXECUTABLE against the engine as
// it stands and red today on ABSENCE of the mechanism, never on a collection, import or fixture error.
// The rest are `it.todo` because the seam they pin — a seat, a gig-plan, a planner office, a residency,
// a player store with its own ledger, a lineage-keyed floor — has no API yet. A todo is a law without a
// seam, not a law deferred; each carries its full text so the count in scripts/laws.sh is honest about
// what is owed, and scripts/laws.sh is bumped so the ONLY red is these laws.
//
// THIS FILE IS RED BY DESIGN. The gate on landing it is the spec-review verdict, not the test run.
//
// TRANSITIONAL FIXTURES, stated so nobody is surprised at step 4: the executable laws below compose
// standards WITH `agent_slug`, because today composeStandard REQUIRES it (check (c), composition.ts).
// C1 outlaws exactly that. So on the day C1 lands, M2/G5, G1 and G4 must be re-fixtured onto a plan,
// and the chart-level forms of C1 and G3 retire in favour of their plan-level forms. That is the build
// order's step 4 and it is written in the spec; it is not a defect in these laws, it is what RED-first
// against a design that removes the fixture's own field looks like.
//
// Scope is matched to the claim throughout (tests/the_tracked_ledger_parses.test.ts): a positive reads
// the exact subject; a universal negative ("no shipped standard …") reads EVERY shipped standard.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeStandard, createRegistry, createOutputStore, MemoryLedger,
  type AgentInvoker, type DomainType, type Chair, type Standard, type Agent,
} from "../src/index.js";
import { runGig } from "../src/runtime.js";
import { loadGenome } from "../src/loader.js";
import { testAgent } from "./_support/agents.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
const note: DomainType = { slug: "one-note", extends: "Signal", domain: "one-point-oh", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const registry = () => { const r = createRegistry(); r.registerType(note); return r; };
const sensor = (over: Partial<Agent> = {}): Agent =>
  testAgent({ slug: "one-sensor", primitives: ["SENSE"], input_types: [], output_types: ["one-note"], domain: "one-point-oh", ...over } as never) as Agent;

/** TRANSITIONAL — composes with agent_slug because the engine requires it today. See header. */
function oneChair(agent: Agent = sensor()): Standard {
  return composeStandard({
    slug: "one-chair", domain: "one-point-oh", agents: [agent],
    phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "one-sensor", depends_on: [], input_contract: [], output_contract: ["one-note"], required_skills: [] } as Chair] }],
  });
}
const invoke: AgentInvoker = () => ({ t: "x", source: "fixture://one-point-oh" });
type Row = Record<string, unknown>;
const phasesSeen = (l: MemoryLedger): string[] =>
  (l.query({}) as unknown as Row[]).filter((r) => r["kind"] === "chair_spend").map((r) => String(r["phase"]));

/** Is `slug` a Verdict-shaped domain type? Walks `extends` through the loaded genome to a core type. */
function isVerdict(slug: string, g: ReturnType<typeof loadGenome>): boolean {
  if (slug === "Verdict") return true;
  let cur: string | undefined = slug;
  for (let i = 0; i < 8 && cur; i++) {
    const t = [...g.domain_types.values()].find((d) => d.slug === cur);
    if (!t) return false;
    if (t.extends === "Verdict") return true;
    cur = t.extends;
  }
  return false;
}


/** A universal negative over "every shipped standard" is only as wide as the universe it reads. Pin it:
 *  every standards/*.json loaded, zero load_errors in that class — a standard that fails to load would
 *  otherwise leave the universe silently and the law would go green by breakage. */
function pinUniverse(g: ReturnType<typeof loadGenome>): void {
  const onDisk = readdirSync(join(REPO, "standards")).filter((f) => f.endsWith(".json")).length;
  const stdErrors = (g.load_errors ?? []).filter((e) => JSON.stringify(e).includes("standards/"));
  expect(stdErrors, "a standard failed to load — the universe is short").toEqual([]);
  // bearing-laws live in standards/ but are not standards (CLAUDE.md); subtract them from the file count.
  const bearing = readdirSync(join(REPO, "standards")).filter((f) => f.endsWith(".json") && JSON.parse(readFileSync(join(REPO, "standards", f), "utf8")).kind === "bearing-law").length;
  expect(g.standards.size, "every standards/*.json that is a standard is in the universe").toBe(onDisk - bearing);
  expect(g.standards.size).toBeGreaterThan(0);
}

// ── PLAYER ───────────────────────────────────────────────────────────────────────────────────────
describe("P — a player is a name, a lineage, a memory and an instrument", () => {
  it("P1 — a player file carrying capability is REFUSED at load, naming the field", () => {
    const dir = mkdtempSync(join(tmpdir(), "one-point-oh-"));
    try {
      for (const d of ["agents", "standards", "domain_types", "core_types", "skills", "evals"]) mkdirSync(join(dir, d), { recursive: true });
      // A COMPLETE 0.x agent — every field the current loader requires is present, so the only thing
      // this can be red on is the ABSENCE of the 1.0 refusal. (The first draft omitted
      // behavioral_primitives and was red on GenomeIncompleteError instead — a fixture error, caught
      // in review.) Under 1.0 every field below except slug belongs somewhere other than the player.
      writeFileSync(join(dir, "agents", "job-description.json"), JSON.stringify({
        slug: "job-description", primitives: ["SENSE"], behavioral_primitives: ["explorer", "analyst"],
        input_types: [], output_types: ["Signal"], domain: "x",
        allowed_tools: ["Read"], model_tier: "standard", max_tool_calls: 10, code_tool_access: "read",
        identity: "A job description pretending to be a person, long enough to clear the identity floor by a margin.",
        method: "1. read\n2. read more\n3. seal", constraints: [],
      }, null, 2));
      const g = loadGenome(dir);
      const err = (g.load_errors ?? []).find((e) => JSON.stringify(e).includes("job-description"));
      expect(err, "a player file carrying capability must be a load_error naming the file").toBeDefined();
      // Second review: /allowed_tools|primitives|model_tier|identity/ would be satisfied by the EXISTING
      // behavioral_primitives zod message or any future identity-floor refusal — a partial rule goes green.
      // The 1.0 refusal has to say WHERE the field belongs now; nothing in the engine says that today.
      expect(JSON.stringify(err), "the refusal names the field AND where it belongs under 1.0").toMatch(/belongs (to|on) the (gig plan|seat|lineage)/i);
      // Third review: a loader rule for ONE field would green this. Every capability field the fixture
      // carries must be named in a refusal — the law is "capability leaves the player", not "one field does".
      const named = JSON.stringify(g.load_errors ?? []);
      for (const f of ["primitives", "behavioral_primitives", "allowed_tools", "model_tier", "max_tool_calls", "code_tool_access", "identity", "method"]) {
        expect(named, `the refusal must name \`${f}\` — a rule that catches one field is not the law`).toContain(f);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.todo("P2 — identity is the player's uuid; the nick is never a map key, a path segment (genome_writer.ts:61-62) or a hash input (runtime.ts:1397)");
  it.todo("P3 — a player of kind: player with no sealed PLAYER LINEAGE cannot be seated: refused at PLAN, naming the player; HUMANS need no seal (a human IS their lineage), so the governor's residency stays the one fixed point");
  it.todo("P4 — `human: true` becomes `kind: \"human\" | \"player\"`; both are agent KINDS that hold offices and occupy seats");
  it.todo("P5 — disposition lives in the lineage seal; a plan may not re-dispose a player and a chart may not");
});

// ── LINEAGE ──────────────────────────────────────────────────────────────────────────────────────
describe("L — behaviour is founded on a sealed PLAYER lineage (not the lineage of a question)", () => {
  it.todo("L0 — `lineage-record` is the lineage OF A QUESTION (lineage-pass-v1, attached to an institution) and is not used as a player's lineage");
  it.todo("L1 — a PLAYER LINEAGE SEAL {player_id, forebear, alignment, angle} — and NOTHING else; tensions[] is dropped, tension is emergent from seating — is sealed by the governor's office (= naming-ritual-v1's human seat); per player, never per institution");
  it.todo("L2 — a player's prompt foundation is built FROM the seal's text; no identity field to drift from it (buildPrompt reads a.identity at claude_invoker.ts:204; completions calls it at completions_invoker.ts:342/349/362)");
  it.todo("L3 — the behavioural floor keys on the seal's forebear discipline, not a primitives enum (behavioral_families.ts:5-13, floor :78)");
  it.todo("L4 — the current named players pass through the ritual like any other; a nick that alludes is permitted, the formal name is earned");
});

// ── MEMORY ───────────────────────────────────────────────────────────────────────────────────────
describe("M — notes belong to the player, in a store with its own ledger", () => {
  it.todo("M1 — a memory artifact inside a repo tree is a load_error (a NEW loader pass; today the loader walks a fixed directory list, loader.ts:258-657)");
  it("M2/G5 — every gig's final phase is REFLECTION, appended by the ENGINE after the chart's last phase", async () => {
    const ledger = new MemoryLedger();
    const outputs = createOutputStore(registry());
    await runGig(oneChair(), {}, { outputs, ledger, invoke, model_version: "m" });
    const seen = phasesSeen(ledger);
    // PROXY, stated: until a session-note type exists the subject is the engine's RESERVED phase name
    // in the spend rows. The chart under test declares no such phase, so a chart cannot satisfy this by
    // naming one (second review). When the note type lands, the subject becomes the sealed note.
    expect(oneChair().phases.some((p) => /reflect/i.test(p.name)), "fixture precondition: the chart declares no reflection phase").toBe(false);
    expect(seen.length, "the gig ran at least its one chart phase").toBeGreaterThan(0);
    expect(seen[seen.length - 1], `last phase played was "${seen[seen.length - 1]}" — reflection must come after the chart`).toBe("reflect");
    // Third review: an empty phase named "reflect" would green the line above. Reflection SEALS a note.
    expect(outputs.all().some((o) => o.domain_type === "session-note"), "reflection must seal a session-note record — a phase name alone is not a reflection").toBe(true);
  });
  it.todo("M3 — a session note references outputs by content_sha and never carries their text; consolidation is a SEALED act whose input_shas are the notes consumed, performed AT EVERY REFLECTION so a player is never seated carrying raw notes");
  it.todo("M4 — a seated player is handed its consolidated memory on the invoke ctx (runtime.ts:3660-3690, beside hydration); a player with none is handed NOTHING");
  it.todo("M5 — the player store is a GenomeStore-style port with its OWN ledger and output store on all three backings; cross-store refs are content_sha only and are not resolved by outputs.addRef");
});

// ── CHART ────────────────────────────────────────────────────────────────────────────────────────
describe("C — a chart is a chord progression", () => {
  it("C1 — a position names the MODE it needs, never who plays: NO shipped standard carries agent_slug on any chair (universal, every standard)", () => {
    const g = loadGenome(REPO);
    pinUniverse(g);
    const offenders: string[] = [];
    for (const s of g.standards.values()) {
      for (const p of s.phases) for (const c of p.chairs) if (c.agent_slug) { offenders.push(`${s.slug} ${p.name}/${c.role} -> ${c.agent_slug}`); break; }
    }
    expect(offenders, `${offenders.length} of ${g.standards.size} shipped standards still name who plays`).toEqual([]);
  });
  it.todo("C2 — a chart carrying methods, constraints, tool grants, tiers or caps is REFUSED (StandardSchema + the loader's standards pass)");
  it.todo("C4 — two kinds: a CHECK is deterministic and engine-run (today's evals, runtime.ts:4401-4418, zero inference) and stays on the chart as a named C2 exception; a JUDGEMENT needs a mind and is a VERIFY position G3 applies to; the word eval goes");
});

// ── SEAT AND PLAN ────────────────────────────────────────────────────────────────────────────────
describe("G — a gig is planned (a SEAT per position), played, and reflected on", () => {
  it("G1 — before performance a planner seals a gig-plan: the FIRST phase played is the plan, not the chart's first phase", async () => {
    const ledger = new MemoryLedger();
    const outputs = createOutputStore(registry());
    await runGig(oneChair(), {}, { outputs, ledger, invoke, model_version: "m" });
    const seen = phasesSeen(ledger);
    // Same proxy and the same guard as M2/G5: the chart declares no plan phase, and the subject is the
    // engine's reserved name exactly, not a pattern a chart author could satisfy with "plan-x".
    expect(oneChair().phases.some((p) => /plan/i.test(p.name)), "fixture precondition: the chart declares no plan phase").toBe(false);
    expect(seen[0], `first phase played was "${seen[0]}" — the plan must precede the chart`).toBe("plan");
    // Third review: an empty phase named "plan" would green the line above. A plan is a SEALED gig-plan.
    expect(outputs.all().some((o) => o.domain_type === "gig-plan"), "the planner must seal a gig-plan record — a phase name alone is not a plan").toBe(true);
  });
  it.todo("G2 — a seat whose position's needed mode the player's lineage does not support is refused AT PLAN (decidable there because the position carries `needs`; compose has no registry, composition.ts:464)");
  it("G3 — a seat that VERIFIES another seat's output cannot hold the same player: NO shipped standard seats one agent to judge an output it ITSELF produced (universal, every standard; chart-level form until step 4)", () => {
    // THE TIGHT FORM. Revision 2's law flagged any agent that emitted a non-Verdict anywhere AND a Verdict
    // anywhere in one standard. That is wider than the claim, and it was wrong on the shipped genome: in
    // software-change-v1, miles frames (change-decision) and then verifies change-plan + change-set —
    // BOTH produced by bill. That is a bandleader gating another player's work, which is the pattern this
    // repo's own bandleader embodies, not a player checking itself. The loose form counted five
    // violations and the spec repeated the number; a second review caught it. The claim is: the VERDICT
    // seat's inputs include a type the SAME agent produced. Three shipped standards do that today.
    const g = loadGenome(REPO);
    pinUniverse(g);
    const offenders: string[] = [];
    for (const s of g.standards.values()) {
      const producedBy = new Map<string, Set<string>>(); // type -> agents that emit it in this standard
      for (const p of s.phases) for (const c of p.chairs) if (c.agent_slug)
        for (const t of c.output_contract ?? []) producedBy.set(t, new Set([...(producedBy.get(t) ?? []), c.agent_slug]));
      for (const p of s.phases) for (const c of p.chairs) {
        if (!c.agent_slug || !(c.output_contract ?? []).some((t) => isVerdict(t, g))) continue;
        const own = (c.input_contract ?? []).filter((t) => producedBy.get(t)?.has(c.agent_slug!));
        if (own.length) offenders.push(`${s.slug} ${p.name}/${c.role}: ${c.agent_slug} judges its own [${own}]`);
      }
    }
    expect(offenders, `${offenders.length} shipped seat(s) judge their own output:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
  it("G4 — the plan is the ONLY source of per-seat capability: a seat no plan granted anything reaches NOTHING, whatever the player file says", async () => {
    // The AGENT is armed with Read. Under 1.0 the agent is not where a grant lives, so the seat must see
    // nothing. Today ctx.allowed_tools is derived from the agent (via the #568 ceiling) — red on the
    // agent still being the source.
    const std = oneChair(sensor({ allowed_tools: ["Read"] } as never));
    let seen: readonly string[] | undefined | "never-invoked" = "never-invoked";
    const spy: AgentInvoker = (ctx) => { seen = ctx.allowed_tools; return { t: "x", source: "fixture://one-point-oh" }; };
    await runGig(std, {}, { outputs: createOutputStore(registry()), ledger: new MemoryLedger(), invoke: spy, model_version: "m" });
    // Second review: the first draft asserted `seen ?? []`, so DELETING the ctx wire (undefined) made it
    // green with no plan in existence — a red law that passes on wire-cut. The seat must be HANDED an
    // explicit empty grant: defined, and empty. Absent is not none; absent is a cut wire.
    expect(seen, "the invoker was reached").not.toBe("never-invoked");
    expect(seen, "the seat must be HANDED its grant — an undefined ctx.allowed_tools is a cut wire, not an empty plan").toBeDefined();
    expect(seen, "no plan granted this seat anything — the player file is not a grant").toEqual([]);
  });
  it.todo("G5 — reflection is appended by the engine, never declared on a chart (executable form under M2/G5)");
  it.todo("G6 — re-seating after the seal is a SEALED AMENDMENT by the ENGINE (expansion runtime.ts:1791, rungs :2829-2834/:2752, and REFLECTION — one seat per player that played, fixed engine grant) or an OFFICE (approval worker.ts:122-128) — and no one else; the planner's frame is final once sealed");
  it.todo("G7 — the plan is part of run identity: its content_sha enters RunIdentity (reuse.ts:116-136), the checkpoint key becomes (plan_sha, seat) (:215), and ClaimedGig carries the plan (worker.ts:102); a QUEUED gig is planned AT ENQUEUE by a resident planner of the queueing institution — the drain executes and never plans");
});

// ── TOURS ────────────────────────────────────────────────────────────────────────────────────────
describe("T — a booking names an office", () => {
  it.todo("T1 — a Booking (tours/*.json, today responsible_chair) names the OFFICE responsible; whoever holds it by residency at performance time is accountable; a booking whose office has NO incumbent at performance PARKS, like a human chair with no approval");
});

// ── RESIDENCY ────────────────────────────────────────────────────────────────────────────────────
describe("R — a player holds an OFFICE by residency, and can be removed", () => {
  it.todo("R1 — a player is seated only through a CURRENT residency in the gig's institution; the plan resolves position -> player THROUGH residency (institutions/quartet.json chairs :141, assignments :360)");
  it.todo("R2 — a residency grants OFFICES, not capabilities — with ONE named exception: the PLANNER's office carries a fixed grant sealed by the governor, because it creates seats and is the one seat in no plan; the dispatch grant (DispatchCapGrantSchema, genome_schema.ts:843) moves onto it");
  it.todo("R3 — ending a residency is a sealed act; memory stays the player's, outputs stay the institution's; a departed player cannot carry the institution's text out (closes first-draft open question 3)");
  it.todo("R4 — the first planner is seated by residency granted directly by the governor's office, not by a plan (closes first-draft open question 1)");
  it.todo("R5 — a human holding an office is a residency too (kind: human); removal works identically");
  it.todo("R6 — hydration slots bound 'at seat time' (p.chair.supplies, runtime.ts:3669) bind at PLAN time from the office's supplies through the seat");
});

// ── MODEL AGNOSTICISM ────────────────────────────────────────────────────────────────────────────
describe("A — nothing a player carries is shaped to a model", () => {
  it.todo("A1 — no model name, model-specific prompt grammar or invoker session artefact in the player record, lineage seal, skills or memory");
  it.todo("A2 — the SEAT names the model; resolveModel(tier, fallback) (claude_invoker.ts:38) reads the seat and nothing else");
  it.todo("A3 — memory is written in the invoker-neutral note shape, never as a model session; sessionUuidFor / --resume is an invoker optimisation WITHIN a gig; a ladder rung starts COLD — fresh seat, same inputs, the failing verdict as its only extra, no mid-gig note");
  it.todo("A4 — reflection runs under whichever door played the gig and produces the same note shape (completions transcripts: spec_completions_seat_transcript)");
});

// ── STORES ───────────────────────────────────────────────────────────────────────────────────────
describe("S — every object on every backing", () => {
  it.todo("S1 — player, lineage seal, gig-plan, plan-amendment, seat, residency, session note, consolidated memory each have a row shape on file, PostgREST and RPC (genome_store.ts:41 GenomeClass; :113-115 Q.agents; :292 defineAgent) — genome_browse_parity extended");
});

// ── TURN ─────────────────────────────────────────────────────────────────────────────────────────
describe("U — a request is a gig; turn closure is deterministic", () => {
  it.todo("U1 — every request to the engine is a gig with the three movements (plan, perform, reflect); work outside one is not the engine's work");
  it.todo("U2 — turn closure IS the sealed reflection (the fifth engine amendment); a turn is closed when its reflection is sealed and not before, and never left open");
  it.todo("U3 — a turn that cannot reach reflection is a FAILED gig with a sealed reason — never an open one, never a quiet success");
});

// ── THE HASH, SAID ONCE ──────────────────────────────────────────────────────────────────────────
describe("H — the hash changes meaning once, and identity survives the break", () => {
  it.todo("H1 — every existing genome_hash and run_fingerprint changes meaning on the day this lands; genome_hash_stability.test.ts:101-106 flips; genome_hash is never waived at resume (reuse.ts:168) so every live checkpoint dies with it; the 1.0 release says so first");
  it.todo("H2 — a sealed slug -> player_id table maps every 0.x ledger row, checkpoint and genome/history/<slug>/ path onto a uuid player; unmapped rows are REPORTED, never guessed");
});
