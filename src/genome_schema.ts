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
export const AgentObjectSchema = z.object({
  slug: z.string(),
  primitives: z.array(PrimitiveSchema).readonly(),
  input_types: z.array(z.string()).readonly().default([]),
  /** The inputs this agent CANNOT WORK WITHOUT in ANY placement — the per-agent MANDATE that
   *  `input_types` (the capability ENVELOPE: what the agent CAN consume across all roles) cannot
   *  express. `composeStandard` refuses a chair whose `input_contract` omits any of these, because
   *  that placement would run the agent's method against an input that never arrives. Every entry
   *  MUST also appear in `input_types` — an agent cannot REQUIRE an input outside its own envelope;
   *  the cross-field rule on `AgentSchema` (the `.superRefine` below) enforces that at PARSE.
   *
   *  OPTIONAL with NO default — deliberately, exactly like `turn_budget`/`tier`. A `.default([])`
   *  would make the field non-optional on the `Agent` output type (breaking hand-rolled `Agent`
   *  literals such as `tests/genome_write_roundtrip.test.ts`'s `sensor`) and would ADD
   *  `required_inputs: []` to every existing agent on write-back, breaking byte-equivalent round-trip.
   *  Absent stays absent; a Zod object drops an undeclared key, so the field must be declared HERE to
   *  be retained. */
  required_inputs: z.array(z.string()).readonly().optional(),
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

/**
 * The agent AUTHORING/parse surface: the plain `AgentObjectSchema` plus the one cross-field rule a
 * single field cannot state — every `required_inputs` entry must also be an `input_types` entry.
 *
 * Mirrors the `VenueSchema` / `VenueObjectSchema` split below. The inner `AgentObjectSchema` is a
 * plain `ZodObject`, so it retains `.shape` — which `zodToMcpProps(AgentObjectSchema)` (the advertised
 * MCP surface) and `Object.keys(AgentObjectSchema.shape)` (server.ts's hosted-write key list) both
 * need. `AgentSchema` wraps it in a `.superRefine`, a `ZodEffects` that has NEITHER — so those two
 * consumers read the inner object while every `.parse`/`.safeParse` caller (`defineAgent`, the loader)
 * gets the cross-field rule for free. An agent that requires an input outside its own capability
 * envelope is MALFORMED, not merely un-composable, so it is refused at PARSE — earlier and closer to
 * the author than the compose-time chair refusal, which is a different question (does THIS placement
 * supply it?).
 */
export const AgentSchema = AgentObjectSchema.superRefine((agent, ctx) => {
  const envelope = new Set(agent.input_types ?? []);
  for (const req of agent.required_inputs ?? []) {
    if (envelope.has(req)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["required_inputs"],
      message:
        `required_inputs entry "${req}" is not in input_types [${(agent.input_types ?? []).join(", ")}] — ` +
        `an agent cannot REQUIRE an input outside its capability envelope. Add "${req}" to input_types, ` +
        `or drop it from required_inputs.`,
    });
  }
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
  /** The guaranteed turn floor, declared on the WORK (the chair) rather than the player (the
   *  agent's `max_tool_calls`). Resolves chair > agent > engine default at invocation. OPTIONAL
   *  so every existing chair record parses byte-equivalent — a Zod object DROPS an undeclared key,
   *  so the field must be declared here to be RETAINED. A non-negative INTEGER: a negative or
   *  non-integer cap fails closed at load, never reaching resolution. 0 is a deliberate hard floor,
   *  parsed as 0 and kept DISTINCT from absent (which falls through to the agent tier). */
  turn_budget: z.number().int().nonnegative().optional(),
  /** The per-chair elasticity ceiling on the shared per-gig reserve pool: the most this chair may
   *  ever draw when it exhausts its budget — no theft even when the pool is larger. Same additive,
   *  fail-closed, integer discipline as `turn_budget`. May be declared WITHOUT `turn_budget`: the
   *  budget then falls through the resolution tiers while the reserve still bounds the draw. */
  turn_reserve: z.number().int().nonnegative().optional(),
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
  /** The DEFAULT gig-level reserve pool: a per-gig quantity of turns a budget-exhausted chair may
   *  draw from, capped per chair by its own `turn_reserve`. The DISPATCH payload's `pool` (on the
   *  budget input) is the primary source and OVERRIDES this default deterministically when both are
   *  present (no max, no sum). Optional + non-negative integer, additive like the chair fields. */
  reserve_pool: z.number().int().nonnegative().optional(),
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
  })
  // ARCHIVE is a claim about a fetch that happened, so it must carry the evidence of that fetch.
  // Until now `retrieved_at` was `.optional()` with no tie to the grade and no bound on its value,
  // so `{archive}` with no timestamp parsed and `{archive, retrieved_at:"2099-01-01"}` parsed — a
  // fetch dated 75 years out was a valid archive claim. This closes the illegal state for EVERY
  // CitationSchema caller (not only the GENOME_ATTRIBUTIONS rows one test loops over): an archive
  // citation MUST name when it was fetched, and that time cannot be in the future. ATTESTATION
  // claims no fetch and is untouched — it may carry no `retrieved_at`.
  .superRefine((c, ctx) => {
    if (c.evidence_grade !== "archive") return;
    if (c.retrieved_at === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retrieved_at"],
        message:
          "an archive-grade citation claims the primary was fetched — it must record retrieved_at (when)",
      });
      return;
    }
    const fetchedAt = new Date(c.retrieved_at).getTime();
    if (Number.isNaN(fetchedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retrieved_at"],
        message: "retrieved_at is not a parseable date — an archive claim needs a real fetch time",
      });
      return;
    }
    if (fetchedAt > Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retrieved_at"],
        message: "retrieved_at is in the future — a fetch cannot have happened later than now",
      });
    }
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
    /** ADDITIVE, OPTIONAL obligation-tier mark. An obligation states whether it is a stated norm or
     *  a verified rule: "declared" says there is no runtime verifier, "enforced" claims a verifier
     *  backs it. ABSENT-parses-fine, so every pre-existing file round-trips byte-equivalent (a Zod
     *  object drops an undeclared key, so the field must be declared HERE to be retained). The
     *  admissibility check (checkInstitutionAdmissibility in institution_enforcement.ts) refuses an
     *  UNMARKED obligation — the marking is how a document states its enforced/declared split
     *  rather than leaving silence to pass a norm off as a rule. */
    tier: z.enum(["declared", "enforced"]).optional(),
  })
  .strict();
