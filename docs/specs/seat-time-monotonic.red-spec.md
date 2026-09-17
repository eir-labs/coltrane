# RED-spec — chair timings on a monotonic clock

- **Contract:** `contract-seat-time-monotonic-v1`
- **Criterion:** a seat's time is time the seat ran, never time the machine slept.
- **Laws:** `tests/spec_seat_time_monotonic.test.ts` (RED — enforcement does not exist yet)
- **Controls (stay green):** `tests/spec_seat_metrics.test.ts`, `tests/runtime.test.ts`
- **Publish:** nothing (draft-laws phase only).

## The defect

Since the seat-metrics build (`0685280`), `src/runtime.ts` measures every
`chair_complete.duration_ms` and `first_write_ms` as `Date.now() - t0`:

| callsite | seat | what it measures |
| --- | --- | --- |
| `src/runtime.ts:2115` / `:2135` | human | `t0` / `duration_ms` |
| `src/runtime.ts:2963` | agent | `t0` |
| `src/runtime.ts:3275` | agent | `first_write_ms` |
| `src/runtime.ts:3825` | agent | `duration_ms` |

`Date.now()` is the **wall** clock. A chair that runs across a lid-close sleep or an
NTP step reports the slept/stepped interval as seat time. Seat time is how the operator
reads where a build's minutes go (measured this week: ~86% generation, ~1% tools), so a
sleep-inflated `first_write_ms` reads as a seat that thought for an hour.

`performance.now()` in Node is monotonic (`uv_hrtime`: `mach_absolute_time` on macOS,
`CLOCK_MONOTONIC` on Linux) and does not advance across system sleep. It returns a
fractional millisecond, so the seal must round to whole ms.

## Obligations → mechanism → law

Each obligation names the callsite the fix must change and the law that FAILS today
against the contract's reason.

### O1 — an agent seat's `duration_ms` and `first_write_ms` are monotonic differences, rounded to whole ms, never `Date.now()`

- **Mechanism:** at `src/runtime.ts:2963/3275/3825`, difference `performance.now()`
  instead of `Date.now()`, rounding each result (`Math.round`) to whole milliseconds.
- **Callsite:** `executeChair` in `src/runtime.ts` — `t0` (2963), the first
  Write/Edit/MultiEdit/NotebookEdit `tool_use` (3275), the `chair_complete` emit (3825).
- **Laws:** the agent-seat cases below, `I1` and `I2`. `I1` also asserts both numbers are
  whole milliseconds (green today; must stay green once the fix introduces fractional
  `performance.now()` and rounds it).

### O2 — a human seat's `duration_ms` is measured the same way

- **Mechanism:** at `src/runtime.ts:2115/2135`, difference `performance.now()` instead of
  `Date.now()`, rounded.
- **Callsite:** the human-chair branch in `runGig` — `t0` (2115), the `chair_complete`
  emit (2135).
- **Law:** `O2 — a human seat's duration_ms excludes a wall-clock jump during the seat`.

## Invariants → law

### I1 — a wall-clock jump during a chair is not counted

- **Checkable:** `Date.now` spied to jump forward 3,600,000 ms between chair start and the
  stub's first `Write` `tool_use` event; `first_write_ms` and `duration_ms` are each under
  60,000.
- **Law:** `I1 — a wall-clock jump between chair start and the first write inflates neither
  first_write_ms nor duration_ms`.
- **Observed RED:** both read `3600000` (`expected 3600000 to be less than 60000`).

### I2 — real elapsed time is still counted

- **Checkable:** a stub invoker that waits 50 ms before its first `Write` event and
  returns; `first_write_ms >= 40` and `duration_ms >= first_write_ms`.
- **Mechanism of the RED:** `Date.now` is spied FROZEN (the wall clock never advances)
  while the stub does 50 ms of real work. A monotonic clock keeps the 50 ms; the frozen
  `Date.now()` difference erases it to 0. This isolates that the number comes from a clock
  that advances with real time, independent of `Date.now`.
- **Law:** `I2 — real elapsed time is still counted when the wall clock does not move`.
- **Observed RED:** `first_write_ms` read `0` (`expected 0 to be greater than or equal to
  40`).

## Method

- **Property isolated:** the two invariants are the two directions of one axiom — the
  measured interval equals real monotonic elapsed time, and nothing else. `I1` drives the
  wall clock UP (over-count → must be excluded); `I2` freezes it (under-count → real time
  must survive). Example-based cases over `runGig`, because each is a specific behavior of
  the seal path, not a universal over a generated input space.
- **The jump is simulated by spying on `Date.now` ONLY**, never fake timers — fake timers
  also replace `performance.now()`, the clock the fix must switch to, which would make the
  law un-observable. The agent-seat spy is a controllable `fakeNow` the stub advances
  between events (the stub owns the timeline); the human-seat spy jumps on its second read.
- **Controls:** the in-file `control` case (no spy — real elapsed measured, green today and
  after), plus `tests/spec_seat_metrics.test.ts` and `tests/runtime.test.ts`, both run and
  green, so the fix is scoped to the clock and does not disturb first-write/duration
  semantics or the wider runtime.

## Observed run

`npx vitest run tests/spec_seat_time_monotonic.test.ts` → 3 failed, 1 passed:

- `I1` — `expected 3600000 to be less than 60000`
- `I2` — `expected 0 to be greater than or equal to 40`
- `O2` — `expected 3600000 to be less than 60000`
- `control` — passed.

`npx vitest run tests/spec_seat_metrics.test.ts tests/runtime.test.ts` → 12 passed.
