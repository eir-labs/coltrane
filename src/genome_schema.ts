// genome_schema.ts — the genome's DNA, defined ONCE in Zod. Every genome class's shape lived in
// 3-5 hand-maintained places (the TS type, the construction function, the MCP input_schema, the
// handler, the file format) and they drifted — a field added to the type silently never reached the
// MCP surface; a constructor quietly dropped a sealed field; the loader validated skills/evals as
// untyped bags. This module is the single source: from each schema we derive the TYPE (z.infer),
// the VALIDATOR (.parse), the MCP input_schema (zodToMcpProps), and the loader's file validation.
// Add a field once here and every restatement follows.
import { z } from "zod";

// ── Building blocks (the shared sub-schemas the classes compose from) ─────────────
export const PrimitiveSchema = z.enum(["SENSE", "INTERPRET", "JUDGE", "PLAN", "CREATE", "VERIFY"]);
export const BelbinRoleSchema = z.enum(["explorer", "analyst", "critic", "synthesizer", "planner", "executor", "audience_modeler"]);
export const CodeToolAccessSchema = z.enum(["none", "read", "write", "full"]);
export const ModelTierSchema = z.enum(["economy", "standard", "premium"]);
export const DepthSchema = z.enum(["skim", "quick", "standard", "deep"]);

// The caged-browser grant (the cage branch adds browser_grant to the agent; the schema is here so
// the grant is validated like any field). Network grant for skills lives in the skill schema.
export const BrowserGrantSchema = z.object({
  allowed_origins: z.array(z.string()),
  blocked_origins: z.array(z.string()).optional(),
  trace_dir: z.string().optional(),
  isolated: z.boolean().optional(),
  headless: z.boolean().optional(),
});
export type BrowserGrant = z.output<typeof BrowserGrantSchema>;

// ── Skill — the package shape. Reconciles the two current shapes (SkillMeta typed + SkillRecord
//    {slug;[k]:unknown} bag) into one. SHAPE-aligned only: determinism_ratio + fixtures are
//    fields/artifacts the schema knows, but the OG rigid "fixtures pass ≥ threshold to PROMOTE"
//    ceremony is deliberately NOT a schema invariant — promotion strictness is a separate, tunable
//    policy. The fixture/determinism runner still enforces "fixtures pass + deterministic" in CI.
//
//    Declared ABOVE the agent because an agent CARRIES skills (AgentSchema.skills below): the
//    package shape has to exist before the record that embeds it. ──
export const NetworkGrantSchema = z.object({
  allow: z.array(z.string()).default([]),
  methods: z.array(z.string()).optional(),
  max_requests: z.number().optional(),
  max_bytes: z.number().optional(),
});
export const SkillPermissionSchema = z.object({
  tier: z.number().optional(),
  network: NetworkGrantSchema.optional(),
});
/**
 * A HYDRATION SLOT — a named hole in a skill's method that something outside the agent fills.
 *
 * The seam this draws is the whole point of a carried skill: the METHOD is the agent's (portable,
 * it travels into any institution that seats the player), while the DATA the method operates on is
 * the institution's. A skill that hard-codes one house's constraints is not portable; a skill that
 * declares the slot and receives the constraints is.
 *
 * `binding` says WHEN the slot is filled, and the two times are not interchangeable:
 *   - "institution" (the default when omitted) — filled at SEAT time from the chair's `supplies`.
 *     Known before any run exists, so a `required` slot nothing supplies is a DEAD SLOT and
 *     composition refuses it, exactly as an unresolvable tool grant is refused.
 *   - "gig" — filled at DISPATCH time from the gig payload. These are the chair contract's formal
 *     parameters and the dispatch input is the argument list, so compose time cannot demand them:
 *     it knows nothing about the arguments of a run that has not been asked for yet. Their floor
 *     belongs to the runtime pre-flight at t=0.
 */
export const HydrationSlotSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  binding: z.enum(["institution", "gig"]).optional(),
});
export const SkillSchema = z.object({
  slug: z.string(),
  version: z.number().optional(),
  skill_type: z.string().optional(),
  input_type: z.string().optional(),
  output_type: z.string().optional(),
  corpus: z.string().optional(),
  determinism_ratio: z.number().optional(),
  permission: SkillPermissionSchema.optional(),
  description: z.string().optional(),
  timeout_ms: z.number().optional(),
  /** Slot name → the declared shape of what fills it. See HydrationSlotSchema: the method is the
   *  agent's, the slot data is the institution's (or the gig's). */
  hydration: z.record(HydrationSlotSchema).optional(),
  // a package declares fixtures (test suite + determinism meter) + its code. Present so skill_define
  // is package-aware (meta + fixtures + code), not the retired flat {slug, domain, md}.
  fixtures: z.array(z.unknown()).optional(),
  code: z.string().optional(),
  md: z.string().optional(),
});

// ── Agent — the template class, migrated end-to-end. z.input = AgentDef (what you author,
//    optionals allowed); z.output = Agent (defaults applied). One definition, both types. ──
export const AgentSchema = z.object({
  slug: z.string(),
  primitives: z.array(PrimitiveSchema).readonly(),
  input_types: z.array(z.string()).readonly().default([]),
  output_types: z.array(z.string()).readonly().default([]),
  domain: z.string().nullable().default(null),
  identity: z.string(),
  method: z.string(),
  constraints: z.array(z.string()).readonly(),
  behavioral_primitives: z.tuple([BelbinRoleSchema, BelbinRoleSchema]).readonly(),
  // optional on the OUTPUT type too (defineAgent fills []) — matches the current Agent interface so
  // the ~50 call-sites that build Agent objects don't all break. defineAgent applies the [] default.
  allowed_tools: z.array(z.string()).readonly().optional(),
  disallowed_tools: z.array(z.string()).readonly().optional(),
  /** REFERENCES into the shared repertoire (`skills/<slug>/`): the off-the-shelf method, bound by
   *  name, resolved against the genome's skills map at run time. A slug that resolves to no
   *  package is a dangling binding (loader) and a dead name when a chair requires it (runtime). */
  skill_slugs: z.array(z.string()).readonly().optional(),
  /** The agent's OWN skills, carried on its record rather than referenced by name.
   *
   *  An agent is the thing closest to its own work, so it is the agent that grows technique — and
   *  grown technique has to be portable: the same player seated in a second institution brings its
   *  method along instead of waiting for that institution's repertoire to contain it. Institution
   *  data never rides along; a carried skill declares `hydration` slots and the seating fills them.
   *
   *  Relationship to `skill_slugs`: slugs name the SHARED repertoire, `skills` are the agent's own.
   *  Resolution unions the two, carried-first, so a carried definition SHADOWS a same-slug
   *  repertoire package (the player's own technique is the one that plays) and a slug covered by a
   *  carried definition is not a dangling binding. */
  skills: z.array(SkillSchema).readonly().optional(),
  model_tier: ModelTierSchema.optional(),
  max_tool_calls: z.number().optional(),
  max_token_budget: z.number().optional(),
  code_tool_access: CodeToolAccessSchema.optional(),
  depth_profile: DepthSchema.optional(),
  browser_grant: BrowserGrantSchema.optional(),
});

