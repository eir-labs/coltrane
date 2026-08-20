// ════════════════════════════════════════════════════════════════════════════════════════════
// PENDING IMPLEMENTATION — this file is committed RED on purpose. It is the red-spec for the
// ENGINE HALF of a governed `org_hire` verb, the org-membership analogue of
// `venue_credential_mint` (see tests/spec_venue_credential_mint.test.ts and src/venue_credential.ts).
// A failure here is a feature not yet built. A failure in any file NOT named for a pending spec is
// a regression. Do not weaken these laws to make CI green; implement them.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// THE GAP. There is no verb that ADMITS an agent to an org. A peer session that asked to be seated
// as a player was refused at genome load ("name a seated player"), and the only path to admit it is
// a human editing store rows by hand. The engine ships no governed surface for the act.
//
// WHAT THE ENGINE OWNS AND WHAT IT DOES NOT — the venue_credential_mint split, exactly. The engine
// ships the verb, its zod-derived input schema, its shape validation, an EXACT sorted set of typed
// refusals, and a `deps.hireMember` seam a deployment injects; the store performs the insert and any
// RLS. The refusals are the testable part, and they are testable OFFLINE — no store required.
//
// FOUR THINGS THIS SPEC PINS, each load-bearing:
//   1. ADMISSION IS NOT AUTHORITY. The input schema is OrgMemberSchema = {org_slug, agent_slug} and
//      nothing more. If org_hire accepted `caps`/`standards`/a chair, it would become a path to mint
//      authority in one call. A law proves the schema carries no field a capability could travel.
//   2. HIRING IS NEVER SELF-SERVICE. Only a 'member' caller (a human bearer) may hire; a
//      player/venue/gig token is refused `not_a_human_member` before the backend is ever reached.
//   3. A DEAD NAME FAILS CLOSED. `unknown_agent` when no agent_record exists; `already_member` when
//      the hire repeats (an ERROR, not a silent no-op — a governance surface must surface duplication).
//   4. THE ACT IS SEALED TO THE LEDGER. A successful hire writes a kind:"genome_mutation" row so
//      who-hired-whom lives in the append-only chain, sealed before the caller is told it succeeded.
//
// THE IMPORT BELOW IS THE SPECIFICATION. `src/org_hire.ts` does not exist yet, and the
// `deps.hireMember` seam on ToolSurfaceDeps does not exist yet. The org_hire module is loaded through
// a specifier held in a VARIABLE — a static import of a file that is not there fails the whole suite
// at link time, and because this repo's vitest globalSetup builds (tsc) first, a compile-time module
// error would stop EVERY band from running, so nobody could tell a pending spec from a regression.
// The variable keeps tsc clean and puts the red where it belongs: at runtime, on the law that needs
// the module.
import { describe, it, expect, vi } from "vitest";
import { createToolSurface, type ToolSurfaceDeps, type SurfaceToolResult } from "../src/server.js";
import { MCP_TOOLS } from "../src/mcp.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { OrgMemberSchema } from "../src/genome_schema.js";

/** The module the spec says should exist. Loaded dynamically, through a specifier held in a
 *  variable, for the reason stated in the header: a STATIC import of a missing file fails the whole
 *  suite (and every band) at tsc/link time, hiding the pending spec inside a compile error. */
const ORG_HIRE_MODULE = "../src/org_hire.js";
interface OrgHireModule {
  ORG_HIRE_REFUSALS: readonly string[];
}
const orgHireModule = async (): Promise<OrgHireModule> =>
  (await import(ORG_HIRE_MODULE)) as unknown as OrgHireModule;

/** A bare surface: a registry, an output store, and an in-memory ledger. `extra` layers on the
 *  caller identity and the deps.hireMember backend a given law exercises. Cast because the seam
 *  (deps.hireMember) is exactly what this spec asks the engine to add — it is not on the type yet,
 *  the same way deps.mintVenueCredential was absent when spec_venue_credential_mint was written. */
