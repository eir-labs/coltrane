# The caged browser — deny-by-default browser automation, shipped default

Raw browser automation is powerful and dangerous: an agent with a browser can reach **any** site,
persist state across runs, and exfiltrate. Most agent frameworks hand the model a browser and trust
the prompt to keep it in bounds — which is no boundary at all.

Coltrane ships a **deny-by-default browser cage** as a first-class substrate feature. An agent
*declares* the origins it may reach; coltrane builds the browser so it **physically cannot reach
anything else**. The boundary is enforced by the browser server, not by prompt etiquette.

## How it works

An agent that grants the browser tools (`mcp__playwright__*`) declares a `browser_grant`:

```jsonc
// agents/patent-browser-scout.json
"allowed_tools": ["mcp__playwright__browser_navigate", "mcp__playwright__browser_snapshot", …],
"browser_grant": { "allowed_origins": ["ppubs.uspto.gov"] }
```

At dispatch, coltrane resolves that grant (`#185`) and **builds the Playwright server from the
declaration** — `buildPlaywrightCage` renders the `@playwright/mcp` config:

```
npx @playwright/mcp@latest --headless --isolated \
    --allowed-origins ppubs.uspto.gov \
    --save-session --output-dir <trace dir>
```

- **`--allowed-origins`** — the nav allowlist. An origin not on it is refused **at the network**
  (`net::ERR_BLOCKED_BY_CLIENT`), never reached. This is the deny-by-default boundary.
- **`--isolated`** — ephemeral in-memory profile; no cookie/storage bleed across gigs.
- **`--headless`** — no UI, no human-session hijack.
- **`--save-session` + `--output-dir`** — the session (every navigation + tool call) is written to
  disk for provenance: "the browser actually went to ppubs.uspto.gov" is an artifact.

**Fail closed:** an agent that grants `mcp__playwright__*` tools but declares *no* `browser_grant`
has no caged server built — its grant is unresolvable and the chair fails closed (`#185`). There is
no path to an *un*caged browser.

## Proof

`tests/e2e/playwright_cage_live.spec.ts` (gated `COLTRANE_LIVE=1`) dispatches a real browser agent
caged to `ppubs.uspto.gov` and asserts both halves:

```
allowlisted_uspto_loaded: true    — "Patent Public Search | USPTO" loaded
offlist_example_loaded:   false   — example.com refused: net::ERR_BLOCKED_BY_CLIENT
```

The deterministic half (`tests/playwright_cage.test.ts`) pins the exact config the builder ships.

## The demonstrator

`patent-browser-scout` is a shipped agent that uses the cage for real: it drives **USPTO Patent
Public Search** (the one origin its cage permits), runs a structured query (USPTO's field-code
syntax — free text returns everything; `code.ti,ab. AND integrity.ti,ab. AND (hash OR signature).ti,ab.`
returns a filtered, relevant set), reads the results off the page, judges relevance, and emits a
`coverage-report` that attests the official corpus was actually searched. Proven live: a real
structured query returned 237 genuinely relevant patents through the caged browser.

USPTO is the right instrument here — unlike scraping-hostile surfaces, the official Patent Public
Search serves a real browser session, so the caged browser reaches it where a naive HTTP scrape is
blocked. The cage makes that reach **safe by construction**.
