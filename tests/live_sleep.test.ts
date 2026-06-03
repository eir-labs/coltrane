// sleep tests — sleepSteve receipt shape, sleepAllSteves fan-out,
// registerNightlySleep cron timing + cancellation.

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeScaffold } from "../src/live/scaffold.js";
import {
  sleepSteve,
  sleepAllSteves,
  registerNightlySleep,
  msUntilNextHour,
} from "../src/live/sleep.js";

describe("sleepSteve", () => {
  it("writes a SleepReceipt with stub values and sleep_math_not_yet_wired flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-sleep-"));
    await materializeScaffold({ root: dir, uuids: ["a", "b", "c", "d"] });
    const r = await sleepSteve("a", dir);
    expect(r.uuid).toBe("a");
    expect(r.sleep_seal_sha).toBe("stub");
    expect(r.candidate_count).toBe(0);
    expect(r.error).toBe("sleep_math_not_yet_wired");
    expect(typeof r.sleep_started_at).toBe("string");
  });

  it("persists the receipt under sleep/ as a json file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-sleep-"));
    await materializeScaffold({ root: dir, uuids: ["a", "b", "c", "d"] });
    await sleepSteve("a", dir);
    const sleepDir = join(dir, ".coltrane", "steve_a", "sleep");
    const files = await readdir(sleepDir);
    expect(files.length).toBe(1);
    const f = files[0]!;
    expect(f).toMatch(/^receipt_.*\.json$/);
    const raw = await readFile(join(sleepDir, f), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.uuid).toBe("a");
  });

  it("returns error receipt when steve_<uuid>/ missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-sleep-"));
    const r = await sleepSteve("ghost", dir);
    expect(r.error).toMatch(/not found/);
    expect(r.sleep_seal_sha).toBe("");
  });

  it("uses the injected run override (real-impl handoff path)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-sleep-"));
    await materializeScaffold({ root: dir, uuids: ["a", "b", "c", "d"] });
    const fake = vi.fn(async () => ({
      seal_sha: "real-sha-abc",
      candidate_count: 7,
    }));
    const r = await sleepSteve("a", dir, { run: fake });
    expect(fake).toHaveBeenCalled();
    expect(r.sleep_seal_sha).toBe("real-sha-abc");
    expect(r.candidate_count).toBe(7);
    expect(r.error).toBeUndefined();
  });
});

describe("sleepAllSteves", () => {
  it("invokes sleepSteve in parallel for all discovered Steves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-sleep-all-"));
    await materializeScaffold({ root: dir, uuids: ["a", "b", "c", "d"] });
    const receipts = await sleepAllSteves(dir);
    expect(receipts).toHaveLength(4);
    const uuids = receipts.map((r) => r.uuid).sort();
    expect(uuids).toEqual(["a", "b", "c", "d"]);
  });

  it("returns empty when .coltrane is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-sleep-empty-"));
    const receipts = await sleepAllSteves(dir);
    expect(receipts).toEqual([]);
  });
});

describe("msUntilNextHour", () => {
  it("returns ms until target hour today if still in the future", () => {
    const now = new Date("2026-06-03T01:00:00");
    // 2 hours = 7,200,000 ms
    expect(msUntilNextHour(now, 3)).toBe(2 * 3600_000);
  });

  it("rolls over to tomorrow if target hour has already passed", () => {
    const now = new Date("2026-06-03T05:00:00");
    // 22 hours until 3am tomorrow
    expect(msUntilNextHour(now, 3)).toBe(22 * 3600_000);
  });

  it("equal-time case rolls forward (avoid same-instant fire)", () => {
    const now = new Date("2026-06-03T03:00:00");
    expect(msUntilNextHour(now, 3)).toBe(24 * 3600_000);
  });
});

describe("registerNightlySleep", () => {
  it("schedules at 3am local by default and fires runSleepAll on timer", async () => {
    const log = vi.fn(async () => undefined);
    let fireCount = 0;
    let cancelled = false;
    const setT = vi.fn((cb: () => void, _ms: number) => {
      // fire once then stop (cancel from inside) to avoid infinite re-schedule
      if (fireCount === 0 && !cancelled) {
        fireCount++;
        setImmediate(() => {
          if (!cancelled) cb();
        });
      }
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const clearT = vi.fn(() => {
      cancelled = true;
    }) as unknown as typeof clearTimeout;
    const runAll = vi.fn(async () => {
      cancelled = true; // stop re-scheduling
      return [
        { uuid: "a", sleep_started_at: "x", sleep_seal_sha: "stub", candidate_count: 0 },
      ];
    });

    const handle = registerNightlySleep(
      { root: "/tmp", log },
      {
        now: () => new Date("2026-06-03T01:00:00"),
        set_timeout: setT,
        clear_timeout: clearT,
        run_sleep_all: runAll,
      },
    );

    // setT was invoked with ms-until-3am = 2h
    expect(setT).toHaveBeenCalled();
    const callArgs = (setT as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(callArgs[1]).toBe(2 * 3600_000);

    // give the async fire a tick to land
    await new Promise((res) => setTimeout(res, 10));
    expect(runAll).toHaveBeenCalled();

    handle.cancel();
    expect(clearT).toHaveBeenCalled();
  });

  it("is cancellable — cancel before fire prevents runAll", async () => {
    const log = vi.fn(async () => undefined);
    let captured: (() => void) | undefined;
    const setT = vi.fn((cb: () => void, _ms: number) => {
      captured = cb;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const clearT = vi.fn() as unknown as typeof clearTimeout;
    const runAll = vi.fn(async () => []);

    const handle = registerNightlySleep(
      { root: "/tmp", log },
      {
        now: () => new Date("2026-06-03T01:00:00"),
        set_timeout: setT,
        clear_timeout: clearT,
        run_sleep_all: runAll,
      },
    );
    handle.cancel();
    if (captured) captured();
    await new Promise((res) => setImmediate(res));
    expect(runAll).not.toHaveBeenCalled();
  });

  it("respects a custom hour override", () => {
    const log = vi.fn(async () => undefined);
    const setT = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;
    const clearT = vi.fn() as unknown as typeof clearTimeout;
    registerNightlySleep(
      { root: "/tmp", log },
      {
        hour: 5,
        now: () => new Date("2026-06-03T01:00:00"),
        set_timeout: setT,
        clear_timeout: clearT,
        run_sleep_all: async () => [],
      },
    );
    const callArgs = (setT as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(callArgs[1]).toBe(4 * 3600_000);
  });
});
