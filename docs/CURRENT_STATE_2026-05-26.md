% Coltrane Open Source — Current State
% Eir Is Real, Inc.
% 2026-05-26

## TL;DR

Coltrane OSS (the **Well-Tempered Agent System**) is a clean-room, dependency-free TypeScript rebuild of the Coltrane orchestration brain, built to be **given away** (Apache-2.0). The v0 engine is **functionally complete and green**: every spec section that is an engine concern is covered, all 32 MCP tools are wired to real implementations (zero stubs), and the whole suite passes the real gate.

- **`npm run verify` → 492 tests / 58 files, `tsc --noEmit` clean.**
- **28/32 MCP tools wired** to real in-repo implementations — no `not_implemented` stubs remain.
- **47 registered pre-reg rows** (every test pairs a *karma* must-pass with an *apoha* must-fail).
- **The rebuild-from-files litmus passes**: a registry reconstituted purely from on-disk genome files runs a full gig end-to-end.
- **README + Apache-2.0 license shipped**; cross-language (TS↔Python) canonical-form conformance proven on 3 published hashes.

Remaining before a public release is **not engine work** — it's two domain lanes (§10 company context, §11 product-development) and the live-Claude spawn validation (needs a CLI + key, out of unit scope).

---

## What Coltrane is

An MCP server that composes bands of agents from a **content-addressed genome** (plain files), runs them against typed inputs, and emits a **reconstructible, hash-sealed record** of what happened. Self-contained, per-user, depends on nothing but Claude Code as the cognition.

**The three-layer giveaway model:**

| Layer | What it is | Who holds it |
|---|---|---|
| ENGINE | This repo — runtime + MCP server + canonical-form contract | Given away (Apache-2.0) |
| CONTENT | The per-deployment genome (your type/agent/standard definitions) | Re-accumulable by anyone |
| INSTITUTION | The party operating a deployment, carrying accountability | The commercial coordinate — not code |

The engine is gifted in full. The accountability stake is the only commercial coordinate, held by whoever runs a deployment.

## The core model (what a reader needs to hold)

- **Genome** — JSON/text files under `core_types/`, `domain_types/`, `agents/`, `standards/`, `skills/`. Adding a type or agent = adding a file. No TypeScript change required.
- **Five definition classes** — `types · players(agents) · standards · skills · evals`. Each is hashable and fixture-backable.
- **Six cognitive primitives** — `SENSE · INTERPRET · JUDGE · PLAN · CREATE · VERIFY`, each mapping 1:1 to a core output type (`Signal · Interpretation · Judgment · Plan · Artifact · Verdict`).
- **Three identity hashes per definition** — `content_hash` (the bytes) · `dependency_hash` (relational closure) · `effective_hash` (the binding). Byte-identical definitions in different contexts produce different effective hashes.
- **One sealed record per gig** — `genome_hash` (deterministic — the reproducibility key) + `run_fingerprint` (carries model_version + eval scores, non-deterministic by design). Both in the append-only ledger.

---

## Build status by spec section

| Section | Status | Notes |
|---|---|---|
| §2 Type system | ✅ covered | 6 immutable core types, loaded from disk |
| §3 Primitives + composition | ✅ covered | progression rules (CREATE needs upstream INTERPRET/PLAN, etc.) |
| §4 Agent model (3 spaces) | ✅ covered | creative / harmonic / permissions change-classes |
| §5 Domain type registry | ✅ covered | resolve/register/extend, reuse enforcement, genome bridge |
| §6 Database schema | ✅ covered | pure-TS outputs store + provenance graph + findings view + runtime |
| §7 MCP surface (28 tools) | ✅ covered | full surface enumerated + approval-gated |
| §8 Coltrane's own profile | ✅ covered | 11 self-governance constraints |
| §9 Trust & access | ✅ covered | grant TTL, plan-scope, artifact/verdict validation |
| §10 Company context | ⏳ assigned | charter exists; domain lane open |
| §11 Product-development domain | ⏳ assigned | open lane |
| §12 Pricing architecture | ✅ covered | credit formula, depth/model multipliers |
| §13 Bootstrap sequence | ✅ covered | rebuild-from-files litmus proven (O15) |
| §14 Testing strategy | meta | the pre-reg discipline itself |

