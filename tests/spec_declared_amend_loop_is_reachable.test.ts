// A DECLARED AMEND LOOP MUST BE ABLE TO FIRE.
// (contract-declared-amend-loop-is-reachable-v1)
//
// THE MEASURED DEFECT (operator, 2026-09-19). `standards/patent-triage-v1.json` declares
// `max_examine_rounds: 3`. It has never once amended, and could not have.
//
// The runtime selects the makers to re-run like this (src/runtime.ts:2404-2412):
//
//     const producesArtifact = (c: Chair): boolean => {
//       const out = c.output_contract[0];
//       return !!out && (deps.outputs.coreTypeOf(out) ?? "") === "Artifact";
//     };
//     const makerSet = vch.depends_on.map(...).filter(... producesArtifact);
//     if (makerSet.length === 0) continue;   // ← silently, every round
//
// patent-triage-v1's `judge` depends on `search` (prior-art-hit → Signal), `map`
// (novelty-analysis → Interpretation), `examine` (examiner-rejection → Judgment) and `amend`
// (examine-round-record → Interpretation). Not one resolves to Artifact. `makerSet` is empty, the
// loop `continue`s, and the declared 3 rounds are a number nothing reads. Its `gate` chair is inert
// for the same reason. Of the six shipped standards that declare `max_examine_rounds`, five are
// genuinely reachable and this one is not — so the defect is not the mechanism, it is the join
// between the mechanism and the one caller that misses it.
//
// `tests/examine_amend_loop.test.ts` covers the mechanism with a SYNTHETIC standard whose maker
// outputs `artifact` (extends "Artifact"). So the loop has a passing law AND a shipped caller that
// never reaches it — CLAUDE.md's "a test proves a mechanism WORKS and nothing was asking whether it
// is REACHED", exactly.
//
// THE CONTRACT: declaring `max_examine_rounds` is a claim that this standard amends. A standard
// whose shape cannot drive the loop must not be able to make that claim silently. This is the same
// discipline the engine already applies to a tool grant with no provider and a required hydration
// slot nothing supplies: absent must DECLINE, never quietly stand in.
//
// THESE LAWS ARE RED BY DESIGN:
//   O1 — red on the shipped genome (patent-triage-v1).
//   O2 — red because composeStandard has no such refusal.
//   O3 — red because the runtime's selection rule is an inline closure that nothing else can read,
//        so a compose-time check would be a SECOND copy of the rule, free to drift from it. The
//        point of O3 is that there must be exactly one predicate with two callers — otherwise the
//        next person to widen the rule fixes the runtime and leaves the gate behind.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src";
import * as coltrane from "../src/index.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORES = new Set(["Signal", "Interpretation", "Judgment", "Plan", "Artifact", "Verdict"]);

interface ChairLike {
  role: string;
  depends_on?: string[];
  output_contract?: string[];
}

/** Resolve a domain type slug to the core type it ultimately extends, following the chain. */
function coreOf(genome: ReturnType<typeof loadGenome>, slug: string | undefined): string | null {
  let cur = slug;
  const seen = new Set<string>();
  while (cur && !CORES.has(cur)) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const t = genome.domain_types.get(cur) as { extends?: string } | undefined;
    cur = t?.extends;
  }
  return cur && CORES.has(cur) ? cur : null;
}

/** Every standard the repo ships that DECLARES an amend loop. */
function standardsDeclaringRounds(genome: ReturnType<typeof loadGenome>) {
  const out: { slug: string; rounds: number; chairs: ChairLike[] }[] = [];
  for (const [slug, def] of genome.standards) {
    const d = def as unknown as { max_examine_rounds?: number; phases?: { chairs: ChairLike[] }[] };
    if (!d.max_examine_rounds) continue;
    out.push({ slug, rounds: d.max_examine_rounds, chairs: (d.phases ?? []).flatMap((p) => p.chairs) });
  }
  return out;
}