export type AgentInput = z.input<typeof AgentSchema>;
export type AgentOutput = z.output<typeof AgentSchema>;

// ── Chair / Phase / Standard — the schema is the DNA; the runtime Standard (resolved agents) is a
//    transform output and stays a derived type in composition.ts. The FILE/compose shape is here. ──
export const ChairSchema = z.object({
  role: z.string(),
  agent_slug: z.string().optional(),
  skill_slug: z.string().optional(),
  /** The human seat: the chair is an approval office held by a person. No agent, no skill —
   *  the incumbent's sealed verdict is the chair's output, and a gig that reaches this chair
   *  unapproved PARKS (awaiting_approval) rather than confabulating a yes. */
  human: z.boolean().optional(),
  depends_on: z.array(z.string()).default([]),
  input_contract: z.array(z.string()).default([]),
  output_contract: z.array(z.string()).default([]),
  // #243 — which promised outputs may legitimately be absent. Deny-by-default: omitted
  // means every promised type is required. Subset of output_contract, checked at compose.
  optional_outputs: z.array(z.string()).default([]),
  /** The FLOOR. A skill named here must be held by whoever is seated — bound by slug or carried on
   *  the record — or the seating is refused at compose and the chair fails closed at run. */
  required_skills: z.array(z.string()).default([]),
  /** The PREFERENCE. Technique this chair would rather its incumbent hold, stated without refusing
   *  the ones who do not: the roster of available agents is a fact about the world, not a defect,
   *  and a preference that refused a seating would be a second floor under another name. Nothing
   *  checks it at compose time — deliberately, including its names, since a chair may legitimately
   *  prefer a technique no agent in the genome has grown yet. */
  preferred_skills: z.array(z.string()).default([]),
  /** The institution's side of a hydration contract, at the phase-chair level: slot name → the
   *  value that fills it. An institution-bound `required` slot on a skill the seated agent holds
   *  and nothing here (or on the institutional chair) fills is refused at compose. */
  supplies: z.record(z.unknown()).optional(),
});
export const PhaseSchema = z.object({ name: z.string(), chairs: z.array(ChairSchema) });
/** Lifecycle status, shared by domain types and standards (#203). */
export const DomainTypeStatusSchema = z.enum(["active", "deprecated", "retired"]);

export const StandardSchema = z.object({
  slug: z.string(),
  domain: z.string(),
  // #203 — a lifecycle field the loader used to STRIP. An author could mark a standard
  // deprecated, see the edit accepted, and watch it stay dispatchable with nothing saying
  // otherwise; the loader models what it models and silently discards the rest.
  //
  // OPTIONAL rather than defaulted, deliberately. A default here would make `status`
  // required on the runtime `Standard` type, which every hand-rolled literal (34 of them in
  // the suite alone) would then have to restate — noise that teaches nobody anything. The
  // LOADER applies the default, so a standard read from disk always carries one and a
  // standard built in memory need not care.
  status: DomainTypeStatusSchema.optional(),
  agents: z.array(z.unknown()).optional(),       // compose input (agent slugs/objects)
  agent_slugs: z.array(z.string()).optional(),   // the file shape (resolved to agents on load)
  phases: z.array(PhaseSchema),
  eval_slugs: z.array(z.string()).readonly().optional(),
  input_types: z.array(z.string()).readonly().optional(),
  output_types: z.array(z.string()).readonly().optional(),
  // ENFORCED (#194): the runtime reads this K-cap. When a VERIFY chair seals a failing verdict
  // (pass === false), runGig re-runs the maker(s) it judged with the verdict fed back and
  // re-verifies, up to this many rounds, stopping the instant the verdict passes — and never
  // laundering a red verdict green when the rounds are spent. See the EXAMINE⇄AMEND block in
  // runtime.ts; the contract is tests/examine_amend_loop.test.ts.
  max_examine_rounds: z.number().optional(),
  description: z.string().optional(),
});
export type StandardInput = z.input<typeof StandardSchema>;
export type StandardOutput = z.output<typeof StandardSchema>;

// ── Eval — retire the {slug;[k]:unknown} bag; the loader validates eval files against this. ──
export const EvalSchema = z.object({
  slug: z.string(),
  domain: z.string().optional(),
  on_type: z.string().optional(),
  non_empty_fields: z.array(z.string()).optional(),
  // free-text description of the assertion the eval encodes (the runtime scores via on_type +
  // non_empty_fields; `asserts` is the human-readable intent, not a machine list).
  asserts: z.string().optional(),
});

// ── DomainType — the ONE source for the persisted type record. The loader's DomainTypeRecord and
//    the registry's working projection both derive from this (no more three near-duplicate defs),
//    and type_register's MCP surface is generated from it. version/status default (every on-disk
//    file carries version:1 + status:"active"), so z.output has them present — the loader keys on
//    `slug@version` and reads status — while z.input leaves them optional for the register op. ──
export const DomainTypeSchema = z.object({
  slug: z.string(),
  version: z.number().default(1),
  extends: z.string(),
  domain: z.string(),
  status: DomainTypeStatusSchema.default("active"),
  description: z.string().optional(),
  schema: z.record(z.unknown()),
  required_fields: z.array(z.string()).default([]),
});

