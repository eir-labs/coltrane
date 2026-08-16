// The worker environment contract, written down in ONE place — the fix for Gap 3 of
// SPEC-worker-contract.md.
//
// ONE VARIABLE, THREE READERS, TWO MEANINGS. `COLTRANE_DRAIN_URL` was read by callers that did not
// agree on what host it named — two treated it as the database's PostgREST base, one as the
// Coltrane service origin. Pointed at the database, rows wrote and the artifact 401'd forever;
// repointed at the service, provisioning broke against a 307. Every fix moved the failure because
// the variable had never named one thing.
//
// This module pins the general form of the fix rather than that instance of it:
//   * one variable names one host; two hosts are two variables (`WORKER_ENV_CONTRACT`);
//   * `COLTRANE_SERVICE_URL` is canonical and `COLTRANE_DRAIN_URL` survives only as a normalized
//     legacy alias — a role name is not a host name, which is how one variable came to hold both;
//   * a legacy shape NORMALIZES, never appends (`normalizeWorkerEnv`) — appending is what produced
//     `/rest/v1/rest/v1`;
//   * a misconfigured worker refuses at STARTUP in its own voice (`assertWorkerEnv`), rather than
//     learning it is pointed at the wrong host from a status code at its first write.
//
// The contract enumerates every variable the worker path reads. `tests/spec_worker_environment.test.ts`
// scans the real source of the WORKER_PATH files and fails if any `process.env["…"]` read is absent
// from this table — so the table is a declaration the code is held to, not a comment. This file
// therefore reads NO environment itself; its three functions take the environment as an argument.

/** Which host a value addresses — or "none" when it names no host at all. */
export type EnvHost = "service" | "store" | "none";
/** What kind of thing it is. A url is the only role that MUST name a host. */
export type EnvRole = "url" | "credential" | "identity" | "tuning";
/** When a worker must have it. "venue"/"player" are the two credential modes (Gap 4). */
export type EnvRequired = "always" | "venue" | "player" | "conditional" | "never";

export interface WorkerEnvVar {
  name: string;
  host: EnvHost;
  role: EnvRole;
  required: EnvRequired;
  /** one sentence: what it means and, for a url, WHICH host it names. */
  meaning: string;
  /** names tolerated for compatibility and normalized onto `name`. */
  legacy_names?: readonly string[];
}

/**
 * THE ENUMERATED TABLE. Every environment variable the worker path reads appears here exactly once,
 * as a `name` or as one entry's `legacy_names`. Exactly one always-required url names each host
 * (store, service); no name is listed twice; no legacy alias is also someone's canonical name.
 */
