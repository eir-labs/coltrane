// Institutional-law ENFORCEMENT — the seam that makes Coltrane's own laws machine-checkable
// at the moment of action, rather than prose that sounds binding.
//
// Coltrane's public position is that an institutional law is decidable when an action is
// attempted. Today institutions/coltrane.json ships three ADICO laws whose `check.predicate`
// is a real s-expression that NOTHING evaluates, and composeStandard verifies chair caps at
// dispatch while verifying no chair obligation at all. This module is the repair: a
// zero-dependency in-house s-expression evaluator with a fixed verdict codomain, and an
// admissibility check that refuses an institution document claiming more enforcement than it
// has.
//
// GREEN STATUS. The signatures below and the `Verdict` codomain are the fixed seam authored by
// the red spec; this change fills the bodies WITHOUT touching either. The evaluator is a total
// four-plus-valued reducer over a supplied fact record; admissibility is a separate, explicitly
// invoked pure function. Neither is wired into loadGenome — a universal gate would refuse
// quartet.json (unmarked obligations, non-fact-decidable operators) and break "loads unchanged".
// See docs/specs/coltrane-enforces-its-laws.md.

/**
 * The closed verdict algebra — a strict superset of refuse/permit, grounded in XACML 3.0's
 * four-valued decision model:
 *  - PERMIT          the action is allowed (an allow atom, or a satisfied obligation).
 *  - DENY            the action is refused (a deny atom, or a breached obligation — the or_else fires).
 *  - NOT_APPLICABLE  the law does not govern this action (the guard of `(=> P Q)` is false).
 *  - UNDECIDED       well-formed, but the fact-only evaluator cannot reduce it (e.g. an operator
 *                    that needs a genome/collection/timestamp context not supplied). Never coerced
 *                    to PERMIT or DENY.
 *  - DEAD_NAME       a name declared in `check.inputs` is absent from the fact record. Fails closed,
 *                    the exact analogue of an unresolvable tool grant (runtime.ts's
 *                    resolveAgentGrants().unknown). Never PERMIT, never a DENY dressed as a decision.
 *
 * PERMIT/DENY/UNDECIDED is a deliberate strict subset of the edit-automata TERMINATE/SUPPRESS/INSERT
 * taxonomy (Ligatti, Bauer & Walker 2005): SUPPRESS and INSERT are a named future gap, extendable
 * behind this same interface.
 */
export type Verdict = "PERMIT" | "DENY" | "NOT_APPLICABLE" | "UNDECIDED" | "DEAD_NAME";

/** The five closed verdict values as data — for codomain-closure and exhaustiveness assertions. */
export const VERDICTS: readonly Verdict[] = [
  "PERMIT",
  "DENY",
  "NOT_APPLICABLE",
  "UNDECIDED",
  "DEAD_NAME",
];

/** The InstitutionalLawCheckSchema shape the evaluator consumes: a predicate + its typed inputs. */
export interface LawCheck {
  predicate: string;
  inputs: Record<string, string>;
}

/** A supplied fact record: each declared input name → its supplied value. */
export type FactRecord = Record<string, unknown>;

// ── An in-house, zero-dependency s-expression reader ──────────────────────────────────────────
// SMT-LIB2 is itself s-expression many-sorted first-order logic, so a Z3 backend later sits behind
// the SAME `evaluate()` signature; this reader is the fact-only front half. It is TOTAL over
// well-formed input and throws only ParseError on malformed input — which `evaluate` catches
// (runtime never throws) and which admissibility surfaces as a static refusal.

class ParseError extends Error {}

type SExpr =
  | { kind: "list"; items: SExpr[] }
  | { kind: "sym"; name: string }
  | { kind: "str"; value: string };

type Token = { t: "("; } | { t: ")"; } | { t: "str"; v: string } | { t: "sym"; v: string };

function isDelimiter(c: string): boolean {
  return c === "(" || c === ")" || c === '"' || c === " " || c === "\t" || c === "\n" || c === "\r";
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(") {
      out.push({ t: "(" });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ t: ")" });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < n) {
          s += src[j + 1]!;
          j += 2;
          continue;
        }
        s += src[j]!;
        j++;
      }
      if (j >= n) throw new ParseError("unterminated string literal");
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n && !isDelimiter(src[j]!)) j++;
    out.push({ t: "sym", v: src.slice(i, j) });
    i = j;
  }
  return out;
}

