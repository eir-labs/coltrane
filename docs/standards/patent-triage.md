# patent-triage-v0 — patentability triage and provisional drafting

> Are the ideas you're working on patentable, and if so, what does a
> 1-page provisional patent for them look like?

`patent-triage-v0` is a Coltrane standard that takes an invention
description and runs it through four phases: **cleave**, **novelty**,
**refine-claim**, and **judge**. Each phase emits typed outputs that flow
into the next; the final verdict (FILEABLE / REFINE-FIRST /
NOT-FILEABLE) is sealed onto the chain so the reasoning is auditable
later.

This is open form. The pipeline is open source. You bring the model, the
corpus, and the invention. Nothing about the substance leaves your
machine unless you choose to export it.

## Who this is for

Solo founders, engineers, and small-team leads with working artifacts
who need to decide whether to spend $5K–$50K on a real provisional
filing. You have the substance; the pipeline is the assist that sharpens
it before you commit money.

It does not replace a patent attorney. It replaces the *first $5,000 of
conversation* with the attorney — the part that ends with the attorney
saying "this isn't novel" or "this claim is too broad." Bring the
pipeline's verdict to the attorney and the next conversation is the one
worth paying for.

## The pipeline

```
your invention description (markdown, text, or natural-language)
       │
       ▼
┌────────────────┐
│ 1. CLEAVE      │  → one-sentence claim + what-this-is-NOT list
│                │     (3-5 distinctions vs prior art) + named
│                │     failure modes
└────────────────┘
       │
       ▼
┌────────────────┐
│ 2. NOVELTY     │  → prior-art hits + nearest-neighbor distance +
│                │     verdict (PASS / TOO-CLOSE-TO-CALL / FAIL)
└────────────────┘
       │
       ▼
┌────────────────┐
│ 3. REFINE      │  → refined one-sentence claim with explicit
│                │     distancing-limitation; cleave-grade
│                │     (TIGHT / LOOSE / UNBOUNDED)
└────────────────┘
       │
       ▼
┌────────────────┐
│ 4. JUDGE       │  → FILEABLE / REFINE-FIRST / NOT-FILEABLE +
│                │     (only if FILEABLE) a 6-section provisional
│                │     draft skeleton
└────────────────┘
       │
       ▼
   triage verdict + sealed chain receipt
```

## Quickstart

```bash
# 1. Describe your invention in a markdown file.
$EDITOR my_invention.md

# 2. Dispatch the standard via MCP.
coltrane gig_dispatch \
  --standard_slug patent-triage-v0 \
  --input '{"invention_md": "my_invention.md"}'

# 3. Read the outputs.
# Every phase wrote a typed output. The final verdict is the triage_verdict.
# If FILEABLE, the provisional draft is in the gig's output set.
```

## What each phase asks

### Phase 1 — Cleave

The phase asks: **is there one clean cleave plane in this invention —
one sentence that names what it is, stripped of representation?**

It then pressure-tests: **what 3-5 things is this not?** Each is a piece
of prior art that comes close but bounds a different space. These are
the sharper boundary markers. And: **where would this fracture under
pressure?** — the named failure modes.

The output is a `claim-draft` (the one-sentence claim) + a
`failure-modes` document (named failure modes + the what-this-is-NOT
list). Together they're the territory that would be enforced if a
patent issued.

### Phase 2 — Novelty

The phase takes the claim and searches prior art. For each hit, it
records a similarity score and what the prior art covers vs what the
claim has that the prior art does not.

Output: a list of `prior_art_hit` entries, a nearest-neighbor distance,
and a `novelty_verdict` (PASS / TOO-CLOSE-TO-CALL / FAIL).

If the verdict is FAIL the pipeline still walks the remaining phases —
the inventor may want the refined-claim phase to surface whether a
narrower claim could survive.

### Phase 3 — Refine-claim

The phase rewrites the claim under the single-cleave discipline: one
independent claim, at most three functional elements joined by
`comprising`, every word load-bearing, an explicit distancing
limitation when the novelty-verdict named a close hit.

Output: a refined `claim-draft` with a `cleave_grade`
(TIGHT / LOOSE / UNBOUNDED). LOOSE or UNBOUNDED triggers a REFINE-FIRST
verdict at the next phase; the pipeline tells the inventor what
tightening would look like.

### Phase 4 — Judge

The phase reads all upstream outputs and issues one of three verdicts.
Only on FILEABLE does it produce a provisional-draft skeleton — a
6-section outline the inventor can take to a patent attorney or use as
the starting point of a USPTO provisional filing.

## Verdict semantics

The pipeline returns exactly one of:

- **FILEABLE** — all phases passed. Provisional draft skeleton is in
  the gig's output set. Recommended next step: 1-hour attorney review
  before filing.
- **REFINE-FIRST** — one or more phases returned a marginal verdict.
  The pipeline returns a specific refinement axis (novelty, scope,
  clarity, or enablement) and what to address.
- **NOT-FILEABLE** — prior art overlap is too strong, OR no single-
  sentence claim can be drawn from the invention. The pipeline returns
  the cited prior art and a plain-English explanation. The inventor
  decides whether to abandon, pivot, or publish defensively to prevent
  someone else from filing a similar claim.

## Why "open form"

Open form means:

- The **pipeline shape** is fixed: the four phases, the verdict
  vocabulary, the discipline rules.
- The **substrate** is bring-your-own: which model runs the phases
  (Claude, Gemini, GPT, local), which prior-art corpus is searched,
  which embedding / distance function, which patent-jurisdiction the
  draft is styled for.

Closed-form would be: send us your invention, our cloud runs our model
on our corpus, here's a verdict and a bill. Inventors don't trust that,
and shouldn't — the substance of an invention is too sensitive to send
to a third party before you know whether you have a patentable thing.

Open form is the trust shape that makes inventors actually run a triage
on their own ideas. The pipeline doesn't see anything you don't
explicitly export. The model can be local. The corpus can be local. The
substrate is fully under your control.

## What this is NOT

- **Not legal advice.** The verdict is not a representation that the
  invention will hold up in examination or litigation. It's a pre-filing
  rigor filter. Get an attorney before you file.
- **Not a search-engine replacement.** Phase 2's corpus is only as good
  as what it's connected to. Foreign-language patents, trade-secret
  disclosures, recent unindexed publications can still anticipate a
  claim the pipeline calls PASS.
- **Not infallible on claim shape.** Phase 3 uses heuristics on the
  claim shape. An expert patent attorney will catch shape issues the
  pipeline misses.
- **Not a substitute for the inventor's own judgment.** The pipeline
  scaffolds the discipline; it doesn't perform it. The recognition of
  *what is empty* vs *what is invariant* is still a skill the inventor
  brings. See `docs/diamond_cutting_discipline.md`.

## See also

- `docs/diamond_cutting_discipline.md` — the principle behind the
  pipeline.
- `standards/patent-triage-v0.json` — the standard composition.

— compiled by the Coltrane band
