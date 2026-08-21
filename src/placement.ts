/**
 * THE CHAIR-PLACEMENT SEAM — the engine defines the question; a deployment answers it.
 *
 * WHY THIS SHAPE. The Envoy orientation (2026-08-21) states it directly: "Coltrane (OSS) exposes the
 * chair-placement seam; Envoy (deployment) plugs into it… the same shape as the venue-realizer seam:
 * an interface the engine defines and enforces, an implementation the deployment supplies." So the
 * resolution — who may sit here, and with what history — deliberately does NOT live in this repo.
 * The engine owns the MOMENT and the REFUSAL; the resolver owns the answer.
 *
 * WHAT IT UNBLOCKS. Three things are loaded into the genome today and read by nothing, because there
 * has been no moment at which anything is asked:
 *   · an institutional chair's `supplies` — the quartet writes a house-style nothing consumes
 *   · `technique_evidence` — "why this player in this chair", 0 readers
 *   · `contract_caps` — the chair-authorisation narrowing rule, 0 readers
 * Each is an answer waiting for a question. This is the question.
 *
 * OPTIONAL BY ABSENCE, CLOSED BY REFUSAL. A deployment that supplies no resolver runs exactly as
 * before — every existing standard and gig is untouched, which is what makes this safe to land ahead
 * of any consumer. A deployment that supplies one can REFUSE a seating, and a refusal stops the
 * chair. A refusal that were logged and ignored would make the seam decoration.
 */

/** Who is being placed, where, and under what. Everything the engine knows at the moment a chair is
 *  taken — deliberately no more: what else bears on the decision is the resolver's business. */
export interface PlacementRequest {
  /** The agent being seated. */
  readonly agent_slug: string;
  /** The chair's role within the standard. */
  readonly role: string;
  /** The standard the chair belongs to. */
  readonly standard_slug: string;
  /** The phase the chair runs in. */
  readonly phase: string;
  /** The gig this placement is for. */
  readonly gig_id: string;
  /** What the chair's contract says this seat consumes and produces — enough for a resolver to ask
   *  "can it do what this chair assigns" without reaching back into the genome itself. */
  readonly input_contract: readonly string[];
  readonly output_contract: readonly string[];
}

/**
 * The answer. `admitted: false` REFUSES the seating and stops the chair.
 *
 * `hydration` is the other half of placement — Envoy's "carry the chain into the chair". Whatever the
 * resolver returns reaches the invocation as `ctx.hydration`, on exactly the wire an institutional
 * chair's `supplies` would use. A resolver that admits without hydrating is valid; the field is
 * optional because validation and hydration are separable and a deployment may want only the first.
 */
export interface PlacementDecision {
  readonly admitted: boolean;
  /** Why refused. Carried into the error so an operator learns the reason, not merely that it failed. */
  readonly reason?: string | undefined;
  /** Slot name → value, delivered to the seated agent. */
  readonly hydration?: Record<string, unknown> | undefined;
}

/** What a deployment supplies. One method: the engine asks at the moment a chair is taken. */
export interface PlacementResolver {
  place(request: PlacementRequest): Promise<PlacementDecision>;
}

/**
 * A refused seating. Distinct from every other chair failure because the chair never ran — nothing
 * was spent, and the reason belongs to the institution rather than to the work.
 */
export class PlacementRefused extends Error {
  readonly agent_slug: string;
  readonly role: string;
  constructor(agent_slug: string, role: string, reason: string) {
    super(`placement refused — agent "${agent_slug}" may not take chair "${role}": ${reason}`);
    this.name = "PlacementRefused";
    this.agent_slug = agent_slug;
    this.role = role;
  }
}