function parse(src: string): SExpr {
  const toks = tokenize(src);
  let pos = 0;
  function readExpr(): SExpr {
    if (pos >= toks.length) throw new ParseError("unexpected end of input");
    const tok = toks[pos]!;
    if (tok.t === "(") {
      pos++;
      const items: SExpr[] = [];
      while (pos < toks.length && toks[pos]!.t !== ")") items.push(readExpr());
      if (pos >= toks.length) throw new ParseError("unbalanced parenthesis");
      pos++; // consume the ")"
      return { kind: "list", items };
    }
    if (tok.t === ")") throw new ParseError("unexpected )");
    pos++;
    return tok.t === "str" ? { kind: "str", value: tok.v } : { kind: "sym", name: tok.v };
  }
  const expr = readExpr();
  if (pos !== toks.length) throw new ParseError("trailing tokens after expression");
  return expr;
}

// ── The operator table — the UNION across both shipped institutions ───────────────────────────
// coltrane's fact-decidable core plus quartet's collection/temporal operators. An operator in this
// set is IMPLEMENTED (it does not trip the admissibility "unimplemented operator" refusal); one
// outside it is an unimplemented operator — an admissibility refusal statically, and UNDECIDED at
// runtime. Some KNOWN operators (subseteq/forall/resolvable/…) still cannot be reduced from facts
// alone, so they too return UNDECIDED at runtime — that is an honest non-decision, not an unknown.
const KNOWN_OPERATORS: ReadonlySet<string> = new Set<string>([
  "=>",
  "and",
  "or",
  "not",
  "=",
  "is-agent",
  "human-governor",
  "require",
  "allow",
  "deny",
  "subseteq",
  "forall",
  "resolvable",
  "nonempty",
  "declared_before",
  "has",
  "backed_by_contract",
]);

/** `allow` / `deny` are verdict ATOMS, not variables — excluded when collecting free variables. */
const VERDICT_ATOMS: ReadonlySet<string> = new Set<string>(["allow", "deny"]);

// ── The four-plus-valued reducer ──────────────────────────────────────────────────────────────
// A boolean sub-expression reduces to one of three states: true, false, or "U" (cannot decide from
// facts). "U" propagates upward and becomes the verdict UNDECIDED — it is never rounded to a
// decision. A verdict-producing node reduces straight to a Verdict.

type Tri = boolean | "U";

function resolveOperand(node: SExpr, facts: FactRecord): { ok: boolean; value?: unknown } {
  if (node.kind === "str") return { ok: true, value: node.value };
  if (node.kind === "sym") return { ok: true, value: facts[node.name] };
  return { ok: false };
}

function asBool(node: SExpr, facts: FactRecord): Tri {
  if (node.kind !== "list" || node.items.length === 0) return "U";
  const head = node.items[0]!;
  if (head.kind !== "sym") return "U";
  const args = node.items.slice(1);
  switch (head.name) {
    case "and": {
      let seenUndecided = false;
      for (const a of args) {
        const b = asBool(a, facts);
        if (b === false) return false;
        if (b === "U") seenUndecided = true;
      }
      return seenUndecided ? "U" : true;
    }
    case "or": {
      let seenUndecided = false;
      for (const a of args) {
        const b = asBool(a, facts);
        if (b === true) return true;
        if (b === "U") seenUndecided = true;
      }
      return seenUndecided ? "U" : false;
    }
    case "not": {
      if (args.length !== 1) return "U";
      const b = asBool(args[0]!, facts);
      return b === "U" ? "U" : !b;
    }
    case "=": {
      if (args.length !== 2) return "U";
      const l = resolveOperand(args[0]!, facts);
      const r = resolveOperand(args[1]!, facts);
      if (!l.ok || !r.ok) return "U";
      return l.value === r.value;
    }
    case "is-agent": {
      if (args.length !== 1) return "U";
      const v = resolveOperand(args[0]!, facts).value;
      return !!v && typeof v === "object" && (v as Record<string, unknown>).is_agent === true;
    }
    case "human-governor": {
      if (args.length !== 1) return "U";
      const v = resolveOperand(args[0]!, facts).value;
      return !!v && typeof v === "object" && (v as Record<string, unknown>).human_governor === true;
    }
    default:
      // A KNOWN-but-not-fact-decidable operator (subseteq/forall/resolvable/nonempty/…) or one this
      // evaluator does not implement: it cannot be reduced from the supplied facts. UNDECIDED, never
      // a silent true/false.
      return "U";
  }
}