export const WORKER_ENV_CONTRACT: readonly WorkerEnvVar[] = [
  {
    name: "COLTRANE_STORE_URL",
    host: "store",
    role: "url",
    required: "always",
    meaning:
      "The PostgREST base URL of the store — the database host that persists gigs, outputs and ledger rows and that the claim path reads directly.",
  },
  {
    name: "COLTRANE_STORE_ANON",
    host: "none",
    role: "credential",
    required: "always",
    meaning:
      "The store's public anon API key, presented to the store on the claim path as its `apikey`; it is not a write credential.",
  },
  {
    name: "COLTRANE_SERVICE_URL",
    host: "service",
    role: "url",
    required: "always",
    meaning:
      "The origin of the Coltrane service that brokers drain writes and boot-time provisioning — names the service host, and never the managed database.",
    legacy_names: ["COLTRANE_DRAIN_URL"],
  },
  {
    name: "COLTRANE_DRAIN_KEY",
    host: "none",
    role: "credential",
    required: "venue",
    meaning:
      "The venue's org-scoped `cdk_` drain credential authorizing output writes through the service on behalf of the whole instance.",
  },
  {
    name: "COLTRANE_AGENT_TOKEN",
    host: "none",
    role: "credential",
    required: "player",
    meaning:
      "A single agent's own `ctk_` bearer token, identifying the player to the store in player mode instead of a shared venue key.",
  },
  {
    name: "COLTRANE_INSTANCE",
    host: "none",
    role: "identity",
    required: "conditional",
    meaning:
      "The name this worker box answers to, stamped on every drain write so the store can gate the write against a live lease; absent for an unleased local run.",
    legacy_names: ["FLY_APP_NAME"],
  },
  {
    name: "COLTRANE_DRAIN_PG",
    host: "none",
    role: "credential",
    required: "never",
    meaning:
      "Legacy direct-Postgres connection string for the drain — a fallback sink reached only when no service drain key is configured.",
  },
  {
    name: "COLTRANE_DRAIN_BUCKET",
    host: "none",
    role: "tuning",
    required: "never",
    meaning:
      "Name of the storage bucket that drain artifacts are written into; defaults to `coltrane-artifacts` when unset.",
  },
  {
    name: "COLTRANE_DRAIN_OPENING",
    host: "none",
    role: "tuning",
    required: "never",
    meaning:
      "Milliseconds the drain waits for a gig's opening header before proceeding; tunes drain startup latency.",
  },
  {
    name: "COLTRANE_MIRROR_DIR",
    host: "none",
    role: "tuning",
    required: "never",
    meaning:
      "Local directory the output mirror writes a copy of every sealed artifact into for offline inspection.",
  },
  {
    name: "COLTRANE_GIT_CREDENTIALS_URL",
    host: "none",
    role: "tuning",
    required: "never",
    meaning:
      "Endpoint the worker asks for a short-lived git credential when cloning a lease's repository; unset outside a leased drain.",
  },
  {
    name: "COLTRANE_MODEL",
    host: "none",
    role: "tuning",
    required: "never",
    meaning:
      "Overrides the model version a chair invokes and is recorded on outputs as the model that produced them.",
  },
  {
    name: "COLTRANE_CHAIR_TIMEOUT_MS",
    host: "none",
    role: "tuning",
    required: "never",
    meaning:
      "Per-chair wall-clock timeout in milliseconds before a running chair invocation is abandoned.",
  },
  {
    name: "COLTRANE_GIG_TIMEOUT_MS",
    host: "none",
    role: "tuning",
    required: "never",
    meaning:
      "Overall wall-clock timeout in milliseconds for a single gig before the worker abandons it.",
  },
  {
    name: "COLTRANE_WORKER_CHECKPOINTS",
    host: "none",
    role: "tuning",
    required: "never",
    meaning:
      "Overrides the worker's checkpoint cadence, controlling how often in-progress run state is persisted to disk.",
  },
  {
    name: "COLTRANE_WORKER_STATE_TTL_DAYS",
    host: "none",
    role: "tuning",
    required: "never",
    meaning:
      "Days a worker retains persisted run state before it is considered stale and eligible for pruning.",
  },
  {
    name: "COLTRANE_TOOL_PROVIDERS",
    host: "none",
    role: "tuning",
    required: "never",
    meaning:
      "Comma-separated list of tool providers the worker is permitted to load, narrowing the tool surface a chair may reach.",
  },
];

/** The canonical service-url entry — the one host the legacy `COLTRANE_DRAIN_URL` normalizes onto. */
const SERVICE_URL = "COLTRANE_SERVICE_URL";
/** The canonical store-url entry — the database host, which must never be the same as the service. */
const STORE_URL = "COLTRANE_STORE_URL";
/** The legacy role-name that once held both meanings; now a normalized alias of the service url. */
const DRAIN_URL = "COLTRANE_DRAIN_URL";

/** The managed database's host shape. A service url naming this is the defect in its purest form. */
const MANAGED_DB_HOST = /(^|\.)supabase\.(co|in|net)$/i;

/** Parseable as an http(s) URL — the shape a `role: "url"` variable must have. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** The host a url addresses, or "" when it does not parse — for comparing two urls' hosts. */
function urlHost(value: string): string {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Strip the legacy `/rest/v1` suffix an origin may carry from when it named a database. Mirrors
 * `src/output_mirror.ts:317-320`: build from the ORIGIN, so a suffix that survives a redeploy can
 * never be appended-to and produce `/rest/v1/rest/v1`.
 */
function serviceOrigin(value: string): string {
  return value.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
}

/**
 * Normalize a worker environment onto its canonical shape — it NORMALIZES, it never appends.
 *
 *   * strips a legacy `/rest/v1` path suffix from the service url rather than building on top of it;
 *   * maps the legacy name (`COLTRANE_DRAIN_URL`) onto the canonical `COLTRANE_SERVICE_URL`;
 *   * treats the hosting provider's app name (`FLY_APP_NAME`) as a legacy alias of `COLTRANE_INSTANCE`;
 *   * is IDEMPOTENT — applying it to its own output changes nothing.
 *
 * The legacy keys are dropped from the output: a normalized environment carries only canonical
 * names, which is what makes re-application a no-op.
 */
export function normalizeWorkerEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }

  // A legacy name fills the canonical one only when the canonical is not already set, then is
  // dropped — mapping, not appending.
  const legacyService = out[DRAIN_URL];
  if (legacyService !== undefined && out[SERVICE_URL] === undefined) {
    out[SERVICE_URL] = legacyService;
  }
  delete out[DRAIN_URL];

  const legacyInstance = out["FLY_APP_NAME"];
  if (legacyInstance !== undefined && out["COLTRANE_INSTANCE"] === undefined) {
    out["COLTRANE_INSTANCE"] = legacyInstance;
  }
  delete out["FLY_APP_NAME"];

  const service = out[SERVICE_URL];
  if (service !== undefined) {
    out[SERVICE_URL] = serviceOrigin(service);
  }

  return out;
}