export type SkillOutput = z.output<typeof SkillSchema>;
export type HydrationSlot = z.output<typeof HydrationSlotSchema>;
export type EvalOutput = z.output<typeof EvalSchema>;
export type DomainTypeOutput = z.output<typeof DomainTypeSchema>;

// ── The institutional layer — institutions, organizations, agents-as-members, chairs, seats,
//    lineage, keys. The DEFINITIONS live here (public structure, one Zod source); the INSTANCES
//    (a real institution's orgs, named agents, issued keys) live in a governed instance store and
//    are written only through the MCP surface. Same discipline as every class above: the same
//    concepts had grown three disagreeing representations (engine files, hand-shaped instance
//    tables, empty carryover tables); this is the one source they all derive from.
//
//    An agent RECORD is membership/identity — who exists in the organization, human and model on
//    the SAME contract — distinct from the performer profile (AgentSchema above), which is what a
//    seat renders when the agent plays. A human record links to its auth account; a model record
//    simply has no auth account. Chairs carry the configuration (role, function, mission,
//    required_skills, caps, obligations); agents are the few named players who swap into them. ──

/** The typed lineage-edge vocabulary. Caps grant these; lineage edges are made of them. */
export const LineageEdgeTypeSchema = z.enum(["anchored-in", "produced-by", "evolved-from", "descends-from"]);

/** A reference from an institution to a published lineage-record that grounds it. The record
 *  itself is sealed content-addressed in the ledger; the institution carries the REFERENCE, so an
 *  APPROVED lineage (the lineage-pass standard's `approve` chair sealed a passing lineage-verdict)
 *  becomes first-class institutional grounding — see `institutionLineageGrounding` below. `record_ref`
 *  is the only non-optional field: a lineage reference that names no record references nothing.
 *  Store-side home is `coltrane_institution_lineage` (follow-up; not built here). */
export const LineageRecordRefSchema = z.object({
  /** content_sha (or slug) of the sealed lineage-record this institution is grounded in. */
  record_ref: z.string(),
  /** the lineage-question the record answered, for display without dereferencing the record. */
  question: z.string().optional(),
  /** the human seal: filled from the approve chair's verdict when the lineage is adopted. Null
   *  until then — an institution never grounds itself on an unapproved lineage. */
  approved_by: z.string().nullable().default(null),
  sealed_at: z.string().optional(),
});
export type LineageRecordRefOutput = z.output<typeof LineageRecordRefSchema>;

/** A CITATION of external published work, shaped so it can be checked rather than admired.
 *
 *  The genome had no way to say "this schema class implements that paper." `ForebearSchema` is
 *  person-shaped (it carries a working disposition taken from a named figure, not a bibliographic
 *  record) and `LineageEdgeSchema.source` is `z.record(z.unknown())`, so a presence check on it
 *  passes on `{}`. The gate in `default_genome_quartet.test.ts` already states the bar — "an
 *  uncited attribution is a claim, not a record" — but had no shape able to enforce it.
 *
 *  The refinement below is the citation's analogue of `InstitutionalLawCheckSchema`: an
 *  institutional law is authorable only if it reduces to an evaluable predicate over typed inputs,
 *  and a citation stands only if it reduces to a resolvable identifier. Prose that cannot be
 *  checked does not get to be a record — same refusal, same grounds, both enforced at authorship.
 *
 *  `evidence_grade` types the distinction the diplomatics tradition draws and this codebase had
 *  only ever narrated: ARCHIVE — the primary was fetched, and `retrieved_at` says when — versus
 *  ATTESTATION — someone declared it. The grade is recorded and never laundered upward. */
export const CitationSchema = z
  .object({
    /** Author names as cited, e.g. "Crawford, S.E.S.". At least one — an anonymous citation is a rumour. */
    authors: z.array(z.string()).min(1),
    year: z.number().int(),
    title: z.string(),
    /** Journal, publisher, or conference. */
    venue: z.string(),
    /** Volume/issue/pages or equivalent, e.g. "89(3): 582–600". */
    locator: z.string().optional(),
    doi: z.string().optional(),
    url: z.string().optional(),
    /** ARCHIVE = the primary was fetched. ATTESTATION = it was declared. Never laundered upward. */
    evidence_grade: z.enum(["archive", "attestation"]),
    /** When the primary was fetched. An archive-grade claim is a claim about a fetch that happened. */
    retrieved_at: z.string().optional(),
  })
  .strict()
  .refine((c) => Boolean(c.doi ?? c.url), {
    message: "a citation with no resolvable identifier (doi or url) is prose, not a citation",
  });

/** How a genome schema class stands to the published work behind it.
 *
 *  Deliberately NOT `LineageEdgeTypeSchema`. That enum is the CAPABILITY vocabulary — "Caps grant
 *  these" — and widening it to fit scholarship would widen what a capability grant can scope. The
 *  two are different acts: `anchored-in` says nothing about a paper, `diverges-from` says nothing
 *  as a permission. This enum mirrors the `lineage-map` domain type's relations exactly, so a
 *  lineage pass's connection becomes an attribution with no translation step and no finding that
 *  the genome cannot write down.
 *
 *  `diverges-from` is load-bearing, not decorative: this codebase HAS a deliberate divergence
 *  (chair obligations are stated and never verified, against Fuller's congruence principle), and a
 *  vocabulary that can only express descent would force that either into silence or into a false
 *  claim of alignment. */
export const AttributionRelationSchema = z.enum([
  "descends-from",
  "aligns-with",
  "diverges-from",
  "supersedes",
  "informed-by",
]);

/** Binds one genome schema class to the published work behind it. `what_taken` keeps
 *  `ForebearSchema`'s word: an attribution names what was taken, not merely what was read. */
