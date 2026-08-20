/** THE SUITE REACHES NO REMOTE.
 *
 *  `src/output_mirror.ts` decides whether to append to a remote store by reading AMBIENT env
 *  (`remoteConfigured()`: COLTRANE_DRAIN_KEY || COLTRANE_DRAIN_PG). A developer box configured to
 *  drain — the same box `npm run verify` runs on before a deploy — therefore had every persisted
 *  output POSTed to that box's real service, under that box's real credential, from a green test run.
 *
 *  Measured before the guard landed: one full suite with the drain env set sent 428 requests to the
 *  configured origin (423 gig rows, 4 output records, 1 artifact upload). Every test passed. A
 *  fire-and-forget drain that SUCCEEDS logs nothing, so the suite had no way to report it.
 *
 *  tests/_support/isolate_audit_spine.ts (a setupFile, so it runs per test file) now deletes those
 *  vars. This law is the tripwire on that guard: it fails if the deletion is removed, reordered out,
 *  or if the setupFile stops being registered in vitest.config.ts. It asserts the OBSERVABLE fact the
 *  guard exists to produce, not the presence of the line that produces it. */
import { describe, expect, it } from "vitest";

describe("the test suite reaches no remote store", () => {
  it("no drain credential is visible to a test — a green run cannot write to an org store", () => {
    // The exact disjunction remoteConfigured() evaluates. Either being set is sufficient to arm the
    // remote append, so both must be absent for the suite to be hermetic.
    expect(process.env["COLTRANE_DRAIN_KEY"], "COLTRANE_DRAIN_KEY leaked into the suite").toBeUndefined();
    expect(process.env["COLTRANE_DRAIN_PG"], "COLTRANE_DRAIN_PG leaked into the suite").toBeUndefined();
  });

  it("no drain ORIGIN is visible either — the address is severed as well as the credential", () => {
    // Belt and braces, and it carries its own reason: a key with no origin already fails loudly
    // (worker_env refuses the pair), but an ORIGIN left set is what turns a future ambient key into
    // a live POST. Severing both means a single leaked variable is never sufficient.
    expect(process.env["COLTRANE_DRAIN_URL"], "COLTRANE_DRAIN_URL leaked into the suite").toBeUndefined();
  });
});