## Engine implementation (`src/`, 21 modules, all shipped)

`core_types · type_versioning · composition · registry · loader · outputs · ledger · runtime · server · mcp · simulate · claude_invoker · access_grant · agent_profile · output_validation · pricing · charter · coltrane_profile · learner · canonical_form · index`

**The MCP server (`server.ts`):** a pure, fully-testable `dispatchTool` dispatcher + the stdio wiring. **All 28 tools wired to real implementations** — the `NEEDS_RUNTIME` stub set is now empty. The only `not_implemented` paths left are *correct behavior*: a bare server with no standards/invoke injected (`gig_dispatch` guard) and the unknown-slug fallback.

**The runtime (`runtime.ts`):** `runGig` walks a standard's phases, invokes each agent via an injectable `AgentInvoker` (a deterministic mock in tests, the real `claude` CLI in production), writes typed + validated outputs, links `derived_from` provenance, and records a ledger entry with a deterministic `genome_hash` + a model-sensitive `run_fingerprint`.

**Cognition seam (`claude_invoker.ts`):** the real invoker builds the 5-layer prompt (pure, tested) and spawns `claude -p`. The spawn itself is the one non-deterministic seam — explicitly *not* unit-tested (it needs a CLI + key); its pure pieces are.

## Test & discipline state

- **492 tests across 58 files, `tsc --noEmit` clean** — the gate is `npm run verify` = `tsc && vitest`, both must pass.
- **47 pre-registered rows** in `prereg.md`. Discipline: register before opening the file; every test pairs a *karma* (must-pass) with an *apoha* (must-fail); the file path + owner + status mirror into `tracking.json`.
- **End-to-end coverage**: full loop through the MCP surface (E1), backward-compat findings view at scale (E2), 5-phase bug-fix standard with no phase-skip (E3), dynamic mid-gig type registration (E4), full artifact→signal provenance trace (E6), and the **bootstrap rebuild litmus (O15)** — a registry rebuilt purely from disk files runs a complete gig.
- **Cross-language conformance**: the canonical-form hashes reproduce byte-for-byte in both this TS engine and the Python proof harness (3 published reference hashes in the README).

## Provenance / notarization

`src/server.ts` is OTS-stamped at sha `a12f828c…` (0 stubs), superseding the prior `b9573f6f…` (12 stubs). The genome is git-hash-chained; the rebuild litmus enforces "the repo *is* the genome."

---

## What remains before a public OSS release

1. **§11 product-development domain** — open lane.
2. **§10 company-context domain** — the `charter` primitive exists; the surrounding domain lane is open.
3. **Live-Claude validation** — exercising the real `claude` spawn end-to-end (needs a CLI + key; out of unit-test scope, belongs in a manual/integration pass).
4. **Docs polish for external audiences** — the README is shipped + technically complete; any customer/funder-facing rendering is an audience-coupling pass, not engine work.

**None of the above is engine-blocking.** The v0 engine is releasable as-is for the developer audience; the open lanes are domain content + a live smoke pass.

## Suggested hooks for new-contributor assessment

- **Run the litmus yourself**: `git clone … && npm install && npm run verify` → expect 322 green. Then delete any cache and re-run — green means the genome is the source of truth.
- **Read `README.md`** (the 5-sentence "what it is" + 3-layer give-away model + canonical-form interop section).
- **Inspect the surface**: `src/mcp.ts` (28 tools) and `tests/server_*_wires.test.ts` (proof each is real, not a stub).
- **Assess the gift framing**: is the ENGINE / CONTENT / INSTITUTION split the right commercial coordinate? Is Apache-2.0 the right license posture?
- **Open-lane call**: do §10/§11 need to land before a public release, or do they ship as "domains are content, bring your own"?

---

*Source of truth: `tracking.json` + `prereg.md` in the repo.*
