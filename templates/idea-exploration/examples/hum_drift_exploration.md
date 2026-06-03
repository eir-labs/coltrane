# Worked example — Hum/Drift exploration

A complete walk through the idea-exploration template using a real seed: a two-person ambient instrument that runs on the edge.

**Seed topic**: "Hum/Drift — a two-person ambient instrument over a shared edge fabric. Touch surface, low-latency ducking, gentle harmonic relationship between the two players."

This is the worked example used by `tests/e2e/idea_exploration_template.spec.ts`.

---

## DISCOVER — 10 candidate framings

| id  | framing                                       | one_liner                                                                                 | tensions                                                                          | lineage                |
| :-- | :-------------------------------------------- | :---------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------- | :--------------------- |
| c1  | listening-instrument                          | each player shapes what the OTHER plays via shared envelope follower                      | who is the "instrument", who is the "player"?                                     | base seed              |
| c2  | grief-keening duet                            | trained on cross-cultural keening; two voices follow each other into a resolution         | risk of bathos; cultural-import concern (apoha-Beirut)                            | reframe of c1          |
| c3  | non-Western tuning bath                       | gamelan / Carnatic / Persian temperament selectable per session; no Western default       | tuning-system audience is small; pedagogy required                                | opposite-pole of c1    |
| c4  | infant co-regulation                          | parent + baby; instrument modulates to keep baby's autonomic state inside soothe-band     | medical-device shape; FDA-class risk                                              | audience-pivot of c1   |
| c5  | dyad-therapy adjunct                          | couples / sibling pairs; instrument's "drift" surfaces who's leading vs following         | privacy + clinical-deployment concerns                                            | audience-pivot of c1   |
| c6  | distributed-system pedagogy toy               | the two ends are literally two machines; the audible drift teaches Lamport-clock vibes    | niche audience (CS educators); aesthetic risk (toy-feel)                          | lineage-shift of c1    |
| c7  | one-player solo + ghost                       | only one human; the second voice is a recorded loop of the player's own prior session     | violates "two-person" premise; might be the better idea anyway                    | apoha of "two-person"  |
| c8  | aphasia bridge                                | post-stroke patient + caregiver; instrument relays affect when words have gone            | medical-class again; deeply intimate                                              | combination c4 + c5    |
| c9  | site-specific landscape duet                  | each instance tied to a physical landmark; players co-located OR remote, but ANCHORED     | logistics of hardware-at-site                                                     | constraint-twist on c1 |
| c10 | conference-protocol sonification              | inputs are real BGP/NTP/gossip-protocol events; two listeners interpret + reduce together | replaces "play" with "listen-together"; closest to honest substrate-coupling      | substrate-shift of c1  |

**Diversity score: 78/100** — receivers span instrument-makers, clinicians, parents, CS educators, site-specific artists, and protocol-sonification listeners.

Gate: 10 candidates ≥ 7 AND diversity 78 ≥ 60 → DISCOVER closes.

---

## DEFINE_AUDIENCE — archetype check per candidate

(condensed — full assessments live in `audience-assessment` artifacts)

