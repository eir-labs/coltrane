# Coltrane v2 — Test Suite Prereg

**Source of truth:** `Coltrane Spec.docx.md` §14 (Testing Strategy)
**Discipline:** every test pairs a karma claim (must pass) with an apoha (must fail). registered before impl.
**Updated:** 2026-05-25T18:25:00Z

## Layer 1 — Type System (8)

| # | Karma (must pass) | Apoha (must fail) | File |
|---|---|---|---|
| T1 | Output validates against core type schema | Output missing a required core-type field is rejected | tests/core_types.test.ts + tests/artifact_validation_criteria.test.ts |
| T2 | Output validates against domain type schema | Output missing a required domain-extension field is rejected | tests/domain_type_validation.test.ts |
| T3 | Bad-schema output is rejected at write | Bad-schema output silently written through | tests/domain_type_validation.test.ts |
| T4 | type_resolve returns correct scores for known types | Scoring weights drift from §5 (0.4/0.15/0.2/0.15/0.1) | tests/type_resolution.test.ts |
| T5 | type_register fails if resolver scored ≥ 80 | type_register silently creates duplicate | tests/type_resolution.test.ts |
| T6 | type_extend creates new version, old survives | New version overwrites old | tests/type_versioning.test.ts |
| T7 | Breaking change without approval is rejected | Breaking change accepted without human approval | tests/type_versioning.test.ts |
| T8 | Backward-compat findings view returns correct data | View returns stale or misjoined rows | tests/findings_view.test.ts |

## Layer 2 — Pipeline Validation (6)

| # | Karma (must pass) | Apoha (must fail) | File |
|---|---|---|---|
| P1 | Agent with CREATE but no upstream INTERPRET rejected | Such agent accepted | tests/composition_rules.test.ts |
| P2 | Valid SENSE → INTERPRET → JUDGE pipeline passes | Valid pipeline rejected (false positive) | tests/composition_rules.test.ts |
| P3 | Missing input type in pipeline flagged | Unsatisfied input slips through | tests/composition_rules.test.ts |
| P4 | Circular dependency rejected | Loop slips through | tests/composition_rules.test.ts |
| P5 | Standard composition with invalid agent mix rejected | Invalid mix slips through | tests/standard_composition_validation.test.ts |
| P6 | standard_simulate cost estimate within ±20% of actual | Estimate drifts > 20% silently | tests/standard_simulate.test.ts |

## Layer 3 — Trust & Access (6)

| # | Karma (must pass) | Apoha (must fail) | File |
|---|---|---|---|
| A1 | Agent in SENSE phase cannot access write tools | Write tool exposed in SENSE phase | tests/trust_boundaries.test.ts |
| A2 | Plan referencing files outside grant rejected | Out-of-scope plan accepted | tests/trust_boundaries.test.ts |
| A3 | Artifact without validation_criteria[] is rejected | Such artifact accepted | tests/artifact_validation_criteria.test.ts |
| A4 | Verdict without checks[] is rejected | Such verdict accepted | tests/artifact_validation_criteria.test.ts |
| A5 | Expired access grant blocks execution | Expired grant still grants access | tests/grant_ttl.test.ts |
| A6 | Files modified outside declared scope flagged by recorder | Out-of-scope write goes unflagged | tests/recorder_audit.test.ts |

## Cross-cutting | # | Karma (must pass) | Apoha (must fail) | File |
|---|---|---|---|
| X1 | OSS engine imports no fleet infra / internal endpoints | An import from @supabase, slack_ant, or eir-internal slips into src/ | tests/dependency_isolation.test.ts |
| X2 | System exposes no API claiming gig reproducibility | An assertGigReproducible / behaviorHash export appears | tests/gig_nondeterminism.test.ts |

## §5 Domain Registry — additional | # | Karma (must pass) | Apoha (must fail) | File |
|---|---|---|---|
| R1 | Domain type registered at runtime, no source file changes; instance validates against the registry alone | Registering a type writes/edits a .ts source file, or an unregistered type validates | tests/runtime_type_creation.test.ts |
| R2 | One core type extends into multiple domains, each validates; core types immutable (no add-core API), extends must be a core | A domain type extending a non-core type is accepted, or a registerCoreType API exists | tests/domain_extension.test.ts |
| R3 | loadRegistry(genome) populates the registry from genome domain types; they resolve + validate with zero registerType calls | A fresh registry validates an unregistered type, or genome types are absent after load | tests/genome_registry_bridge.test.ts |
| R4 | type_resolve / type_register / type_browse work through the MCP router (dispatchTool), not just the registry in isolation | A type tool returns not_implemented, or a duplicate register is accepted via the router | tests/mcp_type_tools.test.ts |

