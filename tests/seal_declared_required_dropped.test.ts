// RED-first — issue #227, second half: "7 registered domain types declare
// `required_fields: []` … so an empty `{}` validates and seals as a well-formed empty
// output."
//
// The issue is CORRECT on the symptom and UNDERSTATES the cause. It frames the empty
// `required_fields` as possibly-deliberate sparseness for draft/scratch types. It is not.
// All 7 of those types DO declare their required fields — in the JSON Schema idiom, inside
// `schema.required` — and `src/registry.ts:161` throws that away:
//
//     const schema = {
//       type: "object",
//       properties: { ...baseProps, ...ownProps },
//       required: dt.required_fields,        // ← the type's own schema.required is DISCARDED
//       additionalProperties,
//     };
//
// Independently derived against main @ 929f81c (all 30 domain_types/*.json read):
//
//   slug                  schema.required (declared, dropped)
//   ────────────────────  ─────────────────────────────────────────────────────────────
//   draft-agent-profile   input_refs, slug, description, behavioral_primitives,
//                         system_prompt_draft, user_acceptance
//   draft-domain-type     input_refs, slug, extends, domain, schema, user_acceptance
//   draft-standard        input_refs, slug, domain, phases, user_acceptance
//   pattern-extraction    input_refs, user_signature, confidence_band
//   project-charter       id, name, use_case, scope
//   repo-survey           repo_path, repo_name, survey_completeness
//   seeding-verdict       input_refs, repos_surveyed, pass, checks, outcome
//
// ZERO domain types in the genome are genuinely sparse: every type with
// `required_fields: []` has a non-empty `schema.required`. So the "maybe the author meant
// it" reading has no instances to defend. This is an authoring-convention split — the 23
// patent/e2e types populate `required_fields` and leave `schema.required` empty; these 7
// (all domain `seeding` / `bootstrap`) do the reverse — and the loader never reconciles the
// two. `src/server.ts:609` shows the intended direction of normalization:
//
//     const nextRequired = extension?.schema?.required ?? baseDef.required_fields;
//
// i.e. `type_extend` ALREADY treats `schema.required` as the authoritative source and
// projects it into `required_fields`. These 7 types were hand-authored as files, so that
// normalization never ran on them.
//
// Contract pinned here: a domain type's declared required fields are enforced at seal,
// whichever of the two fields the author used to declare them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOutputStore, loadGenome, loadRegistry, OutputStoreError } from "../src";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Which core each of the 7 extends — needed to build a well-formed write() call.
//
// `partial` is the load-bearing fixture. Each one is a payload that:
//   - carries at least one DECLARED field with a schema-valid value, so it is not empty
//     and cannot be caught by a naive "reject {}" rule;
//   - OMITS at least two other fields the type's own schema.required names, so a correct
//     #229 union fix rejects it;
//   - for Artifact/Verdict cores, ALSO satisfies the #228 path-(b) core invariant
//     (non-empty validation_criteria / checks-with-method), so the ONLY thing that can
//     reject it is #229.
//
// That third property is what makes every one of these a pure #229 red. Without it, the
// four Artifact/Verdict rows would go green on the (b) wiring alone, with schema.required
// still discarded — which is exactly how the earlier all-`{}` version of this file could
// be fully greened while the defect it names was untouched.
const AFFECTED = [
  {
    slug: "draft-agent-profile", core: "Artifact", primitive: "CREATE",
    // missing: input_refs, description, behavioral_primitives, system_prompt_draft, user_acceptance
    partial: { slug: "drafted-agent", validation_criteria: ["human review before adoption"] },
  },
  {
    slug: "draft-domain-type", core: "Artifact", primitive: "CREATE",
    // missing: input_refs, extends, domain, schema, user_acceptance
    partial: { slug: "drafted-type", validation_criteria: ["human review before adoption"] },
  },
  {
    slug: "draft-standard", core: "Artifact", primitive: "CREATE",
    // missing: input_refs, domain, phases, user_acceptance
    partial: { slug: "drafted-standard", validation_criteria: ["human review before adoption"] },
  },
  {
    slug: "pattern-extraction", core: "Interpretation", primitive: "INTERPRET",
    // missing: input_refs, confidence_band
    partial: { user_signature: "rapid cross-domain research with TDD-flavored code changes" },
  },
  {
    slug: "project-charter", core: "Plan", primitive: "PLAN",
    // missing: use_case, scope
    partial: { id: "charter-1", name: "A charter" },
  },
  {
    slug: "repo-survey", core: "Signal", primitive: "SENSE",
    // missing: repo_name, survey_completeness
    partial: { repo_path: "/Users/x/repo" },
  },
  {
    slug: "seeding-verdict", core: "Verdict", primitive: "VERIFY",
    // missing: input_refs, repos_surveyed, pass. `method` rides as an undeclared extra on
    // the check item — seeding-verdict overloads `checks` with an item schema requiring
    // ["name","passed"] and never mentioning `method` (filed as #230), so a MAXIMALLY
    // schema-valid seeding-verdict is rejected by path (b). Adding `method` is only
    // possible because the nested item schema is not closed; the type still needs a real
    // schema amendment, not a field top-up.
    partial: { outcome: "completed", checks: [{ name: "coverage", passed: true, method: "manual" }] },
  },
] as const;

