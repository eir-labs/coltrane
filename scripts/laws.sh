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
# 3965 → 3966: one stale law went (it asserted Node's permission model has no network gate, which
# stopped being true at Node 24), and two pure flag-string laws replaced it in this band. The nine
# laws that need a real request moved to tests/security — a band may reach out, the root suite may
# not — so they are counted there, by file, not here.
EXPECTED_LAWS="${EXPECTED_LAWS:-4248}"
#  +3 genome_writes_stay_in_root, charter_read (conductor's decision on #559): a charter is read only from
#      inside the genome root — a control, the hostile paths refused by name with nothing returned, and no
#      genome root means refused.
#  +37 genome_writes_stay_in_root (new file, RED at e6c89ff): no path the engine derives leaves its root —
#      founder ruling "SLUGS ARE NOT IDENTIFIERS". 12 controls (a normal slug still writes inside the root) and
#      25 red laws: six local genome-writing doors, agent_evolve's traversal read, the history snapshot, the
#      three blessed writers on their own (4), the hosted store upsert per door (7) and the port for every class,
#      persistLineageAdoption, the skill chain append and read, output_write's gig id, gig_logs' gig id.
#   +5 skill_runs_on_exec_path (new file, #557 round 2): a skill runs on process.execPath, never `node` from
#      PATH. The floor checked the parent's Node while the skill ran on PATH's (grade issuecomment-5847532054:
#      an ungranted skill on PATH node 24 fetched a listener and got 200). P1a-c executeSkill /
#      executeSkillAsync / skill_execute; P3a bootstrap's fallback engine MCP server; P3b the relay's child.
#  +10 Node 26 is enforced where skills run, not at install; the bus is not a hosted tool (founder ruling,
#      26 Sep 2026; coltrane-ui #252's grade). +11 node_floor_where_skills_run (new file: F1 library import
#      below 26, F2 install not refused, F3 skill execution refuses by name, F4 `coltrane work` refuses),
#      +4 bus_not_hosted (new file: B1-B3 hosted bus_* refused with no write, B4 local control); -3
#      node_floor_refuses' install laws and -2 skill_sandbox_confinement's engines laws, retired with the
#      install floor they pinned.
#  +51 #545 rebuilt on main after #552 (the Node 26 floor made its Node 22 special-casing moot): +30 the
#      landscape genome, +21 every_skill_runs_its_fixtures (discovered skills, three booked). Read from the run.
#   +1 node_floor_refuses: THIS runtime accepts --allow-net, probed (the constant said 24; it is 25). Floor → 26.
#   +8 the Node floor is 24 (26 Sep 2026, the sovereign: "22 is no starter given lack of network
#      controls"): node_floor_refuses (6, new file) — install and start refuse Node < 24; and
#      skill_sandbox_confinement +2 — the floor backs a network grant; every CI/container pin meets it.
#   +1 the agnosticism law can FAIL (#537) — the reside corpus is discovered, not listed.
#  +13 spec_reside_drive (new file, #537) — driveResidency: the pump, the single-flight drain, the stop
#      race (WI-9). Rebased onto b5112ff (#550): main 4119 + the branch's own +13.
#   +7 a_red_law_names_its_plant (#551, red-spec v5) — carried in by the rebase onto 805b535; the
#      count is main's +7 over this branch's 4112, read from the run (4119 collected, 431 files).
#   +7 fan_out F9 (6) + simulate_names_seats S14 (1) — `over.carry`: a KEEP-list of dotted paths
#      narrowing the VIEW a seat receives, never the sealed record. Justified by measurement, not
#      argument: eir-drafting's failing run handed 86 seats 490,779 characters each with 306,011 of
#      it `data.expanded`, and their current healthy merge still spends 58% of every seat on what it
#      cannot use. No chair can fix it — the record SHOULD hold `expanded` for the trace, so a
#      chair-level fix buys the seat's view by sealing a poorer record. Dotted because their two fat
#      fields sit at different depths (`charter` at the top, `data.expanded` one down) and a
#      top-level allowlist cannot reach the number that justified the feature. KEEP because
#      enriching the record is the common act and enriching a prompt should be the deliberate one.
#      A carry path matching nothing REFUSES: under a keep-list a renamed field turns into a seat
#      that quietly STARVES and answers anyway. Seven cuts, all red — the last only after F9f, since
#      every other law built its chair in TypeScript and none went through the schema.
#   +2 simulate_names_seats S12/S13 — `largest_field` follows the biggest field DOWN while it is an
#      object. Found on the feature's first real use: a skill seals `{data: {…}}`, so the biggest
#      top-level field of every source-set record is `data` — a true answer that is the same answer
#      whatever is wrong. `data.expanded (20,007)` is the answer; `data (41,297)` is a tautology.
#      Stops at an array (an index is not a field a caller can carry or drop) and at depth 3. Four
#      cuts, all red — the last only after its law could tell the named field's bytes from its
#      parent's, which it could not when the wrapper and its child were the same size.
#  +11 simulate_names_seats (new file) — the pre-dispatch gate now says WHO PLAYS. A chair with
#      `fan_out` is a TEMPLATE; simulate received each phase as a chair COUNT, so a run that will
#      seat 22 players looked like one that seats 1 AND WAS PRICED AS ONE — a "validate before you
#      spend" gate quoting 1/22 of the spend. `seat_plan` names every chair by role, expands a
#      fan-out with the ENGINE's own split (never a re-implementation), and reports the BYTES each
#      seat would be handed after narrowing plus the largest field in each input. Measured by
#      eir-drafting on a failing run: a seat handed 490,779 characters to read its own 48,849,
#      434,225 of it two sibling arrays that fan_out leaves whole. That is now a number read before
#      dispatch. Fourteen cuts: nine red at once; four stayed green because every law simulated from
#      a RAW payload and never from sealed records — the path a real dispatch takes — until S10/S11
#      were written, which also found the planner measuring the caller's markers instead of the
#      resolved payload. A fifteenth finding has no law and needed none: naming a field `template`
#      made the reachability sweep count `project-charter.template` as read by a file unrelated to
#      it, so the field is `is_template` and that pin stays honest at 235.
#  +11 optional_declared_input (new file) — `chair.optional_inputs`, the twin of optional_outputs: a
#      declared input whose ABSENCE is not a refusal, so a chair can read the previous round's
#      findings and still run the first round. Waived in four demands (compose's pipeline check, the
#      t=0 pre-flight, and prepareChair's two branches — agent AND skill) plus chart rule R7, which
#      would otherwise call the slot dead one layer up and leave the waiver unreachable. Deny-by-
#      default, subset of input_contract, refused at compose if it names a type the chair does not
#      declare; optional never means ignored — a present optional input is routed as before; and one
#      chair's waiver never excuses another chair's demand for the same type. Twelve cuts: nine red
#      at once, three stayed green — the skill branch and the schema field had no law until O10/O11
#      were written, and the normaliser's `?? []` line could not fail at all, so it was deleted.
# +3 fan_out F8 (fan_out.test.ts) — `over.across_sources`: one seat per item across EVERY record of
# the set, each handed only its own record and stamped with it; a key repeated across rounds still
# refused; the default two-source refusal unchanged. Six cuts, all red: the stamp naming the first
# source, an empty drop set, the runtime ignoring drop, the opt-in forced on, the duplicate check
# dropped, items taken from the first source only.   # includes 21 todo
#   +6  claude_seat_reads (new file) — law 9 on the door the drafting genome runs on: a Claude seat's
#       tools are a CHILD's, so its reads live only in the stream. captureSeatReads reads the sealed
#       records its tool RESULTS carried and emits the same `seat_read` the completions door does, so
#       the runtime's one verification path serves both. Asking is not reading (only a result counts),
#       and the seat's own output_write result is not a read. 6 wires cut, all red.
#   +6  seat_reads_recorded (new file) — spec.coltrane-sealed-inputs law 9, un-deferred: a sealed record
#       a seat PULLS through its tools is named in what it seals, re-hashed first (the door's check) and
#       stamped with a `read` resolution so trace crosses the gig. Two cuts stayed green until their laws
#       were written: trusting the reported sha (a ref a record's own CONTENT claims), and dedup against
#       what was pushed.
#   +6  gig_input_validated (new file) — a dispatch payload is checked against the types it claims to
#       be, at the door, with the same compiled schema the seal enforces (eir-drafting's repro: a
#       charter carried 4 forbidden fields and omitted 2 required ones for months; only a seal caught
#       it). Not the seal's core floor — a payload is not an output. Unknown types and non-object
#       values are skipped, both pinned. 6 wires cut, all red; two existing laws had to be amended
#       because the door now refuses earlier than they expected.
#   -8  bifrost_invoker deleted (7 laws + 1 todo): a second AgentInvoker named for ONE vendor's
#       transport (/v1/generate, text-only, no tools), exported from index.ts and called nowhere in
#       src/. The completions port replaced it with one general OpenAI-compatible connector whose
#       endpoint is an env var, and spec_turn_loop LAW 18 already forbids the loop and the port to name
#       a vendor. Deleting it did NOT move the orphan pin: it was exported from index.ts, so it was
#       never in that count.
#   +6  code_tools (new file) — the engine's own code hands for a chair on any model: read / search /
#       patch-exactly-once / run one law file, confined to the repo (realpath, so .., absolute and
#       symlinks cannot escape), never touching secrets or .git. Plus the union that gives a chat chair
#       both engine and code tools. 10 wires cut; the absolute-path check first stayed green (it cannot
#       escape anyway), so the law now pins that the refusal SAYS "absolute".
#   +3  bus_commit (new file) — a bus chair's commitments are SEALED (its source persists; a gig seat's
#       still only validates, which K-always-seal pins), stamped gig bus:<name> / the chair / phase bus
#       whatever the model wrote. 4 wires cut, all red.
#   +4  bus_terminal R1-R4 — bare `coltrane` resolves the repo's CONDUCTOR (the one seated chair with role "conductor" in the genome's institutions); --chair wins; none or two refuse, saying how to fix it. 4 wires cut, all red.
#   +4  bus_verbs (new file) — bus_post / bus_read / bus_owed on the MCP surface, so a Claude Code chair
#       is a member of the same bus `coltrane chat` uses (wiki spec.coltrane-bus). A bus name cannot
#       reach outside the bus directory; the speaker must be named. 7 wires cut, all red. Two existing
#       laws caught the first draft: a description backticking another verb's argument (#535), and one
#       shared handler reading every verb's arguments (#234).
#   +1  completions_seal K11 — an identical accepted write seals once (eir-drafting 3a37d808 facts-5 sealed one payload twice, same content_sha, 5 ms apart); distinct payloads still seal separately.
#   +14 bus (5), bus_chair (5), bus_terminal (4) — wiki spec.coltrane-bus steps 1-3: an append-only
#       JSONL bus with per-member cursors (a tag owes a reply, untagged is passive signal), a resident
#       chair that answers only what it owes, and bare `coltrane` in a terminal opening a chat with it.
#       20 wires cut; two first cuts stayed green (a self-tag counted as a debt; the terminal's two
#       echo guards each cover the other — cut together, the law reds).
#   +2  completions_reasoning_effort (new file) — a seat's resolved effort reaches the wire as
#       reasoning.effort (levels above high saturate). The long-wait transport's 5 laws live in the
#       security band (tests/security/completions_long_wait.spec.ts): they open a real loopback
#       socket, which the root suite forbids.
#   +9  amend_ladder (new file) — a failed re-verify read against the verdict before it: different
#       findings seat the maker one rung up (cold), the same findings stop the loop (amend_stalled).
#       A first draft designed for "unreadable findings"; the core Verdict makes that case impossible,
#       its law could not fail, and it went. 11 wires cut, all red.
#   +4  spec_reverify_resume_prompt (existing file, rewritten by contract-reverify-carries-amendment-v1,
#       drafted red on work/release-compile-cache 59704e5 and built here) + F1 drafted with the build. A
#       resumed re-verify carries the inputs its round-one verdict never saw (by content_sha: comparing by
#       id reds I1), and the working-tree instruction reaches only a seat that can read the tree.
#   +10 tier_ladder (new file) — COLTRANE_TIER_LADDER: a completions chair that cannot seal is seated
#       cold one rung up; only seal failures climb; every rung settles; the record names the model AND
#       tier that sealed (a failed cheap rung out-produced the sealer in the fixture, so the whole-chair
#       argmax named the loser until the sink kept output since the climb apart). 11 wires cut, all red.
#   +11 completions_seal (new file) — a completions seat seals through output_write, in-band, over an
#       in-process engine source pinned to validate. Cutting that pin reds K1 with "expected 2 to be 1":
#       the double seal. The handoff's bridge, dispatchTool(toolBaseName(name)), would have refused
#       every namespaced call as unknown (toolBaseName strips a scope suffix, not the server prefix);
#       the laws caught it and toolSlugOf now does that job. One cut stayed green on first write (the
#       repair turn dropped from the per-model spend) and K3 now pins the attribution too.
#   +14 fan_out (new file) — a chair seated once per item of a sealed set, each instance handed only
#       its slice (and only the join items that match it), each seal naming the slice's sha. 21 wires
#       cut; six first cuts broke the build and the runner said so instead of reporting green.
#   +13 sealed_inputs (new file) — spec.coltrane-sealed-inputs: a dispatch names sealed outputs
#       ($output / $query) and runGig resolves, re-hashes, type-checks and delivers them, stamping an
#       engine-only resolution that trace() may cross. Sabotage ran over 18 wires; four stayed green on
#       first write (markers left in gig_input, the door's type check — L2 passed on a LATER chair's
#       refusal — an undeclared key silently dropped, a mixed array) and each got a law that reds.
#   +1  mcp_tools_describe law 7 (#535) — a description that backticks an argument names one the
#       verb's own input_schema declares. The prose sits beside a GENERATED schema: the schema moves
#       with the handler, the description does not. Its first draft could not fail — it forgave any
#       token no tool anywhere declared, which is exactly what a renamed argument leaves behind.
#       Sabotage said so (`current` -> `slug_current` stayed green); the exemption is gone.
EXPECTED_FILES="${EXPECTED_FILES:-438}"   # + tests/genome_writes_stay_in_root.test.ts, + tests/skill_runs_on_exec_path.test.ts, + tests/node_floor_where_skills_run.test.ts, + tests/bus_not_hosted.test.ts, + tests/every_skill_runs_its_fixtures.test.ts, + tests/node_floor_refuses.test.ts, + tests/spec_reside_drive.test.ts (#537), + tests/a_red_law_names_its_plant.test.ts (#551), + tests/sealed_inputs.test.ts, tests/fan_out.test.ts, tests/completions_seal.test.ts, tests/tier_ladder.test.ts, tests/amend_ladder.test.ts, tests/completions_reasoning_effort.test.ts, tests/bus.test.ts, tests/bus_chair.test.ts, tests/bus_terminal.test.ts, tests/bus_verbs.test.ts, tests/bus_commit.test.ts, tests/code_tools.test.ts, tests/gig_input_validated.test.ts, tests/seat_reads_recorded.test.ts, tests/claude_seat_reads.test.ts, tests/optional_declared_input.test.ts, tests/simulate_names_seats.test.ts

