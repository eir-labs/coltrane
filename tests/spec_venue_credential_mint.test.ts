// ════════════════════════════════════════════════════════════════════════════════════════════
// PENDING IMPLEMENTATION — this file is committed RED on purpose. See SPEC-worker-contract.md.
// A failure here is a feature not yet built. A failure in any file NOT named spec_* is a
// regression. Do not weaken these laws to make CI green; implement them.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// GAP 1 — THERE IS NO VERB THAT MINTS A VENUE CREDENTIAL, so the only way to stand up a worker
// runs through a browser.
//
// A venue is any host that runs `coltrane work`. To run one you need an org-scoped,
// instance-bound drain key plus a set of environment variables. The engine ships no MCP verb that
// produces either, so every deployment invents its own out-of-band path — and in practice those
// paths end at a screen a human reads a secret off and carries somewhere by hand.
//
// That is not a deployment concern wearing a defect's clothes. It is the reverse. An assistant
// operates Coltrane through the MCP surface; a capability with no verb is a capability an
// assistant cannot use, however well the underlying machinery works. And the hand-carried step is
// exactly what the venue credential design exists to remove: `cdk_` keys were introduced so a box
// holds ONE credential and the store mints per-gig authority on each claim (src/worker.ts:298).
// Provisioning that design by copy-paste puts the long-lived secret back on a clipboard.
//
// WHAT THE ENGINE OWNS AND WHAT IT DOES NOT. The engine has no opinion about who may run a venue
// and no way to check one — that rule lives in the store. So it ships the verb, its schema, its
// shape validation and its refusals; a deployment wires the minting backend. This is the division
// src/tool_providers.ts:9 already states for MCP servers ("the OSS engine ships this RESOLUTION
// machinery; a deployment registers the actual server config") and the one deps.queueGig already
// implements for dispatch.
//
// THE IMPORTS BELOW ARE THE SPECIFICATION. `src/venue_credential.ts` does not exist; the mint seam
// on ToolSurfaceDeps does not exist. Each law loads what it needs dynamically so it fails on its
// own line, naming its own missing piece, rather than taking the file down at link time.
import { describe, it, expect, vi } from "vitest";
import { createToolSurface, type ToolSurfaceDeps, type SurfaceToolResult } from "../src/server.js";
import { MCP_TOOLS } from "../src/mcp.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { VenueSchema } from "../src/genome_schema.js";
import { realize } from "../src/venue_realize.js";

/** A refusal is a CODE plus a sentence, following RefusalCode in src/venue_realize.ts:23. */
type SpecResult = SurfaceToolResult & { refusal?: string };

/** What the grant looks like coming back from a deployment's minting backend. `credential_classes`
 *  is in `VenueSchema.credential_surface` vocabulary — the room's own word for what may legitimately
 *  be present — because that is the contract the provisioned box is then judged against. */
interface VenueCredentialGrant {
  instance: string;
  env: Record<string, string>;
  credential_classes: string[];
  expires_at?: string | null;
}

/** The module the spec says should exist. Loaded dynamically, through a specifier held in a
 *  variable, for a reason worth stating: a STATIC import of a file that is not there fails the
 *  whole suite at link time, and — because this repo's vitest globalSetup builds first — a
 *  compile-time module error would stop EVERY band from running, so nobody could tell a pending
 *  spec from a regression. The variable keeps tsc clean and puts the red where it belongs: at
 *  runtime, on the law that needs the module. */
const VENUE_CREDENTIAL_MODULE = "../src/venue_credential.js";
interface VenueCredentialModule {
  VENUE_CREDENTIAL_REFUSALS: readonly string[];
}
const venueCredentialModule = async (): Promise<VenueCredentialModule> =>
  (await import(VENUE_CREDENTIAL_MODULE)) as unknown as VenueCredentialModule;