describe("a standard that declares max_examine_rounds can actually amend", () => {
  it("O1 — every shipped standard declaring an amend loop has a verify chair with a maker to re-run", () => {
    const genome = loadGenome(REPO_ROOT);
    const declaring = standardsDeclaringRounds(genome);
    expect(declaring.length, "the repo ships standards that declare amend rounds; this law is derived, not hard-coded").toBeGreaterThan(0);

    const inert: string[] = [];
    for (const std of declaring) {
      const byRole = new Map(std.chairs.map((c) => [c.role, c] as const));
      const verifiers = std.chairs.filter((c) => coreOf(genome, c.output_contract?.[0]) === "Verdict");
      // A standard with no verify chair at all cannot start the loop either.
      const anyReachable = verifiers.some((v) =>
        (v.depends_on ?? []).some((r) => coreOf(genome, byRole.get(r)?.output_contract?.[0]) === "Artifact"),
      );
      if (!anyReachable) {
        const detail = verifiers.length === 0
          ? "no verify chair at all"
          : verifiers
              .map((v) => `${v.role}←[${(v.depends_on ?? []).map((r) => `${r}:${coreOf(genome, byRole.get(r)?.output_contract?.[0])}`).join(", ")}]`)
              .join(" ");
        inert.push(`${std.slug} (max_examine_rounds: ${std.rounds}) — ${detail}`);
      }
    }
    expect(
      inert,
      "a shipped standard declares an amend loop the runtime can never drive: src/runtime.ts:2404-2412 re-runs only depends_on members whose output_contract[0] resolves to core Artifact, finds none, and `continue`s every round — so the declared number is read by nothing and the standard has been running a single round while claiming otherwise",
    ).toEqual([]);
  });

  it("O2 — composeStandard REFUSES a standard that declares rounds no verify chair can drive", () => {
    const compose = (coltrane as unknown as { composeStandard?: (d: unknown) => unknown }).composeStandard;
    expect(compose, "composeStandard is exported").toBeTypeOf("function");

    // REAL agents from the shipped genome, and the REAL chair shapes of patent-triage-v1's
    // `examine` and `judge` — snapshotted here on purpose. `composeStandard` resolves agents from
    // the objects it is handed, so a fixture naming invented slugs dies on a TypeError long before
    // it reaches this contract, which would be a law failing for the wrong reason. Keeping a literal
    // copy also means this law still has a dead loop to refuse after the shipped file is corrected.
    const genome = loadGenome(REPO_ROOT);
    const examiner = genome.agents.get("patent-examiner");
    const judge = genome.agents.get("triage-judge");
    expect(examiner, "patent-examiner is in the genome").toBeDefined();
    expect(judge, "triage-judge is in the genome").toBeDefined();

    const dead = {
      slug: "dead-amend-loop-fixture",
      domain: "patent-triage",
      agents: [examiner!, judge!],
      max_examine_rounds: 3,
      phases: [
        {
          name: "work",
          chairs: [
            { role: "examine", agent_slug: "patent-examiner", depends_on: [], input_contract: [], output_contract: ["examiner-rejection"], required_skills: ["statutory-checklist"] },
            { role: "judge", agent_slug: "triage-judge", depends_on: ["examine"], input_contract: ["examiner-rejection"], output_contract: ["triage-verdict"], required_skills: ["citation-verify"] },
          ],
        },
      ],
      input_types: [],
      output_types: ["examiner-rejection", "triage-verdict"],
    };
    expect(
      () => compose!(dead),
      "a standard declaring max_examine_rounds whose only verify chair depends on no Artifact-producing maker composed cleanly — the declaration is a dead name and must fail closed at compose, exactly as an unresolvable tool grant and an unsupplied required hydration slot already do",
    ).toThrow(/amend|examine_rounds/i);
  });

  it("O3 — the runtime's maker selection and the compose-time gate read ONE exported predicate", () => {
    // Without a shared predicate the compose check is a second statement of the same rule, free to
    // drift from it. Whoever widens the runtime's notion of an amendable maker must not have to
    // remember to widen a gate somewhere else — that is the "rule that cannot fail is remembered,
    // not enforced" failure one level up.
    const fn = (coltrane as unknown as { amendableMakers?: unknown }).amendableMakers;
    expect(
      fn,
      "no `amendableMakers` is exported, so the amend-loop selection rule lives only as an inline closure in src/runtime.ts and any compose-time gate would be a copy of it",
    ).toBeTypeOf("function");
  });
});