export const SchemaAttributionSchema = z
  .object({
    /** The attributed schema class, by its exported name, e.g. "InstitutionalLawSchema". */
    subject: z.string(),
    relation: AttributionRelationSchema,
    what_taken: z.string(),
    citation: CitationSchema,
  })
  .strict();
export type AttributionRelation = z.output<typeof AttributionRelationSchema>;
export type CitationOutput = z.output<typeof CitationSchema>;
export type SchemaAttributionOutput = z.output<typeof SchemaAttributionSchema>;

/** An institutional LAW as an invocable, machine-checkable contract rather than prose.
 *
 *  Descends from Crawford, S.E.S. & Ostrom, E. (1995), "A Grammar of Institutions," American
 *  Political Science Review 89(3): 582–600, doi:10.2307/2082975 — the ADICO grammar: Attributes
 *  (who it binds), Deontic (permitted | obliged | forbidden), aIm (the action or state governed),
 *  Conditions (when it applies), Or-else (the consequence on breach). Or-else is the slot that
 *  separates a RULE (ADICO) from a norm (ADIC) and a strategy (AIC), which is why it is required
 *  here: a statement with no consequence on breach is not a law in this genome. The formal
 *  attribution is carried as data in GENOME_ATTRIBUTIONS below, not only in this comment.
 *  `check` is the machine-checkable surface: a normalized, serializable predicate an evaluator can
 *  invoke plus the typed inputs it reads (design-by-contract). The evaluator that RUNS the
 *  predicate is a follow-on; this is the shape it consumes. STRICT: an ADICO record with an unknown
 *  field fails to parse. Each law carries its OWN `content_hash` (over its canonical ADICO
 *  content), which canonical_form.ts already lists in EXCLUDED_FIELDS, so a law never moves the
 *  institution's structural genome_hash — laws are hashed as content, not folded into structure. */
export const DeonticSchema = z.enum(["permitted", "obliged", "forbidden"]);
export const InstitutionalLawCheckSchema = z
  .object({
    /** A normalized, serializable predicate (e.g. an s-expression) an evaluator invokes. */
    predicate: z.string(),
    /** The typed inputs the predicate reads: input name → its type name. */
    inputs: z.record(z.string()),
  })
  .strict();
export const InstitutionalLawSchema = z
  .object({
    attributes: z.string(),
    deontic: DeonticSchema,
    aim: z.string(),
    conditions: z.string(),
    or_else: z.string(),
    check: InstitutionalLawCheckSchema,
    content_hash: z.string(),
  })
  .strict();

/** A chair OBLIGATION as a deontic NORM PAIR — the deliberate structural SUBSET of ADICO the
 *  change-request specifies for obligations: who it binds (`attributes`) and the action or state
 *  governed (`aim`), with `deontic` defaulting to `obliged` (an obligation is obliged unless it
 *  says otherwise). Not the full law: conditions / or_else / check are institution-level, not a
 *  burden every chair obligation carries.
 *
 *  The pair is I/O logic's — Makinson, D. & van der Torre, L. (2000), "Input/Output Logics,"
 *  Journal of Philosophical Logic 29(4): 383–408, doi:10.1023/A:1004748624537 — which writes a norm
 *  as (a, x): body `a` the input condition (here the chair and its situation) and head `x` the
 *  deontic output, read O(x|a), "x is obligatory given a." That is why obligations can drop the
 *  law's other three slots without becoming prose: the pair is already the complete normative unit.
 *  Formal attribution in GENOME_ATTRIBUTIONS below. */
export const NormPairSchema = z
  .object({
    attributes: z.string(),
    aim: z.string(),
    deontic: DeonticSchema.default("obliged"),
  })
  .strict();
export type DeonticOperator = z.output<typeof DeonticSchema>;
export type InstitutionalLawOutput = z.output<typeof InstitutionalLawSchema>;
export type NormPairOutput = z.output<typeof NormPairSchema>;

/** Where a genome schema class implements published prior art, the attribution lives HERE as data
 *  — parseable, dereferenceable, and gradeable — rather than only as a name-drop in a comment a
 *  reader must take on faith. Both entries below were fetched from publisher/registry on the
 *  recorded date, which is what earns them `archive` rather than `attestation`.
 *
 *  Additive and read-only: nothing in dispatch or hashing consumes this, so an entry here moves no
 *  genome_hash. It is a record of descent, held to the same bar as any other record in this repo. */
