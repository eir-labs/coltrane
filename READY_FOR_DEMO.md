# Ready for demo — coltrane-oss

## Checklist

- [x] Engine verified — 492/492 tests pass, `tsc --noEmit` clean, 3.41s wall-time on `npm run verify`.
- [x] No CONFIDENTIAL markers in public-facing files — `**INTERNAL | CONFIDENTIAL**` removed from `Coltrane Spec.docx.md` line 13.
- [x] Internal-author labels stripped from public-facing files:
  - `Coltrane Spec.docx.md` (header only — body had none)
  - `README.md` (already clean)
  - `prereg.md` (~50 inline author-tag parens dropped)
  - `tracking.json` (`updated_by` + `owner` + `assignments` collapsed to `"eng"`; JSON re-validated)
  - `src_api_surface.md` (owner footnote neutralized)
  - `docs/CURRENT_STATE_2026-05-26.md` (owner column dropped from build-status table; footer credit neutralized)
  - `src/acoustics.ts`, `src/document_factory.ts` (top-of-file comments)
  - `tests/canonical_form.test.ts`, `tests/server_runtime_wires.test.ts`, `tests/server_easy_wires.test.ts`, `tests/coltrane_profile_constraints.test.ts` (top comments + describe strings)
- [x] Internal-only doc archived (not deleted) — `docs/AUDIT_2026_05_29.md` moved to `docs/_archive/AUDIT_2026_05_29.md`. It references operational cadence + cross-repo audit pattern that aren't useful to an external reader.
- [x] Public README first-100-words pass for "stranger can understand" — the 5-sentence "What it is" is direct; the install + run + verify gate is the first thing under the fold. "Genome" is jargon but defined in the same paragraph. Acceptable.
- [ ] Demo script (5-minute walkthrough) drafted — NOT done in this phase (out of scope for the cleanup pass).

## What's internal-only after this pass

- `docs/_archive/AUDIT_2026_05_29.md` — keep for internal reference; references operational cadence + cross-repo audit pattern from another build, not useful to a new contributor.
- The "Owner" assignments in `tracking.json` are now all `"eng"` — internal task allocation is no longer surfaced in the public artifact. Recovering who-did-what is via git blame, which is normal OSS hygiene.

## What's pickable for a live demo

1. **`npm run verify`** — green in ~3.4s. Stranger sees 492/492 + tsc clean. The fastest possible "the gate works" demonstration.
2. **The rebuild-from-files litmus** (test `tests/bootstrap_genome.test.ts`, prereg row O15) — a registry reconstituted purely from `core_types/`, `agents/`, `standards/` on disk runs a full gig end-to-end through the MCP surface. This is the clearest evidence of "the repo IS the genome."
3. **`examples/hello_band/run.ts`** — runs offline (deterministic stand-in for Claude spawn), shows the smallest possible 2-agent pipeline (sensor → summarizer). Runnable with `npx tsx examples/hello_band/run.ts`.
4. **Cross-language hash conformance** (test `tests/canonical_form.test.ts`) — 3 published reference hashes reproduce byte-for-byte in TS; Python proof harness reproduces the same hashes. Single sharpest "this is interop-grade" point.
5. **MCP server boot** — `npm run build && node dist/server.js`, then connect any MCP client (Claude Code, Cursor). 28 tools wired to real impls, zero `not_implemented` stubs.

## Notes / flags for review

- None of the band-persona strips broke any test. Replacements were comments + author-labels + describe strings, never identifiers.
- The product term "Coltrane" / "coltrane" remains throughout — that's the product name, load-bearing in code (`ColtraneProfile`, `coltrane_profile.ts`, `createColtraneServer`, MCP `name: "coltrane"`).
- "Lighthouse" hex vectors in `prereg.md` O1 → renamed "published reference hex vectors". Test descriptions in `canonical_form.test.ts` likewise neutralized. The hash values themselves (load-bearing) untouched.
