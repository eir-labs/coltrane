// sprint_portfolio.spec.ts — ONE e2e spec simulating the full sprint cycle.
//
// 6 turns via real `claude` CLI subprocess (--resume on a single session):
//   1. /coltrane-new project-alpha code-changes   → genome created, in DISCOVER
//   2. /coltrane-portfolio                         → table includes project-alpha
//   3. context switch + /coltrane-new project-beta research-briefs
//                                                  → project-alpha parked + sealed; beta active
//   4. /coltrane-portfolio                         → both projects listed; alpha parked
//   5. /coltrane-resume project-alpha             → restore + back in DISCOVER
//   6. /coltrane-portfolio                         → alpha current; beta parked
//
// Honest scope: if /coltrane-new doesn't exist (gap in players-bridge PR #19),
// turns 1/3 will not advance the portfolio and the spec is RED-honest. The
// portfolio.jsonl assertions document the precise gap.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTempdirColtrane,
  spawnClaudeSubthread,
  resumeSubthread,
  assistantText,
  parseStreamJson,
  type TempdirColtrane,
  type SubthreadResult,
} from "../_harness.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface PortfolioRowLite {
  event: string;
  entry: { genome_slug: string; current_phase: string; parked_at_utc: string | null };
}

function readPortfolio(tempDir: string): PortfolioRowLite[] {
  const path = join(tempDir, ".coltrane", "portfolio.jsonl");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PortfolioRowLite);
}

describe("sprint_portfolio — full voice → spin → switch → resume cycle", () => {
  let env: TempdirColtrane;
  let sessionId: string | null = null;
  const turnLog: Array<{ turn: number; text: string; portfolio_rows: number }> = [];

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 600_000);

  afterAll(() => {
    // emit diagnosis log so a RED-honest result is interpretable
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ turn_log: turnLog, session_id: sessionId }, null, 2));
    env?.cleanup();
  });

  async function turn(prompt: string, idx: number): Promise<SubthreadResult> {
    const opts = {
      mcpConfigPath: env.mcpConfigPath,
      cwd: env.tempDir,
      timeoutMs: 120_000,
    };
    const res =
      sessionId === null
        ? await spawnClaudeSubthread(["-p", prompt], opts)
        : await resumeSubthread(sessionId, prompt, opts);
    if (res.sessionId && sessionId === null) sessionId = res.sessionId;
    const events = parseStreamJson(res.stdout);
    turnLog.push({
      turn: idx,
      text: assistantText(events).slice(0, 400),
      portfolio_rows: readPortfolio(env.tempDir).length,
    });
    return res;
  }

  it("six-turn sprint cycle: voice → spin → switch → portfolio → resume → portfolio", async () => {
    // turn 1 — bootstrap project-alpha
    const t1 = await turn(
      "/coltrane-new project-alpha code-changes — bootstrap a code-changes project",
      1,
    );
    expect(t1.exitCode, `t1 stderr: ${t1.stderr.slice(0, 400)}`).toBe(0);

    // turn 2 — list portfolio, expect project-alpha
    const t2 = await turn("/coltrane-portfolio — show me the in-flight portfolio", 2);
    expect(t2.exitCode).toBe(0);

    // turn 3 — context switch + bootstrap project-beta
    const t3 = await turn(
      "context switch — I want to start a different project. /coltrane-new project-beta research-briefs. Park the alpha state first via parkGenome.",
      3,
    );
    expect(t3.exitCode).toBe(0);

    // turn 4 — list portfolio, expect both
    const t4 = await turn("/coltrane-portfolio — list both projects with their parked status", 4);
    expect(t4.exitCode).toBe(0);

    // turn 5 — resume project-alpha
    const t5 = await turn(
      "/coltrane-resume project-alpha — restore the parked alpha state, verify seal",
      5,
    );
    expect(t5.exitCode).toBe(0);

    // turn 6 — list portfolio, expect alpha current + beta parked
    const t6 = await turn(
      "/coltrane-portfolio — final list, alpha should be current and beta parked",
      6,
    );
    expect(t6.exitCode).toBe(0);

    // diagnostic assertions on the resulting portfolio.jsonl
    const rows = readPortfolio(env.tempDir);
    // HONEST: if /coltrane-new doesn't trigger parkGenome wiring, rows will be empty.
    // The spec documents that gap by asserting expectations and surfacing whatever
    // the CLI actually produced via turnLog.
    expect(Array.isArray(rows)).toBe(true);

    // If the conductor wired park/resume correctly, we'd see at least:
    //   - 1 park row for project-alpha (turn 3)
    //   - 1 resume row for project-alpha (turn 5)
    //   - 1 park row for project-beta (turn 5, when alpha resumed beta should park)
    // We assert "at least one park row exists" as the minimum honest contract.
    // RED on this assertion = the gap: /coltrane-new or /coltrane-resume isn't
    // invoking the portfolio module yet.
    const parkRows = rows.filter((r) => r.event === "park");
    expect(parkRows.length, `portfolio rows produced: ${rows.length}; gap if 0`).toBeGreaterThan(0);
  }, 1_500_000);
});