export type DeonticOperator = z.output<typeof DeonticSchema>;
export type InstitutionalLawOutput = z.output<typeof InstitutionalLawSchema>;
export type NormPairOutput = z.output<typeof NormPairSchema>;

/** A BEARING-LAW: sealable canon, not an executable standard.
 *
 *  An org genome's standards/ may hold documents of kind "bearing-law" — the ADICO record of an
 *  obligation a LEGAL PERSON bears (an executed SAFE portfolio, a payment note, a delivery SOW),
 *  researched against real instruments and destined for Nomos's seal. They carry NO phases, seat
 *  no agents, and must never become dispatchable; the loader admits them here instead of feeding
 *  them to composeStandard (where a missing phase graph is a defect, not a document kind).
 *
 *  The `law` is the full five-slot ADICO grammar (InstitutionalLawSchema) with ONE deliberate
 *  relaxation: `content_hash` is optional — a bearing-law is lawfully PRE-sealing ("Nomos seals",
 *  org-genome-design.md §3), so the hash the institution's laws must already carry may be absent
 *  here. canonical_form.ts excludes `content_hash` from hashing either way, so sealing identity
 *  is unmoved by its presence or absence.
 *
 *  Top level is deliberately NON-strict: `instrument` and `provenance` are evidentiary prose
 *  objects whose interior shape belongs to the record, not the engine, and fields like `flags` /
 *  `unresolved` are the document being honest about its own open questions. The engine validates
 *  the load-bearing frame (identity, kind, ADICO law, source, subject, bearer) and carries the
 *  rest as content. */