| id  | archetype-shape 1                                                                  | archetype-shape 2                                       | archetype-shape 3                                  | kill_recommended |
| :-- | :--------------------------------------------------------------------------------- | :------------------------------------------------------ | :------------------------------------------------- | :--------------- |
| c1  | duo-improvising musicians who want a "third member"                                | dancers wanting a sound-substrate for partner work      | ambient-listener couples for evening practice      | no               |
| c2  | bereavement-circle facilitators wanting non-verbal grief container                 | hospice music therapists                                | (struggling — only 2 sharp shapes)                 | **yes** (audience too narrow + cultural-import risk; apoha-Beirut applies) |
| c3  | gamelan ensembles wanting digital companion                                        | Persian-music students                                  | (cultural sensitivity required; pedagogy heavy)    | partial — develop only with collaborator from each tradition |
| c4  | postpartum-period parents in autonomic-distress windows                            | neonatal-unit clinicians                                | infant-development researchers                     | no (but medical-class gate at DEVELOP) |
| c5  | dyad-therapists wanting affect-surface                                             | couples doing structured weekly check-ins               | sibling-conflict-resolution practitioners          | no               |
| c6  | distributed-systems instructors                                                    | educational-game designers                              | (only 2 sharp shapes; toy-feel risk)               | partial          |
| c7  | solo-practice musicians revisiting prior takes                                     | meditators using "earlier-self" as duet partner         | grief-work (your-voice-from-before)                | no               |
| c8  | post-stroke patient + their primary caregiver                                      | aphasia-specialist SLPs                                 | (medical class; clinical deployment)               | no (but high medical risk) |
| c9  | site-specific sound artists                                                        | parks-department curators                               | place-based ritual practitioners                   | no               |
| c10 | network engineers as listeners-not-players                                         | protocol-design educators                               | substrate-coupling researchers (Eugene's lane)     | no               |

**Survivors going to seal**: c1, c4, c5, c7, c9, c10 (six). Killed-at-audience: c2. Partial (develop only with collaborator): c3, c6, c8.

For the worked example, we'll seal 6 (c1, c4, c5, c7, c9, c10) and treat the 3 partials as KILLED-AT-AUDIENCE for simplicity.

---

## DEFINE_SEAL — sealed pre-regs for the 6 survivors

(canonical sha256 over `{candidate_id, predict, kill_condition, apoha}` — example shown with placeholders; real hashes computed in the e2e test)

### c1 — listening-instrument
- **predict**: "WITHIN 8 weeks of release to 12 musician-duos, ≥ 6 duos report (in structured interview) that the instrument changed how they listen to their partner during play."
- **kill_condition**: "IF < 4 of 12 duos report a listening-shift BY week 8, the listening-instrument hypothesis is FALSIFIED."
- **apoha**: ["NOT a one-player solo with FX", "NOT a turn-taking duet (the listening must be CONCURRENT)", "NOT a generic 'jam together' tool"]
- **sha256_pre_verdict**: `<computed at seal>`

### c4 — infant co-regulation
- **predict**: "WITHIN a 12-dyad pilot, infant HRV variance during instrument-use is statistically lower (p<0.05) vs matched-time without instrument."
- **kill_condition**: "IF HRV variance unchanged or higher with instrument, OR if any safety-event occurs, this candidate is FALSIFIED."
- **apoha**: ["NOT a sleep-training device", "NOT a music-therapy claim", "NOT medical advice", "NOT a baby-monitor"]
- **sha256_pre_verdict**: `<computed at seal>`

### c5 — dyad-therapy adjunct
- **predict**: "WITHIN a 6-couple structured 4-week trial, ≥ 4 couples and ≥ 2 therapists report the instrument surfaced lead/follow dynamics they hadn't previously articulated."
- **kill_condition**: "IF < 3 couples OR < 2 therapists report this surfacing, the dyad-therapy hypothesis is FALSIFIED."
- **apoha**: ["NOT couples therapy itself", "NOT a diagnostic tool", "NOT a replacement for verbal work"]
- **sha256_pre_verdict**: `<computed at seal>`

### c7 — solo + ghost
- **predict**: "WITHIN 4 weeks of release to 20 solo practitioners, ≥ 12 report that the ghost-of-self made a session feel like duet rather than overdub."
- **kill_condition**: "IF < 8 of 20 report duet-feel, the ghost-duet hypothesis is FALSIFIED."
- **apoha**: ["NOT a looper", "NOT a layering tool", "NOT an overdub workflow"]
- **sha256_pre_verdict**: `<computed at seal>`

### c9 — site-specific
- **predict**: "WITHIN 3 deployed sites over 6 months, each site accrues ≥ 20 distinct visitor-sessions AND ≥ 6 visitors return for a second session."
- **kill_condition**: "IF any site averages < 15 sessions or zero returns by month 6, the site-specific hypothesis is FALSIFIED."
- **apoha**: ["NOT a sound installation (interaction required)", "NOT location-aware app (the hardware IS the anchor)", "NOT one-off art piece"]
- **sha256_pre_verdict**: `<computed at seal>`

### c10 — protocol sonification (listen-together)
- **predict**: "WITHIN 4 sessions with paired network-engineers listening to live BGP feeds, ≥ 3 pairs identify a routing-anomaly before their dashboard alerts fire."
- **kill_condition**: "IF zero pairs catch an anomaly pre-alert across 4 sessions, the protocol-substrate-coupling hypothesis is FALSIFIED."
- **apoha**: ["NOT a dashboard replacement", "NOT background music", "NOT alerting (the LISTENING is the work)", "NOT one-listener (the dyad IS the perceptual instrument)"]
- **sha256_pre_verdict**: `<computed at seal>`

**SEAL FIRES**. All 6 triples sha256'd, frozen, persisted.

---

## DEVELOP — pick 1, archive 5

User picks **c10 — protocol sonification** to develop now (it lands closest to Eugene's substrate-coupling research thesis; the c1 listening-instrument is what Hum/Drift already IS).

The other 5 (c1, c4, c5, c7, c9) become `unsown-seed` artifacts in `archived_seeds/`:

```
archived_seeds/
  c1__listening_instrument.json     (sha256: <hash>)
  c4__infant_co_regulation.json     (sha256: <hash>)
  c5__dyad_therapy_adjunct.json     (sha256: <hash>)
  c7__solo_plus_ghost.json          (sha256: <hash>)
  c9__site_specific.json            (sha256: <hash>)
```

Each `reason_not_developed` documents the temporal pickup ("not c1 because Hum/Drift is already this; pick again when v2 design begins"). Each is restartable — pull, DEVELOP, ripen against the sealed seal.

c10 moves to active build under its frozen seal.

---

## DELIVER — verdict

c10 is built. 4 sessions run with paired network engineers.

**Observed**: 2 of 4 pairs caught a routing anomaly before dashboard alert (one BGP withdrawal-storm, one slow-leak). Kill_condition was "zero pairs across 4 sessions" — kill did NOT fire. Predict was "≥ 3 pairs" — predict was NOT met.

**Verdict**: `PARTLY-RIPENED` (specific sub-criterion — proof-of-concept pre-alert detection — confirmed; predict's threshold not met).

For the 5 archived unsown-seeds: each sha256_pre_verdict re-hashes to match its stored value. Restartability **confirmed**.

**Verdict bundle**:
- c10: PARTLY-RIPENED
- c1, c4, c5, c7, c9: ARCHIVED, restartable, seal integrity intact
- c2, c3, c6, c8: KILLED-AT-AUDIENCE (not sealed)

The exploration cycle closes. 6 seeds sealed. 1 developed → partly-ripened (lesson: dyad-listening-as-anomaly-detector is real but needs longer sessions OR better-trained listeners; informs the c10 re-DEVELOP). 5 preserved as restartable seeds. This IS what "seed that plants seeds" looks like in the idea-exploration lane.
