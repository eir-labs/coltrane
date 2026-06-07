# Hot-reloading Coltrane without losing your Claude Code session

Two cases come up while iterating on Coltrane from inside Claude Code.
They have different fixes, and confusing them costs a session.

## Case 1 — you changed agents / standards / domain-types / skills / evals

This is a **genome change** (definitions, no MCP server code touched).
The MCP server is fine — only the files in `agents/`, `standards/`,
`domain_types/`, `skills/`, `evals/` changed.

**Fix:** call the MCP tool `genome_reload` from inside Claude Code. The
server re-reads the genome from disk in place; no restart, no new session.

```
> coltrane genome_reload
```

The tool returns `reloaded: true`, a diff of what changed, and any
per-file load errors. Your conversation context is untouched.

## Case 2 — you changed Coltrane server code itself

This is a **server-binary change** (you edited `src/`, ran
`npm run build`, and the new `dist/` bytes need to be running). The MCP
process is loaded from a Node entry point — restarting Claude Code is
*one* way to pick up the new code, but it ends your conversation.

**Fix** (Rob's recipe — keeps the session alive):

```bash
# 1. Drop the MCP registration in your current session.
claude mcp remove coltrane -s local

# 2. Re-add it pointing at the freshly built server entry.
claude mcp add coltrane node /absolute/path/to/coltrane/dist/src/server_entry.js

# 3. Branch the conversation (forks history; lets you resume cleanly).
/branch

# 4. Note the session id printed by /branch, then resume:
claude -r <session-id>
```

Coltrane comes back alive in the same conversation, running the new
binary.

## Which case am I in?

- Edited a `.json` under `agents/` or `standards/` or `domain_types/` or
  `skills/` or `evals/` → **Case 1**. Use `genome_reload`.
- Edited a `.ts` under `src/` and ran `npm run build` → **Case 2**. Use
  Rob's recipe.
- Both at once → run Case 2 (it picks up the new server, which loads the
  fresh genome on boot).

## Why two cases?

Coltrane is two layers running in one process:

- The **genome** — the typed JSON definitions read from disk at boot and
  re-read on `genome_reload`. Everything user-authored lives here.
- The **server** — the Node binary that exposes the MCP tool surface
  and dispatches gigs through the runtime. Changes here require the
  process to restart.

`genome_reload` (PR #136) was built so the common edit loop — tweaking an
agent prompt, adding a domain type, refining a standard — never costs you
a session. Case 2 is the rarer loop (changing the Coltrane code itself),
and Rob's recipe is the manual dance that handles it without ending the
conversation.

— captured from Rob's first-user iteration, 2026-06-07
