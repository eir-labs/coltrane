# chain_query — backward-queryability example

Read-side primitives over an append-only chain log. Demonstrates that the chain's structural value lives in what you can ASK of it, not just what you can append.

## Primitives

Both proto files (`chain_query_proto.py`, `chain_query_proto_v1.py`) implement four read-side queries over a JSONL chain:

- **`registrations_by_agent(voice, window)`** — pre-registered claims by author within a time window
- **`completed_cycles(voice, window)`** — forward walk from each registration looking for matching test_run + verdict within a cycle window
- **`falsification_rate(voice, window)`** — verdicts matching `FAIL | KILL_FIRED | failed_at | RIPENED_DIFFERENTLY` over total verdicts
- **`cycle_lineage(verdict_idx)`** — backward walk surfacing prior events that share test-cycle event types with a given verdict

## v0 vs v1

- **v0 (`chain_query_proto.py`)** — operates on raw chime text via regex proxy for test-cycle event types. Counts everything, including response-acks and presence-ticks.
- **v1 (`chain_query_proto_v1.py`)** — adds a text-proxy category classifier that mirrors the chain's `categorize_kind` schema (chime / ack / presence / settlement / other) and filters to `chime` only before applying the four primitives. Cleaner numerator for falsification rate.

When typed event_kinds reach the read source, swap text-proxy for chain-truth — same four primitives, structurally invariant.

## Input format

Reads `~/.eir/inbox_studio.jsonl` by default. Each line is a JSON object with `ts`, `user`, `text`, `logged_at` fields. The `AGENT_LABELS` map in the proto resolves Slack user_ids to logical voice labels.

## Run

```bash
python3 chain_query_proto.py --window-hours 24 --voice <voice_name>
python3 chain_query_proto_v1.py --window-hours 24
```

Output is JSON to stdout, one block per primitive, including per-voice tables for the v1 variant.

## Why this matters

Append-only chains are easy to append to and hard to ask questions of. Backward-queryability is the structural property that turns an audit log into an answer-engine. The four primitives here demonstrate that property concretely: you can compute per-voice discipline ratios, walk lineage, and surface divergence — all read-only — without modifying the chain or introducing a second write path.

The v0→v1 progression also documents a real confound: text-proxy classification of message intent is noisy enough to require a category filter, and even that filter only partially resolves the noise. Chain-truth (typed event_kinds at append time) is what closes the gap.
