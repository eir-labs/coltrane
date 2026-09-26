// Shared fixture for the gig-runs-once battery (docs/specs/gig-runs-once.red-spec.json).
//
// ONE FAKE, TWO HOSTS, STATEFUL. The hosted drain speaks to two different origins and the defect
// lives in the join between them, so the fake keeps them apart by HOST rather than by path suffix:
//
//   STORE  (ctx.baseUrl)        /rest/v1/rpc/coltrane_drain_claim · coltrane_mcp_genome ·
//                               coltrane_mcp_gig_status · coltrane_mcp_gig_outputs · coltrane_mcp_gig_fail
//   DRAIN SERVICE (COLTRANE_DRAIN_URL)
//                               /rest/v1/coltrane_gigs (the header) · /rest/v1/coltrane_outputs ·
//                               /storage/v1/object/... · the lease RPCs (renew / release)
//
// It is STATEFUL on purpose: a header the drain service ACKNOWLEDGED is what coltrane_mcp_gig_status
// answers later, and an output row it acknowledged is what coltrane_mcp_gig_outputs answers later. A
// re-claim law (E6) is only honest if the second worker reads what the first one actually wrote —
// a fake that hands the second worker a hand-written header would pass whatever the first worker did.
//
// New symbols (src/lease.ts, WorkOnceDeps.scheduleHeartbeat, WorkOnceResult.acknowledged) are reached
// through variable specifiers and casts: vitest's globalSetup runs tsc over tests/, and a static import
// of a missing symbol would take every band down with it instead of failing on its own line.
import { vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerContext } from "../src/worker.js";

export const STORE = "https://store.example";
export const DRAIN_ORIGIN = "https://coltrane.example";
export const DRAIN_KEY = "cdk_venue_gig_runs_once";
export const INSTANCE = "coltrane-drain-gig-runs-once";
export const GIG_ID = "99999999-8888-7777-6666-555555555555";

/** The lease module the contract names. Loaded by a variable specifier (see header). */
export const LEASE_MODULE = "../src/lease.js";
export interface LeaseModule {
  HOSTED_LEASE_MS: number;
  DRAIN_LEASE_ROUTES: { renew: string; release: string };
}
export const loadLease = async (): Promise<LeaseModule> =>
  (await import(/* @vite-ignore */ LEASE_MODULE)) as unknown as LeaseModule;

export const venueCtx = (): WorkerContext => ({
  baseUrl: STORE,
  anonKey: "anon-key",
  agentToken: "",
  drainKey: DRAIN_KEY,
  instance: INSTANCE,
  worker: "gig-runs-once",
});

const scout = {
  slug: "scout",
  primitives: ["SENSE"],
  input_types: ["Signal"],
  output_types: ["Signal"],
  domain: "demo",
  identity: "you are scout",
  method: "1. look 2. report 3. stop",
  constraints: [],
  behavioral_primitives: ["explorer", "critic"],
  permissions: {},
  default_skills: [],
};
const chair = (role: string, deps: string[], input: string[]) => ({
  role, agent_slug: "scout", depends_on: deps, input_contract: input, output_contract: ["Signal"],
  optional_outputs: [], required_skills: [],
});

export const GENOME_ROWS = {
  core_types: [],
  domain_types: [],
  agents: [scout],
  standards: [
    // one model chair
    { slug: "one-chair-v0", domain: "demo", status: "active", phases: [{ name: "scan", chairs: [chair("scan", [], [])] }], output_types: ["Signal"] },
    // two model chairs in sequence — the second one is what a lost lease must never reach
    {
      slug: "two-chair-v0", domain: "demo", status: "active",
      phases: [
        { name: "scan", chairs: [chair("scan", [], [])] },
        { name: "rescan", chairs: [chair("rescan", ["scan"], ["Signal"])] },
      ],
      output_types: ["Signal"],
    },
    // three model chairs in sequence: a closed gig seals the first, its resumer the second, and the
    // resumer's re-claim must pay only for the third
    {
      slug: "three-chair-v0", domain: "demo", status: "active",
      phases: [
        { name: "scan", chairs: [chair("scan", [], [])] },
        { name: "rescan", chairs: [chair("rescan", ["scan"], ["Signal"])] },
        { name: "final", chairs: [chair("final", ["rescan"], ["Signal"])] },
      ],
      output_types: ["Signal"],
    },
    // a human chair only — completes with ZERO model invocations when the claim carries its approval,
    // which is what lets the CLI law run `coltrane work` end to end with the real chair invoker
    {
      slug: "human-only-v0", domain: "demo", status: "active",
      phases: [{
        name: "approve",
        chairs: [{ role: "approve", human: true, agent_slug: "", depends_on: [], input_contract: [], output_contract: ["Judgment"], optional_outputs: [], required_skills: [] }],
      }],
      output_types: ["Judgment"],
    },
  ],
  skills: [],
  venues: [],
  charts: [],
};