function bareDeps(extra?: Record<string, unknown>): ToolSurfaceDeps {
  const registry = createRegistry();
  const base = { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
  return { ...base, ...(extra ?? {}) } as ToolSurfaceDeps;
}

/** A complete environment, as a deployment's backend would answer. Placeholder hosts throughout —
 *  this repo is public and no real origin belongs in a fixture. */
const COMPLETE_ENV: Record<string, string> = {
  COLTRANE_STORE_URL: "https://store.example",
  COLTRANE_STORE_ANON: "anon-key-placeholder",
  COLTRANE_SERVICE_URL: "https://coltrane.example",
  COLTRANE_DRAIN_KEY: "cdk_placeholder",
  COLTRANE_INSTANCE: "my-laptop",
};

const okMint = (env: Record<string, string> = COMPLETE_ENV) =>
  vi.fn(async (args: { org_slug: string; instance: string }): Promise<VenueCredentialGrant> => ({
    instance: args.instance,
    env: { ...env },
    credential_classes: ["coltrane-venue-key"],
    expires_at: null,
  }));

function mintTool(deps: ToolSurfaceDeps) {
  return createToolSurface(deps).find((t) => t.name === "venue_credential_mint");
}

const props = (schema: object): Record<string, unknown> =>
  ((schema as { properties?: Record<string, unknown> }).properties ?? {});

describe("GAP 1 — the venue credential has a verb", () => {
  // #375's lesson, stated as a law: a tool added to a surface nothing serves is a tool no client
  // can call. `acting_for` was put on hosted_tools.ts while the hosted endpoint mounted MCP_TOOLS,
  // and the store kept answering "no acting_for was named" for two rounds because the field was
  // never in the schema being served. MCP_TOOLS is the served surface; that is where this lives.
  it("venue_credential_mint is on the engine's tool surface", () => {
    const def = MCP_TOOLS.find((t) => t.slug === "venue_credential_mint");
    expect(def, "the verb must exist in MCP_TOOLS — the surface every transport mounts").toBeDefined();
    expect(mintTool(bareDeps()), "and therefore in createToolSurface").toBeDefined();
  });

  // Two arguments, both required to name the thing being minted: WHICH organization the credential
  // is scoped to, and WHICH venue instance it is bound to. A key with an org and no instance is
  // the org's whole authority with nothing to bind it to.
  it("its schema takes an organization and a venue instance", () => {
    const def = MCP_TOOLS.find((t) => t.slug === "venue_credential_mint");
    expect(def, "no verb, no schema").toBeDefined();
    const input = props(def!.input_schema);
    expect(Object.keys(input).sort(), "org + instance, and nothing a caller must guess at").toEqual(
      ["instance", "org_slug"],
    );
  });

  // The verb returns the ENVIRONMENT, not a key. A caller handed a key alone still has to discover
  // four more variables and infer which URL names which host — which is Gap 3, and Gap 3 cost two
  // days of a missing blob that read like a storage-permissions problem.
  it("its schema advertises the environment it returns, not just the credential", () => {
    const def = MCP_TOOLS.find((t) => t.slug === "venue_credential_mint");
    expect(def, "no verb, no schema").toBeDefined();
    const output = props(def!.output_schema);
    expect(Object.keys(output), "the answer carries the whole environment").toContain("env");
    expect(Object.keys(output), "and echoes the instance it bound to").toContain("instance");
  });

  // WITH NO BACKEND WIRED, the verb answers — it does not throw and it does not return a generic
  // error. This is the shape src/server.ts:2957-3060 already uses when deps.queueGig / approveGig /
  // cancelGig are absent: the tool stays in the surface and says which seam to wire. A caller that
  // cannot tell "this deployment has not wired minting" from "your request was bad" retries the
  // wrong thing forever.
  it("answers with a typed explanation when no minting backend is wired", async () => {
    const tool = mintTool(bareDeps());
    expect(tool, "the verb must exist even where nothing backs it").toBeDefined();
    const res = (await tool!.call({ org_slug: "acme-studio", instance: "my-laptop" })) as SpecResult;
    expect(res.ok).toBe(false);
    expect(res.refusal, "a code, not a prose-only failure").toBe("no_backend");
    expect(res.error, "and it names the seam a deployment wires").toMatch(/mintVenueCredential/);
  });

  // The COMPLETE environment. Every required variable, with a real value, from one call.
  // The last assertion is the whole of Gap 3 in one line: a grant whose two URLs name the same
  // host has told the caller nothing, and is the exact misconfiguration that broke provisioning.
  it("returns the complete worker environment, with the two hosts distinct", async () => {
    const mint = okMint();
    const tool = mintTool(bareDeps({ mintVenueCredential: mint, caller: { kind: "member" } }));
    expect(tool, "the verb must exist").toBeDefined();
    const res = (await tool!.call({ org_slug: "acme-studio", instance: "my-laptop" })) as SpecResult;
    expect(res.ok, res.error).toBe(true);
    const data = res.data as { instance: string; env: Record<string, string> };
    expect(data.instance, "the instance the caller asked to bind").toBe("my-laptop");
    for (const name of Object.keys(COMPLETE_ENV)) {
      expect(data.env[name], `${name} must arrive with a value, not a placeholder to fill in`)
        .toBeTruthy();
    }
    expect(
      new URL(data.env["COLTRANE_STORE_URL"]!).host,
      "the database and the service are two hosts; a grant naming one twice is Gap 3 shipped",
    ).not.toBe(new URL(data.env["COLTRANE_SERVICE_URL"]!).host);
  });

  // THE TIE TO THE ROOM CONTRACT, and it is load-bearing rather than tidy.
  //
  // `realize` (src/venue_realize.ts) already treats a credential class present in the environment
  // but NOT declared by the venue's `credential_surface` as a `credential-breach` refusal. So a
  // mint that provisions a class no room declares stands up a box that every room then refuses —
  // and the operator debugs a working credential against a correct refusal. Naming the classes, in
  // the room's own vocabulary, is what lets the two be checked against each other before a gig is
  // ever dispatched.
  //
  // The law runs the REAL gauntlet in both directions, so it cannot pass by naming a plausible
  // string: a room declaring exactly these classes admits the provisioned box; a room declaring
  // none refuses it, by that code.
  it("names the credential classes it provisioned, in the room contract's own vocabulary", async () => {
    const tool = mintTool(bareDeps({ mintVenueCredential: okMint(), caller: { kind: "member" } }));
    expect(tool, "the verb must exist").toBeDefined();
    const res = (await tool!.call({ org_slug: "acme-studio", instance: "my-laptop" })) as SpecResult;
    expect(res.ok, res.error).toBe(true);
    const classes = (res.data as { credential_classes: string[] }).credential_classes;
    expect(classes.length, "a grant that provisions credentials must say which classes").toBeGreaterThan(0);
    for (const c of classes) {
      // CLASSES, never material — the same reason `credential_surface` is a list of names and never
      // a field a secret could occupy.
      expect(c, "a class name must not carry the credential").not.toContain(COMPLETE_ENV["COLTRANE_DRAIN_KEY"]);
    }

    const gigId = "99999999-9999-9999-9999-999999999999";
    const declaring = VenueSchema.parse({
      slug: "provisioned-room-v1", institution_slug: "quartet", credential_surface: classes,
    });
    expect(
      realize(declaring, { seats: [], ambientEnv: {}, credentialsPresent: classes, gigId }).ok,
      "a room declaring exactly these classes must admit the box this grant provisioned",
    ).toBe(true);

    const declaringNothing = VenueSchema.parse({ slug: "bare-room-v1", institution_slug: "quartet" });
    const refused = realize(declaringNothing, { seats: [], ambientEnv: {}, credentialsPresent: classes, gigId });
    expect(refused.ok, "and a room declaring none must refuse it — which is why the names matter").toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("credential-breach");
  });

  // A backend that answers with a HALF-SET is refused rather than passed through. Handing back an
  // incomplete environment moves the assembly problem to the caller while looking like success —
  // and the caller then discovers the gap from a status code at first write, which is the failure
  // mode this whole verb exists to end.
  it("refuses an incomplete grant instead of forwarding it", async () => {
    const partial = { ...COMPLETE_ENV };
    delete partial["COLTRANE_SERVICE_URL"];
    const tool = mintTool(
      bareDeps({ mintVenueCredential: okMint(partial), caller: { kind: "member" } }),
    );
    expect(tool, "the verb must exist").toBeDefined();
    const res = (await tool!.call({ org_slug: "acme-studio", instance: "my-laptop" })) as SpecResult;
    expect(res.ok).toBe(false);
    expect(res.refusal).toBe("incomplete_env");
    expect(res.error, "and it names what is missing").toMatch(/COLTRANE_SERVICE_URL/);
  });

  // THE ESCALATION LAW. A gig-scoped credential is issued to one agent for one gig and expires
  // with that gig's lease (src/worker.ts:319). A venue credential is org-scoped and outlives every
  // gig. Letting the first mint the second turns the narrowest credential in the system into the
  // broadest — and no store-side gate catches it, because the store sees a valid org-scoped
  // request arriving from a credential it issued.
  //
  // The refusal is its own code. "Not authorized" is indistinguishable from "wrong password", and
  // a caller that cannot tell them apart retries with the same credential forever.
  it("refuses a gig-scoped credential, by name, without reaching the backend", async () => {
    const mint = okMint();
    const tool = mintTool(
      bareDeps({ mintVenueCredential: mint, caller: { kind: "gig", gig_id: "11111111-1111-1111-1111-111111111111" } }),
    );
    expect(tool, "the verb must exist").toBeDefined();
    const res = (await tool!.call({ org_slug: "acme-studio", instance: "my-laptop" })) as SpecResult;
    expect(res.ok).toBe(false);
    expect(res.refusal).toBe("gig_scoped_token");
    expect(res.error, "the refusal has to teach, or it reads as a broken deployment")
      .toMatch(/gig|lease/i);
    expect(mint, "a refused mint must never reach the backend").not.toHaveBeenCalled();
  });

  // Returned once. There is no read-back verb, and adding one would make every credential in the
  // system readable by anything holding the surface — the same widening the law above refuses.
  it("has no read-back verb: the credential is answered once and never retrievable", () => {
    // An EXACT list rather than "no read verb exists", so the law cannot pass vacuously on a
    // surface where the whole family is missing — and so that adding a second verb to it is a line
    // someone changed on purpose.
    expect(
      MCP_TOOLS.filter((t) => t.slug.startsWith("venue_credential_")).map((t) => t.slug),
      "mint exists, and it is the ONLY venue_credential_* verb",
    ).toEqual(["venue_credential_mint"]);
  });

  // An EXACT list, not a floor, for the same reason tests/hosted_tools.test.ts pins its tool names
  // exactly: a refusal code is a contract with clients, and one that drifts in silently is a
  // client branch nobody wrote.
  it("names exactly three refusals, each a reason a mint cannot proceed", async () => {
    const { VENUE_CREDENTIAL_REFUSALS } = await venueCredentialModule();
    expect(VENUE_CREDENTIAL_REFUSALS, "the import is the specification").toBeDefined();
    expect([...VENUE_CREDENTIAL_REFUSALS].sort()).toEqual([
      "gig_scoped_token",
      "incomplete_env",
      "no_backend",
    ]);
  });
});
