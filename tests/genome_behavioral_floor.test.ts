// The genome behavioral FLOOR — "loads cleanly" and "functions" are different bars.
//
// The completeness gate (GenomeIncompleteError) forces behavioral fields to be PRESENT;
// this suite forces them to be MEANINGFUL. It is the enforcement half of the behavioral
// families (tests/_support/behavioral_families.ts): every agent must carry, verbatim,
// the constraint families its primitives and substrate owe — that's inheritance that
// cannot drift, without an engine-level extends mechanism.
//
// RED-first: written against the migration stubs (method = "Carry out the <X> role: ...",
// constraints = [], no grants) that passed the load gate while leaving every agent
// behaviorally hollow — the gap a live patent-triage run surfaced when novelty-searcher
// emitted a recalled citation shaped like a retrieval.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLOOR,
  RETRIEVAL,
  JUDGE_FAMILY,
  MAKER,
  VERIFY_FAMILY,
  SHAPER,
  EXTERNAL_SUBSTRATE,
  GRANT_REQUIRED,
  METHOD_STUB_RE,
} from "./_support/behavioral_families.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface GenomeAgent {
  slug: string;
  primitives: string[];
  description?: string;
  identity: string;
  method: string;
  constraints: string[];
  allowed_tools?: string[];
  code_tool_access?: string;
}

const agents: GenomeAgent[] = readdirSync(join(REPO, "agents"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(REPO, "agents", f), "utf8")) as GenomeAgent);

// What each agent owes, derived from what it already declares — no new taxonomy.
function owedFamilies(a: GenomeAgent): Array<{ name: string; strings: readonly string[] }> {
  const owed: Array<{ name: string; strings: readonly string[] }> = [{ name: "floor", strings: FLOOR }];
  if (EXTERNAL_SUBSTRATE[a.slug]) owed.push({ name: "retrieval", strings: RETRIEVAL });
  if (a.primitives.includes("JUDGE")) owed.push({ name: "judge", strings: JUDGE_FAMILY });
  if (a.primitives.includes("CREATE")) owed.push({ name: "maker", strings: MAKER });
  if (a.primitives.includes("VERIFY")) owed.push({ name: "verify", strings: VERIFY_FAMILY });
  if (a.primitives.includes("INTERPRET") && a.primitives.includes("PLAN") && !a.primitives.includes("CREATE"))
    owed.push({ name: "shaper", strings: SHAPER });
  return owed;
}

describe("every genome agent clears the behavioral floor", () => {
  it("the genome has agents to audit", () => {
    expect(agents.length).toBeGreaterThanOrEqual(19);
  });

  for (const a of agents) {
    describe(a.slug, () => {
      it("method is a real step-by-step, not a restatement of the name", () => {
        expect(a.method, "method is the migration stub").not.toMatch(METHOD_STUB_RE);
        expect(a.method, "method must differ from identity").not.toBe(a.identity);
        // a method is steps: at least three numbered steps
        const steps = a.method.match(/(^|\n)\s*\d+[.)]\s/g) ?? [];
        expect(steps.length, "method needs >=3 numbered steps").toBeGreaterThanOrEqual(3);
      });

      it("identity is authored prose, not the description field recycled", () => {
        expect(a.identity.length).toBeGreaterThanOrEqual(60);
        expect(a.identity, "identity must not be the bare description").not.toBe(a.description ?? "");
      });

      it("carries every constraint family its primitives + substrate owe", () => {
        for (const fam of owedFamilies(a)) {
          for (const s of fam.strings) {
            expect(a.constraints, `missing ${fam.name} constraint: "${s.slice(0, 60)}…"`).toContain(s);
          }
        }
      });

      if (GRANT_REQUIRED.includes(a.slug)) {
        it(`has a real tool grant (substrate: ${EXTERNAL_SUBSTRATE[a.slug] ?? "coltrane MCP actions"})`, () => {
          expect(a.allowed_tools ?? [], "tool-using agent with an empty cage").not.toEqual([]);
        });
      }

      if ((a.allowed_tools ?? []).length > 0) {
        it("a tool grant carries a turn cap — an unbounded tool-using child can wedge the gig", () => {
          const cap = (a as { max_tool_calls?: number }).max_tool_calls;
          expect(cap, "granted agent missing max_tool_calls").toBeTypeOf("number");
          expect(cap!).toBeGreaterThan(0);
        });
      }

      it("tool grant and code_tool_access are consistent (the grant IS the policy)", () => {
        const tools = a.allowed_tools ?? [];
        const access = a.code_tool_access ?? "none";
        if (tools.some((t) => t.startsWith("Bash"))) {
          expect(access, "Bash granted but code_tool_access denies it").toBe("full");
        } else if (tools.some((t) => ["Read", "Glob", "Grep"].includes(t.split("(")[0]!))) {
          expect(["read", "write", "full"], "Read-class tools granted but code_tool_access denies them").toContain(access);
        }
      });
    });
  }
});