export const BearingLawAdicoSchema = InstitutionalLawSchema.extend({
  content_hash: z.string().optional(),
});
export const BearingLawSchema = z.object({
  slug: z.string(),
  kind: z.literal("bearing-law"),
  domain: z.string().optional(),
  status: z.enum(["active", "deprecated", "retired"]).optional(),
  /** Where the obligation derives from (e.g. "charter"). */
  source: z.string(),
  /** The legal person that bears it, e.g. "org:eir-labs-inc". */
  subject_ref: z.string(),
  /** Prose identification of the bearer of record (and any intended assignee). */
  bearer: z.string(),
  description: z.string().optional(),
  law: BearingLawAdicoSchema,
  /** The instrument(s) evidencing the obligation — record-owned interior shape. */
  instrument: z.record(z.unknown()),
  /** Where this record came from and under what authority it was recast. */
  provenance: z.record(z.unknown()),
  flags: z.array(z.string()).optional(),
});
export type BearingLawOutput = z.output<typeof BearingLawSchema>;

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
  {
    subject: "BookingSchema",
    relation: "descends-from",
    what_taken:
      "The ENCUMBRANCE as the accounting object that sits between the appropriation ceiling and the " +
      "expenditure — a commitment that reserves declared capacity against a future outlay and is " +
      "reported against fund balance before any cash moves. A Booking IS that reservation leg: the " +
      "genome held the ceiling (ChartBudgetEnvelope) and the expenditure (GigLedgerEntry) and omitted " +
      "the encumbrance, which is the leg this schema adds. The unit discipline (a draw is per-unit, " +
      "never converted) is the fund-accounting rule that a reservation is held in the terms it was " +
      "declared in.",
    citation: {
      authors: ["Governmental Accounting Standards Board"],
      year: 2009,
      title:
        "GASB Statement No. 54: Fund Balance Reporting and Governmental Fund Type Definitions (encumbrance and fund-balance reservation)",
      venue: "Governmental Accounting Standards Board",
      locator: "Statement No. 54",
      url: "https://storage.gasb.org/GASBS%2054.pdf",
      evidence_grade: "archive",
      retrieved_at: "2026-08-13",
    },
  },
  {
    subject: "applyCommitmentOp",
    relation: "descends-from",
    what_taken:
      "The social-commitment algebra C(debtor, creditor, antecedent, consequent) and its operation " +
      "set — create, detach, discharge, cancel, delegate, assign, release — with the load-bearing " +
      "party constraints: cancel is the debtor's act and release the creditor's, and the two never " +
      "collapse into one value. applyCommitmentOp is that state machine, and the lifecycle is a " +
      "party-constrained transition function rather than a status field precisely because the source " +
      "treats who-may-act as constitutive of the commitment, not incidental to it.",
    citation: {
      authors: ["Singh, M.P.", "Chopra, A.K.", "Desai, N."],
      year: 2009,
      title: "Commitment-Based Service-Oriented Architecture",
      venue: "IEEE Computer",
      locator: "42(11): 72–79",
      doi: "10.1109/MC.2009.347",
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

/** The CLOSED set of device KINDS a room may ask a host for — a class, never a path. A contract that
 *  could name a raw device path could name the raw memory device (`/dev/mem`) or a whole block
 *  device, which is a host compromise submitted as a hardware request; the concrete nodes are the
 *  machine's business, mapped from the class at realization. Validated at the VALUE level so a path
 *  is refused by name (on `devices`), not merely as an unknown key. */
export const VenueDeviceClassSchema = z.enum(["audio", "gpio", "i2c", "serial", "spi", "video"]);
export const DEVICE_CLASSES = VenueDeviceClassSchema.options;

/** One MCP server a room stands up: a slug, a transport, the launch command, and which credential
 *  CLASSES it needs (never material). Modelled on what a room declares and deliberately NOT
 *  `.strict()`, so a future transport-specific field is an addition rather than a breaking change —
 *  the sub-schema is inferred from the contract's own shape, not a formally frozen surface. */
export const VenueMcpServerSchema = z.object({
  slug: z.string(),
  transport: z.string(),
  command: z.array(z.string()).default([]),
  /** The endpoint an over-the-wire transport (e.g. `sse`) connects to. Absent for a `stdio` server,
   *  which is reached by its `command` instead — the per-transport requirement is stated once, in the
   *  cross-field rule on `VenueSchema`, so both doors (the loader and venue_define) enforce it. */
  url: z.string().optional(),
  credential_names: z.array(z.string()).default([]),
});

export const VenueObjectSchema = z
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
    /** WHICH SUBSTRATE this room requires — a free string a deployment matches its available
     *  realizers against (e.g. "container"). A FREE string, not a closed enum: the set of substrates
     *  is a deployment fact rather than a genome one, and freezing it here would over-constrain
     *  substrates the contract has not yet named. Absent means the deployment's default — deny-by-
     *  default belongs on CAPABILITY, not on portability, so a room that names no substrate runs on
     *  whatever is supplied, the same lean an unnamed venue takes on targeting. */
    substrate: z.string().optional(),
    /** The MCP servers the room stands up. Each names credential CLASSES, never material — the same
     *  discipline `credential_surface` takes, restated at the server that consumes them. */
    mcp_servers: z.array(VenueMcpServerSchema).default([]),
    /** The device CLASSES the room needs — a kind (`serial`, `gpio`…), never a path. The machine
     *  maps a class to concrete nodes and the owning group; a contract that could name a node could
     *  name the raw memory device, so the value is pinned to the closed enumeration. */
    devices: z.array(VenueDeviceClassSchema).default([]),
    /** The architectures this room supports (e.g. `arm64`). Absent means any: portability is not
     *  capability, so an unnamed architecture is realizable on any host rather than none. */
    architectures: z.array(z.string()).default([]),
    /** A ceiling on how many chairs may realize against this room at once. Per-chair realization
     *  multiplies substrate resources by the WIDTH of a phase, and memory scales with running
     *  processes, so the bound belongs in the contract where an author sets it deliberately rather
     *  than discovering it with the first wide DAG on the first box that runs it. */
    max_concurrent_chairs: z.number().int().positive().optional(),
    /** The shared FLOOR this room composes over, so N rooms cost floor + Σ(deltas) rather than
     *  N × environment. A label two rooms share to declare they build on the same base. */
    floor: z.string().optional(),
    // NO repository field, DELIBERATELY. A venue is a room AT REST — every field above is at-rest
    // policy (the tool ceiling, the credential surface, the installs, the floor). The repository a run
    // works on is the SUBJECT of that run, and it is one-to-MANY against any given room: one venue
    // serves many repositories, so pinning a `repo_url` here would mint a venue per repository. The
    // repository is therefore named on the RUN, not the room — explicitly at dispatch (a dispatch
    // field threaded to `RunDeps.repoUrl`) or from the claim's governed `repo_url` column on the drain
    // — and the realized room's workspace is populated from THAT (through src/workspace.ts
    // `prepareWorkspace`, the same mechanism the drain uses). The legitimate worry that once lived on
    // this field — never infer the host's cwd — is preserved by making the source explicit at
    // dispatch, not by fixing it to the contract: a room's tree is a function of how the run was
    // invoked, never of an at-rest venue field or of the operator's own checkout.
  })
  .strict();

