// THE LOCK ARTIFACT LIVES UNDER .coltrane/ AND IS NEVER COMMITTED.
//
// The lock file is a runtime artifact, not source: it belongs beside the ledger and the mirror
// under `<genomeRoot>/.coltrane/` (the house convention — ledger.ts:240, output_mirror.ts:72),
// which `.gitignore` already excludes. So a live run shows exactly one `repo-lock-*.json` under
// `.coltrane/`, that directory is gitignored, and a terminal outcome leaves NO lock litter.
//
// RED-first: no lock file is created before the implementation, so the existence assertion fails.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dispatchTool } from "../src/server.js";
import { freshGenomeDir, depsFor, gate, heldInvoke, pollSettled } from "./_support/repo_lock_fixtures.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const lockFiles = (dir: string): string[] => {
  try { return readdirSync(dir).filter((f) => /^repo-lock-.*\.json$/.test(f)); }
  catch { return []; } // ENOENT — no .coltrane/ yet == no lock file
};

describe("lock artifact placement — under .coltrane/, gitignored, and cleaned up on terminal", () => {
  it("writes one repo-lock artifact under .coltrane/ while running, ignored by git, and none after settle", async () => {
    const root = freshGenomeDir();
    const coltrane = join(root, ".coltrane");
    const g = gate();
    const d = depsFor(root, heldInvoke(g));
    const r = await dispatchTool("gig_dispatch", { standard_slug: "lock-demo", input: {} }, d);
    const gid = (r.data as { gig_id: string }).gig_id;

    // While the gig runs, exactly one lock artifact exists under .coltrane/.
    const running = lockFiles(coltrane);
    expect(running.length, "a running gig writes exactly one repo-lock-*.json under .coltrane/").toBe(1);

    // .coltrane/ is gitignored in this repo, so the artifact can never be committed.
    const ignoreLines = readFileSync(join(REPO, ".gitignore"), "utf8").split(/\r?\n/).map((s) => s.trim());
    expect(ignoreLines, ".coltrane/ must be gitignored so lock artifacts are never committed").toContain(".coltrane/");

    g.open();
    expect((await pollSettled(d, gid))["status"]).toBe("complete");

    // A terminal outcome leaves no lock litter behind.
    expect(lockFiles(coltrane).length, "a terminal gig leaves no repo-lock artifact behind").toBe(0);
  });
});