export const VERDICT = {
  id: "approval-1", input_refs: [],
  criteria: ["the boundary is right"],
  verdicts: [{ criterion: "the boundary is right", verdict: "approved" }],
  reasoning_chain: ["read it; it is right"],
};

/** A claim as coltrane_drain_claim answers it. The minted token is SCOPED TO THIS GIG (ctk_<gig id>),
 *  as the live store mints it. The fake store below enforces that scope (see `scopeRefusal`). */
export const claimFor = (standard_slug: string, extra: Record<string, unknown> = {}) => {
  const c: Record<string, unknown> = {
    gig_id: GIG_ID,
    standard_slug,
    standard_version: null,
    mode: "rehearsal",
    input: { subject: "the wire" },
    acting_for: "steve-1",
    ...extra,
  };
  if (!("token" in extra)) c["token"] = `ctk_${String(c["gig_id"])}`;
  return c;
};

/**
 * THE DRAIN SERVICE'S REAL REFUSAL SHAPE (eir-labs/coltrane-ui main: src/lib/drain-service.ts
 * `drainErrorStatus`, and the route at src/app/rest/v1/coltrane_gigs/route.ts). The body is
 * `{ error: <the store's message> }` with NO `code`, and the status is decided by the message
 * text alone: invalid/revoked key → 401, "lacks drain:write" or "no live lease" → 403, and
 * EVERYTHING ELSE → 400. That includes the terminal guard, whose 23514 reaches the engine as a
 * plain 400 with no code.
 *
 * The first fixture answered 409 with a `code`, which is a shape the service never produces, and
 * that is how a refused start header went unrecognised while every law stayed green (review
 * 5326196799, finding 3).
 */
export function drainServiceRefusal(message: string): Response {
  const status = /invalid or revoked drain key/i.test(message) ? 401
    : /lacks drain:write|no live lease/i.test(message) ? 403
    : 400;
  return new Response(JSON.stringify({ error: message }), { status });
}

export const sealableSignal = { id: "sig-1", source: "test", data: { seen: true }, completeness: 1, acquisition_cost: 0 };

