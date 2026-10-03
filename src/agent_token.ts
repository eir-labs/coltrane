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
//   · bad_ttl            — the store takes INTEGER HOURS ≥ 1; a TTL it cannot express is refused,
//     never rounded (rounding 15 minutes up to an hour quadruples the exposure silently — Envoy's
//     session issuer refuses the same way, addendum b20dc2c)
// Who may issue, whether the agent is a member, whether it has been named — the store's answers,
// carried back as typed codes (not_a_member, not_named). The token is returned ONCE and is never
// sealed to the ledger: the store's row is its record.

export const AGENT_TOKEN_REFUSALS = ["bad_ttl", "no_backend", "not_a_human_member"] as const;
export type AgentTokenRefusal = (typeof AGENT_TOKEN_REFUSALS)[number];

/** The deployment's contract: resolve to a typed struct, never a generic throw, so the store's own
 *  refusal codes survive the seam. */
export type IssueAgentTokenResult =
  | { ok: true; key_id: string; expires_at: string; agent_token: string }
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

/** `may_dispatch` passes through as a list of standard slugs — strings, non-empty — and nothing else. */
export function mayDispatchList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
}