function readType(slug: string): { required_fields: string[]; schema: { required?: string[] } } {
  return JSON.parse(readFileSync(join(REPO_ROOT, "domain_types", `${slug}.json`), "utf8"));
}

describe("#227 — the genome's declared required fields are dropped, not absent", () => {
  const genome = loadGenome(REPO_ROOT);

  it("re-derives the affected set from disk: exactly 7 types, none of them genuinely sparse", () => {
    // The defect signature: declared-required is non-empty, but the slice registry.ts:161
    // actually enforces (`required_fields`) is empty — so the declaration is lost.
    const lossy = [...genome.domain_types.values()]
      .filter((t) => ((t.schema as { required?: string[] }).required ?? []).length > 0)
      .filter((t) => t.required_fields.length === 0)
      .map((t) => t.slug)
      .sort();
    expect(
      lossy,
      "This census names the types whose declared required-fields registry.ts:161 discards. " +
        "If it came back EMPTY, the likely cause is that the 7 files were normalized on disk " +
        "(schema.required → required_fields, the direction server.ts:609 already uses) — which " +
        "is a legitimate way to land #229. In that case this census has done its job: update it " +
        "rather than reintroducing the discard.",
    ).toEqual(AFFECTED.map((a) => a.slug).slice().sort());

    // The load-bearing correction to the issue: every one of them DID declare its
    // required fields, in schema.required. There is no "deliberately sparse" instance to
    // protect — so tightening these cannot break an intentional design.
    //
    // Asserted as "declared in AT LEAST ONE of the two fields", not as
    // `required_fields === []`. #229 cites src/server.ts:609 as the intended normalization
    // direction (schema.required → required_fields); an implementer who normalizes these
    // 7 files on disk would flip a `required_fields === []` pin red with a message that
    // says nothing about the defect. What must hold either way is that the fields are
    // declared somewhere and enforced at seal.
    for (const { slug } of AFFECTED) {
      const raw = readType(slug);
      const declared = [...new Set([...(raw.schema.required ?? []), ...raw.required_fields])];
      expect(declared.length).toBeGreaterThan(0);
    }
    expect(genome.load_errors).toEqual([]);
  });

  for (const { slug, core, primitive } of AFFECTED) {
    it(`${slug} seals {} today, discarding its declared schema.required`, () => {
      const declared = readType(slug).schema.required ?? [];
      // PRECONDITION: the type file names required fields (green today, and after any fix).
      expect(declared.length).toBeGreaterThan(0);

      const store = createOutputStore(loadRegistry(genome));

      // RED: an empty object seals as a well-formed instance of a type that explicitly
      // declares 3-6 required fields. This is the shape a mis-firing extractJson produces.
      expect(() =>
        store.write({
          core_type: core,
          domain_type: slug,
          domain: "seeding",
          gig_id: `gig-${slug}`,
          agent_slug: "source-walker",
          primitive,
          data: {},
        }),
      ).toThrow(OutputStoreError);
      expect(store.all()).toHaveLength(0);
    });
  }

  // The reds that actually isolate #229. Each payload is non-empty and (for Artifact and
  // Verdict cores) already satisfies the #228 path-(b) core invariant, so neither a
  // "reject empty objects" shortcut nor the (b) wiring can green them. Only honoring the
  // type's declared schema.required can.
  for (const { slug, core, primitive, partial } of AFFECTED) {
    it(`${slug} seals a partial payload today — declared fields missing, nothing rejects it`, () => {
      const declared = readType(slug).schema.required ?? [];
      const present = Object.keys(partial);
      const missing = declared.filter((f) => !present.includes(f));
      // PRECONDITION: this fixture really is incomplete against the type's own contract,
      // and really does carry something (so "reject {}" cannot explain a future green).
      expect(missing.length).toBeGreaterThanOrEqual(2);
      expect(present.length).toBeGreaterThan(0);

      const store = createOutputStore(loadRegistry(genome));

      // RED: the record seals with 2-5 of its declared required fields simply absent.
      expect(() =>
        store.write({
          core_type: core,
          domain_type: slug,
          domain: "seeding",
          gig_id: `gig-${slug}-partial`,
          agent_slug: "source-walker",
          primitive,
          data: { ...partial },
        }),
      ).toThrow(OutputStoreError);
      expect(store.all()).toHaveLength(0);
    });
  }

  it("EVERY type with declared required fields still rejects {} — all 41, not a spot-check", () => {
    // Guards against a fix that SWAPS the source (schema.required instead of
    // required_fields) rather than unioning them. A swap would silently stop enforcing the
    // 23 types that use required_fields — and a single-type spot-check would not notice.
    const registry = loadRegistry(genome);
    const checked: string[] = [];
    for (const t of genome.domain_types.values()) {
      const declared = [
        ...new Set([...((t.schema as { required?: string[] }).required ?? []), ...t.required_fields]),
      ];
      if (declared.length === 0) continue; // none exist today; guarded by the census above
      expect(
        registry.validate({ core_type: t.extends, domain_type: t.slug, data: {} }).valid,
        `${t.slug} declares required ${JSON.stringify(declared)} but accepts {}`,
      ).toBe(false);
      checked.push(t.slug);
    }
    // ALL domain types declare required fields somewhere, so all must be covered. The
    // literal pins the census against silent genome shrinkage: 30 at #227. Org-authored
    // types (the 2026-08 studio/live/auth/genome/naming sets) live in an org STORE, not in
    // this tree — the repo genome is the base repertoire, and the genome-reconcile that
    // moved them is the reason this pin went 59 → 30 rather than anything shrinking silently.
    //
    // 30 → 41: the default-genome quartet added 11 types — the software-change set
    // (change-request, change-context, change-decision, change-plan, change-set,
    // change-verdict) and the product-design set (design-question, design-brief,
    // design-definition, design-concept, design-verdict). All 11 declare their required
    // fields in `required_fields`, so they join `checked` rather than slipping past the
    // `declared.length === 0` skip above, and none of them appears in the `lossy` census —
    // which is why that assertion is untouched.
    //
    // 41 → 44: the preview-deploy set (sealed gig 0538105e) added 3 types —
    // preview-deployment (extends Artifact), deploy-verdict (extends Verdict) and
    // branch-state (extends Signal). All 3 declare their required fields in
    // `required_fields`, so they join `checked` and none appears in the `lossy` census.
    //
    // 44 → 51: the lineage-pass set (lineage-pass-v1) added 7 types — lineage-question,
    // lineage-hit, internal-inventory (extend Signal), lineage-map (extends Interpretation),
    // alignment-plan (extends Plan), lineage-record (extends Artifact) and lineage-verdict
    // (extends Verdict). All 7 declare their required fields in `required_fields`, so they
    // join `checked` and none appears in the `lossy` census.
    //
    // 51 → 52: the software-change-pr set added 1 type — pull-request (extends Artifact),
    // the opened PR the pr-publisher seat seals. It declares its required fields in
    // `required_fields`, so it joins `checked` and does not appear in the `lossy` census.
    //
    // 52 → 60: the defect-investigation-v1 set added 8 types — reproduction, defect-report
    // (extend Signal), defect-location, defect-class (extend Interpretation), root-cause
    // (extends Judgment), fix-spec (extends Plan), class-sweep, fix-verification (extend
    // Verdict). All 8 declare their required fields in `required_fields`, so they join
    // `checked` and none appears in the `lossy` census.
    //
    // 60 → 63: the spec-drafting-v1 set added 3 types — grounding-dossier (extends
    // Interpretation), subsystem-contract (extends Judgment), red-spec (extends Artifact) —
    // the lineage dossier, the falsifiable contract, and the buildable RED spec that the
    // spec-drafting pipeline produces. All 3 declare their required fields in `required_fields`,
    // so they join `checked` and none appears in the `lossy` census.
    //
    // 63 → 64: `woodshed-record` (extends Interpretation) — the record of solitary practice,
    // added because the genome typed the bandstand and not the practice room. It declares its
    // required fields in `required_fields` (question, iterations, corrections, still_open), so
    // it joins `checked` and does not appear in the `lossy` census.
    expect(checked).toHaveLength(genome.domain_types.size);
    expect(checked.length).toBe(64);
  });
});

