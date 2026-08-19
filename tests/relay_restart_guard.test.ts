// venue/8 — server_restart must never SILENTLY kill a running gig.
//
// WHAT HAPPENS TODAY, and what these laws forbid: the relay intercepts server_restart and SIGTERMs
// its child with NO preflight. Gigs run inside that child and chairs are spawned as its children,
// so the kill is total — every in-flight gig and seated chair dies mid-phase, its already-sealed
// outputs banked, and NOTHING marks it dead. A killed gig leaves no record saying it was killed:
// that absence is the defect, the same fail-OPEN-on-a-destructive-path class as `void venue;`.
//
// MEASURED, NOT REASONED: two publish seats died exactly this way — gigs 8146142e and 18726459 —
// with a passing verdict and no `result` event in their logs. 18726459's publish seat last wrote at
// 16:23; a restart was issued seconds before 16:23:58. A SILENT KILL is precisely what today's code
// does, and it is what Law A below FAILS on: on unguarded code the fixture child is killed and no
// gig-naming error comes back, so both the "child survives" and the "error names the gig"
// assertions fail — the defect reproduced.
//
// The relay holds NO gig state (a stdio proxy — zero references to gigs or the runtime). So it must
// ASK the child (reserved JSON-RPC methods) before it kills it, and handle a child that does NOT
// answer. These laws drive the REAL relay over stdio via tests/_support/relay_host.ts against node
// fixtures — no model, no cost, no dist.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable, Readable } from "node:stream";
import { RUNNING_GIGS_METHOD, ABORT_FOR_RESTART_METHOD, PREFLIGHT_TIMEOUT_MS } from "../src/server_relay.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_HOST = join(REPO_ROOT, "tests", "_support", "relay_host.ts");

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * A stand-in for the coltrane server child that answers the relay's reserved restart-guard methods
 * from a config file the test owns:
 *   • RUNNING_GIGS_METHOD  → replies { running: cfg.running } — the pre-restart gig check.
 *                            When cfg.hangOnPreflight it NEVER replies (the unresponsive-child case).
 *   • ABORT_FOR_RESTART    → appends a `gig_abort` row naming each running gig to cfg.ledgerPath,
 *                            then replies { aborted: cfg.running } — the force path's record.
 *   • initialize + any other request → a minimal { ok } reply, so the handshake completes and any
 *     post-refusal liveness check is ANSWERED by this same (un-killed) child.
 * Boots are counted through a file (each boot is a separate process) so a test can prove the child
 * was — or was NOT — swapped. The method names are interpolated from the relay's own exports, so a
 * rename of the wire protocol breaks the fixture rather than silently passing.
 */
function childFixture(
  dir: string,
  cfg: { running: string[]; hangOnPreflight?: boolean; ledgerPath?: string },
): string {
  const entry = join(dir, "entry.mjs");
  const counter = join(dir, "boots");
  const cfgPath = join(dir, "cfg.json");
  writeFileSync(cfgPath, JSON.stringify({
    running: cfg.running,
    hangOnPreflight: !!cfg.hangOnPreflight,
    ledgerPath: cfg.ledgerPath ?? null,
  }));
  writeFileSync(entry, [
    'import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    `const counter = ${JSON.stringify(counter)};`,
    `const cfgPath = ${JSON.stringify(cfgPath)};`,
    `const RUNNING_GIGS = ${JSON.stringify(RUNNING_GIGS_METHOD)};`,
    `const ABORT_FOR_RESTART = ${JSON.stringify(ABORT_FOR_RESTART_METHOD)};`,
    'const boots = existsSync(counter) ? Number(readFileSync(counter, "utf-8")) : 0;',
    'writeFileSync(counter, String(boots + 1));',
    'const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));',
    'const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");',
    'const rl = createInterface({ input: process.stdin });',
    'rl.on("line", (line) => {',
    "  let m; try { m = JSON.parse(line); } catch { return; }",
    "  if (m.id === undefined || m.method === undefined) return; // notification",
    "  if (m.method === RUNNING_GIGS) {",
    "    if (cfg.hangOnPreflight) return; // never answer — the unresponsive-child case (Law C)",
    "    return send(m.id, { running: cfg.running });",
    "  }",
    "  if (m.method === ABORT_FOR_RESTART) {",
    "    if (cfg.ledgerPath) for (const gid of cfg.running) {",
    '      appendFileSync(cfg.ledgerPath, JSON.stringify({ event: "gig_abort", subject_gig_id: gid, reason: "server_restart override" }) + "\\n");',
    "    }",
    "    return send(m.id, { aborted: cfg.running });",
    "  }",
    "  // initialize + tools/call system_health + anything else: answer so the handshake completes",
    "  // and a post-refusal liveness check lands on this SAME child.",
    "  send(m.id, { ok: true, method: m.method });",
    "});",
    "",
  ].join("\n"));
  return entry;
}

