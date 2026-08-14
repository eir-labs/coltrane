// Two-tier output persistence + retrieval — the reliable local mirror MCP traverses.
//
// The bug this closes: a CLI-dispatched gig sealed outputs to disk, but the payloads were not
// reliably retrievable through the MCP surface. This module makes every sealed output land in a
// content-addressed local store under `.coltrane/` (gitignored) that MCP reads seamlessly with
// NO remote configured, and — only when an append credential is present — ALSO drains the same
// record to a remote row + artifact store.
//
// Two tiers, by design:
//   • TIER 1 — a compact, queryable METADATA row, ALWAYS. id, gig_id, agent, phase, primitive,
//     domain_type, content_sha, a short preview, a storage_ref, cost/tokens, created_at. This
//     alone supports high-level traversal (`output_query`/`output_trace`) without loading a
//     single payload.
//   • TIER 2 — the full PAYLOAD, as a content-addressed artifact, fetched only on the deeper
//     second pass (`readPayload`, or `output_query { include_data:true }`).
//
// OSS stays pure: with no drain credential in the environment, ONLY the local tier runs and no
// new npm dependency is touched (the remote row goes over `fetch`; the optional Postgres path is
// a guarded dynamic import that is never reached unless a PG connection string is set).
import * as fs from "node:fs";
import * as path from "node:path";
import type { OutputRecord } from "./outputs.js";

// TIER 1 — the compact metadata row. Deliberately does NOT carry `data`: a caller traversing the
// chain reads these; the payload is a second, explicit fetch.
export interface OutputMeta {
  id: string;
  gig_id: string;
  agent_slug: string;
  from_role?: string | undefined;
  phase?: string | undefined;
  primitive: string;
  core_type: string;
  domain_type: string;
  domain_type_version: number;
  domain: string;
  content_sha: string;
  input_refs: string[];
  input_shas: string[];
  cost_usd?: number | undefined;
  tokens_used?: number | undefined;
  duration_ms?: number | undefined;
  model?: string | undefined;
  model_tier?: string | undefined;
  created_at: string;
  /** A short human/agent-readable summary of the payload, so a high-level scan need not open the artifact. */
  preview: string;
  /** Where the full payload lives — a repo-relative path locally, a storage URL when drained. */
  storage_ref: string;
}

export interface OutputMirror {
  /** The mirror's on-disk root (e.g. `<genomeRoot>/.coltrane`). */
  readonly root: string;
  /** Persist a sealed output: Tier-1 meta row + Tier-2 artifact locally, and drain to remote when configured. */
  persist(rec: OutputRecord): void;
  /** Tier-1 traversal — a FRESH disk read (no in-process staleness), optionally scoped to one gig. */
  queryMeta(filter?: { gig_id?: string | undefined }): OutputMeta[];
  /** Tier-2 second pass — the full payload for a single output, by id or content_sha. */
  readPayload(sel: { id?: string | undefined; content_sha?: string | undefined }): { meta?: OutputMeta | undefined; data?: Record<string, unknown> | undefined } | undefined;
}

const ARTIFACT_SUBDIR = path.join("outputs", "artifacts");
const META_SUBDIR = path.join("outputs", "meta");

// Where the local mirror lives. `COLTRANE_MIRROR_DIR` overrides (tests, sandboxes); otherwise
// `<genomeRoot>/.coltrane` — beside the ledger, gitignored, so a CLI and an MCP server rooted at
// the same repo share one store and MCP retrieval traverses exactly what the CLI sealed.
export function defaultMirrorDir(root?: string): string {
  const override = process.env["COLTRANE_MIRROR_DIR"];
  if (override && override.length > 0) return override;
  return path.join(root ?? process.cwd(), ".coltrane");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function appendJsonl(file: string, row: unknown): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

// A short, deterministic summary of the payload for the Tier-1 row. Never throws.
export function outputPreview(data: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(data);
    return s.length <= 200 ? s : s.slice(0, 197) + "...";
  } catch {
    return "";
  }
}
const makePreview = outputPreview;

