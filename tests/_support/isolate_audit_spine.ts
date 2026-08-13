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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spine = mkdtempSync(join(tmpdir(), "coltrane-test-spine-"));
process.env["COLTRANE_LEDGER_PATH"] = join(spine, "ledger.jsonl");
process.env["COLTRANE_MIRROR_DIR"] = spine;
