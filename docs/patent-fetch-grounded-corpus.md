# Grounded patent-fetch — a real, cage-bound corpus tier

**Status:** RED spec (this PR is the contract; implementation lands against it).
**Defined by:** `tests/patent_fetch_spec.test.ts` (structural, RED) + `tests/e2e/patent_fetch_live.spec.ts` (COLTRANE_LIVE).

## Problem

`patent-fetch` today is a mock: `permission.tier = 0` (filesystem-read only), no network grant, and
its "live path" can never fire because the skill cage is deny-by-default on egress. So prior-art
search has never touched a real corpus — the v0 failure (an unfounded FILEABLE) and the reason the
v1 verdict-gate has to fall back to INSUFFICIENT-EVIDENCE. The agent's `allowed_tools`
(`WebSearch`/`WebFetch`) don't help: the patent surfaces that matter are JS-walled or return raw
JSON the model can't fetch from inside the cage.

## What we proved

A spike (no browser, no API key) fetched real patents from **Google Patents**, which
**server-renders the bibliography into HTML**. From `US9652599B2` in ~400 ms we extracted a full,
verifiable record:

```
title         "Restricted code signing"
assignee      "Arris Enterprises LLC"
inventors     ["Alexander Medvinsky", "Ali Negahdar", "Xin Qiu"]
dates         priority 2014-06-11 · filing 2015-06-11 · grant 2017-05-16
cpc_codes     ["G06F21/10", "H04L9/3247", … 15 total]
claims        real claim text, per-claim
citations     ["US20050246523A1", "US9141150B1", … 9 backward refs]
content_sha   aa68261e… (hash over the fetched bytes)
verified      true (HTTP 200 + title present + abstract section present)
```

**Per-patent fetch + verify needs no browser** — it's a plain HTTPS GET. That covers exactly what
`citation-verify` needs: turning "I cite patent X" into a hash-pinned record of X's real text.

## Architecture — two tiers

| tier | for | substrate | determinism |
|---|---|---|---|
| **HTTP** (this PR) | per-patent fetch+verify; structured sources | `fetch()` in the cage, allowlisted hosts | record HAR → fixture → replay |
| **Browser** (follow-up) | JS-walled SEARCH surfaces (Google Patents search, USPTO Patent Public Search) | Playwright behind a domain allowlist | trace + HAR sealed as provenance |

Sources, by tier:
- **Google Patents** (HTTP) — per-patent biblio is in the HTML. Primary verification source.
- **EPO OPS** (HTTP) — official REST API, OAuth key, free tier. Best *structured* source (needs a key).
- **USPTO Patent Public Search** (browser) — JSON behind a session; the search UX is JS-walled.

## The tool addition — a network permission tier on the skill cage

The cage today is tiers 0/1/2 = filesystem-read / +write / +child; **network is denied at every
tier**. This PR adds network as an explicit, allowlisted grant — the load-bearing safety lever and
the "tool" being added:

```jsonc
// skills/patent-fetch/meta.json
"permission": {
  "tier": 0,
  "network": {
    "allow": ["patents.google.com", "ops.epo.org"],   // deny-by-default; allowlist IS the policy
    "methods": ["GET"],                                 // read-only — no POST/PUT/downloads
    "max_requests": 40,                                 // per-gig egress budget + kill-switch
    "max_bytes": 33554432
  }
}
```

- **Deny-by-default**: a host not on `allow` is blocked before the request leaves. The allowlist
  string is the enforcement token — same shape as our per-agent tool grant (the scope IS the policy).
- **Read-only**: only `methods` are permitted; scraping never writes to a remote.
- **Egress budget**: `max_requests`/`max_bytes` is a finitude bound — a runaway agent can't crawl the
  open web. Mirrors the per-gig cost budget.
- **Content-hashed grant**: `network` is part of the package's content hash, so tampering with the
  allowlist breaks the genome chain (tamper-evident).
- **Content-addressed cache**: a granted patent's text is immutable → hash(url) → body is a forever
  cache; a re-fetch is a cache hit, not a request (IO is scarce).

## The full record — `patent-record` (new domain type)

The verified full patent document, extends `Signal`, domain `patent-triage`:

| field | req | note |
|---|---|---|
| `patent_number` | ✓ | canonical publication number |
| `source` | ✓ | "Google Patents" / "EPO OPS" / "USPTO" — feeds coverage-report |
| `url` | | the fetched document URL |
| `title` | ✓ | |
| `abstract` | | |
| `inventors` | | array |
| `assignee` | | |
| `priority_date` / `filing_date` / `grant_date` | | |
| `cpc_codes` | | classification array |
| `claims` | | per-claim text |
| `claim_count` | | |
| `backward_citations` | | cited prior-art numbers |
| `verification_method` | ✓ | "fetch" \| "api" \| "snippet" — snippet is NOT admissible for a verdict |
| `verified` | ✓ | HTTP 200 + title present + claims/abstract present |
| `fetched_at` | | ISO timestamp (stamped by the runtime, not the skill) |
| `content_sha` | ✓ | hash over the fetched bytes — the grounding anchor |

A `patent-record` without `verified` + `content_sha` is **not admissible** — the honesty boundary:
a citation is grounded only when its real text was fetched and pinned.

## Browser tier — `patent-search` as a caged Playwright skill

The JS-walled **search** surfaces (Google Patents search, USPTO Patent Public Search) need a real
browser. The design choice that matters: **make it a deterministic skill, not a model-driven browser
tool.** A skill runs deterministic code in the cage — the model picks the *query* (via `query-expand`),
the skill *executes* the search and returns candidate patent numbers, which `patent-fetch` then
verifies. The model never drives the browser turn-by-turn.

This is not just tidier — it sidesteps the dead-tool problem in **#185**: an agent that grants
`browser_navigate` lists it in its prompt and `--allowedTools`, but the spawn wires no provider
(`mcp_servers: []`), so the tool is a dead name and the agent confabulates. A caged skill has no such
gap: its capability *is* its code plus a content-hashed grant. (#185 remains the backbone for the
*general* model-driven grounding case — agents that browse to ground — and the browser tier's grant
shape below is designed to resolve through the same tool-grant→provider machinery #185 introduces.)

`patent-search`'s grant extends the network cage with a browser block:

```jsonc
"permission": {
  "tier": 2,                                  // browser needs child-process (spawn the engine)
  "network": { "allow": [...], "methods": ["GET"], "max_requests": 40 },
  "browser": {
    "allow": ["patents.google.com", "ppubs.uspto.gov"], // navigation allowlist — route() aborts off-list
    "read_only": true,                        // no downloads, no POST/form-submit off the search path
    "isolate": true,                          // ephemeral context per gig (no cookie/storage bleed)
    "max_pages": 25,                          // page budget — a runaway can't crawl the open web
    "eval_scripts_sha": ["<sha256>"]          // ONLY these vetted extraction scripts run via evaluate;
                                              // never model-authored JS at runtime (code-first, hashed)
  }
}
```

Enforcement points (the cage upgrades, made concrete):
- **navigation allowlist** — `page.route("**/*", r => allowed(host) ? r.continue() : r.abort())`; a
  nav off the allowlist is refused, not silently performed.
- **read-only** — block downloads, non-GET, and form-submits to anything but the search endpoint.
- **ephemeral isolation** — a fresh browser context per gig (formalizes `BROWSER_SESSION_KEY`).
- **vetted scripts only** — `page.evaluate` runs only the `eval_scripts_sha` extraction code; the
  model picks *which* patent, the hashed code does the *how*.
- **trace = provenance** — the Playwright trace (every nav + request + DOM snapshot) is hashed and its
  `content_sha` recorded on the `coverage-report`, so "the search actually hit USPTO" is a sealed
  artifact, not a claim.
- **politeness** — per-domain rate-limit + jitter so the corpus doesn't IP-ban the search.

**OPENs** (decide at implementation): (a) bundle Playwright as an engine dependency vs. resolve the
browser via #185's registrable MCP server and add the allowlist guard around it; (b) exact
`eval_scripts_sha` packaging (inline in the skill vs. a `scripts/` dir in the package, hashed with it).

## RED → green

1. `patent-record` type registered with the full contract.
2. `patent-fetch` rewritten: HTTP-tier fetch → extract → verify → `patent-record`; fixtures are a
   recorded real Google Patents HTML and its expected record (deterministic, replayed in CI).
3. Skill cage: parse + enforce `permission.network` (allowlist, methods, budget); deny-by-default.
4. `prior-art-scout`: drop the non-working `WebSearch`/`WebFetch`; bind the network grant; consume
   `patent-record`; emit `coverage-report` attesting the real corpus.
5. Browser tier (follow-up PR): Playwright behind the same allowlist for the JS search surfaces.

A slice is done when its `describe()` block in `tests/patent_fetch_spec.test.ts` goes green.
