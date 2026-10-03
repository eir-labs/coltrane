// agent_token_issue — the engine half of issuing a STANDING agent token (ctk_) to an agent seated
// in an organization. The shape of org_hire and venue_credential_mint: the engine ships the verb,
// its schema, its shape validation and its refusals; a deployment wires the mint itself on
// ToolSurfaceDeps.issueAgentToken (the store's coltrane_issue_agent_token, which gates on an
// authenticated human member and holds only the token's hash and who issued it).
//
// WHY (3 Oct 2026, spec.order-lifecycle.transition-law R23). The transition law's force guard reads
// whether an order's reconciler can act: seated, granted, holding a live token. Measured on the
// store, every token the reconciler had ever held was a gig-token-<gig> row, minted by the claim
// door for one sitting and revoked at release; nothing issued a standing one. The guard asked for a
// credential no door could issue. This verb is that door. It issues BELONGING TO A SITTING NOTHING:
// what the token may dispatch is the store's `may_dispatch` and the chair's grants, and a verb
// that could issue AND seat in one call would be a path to mint authority — so the schema is the
// store's mint and nothing more.
//
// WHAT THE ENGINE DECIDES. Three structural facts, before any backend is reached:
//   · not_a_human_member — an agent token may not issue an agent token (a one-sitting credential
//     minting a standing one is an escalation no store-side gate catches; absent caller fails closed)
//   · no_backend         — no deployment wired deps.issueAgentToken; the verb answers, never throws
//   · bad_may_dispatch   — may_dispatch is a list of standard slugs or absent; a bare string, an
//     object or a list with anything but non-empty strings is refused by name rather than
//     silently narrowed to [] (a token that may dispatch nothing, issued to a caller who asked
//     for one slug and mistyped the shape, is a silent no-op wearing a success)
//   · bad_ttl            — the store takes INTEGER HOURS ≥ 1; a TTL it cannot express is refused,
//     never rounded (rounding 15 minutes up to an hour quadruples the exposure silently — the
//     deployment's session issuer refuses the same way, for the same reason)
// Who may issue, whether the agent is a member, whether it has been named — the store's answers,
// carried back as typed codes (not_a_member, not_named). The token is returned ONCE and is never
// sealed to the ledger: the store's row is its record.

export const AGENT_TOKEN_REFUSALS = ["bad_may_dispatch", "bad_ttl", "no_backend", "not_a_human_member"] as const;
export type AgentTokenRefusal = (typeof AGENT_TOKEN_REFUSALS)[number];

/** The deployment's contract: resolve to a typed struct, never a generic throw, so the store's own
 *  refusal codes survive the seam. */
export type IssueAgentTokenResult =
  | { ok: true; key_id: string; expires_at: string | null; agent_token: string }
  | { ok: false; code: "not_a_member" | "not_named" };

export interface IssueAgentTokenArgs {
  org_slug: string;
  agent_slug: string;
  may_dispatch: string[];
  ttl_hours: number;
}

/** The store's mint takes integer hours and the floor is one. Anything else is refused by name —
 *  a rounding here would change the credential's life while every test stayed green. */
export function ttlHoursOrRefusal(raw: unknown): { ttl_hours: number } | { refusal: "bad_ttl"; error: string } {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 24 * 366) {
    return {
      refusal: "bad_ttl",
      error:
        `ttl_hours must be a whole number of hours from 1 to ${24 * 366} (got ${JSON.stringify(raw)}) — the store ` +
        "mints in integer hours and a TTL it cannot express is refused, not rounded: rounding changes " +
        "how long a stolen credential lives, silently.",
    };
  }
  return { ttl_hours: n };
}

/** `may_dispatch` is absent (→ []) or a list of non-empty standard slugs. Anything else is refused by
 *  name — never narrowed to [] silently (the grade's D3). */
export function mayDispatchOrRefusal(raw: unknown): { may_dispatch: string[] } | { refusal: "bad_may_dispatch"; error: string } {
  if (raw === undefined || raw === null) return { may_dispatch: [] };
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string" || s.trim() === "")) {
    return {
      refusal: "bad_may_dispatch",
      error:
        `may_dispatch must be a list of standard slugs (non-empty strings) or absent (got ${JSON.stringify(raw)}) — ` +
        "a malformed list is refused, not narrowed: a token that may dispatch nothing, issued to a caller who " +
        "asked for one slug and mistyped the shape, is a silent no-op wearing a success.",
    };
  }
  return { may_dispatch: raw.map((s) => (s as string).trim()) };
}

/** A success the backend answers must carry a token and a key — non-empty strings, nothing more
 *  specific: the engine does not sniff a deployment's credential format (SPEC-worker-contract.md —
 *  the host declares what a bearer is because the host issued it; a format pinned here could not
 *  change without a release). A typed contract the deployment violated is not a credential issued
 *  (the grade's D5). The expiry is the store's number or null — never a blank string wearing a date. */
export function issuedOrError(r: unknown): { ok: true; key_id: string; expires_at: string | null; agent_token: string } | { ok: false; error: string } {
  const x = r as { ok?: unknown; key_id?: unknown; expires_at?: unknown; agent_token?: unknown } | null | undefined;
  if (!x || typeof x !== "object" || x.ok !== true) return { ok: false, error: "the issuing backend answered without ok:true — nothing issued" };
  if (typeof x.agent_token !== "string" || x.agent_token.trim() === "" || typeof x.key_id !== "string" || x.key_id.trim() === "") {
    return { ok: false, error: "the issuing backend answered ok without a token and a key_id — a success with no credential is nothing issued" };
  }
  const expires_at = typeof x.expires_at === "string" && x.expires_at.trim() !== "" ? x.expires_at : null;
  return { ok: true, key_id: x.key_id, expires_at, agent_token: x.agent_token };
}