## Layer 4 — End-to-End (6)

| # | Karma (must pass) | Apoha (must fail) | File |
|---|---|---|---|
| E1 | NL goal → designed standard → executed → outputs in DB | Loop breaks somewhere; outputs missing | tests/e2e_full_loop.test.ts |
| E2 | 100 readiness scans pass through new system; findings view works | Findings view returns wrong rows after migration | tests/e2e_backward_compat.test.ts |
| E3 | Bug fix standard: finding → triage → fix → review → PR | Phase skipped or order broken | tests/e2e_bug_fix_standard.test.ts |
| E4 | Type created during exec, consumed by downstream agent | Dynamic type not visible to downstream | tests/e2e_dynamic_type.test.ts |
| E5 | Learner observes 50+ gigs, proposes downgrade with evidence | Proposes downgrade without 50+ data points (§8 constraint) | tests/learner_threshold.test.ts |
| E6 | Full provenance trace from final artifact to original signal | Trace breaks or missing edges | tests/e2e_provenance_trace.test.ts |

## Orthogonal — §-specific lane tests (registered after audit drift)

| # | Karma (must pass) | Apoha (must fail) | File |
|---|---|---|---|
| O1 | §2.5 canonical_form: 3 published reference hex vectors reproduce; CRLF→LF; excluded fields stripped; effective_hash = sha256("1.1\|ch\|dh") | Hex drifts on shape change; canonText leaves trailing newlines; effective_hash misses content vs deps | tests/canonical_form.test.ts |
| O2 | §7 MCP surface: 32 tools enumerated with input+output schemas; approval-required tools gated correctly | Tool added without schema; always-approval tool slips through gating | tests/mcp_surface.test.ts |
| O3 | §4 agent profile three spaces: Creative/Harmonic/Permissions correctly classify changes; Permissions requires approval | Permission change accepted without approval; harmonic change miscategorized | tests/agent_profile_spaces.test.ts |
| O4 | §12 pricing: credit formula matches spec depth/model multipliers; weights sum correctly | Multiplier drift between code and spec | tests/pricing_architecture.test.ts |
| O5 | §6 outputs store: append + query work; provenance graph walks correctly; backward-compat findings view | Output written without core_type validation; trace breaks on cycle | tests/outputs.test.ts |
| O6 | §6 ledger: append-only — no update/delete API exists; FileLedger persists across instances (litmus) | Ledger exposes update or delete; entries lost across instance boundary | tests/ledger.test.ts |
| O7 | §2 core types loaded from disk: exactly 6 spec-mandated slugs; primitive + schema present; loader rejects extras | core_types/ has 5 or 7 slugs; non-core slug appears; loader silently merges | tests/genome_load.test.ts |
| O8 | §10 charter (was company_context): required fields enforced; subject_type enum bounded; nested products+north_stars validated | Missing field accepted; invalid subject_type accepted; nested-shape drift | tests/charter.test.ts |
| O9 | §7 MCP dispatcher: every tool routes to a defined ToolResult (ok|error|not_implemented), never throws; approval-gated tools surface requires_approval=true | A tool throws past the dispatcher; approval-required tool returns without requires_approval set | tests/mcp_server.test.ts |
| O10 | §7 easy-wire tools (tool_registry_browse · agent_validate_pipeline · type_extend · charter_read · charter_suggest_update) execute against real impls + return ok:true | Any of the 5 still returns not_implemented; charter_read silently reads without path; type_extend returns unknown change_class | tests/server_easy_wires.test.ts |
| O11 | §7 governance-wire tools (system_health · health_check · system_audit · proposal_create · tool_propose · tool_deprecate_propose · capability_research · gig_abort · agent_define · agent_evolve · access_grant_check) execute against real impls + return shaped data | A governance tool returns not_implemented; proposal_create skips ledger append; system_health drifts from outputs.all stats | tests/server_governance_wires.test.ts |
| O12 | §7 runtime-wire tools (output_write · execution_history_read) execute against outputs + ledger; output_write validates at write (T3) + adds provenance ref | Output written without core_type validation; execution_history_read ignores filter args | tests/server_runtime_wires.test.ts |
| O13 | §3 runtime: gig dispatch walks phases, invokes agent per phase, outputs typed + stored, ledger entry appended with genome_hash + run_fingerprint | Phase skipped; output untyped; ledger entry missing manifest fields | tests/runtime.test.ts |
| O14 | Claude invoker PURE pieces: buildPrompt renders the 5-layer hierarchy (disposition·identity·context·task) incl. upstream inputs + output schema; extractJson tolerantly parses bare/fenced/nested JSON from model output and throws when none present. (The spawn itself is the non-deterministic seam — explicitly NOT unit-tested.) | A prompt layer is dropped from buildPrompt; extractJson returns garbage or fails to throw on no-JSON; a test asserts over the live `claude` spawn | tests/claude_invoker.test.ts |
| O15 | §13 Bootstrap Run / rm-rf-rebuild litmus: loadGenome(repoRoot) reads exactly the 6 core types off disk; a registry reconstituted purely from files (loadRegistry) runs a full gig end-to-end through the MCP surface; an unregistered type does not validate | core_types/ on disk has ≠6 slugs; a gig can't run on a registry booted only from files; an unregistered type validates against the file-booted registry | tests/bootstrap_genome.test.ts |
| O16 | JSONG pure-TS port: pack/unpack of the 48-byte header + 280-byte tick reproduces the Python reference (sib/jsong.py) BYTE-FOR-BYTE against a Python-emitted golden fixture; round-trip is identity; malformed input (bad magic, wrong state-length, invalid role, non-record-multiple body) is rejected | TS bytes diverge from the Python golden (cross-language format fork); a malformed buffer is silently accepted; the port pulls a runtime dependency (would break X1) | tests/jsong.test.ts |
| O17 | Song-substrate core: 12 chromatic tones; interval consonance orders unison>fifth>third>tritone (just-intonation grounded); arity names by tone-count (mono/bi/tri/tetra/penta/polyphonic); resolve() returns a STRUCTURED read (full tension profile + tonic), V→I resolves, dissonant-ending does not | consonance ordering drifts from the ratios; resolve() collapses to a scalar pass/fail instead of preserving the profile; a dissonant final chord reads as resolved | tests/tones.test.ts |
| O18 | gig_song (engine→song bridge): a gig's ordered agents encode to a chord progression via a PARAMETERIZED primitive→tone map (overridable, unknown primitives dropped), output is STRUCTURE (progression + per-step arity + tones.resolve), and renders to a valid JSONG observation tick-log (one tick/agent, score=consonance) | the tone-map is hardcoded/un-overridable; output collapses to a scalar; the rendered jsong fails to round-trip through readAll | tests/gig_song.test.ts |
| O19 | Document Factory 5-layer contract: deterministic skeleton (L0→1) + narrative-kill slot-drop (L1→2, no fact→no slot→no invented content) + independent per-slot composition (L2→3, model sees only its facts) + single global coherence (L3→4) + branded render (L4→5); the InferenceRequest contract validates the typed response and retries-once-then-fails-loud (never silent-passes) | a factless section gets composed (invented content); a compose call sees sibling slots / the whole doc; a non-conforming inference response passes silently; output collapses past the typed contract | tests/document_factory.test.ts |
| O20 | Document Factory production wiring: buildInfererPrompt is PURE (same request→same prompt; carries only the dataset, every constraint, and the exact field contract) and makeClaudeInferer is the single non-deterministic seam (spawn injectable → prompt-build + fence-tolerant parse are tested; plugs into runInference); the schema-pack is GENOME DATA — loadSchemaPack reads eir_document_schemas.json (per-section density targets honored) and fails loud on a malformed/missing pack rather than silently degrading to the bootstrap default | the prompt leaks beyond the dataset or drops a constraint; the claude seam can't be tested without a key; a malformed genome pack silently falls back to the hardcoded default; density targets are ignored | tests/document_factory.test.ts |
| O21 | Genome file-loading — the "add capability = add a FILE" claim made real for ALL five classes: loadGenome reads agents/ standards/ skills/ evals/ (not just types), validating agents through defineAgent and standards through composeStandard (agent_slugs resolved against loaded agents) — identical to the code path; fails loud on dup slug, unknown agent ref, or composition error; and the SHIPPED example genome (sensor + summarizer + summarize) loads + composes from disk on the real repo root | a file-defined agent/standard skips the validators that code-defined ones pass; a standard silently drops an unresolved agent ref; the genome dirs ship empty so the core pitch has no demonstrated example; loader reads only types | tests/genome_loading.test.ts |
| O22 | The MCP server bootstraps from the genome FILES: bootstrapServerDeps loads the on-disk genome (COLTRANE_GENOME or cwd) → loadRegistry for types + genome.standards wired in, so a bare `node dist/server.js` serves the shipped genome and gig_dispatch runs a FILE-defined standard end-to-end; tests inject deps (bootstrap skipped), prod boots from files; unknown standard fails honestly | the server starts with an empty registry + no standards (gig_dispatch always not_implemented) despite genome files existing; the file-genome is ignored at runtime; a bad cwd silently yields an empty server instead of failing loud | tests/server_bootstrap.test.ts |