function asVerdict(node: SExpr, facts: FactRecord): Verdict {
  if (node.kind === "sym") {
    if (node.name === "allow") return "PERMIT";
    if (node.name === "deny") return "DENY";
    return "UNDECIDED";
  }
  if (node.kind === "str") return "UNDECIDED";
  if (node.items.length === 0) return "UNDECIDED";
  const head = node.items[0]!;
  if (head.kind !== "sym") return "UNDECIDED";
  const args = node.items.slice(1);
  switch (head.name) {
    case "=>": {
      // The guard/consequent form: P false → the law does not govern this action (NOT_APPLICABLE);
      // P true → reduce the consequent; P undecidable → UNDECIDED (never a decision).
      if (args.length !== 2) return "UNDECIDED";
      const p = asBool(args[0]!, facts);
      if (p === "U") return "UNDECIDED";
      if (p === false) return "NOT_APPLICABLE";
      return asVerdict(args[1]!, facts);
    }
    case "require": {
      // An obligation's check: R holds → the obligation is met (PERMIT); R fails → the or_else fires
      // (DENY); R undecidable → UNDECIDED.
      if (args.length !== 1) return "UNDECIDED";
      const r = asBool(args[0]!, facts);
      if (r === "U") return "UNDECIDED";
      return r ? "PERMIT" : "DENY";
    }
    case "allow":
      return "PERMIT";
    case "deny":
      return "DENY";
    default:
      // A boolean/collection operator in verdict position, or an unimplemented one: the fact-only
      // evaluator cannot reduce it to a decision.
      return "UNDECIDED";
  }
}

/**
 * Evaluate a law's `check` against a supplied fact record and return exactly one Verdict.
 *
 * The interface is the fixed seam: an SMT/solver backend (SMT-LIB2 is itself s-expression
 * many-sorted first-order logic) is reachable later behind this identical signature without
 * changing any caller — solve-vs-evaluate stays inside the box, provided the in-house evaluator
 * keeps "cannot decide" explicit (UNDECIDED) rather than defaulting.
 *
 * Total: it never throws. A declared input the fact record does not supply is DEAD_NAME (fail
 * closed); an unparseable or irreducible predicate is UNDECIDED; neither is ever a PERMIT or DENY.
 */
export function evaluate(check: LawCheck, facts: FactRecord): Verdict {
  // Fail closed on a dead name FIRST: a name the law declares in `check.inputs` but the fact record
  // does not supply. The exact analogue of resolveAgentGrants().unknown — a promised name with no
  // backing. Checked before reduction so a missing input never masquerades as a decision.
  const inputs = check.inputs;
  for (const name of Object.keys(inputs)) {
    if (!Object.prototype.hasOwnProperty.call(facts, name)) return "DEAD_NAME";
  }
  let ast: SExpr;
  try {
    ast = parse(check.predicate);
  } catch {
    // A predicate that does not parse cannot be reduced from facts. Runtime never throws and never
    // decides; an unparseable predicate is REFUSED statically by checkInstitutionAdmissibility.
    return "UNDECIDED";
  }
  return asVerdict(ast, facts);
}

/** One reason a document is inadmissible: which law or obligation, and why. */
export interface AdmissibilityOffender {
  kind: "law" | "obligation";
  /** A locator for the offending element (law aim / chair role + obligation aim). */
  ref: string;
  reason: string;
}

/** Collect-all / refuse-once: admitted, or the FULL list of offenders in a single result. */
export interface AdmissibilityResult {
  admitted: boolean;
  offenders: AdmissibilityOffender[];
}

