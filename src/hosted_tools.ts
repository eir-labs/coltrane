// hosted_tools.ts — the INTERIM six-tool hosted surface. DEPRECATED in favor of the full
// engine surface: `createToolSurface` (subpath "./tool_surface") mounts ALL engine tools
// per-request, backed by a GenomeStore (subpath "./genome_store" — postgrestGenomeStore
// rides the same {baseUrl, anonKey, bearer} context this module established). Kept because
// the current deploy still consumes it; new hosts should mount the full surface instead.
//
// The original charter, still true of the pattern this module pioneered:
// the hosted MCP tool surface, defined ONCE here (OSS, npm-published) and
// consumed by any host: the Vercel app, a self-hosted wrapper, a test harness. The split of
// responsibilities is the auth-boundary law applied to tooling:
//
//   * THE ENGINE (this module) owns what the tools ARE — names, schemas, store-facing
//     behavior. It is dependency-free (plain fetch against a PostgREST-shaped org store)
//     and auth-BLIND: it never decides whether a bearer is valid, it only routes by the
//     bearer's CLASS, and the store refuses invalid credentials where the hashes live.
//   * THE HOST owns transport and authentication — it verifies/obtains the bearer (OAuth
//     browser login for humans, issued ctk_ capability tokens for agents), mounts these
//     definitions on whatever MCP transport it serves, and passes the context in.
//
// Two bearer classes, per the mcp-auth model:
//   * ctk_ agent capability token → security-definer RPCs (coltrane_mcp_*) resolve the
//     token's hash inside the store and scope to its org + exact may_dispatch list.
//   * a member session JWT → rides PostgREST directly; RLS scopes rows to the member, and
//     dispatch runs the governor-gated RPC as them (auth.uid()).

/** Everything a hosted tool needs from its host: where the org store is, and who is calling. */
export interface HostedToolContext {
  /** The org store's base URL (a Supabase project or PostgREST-compatible equivalent). */
  baseUrl: string;
  /** The store's public (anon) API key — required by PostgREST as `apikey`; not a secret. */
  anonKey: string;
  /** The caller's bearer: a member session JWT, or an issued ctk_ agent capability token. */
  bearer: string;
}

export interface HostedToolResult {
  text: string;
  isError?: boolean;
}

export interface HostedTool {
  name: string;
  title: string;
  description: string;
  /** Plain JSON Schema for the tool's params — transport-agnostic, no schema-library coupling. */
  paramsJsonSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: HostedToolContext): Promise<HostedToolResult>;
}

const isAgentBearer = (bearer: string): boolean => bearer.startsWith("ctk_");

const ok = (data: unknown): HostedToolResult => ({ text: JSON.stringify(data) });
const err = (message: string): HostedToolResult => ({ text: message, isError: true });

