# Hot-reloading Coltrane without losing your Claude Code session

Two cases come up while iterating on Coltrane from inside Claude Code.
They have different fixes — confusing them costs a session.

## Case 1 — you changed agents / standards / domain-types / skills / evals

This is a **genome change**: definitions on disk moved, no Coltrane server
code touched. Anything under `agents/`, `standards/`, `domain_types/`,
`skills/`, or `evals/`.

**Fix:** call the MCP tool `genome_reload` from inside Claude Code. The
server re-reads the genome from disk in place; no restart, no new
session.

```
> coltrane genome_reload
```

The tool returns `reloaded: true`, a diff of what changed, and any
per-file load errors. Your conversation context is untouched.

## Case 2 — you changed Coltrane server code itself

This is a **server-binary change**: you edited `src/`, ran
`npm run build`, and the new `dist/` bytes need to be running. The MCP
process is loaded from a Node entry point — its in-memory bytes are
stale until the process restarts.

**Fix:** call the MCP tool `server_restart`. The Coltrane stdio entry
runs as a parent-relay process that holds the stdio pipe to Claude Code
forever and spawns the actual server as a child. `server_restart` kills
the child and respawns it with the new bytes; the parent-side pipe never
moves, so your conversation continues.

```
> coltrane server_restart
```

Returns when the new child is up.

## Which case am I in?

- Edited a `.json` under `agents/`, `standards/`, `domain_types/`,
  `skills/`, or `evals/` → **Case 1**. Use `genome_reload`.
- Edited a `.ts` under `src/` and ran `npm run build` → **Case 2**. Use
  `server_restart`.
- Both at once → run Case 2 first (the new child re-reads the genome on
  boot).

## Why two cases?

Coltrane is two layers running in one process:

- The **genome** — the typed JSON definitions read from disk at boot
  and re-read on `genome_reload`. Everything user-authored lives here.
- The **server binary** — the compiled Node bytes that expose the MCP
  tool surface and dispatch gigs through the runtime. New bytes require
  the child process to restart, which is what `server_restart` does
  inside the relay so the conversation survives.

`genome_reload` (Rob #130 / PR #136) handles the common edit loop —
tweaking an agent prompt, adding a domain type, refining a standard.
`server_restart` handles the rarer loop (changing Coltrane server code
itself) without ending your conversation.

## Architecture: why a parent-relay process

Claude Code spawns the Coltrane MCP server as a child via stdio. It
holds the pipe to that specific PID; if the PID dies, the pipe dies with
it. A naive "restart the server" approach kills the conversation.

The relay solves this by inverting the topology. The stdio entry
(`src/server_entry.ts`) runs as a small proxy in the parent — it
spawns the actual server as a *child* of itself, forwards stdin to the
child, forwards the child's stdout back out, and intercepts the
`server_restart` tool call locally. When `server_restart` fires, the
relay kills the child, re-spawns it, and replies to the client only
after the new child is up. The parent-side pipe never moves.

```
Claude Code  ──stdio──>  relay (parent)  ──stdio──>  server (child)
                              │
                              │  intercepts tools/call server_restart
                              │  kills + respawns the child
                              │  pipe to Claude Code never moves
```

Setting `COLTRANE_SERVER_DIRECT=1` skips the relay and runs the server
directly (single-process, legacy behavior). The relay uses this flag to
spawn its child; debug scripts and the e2e harness use it to avoid the
extra process.

## Pre-relay workaround (kept for reference)

Before `server_restart` shipped, the manual workaround was to drop the
MCP registration in Claude Code and re-add it — Rob found this on
2026-06-07:

```bash
claude mcp remove coltrane -s local
claude mcp add coltrane node /absolute/path/to/coltrane/dist/src/server_entry.js
/branch
claude -r <session-id>
```

This still works on builds before the relay shipped, but the relay's
`server_restart` does the same thing in one tool call and without the
session/branch dance.

— captured from Rob's first-user iteration, 2026-06-07 →
  parent-relay landed 2026-06-08
