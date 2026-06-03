// sleep — manual + nightly trigger for the bleach-wash that surfaces
// ratchet candidates from the last 24h of each Steve's audit.
//
// This file owns:
//   - sleepSteve(uuid)          → run one Steve's sleep cycle
//   - sleepAllSteves()          → fan out across all discovered Steves
//   - registerNightlySleep(ctx) → schedule a 3am-local-time recurring run
//
// The actual math lives in sleep_math_stub.ts → runSleep(). The parallel
// PR replaces that stub; this file's call sites stay stable.

import { mkdir, readdir, writeFile, appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runSleep } from "./sleep_math_stub.js";

export interface SleepReceipt {
  uuid: string;
  sleep_started_at: string;
  sleep_seal_sha: string;
  candidate_count: number;
  error?: string;
}

export interface SleepOptions {
  /** Optional override of runSleep (tests inject a fake). */
  run?: typeof runSleep;
  /** Now override — tests fix the clock. */
  now?: () => Date;
}

/** Sleep one Steve. Writes the receipt under
 * .coltrane/steve_<uuid>/sleep/receipt_<iso>.json and returns it. */
export async function sleepSteve(
  uuid: string,
  rootPath?: string,
  opts: SleepOptions = {},
): Promise<SleepReceipt> {
  const root = rootPath ?? process.cwd();
  const steveDir = join(root, ".coltrane", `steve_${uuid}`);
  const auditPath = join(steveDir, "audit.jsonl");
  const sleepDir = join(steveDir, "sleep");
  const now = (opts.now ?? (() => new Date()))();
  const startedAt = now.toISOString();

  // confirm the steve dir exists at all — error receipt if not
  try {
    await stat(steveDir);
  } catch {
    return {
      uuid,
      sleep_started_at: startedAt,
      sleep_seal_sha: "",
      candidate_count: 0,
      error: `steve_${uuid}/ not found under .coltrane/`,
    };
  }

  await mkdir(sleepDir, { recursive: true });

  const run = opts.run ?? runSleep;
  let receipt: SleepReceipt;
  try {
    const result = await run(uuid, auditPath, sleepDir);
    receipt = {
      uuid,
      sleep_started_at: startedAt,
      sleep_seal_sha: result.seal_sha,
      candidate_count: result.candidate_count,
    };
    if (result.seal_sha === "stub") {
      receipt.error = "sleep_math_not_yet_wired";
    }
  } catch (err) {
    receipt = {
      uuid,
      sleep_started_at: startedAt,
      sleep_seal_sha: "",
      candidate_count: 0,
      error: `sleep_failed: ${String(err)}`,
    };
  }

  // persist the receipt; iso has colons which are filesystem-fine on
  // macOS/linux. We swap colons to dashes anyway to be safe across hosts.
  const fname = `receipt_${startedAt.replace(/[:]/g, "-")}.json`;
  await writeFile(join(sleepDir, fname), JSON.stringify(receipt, null, 2) + "\n", "utf8");
  return receipt;
}

/** Discover all steve_<uuid> dirs under <root>/.coltrane and sleep each
 * in parallel. */
export async function sleepAllSteves(
  rootPath?: string,
  opts: SleepOptions = {},
): Promise<SleepReceipt[]> {
  const root = rootPath ?? process.cwd();
  const baseDir = join(root, ".coltrane");
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return [];
  }
  const uuids = entries
    .filter((e) => e.startsWith("steve_"))
    .map((e) => e.slice("steve_".length));
  return Promise.all(uuids.map((u) => sleepSteve(u, root, opts)));
}

// --- nightly scheduling ---

export interface OrchestratorContext {
  root: string;
  log: (event: Record<string, unknown>) => Promise<void>;
}

export interface NightlyHandle {
  cancel: () => void;
  /** Next scheduled fire (ms since epoch). Exposed for tests. */
  next_fire_at: number;
}

export interface NightlySleepOptions {
  /** Target hour (local time) — defaults to 3 (3am). */
  hour?: number;
  /** Now override for deterministic tests. */
  now?: () => Date;
  /** setTimeout/clearTimeout overrides — tests inject fakes. */
  set_timeout?: typeof setTimeout;
  clear_timeout?: typeof clearTimeout;
  /** Override of the actual sleep-all call (tests inject). */
  run_sleep_all?: () => Promise<SleepReceipt[]>;
}

/** Compute ms until the next occurrence of `hour:00` local time. If the
 * target hour today has already passed, return ms until tomorrow's. */
export function msUntilNextHour(now: Date, hour: number): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/** Register the nightly bleach-wash. Default fire: 3am local time daily.
 * Returns a handle whose .cancel() stops future fires. */
export function registerNightlySleep(
  ctx: OrchestratorContext,
  opts: NightlySleepOptions = {},
): NightlyHandle {
  const hour = opts.hour ?? 3;
  const nowFn = opts.now ?? (() => new Date());
  const st = opts.set_timeout ?? setTimeout;
  const ct = opts.clear_timeout ?? clearTimeout;
  const runAll = opts.run_sleep_all ?? (() => sleepAllSteves(ctx.root));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const schedule = (): number => {
    const now = nowFn();
    const ms = msUntilNextHour(now, hour);
    const fireAt = now.getTime() + ms;
    timer = st(() => {
      if (cancelled) return;
      void (async () => {
        try {
          const receipts = await runAll();
          await ctx.log({
            event: "nightly_sleep_complete",
            steves: receipts.length,
            errors: receipts.filter((r) => r.error).length,
          });
        } catch (err) {
          await ctx.log({ event: "nightly_sleep_error", error: String(err) });
        }
        if (!cancelled) {
          handle.next_fire_at = schedule();
        }
      })();
    }, ms);
    // node-side: don't keep the event loop alive just for this timer
    if (timer && typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    return fireAt;
  };

  const handle: NightlyHandle = {
    next_fire_at: 0,
    cancel: () => {
      cancelled = true;
      if (timer !== undefined) ct(timer);
    },
  };
  handle.next_fire_at = schedule();
  return handle;
}

/** Helper used by orchestrator + manual CLI: append a sleep audit line to
 * each Steve's audit.jsonl noting a manual sleep was kicked off. */
export async function noteSleepInAudit(
  rootPath: string,
  receipt: SleepReceipt,
): Promise<void> {
  const auditPath = join(rootPath, ".coltrane", `steve_${receipt.uuid}`, "audit.jsonl");
  const line =
    JSON.stringify({
      at: new Date().toISOString(),
      kind: "sleep_cycle",
      sleep_started_at: receipt.sleep_started_at,
      sleep_seal_sha: receipt.sleep_seal_sha,
      candidate_count: receipt.candidate_count,
      error: receipt.error ?? null,
    }) + "\n";
  try {
    await appendFile(auditPath, line, "utf8");
  } catch {
    // missing audit file is non-fatal here — receipt is still on disk
  }
}
