// THE ORG-HIRE SEAM — the engine ships the verb, its shape validation, and its refusals; a
// deployment wires the admission backend. The org-membership analogue of `venue_credential_mint`
// (src/venue_credential.ts): same split, same reason.
//
// `org_hire` ADMITS an agent to an org. There was no governed verb for the act, so the only path to
// admit an agent was a human editing store rows by hand. This file is the engine half: the exact
// set of typed refusals, the backend-result contract, and the `deps.hireMember` seam the surface
// handler (src/server.ts callSurfaceTool) applies its refusals around. The store performs the
// insert and any RLS; that half is unreadable by this engine.
//
// TWO CONSTRAINTS DELIBERATELY PINNED, each a design decision a later reader will be tempted to
// "fix" by widening:
//   * ADMISSION IS NOT AUTHORITY. The input is OrgMemberSchema = {org_slug, agent_slug} and nothing
//     more (src/genome_schema.ts). Membership is BELONGING; authority is SEATING — a chair carries
//     caps, an assignment binds an agent to a chair, and a credential presented by an incumbent may
//     only NARROW what a chair grants. If org_hire accepted `caps`/a chair/an assignment it would
//     become a path to mint authority in one call, and that narrowing invariant would lose its
//     floor. Seating is a separate act with a separate gate. The verb carries no field a capability
//     could travel — enforced by the schema itself, asserted by a law.
//   * HIRING IS NEVER SELF-SERVICE. Only a human 'member' caller may hire; an agent token
//     (player/venue/gig) is refused before the backend is reached. That gate lives in the surface
//     handler (it reads CallerIdentity), not here — this file names the refusal it produces.
//
// A successful hire is SEALED to the ledger (a kind:"genome_mutation" row via recordIdentity in
// server.ts), so who-hired-whom lives in the append-only chain rather than only in a database row —
// the same audit obligation agent_define/agent_evolve carry.

/** The four reasons a hire cannot proceed, as an EXACT list — a refusal code is a contract with
 *  clients, so a fourth appearing silently is a client branch nobody wrote. Declared in SORTED
 *  order, so the as-const array IS its own sorted copy and any drift is a line someone changed on
 *  purpose (org_hire_is_governed.test.ts pins the exact set). Mirrors VENUE_CREDENTIAL_REFUSALS.
 *    · already_member     — the hire repeats. An ERROR, not a silent no-op: a governance surface
 *                           must surface a duplicated hire rather than mask a member's mistake.
 *    · no_backend         — no deployment wired deps.hireMember. The verb answers, it never throws.
 *    · not_a_human_member — the caller presented an AGENT token. Hiring is never self-service.
 *    · unknown_agent      — no agent_record with that slug exists. A dead name fails closed. */
export const ORG_HIRE_REFUSALS = [
  "already_member",
  "no_backend",
  "not_a_human_member",
  "unknown_agent",
] as const;

export type OrgHireRefusal = (typeof ORG_HIRE_REFUSALS)[number];

/** What a deployment's admission backend answers with — a TYPED struct, never a generic throw, so a
 *  named refusal code survives the seam. `{ok:true}` admitted; `{ok:false, code}` names why the
 *  store declined, and the code is one the surface maps straight to a typed refusal. The two backend
 *  codes are exactly the two the engine cannot decide for itself: existence (`unknown_agent`) and
 *  idempotency (`already_member`) are facts only the store holds. The other two refusals
 *  (`not_a_human_member`, `no_backend`) are decided by the engine before the backend is reached. */
export type HireMemberResult =
  | { ok: true }
  | { ok: false; code: "unknown_agent" | "already_member" };
