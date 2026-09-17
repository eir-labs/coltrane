// RED — every door names the budget in dollars (contract O1 + I6).
//
//   I6 — `coltrane dispatch --budget 45` reaches runGig as { max_usd: 45 }; the run's own budget_state
//        then reports that ceiling in dollars. (The CLI usage already SAYS `--budget <dollars>` — the
//        green control in tests/spec_budget_is_dollars.test.ts LAW 0 — but the value it threads is an
//        append-unit `opening`, so the word and the wire disagree.)
//   O1 — the advertised MCP gig_dispatch schema names the field and its unit: today it is a bare
//        `budget: "object"`, documenting neither `max_usd` nor dollars.
//
// RED against today's src: src/cli.ts sets `args.budget = { opening }`, src/server.ts reads
// `budgetArg["opening"]`, so the ceiling never lands as `max_usd`; and MCP_TOOLS advertises budget as
// an untyped object.
import { describe, it, expect } from "vitest";
import { runCli, type CliIO } from "../src/cli.js";
import { MCP_TOOLS } from "../src/mcp.js";
import { budgetDeps, spendStandard, spendingInvoker } from "./_support/budget_dispatch.js";

function io(deps: CliIO["deps"]): CliIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout, stderr,
    out: (s: string) => stdout.push(s),
    err: (s: string) => stderr.push(s),
    deps,
  } as CliIO & { stdout: string[]; stderr: string[] };
}

describe("I6 — `coltrane dispatch --budget 45` reaches runGig as { max_usd: 45 }", () => {
  it("the ceiling threads through the CLI and lands as a dollar ceiling on the run's budget_state", async () => {
    const seen: string[] = [];
    const o = io(budgetDeps(spendStandard(1), spendingInvoker(0.01, seen)));
    const code = await runCli(["dispatch", "spend", "--budget", "45", "--wait", "--json"], o);
    expect(code, "the dispatch did not succeed").toBe(0);
    const data = JSON.parse(o.stdout.join("")) as { manifest?: { budget_state?: Record<string, unknown> } };
    const bs = data.manifest?.budget_state;
    expect(bs, "the synchronous dispatch returned no budget_state to check").toBeDefined();
    expect(bs?.["max_usd"], "`--budget 45` did not reach runGig as a dollar ceiling of 45").toBe(45);
    expect(bs?.["unit"], "the CLI's dollar budget was re-denominated into append-units on the way to runGig").toBe("usd");
  });
});

describe("O1 — the advertised MCP gig_dispatch schema names max_usd and its unit", () => {
  it("gig_dispatch's budget argument documents the dollar field, not a bare object", () => {
    const tool = MCP_TOOLS.find((t) => t.slug === "gig_dispatch");
    expect(tool, "gig_dispatch is not advertised at all").toBeDefined();
    const schema = JSON.stringify(tool?.input_schema ?? {});
    expect(schema, "the advertised budget schema does not name the max_usd field").toMatch(/max_usd/);
    expect(schema.toLowerCase(), "the advertised budget schema does not state its unit (usd/dollars)").toMatch(/usd|dollar/);
  });
});
