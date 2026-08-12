/**
 * venue_enforcement.test.ts — RED-first PENDING tests for the production venue contract.
 *
 * Every entry here is it.todo / describe.todo: it names an enforcement invariant
 * the implementation gig must convert into a real RED-then-GREEN assertion.
 * They report as pending (not failed), so `npm run verify` stays green and this PR
 * is mergeable under the green-CI law. Do NOT add a real expect()/assert() to this
 * file until the enforcement it names is being implemented — a smuggled real
 * assertion would break green before the mechanism exists.
 *
 * Grounding: see docs/venue-enforcement-spec.md. Callsites cited there are
 * confirmed-as-of the upstream read and must be re-confirmed by the implementation gig.
 */

import { describe, it } from "vitest";

describe.todo("venue enforcement: equipment ceiling applied to the spawn", () => {
  it.todo(
    "the spawn's --allowedTools equals agent.allowed_tools ∩ venue.equipment.tools (toolBaseName match)"
  );
  it.todo(
    "the ceiling is resolved through venueEffectiveTools — the same path the compose-time R10 check uses — so runtime and compose agree"
  );
  it.todo(
    "an agent whose entire grant set lies outside the room already refuses at compose (R10); the runtime intersection agrees with that compose verdict"
  );
  it.todo(
    "a venue named by the chart but absent from the genome fails closed, exactly as an unresolvable tool grant does"
  );
});

describe.todo("venue enforcement: credential_surface scopes the child env", () => {
  it.todo(
    "the child env contains only credentials whose class is named in venue.credential_surface"
  );
  it.todo(
    "an undeclared credential present in the parent env refuses the spawn — it is a breach, not silently stripped"
  );
  it.todo(
    "a credential class named in credential_surface but absent from the parent env is reported, not silently omitted"
  );
});

describe.todo("venue enforcement: doors bound the child's network", () => {
  it.todo("doors.egress bounds the child's outbound network to the declared origins");
  it.todo("an egress attempt to an origin outside doors.egress is refused");
  it.todo("doors.ingress constrains the accepted inbound origins for the realized room");
});

describe.todo("venue enforcement: installs verified against their digest pin", () => {
  it.todo(
    "each install is verified against its sha256 digest pin before the room is used"
  );
  it.todo("a digest mismatch refuses entry to the room rather than proceeding");
});

describe.todo("venue enforcement: lifecycle drives teardown", () => {
  it.todo("lifecycle.policy=ephemeral drives per-gig teardown of the isolated room");
  it.todo(
    "a standing venue without rebuild_cadence is refused by venueDefect (the runtime honours the lifecycle field)"
  );
});

describe.todo("venue enforcement: responsible_chair carried on the realized room", () => {
  it.todo("responsible_chair is carried on the realized room's record");
});

describe.todo("per-gig isolation lifecycle", () => {
  it.todo(
    "each gig runs in its own isolated working tree (fresh per-gig clone, branch gig/<id>), never a shared long-lived process"
  );
  it.todo("teardown removes the isolated working tree after the gig seals");
  it.todo(
    "a resumed gig runs in a FRESH isolated thread continuing from the existing gig's sealed state, not a shared long-lived process"
  );
});

describe.todo("PR-review approval gate", () => {
  it.todo(
    "the spec PR blocks the next (implementation) gig by construction until a human merges it"
  );
  it.todo(
    "the PR-review gate is distinct from the runtime awaiting_approval per-standard chair gate"
  );
  it.todo(
    "the gig result is surfaced on an approvals page; only human confirmation + merge releases the next gig"
  );
});
