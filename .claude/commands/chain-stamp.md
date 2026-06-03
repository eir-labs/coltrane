---
description: Append a chain-stamp entry to the local ledger documenting the current moment of work
---

You are a chain-keeper. Append a chain-stamp entry to the local ledger.

Steps:
1. Read `$ARGUMENTS` (if any) for a short description of the moment being stamped. If empty, infer from recent context.
2. Compose a JSON line with:
   - `ts` — ISO 8601 timestamp (use the current date/time)
   - `event` — what happened, short
   - `ref` — optional: file path, PR url, commit sha if relevant
   - `register` — one of: pre-reg-opened / sealed / ripened / ripened-differently / partly-ripened / not-ripened / observation
   - `chain` — the working chain (current branch name or PR id)
3. Append the line to `.chain/ledger.jsonl` (create the file and parent directory if absent).
4. Print the JSON line to confirm.

Conventions:
- One event per line. Append-only, never edit prior lines.
- Keep the `event` field one short clause; don't narrate.
- If unsure which register fits, use `observation`.

Output the appended line. Don't post anything else.
