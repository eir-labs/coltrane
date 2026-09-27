// RED-DEF-12 — A NEW REPOSITORY SHAPE NEEDS NO AGENT AMENDMENT.
//
// Today a new repository shape IS an agent amendment: to let the implementer write Swift, chancery had to
// widen its allowed_tools (000022/000023), and that widening then applied everywhere. After this change a
// layout declaring `ios/Sources/**` as source lets the SAME agent — the same file on disk, the same object
// in memory — write there. The agent is never touched; the repository says what its source is.
//
// This law runs the whole path the gig takes: the agent FILE and the layout FILE are loaded from one
// genome tree by the real loader, and the loaded layout resolves the loaded agent.
//
//   law                                           kind         drives                                          plant
//   the tree's layout, the tree's agent, ios/     behavioural  loadGenome — src/loader.ts, then                 resolve from the agent's own allowed_tools
//                                                              resolveSeatGrants — src/layout_grants.ts         alone, ignoring `layout`
//   the agent is not amended                      behavioural  resolveSeatGrants — src/layout_grants.ts         write the expansion back onto
//                                                                                                               agent.allowed_tools
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadGenome } from "../src/loader.js";
import type { Agent } from "../src/composition.js";
import { loadLayoutGrants, genomeTree, IMPLEMENTER_FILE, IOS_LAYOUT, TS_LAYOUT, deepFreeze } from "./layout_grants_fixtures.js";

describe("RED-DEF-12 — a new repository shape needs no agent amendment", () => {
  it("an iOS tree's layout lets the tree's own implementer write ios/Sources/** — the agent file never changed", async () => {
    const L = await loadLayoutGrants();
    const tree = genomeTree({ layout: IOS_LAYOUT, agents: [IMPLEMENTER_FILE] });
    const agentBytesBefore = readFileSync(join(tree, "agents", "implementer.json"), "utf8");
    const g = loadGenome(tree);
    expect(g.load_errors, JSON.stringify(g.load_errors)).toEqual([]);
    const agent = g.agents.get("implementer");
    expect(agent, "the tree's implementer did not load").toBeDefined();
    const layout = (g as unknown as { layout?: unknown }).layout;
    expect(layout, "the iOS tree's layout was not loaded onto the genome").toEqual(IOS_LAYOUT);

    const r = L.resolveSeatGrants({ agent: agent!, layout: layout as never });
    expect(r.refusals, JSON.stringify(r.refusals)).toEqual([]);
    expect(r.grants, "the iOS layout's source did not reach the seat").toContain("Write(ios/Sources/**)");
    expect(r.grants, "the iOS layout's tests did not reach the seat").toContain("Edit(ios/Tests/**)");
    expect(r.grants, "a role token leaked through unexpanded").not.toContain("Write(@source)");
    expect(readFileSync(join(tree, "agents", "implementer.json"), "utf8"), "resolution amended the agent file").toBe(agentBytesBefore);
  });

  it("the SAME agent object resolves per repository, and is never amended by resolving", async () => {
    const L = await loadLayoutGrants();
    const agent = deepFreeze({ ...(IMPLEMENTER_FILE as unknown as Agent), allowed_tools: [...(IMPLEMENTER_FILE["allowed_tools"] as string[])] });
    const snapshot = JSON.stringify(agent);
    const ios = L.resolveSeatGrants({ agent, layout: IOS_LAYOUT });
    const ts = L.resolveSeatGrants({ agent, layout: TS_LAYOUT });
    expect(ios.grants).toContain("Write(ios/Sources/**)");
    expect(ts.grants).toContain("Write(src/**)");
    expect(JSON.stringify(agent), "resolution rewrote the agent it was handed").toBe(snapshot);
  });
});
