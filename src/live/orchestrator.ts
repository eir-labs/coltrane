// boot orchestrator for `coltrane play --live-slack`.
//
// Responsibilities:
//   - read the 4 steve seeds out of .coltrane/steve_<uuid>/seed.json
//   - resolve each steve's slack token pair from the parent env
//   - spawn 4 child processes concurrently (one per Steve)
//   - monitor exits; restart on non-zero exit with bounded backoff
//   - append all lifecycle events to .coltrane/orchestrator.log
//
// The child entry point is a worker script that constructs a SlackBridge
// and runs an event loop. We pass the steve uuid + token pair + book +
// audit path via env vars (no positional args, so the binary can be
// swapped between `node` and `claude` without rewiring).

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir, appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SteveSeed } from "./scaffold.js";
import { registerNightlySleep, type NightlyHandle, type NightlySleepOptions } from "./sleep.js";

export interface SteveBootSpec {
  steve_uuid: string;
  seed_path: string;
  audit_path: string;
  bot_token: string;
  app_token: string;
}

export interface OrchestratorOptions {
  root: string;
  /** Path to CLAUDE.md the children read on boot. */
  book_path: string;
  /** Environment (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Child binary; defaults to `node` invoking the worker script. Tests
   * override with a fake (e.g. an echo script). */
  worker_command?: string;
  worker_args?: readonly string[];
  /** Spawner override — defaults to node:child_process.spawn. */
  spawner?: typeof spawn;
  /** Log sink override — tests inject a memory sink. */
  log_sink?: (line: string) => Promise<void>;
  /** Max restart attempts per Steve before giving up. */
  max_restarts?: number;
  /** Override of the nightly-sleep options (tests inject fake timers /
   * disable scheduling entirely by passing { disable: true }). */
  nightly_sleep?: NightlySleepOptions & { disable?: boolean };
}

export interface OrchestratorHandle {
  steves: ReadonlyArray<{
    steve_uuid: string;
    child: ChildProcess;
    restarts: number;
  }>;
  nightly_sleep?: NightlyHandle;
  shutdown: () => Promise<void>;
}

/** Discover all steve dirs under <root>/.coltrane. Returns one
 * SteveBootSpec per Steve, with tokens pulled from env by 1-based index
 * (matches the .env.template ordering). */
export async function discoverSteves(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<SteveBootSpec[]> {
  const baseDir = join(root, ".coltrane");
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return [];
  }
  const steveDirs = entries.filter((e) => e.startsWith("steve_")).sort();
  const specs: SteveBootSpec[] = [];
  for (let i = 0; i < steveDirs.length; i++) {
    const dir = steveDirs[i];
    if (!dir) continue;
    const seedPath = join(baseDir, dir, "seed.json");
    const auditPath = join(baseDir, dir, "audit.jsonl");
    const raw = await readFile(seedPath, "utf8");
    const seed = JSON.parse(raw) as SteveSeed;
    const idx = i + 1;
    const bot = env[`SLACK_BOT_TOKEN_${idx}`];
    const app = env[`SLACK_APP_TOKEN_${idx}`];
    specs.push({
      steve_uuid: seed.steve_uuid,
      seed_path: seedPath,
      audit_path: auditPath,
      bot_token: bot ?? "",
      app_token: app ?? "",
    });
  }
  return specs;
}

interface SteveState {
  steve_uuid: string;
  child: ChildProcess;
  restarts: number;
}

/** Boot the orchestrator. Returns a handle to inspect / shut down the
 * group. Caller is responsible for awaiting shutdown. */
export async function bootOrchestrator(opts: OrchestratorOptions): Promise<OrchestratorHandle> {
  const env = opts.env ?? process.env;
  const maxRestarts = opts.max_restarts ?? 5;
  const spawner = opts.spawner ?? spawn;
  const workerCommand = opts.worker_command ?? "node";
  const workerArgs = opts.worker_args ?? [join(opts.root, "dist", "src", "live", "worker.js")];
  const logPath = join(opts.root, ".coltrane", "orchestrator.log");

  await mkdir(dirname(logPath), { recursive: true });

  const log = async (event: Record<string, unknown>) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
    if (opts.log_sink) {
      await opts.log_sink(line);
      return;
    }
    await appendFile(logPath, line, "utf8");
  };

  const specs = await discoverSteves(opts.root, env);
  await log({ event: "discover", count: specs.length });

  const states: SteveState[] = [];

  const launchOne = (spec: SteveBootSpec, restarts: number): SteveState => {
    const child = spawner(workerCommand, [...workerArgs], {
      env: {
        ...env,
        STEVE_UUID: spec.steve_uuid,
        STEVE_SEED_PATH: spec.seed_path,
        STEVE_AUDIT_PATH: spec.audit_path,
        SLACK_BOT_TOKEN: spec.bot_token,
        SLACK_APP_TOKEN: spec.app_token,
        COLTRANE_BOOK_PATH: opts.book_path,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const state: SteveState = { steve_uuid: spec.steve_uuid, child, restarts };

    child.on("exit", (code, signal) => {
      void log({
        event: "child_exit",
        steve_uuid: spec.steve_uuid,
        code,
        signal,
        restarts: state.restarts,
      });
      // restart on non-zero exit (signal-terminated counts as crash) up to bound
      if ((code !== 0 || signal !== null) && state.restarts < maxRestarts) {
        state.restarts += 1;
        const replacement = launchOne(spec, state.restarts);
        state.child = replacement.child;
        void log({
          event: "child_restart",
          steve_uuid: spec.steve_uuid,
          restarts: state.restarts,
        });
      }
    });

    return state;
  };

  for (const spec of specs) {
    const state = launchOne(spec, 0);
    states.push(state);
    await log({ event: "child_spawn", steve_uuid: spec.steve_uuid, pid: state.child.pid ?? null });
  }

  // Register the nightly bleach-wash. Skippable for tests via
  // nightly_sleep: { disable: true }.
  let nightly: NightlyHandle | undefined;
  if (!opts.nightly_sleep?.disable) {
    const { disable: _disable, ...nightlyOpts } = opts.nightly_sleep ?? {};
    nightly = registerNightlySleep(
      {
        root: opts.root,
        log,
      },
      nightlyOpts,
    );
    await log({ event: "nightly_sleep_registered", hour_local: nightlyOpts.hour ?? 3 });
  }

  return {
    steves: states,
    ...(nightly !== undefined ? { nightly_sleep: nightly } : {}),
    async shutdown() {
      for (const s of states) {
        try {
          s.child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      if (nightly) nightly.cancel();
      await log({ event: "shutdown" });
    },
  };
}