export const GENOME_ATTRIBUTIONS: readonly SchemaAttributionOutput[] = [
  {
    subject: "InstitutionalLawSchema",
    relation: "descends-from",
    what_taken:
      "The five-slot ADICO grammar — Attributes / Deontic / aIm / Conditions / Or-else — as the " +
      "decomposition an institutional statement must survive to be authorable, and the source's " +
      "own rule/norm/strategy distinction, which is why Or-else is a required field rather than an " +
      "optional one: a statement carrying no consequence on breach is not a rule.",
    citation: {
      authors: ["Crawford, S.E.S.", "Ostrom, E."],
      year: 1995,
      title: "A Grammar of Institutions",
      venue: "American Political Science Review",
      locator: "89(3): 582–600",
      doi: "10.2307/2082975",
      evidence_grade: "archive",
      retrieved_at: "2026-08-13",
    },
  },
  {
    subject: "DeonticSchema",
    relation: "descends-from",
    what_taken:
      "The three deontic operators themselves — permitted / obliged / forbidden — as the closed set " +
      "a normative statement's modality is drawn from. The schema is an enum rather than a free " +
      "string because the source treats these as an exhaustive modal vocabulary, not a sample of one.",
    citation: {
      authors: ["von Wright, G.H."],
      year: 1951,
      title: "Deontic Logic",
      venue: "Mind",
      locator: "LX(237): 1–15",
      doi: "10.1093/mind/LX.237.1",
      evidence_grade: "archive",
      retrieved_at: "2026-08-13",
    },
  },
  {
    subject: "InstitutionSchema",
    relation: "aligns-with",
    what_taken:
      "The rule of recognition: an institution's validity criterion is itself a rule the institution " +
      "holds, not an external fact about it. Our analogue is that a law is admitted only by parsing " +
      "against InstitutionalLawSchema — the schema IS this institution's recognition rule, and " +
      "composition is where it is applied. ALIGNS-WITH, not descends-from: the schema was not built " +
      "from the source, and the correspondence was drawn by a lineage pass reading both.",
    citation: {
      authors: ["Hart, H.L.A."],
      year: 1961,
      title: "The Concept of Law",
      venue: "Oxford University Press",
      url: "https://archive.org/details/conceptoflaw0000hart",
      evidence_grade: "archive",
      retrieved_at: "2026-08-13",
    },
  },
  {
    subject: "InstitutionalChairSchema",
    relation: "diverges-from",
    what_taken:
      "The congruence principle — that official action must match declared rule, and that persistent " +
      "mismatch is a defect in legality itself. We diverge KNOWINGLY: a chair's `obligations` are " +
      "stated and `composeStandard` verifies none of them, and `preferred_skills` is soft down to its " +
      "names. This entry exists so the divergence is recorded rather than discovered. Enforcing chair " +
      "obligations would change the institution's design and must be an explicit decision, not a " +
      "tidy-up. Sealed as such by lineage-record 03cacf6a.",
    citation: {
      authors: ["Fuller, L.L."],
      year: 1964,
      title: "The Morality of Law",
      venue: "Yale University Press",
      url: "https://archive.org/details/moralityoflaw0000full",
      evidence_grade: "archive",
      retrieved_at: "2026-08-13",
    },
  },
  {
    subject: "InstitutionalChairSchema.caps",
    relation: "aligns-with",
    what_taken:
      "The three-element model — formal rules, informal constraints, and the ENFORCEMENT " +
      "CHARACTERISTICS that decide whether either means anything. The third element is the one our " +
      "layer operationalizes: caps resolve to providers at dispatch and a dead name fails closed, " +
      "which is enforcement moved to the earliest moment rather than left to after-the-fact review.",
    citation: {
      authors: ["North, D.C."],
      year: 1990,
      title: "Institutions, Institutional Change and Economic Performance",
      venue: "Cambridge University Press",
      doi: "10.1017/CBO9780511808678",
      evidence_grade: "archive",
      retrieved_at: "2026-08-13",
    },
  },
  {
    subject: "NormPairSchema",
    relation: "descends-from",
    what_taken:
      "The norm as a pair (a, x) — input condition and deontic output, read O(x|a) — which is the " +
      "warrant for a chair obligation being a complete normative unit while carrying only " +
      "`attributes` and `aim`, rather than a law with three slots missing.",
    citation: {
      authors: ["Makinson, D.", "van der Torre, L."],
      year: 2000,
      title: "Input/Output Logics",
      venue: "Journal of Philosophical Logic",
      locator: "29(4): 383–408",
      doi: "10.1023/A:1004748624537",
      evidence_grade: "archive",
      retrieved_at: "2026-08-13",
    },
  },
];

// Slugs NAME identities; LOOKUPS go by id. The instance store assigns each institutional
// identity a stable uuid; references and RLS key on the id, never the slug.
export const InstitutionSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  name: z.string(),
  kind: z.enum(["institution", "personal"]),
  laws: z.array(InstitutionalLawSchema).default([]),
  wiki_space: z.string().optional(),
  sovereign: z.boolean().default(false),
  /** First-class lineage: references to approved lineage-records that ground this institution.
   *  Additive and defaulted, so an institution declared without it simply has no adopted lineage
   *  yet. A record lands here only after the lineage-pass `approve` chair seals it; every agent
   *  seated in the institution then inherits these as formal grounding (see the surfacing seam in
   *  `institutionLineageGrounding`). */
  lineage: z.array(LineageRecordRefSchema).default([]),
});

export const OrganizationSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  name: z.string(),
  charter: z.string().nullable().default(null),
  address: z.string().optional(),
  parent_org: z.string().nullable().default(null),
});

/** Membership/identity record: human and model agents on the SAME contract. */
export const AgentRecordSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  name: z.string(),
  kind: z.enum(["human", "steve"]),
  is_institution: z.boolean().default(false),
  skill_slugs: z.array(z.string()).default([]),
  // Lifecycle: nothing is active until governed so; "named" is sealed through the naming
  // ceremony (never self-approved — the proposal routes to the human governor).
  status: z.enum(["proposed", "named", "active", "retired"]).default("proposed"),
  named_from_forebear: z.string().nullable().default(null),
  // The auth link for human agents (the org's identity provider user id). A model agent
  // has no auth account; its authority is always a delegated, attenuated grant.
  auth_user_id: z.string().nullable().default(null),
});

export const OrgMemberSchema = z.object({ org_slug: z.string(), agent_slug: z.string() });
export const OrgInstitutionSchema = z.object({ org_slug: z.string(), institution_slug: z.string() });

/** A capability grant: a typed lineage-edge scope, optionally expiring. The grant IS the policy. */
export const EdgeCapGrantSchema = z.object({
  edge_type: LineageEdgeTypeSchema,
  scope: z.record(z.unknown()),
  expires: z.string().nullable().default(null),
});

/** The chair-contract dispatch grant — the office names which standards its incumbent may
 *  run. Authority sits on the chair; a credential presented by the incumbent may only
 *  narrow it, never widen it. (This is the shape the store's authorization function reads:
 *  a flat cap, not a scope smuggled inside a lineage edge.) */
export const DispatchCapGrantSchema = z.object({
  grant: z.literal("dispatch"),
  standards: z.array(z.string()).readonly(),
  expires: z.string().nullable().default(null),
});

/** A chair cap is a lineage-edge grant or a dispatch grant. One union, one Zod source. */
export const CapGrantSchema = z.union([EdgeCapGrantSchema, DispatchCapGrantSchema]);