export interface Call {
  seq: number;
  host: "store" | "drain" | "other";
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

type Answer = Response | Promise<Response>;

export interface HostedOpts {
  /** What coltrane_drain_claim answers. A function lets a law change the answer between claims. */
  claim: unknown | (() => unknown);
  /** The header route. Default: 201 and the row is merged into `gigs`. `attempt` counts POSTs of the
   *  same status for the gig, 1-based, so a law can fail the first N tries. */
  header?: ((body: Record<string, unknown>, attempt: number) => Answer | undefined) | undefined;
  /** The output-row route. Default: 201 and the row lands in `outputs`. `attempt` counts POSTs of the
   *  same output id, 1-based. Only an ACKNOWLEDGED row lands. */
  outputs?: ((body: Record<string, unknown>, attempt: number) => Answer | undefined) | undefined;
  renew?: (body: Record<string, unknown>) => Answer;
  release?: (body: Record<string, unknown>) => Answer;
  gigFail?: () => Answer;
}

export interface HostedStore {
  calls: Call[];
  /** The gig rows as the store holds them — only ACKNOWLEDGED header writes land here. */
  gigs: Map<string, Record<string, unknown>>;
  /** Output rows the drain service ACKNOWLEDGED, in the projection coltrane_mcp_gig_outputs answers. */
  outputs: Array<Record<string, unknown>>;
  /** Replace the options between two workOnce calls (a re-claim by a second worker). */
  set(next: Partial<HostedOpts>): void;
  /** Calls to the drain service's header route. */
  headers(): Call[];
  renews(): Call[];
  /** Calls to the drain service's output-row route. */
  outputRows(): Call[];
  releases(): Call[];
}

const ok = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

export function hostedStore(initial: HostedOpts): HostedStore {
  let opts: HostedOpts = { ...initial };
  const calls: Call[] = [];
  const gigs = new Map<string, Record<string, unknown>>();
  const outputs: Array<Record<string, unknown>> = [];
  const attempts = new Map<string, number>();
  let seq = 0;
  // THE STORE'S SCOPE RULES for a gig-scoped token, enforced here because the first fixture
  // answered for ANY gig and was blind to review 5326196799 finding 1.
  //
  // THIS MIRRORS THE coltrane-ui FOLLOW-UP, NOT #250 AS MERGED. #250 put the read-only resume
  // exception in coltrane_mcp_gig_outputs alone. The conductor's D1 decision widens it, in a
  // coltrane-ui law and migration, to coltrane_mcp_gig_STATUS for exactly the gig the token's row
  // resumes, mirroring outputs. Until that deploys, the live store still refuses the status read.
  //   READS  (status, outputs): the token's own gig, plus exactly the gig its row `resumes`.
  //   WRITES (gig_fail, gig_park): the token's own gig only.
  //   Anything else: 42501 "scoped to a single gig", answered PostgREST-style (403 + {code, message}).
  // A token this store never minted for a gig, such as a player's own token, is not gig-scoped and
  // passes.
  const gigTokens = new Map<string, { gig: string; resumes: string | null }>();
  const scopeRefusal = (body: Record<string, unknown>, what: "read" | "own"): Response | undefined => {
    const scope = gigTokens.get(String(body["p_bearer"] ?? ""));
    if (!scope) return undefined;
    const gig = String(body["p_gig"]);
    if (gig === scope.gig) return undefined;
    if (what === "read" && scope.resumes !== null && gig === scope.resumes) return undefined;
    return new Response(JSON.stringify({ code: "42501", message: "gig token is scoped to a single gig" }), { status: 403 });
  };

  const fetchFake = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const origin = `${u.protocol}//${u.host}`;
    const host: Call["host"] = origin === STORE ? "store" : origin === DRAIN_ORIGIN ? "drain" : "other";
    let body: Record<string, unknown> = {};
    try {
      const parsed = init?.body ? (JSON.parse(String(init.body)) as unknown) : {};
      body = (Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed) as Record<string, unknown>;
    } catch { /* not JSON */ }
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const call: Call = { seq: seq++, host, path: u.pathname, body, headers };
    calls.push(call);

    if (host === "store") {
      const fn = u.pathname.replace(/^\/rest\/v1\/rpc\//, "");
      if (fn === "coltrane_drain_claim" || fn === "coltrane_mcp_claim") {
        const c = typeof opts.claim === "function" ? (opts.claim as () => unknown)() : opts.claim;
        if (fn === "coltrane_drain_claim" && c && typeof c === "object") {
          const cc = c as Record<string, unknown>;
          if (typeof cc["token"] === "string") {
            gigTokens.set(cc["token"], { gig: String(cc["gig_id"]), resumes: typeof cc["resumes"] === "string" ? cc["resumes"] : null });
          }
        }
        return ok(c ?? null);
      }
      if (fn === "coltrane_mcp_genome") return ok(GENOME_ROWS);
      if (fn === "coltrane_mcp_gig_status") {
        const refused = scopeRefusal(body, "read");
        if (refused) return refused;
        const row = gigs.get(String(body["p_gig"]));
        return ok(row ?? null);
      }
      if (fn === "coltrane_mcp_gig_outputs") {
        const refused = scopeRefusal(body, "read");
        if (refused) return refused;
        return ok(outputs.filter((o) => o["gig_id"] === body["p_gig"]));
      }
      if (fn === "coltrane_mcp_gig_fail") {
        const refused = scopeRefusal(body, "own");
        if (refused) return refused;
        return opts.gigFail ? await opts.gigFail() : ok(true);
      }
      if (fn === "coltrane_mcp_gig_park") {
        const refused = scopeRefusal(body, "own");
        if (refused) return refused;
        return ok(true);
      }
      return new Response(`unexpected store rpc ${fn}`, { status: 500 });
    }

    if (host === "drain") {
      if (u.pathname === "/rest/v1/coltrane_gigs") {
        const key = `${String(body["id"])}:${String(body["status"])}`;
        const n = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, n);
        const custom = opts.header?.(body, n);
        const res = custom ? await custom : ok(null, 201);
        if (res.ok) {
          const id = String(body["id"]);
          const prior = gigs.get(id) ?? {};
          // merge semantics, manifest merged too — what the store seat is adding
          const manifest = { ...((prior["manifest"] as Record<string, unknown>) ?? {}), ...((body["manifest"] as Record<string, unknown>) ?? {}) };
          const merged: Record<string, unknown> = { ...prior };
          for (const [k, v] of Object.entries(body)) if (v !== null && v !== undefined) merged[k] = v;
          merged["manifest"] = manifest;
          gigs.set(id, merged);
        }
        return res;
      }
      if (u.pathname === "/rest/v1/coltrane_outputs") {
        const okey = `output:${String(body["id"])}`;
        const on = (attempts.get(okey) ?? 0) + 1;
        attempts.set(okey, on);
        const custom = opts.outputs?.(body, on);
        const res = custom ? await custom : ok(null, 201);
        if (!res.ok) return res;
        outputs.push({
          id: body["id"], gig_id: body["gig_id"], domain_type: body["domain_type"], agent_slug: body["agent_slug"],
          phase: body["phase"], content_sha: body["content_sha"], input_shas: body["input_shas"],
          created_at: body["created_at"], data: body["data"],
        });
        return res;
      }
      if (u.pathname.startsWith("/storage/v1/object/")) return ok(null, 200);
      if (u.pathname.endsWith("/coltrane_drain_renew")) {
        return opts.renew ? await opts.renew(body) : ok(new Date(Date.now() + 3_600_000).toISOString());
      }
      if (u.pathname.endsWith("/coltrane_drain_release")) {
        return opts.release ? await opts.release(body) : ok(true);
      }
      return new Response(`unexpected drain path ${u.pathname}`, { status: 404 });
    }
    return new Response(`unexpected url ${String(url)}`, { status: 500 });
  });
  vi.stubGlobal("fetch", fetchFake);

  const onDrain = (pred: (c: Call) => boolean) => () => calls.filter((c) => c.host === "drain" && pred(c));
  return {
    calls,
    gigs,
    outputs,
    set(next) { opts = { ...opts, ...next }; },
    headers: onDrain((c) => c.path === "/rest/v1/coltrane_gigs"),
    renews: onDrain((c) => c.path.endsWith("/coltrane_drain_renew")),
    outputRows: onDrain((c) => c.path === "/rest/v1/coltrane_outputs"),
    releases: onDrain((c) => c.path.endsWith("/coltrane_drain_release")),
  };
}

