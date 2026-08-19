// Genome — OPEN questions raised by the 2026-08-19/20 sweep, committed rather than left in prose.
//
// Each was hit while fixing something adjacent, each is a real contract that is not GROUNDED, and
// each was previously recorded only in a PR description — which is folklore with a URL. The OPEN
// primitive is the right home: reported as a todo, never a false pass, never a noisy fail, and
// carrying the concrete assertion that would move it OPEN -> RED.
import { describe } from "vitest";
import { open } from "./_support/open.js";

describe("genome: open questions", () => {
  open("input_contract cannot express seed-or-produce", {
    question:
      "Can a chair declare an input it may EITHER be seeded with OR produce itself? Every input_contract entry is mandatory (runtime.ts:2101 throws missingGigInput for each unsatisfied one), so naming a type there forces every dispatch to supply it. PR #424's I9 asserted the read-context chair names change-context; that would have made a pre-built reading compulsory on every run, contradicting I11's four interchangeable producers — one of which is that very chair. The clause was withdrawn rather than satisfied.",
    resolves_when:
      "ChairSchema carries an optional-input arm (e.g. `seedable_inputs`) that the runtime treats as satisfied-if-absent, and a law dispatches the same standard twice — once WITH a seeded change-context and once without — and both run: the seeded one skips the reader, the unseeded one produces it.",
    grounding: "PR #424 (I9 amendment, in the law's own comment) + src/runtime.ts:2101 (#156 seeding seam)",
  });

  open("reuse enforcement has no notion of identity", {
    question:
      "Should score() consider a type's SLUG? It ranks candidates on extends/domain/required_fields and never on name, so it cannot distinguish 'another version of this type' from 'a duplicate of this type'. PR #438 routed around it by excluding the registrar's own slug at the callsite, deliberately leaving score() alone — but the same blindness means any legitimately similar NEW type is refused at 80 with no way to say 'this one is genuinely different, and here is its name'.",
    resolves_when:
      "score() takes identity into account (or a caller-supplied intent), and laws pin BOTH directions: a second version of an existing slug resolves as the same type, while a differently-named type sharing extends/domain/required_fields is still refused at >= 80 — the purpose reuse enforcement exists for.",
    grounding: "PR #438 (rejected alternatives + the callsite exclusion) + src/registry.ts:244-264",
  });

  open("the type system is not version-aware end to end", {
    question:
      "Should a sealed output's domain_type_version participate in resolution, or is it a record-only fact? PRs #432/#433/#437 made a version DECISION read a real version and an output STAMP record it, but 9,110 already-sealed outputs carry v1 by construction, and nothing consumes the stamp when resolving a type. A record now states which version it conformed to and no reader acts on it.",
    resolves_when:
      "a consumer exists that reads domain_type_version off a sealed record and resolves against THAT version rather than the newest — with a law showing an output sealed at v1 still validating after its type reaches v3, and a decision recorded for what a v1 record means once v1 is retired.",
    grounding: "PRs #432, #433, #437 + the measured 9,110 outputs at v1 across 100 distinct types",
  });

  open("a room's checkpoint granularity", {
    question:
      "Is a gig's resume cursor chair-level or step-level? A checkpoint's roles entry records only sealed outputs (output_ids, content_shas, sealed_at), so resume can restart a chair but never resume inside one — a killed 331-second read loses the whole read. The chair's own session id IS in the gig log (84 occurrences in one chair), and Claude Code can resume a session by id, so the material for step-level exists; the invoker never emits --resume and nothing captures the id into the checkpoint.",
    resolves_when:
      "the checkpoint carries the chair's session id, the invoker passes --resume when restarting a chair that has one, and a law kills a chair mid-run and shows the resumed chair continuing rather than restarting — with the cost stated: a resumed thread carries prior context, so the cold-start cost a new room pays mostly disappears.",
    grounding: "the Engagement design (gig 919cc181) + the operator's doubt on that page + src/claude_invoker.ts:951 (reserve) and the checkpoint roles shape",
  });
});
