# patent_triage_v0 — patentability triage and provisional drafting

> Are the ideas you're working on patentable, and if so, what does a 1-page
> provisional patent for them look like?

`patent_triage_v0` is a Coltrane standard that takes an invention description
and runs it through four phases: **carving**, **novelty**, **smallest-spring
shape**, and **provisional draft**. Each phase emits typed outputs that flow
into the next; the final verdict (FILEABLE / REFINE-FIRST / NOT-FILEABLE) is
sealed onto the chain so the reasoning is auditable later.

This is open form. The pipeline is OSS. You bring the model, the corpus, and
the invention. Nothing about the substance leaves your machine unless you
choose to export it.

## Who this is for

Solo founders, engineers, and small-team leads with working artifacts who
need to decide whether to spend $5K–$50K on a real provisional filing.
You have the substance; the pipeline is the carving-discipline assist that
sharpens it before you commit money.

It does not replace a patent attorney. It replaces the *first $5,000 of
conversation* with the attorney — the part that ends with the attorney
saying "this isn't novel" or "this claim is too broad." Bring the pipeline's
verdict to the attorney and the next conversation is the one worth paying for.

## The pipeline

```
your invention description (markdown, text, or natural-language)
       │
       ▼
┌────────────────┐
│ 1. CARVING     │  → carving statement (1 sentence) + apoha set (3-5
│                │     distinctions: what this is NOT, vs prior art)
└────────────────┘
       │
       ▼
┌────────────────┐
│ 2. NOVELTY     │  → prior-art hits + nearest-neighbor distance + verdict
│                │     (NOVEL / OVERLAPS / DERIVATIVE)
└────────────────┘
       │
       ▼
┌────────────────┐
│ 3. SMALLEST    │  → claim-shape grade (TIGHT / LOOSE / UNBOUNDED) +
│    SPRING      │     named failure modes (3 ways the carving could fail)
└────────────────┘
       │
       ▼
┌────────────────┐
│ 4. PROVISIONAL │  → 1-page draft, only if upstream verdicts pass:
│    DRAFT       │     Field / Background / Summary / Claim / Embodiment
│                │     / Failure modes
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
  --standard_slug patent_triage_v0 \
  --input '{"invention_md": "my_invention.md"}'

# 3. Read the outputs.
# Every phase wrote a typed output. The final verdict is the triage_verdict.
# If FILEABLE, the provisional draft is in the gig's output set.
# The chain receipt is sealed under your steve_<uuid>/audit/.
```

If you don't have the MCP server running, you can use the standalone CLI:

```bash
coltrane run patent_triage_v0 my_invention.md
```

## What each phase asks

### Phase 1 — Carving

The phase asks: **what space does this artifact bound?** Strip the bytes,
words, current vocabulary. Name the invariant territory in one sentence.

It then asks: **what 3-5 things is this not?** Each is a piece of prior art
that comes close but bounds a different space. These are the *apoha* — the
sharper boundary markers.

The output is a `carving` (the statement) + an `apoha_set` (the distinctions).
Together they're the territory that would be enforced if a patent issued.

### Phase 2 — Novelty

The phase takes the carving + apoha set and searches prior art (USPTO,
Google Patents, Semantic Scholar by default; configurable). For each hit, it
computes a similarity score against the carving and the apoha distinctions.

Output: a list of `prior_art_hit` entries, a nearest-neighbor distance, and a
`novelty_verdict` (NOVEL / OVERLAPS / DERIVATIVE).

If the verdict is OVERLAPS or DERIVATIVE the pipeline returns early — there's
no point drafting a provisional for a carving that's already in the public
practice it claims to exclude.

### Phase 3 — Smallest-spring shape

The phase asks: **can the carving be stated as a smallest spring with known
failure modes?**

A smallest spring is one independent claim, stated in one sentence, with
*one* independent variable. If the claim requires three coordinated
mechanisms to operate, it's not a spring — it's an assembly, and the
substrate behind it is what should be patented (or open-sourced; same
question).

