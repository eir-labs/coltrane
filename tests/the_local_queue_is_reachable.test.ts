// THE LOCAL QUEUE HAS A FRONT DOOR.
//
// src/local_queue.ts shipped with 34 laws and correct concurrency, and NOTHING COULD REACH IT.
// `deps.queueGig` is consulted only inside callSurfaceTool's HOSTED branch, so a local caller's
// gig_dispatch spawns in-process and never touches a queue; and `workOnce` claims through
// `coltrane_drain_claim`, knowing nothing of a file backing. A storage engine no front door opens
// is the exact defect this codebase spent a day closing — a mechanism built, tested, documented,
// and not connected — so these laws are what stop that being true of the queue itself.
//
// What they pin is the OUTCOME a person can perform: enqueue a gig on one terminal, claim it on
// another, with no Supabase, no service origin and no cdk_ key. `COLTRANE_QUEUE_DIR` is the whole
// configuration, and its ABSENCE leaves today's behaviour exactly as it was.
//
// ONE RUNNER, NOT TWO. The most valuable law here is L5. `reside` already had to prove this about
// itself — residencyGigPath must BE workOnce, compared by referential identity — because two front
// doors that "agree on what a gig means" is a promise, while one shared symbol is a fact. A local
// claim path that grew its own runner would produce a second definition of what running a gig IS,
// and the two would drift silently. So: exactly one runGig in src/, and the local path calls it.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCli, USAGE, type CliIO } from "../src/cli.js";

/** runCli reads process.env directly, so a law about env-driven behaviour sets it and restores it.
 *  Deliberately NOT adding an env parameter to runCli purely to be testable: the production path
 *  reads the real environment, and a law that drives a different path proves less. */
async function withEnv<T>(over: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prior = new Map<string, string | undefined>();
  const drainish = ["COLTRANE_DRAIN_KEY", "COLTRANE_DRAIN_URL", "COLTRANE_INSTANCE", "COLTRANE_STORE_ANON", "COLTRANE_STORE_URL", "COLTRANE_QUEUE_DIR"];
  for (const k of drainish) { prior.set(k, process.env[k]); delete process.env[k]; }
  for (const [k, v] of Object.entries(over)) { prior.set(k, prior.has(k) ? prior.get(k) : process.env[k]); if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of prior) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
import { openLocalQueue, LOCAL_QUEUE_DIR_VAR } from "../src/local_queue.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function io(): CliIO & { stdout: string[]; stderr: string[] } {
  const o = { stdout: [] as string[], stderr: [] as string[] };
  return {
    out: (s: string) => o.stdout.push(s),
    err: (s: string) => o.stderr.push(s),
    stdout: o.stdout,
    stderr: o.stderr,
  } as CliIO & { stdout: string[]; stderr: string[] };
}

const roots: string[] = [];
const freshRoot = (): string => {
  const r = mkdtempSync(join(tmpdir(), "coltrane-reach-"));
  roots.push(r);
  return r;
};
const cleanup = (): void => {
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
};

describe("the local queue is reachable from a front door", () => {
  it("L0 the module and the env var exist — the law is not vacuous", () => {
    expect(typeof openLocalQueue).toBe("function");
    expect(LOCAL_QUEUE_DIR_VAR).toBe("COLTRANE_QUEUE_DIR");
  });

  it("L6 `enqueue` is a KNOWN cli verb — a door nobody can find is not a door", async () => {
    const o = io();
    // An unknown verb exits 2 and prints usage. A known one must not be rejected as unknown.
    const code = await runCli(["enqueue"], o);
    const said = [...o.stdout, ...o.stderr].join("\n");
    expect(said, "`enqueue` was rejected as an unknown command").not.toMatch(/unknown command "enqueue"/);
    expect(USAGE, "USAGE does not mention enqueue, so no reader learns the door exists").toMatch(/enqueue/);
    expect(code, "a bare `enqueue` with no standard slug should be a usage error, not a crash").toBe(2);
  });

  it("L1 `enqueue` puts a runnable row in the local queue", async () => {
    const root = freshRoot();
    const o = io();
    const code = await withEnv({ [LOCAL_QUEUE_DIR_VAR]: root }, () =>
      runCli(["enqueue", "demo-standard", "--input", JSON.stringify({ q: "x" })], o));
    expect(code, `enqueue failed: ${[...o.stdout, ...o.stderr].join(" ")}`).toBe(0);
    const rows = openLocalQueue(root).list();
    expect(rows.length, "enqueue reported success and the queue is empty").toBe(1);
    expect(rows[0]!.state, "the enqueued row is not queued").toBe("queued");
    expect(rows[0]!.gig_id, "the enqueued row has no gig_id").toBeTypeOf("string");
  });

  it("L2 `enqueue` with no queue dir REFUSES, naming the variable", async () => {
    const o = io();
    const code = await withEnv({}, () => runCli(["enqueue", "demo-standard"], o));
    expect(code, "enqueue with nowhere to write reported success").not.toBe(0);
    expect(
      [...o.stdout, ...o.stderr].join("\n"),
      "the refusal must name COLTRANE_QUEUE_DIR so the reader knows what to set",
    ).toMatch(/COLTRANE_QUEUE_DIR/);
  });

  it("L3 a row enqueued by the cli is the row a claim returns — round trip", async () => {
    const root = freshRoot();
    const o = io();
    await withEnv({ [LOCAL_QUEUE_DIR_VAR]: root }, () =>
      runCli(["enqueue", "demo-standard", "--input", JSON.stringify({ q: "round-trip" })], o));
    const claimed = await openLocalQueue(root).claim("worker-1");
    expect(claimed, "the cli wrote a row no worker can claim").not.toBeNull();
    expect(claimed!.standard_slug).toBe("demo-standard");
    expect((claimed!.input as { q?: string }).q).toBe("round-trip");
  });

  it("L4 both backings configured is a REFUSAL, not a guess", async () => {
    const root = freshRoot();
    const o = io();
    const code = await withEnv(
      { [LOCAL_QUEUE_DIR_VAR]: root, COLTRANE_DRAIN_URL: "https://example.invalid" },
      () => runCli(["enqueue", "demo-standard"], o));
    expect(code, "a caller with both backings set was silently given one of them").not.toBe(0);
    expect(
      [...o.stdout, ...o.stderr].join("\n"),
      "the refusal must say WHY rather than picking a precedence order",
    ).toMatch(/both|conflict/i);
  });

  it("L5 there is exactly ONE runGig in src/ — the local path must not fork the runner", () => {
    const defs: string[] = [];
    for (const f of readdirSync(SRC).filter((x) => x.endsWith(".ts"))) {
      const s = readFileSync(join(SRC, f), "utf8");
      if (/^export (?:async )?function runGig\b/m.test(s)) defs.push(f);
    }
    expect(
      defs,
      "a second runGig means two definitions of what running a gig IS, free to drift apart — " +
        "the failure `residencyGigPath` had to prove it did not commit",
    ).toEqual(["runtime.ts"]);
  });
});

import { afterAll } from "vitest";
afterAll(cleanup);