/** The repo-relative artifact path for a content_sha — the Tier-1 row's local `storage_ref`. */
export function mirrorStorageRef(content_sha: string): string {
  return path.join(ARTIFACT_SUBDIR, `${content_sha.replace(/[^0-9a-zA-Z._-]/g, "_")}.json`);
}

function metaOf(rec: OutputRecord, storage_ref: string): OutputMeta {
  return {
    id: rec.id,
    gig_id: rec.gig_id,
    agent_slug: rec.agent_slug,
    from_role: rec.from_role,
    phase: rec.phase,
    primitive: rec.primitive,
    core_type: rec.core_type,
    domain_type: rec.domain_type,
    domain_type_version: rec.domain_type_version,
    domain: rec.domain,
    content_sha: rec.content_sha,
    input_refs: rec.input_refs,
    input_shas: rec.input_shas,
    cost_usd: rec.cost_usd,
    tokens_used: rec.tokens_used,
    duration_ms: rec.duration_ms,
    model: rec.model,
    model_tier: rec.model_tier,
    created_at: rec.created_at,
    preview: makePreview(rec.data),
    storage_ref,
  };
}

function readJsonlRows<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const rows: T[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as T);
    } catch {
      // Forgiving read (a torn append should not take the whole traversal offline). The
      // store's own `integrity()` is the surface that REPORTS damage; here we keep serving.
    }
  }
  return rows;
}