describe("#227 — positive controls for the declared-required fix (must stay green)", () => {
  const genome = loadGenome(REPO_ROOT);

  it("a repo-survey carrying every field its schema.required names still seals", () => {
    const store = createOutputStore(loadRegistry(genome));
    const rec = store.write({
      core_type: "Signal",
      domain_type: "repo-survey",
      domain: "seeding",
      gig_id: "gig-ok",
      agent_slug: "source-walker",
      primitive: "SENSE",
      // `source` joined repo-survey's schema.required under the #227 ruling (Signal's
      // substance floor), so "every field its schema.required names" now includes it.
      data: { repo_path: "/Users/x/repo", repo_name: "repo", survey_completeness: "complete", source: "file:///Users/x/repo" },
    });
    expect(rec.domain_type).toBe("repo-survey");
    expect(rec.content_sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a project-charter carrying every field its schema.required names still seals", () => {
    const store = createOutputStore(loadRegistry(genome));
    const rec = store.write({
      core_type: "Plan",
      domain_type: "project-charter",
      domain: "bootstrap",
      gig_id: "gig-ok-2",
      agent_slug: "problem-definer",
      primitive: "PLAN",
      // `steps` joined project-charter's schema.required under the #227 ruling (Plan's
      // substance floor) — a charter that sequences nothing is not a plan.
      data: { id: "ch-1", name: "A charter", use_case: "code-changes", scope: "do the thing", steps: ["scaffold the project", "run the first gig"] },
    });
    expect(rec.domain_type).toBe("project-charter");
  });

});
