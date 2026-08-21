import type { LoadedInstitution } from "./institution_loader.js";
import type { PlacementDecision, PlacementRequest, PlacementResolver } from "./placement.js";

/**
 * A PlacementResolver backed by the genome's own `institutions/*.json`.
 *
 * WHY THIS IS IN OSS, given the seam exists for a deployment to fill. The precedent is this repo's:
 * the venue seam defines `VenueRealizer` AND ships `dockerComposeRealizer()`; `GenomeStore` has three
 * backings behind one port. This is the file backing of the placement port — the parallel to Envoy's
 * store-backed resolver, not a competitor to it. Envoy answers from `coltrane_chair_assignment`; this
 * answers from the files a clone already has.
 *
 * WHAT IT CLOSES. `institutions/quartet.json`'s structure-builder chair supplies a real `house-style`,
 * and bill's carried `structure-conformance` skill tells its agent to "read the constraints supplied
 * in the `house-style` slot". Nothing ever delivered it, because until the placement seam there was
 * no moment at which anything was asked. This is the first thing to answer.
 *
 * THE SEMANTIC, and it is the whole design decision:
 *
 *   SILENCE ADMITS       — an institution that says nothing about an agent does not refuse it.
 *   CONTRADICTION REFUSES — an institution that seats a DIFFERENT agent in that role does.
 *
 * Refusing every unwitnessed seating would break the shipped genome: no standard outside the quartet
 * carries assignments at all. Absence of a record is not a finding — it is a genome that has not been
 * populated yet, and treating it as a refusal would make the feature unusable on the day it landed.
 * A contradiction is different: the institution HAS spoken about this chair and named someone else.
 */
export function institutionPlacementResolver(
  institutions: ReadonlyMap<string, LoadedInstitution>,
): PlacementResolver {
  return {
    place: async (request: PlacementRequest): Promise<PlacementDecision> => resolve(institutions, request),
  };
}

function resolve(
  institutions: ReadonlyMap<string, LoadedInstitution>,
  request: PlacementRequest,
): PlacementDecision {
  for (const inst of institutions.values()) {
    // The document is typed by the loader (InstitutionDocumentSections); read it as such rather than
    // casting to a bag of unknowns, so a section that changes shape breaks here at compile time.
    const chairs = inst.document.chairs ?? [];
    const seats = inst.document.assignments ?? [];

    // The chair this role names, in this institution. A role no chair carries is silence.
    const chair = chairs.find((c) => c.role === request.role);
    if (!chair) continue;

    // Who the institution seats there. An unseated chair is also silence — the office exists and
    // nobody has been placed in it, which is not a statement about the agent being placed now.
    const seat = seats.find((s) => s.chair_id === chair.id);
    if (!seat) continue;

    if (seat.agent_slug !== request.agent_slug) {
      return {
        admitted: false,
        reason:
          `institution "${inst.slug}" seats "${seat.agent_slug}" in chair "${request.role}", ` +
          `not "${request.agent_slug}"`,
      };
    }

    // Seated, and it is this agent. Carry the chair's supplies — the institution's data entering at
    // the seat, which is the wire this whole surface was waiting for.
    const supplies =
      chair.supplies && Object.keys(chair.supplies).length > 0
        ? { ...(chair.supplies as Record<string, unknown>) }
        : undefined;
    return supplies ? { admitted: true, hydration: supplies } : { admitted: true };
  }
  // No institution had anything to say about this role. Silence admits.
  return { admitted: true };
}