/** The chair is the thing: the seat's configuration, not a person. */
export const InstitutionalChairSchema = z.object({
  id: z.string().optional(),
  institution_slug: z.string(),
  role: z.string(),
  /** The human office: this chair is held by a person, never a model agent. */
  human: z.boolean().optional(),
  function: PrimitiveSchema,
  mission: z.string(),
  /** The floor: skills the office requires of whoever holds it. */
  required_skills: z.array(z.string()).default([]),
  /** The preference: technique the office would rather its incumbent hold, stated without refusing
   *  the agents who do not hold it. Same two-tier reading as the phase chair's. */
  preferred_skills: z.array(z.string()).default([]),
  /** The institution's data, delivered through the office: hydration slot name → the value that
   *  fills it. This is where institution-specific content belongs — NOT inside the carried skill,
   *  which is why the skill stays portable across institutions. */
  supplies: z.record(z.unknown()).optional(),
  caps: z.array(CapGrantSchema).default([]),
  obligations: z.array(NormPairSchema).default([]),
});

/** What a seating cited: a source and the claim read from it. Both required — a source with no
 *  claim cites nothing in particular, and a claim with no source is a recollection. */
export const TechniqueEvidenceSchema = z.object({
  source: z.string(),
  claim: z.string(),
});

/** A seat: a named agent bound into a chair for an org, witnessed.
 *
 *  Seating is a JUDGEMENT — this player, this office — and `technique_evidence` makes it a recorded
 *  one: the ledger queries, improvement reports, prior gig fingerprints or deterministic suite
 *  results the decision weighed. Optional, because a seating may be made on no evidence at all;
 *  what is not optional is the difference between the two, which is exactly what the field records. */
export const ChairAssignmentSchema = z.object({
  id: z.string().optional(),
  chair_id: z.string(),
  agent_slug: z.string(),
  org_slug: z.string(),
  contract_caps: z.array(CapGrantSchema).default([]),
  technique_evidence: z.array(TechniqueEvidenceSchema).optional(),
  witnessed_by: z.string().nullable().default(null),
});

/** Cross-institution exposure happens only by contract across the wall. */
export const ExchangeContractSchema = z.object({
  id: z.string().optional(),
  from_institution: z.string(),
  to_institution: z.string(),
  caps: z.array(CapGrantSchema).default([]),
  witnessed_by: z.string().nullable().default(null),
});

export const ForebearSchema = z.object({
  slug: z.string(),
  institution_slug: z.string(),
  name: z.string(),
  domain: z.string().optional(),
  what_taken: z.string().optional(),
  kind: z.string().optional(),
});

export const NorthstarSchema = z.object({
  slug: z.string(),
  institution_slug: z.string(),
  ordinal: z.number().optional(),
  kind: z.string().optional(),
  title: z.string(),
  statement: z.string(),
  source: z.record(z.unknown()).optional(),
  quote: z.string().optional(),
});

export const LineageEdgeSchema = z.object({
  id: z.number().optional(),
  institution_slug: z.string(),
  edge_type: LineageEdgeTypeSchema,
  from_node: z.string(),
  to_node: z.string(),
  kind: z.string().optional(),
  source: z.record(z.unknown()).optional(),
});

/** The issued org service key DOCUMENT — self-describing (key id, org scope, issuer, scopes,
 *  endpoints) so downstream images have a uniform understanding of what they hold. STRICT by
 *  construction: the secret has no field to live in, so a record carrying key material fails to
 *  parse. Org-scoped because the organization is the resource-usage boundary. Never a platform
 *  service_role. */
export const OrgServiceKeySchema = z
  .object({
    key_id: z.string(),
    org_slug: z.string(),
    issuer: z.string(),
    scopes: z.array(z.string()).default([]),
    endpoints: z.record(z.string()).optional(),
    issued_at: z.string().optional(),
    expires: z.string().nullable().default(null),
    status: z.enum(["active", "revoked"]).default("active"),
  })
  .strict();

export type InstitutionOutput = z.output<typeof InstitutionSchema>;

/** The institution-lineage SURFACING SEAM. When a seat renders a player into a Claude Code
 *  subagent (`src/player_to_claude_code.ts`, the seat→prompt transform), the institution's approved
 *  lineage-records are read through here and folded into the agent's formal grounding — the same
 *  seam a future institutional-northstars / forebears surface would use. Today it returns the refs
 *  themselves (the institution definition carries them); the STORE-BACKED path (dereferencing each
 *  `record_ref` to its sealed lineage-record via `coltrane_institution_lineage`) is the follow-up
 *  the instance layer fills. Named here, additively, so the seam has one home rather than being
 *  reinvented at the render call site. */
export function institutionLineageGrounding(inst: InstitutionOutput): readonly LineageRecordRefOutput[] {
  return inst.lineage;
}
export type OrganizationOutput = z.output<typeof OrganizationSchema>;
export type AgentRecordOutput = z.output<typeof AgentRecordSchema>;
export type CapGrant = z.output<typeof CapGrantSchema>;
export type InstitutionalChairOutput = z.output<typeof InstitutionalChairSchema>;
export type ChairAssignmentOutput = z.output<typeof ChairAssignmentSchema>;
export type TechniqueEvidence = z.output<typeof TechniqueEvidenceSchema>;
export type ExchangeContractOutput = z.output<typeof ExchangeContractSchema>;
export type ForebearOutput = z.output<typeof ForebearSchema>;
export type NorthstarOutput = z.output<typeof NorthstarSchema>;
export type LineageEdgeOutput = z.output<typeof LineageEdgeSchema>;
export type OrgServiceKeyOutput = z.output<typeof OrgServiceKeySchema>;