/** Environment + state root for one law. Returns a cleanup. */
export function hostedEnv(): { stateRoot: string; cleanup(): void } {
  const stateRoot = mkdtempSync(join(tmpdir(), "coltrane-runs-once-"));
  const saved: Record<string, string | undefined> = {};
  const set = (k: string, v: string | undefined) => {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  set("COLTRANE_WORKER_CHECKPOINTS", stateRoot);
  set("COLTRANE_DRAIN_URL", DRAIN_ORIGIN);
  set("COLTRANE_DRAIN_KEY", DRAIN_KEY);
  set("COLTRANE_INSTANCE", INSTANCE);
  set("COLTRANE_DRAIN_DEBUG", undefined);
  set("COLTRANE_DRAIN_PG", undefined);
  set("COLTRANE_GIG_TIMEOUT_MS", undefined);
  return {
    stateRoot,
    cleanup() {
      vi.unstubAllGlobals();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}

/** Rows the worker sealed locally for a gig (its durable output store). */
export function sealedLocally(stateRoot: string, gig_id: string): Array<Record<string, unknown>> {
  const p = join(stateRoot, "outputs", `${gig_id}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Let fire-and-forget drains that WERE started settle, so a law observes what was sent. */
export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** A delayed acknowledgement: resolves `ms` later and flips `flag.done` at that moment. */
export function lateAck(flag: { done: boolean }, ms = 60, status = 201): Promise<Response> {
  return new Promise((resolve) => setTimeout(() => { flag.done = true; resolve(new Response("null", { status })); }, ms));
}

export const TERMINAL = new Set(["completed", "complete", "failed", "aborted"]);