async function rpc(ctx: HostedToolContext, fn: string, body: Record<string, unknown>, asCaller: boolean): Promise<HostedToolResult> {
  const res = await fetch(`${ctx.baseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: ctx.anonKey,
      // The JWT authenticates via the header (PostgREST verifies it; RLS/auth.uid() scope it).
      // A ctk_ bearer is NOT a JWT — it authenticates inside the definer RPC via the body, and
      // the transport rides the anon key.
      Authorization: `Bearer ${asCaller ? ctx.bearer : ctx.anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    try {
      const parsed = JSON.parse(text) as { message?: string };
      return err(parsed.message ?? text);
    } catch {
      return err(text || `store error ${res.status}`);
    }
  }
  return { text: text || "null" };
}

async function restGet(ctx: HostedToolContext, pathAndQuery: string): Promise<HostedToolResult> {
  const res = await fetch(`${ctx.baseUrl}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: ctx.anonKey,
      Authorization: `Bearer ${ctx.bearer}`,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) return err(text || `store error ${res.status}`);
  return { text };
}

export const HOSTED_TOOLS: HostedTool[] = [
  {
    name: "list_standards",
    title: "List standards",
    description: "The standards in your organizations' genome layers — what a gig can be.",
    paramsJsonSchema: { type: "object", properties: {} },
    async handler(_args, ctx) {
      if (isAgentBearer(ctx.bearer)) return rpc(ctx, "coltrane_mcp_standards", { p_bearer: ctx.bearer }, false);
      return restGet(ctx, "coltrane_standards?select=slug,version,status,domain,output_types,org_id&order=slug");
    },
  },
  {
    name: "list_gigs",
    title: "List gigs",
    description:
      "The queue and the history — the gig table IS the queue. Optionally filter by status (queued|running|completed|failed|aborted).",
    paramsJsonSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "queued|running|completed|failed|aborted" },
        limit: { type: "number" },
      },
    },
    async handler(args, ctx) {
      if (isAgentBearer(ctx.bearer)) return err("agent tokens read single gigs via gig_status; listing is a member surface");
      const limit = Math.min(Number(args["limit"] ?? 25), 100);
      const status = args["status"] ? `&status=eq.${encodeURIComponent(String(args["status"]))}` : "";
      return restGet(
        ctx,
        `coltrane_gigs?select=id,standard_slug,status,mode,total_cost_usd,dispatched_by,acting_for,created_at,completed_at&order=created_at.desc&limit=${limit}${status}`,
      );
    },
  },
  {
    name: "gig_status",
    title: "Gig status",
    description: "One gig's status, spend, and reproducibility keys (org-scoped).",
    paramsJsonSchema: {
      type: "object",
      properties: { gig_id: { type: "string" } },
      required: ["gig_id"],
    },
    async handler(args, ctx) {
      const gig = String(args["gig_id"] ?? "");
      if (isAgentBearer(ctx.bearer)) return rpc(ctx, "coltrane_mcp_gig_status", { p_bearer: ctx.bearer, p_gig: gig }, false);
      return restGet(
        ctx,
        `coltrane_gigs?select=id,standard_slug,status,mode,total_cost_usd,genome_hash,run_fingerprint,started_at,completed_at,manifest&id=eq.${encodeURIComponent(gig)}`,
      );
    },
  },
  {
    name: "gig_outputs",
    title: "Gig outputs",
    description: "A gig's sealed outputs with their provenance (content_sha + input_shas).",
    paramsJsonSchema: {
      type: "object",
      properties: { gig_id: { type: "string" } },
      required: ["gig_id"],
    },
    async handler(args, ctx) {
      const gig = String(args["gig_id"] ?? "");
      if (isAgentBearer(ctx.bearer)) return rpc(ctx, "coltrane_mcp_gig_outputs", { p_bearer: ctx.bearer, p_gig: gig }, false);
      return restGet(
        ctx,
        `coltrane_outputs?select=id,domain_type,agent_slug,phase,content_sha,input_shas,created_at,data&gig_id=eq.${encodeURIComponent(gig)}&order=created_at`,
      );
    },
  },
  {
    name: "roster",
    title: "Roster",
    description: "The named players and humans of your organizations — names, forebears, status (member surface).",
    paramsJsonSchema: { type: "object", properties: {} },
    async handler(_args, ctx) {
      if (isAgentBearer(ctx.bearer)) return err("the roster is a member surface; agent tokens read gigs and outputs");
      return restGet(ctx, "coltrane_agent?select=slug,name,kind,status,named_from_forebear&order=slug");
    },
  },
  {
    name: "institution_browse",
    title: "Browse institutions",
    description:
      "The institutions your organizations answer to, and whether each of their laws has TEETH — " +
      "an evaluable check — or is prose. Read-only.",
    paramsJsonSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "One institution, with its laws in full. Omit for the list." },
      },
    },
    async handler(args, ctx) {
      // A member surface, like `roster`. An agent token reads gigs and outputs; which institutions
      // an organization answers to is a governance question, not a chair's working context.
      if (isAgentBearer(ctx.bearer)) {
        return err("institutions are a member surface; agent tokens read gigs and outputs");
      }

      const one = typeof args["slug"] === "string" ? String(args["slug"]) : "";
      const out = await restGet(
        ctx,
        one
          ? `coltrane_institution?select=slug,name,kind,sovereign,laws&slug=eq.${encodeURIComponent(one)}`
          : "coltrane_institution?select=slug,name,kind,sovereign,laws&order=slug",
      );
      if (out.isError) return out;

      type Law = { aim?: string; deontic?: string; or_else?: string; check?: { predicate?: string } };
      type Row = { slug: string; name: string; kind: string; sovereign: boolean; laws?: Law[] };
      const rows = JSON.parse(out.text) as Row[];

      // THE DISTINCTION WORTH SURFACING. A law with a `check` is adjudicable — `evaluate()` can
      // decide it. A law without one is a sentence: it may be the most important rule an institution
      // has and nothing can enforce it. Counting them separately is the difference between reading
      // a constitution and knowing which parts bind.
      const shaped = rows.map((r) => {
        const laws = r.laws ?? [];
        const withTeeth = laws.filter((l) => typeof l?.check?.predicate === "string" && l.check.predicate.length > 0);
        return {
          slug: r.slug,
          name: r.name,
          kind: r.kind,
          sovereign: r.sovereign,
          laws_total: laws.length,
          laws_enforceable: withTeeth.length,
          laws_prose_only: laws.length - withTeeth.length,
          ...(one
            ? {
                laws: laws.map((l) => ({
                  aim: l.aim,
                  deontic: l.deontic,
                  or_else: l.or_else,
                  enforceable: typeof l?.check?.predicate === "string" && l.check.predicate.length > 0,
                  predicate: l?.check?.predicate,
                })),
              }
            : {}),
        };
      });

      return ok({ institutions: shaped, count: shaped.length });
    },
  },
  {
    name: "dispatch_gig",
    title: "Dispatch a gig",
    description:
      "Queue one run of a standard. Queuing only — a drain worker claims and runs it. Members dispatch as themselves (governor-gated); agent tokens are limited to their exact may_dispatch list.",
    paramsJsonSchema: {
      type: "object",
      properties: {
        standard_slug: { type: "string" },
        mode: { type: "string", enum: ["rehearsal", "studio", "live"] },
        input: { type: "object" },
        org_slug: { type: "string", description: "Disambiguates when you belong to several orgs carrying the standard." },
        acting_for: {
          type: "string",
          description:
            "The player whose authority this work carries — the identity a drain will run it as. " +
            "Must be a SEATED member: the genome read the run needs is gated on seating, so an " +
            "unseated name produces a gig that can only fail. Omit to act as yourself, which " +
            "requires that you are seated.",
        },
      },
      required: ["standard_slug", "mode", "input"],
    },
    async handler(args, ctx) {
      if (isAgentBearer(ctx.bearer)) {
        const out = await rpc(
          ctx,
          "coltrane_mcp_dispatch",
          { p_bearer: ctx.bearer, p_standard: args["standard_slug"], p_mode: args["mode"], p_input: args["input"] ?? {} },
          false,
        );
        return out.isError ? out : ok({ gig_id: JSON.parse(out.text), status: "queued" });
      }
      const out = await rpc(
        ctx,
        "coltrane_gig_dispatch",
        {
          p_standard: args["standard_slug"],
          p_mode: args["mode"],
          p_input: args["input"] ?? {},
          p_org_slug: args["org_slug"] ?? null,
          // WHO ACTS, as distinct from who asked. Without this the store defaults to the caller,
          // and a caller who holds no chair produces a gig that fails at genome load thirty minutes
          // later on a drain — which is exactly what the first real gig did.
          p_acting_for: args["acting_for"] ?? null,
        },
        true,
      );
      return out.isError ? out : ok({ gig_id: JSON.parse(out.text), status: "queued" });
    },
  },
  {
    name: "cancel_gig",
    title: "Cancel a queued gig",
    description:
      "Cancel one QUEUED run before a drain worker claims it, so no worker ever runs it. Only a queued gig can be cancelled — a running gig is stopped with gig_abort, and the store refuses a claimed/running/terminal row. Members cancel as themselves; agent tokens are scoped to their org.",
    paramsJsonSchema: {
      type: "object",
      properties: { gig_id: { type: "string" } },
      required: ["gig_id"],
    },
    async handler(args, ctx) {
      const gig = String(args["gig_id"] ?? "");
      if (isAgentBearer(ctx.bearer)) {
        const out = await rpc(ctx, "coltrane_mcp_gig_cancel", { p_bearer: ctx.bearer, p_gig: gig }, false);
        return out.isError ? out : ok({ gig_id: JSON.parse(out.text), status: "cancelled" });
      }
      const out = await rpc(ctx, "coltrane_gig_cancel", { p_gig: gig }, true);
      return out.isError ? out : ok({ gig_id: JSON.parse(out.text), status: "cancelled" });
    },
  },
];

export function hostedToolByName(name: string): HostedTool {
  const tool = HOSTED_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown hosted tool: ${name}`);
  return tool;
}