/**
 * The venue contract, with the cross-field MCP rules a single field cannot state.
 *
 * The inner `VenueObjectSchema` above is a plain `ZodObject` — it retains `.shape`, which
 * `zodToMcpProps(VenueObjectSchema)` (the advertised MCP surface) and `Object.keys(...shape)` (the
 * hosted-write key list) both need. `VenueSchema` wraps it in a `.superRefine`, which is a
 * `ZodEffects` that has NEITHER — so those two consumers read the inner object while every
 * `.parse`/`.safeParse` caller (the loader, `venue_define`, the realizer) gets the cross-field rules
 * for free. The three rules below are the ones a room could otherwise author "granted but
 * unprovided": a tool naming a server the room never declared, a transport missing the field that
 * makes it reachable, or a server needing a credential the surface does not admit. Each is refused at
 * PARSE, moving the discovery from a box nobody is watching to the author's own terminal.
 */
export const VenueSchema = VenueObjectSchema.superRefine((venue, ctx) => {
  const declaredSlugs = new Set(venue.mcp_servers.map((s) => s.slug));

  // Rule 1 — every `mcp__<slug>__<tool>` grant must name a DECLARED server. R10 checks the tool-NAME
  // intersection at compose time, a different question; nothing there says what provides the server.
  for (const tool of venue.equipment.tools) {
    const m = /^mcp__(.+?)__/.exec(tool);
    if (m && !declaredSlugs.has(m[1]!)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcp_servers"],
        message:
          `venue "${venue.slug}" grants tool "${tool}" from mcp server "${m[1]!}", which it does not declare ` +
          `in mcp_servers — a granted server with no declaration is "granted but unprovided", discovered ` +
          `at use on a box nobody is watching. Declare the "${m[1]!}" server, or drop the grant.`,
      });
    }
  }

  venue.mcp_servers.forEach((server, i) => {
    // Rule 2 — each transport owes the one field that makes it reachable: a command for stdio, a url
    // for sse. A declaration that cannot be acted on is not a declaration.
    if (server.transport === "stdio" && server.command.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcp_servers", i, "command"],
        message: `mcp server "${server.slug}" uses transport "stdio" but declares no command — a stdio server is reached by the command that launches it`,
      });
    }
    if (server.transport === "sse" && !server.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcp_servers", i, "url"],
        message: `mcp server "${server.slug}" uses transport "sse" but declares no url — an sse server is reached by the url it connects to`,
      });
    }

    // Rule 3 — every credential a server names must be a member of the room's credential_surface.
    // realize() already treats a credential class present-but-undeclared as a breach, so a server
    // needing an unlisted credential would stand up a box every room then refuses.
    for (const cred of server.credential_names) {
      if (!venue.credential_surface.includes(cred)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mcp_servers", i, "credential_names"],
          message:
            `mcp server "${server.slug}" needs credential "${cred}", which venue "${venue.slug}" does not admit ` +
            `in credential_surface — an unlisted credential is a breach, not a default. Add "${cred}" to credential_surface.`,
        });
      }
    }
  });
});

