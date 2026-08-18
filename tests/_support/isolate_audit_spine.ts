// One audit spine PER TEST FILE (#328).
//
// vitest.config.ts pins COLTRANE_LEDGER_PATH / COLTRANE_MIRROR_DIR to fixed paths so an unrooted
// bootstrap cannot seed the developer's checkout with audit rows. That protection is right and
// stays. What it also did, unintentionally, was hand all 213 test files ONE ledger and ONE mirror:
// every sealing test appended to the same two stores, so their size grew monotonically as the suite
// progressed.
//
// `system_health` scans both in full — `deps.ledger.integrity()` + `deps.outputs.integrity()`, and
// a real call on this repo reports `scanned: 5050`. So the cost of a system_health test became a
// function of how much of the suite had already run, and the two tests that call it crossed
// vitest's 5s default nondeterministically: 2 failures in 4 full-suite runs on clean main, each
// passing in isolation. The measured proof is the entry count — a freshly-rooted genome's ledger
// reported 2428 entries that belonged to other files.
//
// A flaky gate is not a cosmetic problem here. Law C of institutions/coltrane.json obliges a green
// CI result before merge; a gate that fails half the time on unchanged code teaches readers to
// re-run until green, which is indistinguishable from teaching them to ignore red.
//
// This runs as a setupFile, so it re-executes for each test file and each gets a private spine.
// The scan a system_health test pays for is then bounded by ITS OWN file, which is the only work
// that test was ever meant to be measuring.
//
// A test that sets these env vars itself (tests/ledger_durability.test.ts pins the resolution rules
// deliberately) still overrides this — assignment order gives the test the last word, which is
// correct: this is a floor, not a ceiling.
//
// The OUTPUT STORE is the third leg, and it was missed the first time (#328 covered the ledger and
// the mirror only). `bootstrapServerDeps` roots the store at `defaultOutputsPersistDir()`
// (src/outputs.ts:366) — which is NOT genome-rooted and NOT covered by vitest.config.ts's env
// block, so it resolved to the developer's real `$HOME/.eir/coltrane_outputs`. That directory is
// not scoped to a run at all: it is shared by every test file, every parallel worker, and every
// suite run since the machine was set up, and it only ever grows (measured here: 6,099 files,
// ~100-200 added per day since June).
//
// `system_health` scans it in full on every call — `deps.outputs.integrity()` hydrates and then
// re-scans `outputs/` + `refs/` (src/outputs.ts:896-939), and `deps.outputs.all()` hydrates again.
// So the two tests that call system_health from a freshly-bootstrapped deps paid for the whole
// accumulated history of the host: measured at 3.1-4.7s against vitest's 5s default, with a 7.1s
// excursion under full-suite parallelism that timed both of them out in the same run
// (tests/genome_layering.test.ts and tests/genome_reload_tool.test.ts, "Test timed out in 5000ms").
// Pointing the store at this file's private spine drops the same two tests to 5-9ms.
//
// This is the same defect #328 describes, in the same shape, for the same reason — a global store
// standing in for a per-file one — so it belongs behind the same floor rather than behind a raised
// testTimeout. A timeout raise would keep the cost, keep the $HOME coupling, and keep the cliff:
// the directory grows monotonically, so any fixed budget is only ever a later failure date. It is
// also why CI never reproduced this and a developer machine does — CI starts from an empty $HOME.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spine = mkdtempSync(join(tmpdir(), "coltrane-test-spine-"));
process.env["COLTRANE_LEDGER_PATH"] = join(spine, "ledger.jsonl");
process.env["COLTRANE_MIRROR_DIR"] = spine;
process.env["COLTRANE_OUTPUTS_DIR"] = join(spine, "outputs");
