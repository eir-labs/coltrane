# A sealed defect-investigation run — the write-boundary bug

`write-boundary-investigation.jsonl` is a **real, unedited sealed output stream** from dispatching
the `defect-investigation-v1` standard against an actual defect in this engine: model chairs'
outputs were validated post-hoc at seal instead of at the write boundary, so a contract-violating
payload aborted the gig with an empty seal. (The fix this investigation drove landed in PR #311.)

It is here as a **worked example** — the way the engine's own provenance chain reads when a real
methodology runs, rather than a description of it. The worked examples are the manual.

## What's in the file

Four content-addressed sealed outputs, one JSON object per line, in the order the standard
produced them:

| # | domain type | primitive | `content_sha` | `input_shas` |
|---|---|---|---|---|
| 1 | `reproduction`    | SENSE     | `1b62daa6…` | `[]` — the root; senses the gig input |
| 2 | `defect-location` | INTERPRET | `0f075fa3…` | `[1b62daa6…]` — consumes the reproduction |
| 3 | `root-cause`      | JUDGE     | `419408c7…` | `[0f075fa3…]` — consumes the location |
| 4 | `defect-class`    | INTERPRET | `3d972c06…` | `[419408c7…]` — consumes the root-cause |

Each output's `input_shas` names **exactly** the `content_sha` of what it consumed — the
provenance chain is engine-stamped, not asserted by the agent. Read the column top-to-bottom and
the chain is a straight line: reproduce → locate → root-cause → generalize-to-class.

## What it demonstrates

- **The methodology.** `defect-investigation-v1` does not stop at a root cause. It abstracts the
  root to its **defect class** (output 4) — the single invariant that, held everywhere, kills the
  whole class — so the fix is class-complete, not an instance patch. That is the point of the
  standard, and output 4 is where it happens.
- **The sealed chain.** Every output carries `content_sha` (the hash of its own `data`),
  `input_shas` + `input_refs` (what it consumed), the `agent_slug` and `phase` that produced it,
  and the `model` the run actually spent. Nothing in the chain is recomputed or recalled.

## Reading and fidelity notes

- It is JSON Lines: `while read line; do echo "$line" | jq .; done < write-boundary-investigation.jsonl`.
- It is **verbatim**. `content_sha` is the hash of each output's `data`, so editing any payload
  would break its own hash and the `input_shas` of everything downstream — the outputs are shown
  exactly as sealed. That includes one imprecision in output 2 (a locator quote attributed to the
  wrong sibling file); it is the real agent's output, left as it sealed, because that is what a
  faithful record is.
