// RED — the drain's ceiling is a dollar ceiling (contract I7 + F4).
//
// Today `drainBudget` reads `COLTRANE_DRAIN_OPENING` and falls back to a 2000 append-unit default
// (src/run_deps.ts `DEFAULT_DRAIN_OPENING = 2000`) — the "every drained gig with more than ~20KB of
// context is refused" bug. The contract:
//   I7 — apply `COLTRANE_DRAIN_MAX_USD` as the per-gig dollar ceiling when set, and NO ceiling when
//        absent (the 2000 append-unit default is gone). worker_env documents the variable as USD.
//   F4 — `COLTRANE_DRAIN_MAX_USD` set but not a positive finite number → the drain refuses to start,
//        naming the variable.
//
// RED against today's src: `drainBudget` never reads COLTRANE_DRAIN_MAX_USD, always returns an
// append-unit `{ opening }`, and never throws on a malformed value; and WORKER_ENV_CONTRACT has no
// entry for the variable at all.
import { describe, it, expect, afterEach } from "vitest";
import { drainBudget } from "../src/run_deps.js";
import { WORKER_ENV_CONTRACT } from "../src/worker_env.js";

const MAX_USD = "COLTRANE_DRAIN_MAX_USD";
const OLD_OPENING = "COLTRANE_DRAIN_OPENING";
const saved: Record<string, string | undefined> = {};

function set(name: string, value: string | undefined): void {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
});

const asDollars = (b: unknown) => b as Record<string, unknown>;

describe("I7 — the drain applies COLTRANE_DRAIN_MAX_USD as a dollar ceiling", () => {
  it("reads the variable as the per-gig dollar ceiling when set", () => {
    set(OLD_OPENING, undefined);
    set(MAX_USD, "5");
    const b = asDollars(drainBudget(undefined));
    expect(b["max_usd"], "COLTRANE_DRAIN_MAX_USD did not reach the drain budget as a dollar ceiling").toBe(5);
    expect(b["opening"], "the drain still built an append-unit opening for a dollar ceiling").toBeUndefined();
  });

  it("applies NO ceiling when the variable is absent — the 2000 append-unit default is gone", () => {
    set(OLD_OPENING, undefined);
    set(MAX_USD, undefined);
    const b = asDollars(drainBudget(undefined));
    expect(b["opening"], "the retired 2000 append-unit default still governs a drained gig with no dollar ceiling set").toBeUndefined();
    expect(b["max_usd"], "an absent COLTRANE_DRAIN_MAX_USD conjured a dollar ceiling from nowhere").toBeUndefined();
  });
});

describe("F4 — a malformed COLTRANE_DRAIN_MAX_USD refuses to start, naming the variable", () => {
  const bad: ReadonlyArray<{ name: string; value: string }> = [
    { name: "not a number", value: "banana" },
    { name: "zero", value: "0" },
    { name: "negative", value: "-3" },
    { name: "Infinity", value: "Infinity" },
  ];
  it.each(bad)("$name → drainBudget throws naming COLTRANE_DRAIN_MAX_USD", ({ value }) => {
    set(OLD_OPENING, undefined);
    set(MAX_USD, value);
    let caught: unknown = null;
    try {
      drainBudget(undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught, `a malformed ${MAX_USD}=${value} did not refuse the drain — it started with the wrong (or no) ceiling`).toBeInstanceOf(Error);
    expect(String((caught as Error | null)?.message ?? ""), "the refusal did not name the variable").toContain(MAX_USD);
  });
});

describe("I7 — worker_env documents COLTRANE_DRAIN_MAX_USD as USD", () => {
  it("the worker-environment contract carries the variable, described in dollars", () => {
    const entry = WORKER_ENV_CONTRACT.find((e) => e.name === MAX_USD);
    expect(entry, "COLTRANE_DRAIN_MAX_USD is not in the worker-environment contract at all").toBeDefined();
    expect((entry?.meaning ?? "").toLowerCase(), "the drain ceiling variable is not documented in dollars/USD").toMatch(/usd|dollar/);
  });
});