## Orthogonal — §8 Coltrane's Profile Constraints (11)
`tests/coltrane_profile_constraints.test.ts`:
- Never execute standard without presenting design first (unless auto-approve on)
- Never create new type if resolver scored existing ≥ 80
- Never create agent with permissions exceeding requesting user's access
- Never touch customer code/data/infra without explicit scoped permission
- Always estimate cost before execution; abort if estimate > budget
- Max 10 new types per design session
- Max 5 new agents per design session
- Always include a design-rationale output
- Never store customer credentials (scoped tokens with TTL only)
- Proactive proposals require ≥ 50 data points
- Can never approve its own proposals

## Discipline Protocol

1. Register here before opening the test file. PR-blocking until prereg row exists.
2. File path in row matches actual file. tracking.json reflects same path + owner + status.
3. Karma + apoha both implemented. orphan karma (no apoha) → reject at CI.
4. When closing a test, mark status in tracking.json. Don't delete the prereg row — keep the registration.
5. Adding a row requires an open lane in tracking.json. No off-prereg tests.

## Release tie-up — agent evolution lineage | # | Karma (must pass) | Apoha (must fail) | File |
|---|---|---|---|
| O24 | evolveProfile threads lineage: version+1, parent_version=base.version, status=draft, creative change applied; chain reconstructs | parent_version unset/wrong; in-place mutate (base unchanged); a harmonic or permissions change passes through evolve instead of requiring a proposal | tests/agent_evolve_lineage.test.ts |
| O23 | §7 promotion + learning surface — 5 tools wired through dispatcher: agent_promote/standard_promote/skill_promote enforce forward-only state-machine transitions and append a ledger event; session_review_write records reviews (requires gig_id/output_id/agent_slug/quality_scores); learning_synthesize aggregates reviews and gates evidence_sufficient on min_reviews, auto-creates a proposal only when threshold met + auto_propose=true | a backward transition (active→draft) is accepted; an unknown status enum passes; a review missing quality_scores records anyway; learning_synthesize emits evidence_sufficient under threshold; auto_propose silently no-ops when threshold met | tests/mcp_promotion_and_learning.test.ts |
| O25 | Blast-radius cage on the claude spawn — the agent can't inherit the host's ambient tools: `buildInvokerArgs` (pure) ALWAYS emits `--strict-mcp-config` + `--mcp-config <per-gig>` (deny ambient MCP) and adds `--allowedTools`/`--disallowedTools` from the agent's declared grant (`allowed_tools`/`disallowed_tools` on the Agent, genome-file declarable); `makeClaudeInvoker` writes the per-gig mcp-config then cleans it; a playwright agent (`agents/browser-scout.json`) is caged to exactly its tools (ports OG claude-launcher) | the spawn inherits the host's ambient MCP servers; allowed/disallowed grant is dropped; an undeclared agent silently gets full tools without `--strict-mcp-config`; the mcp-config isn't per-gig/cleaned | tests/invoker_cage.test.ts |
| O26 | Substrate-of-truth identity loop — genome-mutation tools CANONICALIZE + HASH + PERSIST + LEDGER-RECORD: agent_define/standard_compose/type_register validate → content_hash=sha256(canonJson(def)) → effective_hash → write `<class>/<slug>.json` under `deps.genome_dir` → ledger-seal (standard_slug=tool, genome_hash=effective_hash); deterministic (same input→same hash); survives process restart (FileLedger); type_extend/agent_evolve seal the new version's identity in the ledger. A hand-edited file with no ledger entry is an orphan (no identity) | a mutation tool returns success but persists nothing (contract lie); identity is never sealed (canonical_form wired to gigs only); a hand-edited file is indistinguishable from an MCP write; the hash isn't deterministic / doesn't survive restart | tests/substrate_identity_loop.test.ts |
