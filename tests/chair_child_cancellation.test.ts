// RED — level 3 of the abort chain (#250) and the orphan half of #252.
//
//   #250 — `child` is a const inside spawnStreaming's promise executor. It is never returned,
//          registered, or exposed; the ONLY path reaching child.kill is the timeout closure.
//          So a cancellation signal has nowhere to attach and a live `claude` child cannot be
//          stopped by anything except its 10-minute wall clock.
//   #252 — server_restart SIGTERMs the server child. The server's own grandchildren (the
//          `claude` processes) are spawned without detached, are not in a separate process
//          group, and POSIX delivers them nothing — they keep running, orphaned, still billing.
//
// No model and no cost: tests/skill_execution.test.ts:52-70 already proves kill semantics are
// testable with a real `node` fixture that traps SIGTERM and a heartbeat marker whose mtime
// stops advancing once the child is genuinely dead. Same pattern, pointed at
// makeClaudeInvoker({ bin }).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeClaudeInvoker, killLiveChairChildren, liveChairChildCount } from "../src/claude_invoker.js";
import { testAgent } from "./_support/agents.js";

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

const dirs: string[] = [];
afterEach(async () => {
  // never leak a spinner out of this file, and don't let one test's dying child be counted by
  // the next test's liveChairChildCount assertion
  killLiveChairChildren(0);
  for (let i = 0; i < 100 && liveChairChildCount() > 0; i++) await sleep(20);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A stand-in for `claude`: an executable node script that REFUSES SIGTERM and writes a
 * heartbeat marker in a tight interval. If the invoker's kill path is missing (or stops at
 * a polite SIGTERM), the marker keeps advancing after the promise settles.
 * Self-caps at 8s so a RED run cannot leak a permanent spinner.
 */
function heartbeatBin(): { bin: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "coltrane-chairchild-"));
  dirs.push(dir);
  const marker = join(dir, "heartbeat.txt");
  const bin = join(dir, "fake-claude.mjs");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    `const marker = ${JSON.stringify(marker)};`,
    'process.on("SIGTERM", () => { /* refuse the polite kill */ });',
    "setInterval(() => writeFileSync(marker, String(Date.now())), 20);",
    "setTimeout(() => process.exit(0), 8000);",
    "",
  ].join("\n"));
  chmodSync(bin, 0o755);
  return { bin, marker };
}

/** A stand-in that answers like `claude --output-format stream-json` and exits 0. */
function answeringBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "coltrane-chairchild-ok-"));
  dirs.push(dir);
  const bin = join(dir, "fake-claude-ok.mjs");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    'process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify({ t: "ok" }) }) + "\\n");',
    "",
  ].join("\n"));
  chmodSync(bin, 0o755);
  return bin;
}

const ctx = () => ({
  agent: testAgent({ slug: "chair", primitives: ["SENSE"], output_types: ["note"] }),
  phase: "sense",
  inputs: [],
  gig_input: {},
});

async function waitForFile(path: string, ms = 6000): Promise<void> {
  const t0 = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - t0 > ms) throw new Error(`child never started (no ${path})`);
    await sleep(20);
  }
}

const mtime = (p: string): number => (existsSync(p) ? statSync(p).mtimeMs : 0);

describe("#250 level 3 — a cancellation signal kills the chair's child", () => {
  it("aborting the signal stops the child, escalating past a SIGTERM trap", async () => {
    const { bin, marker } = heartbeatBin();
    const ac = new AbortController();
    const invoke = makeClaudeInvoker({ bin, abort_grace_ms: 120 });

    const p = Promise.resolve(invoke({ ...ctx(), signal: ac.signal }));
    const settled = p.then(() => "resolved").catch((e: unknown) => String(e));
    await waitForFile(marker);

    const t0 = Date.now();
    ac.abort("operator cancel");
    const outcome = await settled;
    expect(outcome, "the invocation must reject with an abort-shaped error, not hang").toMatch(/abort/i);
    expect(
      Date.now() - t0,
      "the call must settle on the abort, not when the child happens to end on its own — " +
        "otherwise this passes against a no-op kill path (the fixture self-caps at 8s)",
    ).toBeLessThan(2000);

    await sleep(450); // past the grace, so the SIGKILL escalation has fired
    const t1 = mtime(marker);
    await sleep(600);
    expect(
      mtime(marker),
      "the heartbeat is still advancing => the child survived. spawnStreaming's `child` is a " +
        "const in the promise executor and the only path to child.kill is the timeout closure.",
    ).toBe(t1);
  }, 20000);

  it("a signal already aborted before the call never spawns a child at all", async () => {
    const { bin, marker } = heartbeatBin();
    const ac = new AbortController();
    ac.abort("pre-cancelled");
    const invoke = makeClaudeInvoker({ bin, abort_grace_ms: 50 });

    await expect(invoke({ ...ctx(), signal: ac.signal })).rejects.toThrow(/abort/i);
    await sleep(250);
    expect(existsSync(marker), "a pre-aborted chair must not spend a spawn").toBe(false);
  }, 15000);
});

describe("#252 — the server holds handles to its chair children so a shutdown is not an orphaning", () => {
  it("killLiveChairChildren stops an in-flight chair child", async () => {
    const { bin, marker } = heartbeatBin();
    const invoke = makeClaudeInvoker({ bin });
    const p = Promise.resolve(invoke(ctx()));
    const settled = p.then(() => "resolved").catch(() => "rejected");
    await waitForFile(marker);

    expect(liveChairChildCount(), "nothing registers a spawned child, so a shutdown cannot reach it").toBe(1);
    const t0 = Date.now();
    expect(killLiveChairChildren(120)).toBe(1);
    await settled;
    expect(
      Date.now() - t0,
      "the child outlived the shutdown and only ended on its own self-cap (8s) — a registry " +
        "that merely COUNTS children is not a registry that can stop them",
    ).toBeLessThan(2000);

    await sleep(450);
    const t1 = mtime(marker);
    await sleep(600);
    expect(mtime(marker), "the orphan is still running and still billing after the server was told to die").toBe(t1);
  }, 20000);

  it("a chair child that exits normally is de-registered (the registry is not a leak)", async () => {
    const invoke = makeClaudeInvoker({ bin: answeringBin() });
    const out = await invoke(ctx());
    expect(out).toEqual({ t: "ok" });
    expect(liveChairChildCount(), "a settled child must not be retained forever").toBe(0);
  }, 15000);
});