// ── Chart — the ARRANGEMENT: one gig as a performance of many standards ───────────────────────
//
// A standard is a phase graph over chairs. A CHART is the same idea one level up: a typed DAG
// over STANDARDS. Each MOVEMENT names a standard; each EDGE asserts that a type SEALED by the
// source movement seeds an entry chair of the sink movement (the entry-chair-seed rule, promoted);
// each APPROVAL GATE is a human seat at the arrangement level, keyed by `gate_id` so it cannot
// collide with a within-movement human chair that happens to share a role name; the BUDGET
// ENVELOPE bounds the whole performance rather than one movement of it.
//
// The single-standard gig is the DEGENERATE chart: one movement, no edges, no gates, whose
// `chart_hash` short-circuits byte-for-byte to `genomeHash` of that standard (src/chart.ts), so an
// existing run's `run_fingerprint` does not move. `venue` is deliberately opaque here — its
// infrastructure meaning belongs to the runtime layer, and speculating it into the schema would
// bind a decision this shape does not need.
//
// Nothing else in this file changes: every cross-reference below is a slug by `z.string()`, never
// a Zod ref, so a chart names standards and agents without the chart schema depending on theirs.

/** One typed edge: a type the source movement seals, consumed by the sink movement's entry chairs. */
export const ChartEdgeSchema = z
  .object({
    from_movement: z.string(),
    to_movement: z.string(),
    output_type: z.string(),
    /** true = a CONDITIONAL edge: the type lives only in a terminal chair's `optional_outputs`,
     *  so the flow may legitimately carry nothing. Compose classifies it; it cannot prove the
     *  optional output will be produced, which is why a conditional edge never satisfies a
     *  REQUIRED entry slot (src/chart.ts R6/R7). */
    optional: z.boolean().default(false),
  })
  .strict();

/** Who plays which chair for this movement — a recorded act, optionally with its evidence. */
export const ChartSeatingSchema = z
  .object({
    chair: z.string(),
    agent_slug: z.string(),
    technique_evidence: z.array(TechniqueEvidenceSchema).optional(),
  })
  .strict();

/** One movement: a standard, its gig-bound hydration arguments, and its seatings.
 *
 *  `movement_id` — NOT `standard_slug` — is the identity everything keys on: the checkpoint
 *  namespace, the reuse-cache namespace, the edge endpoints. That is what lets one standard
 *  appear twice in a chart without the two instances sharing cached results. */
export const ChartMovementSchema = z
  .object({
    movement_id: z.string(),
    standard_slug: z.string(),
    runtime_fills: z.record(z.string(), z.unknown()).default({}),
    seatings: z.array(ChartSeatingSchema).default([]),
  })
  .strict();

/** A human seat between movements. Parks on `deps.approvals[gate_id]`. */
export const ChartApprovalGateSchema = z
  .object({
    gate_id: z.string(),
    after_movement: z.string(),
    before_movement: z.string(),
    chair: z.string(),
    prompt: z.string().optional(),
  })
  .strict();

/** The ceiling for the whole performance, in real money. */
export const ChartBudgetEnvelopeSchema = z.object({ total_usd: z.number().positive() }).strict();

export const ChartSchema = z
  .object({
    slug: z.string(),
    movements: z.array(ChartMovementSchema).min(1),
    edges: z.array(ChartEdgeSchema).default([]),
    approval_gates: z.array(ChartApprovalGateSchema).default([]),
    budget_envelope: ChartBudgetEnvelopeSchema.optional(),
    /** The VENUE this performance is held in, by slug — a `VenueSchema` in the genome (below).
     *
     *  A slug, never an inline room: the venue is an institution-level object shared by whichever
     *  arrangement is fit for it, so it is named here and defined once there. A slug that resolves
     *  to no venue is a dead name and `composeChart` refuses the chart (R10), exactly as an
     *  unresolvable tool grant refuses a dispatch.
     *
     *  Deliberately NOT folded into `chart_hash`: a room is environment, not structure. Two runs of
     *  the same arrangement in differently-configured rooms share an arrangement identity; what
     *  distinguishes them belongs to the run's own record, not the chart's. */
    venue: z.string().optional(),
  })
  .strict();

export type ChartInput = z.input<typeof ChartSchema>;
export type ChartOutput = z.output<typeof ChartSchema>;
export type ChartMovementOutput = z.output<typeof ChartMovementSchema>;
export type ChartEdgeOutput = z.output<typeof ChartEdgeSchema>;
export type ChartApprovalGateOutput = z.output<typeof ChartApprovalGateSchema>;
export type ChartSeatingOutput = z.output<typeof ChartSeatingSchema>;

// ── Venue — the institution's configured performance space ────────────────────────────────────
//
// A venue states what EXISTS to be acted with when a gig runs: which tools resolve, which doors
// open inward and outward, what is installed, and which classes of credential may legitimately be
// present. It is an institution-level object (one institution owns it; an institution may operate
// several) and it is a CEILING, never a grant: the authority a seated agent actually holds is its
// own `allowed_tools` INTERSECTED with `equipment.tools`, so a room can only ever narrow a player.
// `composeChart` enforces that where a chart names a venue (src/chart.ts R10).
//
// The contract is deliberately a narrow waist. Nothing here is a harness escape hatch — no image
// reference, no command string, no provisioning block — because a field that can express arbitrary
// harness behaviour destroys the separation between what is declared and what realizes it. What
// this shape covers is the STATICALLY CHECKABLE half of the design: the fields an engine can
// enforce before anything runs. Realization (building the room from the contract) and verification
// by behavioural probe are a lower layer and are not modelled here.
//
// Two asymmetries are load-bearing and stated in the shape rather than in prose:
//   - `doors` separates ingress from egress, because what may reach the room and what may leave it
//     are different questions with different threat models.
//   - `installs` carries DIGESTS, not version ranges: an unpinned install names a family of rooms,
//     which would make a room's identity meaningless.

/** The room's equipment: a deny-by-default allowlist of tool grants, in the same vocabulary as an
 *  agent's `allowed_tools`. A venue with no tools holds nothing — not "read-only tools", nothing. */
export const VenueEquipmentSchema = z
  .object({
    tools: z.array(z.string()).default([]),
  })
  .strict();

/** A host allowlist per direction. Deny-by-default: absent doors reach nothing and are reached by
 *  nothing. `*` is refused — a wildcard door is not a door, it is the absence of one. */
