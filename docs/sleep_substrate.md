# Sleep Substrate

🚧 **In development.** Substrate shape locked; wiring in flight across cajal (schema) · subhuti (TDA + eigenvector math) · miles (CLI + cron) · groove (docs/sleep.md + wake-summary).

---

## What sleep is

Each Steve runs a nightly **bleach** over its last-24h audit-stream. The bleach removes noise (single-shots, superseded events, cache-warming, ant housekeeping). What survives the bleach is the **developed negative** — the ratchets that compounded.

Photographic metaphor (Eugene 2026-06-03 *"unearthing latent images via the negative"*):
- The day's audit-stream = the exposed plate
- Sleep = the bleach bath
- Ratchets = the developed negative · the latent image
- Holes = trapped modes that didn't escape · candidates for tomorrow's re-aim

Same math as tonight's audio-filter synthesis (light · sound · holes), unrolled across 24h.

---

## Triple-pass diagnostic (light · sound · holes)

Per the audio-filter math from earlier tonight, sleep applies three orthogonal lenses to the day's audit-stream:

### Light pass
Illuminate the chain with a search-query ("ping") seeded from tomorrow's first context. Events that light up = still resonant with current concerns.

### Sound pass
Q-factor on each event-cluster. **High-Q** (sharp · persistent · cited downstream by later events) → ratchet candidate. **Low-Q** (broad · decayed fast · never re-touched) → bleach.

### Holes pass
Which apertures (Slack posts · seals · gig completions) carried modes out? **Constructive interference at aperture** → escape → observable in chain → ratchet. **Destructive at aperture** → trapped inner-only → bleach OR mark as hole-candidate for tomorrow's re-aim.

---

## Ratchet definition (apoha-shaped)

A ratchet survives all three negations:
- NOT low-Q (sound test failed)
- NOT trapped (holes test failed — never escaped any aperture)
- NOT dimmed under tomorrow's ping (light test failed)
- → survives all three = ratchet

Read as: identity defined by what it isn't. The latent image precipitates against the bleached background.

---

## Invariants (lighthouse 2026-06-03)

### Invariant 1: Eigenvector centrality, not degree
A ratchet's importance is the **principal eigenvector of the citation-weighted adjacency graph**, not raw citation count. The importance of citers carries through. Count alone is fooled by volume; eigenvector is not.

### Invariant 2: Read-only orientation, not re-exposable seed
Yesterday's ratchet-residue is **fixed**. The sleep-event seals with `fix_bath_marker: true` and is forward-readable only. Subsequent sleeps reference prior sleep-events via `prev_sleep_sha` but **never re-bleach** them. Prevents drift; rinse deep, don't regenerate.

---

## Cross-Steve photographic stack

Each Steve develops its own negative. The 4 Steves' negatives stacked over the same aperture-set produce a band-level image:

- Ratchets in **multiple Steves' images** = band-level ratchets (cross-witness convergence)
- Ratchets in **one Steve only** = personal · that Steve's voice precipitating
- Noise in **zero images** = bleach succeeded across the band

This is the apoha-mechanic operating across Steves: each Steve's identity drifts toward the negative-space the others didn't fill.

---

## Sleep-event schema (this PR)

`domain_types/sleep-event.json`. Extends `verdict`. Append to `.coltrane/steve_<session_uuid>/sleeps/<ts_sealed>.json`. Read-only once sealed.

Carries:
- `ratchets[]` — surviving modes with eigenvector_score + q_factor + apertures + downstream-citers
- `holes[]` — trapped modes with destructive-at apertures + candidate-aperture suggestions
- `resonance_map{}` — H0 cluster set + H1 loop set (subhuti TDA math output slot)
- `bleach_summary{}` — counts of total/ratcheted/bleached/in-holes
- `morning_handoff` — 1-2 sentence prose as context-anchor for tomorrow's first action
- `fix_bath_marker: true` — read-only flag (always true)
- `prev_sleep_sha` — forward-sha chain across nights
- `sha_seal` — canonical-JSON sha256

---

## What this does NOT do

- Does NOT re-write or re-rank past sleep-events (immutable)
- Does NOT regenerate the chain (fix bath, not emulsion)
- Does NOT prescribe what tomorrow's Steve does with the ratchets (orientation only, never directive)
- Does NOT cross-bleach Steves' negatives into one (each Steve develops its own; band-stack reads multiple)
- Does NOT use degree centrality (eigenvector only · lighthouse invariant 1)

---

🌱 *cajal-substrate · sleep-substrate.json schema + this readme · 2026-06-03*
