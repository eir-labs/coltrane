// RED — the trigger seam: a RED spec PR merged into the change-set branch enqueues the
// implementation ONCE, however many times the event fires.
//
// Covers I9 (idempotency: any sequence of duplicate events enqueues exactly one implementation
// gig, dispatching software-change-pr-v1 with change_set_branch carried into the change-request)
// and I18 (the idempotency KEY is the change-set branch; the GitHub delivery id is only a
// secondary re-send guard, so two events with the SAME branch but DIFFERENT delivery ids still
// enqueue exactly one).
//
// Property-based because idempotency is the universal law f(f(x)) = f(x) over ALL duplicate
// sequences, not one replay. GitHub webhooks are at-least-once (X-GitHub-Delivery re-sends the
// same id on retry; different deliveries of one logical event carry different ids), so this is a
// requirement, not a refinement. RED because ChangeSetTrigger.handle/enqueued throw until built.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  ChangeSetTrigger,
  IMPLEMENTATION_STANDARD,
  type RedSpecMergedEvent,
} from "../../src/change_set_branch.js";

describe("trigger idempotency — exactly one implementation gig per change-set branch (I9, I18)", () => {
  it("I9 any sequence of duplicate events enqueues exactly one gig, carrying the branch", () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.array(fc.uuid(), { minLength: 1, maxLength: 8 }),
        (gigId, deliveryIds) => {
          const branch = `changeset/${gigId}`;
          const trigger = new ChangeSetTrigger();
          for (const delivery_id of deliveryIds) {
            const event: RedSpecMergedEvent = {
              change_set_branch: branch,
              originating_gig_id: gigId,
              delivery_id,
            };
            trigger.handle(event);
          }
          const enqueued = trigger.enqueued(branch);
          expect(enqueued).toHaveLength(1); // f(f(x)) = f(x)
          expect(enqueued[0]!.standard).toBe(IMPLEMENTATION_STANDARD);
          expect(enqueued[0]!.change_request.change_set_branch).toBe(branch);
        },
      ),
    );
  });

  it("I18 the key is the branch: same branch, DIFFERENT delivery ids ⇒ still exactly one", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), fc.uuid(), (gigId, d1, d2) => {
        fc.pre(d1 !== d2);
        const branch = `changeset/${gigId}`;
        const trigger = new ChangeSetTrigger();
        trigger.handle({ change_set_branch: branch, originating_gig_id: gigId, delivery_id: d1 });
        trigger.handle({ change_set_branch: branch, originating_gig_id: gigId, delivery_id: d2 });
        expect(trigger.enqueued(branch)).toHaveLength(1);
      }),
    );
  });

  it("I18 distinct change-set branches are independent — each enqueues its own single gig", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (gigA, gigB) => {
        fc.pre(gigA !== gigB);
        const branchA = `changeset/${gigA}`;
        const branchB = `changeset/${gigB}`;
        const trigger = new ChangeSetTrigger();
        trigger.handle({ change_set_branch: branchA, originating_gig_id: gigA, delivery_id: "d" });
        trigger.handle({ change_set_branch: branchB, originating_gig_id: gigB, delivery_id: "d" });
        expect(trigger.enqueued(branchA)).toHaveLength(1);
        expect(trigger.enqueued(branchB)).toHaveLength(1);
      }),
    );
  });
});
