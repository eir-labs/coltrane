# templates/idea-exploration — the diverge-discipline flavor

The idea-exploration flavor of the seed-that-plants-seeds scaffold. Walks the formal double-diamond × safe-prereg discipline on ideas — not code, not research briefs, not ops.

**5-minute walkthrough**:

## 1. What this template is for

You have a topic. You want to explore it WITHOUT prematurely collapsing on the first plausible answer. You want the discipline that:

1. **DIVERGES widely** (≥7 alternatives before converging)
2. **NAMES the receivers** for each alternative (audience-modeler)
3. **SEALS the falsifiable** for each survivor (predict + kill + apoha + sha256)
4. **PICKS 1-3 to DEVELOP**, archives the rest as restartable seeds (NOT losses)
5. **RIPENS against the frozen seal** — no post-hoc reframing

That's this template.

## 2. What this template is NOT

- NOT a generic creative-brainstorm — framings must carry tensions, not vibes
- NOT design-thinking with safe-prereg sprinkled on — the seal is the discipline's spine
- NOT auto-converging — the explicit move is to REFUSE premature convergence
- NOT a "pick the winner" tool — it's a "preserve the seeds, develop the timely-picked" tool

## 3. Files

```
templates/idea-exploration/
├── README.md                                       ← you are here
├── CLAUDE.md                                       ← orientation for Claude when running this template
├── agents/
│   ├── idea_explorer.json                          ← DISCOVER: ≥7 alternatives, refuses convergence
│   ├── audience_modeler.json                       ← DEFINE_AUDIENCE: 3 archetypes/candidate, kills no-receiver
│   ├── kill_condition_keeper.json                  ← DEFINE_SEAL: predict + kill + apoha + sha256 (SEAL FIRES)
│   ├── seed_sower.json                             ← DEVELOP: pick 1-3, archive rest as unsown-seeds
│   └── ripener.json                                ← DELIVER: verdict against frozen seal
├── standards/
│   └── idea_exploration_protocol.json              ← the 5-phase standard
├── skills/
│   └── explore-idea.json                           ← skill metadata for /coltrane-explore-idea
├── .claude/commands/
│   └── coltrane-explore-idea.md                    ← slash command body
├── domain_types/
│   ├── seed-topic.json                             ← Signal
│   ├── idea-candidate.json                         ← Interpretation
│   ├── audience-assessment.json                    ← Judgment
│   ├── sealed-prereg.json                          ← Plan (the SEAL artifact)
│   ├── unsown-seed.json                            ← Artifact (archived restartable seed)
│   └── idea-verdict.json                           ← Verdict
├── core_types/                                     ← stock 6 (copied for self-contained loading)
├── archived_seeds/                                 ← unsown seeds land here
├── examples/
│   └── hum_drift_exploration.md                    ← worked example: full 5-phase walk on a real topic
└── tests/e2e/
    └── idea_exploration_template.spec.ts           ← e2e walking the Hum/Drift example
```

## 4. How to use

### Option A — via cajal's `project-bootstrap-v0` (when it lands on origin/main)

```bash
gh repo create my-explore --template <coltrane-oss-repo> --private
cd my-explore
coltrane dispatch project-bootstrap-v0 --use-case idea-exploration
```

The bootstrap standard's DEVELOP phase unrolls this template into the fresh repo.

### Option B — direct copy (today, while cajal's standard is in-flight)

```bash
git clone <coltrane-oss-repo> my-explore
cd my-explore
cp -r templates/idea-exploration/* .
# now my-explore IS an idea-exploration project; agents/, standards/, etc. are loaded
```

### Option C — invoke the standard inline

If you already have a coltrane-flavored project and want to drop in the idea-exploration discipline as one capability among others:

```bash
cp -r templates/idea-exploration/agents/* agents/
cp templates/idea-exploration/standards/idea_exploration_protocol.json standards/
cp -r templates/idea-exploration/domain_types/* domain_types/
cp templates/idea-exploration/skills/explore-idea.json skills/
cp templates/idea-exploration/.claude/commands/coltrane-explore-idea.md .claude/commands/
```

## 5. The 5-minute walkthrough — Hum/Drift worked example

See `examples/hum_drift_exploration.md` for a complete walk. Summary:

- **Seed**: "Hum/Drift — a two-person ambient instrument over a shared edge fabric."
- **DISCOVER**: surfaces 10 framings (listening-instrument, grief-keening duet, gamelan-bath, infant co-regulation, dyad-therapy adjunct, distributed-system pedagogy toy, solo + ghost, aphasia bridge, site-specific, protocol sonification)
- **DEFINE_AUDIENCE**: kills 1 (grief-keening — too narrow + apoha-Beirut), flags 3 as needing collaborator (3 partial), 6 advance to seal
- **DEFINE_SEAL**: 6 sealed-pre-regs emit; each carries predict + kill + apoha + sha256
- **DEVELOP**: user picks c10 (protocol sonification — closest to substrate-coupling thesis); 5 others archive as unsown-seeds with seal-hashes intact
- **DELIVER**: c10 ripens as PARTLY-RIPENED (2/4 pairs caught anomalies pre-alert; predict said ≥3); 5 archived seeds verified restartable

That's one full cycle. 6 sealed seeds. 1 developed → partly-ripened. 5 preserved as restartable.

## 6. Integration status

- **miles's 4 universal phase-agents** (`domain-explorer`, `problem-definer`, `solution-developer`, `delivery-finalizer`): NOT yet on origin/main as of 2026-06-02. This template ships with 5 lane-flavored agents whose `_note` fields call out the integration slot. When miles lands the universals, the lane charters can collapse into universal-phase-agent tilts.
- **cajal's `project-bootstrap-v0` standard**: lives on `origin/tonight/cajal/project-bootstrap-v0-standard`. References this template directory by name (`templates/idea-exploration/`). Once cajal merges to main, this template becomes the payload DEVELOP unrolls.
- **groove (this template)**: ships now under `templates/idea-exploration/`. Self-contained (own core_types/ + domain_types/) so it loads as a complete coltrane genome without depending on the parent repo's root. E2e test verifies a full 5-phase walk end-to-end.

## 7. The apoha — what this template is NOT

- NOT a pop-design-thinking sticker — the seal is the discipline's spine, not optional garnish
- NOT a creative-brainstorm in coltrane clothing — the 7-alternative gate and the sha256-seal are structural, not decorative
- NOT auto-converging — DISCOVER's job IS to refuse to converge
- NOT silent-loss-of-non-developed-ideas — every archived seed carries its seal-hash and is restartable
- NOT post-hoc-reframing-of-the-predict at ripening — the seal is FROZEN; ripen against THAT