function rpc(child: Child) {
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    try {
      const m = JSON.parse(line) as Record<string, unknown>;
      const id = m["id"];
      if (typeof id === "number" && pending.has(id)) { pending.get(id)!(m); pending.delete(id); }
    } catch { /* non-json */ }
  });
  return {
    request(id: number, method: string, params: unknown, timeoutMs = 20_000): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout: ${method} id=${id} — the relay never answered (HANG)`)),
          timeoutMs,
        );
        pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify(method: string, params: unknown): void {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
  };
}

const INIT_PARAMS = { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "restart-guard-test", version: "0" } };

describe("venue/8 — server_restart cannot silently kill a running gig", () => {
  let host: Child | undefined;
  let dir: string | undefined;
  afterEach(() => {
    host?.kill("SIGKILL");
    host = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function boot(cfg: { running: string[]; hangOnPreflight?: boolean; ledgerPath?: string }) {
    dir = mkdtempSync(join(tmpdir(), "coltrane-restart-guard-"));
    const entry = childFixture(dir, cfg);
    host = spawn("npx", ["tsx", RELAY_HOST, entry], { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] }) as Child;
    host.stderr.resume(); // an unread stderr pipe is its own deadlock; the relay logs on it
    const c = rpc(host);
    await c.request(1, "initialize", INIT_PARAMS, 60_000); // first request pays the tsx cold start
    c.notify("notifications/initialized", {});
    return c;
  }

  it("Law A — a restart with a gig in flight is REFUSED, naming it, and the child is NOT killed", async () => {
    // The measured casualties: publish seats for gigs 8146142e and 18726459, killed mid-work with a
    // passing verdict and no result event. On UNGUARDED code this law fails RED — the fixture child
    // is SIGTERMed with no preflight and no gig-naming error is returned, reproducing the silent kill.
    const c = await boot({ running: ["8146142e"] });

    const restart = await c.request(2, "tools/call", { name: "server_restart", arguments: {} });
    expect(
      restart["result"],
      "the relay killed a child with a gig in flight and answered success — a silent kill, exactly " +
        "what gigs 8146142e and 18726459 suffered",
    ).toBeUndefined();
    expect(restart["error"], "a restart with a gig in flight must come back as a refusal").toBeDefined();
    const msg = String((restart["error"] as { message: string }).message);
    expect(msg).toMatch(/REFUSED/);
    expect(msg, "the refusal must NAME the running gig — a killed gig stops being an absence").toContain("8146142e");

    // The child was left untouched: no respawn, and it still serves.
    expect(
      readFileSync(join(dir!, "boots"), "utf-8"),
      "the child that reported a running gig was respawned — the restart guard must refuse, not kill",
    ).toBe("1");
    const after = await c.request(3, "tools/call", { name: "system_health", arguments: {} });
    expect(after["result"], "the child that held the running gig must still be alive after the refusal").toBeDefined();
  }, 120_000);

  it("Law C — an UNRESPONSIVE child refuses the restart in time and sends NO SIGTERM", async () => {
    // The relay holds no gig state, so a child that will not answer the pre-restart check is a child
    // whose in-flight work the relay cannot see. Assuming it is idle and killing it anyway is the
    // silent kill at the WORST moment — an unhealthy child is when a restart is most likely issued.
    const c = await boot({ running: [], hangOnPreflight: true });

    const started = Date.now();
    const restart = await c.request(2, "tools/call", { name: "server_restart", arguments: {} });
    const elapsed = Date.now() - started;

    expect(restart["result"]).toBeUndefined();
    expect(restart["error"], "a child that never answers the preflight must produce a refusal, not a SIGTERM").toBeDefined();
    expect(String((restart["error"] as { message: string }).message)).toMatch(/did not answer/i);
    expect(
      elapsed,
      `the unresponsive-child refusal took ${elapsed}ms; PREFLIGHT_TIMEOUT_MS is ${PREFLIGHT_TIMEOUT_MS}ms — ` +
        "the relay must give up ASKING and refuse, not hang forever waiting on a hung child",
    ).toBeLessThan(PREFLIGHT_TIMEOUT_MS + 4_000);

    // No SIGTERM: the child was not respawned and still answers non-preflight calls.
    expect(readFileSync(join(dir!, "boots"), "utf-8"), "the unresponsive child was killed — no SIGTERM must be sent").toBe("1");
    const after = await c.request(3, "tools/call", { name: "system_health", arguments: {} });
    expect(after["result"], "the child must still be alive after the refusal — nothing was killed").toBeDefined();
  }, 120_000);

  it("Law D — force=true aborts + LEDGERS each running gig BEFORE the child is swapped", async () => {
    const ledger = join((dir = mkdtempSync(join(tmpdir(), "coltrane-restart-guard-"))), "abort_ledger.jsonl");
    const entry = childFixture(dir, { running: ["3c0ffee0"], ledgerPath: ledger });
    host = spawn("npx", ["tsx", RELAY_HOST, entry], { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] }) as Child;
    host.stderr.resume();
    const c = rpc(host);
    await c.request(1, "initialize", INIT_PARAMS, 60_000);
    c.notify("notifications/initialized", {});

    expect(existsSync(ledger), "nothing should be recorded before the restart is even issued").toBe(false);

    const restart = await c.request(2, "tools/call", { name: "server_restart", arguments: { force: true } });
    expect(restart["result"], "force must still swap the child and answer success — the override is not a dead end").toBeDefined();
    expect(readFileSync(join(dir, "boots"), "utf-8"), "force restart must actually swap the child: a fresh boot").toBe("2");

    // THE PROOF: the killed gig is a RECORD, not an absence. The abort row was written by the OUTGOING
    // child on the abort-for-restart instruction, BEFORE the swap killed it.
    expect(
      existsSync(ledger),
      "force killed the gig but wrote no ledger row — a killed gig must be a fact in the chain, not an absence",
    ).toBe(true);
    const rows = readFileSync(ledger, "utf-8");
    expect(rows, "the ledger row must name the gig the override killed").toContain("3c0ffee0");
    expect(rows).toContain("gig_abort");
  }, 120_000);

  it("Law B — with nothing in flight, restart still swaps the child and the connection survives", async () => {
    // Closing the hole by breaking the nominal restart is not a fix — the same trap as a seat env
    // being airtight and unspawnable. This is the regression guard for the feature the change protects.
    const c = await boot({ running: [] });

    const restart = await c.request(2, "tools/call", { name: "server_restart", arguments: {} });
    expect(restart["error"], "a restart with nothing in flight must NOT be refused").toBeUndefined();
    expect(restart["result"], "restart must still swap the child when nothing is running").toBeDefined();
    expect(readFileSync(join(dir!, "boots"), "utf-8"), "the child must actually be swapped: a fresh boot").toBe("2");

    // The client's connection survived the swap: a following tools/call is answered by the fresh child.
    const after = await c.request(3, "tools/call", { name: "system_health", arguments: {} });
    expect(after["result"], "the client's connection must survive the swap — the whole reason the relay exists").toMatchObject({ ok: true });
  }, 120_000);
});
