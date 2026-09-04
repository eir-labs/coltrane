#!/usr/bin/env bash
# THE LAWS, COUNTED — an exact gate on this repo's own suite.
#
# THE DEFECT THIS CLOSES (verifier, n=232), and it was the law under everything else:
# `npm test` was a bare `vitest run` with no expected count anywhere — not in package.json,
# not in scripts/, not in either workflow. Every other lane in this program is pinned and
# matches its files (the sibling lanes pin theirs at 98, 116 unit / 78 pgTAP, 13, and 5).
# COLTRANE, THE LARGEST SUITE, WAS NOT.
#
# What that costs: a file that fails to COLLECT does exit 1, so an import that throws is
# caught. But a DELETED law is SILENT — the run simply reports a smaller number and passes.
# Demonstrated by her hand on main: two law files -> "Tests 17 passed" exit 0; one file moved
# away -> "Tests 12 passed" exit 0. The suite went 3458 -> 3484 -> 3487 across six PRs in one
# day and nothing asserted what it should be, which means every green reported in that time
# rested on a number that could not tell "more laws" from "different laws".
#
# BOTH NUMBERS ARE PINNED, deliberately. Test count alone would catch a deleted file, but it
# cannot say WHAT changed — and "3487 -> 3480" is a puzzle where "one file went missing" is
# an answer. Files catch a lost suite; tests catch a lost law inside a surviving suite.
#
# Growth is a DELIBERATE EDIT of the numbers below, in the same commit as the new laws. Exact
# (-ne), never a floor: a floor lets a lost law hide behind a new one.
set -euo pipefail
cd "$(dirname "$0")/.."

# THE ROOT BAND — `npm test`, the one the verifier measured and the one carrying almost
# every law in this repo.
EXPECTED_LAWS="${EXPECTED_LAWS:-3509}"   # 3487 passing + 22 todo
EXPECTED_FILES="${EXPECTED_FILES:-347}"

# THE OTHER BANDS. `vitest run` is ROOT-CONFIG ONLY — this repo's own workflow comments
# record that four configs went unexecuted once for exactly that reason. So pinning only the
# root band would repeat the mistake one level up: a pinned entrypoint that is silent about
# most of the configs it does not run. They are small, they are fast, and there is no excuse
# for leaving them unpinned while claiming the laws are counted.
EXPECTED_FAILURE_MODES_FILES="${EXPECTED_FAILURE_MODES_FILES:-5}"
EXPECTED_HONEST_BROKER_FILES="${EXPECTED_HONEST_BROKER_FILES:-2}"
EXPECTED_SECURITY_FILES="${EXPECTED_SECURITY_FILES:-1}"

# THE FILES DELEGATED AWAY FROM THE ROOT BAND, by name.
#
# The verifier caught this message overclaiming: it said "plus every band, exact" while the
# DOCKER band (test:room, tests/venue_live/vitest.config.ts, run by ci.yml) was the one band
# nothing pinned. Her fix was EXPECTED_ROOM_FILES=1. Measuring it suggested a stronger law:
# `find` sees 350 test files and the root band collects 347, and the three-file difference is
# the whole of what any other config is responsible for.
#
# So instead of pinning one more count, this pins the DELEGATION ITSELF: the set of files the
# root band does not collect must be EXACTLY this list. A file that leaves the root band —
# excluded, moved under a band directory, or delegated to a new config — must be named here,
# in the commit that moves it. That catches the room band (it is in the list), and it catches
# the thing a room-band count could not: A TEST FILE THAT NO BAND RUNS AT ALL. A dead law
# nobody executes reports nothing and passes forever, which is the same silence this whole
# script exists to end, one level further out.
EXPECTED_DELEGATED="tests/honest_broker/gig_dispatch.test.ts
tests/honest_broker/recorder_append.test.ts
tests/spec_venue_room_live.test.ts"

# ONE run, not two: this suite is large enough that running it twice to count it is a real
# cost, and a second run is also a second chance to disagree with the first.
JSON_OUT="$(mktemp -t coltrane-laws-XXXXXX.json)"
trap 'rm -f "$JSON_OUT"' EXIT

set +e
npx vitest run --reporter=default --reporter=json --outputFile="$JSON_OUT" "$@"
rc=$?
set -e

if [ ! -s "$JSON_OUT" ]; then
  echo "REFUSED: the run produced no report — a vanished run is not a verdict." >&2
  exit 1