Known failure modes are 3 named ways the carving could fail — concrete
boundary conditions where the invariant stops holding.

Output: a `smallest_spring_grade` (TIGHT / LOOSE / UNBOUNDED) +
`failure_modes` (the named boundaries). LOOSE or UNBOUNDED triggers a
REFINE-FIRST verdict; the pipeline tells the inventor what tightening would
look like.

### Phase 4 — Provisional draft

Only runs if Phase 2 returned NOVEL *and* Phase 3 returned TIGHT.

The phase produces a `provisional_draft` with sections:

- **Field** — the technology area
- **Background** — the gap the carving fills
- **Summary** — the carving statement in patent-claim register
- **Claim** — the smallest spring as an independent claim
- **Embodiment** — one specific implementation that meets the claim
- **Failure modes** — the named boundaries (these protect the inventor in
  later examination by showing the bounded substrate)

The draft is scaffolded for human-and-attorney review. It's not ready to
file as-is; it's ready to bring to an attorney for a one-hour conversation
(~$500) before filing.

## Verdict semantics

The pipeline returns exactly one of:

- **FILEABLE** — all phases passed. Provisional draft is in the gig's
  output set. Recommended: 1-hour attorney review before filing.
- **REFINE-FIRST** — one or more phases returned a marginal verdict. The
  pipeline returns a specific refinement direction (tighten the claim,
  bound the failure modes, narrow the carving).
- **NOT-FILEABLE** — prior art overlap is too strong OR no novel carving
  is identifiable. The pipeline returns the citations and a plain-English
  explanation. The inventor decides whether to abandon, pivot, or
  publish-defensively (post the carving as public prior-art to prevent
  someone else from filing it).

## Why "open form"

Open form means:

- The **pipeline shape** is fixed: the four phases, the discipline rules,
  the verdict vocabulary. That's the carving.
- The **substrate** is bring-your-own: which model runs the phases (Claude,
  Gemini, GPT, local), which prior-art corpus is searched, which
  embedding / distance function, which patent-jurisdiction the draft is
  styled for. That's the representation.

Closed-form would be: send us your invention, our cloud runs our model on
our corpus, here's a verdict and a bill. Inventors don't trust that and
shouldn't — the substance of an invention is too sensitive to send to a
third party before you know whether you have a patentable thing.

Open form is the trust shape that makes inventors actually run a triage on
their own ideas. The pipeline doesn't see anything you don't explicitly
export. The chain receipt is on your disk. The model can be local. The
corpus can be local. The substrate is fully under your control.

## What this is NOT

- **Not legal advice.** The verdict is not a representation that the
  invention will hold up in examination or litigation. It's a pre-filing
  rigor filter. Get an attorney before you file.
- **Not a search-engine replacement.** Phase 2's corpus is only as good as
  what it's connected to. Foreign-language patents, trade-secret
  disclosures, recent unindexed publications can still anticipate a
  carving the pipeline calls NOVEL.
- **Not infallible on smallest-spring.** Phase 3's "is this a smallest
  spring?" check uses heuristics on the claim shape. An expert patent
  attorney will catch shape issues the pipeline misses.
- **Not a substitute for the carving discipline.** The pipeline scaffolds
  the discipline; it doesn't perform it for you. The recognition of
  *what is empty* vs *what is invariant* is still a skill the inventor
  brings. See `docs/carving_discipline.md`.

## See also

- `docs/carving_discipline.md` — the principle behind the pipeline.
- `standards/patent_triage_v0.json` — the standard composition.
- `agents/{carver,novelty_searcher,claim_rewriter,verdict_judger}.json` —
  per-phase agents.
- `domain_types/{invention-spec,prior-art-hit,novelty-verdict,claim-draft,failure-modes,triage-verdict,provisional-draft}.json` —
  typed event shapes.

— compiled by the Coltrane band