# THE OTHER BANDS. `vitest run` is ROOT-CONFIG ONLY — this repo's own workflow comments
# record that four configs went unexecuted once for exactly that reason. So pinning only the
# root band would repeat the mistake one level up: a pinned entrypoint that is silent about
# most of the configs it does not run. They are small, they are fast, and there is no excuse
# for leaving them unpinned while claiming the laws are counted.
EXPECTED_FAILURE_MODES_FILES="${EXPECTED_FAILURE_MODES_FILES:-5}"
EXPECTED_HONEST_BROKER_FILES="${EXPECTED_HONEST_BROKER_FILES:-2}"
EXPECTED_SECURITY_FILES="${EXPECTED_SECURITY_FILES:-4}"   # + skill_runs_on_exec_path.spec.ts: an old PATH node must not open the network to an ungranted skill (a real request)   # + completions_long_wait.spec.ts: the 300s header limit needs a real socket to disprove   # + skill_network_grant.spec.ts: proving a network gate needs a real request, which the root suite forbids

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
# numTotalTests includes 'todo' laws (3487 passed + 22 todo = 3509). Todos are DECLARED
# laws — a todo silently deleted is a law silently abandoned — so they are counted.
#
# NO BACKTICKS AND NO DOUBLE QUOTES ANYWHERE IN THIS BLOCK. The python source sits inside a
# double-quoted bash string, so bash reads every character of it first: a backtick here is
# command substitution (one word in a comment was being RUN, printing a command-not-found
# line over the counts this script exists to report), and a double quote ENDS the argument,
# which breaks the read below and exits the whole script under set -e. Both were committed
# here, the second while fixing the first.
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