export type VenueInput = z.input<typeof VenueSchema>;
export type VenueOutput = z.output<typeof VenueSchema>;

/**
 * The one cross-field venue rule that is NOT a parse error — the lifecycle snowflake below.
 *
 * The MCP cross-field rules (a granted server must be declared, a transport owes its reachability
 * field, a credential must be in the surface) now live on `VenueSchema.superRefine`, so
 * `VenueSchema.safeParse` catches them directly; the split into `VenueObjectSchema` (which keeps the
 * `.shape` that `zodToMcpProps(VenueObjectSchema)` and `Object.keys(...shape)` need) is what let those
 * rules move onto the schema without breaking the advertised surface. This function remains for the
 * lifecycle rule, kept out of the schema so its teaching message stays a full paragraph rather than a
 * ZodIssue string; both doors — the loader and `venue_define` — call `safeParse` and then this.
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

/** The MCP `properties` map (field → JSON type) for a genome class schema.
 *
 *  Accepts either a plain `ZodObject` or a `.superRefine`/`.refine`-wrapped one (a `ZodEffects`, e.g.
 *  `AgentSchema` with its `required_inputs ⊆ input_types` rule): a cross-field-refined class has no
 *  own `.shape`, so unwrap to the inner object before reading it. This mirrors `jsonTypeOf`'s own
 *  effects-unwrapping (`_def.schema`) and lets a refined class advertise its field surface without a
 *  parallel object-schema sibling threaded to every call site. Passing the inner `…ObjectSchema`
 *  directly (as venue does) still works — the guard is a no-op on a plain object. */