export function createOutputMirror(mirrorRoot: string): OutputMirror {
  const artifactsDir = path.join(mirrorRoot, ARTIFACT_SUBDIR);
  const metaDir = path.join(mirrorRoot, META_SUBDIR);

  function artifactPath(content_sha: string): string {
    // Content-addressed: a filename-safe form of the sha. Two byte-identical payloads dedupe.
    const safe = content_sha.replace(/[^0-9a-zA-Z._-]/g, "_");
    return path.join(artifactsDir, `${safe}.json`);
  }

  const storageRef = mirrorStorageRef;

  function writeArtifact(rec: OutputRecord): void {
    const file = artifactPath(rec.content_sha);
    // Content-addressed → if it already exists, the bytes are identical; skip the rewrite.
    if (fs.existsSync(file)) return;
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ content_sha: rec.content_sha, id: rec.id, data: rec.data }), "utf8");
  }

  function metaFile(gig_id: string): string {
    return path.join(metaDir, `${gig_id}.jsonl`);
  }

  return {
    root: mirrorRoot,

    persist(rec) {
      const ref = storageRef(rec.content_sha);
      // TIER 2 first, so the Tier-1 row never points at an artifact that is not there yet.
      writeArtifact(rec);
      // TIER 1 — the always-on compact row.
      appendJsonl(metaFile(rec.gig_id), metaOf(rec, ref));
      // REMOTE, credential-gated. Fire-and-forget: a finished gig is not failed because a
      // remote append could not be reached. OSS with no credential never enters this path.
      if (remoteConfigured()) {
        // ALWAYS warned, not gated behind COLTRANE_DRAIN_DEBUG. A remote append that fails is not
        // a cosmetic loss: the gig header never completes, its lease expires, and the store hands
        // the same work to the next drain — which runs it and pays for it again. Silence here buys
        // a tidy log and costs an unbounded loop, which is the wrong trade in every direction.
        void drainRemote(rec).catch((e) => {
          console.warn(`[output_mirror] remote drain FAILED — this gig will be re-run: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    },

    queryMeta(filter) {
      // A FRESH read every call — this is what makes a long-lived MCP server see a gig sealed by
      // a separate CLI process. No `fullyHydrated`-style latch lives here on purpose.
      if (!fs.existsSync(metaDir)) return [];
      const gigId = filter?.gig_id;
      const files = gigId
        ? [metaFile(gigId)]
        : fs.readdirSync(metaDir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(metaDir, f));
      const out: OutputMeta[] = [];
      for (const file of files) out.push(...readJsonlRows<OutputMeta>(file));
      return out;
    },

    readPayload(sel) {
      let content_sha = sel.content_sha;
      let meta: OutputMeta | undefined;
      if (!content_sha && sel.id) {
        // Resolve id → content_sha via the Tier-1 rows (fresh scan).
        meta = this.queryMeta().find((m) => m.id === sel.id);
        content_sha = meta?.content_sha;
      } else if (content_sha) {
        meta = this.queryMeta().find((m) => m.content_sha === content_sha);
      }
      if (!content_sha) return undefined;
      const file = artifactPath(content_sha);
      if (fs.existsSync(file)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { data?: Record<string, unknown> };
          return { meta, data: parsed.data };
        } catch {
          return { meta };
        }
      }
      // Local miss — the artifact may live only in the remote store (a mirror pulled from a peer).
      // Best-effort remote fetch when configured; otherwise nothing to return.
      return meta ? { meta } : undefined;
    },
  };
}

// ── REMOTE TIER — append-only, credential-gated. Never a service_role key (see the TODO). ──────
//
// Two credential shapes are accepted, whichever is present drives the write:
//   (a) COLTRANE_DRAIN_KEY  — a per-consumer ISSUED, scoped append key. The Tier-1 row is POSTed
//       to PostgREST (`coltrane_outputs`) and the Tier-2 payload uploaded to Storage, both with
//       this key. Uses `fetch` only — no new npm dependency.
//   (b) COLTRANE_DRAIN_PG   — a Postgres connection string for a scoped append role. The row is
//       written over a direct `pg` connection (a guarded dynamic import; `pg` is NOT a declared
//       dependency, so this path is unreachable — and harmless — unless the operator both sets
//       the env AND installs the driver).
//
// COLTRANE_DRAIN_URL is the PostgREST + Storage project base URL (deployment-supplied, no host
// baked in here) for the (a) REST paths. COLTRANE_DRAIN_BUCKET names the Storage bucket
// (default "coltrane-artifacts").
function remoteConfigured(): boolean {
  return Boolean(process.env["COLTRANE_DRAIN_KEY"] || process.env["COLTRANE_DRAIN_PG"]);
}

function drainBody(rec: OutputRecord): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: rec.id,
    gig_id: rec.gig_id,
    agent_slug: rec.agent_slug,
    phase: rec.phase,
    primitive: rec.primitive,
    core_type: rec.core_type,
    domain_type: rec.domain_type,
    domain_type_version: rec.domain_type_version,
    domain: rec.domain,
    content_sha: rec.content_sha,
    data: rec.data,
    input_shas: rec.input_shas,
    cost_usd: rec.cost_usd,
    tokens_used: rec.tokens_used,
    duration_ms: rec.duration_ms,
    created_at: rec.created_at,
  };
  return body;
}

async function drainRemote(rec: OutputRecord): Promise<void> {
  const key = process.env["COLTRANE_DRAIN_KEY"];
  if (key) {
    await drainViaPostgrest(rec, key);
    return;
  }
  const pgConn = process.env["COLTRANE_DRAIN_PG"];
  if (pgConn) {
    await drainViaPg(rec, pgConn);
    return;
  }
}

/**
 * PostgREST's own gate, which is NOT the drain credential.
 *
 * A Supabase project rejects any request without a valid project `apikey`, whatever else it
 * carries. The drain key is an APPLICATION credential — it authenticates inside a SECURITY DEFINER
 * function, against `coltrane_drain_key`, and PostgREST has never heard of it.
 *
 * Conflating the two is what made every drained result vanish: the mirror posted straight at
 * `/rest/v1/coltrane_outputs` with the drain key as `apikey`, PostgREST answered 401, and the
 * failure was swallowed unless COLTRANE_DRAIN_DEBUG happened to be set. The gig stayed `running`,
 * its lease expired, and the work was reclaimed and paid for again — silently, forever.
 */
function storeApiKey(): string {
  const k = process.env["COLTRANE_STORE_ANON"] ?? process.env["COLTRANE_DRAIN_ANON"] ?? "";
  if (!k) {
    throw new Error(
      "COLTRANE_STORE_ANON is required to reach the store: the drain key authenticates inside the " +
        "definer RPC, it is not a project API key",
    );
  }
  return k;
}

/** POST a definer RPC with both credentials in their proper places. */
async function drainRpc(fn: string, body: Record<string, unknown>): Promise<Response> {
  const base = (process.env["COLTRANE_DRAIN_URL"] ?? "").replace(/\/$/, "");
  if (!base) throw new Error("COLTRANE_DRAIN_KEY is set but COLTRANE_DRAIN_URL (project base) is missing");
  return fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: storeApiKey(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function drainViaPostgrest(rec: OutputRecord, key: string): Promise<void> {
  const base = (process.env["COLTRANE_DRAIN_URL"] ?? "").replace(/\/$/, "");
  if (!base) throw new Error("COLTRANE_DRAIN_KEY is set but COLTRANE_DRAIN_URL (project base) is missing");
  // TIER 1 — through the definer RPC, which is the surface built for exactly this. Writing the
  // table directly required the drain key to BE a project API key; it is not, and never was.
  const rowRes = await drainRpc("coltrane_drain_ingest", { p_token: key, p_rows: [drainBody(rec)] });
  if (!rowRes.ok) {
    throw new Error(`coltrane_drain_ingest ${rowRes.status}: ${(await rowRes.text()).slice(0, 200)}`);
  }
  // TIER 2 — the payload artifact into Storage, content-addressed by sha (idempotent upsert).
  const bucket = process.env["COLTRANE_DRAIN_BUCKET"] ?? "coltrane-artifacts";
  const objectPath = `${rec.gig_id}/${rec.content_sha}.json`;
  const artRes = await fetch(`${base}/storage/v1/object/${bucket}/${objectPath}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "x-upsert": "true",
    },
    body: JSON.stringify({ content_sha: rec.content_sha, id: rec.id, data: rec.data }),
  });
  // A duplicate object (already uploaded for this sha) is success, not failure.
  if (!artRes.ok && artRes.status !== 409) throw new Error(`storage POST ${artRes.status}`);
}

async function drainViaPg(rec: OutputRecord, conn: string): Promise<void> {
  // Guarded dynamic import — `pg` is intentionally NOT a declared dependency, so the string is
  // indirected to keep tsc from resolving it, and any failure to load surfaces as a drain error
  // (fire-and-forget at the call site) rather than a hard crash.
  const moduleName = "pg";
  let pg: unknown;
  try {
    pg = await import(moduleName);
  } catch {
    throw new Error(
      "COLTRANE_DRAIN_PG is set but the 'pg' driver is not installed — install it in the consuming " +
        "deployment, or use COLTRANE_DRAIN_KEY (PostgREST) instead. OSS ships no pg dependency.",
    );
  }
  const Client = (pg as { Client?: new (c: { connectionString: string }) => PgClient }).Client;
  if (!Client) throw new Error("'pg' loaded but exposes no Client");
  const client = new Client({ connectionString: conn });
  await client.connect();
  try {
    const b = drainBody(rec);
    await client.query(
      `insert into coltrane_outputs
         (id, gig_id, agent_slug, phase, primitive, domain_type, domain_type_version, domain, content_sha, data, input_shas, cost_usd, tokens_used, duration_ms, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict (id) do nothing`,
      [
        b["id"], b["gig_id"], b["agent_slug"], b["phase"], b["primitive"], b["domain_type"],
        b["domain_type_version"], b["domain"], b["content_sha"], JSON.stringify(b["data"]),
        b["input_shas"], b["cost_usd"], b["tokens_used"], b["duration_ms"], b["created_at"],
      ],
    );
  } finally {
    await client.end();
  }
}

interface PgClient {
  connect(): Promise<void>;
  query(text: string, values: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

// ── The gig-HEADER drain ──────────────────────────────────────────────────────────────────
// Outputs drained but the gig row didn't: the sink's queue table held service-fabricated
// stubs for every real run — sealed outputs hanging off a header that said nothing true
// about the run. On a terminal state the runtime hands this seam the run's own record and
// the stub is replaced (merge semantics) with the real standard, status, spend, timestamps,
// and reproducibility keys. Fire-and-forget like the output drain: a sink outage degrades
// the mirror, never the run.

/** The slice of the run's terminal state the sink's gig row wants. */
export interface GigHeaderRecord {
  gig_id: string;
  standard_slug: string;
  status: "complete" | "failed" | "aborted" | "awaiting_approval";
  genome_hash?: string;
  run_fingerprint?: string;
  started_at?: string;
  finished_at?: string;
  outputs_count?: number;
  usage?: { total_cost_usd?: number; input_tokens?: number; output_tokens?: number } | undefined;
  error?: string;
}

/** The sink row, derived entirely from the run's own record (engine "complete" → sink "completed"). */
export function gigHeaderBody(rec: GigHeaderRecord): Record<string, unknown> {
  const started = rec.started_at ? Date.parse(rec.started_at) : NaN;
  const finished = rec.finished_at ? Date.parse(rec.finished_at) : NaN;
  const duration = Number.isFinite(started) && Number.isFinite(finished) ? finished - started : null;
  const tokens =
    rec.usage && (rec.usage.input_tokens !== undefined || rec.usage.output_tokens !== undefined)
      ? (rec.usage.input_tokens ?? 0) + (rec.usage.output_tokens ?? 0)
      : null;
  const manifest: Record<string, unknown> = {};
  if (rec.outputs_count !== undefined) manifest["output_count"] = rec.outputs_count;
  if (rec.error !== undefined) manifest["error"] = rec.error;
  return {
    id: rec.gig_id,
    standard_slug: rec.standard_slug,
    status: rec.status === "complete" ? "completed" : rec.status,
    genome_hash: rec.genome_hash ?? null,
    run_fingerprint: rec.run_fingerprint ?? null,
    started_at: rec.started_at ?? null,
    completed_at: rec.finished_at ?? null,
    total_cost_usd: rec.usage?.total_cost_usd ?? null,
    total_tokens: tokens,
    total_duration_ms: duration,
    manifest,
  };
}

/** Drain the header. Silent no-op when no drain credential is configured. */
export async function drainGigHeader(rec: GigHeaderRecord): Promise<void> {
  if (!remoteConfigured()) return;
  const key = process.env["COLTRANE_DRAIN_KEY"];
  if (key) {
    const res = await drainRpc("coltrane_drain_upsert_gig", { p_token: key, p_gig: gigHeaderBody(rec) });
    if (!res.ok) {
      throw new Error(`coltrane_drain_upsert_gig ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return;
  }
  const pgConn = process.env["COLTRANE_DRAIN_PG"];
  if (pgConn) {
    const moduleName = "pg";
    const pg = (await import(moduleName)) as { Client?: new (c: { connectionString: string }) => PgClient };
    if (!pg.Client) throw new Error("'pg' loaded but exposes no Client");
    const client = new pg.Client({ connectionString: pgConn });
    await client.connect();
    try {
      const b = gigHeaderBody(rec);
      await client.query(
        `insert into coltrane_gigs (id, standard_slug, status, genome_hash, run_fingerprint, started_at, completed_at, total_cost_usd, total_tokens, total_duration_ms, manifest)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (id) do update set
           standard_slug = excluded.standard_slug, status = excluded.status,
           genome_hash = excluded.genome_hash, run_fingerprint = excluded.run_fingerprint,
           started_at = excluded.started_at, completed_at = excluded.completed_at,
           total_cost_usd = excluded.total_cost_usd, total_tokens = excluded.total_tokens,
           total_duration_ms = excluded.total_duration_ms, manifest = excluded.manifest`,
        [
          b["id"], b["standard_slug"], b["status"], b["genome_hash"], b["run_fingerprint"],
          b["started_at"], b["completed_at"], b["total_cost_usd"], b["total_tokens"],
          b["total_duration_ms"], JSON.stringify(b["manifest"]),
        ],
      );
    } finally {
      await client.end();
    }
  }
}

// TODO(scoped-credential): the remote tier expects an APPEND-ONLY credential — either a
// per-consumer issued key (COLTRANE_DRAIN_KEY) whose grant is exactly "insert a coltrane_outputs
// row + upload an artifact object" and nothing else, or a Postgres role (COLTRANE_DRAIN_PG)
// scoped to INSERT on coltrane_outputs only. A service_role key MUST NOT be used here. Issuing
// that scoped credential (a Supabase RLS insert policy for the key's role, and a Storage bucket
// policy allowing upsert to the artifacts bucket) is deployment work that lives outside this OSS
// repo; this module only consumes whichever env credential is present.
