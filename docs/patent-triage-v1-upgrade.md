# Patent-triage v1 — upgrade plan

**Status:** proposal / spec. Defined by `tests/patent_triage_v1_spec.test.ts` (RED contracts + OPEN forks).

## Why

`patent-triage-v0` runs end-to-end and is honest about its citations, but as *patent work*
it is shallow: it is a competent formatter of patent-shaped reasoning, not yet a competent
analyst. A live run (sealed gig `47d06906…`) made four failures concrete:

1. **It never questioned the invention.** The cleave stripped the plausibly-novel element
   (the permission tiering) as "representation" and rested novelty on the oddest one
   (degrade-to-model-reasoning on hash mismatch). No seat is allowed to reject the premise.
2. **It searched zero patents, then stamped `FILEABLE`.** A patentability triage that never
   touches a patent corpus. The "closest art" was 0.6 relevance because the corpus was wrong
   (web/blogs), not because the idea is novel.
3. **Thin claim tree.** One independent claim restated twice; the only dependent claims were
   boilerplate bolted on at the end. No fallback-position tree — most of the craft of claiming.
4. **The "provisional draft" is a table of contents.** Its Detailed Description is an
   outline with no embodiments, no worked example — zero §112 enablement.

Root cause is architectural, not runtime: each agent is a single-pass, rigid-schema fill
that **rewards looking rigorous over being right** (5 failure modes, 6 "what-this-is-NOT"
items), there is **no adversary**, the decision table **cannot say "insufficient,"** and
nothing **iterates**.

## Goal

Given an invention disclosure, produce a triage an inventor + attorney can trust: the
strongest defensible claim set, a prior-art landscape that **includes patents**, an honest
novelty/obviousness analysis that **can return "insufficient,"** a verdict that is *earned*,
and — only if fileable — a provisional with **real enablement**. Otherwise an honest
"can't assess" or "not worth filing, here's why."

## Methodology — the score

```
analyze → claim → search → map → [ examine ⇄ amend ]×K → judge → (draft)
```

| phase | does |
|---|---|
| **analyze** | de-spin the disclosure: the *real* technical contribution vs. what the inventor thinks is novel; candidate inventive concepts (plural); embodiments |
| **claim** | broadest defensible independent claim **+ a dependent fallback tree** |
| **search** | prior art across **patents *and* literature**, per claim element, iteratively; emit a **coverage-report** (corpora + query log) |
| **map** | element × reference **matrix**: §102 anticipation per element + §103 obviousness combinations |
| **examine ⇄ amend** | an **adversary** tries to kill the claim (§101/§102/§103/§112); an amender narrows to survive or concedes; loop until it survives or dies |
| **judge** | verdict with a real `INSUFFICIENT-EVIDENCE` state and hard gates |
| **draft** (conditional) | provisional with embodiments + how-to-build, only if fileable |

## Agents — 8 seats

Each is a full charter (identity / method / constraints / exactly-two Belbin roles) that
clears the behavioral floor. The v0 four (`diamond-cutter`, `novelty-searcher`,
`claim-rewriter`, `verdict-judger`) are retired into this roster.

| agent | disposition | primitives | charter | grant |
|---|---|---|---|---|
| **disclosure-analyst** | explorer + analyst | SENSE · INTERPRET | extract the real contribution; separate claimed-novel from actually-new | — |
| **claim-architect** | planner + analyst | INTERPRET · PLAN | broadest defensible independent + dependent tree (replaces diamond-cutter; keeps diamond-cutting-discipline) | claim-element-decompose |
| **prior-art-scout** | explorer + critic | SENSE · JUDGE | search patents + literature per element, iteratively; emit coverage-report (replaces novelty-searcher) | patent-fetch, query-expand, citation-verify |
| **anticipation-mapper** | analyst + critic | INTERPRET · JUDGE | build the element × ref matrix; §102/§103 calls | element-mapping-matrix |
| **patent-examiner** (adversary) | critic + executor | JUDGE · VERIFY | *try to reject the claim* on every statute | statutory-checklist |
| **claim-amender** | planner + executor | INTERPRET · PLAN | narrow to survive the rejection, or concede (replaces claim-rewriter) | claim-element-decompose |
| **triage-judge** | critic + synthesizer | JUDGE · VERIFY | verdict + confidence; **hard-gated** (replaces verdict-judger) | — |
| **spec-drafter** | executor + planner | PLAN · CREATE | provisional with real enablement (gated) | — |

## Skills — the deterministic spine

Inference is scarce; encode what repeats. Each is code-first + model-residual,
content-hashed, cached, run in the permission-tiered cage:

| skill | code half | model residual |
|---|---|---|
| **claim-element-decompose** | split a claim on `comprising`/`;`/`wherein` into elements | label each element's function |
| **patent-fetch** | query a real patent corpus (candidate: USPTO PatentsView API — free, structured) | — (pure I/O) |
| **query-expand** | template CPC/IPC class + keyword sets from elements | domain synonyms |
| **citation-verify** | fetch a source, return the supporting quote or `unverified` | judge whether the quote grounds the claim |
| **element-mapping-matrix** | scaffold the empty element × ref grid | fill each cell present/absent/partial |
| **statutory-checklist** | the §101/§102/§103/§112 rubric structure | answer each item |