fi

read -r laws files < <(python3 -c "
import json,sys
d=json.load(open('$JSON_OUT'))
# numTotalTestSuites counts DESCRIBE BLOCKS, not files (1338 vs 347) — the field name
# invites the mistake, and I made it on the first run. testResults is one entry per FILE,
# which is the thing 'a law file went missing' is about.
# numTotalTests includes `todo` laws (3487 passed + 22 todo = 3509). Todos are DECLARED
# laws — a todo silently deleted is a law silently abandoned — so they are counted.
print(d.get('numTotalTests',-1), len(d.get('testResults',[])))
")

echo
echo "laws collected: $laws (expected: $EXPECTED_LAWS) in $files files (expected: $EXPECTED_FILES)"

if [ "$rc" -ne 0 ]; then
  echo "REFUSED: the suite did not pass. The counts above are reported for context only —" >&2
  echo "         a count read over a FAIL line is how a red suite gets called green." >&2
  exit "$rc"
fi

fail=0
if [ "$files" -ne "$EXPECTED_FILES" ]; then
  echo "REFUSED: collected $files law FILES, expected exactly $EXPECTED_FILES —" >&2
  echo "         a law file was deleted, renamed, or added without bumping EXPECTED_FILES." >&2
  fail=1
fi
if [ "$laws" -ne "$EXPECTED_LAWS" ]; then
  echo "REFUSED: collected $laws laws, expected exactly $EXPECTED_LAWS —" >&2
  echo "         a law was deleted or added without bumping EXPECTED_LAWS in scripts/laws.sh." >&2
  fail=1
fi
# ── the other bands, by file count ────────────────────────────────────────────────────
# File count, not test count: these bands are small and their value is that the SUITE exists
# and runs at all. A lost file here is the whole band going quiet.
band() {
  local name="$1" script="$2" expected="$3" out n
  out="$(mktemp -t coltrane-band-XXXXXX.json)"
  if ! npm run --silent "$script" -- --reporter=json --outputFile="$out" >/dev/null 2>&1; then
    echo "REFUSED: band '$name' did not pass." >&2; rm -f "$out"; return 1
  fi
  n="$(python3 -c "import json;print(len(json.load(open('$out')).get('testResults',[])))")"
  rm -f "$out"
  echo "  $name: $n files (expected: $expected)"
  if [ "$n" -ne "$expected" ]; then
    echo "REFUSED: band '$name' collected $n files, expected exactly $expected." >&2; return 1
  fi
}
# ── nothing is orphaned ───────────────────────────────────────────────────────────────
# Needs no docker and no band run: it compares what is ON DISK against what the ROOT band
# collected, which we already have.
delegated_actual="$(python3 -c "
import json,os,subprocess
d=json.load(open('$JSON_OUT'))
root={os.path.relpath(t['name'], os.getcwd()) for t in d.get('testResults',[])}
disk=set(subprocess.run(['find','tests','-name','*.test.ts'],capture_output=True,text=True).stdout.split())
print('\n'.join(sorted(disk-root)))
")"
if [ "$delegated_actual" != "$(printf '%s' "$EXPECTED_DELEGATED" | sort)" ]; then
  echo "REFUSED: the files delegated away from the root band are not the ones declared." >&2
  echo "  declared:" >&2; printf '%s\n' "$EXPECTED_DELEGATED" | sort | sed 's/^/    /' >&2
  echo "  actual:"   >&2; printf '%s\n' "$delegated_actual"   | sed 's/^/    /' >&2
  echo "  A file that leaves the root band must be named in EXPECTED_DELEGATED, in the" >&2
  echo "  commit that moves it — otherwise a test nobody runs passes forever in silence." >&2
  fail=1
else
  echo "  delegated: $(printf '%s\n' "$EXPECTED_DELEGATED" | wc -l | tr -d ' ') files, each declared"
fi

band failure-modes  test:failure-modes  "$EXPECTED_FAILURE_MODES_FILES"  || fail=1
band honest-broker  test:honest-broker  "$EXPECTED_HONEST_BROKER_FILES"  || fail=1
band security       test:security       "$EXPECTED_SECURITY_FILES"       || fail=1

[ "$fail" -eq 0 ] || exit 1
echo "coltrane laws: $laws in $files files, plus every band, exact."
