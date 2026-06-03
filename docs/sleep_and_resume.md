# sleep & resume — live-slack operator commands

Two CLI subcommands shipped alongside `coltrane play --live-slack`.

## `coltrane resume <uuid>`

Open a Steve's inner claude-code thread in your terminal. The orchestrator's
worker writes a `session.json` into each `.coltrane/steve_<uuid>/` on first
claude-code spawn; `resume` reads that file and re-execs `claude --resume
<session_id>` with inherited stdio so you land directly in the inner
monologue.

```
coltrane resume 3f9a-...
```

The session persists across resumes — exit when done; the next `resume` picks
up the same thread. If `session.json` is missing, you'll see a hint to run
`coltrane play --live-slack` first.

## `coltrane sleep <uuid>` and `coltrane sleep --all`

Manual trigger for the bleach-wash that surfaces ratchet candidates from
the last 24h of audit. Each Steve gets a `sleep/receipt_<iso>.json` and an
appended `sleep_cycle` line in its `audit.jsonl`.

```
coltrane sleep 3f9a-...     # one Steve
coltrane sleep --all        # all 4
```

Until the sleep-math PR lands, receipts come back with
`error: "sleep_math_not_yet_wired"` and `candidate_count: 0`. The CLI
surface and the on-disk receipt shape are stable; the math swap is
internal.

## Nightly auto-sleep

`coltrane play --live-slack` also registers a nightly bleach-wash at **3am
local time**. The orchestrator log records each fire as `event:
nightly_sleep_complete`; results land alongside any manual receipts. The
schedule is cancelled cleanly on shutdown.

Sleep math is shipping in parallel; resume + the manual trigger + the
nightly cron are live now.