/**
 * Refuse a misconfigured worker at STARTUP, naming the offending variable in the error — never
 * silently picking a winner, and never learning it from a status code at the first write.
 *
 * Reads the RAW environment. The legacy-alias contradiction check in particular must NOT normalize
 * first: normalizing collapses `COLTRANE_DRAIN_URL` onto `COLTRANE_SERVICE_URL`, leaving nothing to
 * contradict — so the check would pass on exactly the environment it exists to refuse.
 */
export function assertWorkerEnv(env: Record<string, string | undefined>): void {
  // (a) Every always-required variable must be present. A legacy alias satisfies its canonical.
  for (const v of WORKER_ENV_CONTRACT) {
    if (v.required !== "always") continue;
    const present =
      env[v.name] ?? (v.legacy_names ?? []).map((n) => env[n]).find((x) => x != null && x !== "");
    if (present == null || present === "") {
      throw new Error(`${v.name} is required but absent — ${v.meaning}`);
    }
  }

  // (b) Every url-role variable that is present must actually be a url. Checked before any host
  // comparison so the parsing below is safe.
  for (const v of WORKER_ENV_CONTRACT) {
    if (v.role !== "url") continue;
    const value = env[v.name] ?? (v.legacy_names ?? []).map((n) => env[n]).find((x) => x != null);
    if (value != null && value !== "" && !isHttpUrl(value)) {
      throw new Error(`${v.name} is a url but does not parse as one: ${value}`);
    }
  }

  const serviceRaw = env[SERVICE_URL] ?? env[DRAIN_URL];
  const storeRaw = env[STORE_URL];

  // (c) The service url must not name the managed database — checked BEFORE the first request, the
  // diagnostic moved from output_mirror.ts to startup where it belongs.
  if (serviceRaw != null && serviceRaw !== "" && MANAGED_DB_HOST.test(urlHost(serviceRaw))) {
    throw new Error(
      `${SERVICE_URL} names the managed database (${serviceRaw}). It must name the Coltrane service, ` +
        "which brokers both halves of a write; a drain key is not a project credential and Storage will refuse it.",
    );
  }

  // (d) The store and the service must not name the same host — the general form of "pointed at the
  // database", detectable without knowing which of the two is wrong.
  if (
    serviceRaw != null &&
    serviceRaw !== "" &&
    storeRaw != null &&
    storeRaw !== "" &&
    urlHost(serviceRaw) !== "" &&
    urlHost(serviceRaw) === urlHost(storeRaw)
  ) {
    throw new Error(
      `${STORE_URL} and ${SERVICE_URL} name the same host (${urlHost(serviceRaw)}) — a store and a ` +
        "service are two hosts, and one url pointed at both is how three readers came to disagree.",
    );
  }

  // (e) A legacy alias that CONTRADICTS the canonical name refuses, naming both — read raw, because
  // normalization would erase the disagreement. Agreement is the ordinary post-redeploy case.
  const drainRaw = env[DRAIN_URL];
  const serviceCanonical = env[SERVICE_URL];
  if (
    drainRaw != null &&
    drainRaw !== "" &&
    serviceCanonical != null &&
    serviceCanonical !== "" &&
    serviceOrigin(drainRaw) !== serviceOrigin(serviceCanonical)
  ) {
    throw new Error(
      `${DRAIN_URL} (${drainRaw}) disagrees with ${SERVICE_URL} (${serviceCanonical}). ${DRAIN_URL} is a ` +
        `legacy alias of ${SERVICE_URL}; set one, or make them agree.`,
    );
  }
}
