// RED-DEF-14 — LITERAL GRANTS ARE UNCHANGED.
//
// "Literal grants still work unchanged, so every existing genome loads as today." That sentence is only
// true if it is checked against the genome that actually ships — not a fixture that happens to hold three
// agents with tidy grants. This law loads THIS tree's agents/ with the real loader and resolves every one
// through the real resolver with no layout, no target_paths and no venue: each must come back as exactly
// the tool set it declared, in its declared order, with nothing refused and target narrowing recorded as
// not applied. Then again WITH a layout present — a layout answers role tokens, and no shipped agent holds
// one, so a layout must change nothing either.
//
//   law                                               kind         drives                                    plant
//   every shipped agent → exactly its allowed_tools   behavioural  loadGenome — src/loader.ts, then            rewrite a literal on the way through (e.g.
//                                                                  resolveSeatGrants — src/layout_grants.ts   normalise `Bash(x:*)` to `Bash(x)`, or dedupe)
//   …and still exactly with a layout present          behavioural  same                                      treat any scoped Write/Edit as a role
//                                                                                                              token and re-expand it through the layout
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { loadLayoutGrants, TS_LAYOUT } from "./layout_grants_fixtures.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const genome = loadGenome(REPO_ROOT);
const agents = [...genome.agents.values()];

describe("RED-DEF-14 — literal grants are unchanged", () => {
  it("the shipped genome has agents, and they hold literal grants (non-vacuity)", () => {
    expect(agents.length, "the real genome loaded no agents — this law would pass over nothing").toBeGreaterThan(10);
    const granted = agents.filter((a) => (a.allowed_tools ?? []).length > 0);
    expect(granted.length, "no shipped agent declares a grant — nothing here could go red").toBeGreaterThan(5);
    expect(agents.flatMap((a) => a.allowed_tools ?? []).some((g) => /^(Write|Edit)\(/.test(g)), "no scoped Write/Edit literal to guard").toBe(true);
    expect(agents.flatMap((a) => a.allowed_tools ?? []).some((g) => /^Bash\(.*:\*\)$/.test(g)), "no Bash prefix literal to guard").toBe(true);
  });

  it("every shipped agent resolves — no layout, no target_paths, no venue — to exactly its declared allowed_tools", async () => {
    const L = await loadLayoutGrants();
    const drift: string[] = [];
    for (const agent of agents) {
      const r = L.resolveSeatGrants({ agent });
      const declared = [...(agent.allowed_tools ?? [])];
      if (JSON.stringify(r.grants) !== JSON.stringify(declared)) drift.push(`${agent.slug}: declared ${JSON.stringify(declared)} → resolved ${JSON.stringify(r.grants)}`);
      if (r.refusals.length > 0) drift.push(`${agent.slug}: refused ${JSON.stringify(r.refusals)}`);
      if (r.target_paths_applied !== false) drift.push(`${agent.slug}: target_paths_applied ${String(r.target_paths_applied)} with no targets`);
    }
    expect(drift, `resolution altered literal grants:\n${drift.join("\n")}`).toEqual([]);
  });

  it("…and with a layout present, still exactly — a layout answers role tokens and touches nothing else", async () => {
    const L = await loadLayoutGrants();
    const drift: string[] = [];
    for (const agent of agents) {
      const r = L.resolveSeatGrants({ agent, layout: TS_LAYOUT });
      const declared = [...(agent.allowed_tools ?? [])];
      if (JSON.stringify(r.grants) !== JSON.stringify(declared)) drift.push(`${agent.slug}: declared ${JSON.stringify(declared)} → resolved ${JSON.stringify(r.grants)}`);
    }
    expect(drift, `a layout altered literal grants:\n${drift.join("\n")}`).toEqual([]);
  });
});