/** The institution document admissibility consumes: the institution section plus its chairs. */
export interface InstitutionDocument {
  institution: unknown;
  chairs?: readonly unknown[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Walk a parsed predicate, partitioning symbols into operators (head position) and free variables
 *  (operand position, excluding the verdict atoms allow/deny and string literals). */
function collectSymbols(node: SExpr, vars: Set<string>, ops: Set<string>, isHead: boolean): void {
  if (node.kind === "list") {
    if (node.items.length === 0) return;
    for (let i = 0; i < node.items.length; i++) collectSymbols(node.items[i]!, vars, ops, i === 0);
    return;
  }
  if (node.kind === "sym") {
    if (isHead) ops.add(node.name);
    else if (!VERDICT_ATOMS.has(node.name)) vars.add(node.name);
  }
  // string literals are values, not names
}

function checkLaw(law: unknown, offenders: AdmissibilityOffender[]): void {
  const l = asRecord(law);
  const ref = typeof l.aim === "string" && l.aim.length > 0 ? l.aim : "(law)";
  const push = (reason: string): void => {
    offenders.push({ kind: "law", ref, reason });
  };
  const check = asRecord(l.check);
  const predicate = check.predicate;
  const inputs = asRecord(check.inputs);
  if (typeof predicate !== "string") {
    push("law has no check.predicate to evaluate");
    return;
  }
  let ast: SExpr;
  try {
    ast = parse(predicate);
  } catch (e) {
    push(`predicate does not parse: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const vars = new Set<string>();
  const ops = new Set<string>();
  collectSymbols(ast, vars, ops, false);
  const declared = new Set(Object.keys(inputs));
  // Var-declaration closure, both directions: every free variable is declared, AND every declared
  // input is referenced (an unused declaration is a typo-mask that overclaims the law's surface).
  for (const v of vars) {
    if (!declared.has(v)) push(`predicate references undeclared variable "${v}"`);
  }
  for (const d of declared) {
    if (!vars.has(d)) push(`declared input "${d}" is never referenced by the predicate`);
  }
  // Every operator the predicate names must be implemented; an unknown operator must not pass.
  for (const op of ops) {
    if (!KNOWN_OPERATORS.has(op)) push(`predicate uses an unimplemented operator "${op}"`);
  }
  // or_else is the ADICO slot that separates a RULE from a norm; the schema's z.string() lets ''
  // through, so admissibility is where an empty consequence-on-breach is caught.
  if (typeof l.or_else !== "string" || l.or_else.trim() === "") {
    push("or_else is empty — a rule needs a stated consequence on breach");
  }
}

function checkChair(chair: unknown, offenders: AdmissibilityOffender[]): void {
  const c = asRecord(chair);
  const role = typeof c.role === "string" ? c.role : "(chair)";
  const obligations = Array.isArray(c.obligations) ? c.obligations : [];
  for (const raw of obligations) {
    const ob = asRecord(raw);
    const aim = typeof ob.aim === "string" ? ob.aim : "(obligation)";
    // Verified OR explicitly marked declared-tier. There is no verifier surface in this genome, so
    // an obligation states its tier: "enforced" claims a verifier backs it, "declared" states it is
    // a norm with no runtime check. An UNMARKED obligation is refused — silence must not pass a norm
    // off as a rule.
    if (ob.tier !== "declared" && ob.tier !== "enforced") {
      offenders.push({
        kind: "obligation",
        ref: `${role} :: ${aim}`,
        reason: "obligation is neither verified nor explicitly marked declared-tier",
      });
    }
  }
}

/**
 * Refuse an institution document that claims more enforcement than it has. Per law: the predicate
 * parses; every free variable is declared in `check.inputs` and every declared input is referenced;
 * every operator is implemented; `or_else` is non-empty. Per chair obligation: it is verified OR
 * explicitly marked declared-tier — an unmarked unverified obligation is refused, so silence cannot
 * pass a norm off as a rule. Collects every offender and refuses once (collect-all / refuse-once,
 * mirroring runtime.ts's PreflightDispatchError sweep).
 *
 * This is an explicitly-invoked pure function; it is deliberately NOT wired into loadGenome, so
 * quartet.json (unmarked obligations, non-fact-decidable operators) still loads unchanged.
 */
export function checkInstitutionAdmissibility(doc: InstitutionDocument): AdmissibilityResult {
  const offenders: AdmissibilityOffender[] = [];
  const institution = asRecord(doc.institution);
  const laws = Array.isArray(institution.laws) ? institution.laws : [];
  for (const law of laws) checkLaw(law, offenders);
  const chairs = Array.isArray(doc.chairs) ? doc.chairs : [];
  for (const chair of chairs) checkChair(chair, offenders);
  return { admitted: offenders.length === 0, offenders };
}
