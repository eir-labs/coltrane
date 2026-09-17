# seat-memory.red-spec — a chair spawn never writes the operator's auto-memory

**Contract:** `contract-seat-memory-v1`. A seat's writes are its grants; the operator's memory is
not a seat's to write. **Laws (RED):** `tests/spec_seat_never_writes_operator_memory.test.ts` —
every law FAILS today; the enforcement below does not exist yet.

## The measured defect

A `claude -p` seat granted only `Read`, spawned as the Claude invoker spawns chairs
(`--setting-sources user`), wrote `project_package.md` into `~/.claude/projects/<repo>/memory/` —
the operator's own auto-memory, loaded by every later session in the repo (claude 2.1.274).
`--settings '{"autoMemoryEnabled":false}'` removes the memory tool and leaves the directory
unchanged (probed 2026-09-17) — but it is not passed. `--setting-sources user` bounds which
settings FILES load; it does not turn the feature off, so the seat keeps the tool and writes.

## O1 — the obligation

Every Claude chair spawn passes exactly one `--settings` argument whose JSON sets
`autoMemoryEnabled` to `false`.

- **Mechanism / callsite:** `buildInvokerArgs` (`src/claude_invoker.ts`, beside `--setting-sources
  user` at ~`:1123`) pushes one `--settings` `{"autoMemoryEnabled":false}` pair. Exactly one, so
  the setting is unambiguous. Every spawn is built there, so it reaches all spawn kinds from one
  point; `--settings` is disjoint from `--setting-sources`, `--effort` and the session flags, so
  the effort and session-continuity contracts are untouched.
- **Verified by:** `O1 — a first-run spawn passes exactly one --settings whose JSON sets
  autoMemoryEnabled false`.

## I1 — the invariant

It holds on every spawn a chair makes: the first run, the turn-budget reserve continuation, a
resumed amend, and a cold fallback.

- The reserve continuation (`withPrompt`/`withMaxTurns`/`withResume`) and the cold fallback both
  transform the same `baseArgs`, editing only prompt, turn cap and session flag — so the
  `--settings` pair rides through. A resumed amend re-invokes `buildInvokerArgs` with
  `resume: true`, which still emits the pair.
- **Verified by:** the four spawn-kind laws — `resumed amend` (`buildInvokerArgs` with
  `session_id`+`resume`), `reserve continuation` and `cold fallback` (scripted stream-json through
  the injected run seam), and `makeClaudeInvoker driven by runGig` (the real dispatch path).

## Method

Example-based, axiomatic per spawn kind: each spawn kind is a specific behavior, so each law
captures that kind's argument list and asserts the single `autoMemoryEnabled:false` `--settings`
directly. Not property-based — the invariant is a fixed enumeration of four spawn kinds.
