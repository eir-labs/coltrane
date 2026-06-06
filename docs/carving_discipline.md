# The carving discipline

> *"A patent claim is a vehicle. What you actually own is the carved space —
> the territory excluded from public practice by the claim's language. The
> language is one representation of that carving; many other representations
> would suffice if they bounded the same shape with sufficient fidelity."*

This is the practical principle behind Coltrane's `patent_triage_v0` standard.
It generalizes beyond patents — to chains, to standards, to APIs, to brands —
but the patent case is where the discipline pays off in dollars saved on
filings that wouldn't have held up.

## The recognition

Every engineered artifact has two parts:

- **What is empty** — the representation. The bytes, words, code, current
  vocabulary, file format, programming language. These change without the
  artifact changing what it *is*.
- **What is invariant** — the carved space. The territory excluded from
  public practice. Any re-representation must preserve this or the artifact
  is no longer what it was.

Most engineering practice confuses these:

- *Confusing the empty for the invariant* produces brittle artifacts that
  age out as their representations become obsolete. A patent whose claim
  language depends on SHA-1 ages out when SHA-1 is broken. The carving
  (tamper-evident lineage) didn't change; the claim that bound it did.
- *Confusing the invariant for the empty* produces drifted artifacts. The
  form survives, but the cut no longer bounds anything meaningful. The
  claim drifts to cover too much or too little.

The discipline is to know, at every step, which is which.

## What this means for patents specifically

A competent reader of a patent does not read the words; they *feel for the
shape* that is excluded from public practice. The claim is the surveyor's
stake. The carving is the territory. What gets enforced in court is the
territory.

When you ask "is this patentable?" the right question to ask first is
**"what space am I carving?"** — *not* "what words bound it?". The words
come second. If you can't name the space in one sentence stripped of
representation-specific vocabulary, you don't have a patent — you have a
description of an implementation, which is a different thing.

When you ask "is this novel?" the right question is **"is the space I'm
carving genuinely empty of prior art?"** — *not* "have these exact words
been used before?". Words can change; the space stays put.

When you ask "is this defensible?" the right question is **"do I know the
boundary of the space — the failure modes that mark where the carving
ends?"** — *not* "will I win every case?". A defensible carving is one
where the inventor can articulate where it stops.

These three questions are the substrate of the `patent_triage_v0` standard.

## How the discipline generalizes

The carving / representation distinction shows up everywhere in Coltrane:

- **The chain is empty.** Whatever the underlying integrity mechanism is at
  any given time is one representation; the chain is the forward-link
  integrity invariant. The mechanism can be swapped without the chain
  becoming a different chain.
- **The standards are empty.** Each standard's file is a representation of
  a verified phase-composition. If we re-encode in another format, the
  carving (which inputs flow to which agents under which composition)
  stays put.
- **Coltrane itself is empty.** `CLAUDE.md`, `seeds/`, the MCP surface are
  current representations of the carved space between users and frontier
  models. The product is not the files. The product is the steering layer
  the carving names.

This pattern is why Coltrane's design is open-form: anyone can re-implement
any single piece, and as long as the carving is preserved, the system stays
what it was.

## The discipline as a workflow

When you bring an idea — for a patent filing, for a standard, for a new
substrate — walk through these in order before writing words:

1. **Name the carving in one sentence**, in plain language, stripped of any
   specific format / programming language / vendor / library.
2. **Name 3-5 things this is *not*** (the apoha set). Each one is a piece
   of prior art that comes close but bounds a different space. Each is a
   sharper boundary marker than the carving description alone.
3. **Name 3 ways the carving could fail.** Where does the territory
   actually end? These are the boundaries of the invariant.
4. **Re-state the carving in different representations.** Could you
   describe it in math? In a sketch? In another programming language? In a
   verbal pitch to a non-engineer? If a representation breaks it, that
   representation was *more than empty* — it was part of the invariant.
   Refine accordingly.

Only after all four steps do you write the claim language. The words are
the surveyor's stake. The carving is what gets enforced.

## See also

- `docs/standards/patent-triage.md` — the user-facing pipeline that runs
  this discipline against an invention description and returns a triage
  verdict + provisional draft.
- `standards/patent_triage_v0.json` — the standard composition.

— compiled by the Coltrane band