export function zodToMcpProps(schema: z.ZodTypeAny): Record<string, JsonType> {
  const obj = (schema instanceof z.ZodEffects ? schema._def.schema : schema) as z.ZodObject<z.ZodRawShape>;
  return Object.fromEntries(Object.entries(obj.shape).map(([k, v]) => [k, jsonTypeOf(v as z.ZodTypeAny)]));
}

// ── The committed-work objects — Tour / Booking / Resource, the binding middle place ──────────────
//
// The strict runtime gate for src/committed_work.ts, promoted into the single Zod source per
// CLAUDE.md. committed_work.ts re-exports these four names, so the TS interfaces there and this
// gate cannot drift. REUSE, not invention: a Booking's `acceptance` is exactly
// InstitutionalLawCheckSchema (the ONE predicate form, decided by the same evaluate()); its `tier`
// is NormPairSchema's declared|enforced enum, referenced by `.shape.tier` so the vocabulary is
// declared exactly ONCE in the tree (never a second z.enum). No stake / payout / heat / witness /
// currency field appears — the sole money field is `amount`, optional (no numerator is not a
// second tier).

/** The closed commitment lifecycle state set as a Zod enum — the runtime mirror of committed_work.ts's
 *  CommitmentState union. Kept here (not imported from committed_work) so the schema source has no
 *  import cycle back onto the file that re-exports it. */
const CommitmentStateSchema = z.enum([
  "conditional",
  "active",
  "pending",
  "satisfied",
  "violated",
  "expired",
  "cancelled",
  "released",
]);
const CommitmentPartySchema = z.enum(["debtor", "creditor"]);
const CommitmentOpKindSchema = z.enum([
  "create",
  "detach",
  "discharge",
  "cancel",
  "release",
  "delegate",
  "assign",
]);

/** One append-only lifecycle log entry. A delegate carries the residual debtor it substituted out. */
const CommitmentOpEntrySchema = z
  .object({
    op: CommitmentOpKindSchema,
    by: CommitmentPartySchema.optional(),
    residual_debtor: z.string().optional(),
  })
  .strict();

/** The live commitment record: current state, its two parties, and the append-only operation log. */
const CommitmentRecordSchema = z
  .object({
    state: CommitmentStateSchema,
    debtor: z.string(),
    creditor: z.string(),
    log: z.array(CommitmentOpEntrySchema).default([]),
  })
  .strict();

/** How a Resource REFILLS, expressed in the resource's OWN unit — a monthly seat renews, a one-off
 *  purchase does not, a rate-based capacity decays. `quantity` is a magnitude in the SAME unit the
 *  Resource declares; `per_period` is the cadence it renews over (absent for a one-off). NOTHING
 *  here converts between units — replenishment is a quantity-over-time in one unit, never a rate
 *  table that would smuggle an exchange rate in. */
export const ReplenishmentSchema = z
  .object({
    kind: z.enum(["renewing", "one_off", "rate_based"]),
    /** The magnitude that refills each period, in the Resource's OWN unit. Zero for a pure one-off. */
    quantity: z.number(),
    /** The cadence the quantity renews over (e.g. "monthly", "2026-Q3"). Absent for a one-off. */
    per_period: z.string().optional(),
  })
  .strict();

/** One draw against declared capacity — UNIT-TAGGED. A booking draws a VECTOR of these; over-commitment
 *  is checked per unit with NO exchange rate anywhere. */