## The gates — what makes it un-shallow

Enforced as standard `eval_slugs` and/or hard constraints in agent charters — the teeth, in
the spirit of the existing grant⇒cap floor rule:

1. **Coverage gate** — `triage-judge` cannot emit `FILEABLE` unless the coverage-report shows
   ≥1 patent corpus searched with results. No patents → `INSUFFICIENT-EVIDENCE`. *(failure 2)*
2. **Grounding gate** — an anticipation finding may cite only a `verified:true` (fetched, not
   snippet) reference. *(the Nightfall overstatement found in the v0 run)*
3. **Survival gate** — `FILEABLE` requires the claim survived ≥1 examine⇄amend round. *(failure 1)*
4. **Claim-tree eval** — the claim set needs ≥1 independent + ≥2 dependents. *(failure 3)*
5. **Enablement eval** — a provisional-draft needs ≥1 worked embodiment + how-to-build. *(failure 4)*

New verdict state: `triage-verdict.recommended` must enumerate
`FILEABLE | REFINE-FIRST | NOT-FILEABLE | INSUFFICIENT-EVIDENCE`.

## The loop in coltrane terms

`examine ⇄ amend` is a cycle; `composeStandard` forbids cycles in the phase DAG. Two options
(an OPEN fork in the spec):

- **Caller-driven (preferred)** — the standard runs `analyze…map`, then the dispatching MCP
  client orchestrates examine/amend rounds via async `gig_dispatch` until the verdict
  stabilizes (the manual refine loop, made first-class). Async dispatch + monitor + `gig_logs`
  make it watchable.
- **Unrolled** — bake `examine-1, amend-1, examine-2, amend-2` as fixed phases. Self-contained,
  capped depth.

## Build order — smallest load-bearing first

1. **`patent-fetch` skill + `prior-art-scout` + coverage gate + `INSUFFICIENT-EVIDENCE`.**
   Flips the verdict from unfounded-`FILEABLE` to honest. *Root failure — start here.*
2. **`patent-examiner` + `claim-amender` + survival gate** — the adversary loop; biggest depth gain.
3. **`anticipation-mapper` + element-mapping-matrix + grounding gate** — element-level rigor + citation discipline.
4. **`spec-drafter` + enablement eval** — turn the outline into a real draft.
5. Retire the v0 four into the new roster.

Each slice merges when its acceptance contracts (the RED tests) go green.

## Review resolutions (PR #173)

Three reviews converged; the resolved forks (now RED contracts in the spec) and the
construction decisions:

- **`distance_score` is dropped.** A confidence number not traceable to a deterministic input
  is the v0 failure mode — it reads like evidence and isn't. Replaced by
  `element-mapping-matrix.coverage_fraction`, content-hash-reproducible from the matrix bytes.
- **The coverage gate is a hard guard inside `triage-judge`, not an `eval_slug`.** A
  construction-time constraint beats a grading-time check: "FILEABLE without ≥1 patent corpus"
  must be structurally un-emittable, not flagged after the fact.
- **The examine⇄amend loop is caller-driven**, with survival as a **predecessor chain**, not a
  mutable counter. Each round seals an `examine_round_record { round_n, claim_state_sha,
  rejection_state_sha, predecessor_sha, sha256 }`; `survival_count = walk(predecessor_sha)` is
  byte-identically recomputable across gigs. A **`max_examine_rounds`** cap is required;
  **K-exhausted ⇒ `INSUFFICIENT-EVIDENCE`** (an unbounded loop hides itself — each round looks
  productive while cost runs).
- **A `verdict-record` type** persists the verdict with predecessor links to
  `disclosure_input_sha` + `coverage_report_sha` + final `examine_round_record_sha`, so any
  `FILEABLE` is auditable back to the patents that grounded it. `triage-judge` cannot emit a
  verdict without populating all three.
- **The negative form of each gate is the load-bearing half.** "INSUFFICIENT *must fire* on
  zero patents," "verdict *cannot* be FILEABLE when `survival_count == 0`," "draft phase
  *cannot* run unless `recommended == FILEABLE`." The positive-form tests pass against an
  implementation that silently never gates; the must-fire tests land in
  `tests/patent_triage_v1_gates.test.ts` once the standard's I/O shape exists.
- **Charter disambiguation (single-judge invariant):** `anticipation-mapper` emits *strictly
  the matrix* — no rejection language; `patent-examiner` consumes the matrix and is the *only*
  seat that reaches a rejection-or-clear verdict.
- **`citation-verify` binds to `triage-judge` too**, not just `prior-art-scout` — the
  snippet-overstatement failure bites whichever seat writes the verdict.
- **Patent corpus: USPTO PatentsView** (free, structured, no key) for slice 1; add a keyed
  corpus (Espacenet OPS / Lens) later only if coverage proves thin.
- **OPEN is a reusable primitive**, not a v1-local thing — the third TDD state (GREEN / RED /
  OPEN) belongs to the test substrate generally.
