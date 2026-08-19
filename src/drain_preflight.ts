// The drain's environment-contract PREFLIGHT — the checking half of the drain drill, and the one
// part of it that needs no credentials, no network, and no live run to exercise. It is the sibling
// of `assertWorkerEnv` in src/worker_env.ts: where that seat REFUSES a misconfigured worker at
// startup in its own voice, this seat COLLECTS what it finds — present / missing / suspicious — and
// hands an operator a report they can paste into an issue.
//
// FIVE VARIABLES, TWO ENDPOINTS. The drain reads five variables, and the split operators conflate is
// the two-endpoint one:
//   COLTRANE_STORE_URL   the Supabase project — the READ path (genome rows + claim RPCs)
//   COLTRANE_STORE_ANON  that project's public anon key
//   COLTRANE_DRAIN_URL   the COLTRANE SERVICE ORIGIN — the WRITE path (deployment-supplied)
//   COLTRANE_DRAIN_KEY   a per-ORGANIZATION cdk_ drain key (the org is the resource boundary)
//   COLTRANE_INSTANCE    the name bound into the key, gated against the gig lease
// STORE_URL and DRAIN_URL are DIFFERENT HOSTS with different roles (src/output_mirror.ts:239, :313;
// src/worker.ts:9-11). The preflight's primary suspicious case is exactly their conflation: a
// COLTRANE_DRAIN_URL whose host equals the COLTRANE_STORE_URL host — the write path aimed at the
// read endpoint.
//
// IT NEVER PUTS A SECRET IN ITS RESULT. The drain key is reported at most by its class prefix
// (`cdk_`), never its value; the anon key by presence only. A preflight report an operator cannot
// paste into an issue is one nobody will paste into an issue — so the report carries no secret to
// redact.
//
// This module reuses `normalizeWorkerEnv` (the one exported normalization) so the conflation check
// runs on the SAME canonical shape the worker path does — a legacy `/rest/v1` suffix on the store
// url cannot hide a real same-host conflation. It reads NO environment itself; the environment
// arrives as an argument.
import { normalizeWorkerEnv } from "./worker_env.js";

/** A variable that is set. For the drain key, `key_class` reports its class prefix — never its value. */
export interface PresentVar {
  variable: string;
  key_class?: string;
}

/** A required variable that is absent, named specifically so an operator knows which one to set. */
export interface MissingVar {
  variable: string;
}

/** A variable whose value looks wrong, with the operator-facing reason it looks wrong. */
export interface SuspiciousVar {
  variable: string;
  message: string;
}

/** What the preflight found: what is set, what is absent, and what looks misconfigured. */
export interface DrainPreflightResult {
  present: PresentVar[];
  missing: MissingVar[];
  suspicious: SuspiciousVar[];
}

/** The five operator-facing variables the drain reads, by the names an operator actually sets. */
const REQUIRED_VARS = [
  "COLTRANE_STORE_URL",
  "COLTRANE_STORE_ANON",
  "COLTRANE_DRAIN_URL",
  "COLTRANE_DRAIN_KEY",
  "COLTRANE_INSTANCE",
] as const;

/** The host a url addresses, lowercased — or "" when it is absent or does not parse. */
function urlHost(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Read the drain's five-variable environment contract from an env-like record and report what is
 * present, what is missing, and what is suspicious. A PURE COLLECTOR: it does no I/O, reads no
 * process.env, throws nothing, and never places a secret in its result.
 *
 * The primary suspicious case is the store/service conflation — a COLTRANE_DRAIN_URL whose host
 * equals the COLTRANE_STORE_URL host, meaning the write path is aimed at the read endpoint. Hosts
 * are compared on `normalizeWorkerEnv(env)` output (which maps the operator-facing COLTRANE_DRAIN_URL
 * onto the canonical COLTRANE_SERVICE_URL and strips a legacy `/rest/v1` suffix), so a surviving
 * suffix cannot mask a real same-host conflation. The finding is reported under the name the
 * operator set — COLTRANE_DRAIN_URL — not the internal canonical name.
 */
export function drainPreflight(env: Record<string, string | undefined>): DrainPreflightResult {
  const present: PresentVar[] = [];
  const missing: MissingVar[] = [];
  const suspicious: SuspiciousVar[] = [];

  for (const name of REQUIRED_VARS) {
    const value = env[name];
    if (value === undefined || value === "") {
      missing.push({ variable: name });
      continue;
    }
    if (name === "COLTRANE_DRAIN_KEY") {
      // The key's CLASS at most — never its value. Only a recognized `cdk_` prefix is reported.
      const entry: PresentVar = { variable: name };
      if (value.startsWith("cdk_")) entry.key_class = "cdk_";
      present.push(entry);
    } else {
      present.push({ variable: name });
    }
  }

  // The store/service conflation, on the normalized (canonical) shape: after normalizeWorkerEnv the
  // operator's COLTRANE_DRAIN_URL lives under COLTRANE_SERVICE_URL and any legacy `/rest/v1` suffix
  // is stripped, so equal hosts here mean the write path is genuinely aimed at the read endpoint.
  const normalized = normalizeWorkerEnv(env);
  const storeHost = urlHost(normalized["COLTRANE_STORE_URL"]);
  const drainHost = urlHost(normalized["COLTRANE_SERVICE_URL"]);
  if (storeHost !== "" && drainHost !== "" && storeHost === drainHost) {
    suspicious.push({
      variable: "COLTRANE_DRAIN_URL",
      message:
        `COLTRANE_DRAIN_URL host (${drainHost}) equals the COLTRANE_STORE_URL host — the write path is ` +
        `aimed at the read endpoint. COLTRANE_STORE_URL is the store (genome rows + claim RPCs); ` +
        `COLTRANE_DRAIN_URL must be the Coltrane service origin. They are different hosts.`,
    });
  }

  return { present, missing, suspicious };
}