export const DrawSchema = z
  .object({
    resource_slug: z.string(),
    unit: z.string(),
    quantity: z.number(),
  })
  .strict();

/** Capacity as its OWN class. A holding of some opaque, non-convertible `unit` by a `holder` (an
 *  organization slug), for a `period`, transferable across organizations or not. `replenishment` is
 *  OPTIONAL and describes how the holding refills IN ITS OWN UNIT — one Resource definition serves a
 *  renewing, one-off, or rate-based holding without a parallel ledger that could disagree. */
export const ResourceSchema = z
  .object({
    slug: z.string(),
    holder: z.string(),
    quantity: z.number(),
    unit: z.string(),
    /**
     * REQUIRED, and it must stay required — this field is what makes a Resource a BUDGET rather
     * than a running balance, and the difference is load-bearing.
     *
     * A Resource is "this much, over this window". Capacity is settled ONCE, at declaration, and
     * held as a commitment for the window; anything continuous underneath it — a decaying holding,
     * a replenishing one — determines the NEXT declaration rather than being read live inside this
     * one. That is what a budget is, and it is consistent with a layer whose subject is committed
     * work: a commitment is a stored fact even when it was computed from something continuous.
     *
     * WHAT BREAKS IF THIS GOES OPTIONAL. The tempting change is a one-off holding that "has no
     * window" — it feels like it should not need one. But a quantity with no window is a running
     * balance, and a running balance is continuously readable: ask `checkTourCapacity` enough
     * times with varying draws and binary search recovers the holder's exact remaining capacity.
     *
     * For units whose magnitude is private — a pair's earned standing, an org's runway — that is an
     * arbitrary-precision oracle reconstructed from an admissibility check that was never meant to
     * answer it. The window is what stops it: within a period the answer is a fixed declared number
     * the holder chose to commit, not a live reading of what they have.
     *
     * So a one-off holding still declares its window. It is not bureaucracy; it is the reason the
     * check can be offered at all.
     */
    period: z.string(),
    transferable: z.boolean(),
    replenishment: ReplenishmentSchema.optional(),
  })
  .strict();

/** One commitment in the binding middle place: the four load-bearing fields (aim, period,
 *  accountable_office, acceptance) plus its draws, lifecycle and served north stars. `amount` is
 *  OPTIONAL — a real commitment can have no price. `acceptance` and `antecedent` reuse the ONE
 *  predicate form; `tier` reuses NormPairSchema's enum. */
export const BookingSchema = z
  .object({
    slug: z.string(),
    aim: z.string(),
    amount: z.number().optional(),
    period: z.string(),
    accountable_office: z.string(),
    acceptance: InstitutionalLawCheckSchema,
    draws: z.array(DrawSchema).default([]),
    served_northstars: z.array(z.string()).default([]),
    tier: NormPairSchema.shape.tier,
    lifecycle: CommitmentRecordSchema,
    settled_gig_ids: z.array(z.string()).optional(),
    antecedent: InstitutionalLawCheckSchema.optional(),
  })
  .strict();

/** The institution-visible aggregation — it REFERENCES an institution (the constraint) and an
 *  organization (the accountable player) by slug; it does NOT live inside InstitutionSchema. */
export const TourSchema = z
  .object({
    slug: z.string(),
    institution_slug: z.string(),
    org_slug: z.string(),
    responsible_chair: z.string(),
    period: z.string(),
    northstar_slugs: z.array(z.string()).default([]),
    bookings: z.array(BookingSchema).default([]),
  })
  .strict();

export type ReplenishmentOutput = z.output<typeof ReplenishmentSchema>;
export type DrawOutput = z.output<typeof DrawSchema>;
export type ResourceOutput = z.output<typeof ResourceSchema>;
export type BookingOutput = z.output<typeof BookingSchema>;
export type TourOutput = z.output<typeof TourSchema>;