function surfaceDeps(extra?: Record<string, unknown>): ToolSurfaceDeps {
  const registry = createRegistry();
  const base = { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
  return { ...base, ...(extra ?? {}) } as ToolSurfaceDeps;
}

function hireTool(deps: ToolSurfaceDeps) {
  return createToolSurface(deps).find((t) => t.name === "org_hire");
}

const props = (schema: object): Record<string, unknown> =>
  ((schema as { properties?: Record<string, unknown> }).properties ?? {});

/** A backend that admits. The deployment's contract: hireMember({org_slug, agent_slug}) resolves to
 *  {ok:true} | {ok:false, code:'unknown_agent'|'already_member'} — a TYPED struct, never a generic
 *  throw, so a named refusal code survives the seam. */
const okHire = () =>
  vi.fn(async (_args: { org_slug: string; agent_slug: string }) => ({ ok: true as const }));
const codeHire = (code: "unknown_agent" | "already_member") =>
  vi.fn(async (_args: { org_slug: string; agent_slug: string }) => ({ ok: false as const, code }));

const ORG = "telesis";
const AGENT = "coltrane-proposer"; // status active, never 'named' — governance and naming are separate acts.

describe("org_hire — a governed verb that ADMITS an agent to an org (membership, never authority)", () => {
  // ── INV-1 · the verb is on the served surface ─────────────────────────────────────────────────
  // #375's lesson as a law: a tool that is not in MCP_TOOLS is a tool no transport mounts and no
  // client can call. MCP_TOOLS is the served surface; that is where org_hire must live, and
  // therefore where createToolSurface picks it up.
  it("INV-1 · org_hire is on the engine's tool surface", () => {
    const def = MCP_TOOLS.find((t) => t.slug === "org_hire");
    expect(def, "the verb must exist in MCP_TOOLS — the surface every transport mounts").toBeDefined();
    expect(hireTool(surfaceDeps()), "and therefore in createToolSurface").toBeDefined();
  });

  // ── INV-2 · admission is not authority: the input schema carries NO capability field ───────────
  // The load-bearing constraint. OrgMemberSchema is literally {org_slug, agent_slug}. If org_hire
  // grew a `caps`/`standards`/`chair` field it would become a way to mint authority in one call, and
  // the narrowing invariant a credential owes a chair would lose its floor. The law pins the schema
  // at its single Zod source AND on the served surface, and names the fields that must NEVER appear.
  it("INV-2 · its input schema is {org_slug, agent_slug} — no field a capability could travel", () => {
    expect(
      Object.keys(OrgMemberSchema.shape).sort(),
      "the single Zod source carries exactly two fields, both naming the belonging — nothing more",
    ).toEqual(["agent_slug", "org_slug"]);

    const def = MCP_TOOLS.find((t) => t.slug === "org_hire");
    expect(def, "no verb, no served schema to check").toBeDefined();
    const input = props(def!.input_schema);
    expect(
      Object.keys(input).sort(),
      "the served input_schema is derived from OrgMemberSchema and carries the same two fields",
    ).toEqual(["agent_slug", "org_slug"]);
    for (const forbidden of ["caps", "cap", "grant", "grants", "standards", "chair", "seat", "assignment"]) {
      expect(
        Object.keys(input),
        `org_hire ADMITS; it must never carry '${forbidden}' — seating is a separate act with its own gate`,
      ).not.toContain(forbidden);
    }
  });

  // ── INV-3 · hiring is never self-service: a non-'member' caller is refused not_a_human_member ───
  // CallerIdentity.kind is 'member' | 'player' | 'venue' | 'gig'; only 'member' bears a human. An
  // agent token (player/venue/gig) may not admit an agent — that is the whole point of the verb. The
  // refusal is decided from caller identity ALONE, before the backend is reached, so a refused hire
  // never touches deps.hireMember.
  for (const kind of ["player", "venue", "gig"] as const) {
    it(`INV-3 · a '${kind}' caller is refused not_a_human_member, without reaching the backend`, async () => {
      const hire = okHire();
      const tool = hireTool(surfaceDeps({ hireMember: hire, caller: { kind } }));
      expect(tool, "the verb must exist even where the caller is wrong").toBeDefined();
      const res = (await tool!.call({ org_slug: ORG, agent_slug: AGENT })) as SurfaceToolResult;
      expect(res.ok).toBe(false);
      expect(res.refusal, "a code, not a prose-only failure").toBe("not_a_human_member");
      expect(res.error, "the refusal has to teach: hiring is never self-service").toMatch(/human|member|self-service/i);
      expect(hire, "a refused hire must never reach the backend").not.toHaveBeenCalled();
    });
  }

  // ── INV-4 · no backend wired → a typed refusal, never a throw ──────────────────────────────────
  // The same first-class outcome venue_credential_mint has: with no deployment wiring deps.hireMember
  // the verb ANSWERS, naming the seam to wire. A caller that cannot tell "hiring is unwired here" from
  // "your request was bad" retries the wrong thing forever.
  it("INV-4 · a member caller with no backend wired is refused no_backend (typed, not a throw)", async () => {
    const tool = hireTool(surfaceDeps({ caller: { kind: "member" } }));
    expect(tool, "the verb must exist even where nothing backs it").toBeDefined();
    const res = (await tool!.call({ org_slug: ORG, agent_slug: AGENT })) as SurfaceToolResult;
    expect(res.ok).toBe(false);
    expect(res.refusal, "a code, not a prose-only failure").toBe("no_backend");
    expect(res.error, "and it names the seam a deployment wires").toMatch(/hireMember/);
  });

  // A hosted surface answers the SAME way: org_hire is intercepted before the hosted check, so it is
  // never hosted_unsupported and never reaches a store upsert path. This is the observable proxy for
  // "org_hire is in neither HOSTED_BLOCKED nor HOSTED_UPSERT" (both are module-private in server.ts).
  it("INV-4 · org_hire is intercepted before the hosted check — no_backend, not hosted_unsupported", async () => {
    const tool = hireTool(surfaceDeps({ hosted: true, caller: { kind: "member" } }));
    expect(tool, "the verb must exist on a hosted surface too").toBeDefined();
    const res = (await tool!.call({ org_slug: ORG, agent_slug: AGENT })) as SurfaceToolResult;
    expect(res.ok).toBe(false);
    expect(res.hosted_unsupported, "org_hire is callable in hosted mode — not a local-process tool").toBeFalsy();
    expect(res.refusal, "it reaches its own refusal, ahead of the hosted machinery").toBe("no_backend");
  });

  // ── INV-5 · a dead name fails closed: unknown_agent ────────────────────────────────────────────
  // The backend answering {ok:false, code:'unknown_agent'} — no agent_record with that slug — is
  // mapped to a typed unknown_agent refusal, exactly as an unresolvable tool grant fails closed at
  // dispatch. Existence is the ONLY precondition; the engine never checks status ('named'/'active'),
  // because governance and naming are separate acts (coltrane-proposer is active yet was never named).
  it("INV-5 · backend {ok:false, code:'unknown_agent'} maps to a typed unknown_agent refusal", async () => {
    const hire = codeHire("unknown_agent");
    const tool = hireTool(surfaceDeps({ hireMember: hire, caller: { kind: "member" } }));
    expect(tool, "the verb must exist").toBeDefined();
    const res = (await tool!.call({ org_slug: ORG, agent_slug: "no-such-agent-v1" })) as SurfaceToolResult;
    expect(hire, "the backend was consulted — existence is the store's answer, not the engine's").toHaveBeenCalledOnce();
    expect(res.ok).toBe(false);
    expect(res.refusal).toBe("unknown_agent");
  });

  // ── INV-6 · idempotency is an ERROR, not a silent success: already_member ──────────────────────
  // A repeat hire is a governance signal the surface must SURFACE. A silent no-op would mask a human
  // member's mistake. miles settled the defensible-either-way choice on the stricter, more auditable
  // outcome: a duplicate hire is refused, by name.
  it("INV-6 · backend {ok:false, code:'already_member'} maps to a typed already_member refusal (error, not no-op)", async () => {
    const hire = codeHire("already_member");
    const tool = hireTool(surfaceDeps({ hireMember: hire, caller: { kind: "member" } }));
    expect(tool, "the verb must exist").toBeDefined();
    const res = (await tool!.call({ org_slug: ORG, agent_slug: AGENT })) as SurfaceToolResult;
    expect(res.ok, "a repeat hire is an error the surface reports, not a silent success").toBe(false);
    expect(res.refusal).toBe("already_member");
  });

  // ── INV-7 · the hire is sealed to the ledger, before the caller is told it succeeded ────────────
  // agent_define/agent_evolve write kind:"genome_mutation" rows; a hire must too, so who-hired-whom,
  // when, and on whose authority lives in the append-only chain rather than only in a database row.
  // subject_slug is the agent admitted; event is 'org_hire'. Because the call is awaited, a row
  // present when the caller receives ok:true proves the seal preceded the report.
  it("INV-7 · a successful hire seals a genome_mutation row (subject=agent_slug) before it returns", async () => {
    const ledger = new MemoryLedger();
    const hire = okHire();
    const tool = hireTool(surfaceDeps({ ledger, hireMember: hire, caller: { kind: "member" } }));
    expect(tool, "the verb must exist").toBeDefined();
    const res = (await tool!.call({ org_slug: ORG, agent_slug: AGENT })) as SurfaceToolResult;
    expect(res.ok, res.error).toBe(true);
    const rows = ledger.query({ kind: "genome_mutation", subject_slug: AGENT });
    expect(rows.length, "exactly one admission is sealed, and it is present the instant the caller learns of it").toBe(1);
    expect(rows[0]!.event, "the ledger names the act").toBe("org_hire");
    expect(rows[0]!.subject_slug, "the row records the entity admitted").toBe(AGENT);
  });

  // ── INV-8 · admission REPORTS the belonging ────────────────────────────────────────────────────
  // On success the verb answers with the membership it created — the {org_slug, agent_slug} pair, and
  // nothing carrying authority.
  it("INV-8 · on success it returns the {org_slug, agent_slug} membership it admitted", async () => {
    const tool = hireTool(surfaceDeps({ hireMember: okHire(), caller: { kind: "member" } }));
    expect(tool, "the verb must exist").toBeDefined();
    const res = (await tool!.call({ org_slug: ORG, agent_slug: AGENT })) as SurfaceToolResult;
    expect(res.ok, res.error).toBe(true);
    const data = res.data as { org_slug?: string; agent_slug?: string };
    expect(data.org_slug, "the org admitted into").toBe(ORG);
    expect(data.agent_slug, "the agent admitted").toBe(AGENT);
  });

  // ── INV-9 · the audit trail records ONLY real admissions ───────────────────────────────────────
  // A refused hire seals NOTHING — the ledger row is written inside the {ok:true} branch, after the
  // backend confirms the admission, never before. A naive implementation that sealed ahead of the
  // backend result would record admissions that never happened; this law forbids it.
  it("INV-9 · a refused hire (unknown_agent) seals no genome_mutation row", async () => {
    const ledger = new MemoryLedger();
    const tool = hireTool(surfaceDeps({ ledger, hireMember: codeHire("unknown_agent"), caller: { kind: "member" } }));
    expect(tool, "the verb must exist").toBeDefined();
    const res = (await tool!.call({ org_slug: ORG, agent_slug: "no-such-agent-v1" })) as SurfaceToolResult;
    expect(res.ok).toBe(false);
    expect(
      ledger.query({ kind: "genome_mutation", event: "org_hire" }).length,
      "a hire that did not happen must leave no trace claiming it did",
    ).toBe(0);
  });

  // ── INV-10 · the refusal set is an EXACT, sorted list ──────────────────────────────────────────
  // An EXACT list, not a floor, for the same reason VENUE_CREDENTIAL_REFUSALS is pinned exactly: a
  // refusal code is a contract with clients, so a fourth appearing silently is a client branch nobody
  // wrote. Sorted, and equal to its own sorted copy, so drift is a line someone changed on purpose.
  it("INV-10 · ORG_HIRE_REFUSALS is exactly ['already_member','no_backend','not_a_human_member','unknown_agent'], sorted", async () => {
    const { ORG_HIRE_REFUSALS } = await orgHireModule();
    expect(ORG_HIRE_REFUSALS, "the import is the specification").toBeDefined();
    const expected = ["already_member", "no_backend", "not_a_human_member", "unknown_agent"];
    expect([...ORG_HIRE_REFUSALS].sort(), "the four reasons a hire cannot proceed").toEqual(expected);
    expect(
      [...ORG_HIRE_REFUSALS],
      "declared already sorted — the as-const array IS its own sorted copy, so a drift is deliberate",
    ).toEqual(expected);
  });
});
