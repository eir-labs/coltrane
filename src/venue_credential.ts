// THE VENUE CREDENTIAL SEAM — the engine ships the verb, its shape validation, and its refusals;
// a deployment wires the minting backend. See SPEC-worker-contract.md §"Gap 1".
//
// A venue is any host that runs `coltrane work`. To stand one up you need an org-scoped,
// instance-bound drain key plus the complete set of worker-environment variables. This file is the
// engine half of `venue_credential_mint`: the required-env contract, the three typed refusals, and
// the pure shape checks the surface handler (src/server.ts callSurfaceTool) applies around whatever
// backend a deployment injects on ToolSurfaceDeps.mintVenueCredential.
//
// TWO THINGS DELIBERATELY ABSENT, each a design decision a later reader will be tempted to "fix":
//   * NO read-back verb. The credential is answered exactly once and is never retrievable; there is
//     no venue_credential_read and the engine does not persist the grant. Adding one would make
//     every credential readable by anything holding the surface — the same widening the gig-scope
//     refusal exists to prevent.
//   * NO authorization policy. The engine has no opinion about WHO may run a venue and no way to
//     check one — that rule lives in the store. The one caller check here (the gig-scope refusal) is
//     a structural fact about credential SCOPE, not a who-may-mint decision: a gig credential expires
//     with one gig's lease and a venue credential outlives every gig, so letting the first mint the
//     second turns the narrowest credential in the system into the broadest. Every other question
//     about who may mint belongs to a deployment this engine cannot see. No policy hook, allowlist,
//     or role check lives here, and their absence is the design.

/** The worker environment a venue needs, canonical names only. Every one of these must arrive with a
 *  truthy value from a single mint — a grant missing any of them is refused, not forwarded, because a
 *  half-set moves the assembly problem to the caller while looking like success. This is the "always"
 *  + "venue"-scoped core of the worker environment contract (SPEC-worker-contract.md), not the full
 *  table: the conditional and tuning variables (COLTRANE_GIT_CREDENTIALS_URL, the bounded overrides)
 *  are not required for a box to stand up, so their absence is not an incomplete grant. */
export const REQUIRED_WORKER_ENV = [
  "COLTRANE_STORE_URL",
  "COLTRANE_STORE_ANON",
  "COLTRANE_SERVICE_URL",
  "COLTRANE_DRAIN_KEY",
  "COLTRANE_INSTANCE",
] as const;

/** The three reasons a mint cannot proceed, as an EXACT list — a refusal code is a contract with
 *  clients, so a fourth appearing silently is a client branch nobody wrote. Sorted, this is
 *  ['gig_scoped_token','incomplete_env','no_backend'] (spec_venue_credential_mint.test.ts). */
export const VENUE_CREDENTIAL_REFUSALS = [
  "gig_scoped_token",
  "no_backend",
  "incomplete_env",
] as const;

export type VenueCredentialRefusal = (typeof VENUE_CREDENTIAL_REFUSALS)[number];

/** Who is asking to mint. `kind` is the credential class the caller presented; `gig_id` is carried
 *  only for a gig-scoped caller, and only so a refusal can be specific. This is NOT an authorization
 *  principal — the engine reads exactly one thing off it (is this a gig token?), which is a
 *  credential-scope fact, and forwards every other who-may-mint question to the store. */
export interface CallerIdentity {
  kind: "member" | "player" | "venue" | "gig";
  gig_id?: string;
}

/** What a deployment's minting backend answers with. `credential_classes` is in
 *  `VenueSchema.credential_surface` vocabulary — the room's own word for what may legitimately be
 *  present — because that is the contract the provisioned box is then judged against by `realize`.
 *  CLASSES, never material: a class name is what a `credential_surface` declares, never a field a
 *  secret could occupy. */
export interface VenueCredentialGrant {
  instance: string;
  env: Record<string, string>;
  credential_classes: string[];
  expires_at?: string | null;
}

/** The structural escalation check, decided from caller identity ALONE, before any backend is
 *  reached. Returns the refusal code when the caller is gig-scoped, else null. This is credential
 *  SCOPE, not policy: a gig token outliving its lease as a venue key is an escalation no store-side
 *  gate catches, because the store sees a valid org-scoped request from a credential it issued. */
export function gigScopeRefusal(caller: CallerIdentity | undefined): VenueCredentialRefusal | null {
  return caller?.kind === "gig" ? "gig_scoped_token" : null;
}

/** Which required worker-env variables the grant failed to supply a truthy value for. An empty array
 *  means the environment is complete; a non-empty one is exactly what an `incomplete_env` refusal
 *  names, so the caller learns what is missing instead of discovering it from a status code at first
 *  write. */
export function missingWorkerEnv(env: Record<string, string> | undefined): string[] {
  return REQUIRED_WORKER_ENV.filter((key) => !env?.[key]);
}