const HostSchema = z
  .string()
  .refine((h) => h.trim() !== "*", { message: `a door names hosts, never "*" — a wildcard door is not a door` });
export const VenueDoorsSchema = z
  .object({
    ingress: z.array(HostSchema).default([]),
    egress: z.array(HostSchema).default([]),
  })
  .strict();

/** Lifecycle. Ephemeral is the default: the contract is the durable object and the realization is
 *  disposable, because everything a standing room accumulates — drift, residue from prior gigs,
 *  standing credentials, warm state — is exactly the class of thing no output's `input_shas` can
 *  cover. `standing` is permitted as a named exception and owes a rebuild cadence (venueDefect). */
export const VenueLifecycleSchema = z
  .object({
    policy: z.enum(["ephemeral", "standing"]).default("ephemeral"),
    /** ISO-8601 duration or cron-shaped cadence — read by the responsible office, not the engine. */
    rebuild_cadence: z.string().optional(),
  })
  .strict();

/** An install must carry the digest of what will actually be present. */
const InstallPinSchema = z.string().regex(
  /sha256:[0-9a-f]{64}/,
  "an install must be digest-pinned (…sha256:<64 hex>): a version range names a family of rooms, not one room, so an unpinned install makes the venue's identity meaningless",
);

export const VenueSchema = z
  .object({
    slug: z.string(),
    /** Exactly one owning institution. The institution is the duty holder; the office below is the
     *  appointed accountable individual. */
    institution_slug: z.string(),
    /** Why this room is shaped the way it is — read at review, never at runtime. */
    description: z.string().optional(),
    /** The base kind of room (e.g. "ingest-empty", "code-work"). A label for humans and for
     *  "which room does this work want", not a resolvable reference. */
    flavor: z.string().optional(),
    /** Defaulted, not required, and the default is the EMPTY room. Every access-shaped field here
     *  leans the same way: absent doors reach nothing, absent installs install nothing, an absent
     *  credential surface permits nothing. A venue that forgot to state its equipment must hold
     *  nothing rather than hold whatever the reader assumed — and both doors into this class (the
     *  loader and venue_define) get that from the one schema rather than from two agreeing habits. */
    equipment: VenueEquipmentSchema.default({}),
    doors: VenueDoorsSchema.optional(),
    /** Digest-pinned software the room contains. */
    installs: z.array(InstallPinSchema).default([]),
    /** Which CLASSES of credential may legitimately be present, by name. Never material, and never
     *  a field material could occupy: a room that declares nothing here is a room where finding a
     *  credential is a breach rather than a configuration difference. */
    credential_surface: z.array(z.string()).default([]),
    lifecycle: VenueLifecycleSchema.default({}),
    /** The accountable office: an institutional chair id (the office, not its incumbent). One named
     *  duty-holder answers for the room and for what it permits. */
    responsible_chair: z.string().optional(),
  })
  .strict();

export type VenueInput = z.input<typeof VenueSchema>;
export type VenueOutput = z.output<typeof VenueSchema>;

/**
 * Cross-field venue rules — the ones a single field cannot state.
 *
 * A separate function rather than a `.superRefine`, on purpose and by the existing idiom
 * (`domainTypeDefect` in src/registry.ts): the MCP write-surface is generated from
 * `zodToMcpProps(VenueSchema)`, which needs a plain `ZodObject` with a `.shape`, and a refined
 * schema is a `ZodEffects` that has neither. So both doors — the loader and `venue_define` — call
 * `VenueSchema.safeParse` and then this, and a rule enforced at one door is enforced at both.
 *
 * Returns the teaching message, or null when the venue is sound.
 */
export function venueDefect(venue: VenueOutput): string | null {
  if (venue.lifecycle.policy === "standing" && !venue.lifecycle.rebuild_cadence?.trim()) {
    return (
      `venue "${venue.slug}" is standing with no lifecycle.rebuild_cadence — that is a snowflake, not a venue. ` +
      `A standing room accumulates drift, residue from prior gigs and warm state that no output's input_shas can cover, ` +
      `so a standing exception owes a rebuild cadence: a phoenix on a slower clock. State one, or make it ephemeral.`
    );
  }
  return null;
}

// ── zod → MCP input_schema properties. The MCP tool definitions (mcp.ts) derive their hand-written
//    field lists from here, so the write-surface can never drift from the schema. Maps each top-level
//    field to its coarse JSON type; optionals/defaults are flattened (MCP advertises the field). ──
type JsonType = "string" | "number" | "boolean" | "array" | "object";
function jsonTypeOf(schema: z.ZodTypeAny): JsonType {
  let s: z.ZodTypeAny = schema;
  // Unwrap the WRAPPER types (optional/default/nullable/readonly via `innerType`, effects via
  // `schema`) to the inner type. Deliberately NOT `_def.type`: on a ZodArray that key holds the
  // ELEMENT schema, so following it would descend into the array and report the element's scalar
  // type — the bug that advertised `primitives: z.array(enum)` as "string" and broke agent_define.
  // Bound is a deliberate safety cap, not a real limit: the genome's deepest field nests ~3 wrappers
  // (e.g. `.array().readonly().optional()`), so 10 is unreachable in practice — it exists only so a
  // future pathological/cyclic schema can't spin here. Raise it if a real field ever approaches it.
  for (let i = 0; i < 10; i++) {
    const def = (s as { _def?: { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny } })._def;
    const inner = def?.innerType ?? def?.schema;
    if (inner && inner instanceof z.ZodType) { s = inner; continue; }
    break;
  }
  if (s instanceof z.ZodString || s instanceof z.ZodEnum) return "string";
  if (s instanceof z.ZodNumber) return "number";
  if (s instanceof z.ZodBoolean) return "boolean";
  if (s instanceof z.ZodArray || s instanceof z.ZodTuple) return "array";
  return "object";
}

/** The MCP `properties` map (field → JSON type) for a genome class schema. */
export function zodToMcpProps(schema: z.ZodObject<z.ZodRawShape>): Record<string, JsonType> {
  return Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, jsonTypeOf(v as z.ZodTypeAny)]));
}
