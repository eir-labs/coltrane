/** EVERY SHIPPED PLAYER IS COVERED BY THE SMOKE SPEC'S TASK TABLE.
 *
 *  CLAUDE.md states a rule that had nothing behind it: "Don't mutate base band players without
 *  updating their e2e test in lockstep", resting on "Each base player has an e2e test in tests/e2e/".
 *
 *  The test is real — tests/e2e/players_smoke.spec.ts parameterises one routing law over a
 *  PLAYER_TASKS table. But it spawns the REAL claude CLI, so it sits in the live-only exclusion list
 *  (tests/e2e/vitest.offline.config.ts) and never runs in `npm run verify` or in CI. A player could be
 *  added, renamed, or dropped and no gate in the default suite would notice. The rule was a habit.
 *
 *  THIS DOES NOT RUN THE PLAYERS — that costs real model spend, which is why the smoke spec is
 *  deferred and rightly so. It pins the COVERAGE instead: every file in agents/players/ has an entry
 *  in the task table, and every entry names a player that exists. So the live spec's reach is checked
 *  cheaply and continuously, even though the spec itself runs only when someone chooses to spend.
 *
 *  Reading a test file's source as data is an existing idiom here — tests/run_deps_parity.test.ts
 *  gates the runGig call sites by text-level parsing for the same reason: the fact being checked
 *  lives in source shape, not in runtime behaviour.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PLAYERS_DIR = join(process.cwd(), "agents", "players");
const SMOKE_SPEC = join(process.cwd(), "tests", "e2e", "players_smoke.spec.ts");

/** Player slugs as SHIPPED — one markdown subagent definition per file. */
function shippedPlayers(): string[] {
  return readdirSync(PLAYERS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

/** Player slugs the smoke spec's PLAYER_TASKS table actually drives. */
function coveredPlayers(): string[] {
  const src = readFileSync(SMOKE_SPEC, "utf8");
  const table = /const PLAYER_TASKS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src)?.[1] ?? "";
  return [...table.matchAll(/slug:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]!).sort();
}

describe("every shipped base player is covered by the smoke spec", () => {
  const shipped = shippedPlayers();
  const covered = coveredPlayers();

  it("both sides are non-empty — the law is not vacuous", () => {
    expect(shipped.length, "agents/players/ must ship players").toBeGreaterThan(0);
    expect(covered.length, "PLAYER_TASKS must parse — if this is 0 the table's shape changed").toBeGreaterThan(0);
  });

  it("no shipped player is missing from the task table", () => {
    const uncovered = shipped.filter((p) => !covered.includes(p));
    expect(
      uncovered,
      `these players ship in agents/players/ but no PLAYER_TASKS entry drives them: [${uncovered.join(", ")}]. ` +
        `CLAUDE.md says every base player has an e2e test and that they must not be mutated without ` +
        `updating it — add a task entry, or stop shipping the player.`,
    ).toEqual([]);
  });

  it("no task entry names a player that no longer ships", () => {
    const orphaned = covered.filter((p) => !shipped.includes(p));
    expect(
      orphaned,
      `PLAYER_TASKS drives [${orphaned.join(", ")}] but no such file exists in agents/players/. ` +
        `A task for a deleted player passes vacuously in the live run and hides that the roster shrank.`,
    ).toEqual([]);
  });
});
