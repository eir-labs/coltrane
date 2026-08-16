// ════════════════════════════════════════════════════════════════════════════════════════════
// PENDING IMPLEMENTATION — this file is committed RED on purpose. See SPEC-worker-contract.md.
// A failure here is a feature not yet built. A failure in any file NOT named spec_* is a
// regression. Do not weaken these laws to make CI green; implement them.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// GAP 4 — THREE WAYS TO RUN A STANDARD AND NO SINGLE STORY, and inside one of them, two credential
// shapes with materially different semantics and nothing saying when each is correct.
//
// `coltrane dispatch` runs a local-file genome in this process, with no store credential.
// `coltrane work` claims from the store queue and takes its genome from the store.
// `gig_dispatch` on the MCP surface queues a gig for whichever worker claims it.
//
// And `coltrane work` itself accepts EITHER a venue credential (org-scoped, instance-bound; the
// store mints a per-gig credential on each claim, so the worker holds nothing between gigs) OR a
// player token (one agent's own credential, held for its lifetime). Both are legitimate. Nothing
// states when each is correct, and there is no documented way to obtain either — which is Gap 1.
//
// THE DEFECT IS THE DERIVATION, not the choice. `src/cli.ts:219` computes
// `venueMode = Boolean(drainKey && instance)`; `src/worker.ts:320` re-derives
// `ctx.drainKey && ctx.instance` at the claim. They agree today. `src/worker.ts:345-356` exists
// BECAUSE they might not — a guard, with a comment, for the case where the instance is lost
// somewhere downstream of the CLI and the worker would present an empty bearer to the store. That
// defensive branch is the correct response to a condition with two homes. One home is better.
//
// So: one function answers "which mode is this worker in", it carries the fields the answer needs,
// and its refusal is the refusal the CLI prints. Not a second copy of the same boolean.
//
// THE IMPORTS BELOW ARE THE SPECIFICATION. `workerCredentialMode` does not exist yet; each law
// loads it dynamically so it fails on its own line rather than taking the file down at link time.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runCli, type CliIO } from "../src/cli.js";
import { claimNextGig, type WorkerContext } from "../src/worker.js";

/** The answer, carrying what the answer needs — so a call site consumes it instead of re-reading
 *  the environment and re-deciding. `why` is the refusal text, single-sourced. */
type WorkerCredentialMode =
  | { mode: "venue"; drainKey: string; instance: string }
  | { mode: "player"; agentToken: string }
  | { mode: "none"; why: string };

interface WorkerEnvModule {
  workerCredentialMode(env: Record<string, string | undefined>): WorkerCredentialMode;
}
/** Loaded through a specifier held in a variable — see the note in spec_worker_environment.test.ts:
 *  a compile-time module error would stop every band from running, and then nobody could tell a
 *  pending spec from a regression. */
const WORKER_ENV_MODULE = "../src/worker_env.js";
const workerEnv = async (): Promise<WorkerEnvModule> =>
  (await import(WORKER_ENV_MODULE)) as unknown as WorkerEnvModule;

/** Every variable either the CLI door or the claim path consults to decide the mode. */
const MODE_VARS = [
  "COLTRANE_STORE_URL",
  "COLTRANE_STORE_ANON",
  "COLTRANE_AGENT_TOKEN",
  "COLTRANE_DRAIN_KEY",
  "COLTRANE_INSTANCE",
  "FLY_APP_NAME",
] as const;

const STORE = { COLTRANE_STORE_URL: "https://store.example", COLTRANE_STORE_ANON: "anon-key-placeholder" };

describe("GAP 4 — one function answers which mode a worker is in", () => {
  // VENUE MODE, and its fields. A caller that gets back `{mode:"venue"}` and then has to read the
  // environment again for the key and the instance has been told half the answer, and the second
  // half is where the two derivations drifted.
  it("a venue credential with an instance is venue mode, fields included", async () => {
    const { workerCredentialMode } = await workerEnv();
    expect(workerCredentialMode, "the import is the specification").toBeTypeOf("function");
    expect(workerCredentialMode({ ...STORE, COLTRANE_DRAIN_KEY: "cdk_placeholder", COLTRANE_INSTANCE: "my-laptop" }))
      .toEqual({ mode: "venue", drainKey: "cdk_placeholder", instance: "my-laptop" });
  });

  // THE PRECEDENCE RULE, codified rather than left to call-site order. A box holding both is a
  // drain that also happens to carry a player token; the venue credential is the correct one,
  // because it is the one the store mints per-gig authority against.
  it("venue wins when both credentials are present", async () => {
    const { workerCredentialMode } = await workerEnv();
    expect(workerCredentialMode, "the import is the specification").toBeTypeOf("function");
    const m = workerCredentialMode({
      ...STORE,
      COLTRANE_DRAIN_KEY: "cdk_placeholder",
      COLTRANE_INSTANCE: "my-laptop",
      COLTRANE_AGENT_TOKEN: "ctk_placeholder",
    });
    expect(m.mode).toBe("venue");
  });

  it("a player token alone is player mode", async () => {
    const { workerCredentialMode } = await workerEnv();
    expect(workerCredentialMode, "the import is the specification").toBeTypeOf("function");
    expect(workerCredentialMode({ ...STORE, COLTRANE_AGENT_TOKEN: "ctk_placeholder" }))
      .toEqual({ mode: "player", agentToken: "ctk_placeholder" });
  });

  it("the hosting provider's app name still supplies the instance", async () => {
    const { workerCredentialMode } = await workerEnv();
    expect(workerCredentialMode, "the import is the specification").toBeTypeOf("function");
    const m = workerCredentialMode({ ...STORE, COLTRANE_DRAIN_KEY: "cdk_placeholder", FLY_APP_NAME: "my-laptop" });
    expect(m).toEqual({ mode: "venue", drainKey: "cdk_placeholder", instance: "my-laptop" });
  });

  // A VENUE KEY WITH NO INSTANCE IS A MISCONFIGURATION, NOT A DOWNGRADE — even when a player token
  // is sitting right there. A box provisioned as a venue that quietly runs as a player claims a
  // DIFFERENT set of gigs under a DIFFERENT identity, and the operator sees a queue that merely
  // looks empty. That symptom is already on record (src/worker.ts:305-311); this is it in reverse,
  // and silently falling back is how it would happen again.
  it("a venue key with no instance refuses, even when a player token is present", async () => {
    const { workerCredentialMode } = await workerEnv();
    expect(workerCredentialMode, "the import is the specification").toBeTypeOf("function");
    const m = workerCredentialMode({
      ...STORE,
      COLTRANE_DRAIN_KEY: "cdk_placeholder",
      COLTRANE_AGENT_TOKEN: "ctk_placeholder",
    });
    expect(m.mode, "a half-configured venue must not silently become a player").toBe("none");
    expect((m as { why: string }).why).toMatch(/COLTRANE_INSTANCE/);
  });

  it("no credential at all is a refusal that says what is missing", async () => {
    const { workerCredentialMode } = await workerEnv();
    expect(workerCredentialMode, "the import is the specification").toBeTypeOf("function");
    const m = workerCredentialMode({ ...STORE });
    expect(m.mode).toBe("none");
    const why = (m as { why: string }).why;
    expect(why.length, "a refusal with no reason sends the reader to the source").toBeGreaterThan(20);
    expect(why, "and it names both doors, because either one would work")
      .toMatch(/COLTRANE_DRAIN_KEY[\s\S]*COLTRANE_AGENT_TOKEN|COLTRANE_AGENT_TOKEN[\s\S]*COLTRANE_DRAIN_KEY/);
  });
});

describe("GAP 4 — the CLI asks the function rather than deciding again", () => {
  const saved: Record<string, string | undefined> = {};
  let err = "";
  const io: CliIO = { out: () => {}, err: (s) => { err += s; } };

  beforeEach(() => {
    for (const k of MODE_VARS) { saved[k] = process.env[k]; delete process.env[k]; }
    err = "";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  // The single-sourcing law, stated behaviourally: the words the operator reads are the words the
  // function produced. Anything else means two statements of one fact, which is how `venueMode`
  // came to be computed twice in the first place.
  it("prints the mode's own refusal when no credential is configured", async () => {
    const { workerCredentialMode } = await workerEnv();
    expect(workerCredentialMode, "the import is the specification").toBeTypeOf("function");
    const m = workerCredentialMode(process.env);
    expect(m.mode).toBe("none");
    const code = await runCli(["work"], io);
    expect(code, "a malformed invocation exits 2").toBe(2);
    expect(err, "the CLI must print the refusal it was given, not compose a second one")
      .toContain((m as { why: string }).why);
  });

  it("prints the mode's own refusal when a venue key arrives without an instance", async () => {
    const { workerCredentialMode } = await workerEnv();
    expect(workerCredentialMode, "the import is the specification").toBeTypeOf("function");
    process.env["COLTRANE_DRAIN_KEY"] = "cdk_placeholder";
    const m = workerCredentialMode(process.env);
    expect(m.mode).toBe("none");
    await runCli(["work"], io);
    expect(err).toContain((m as { why: string }).why);
  });
});

describe("GAP 4 — the claim routes by the same answer", () => {
  const fetchMock = vi.fn(async (url: unknown) =>
    (String(url).includes("coltrane_drain_claim")
      ? { ok: true, status: 200, text: async () => JSON.stringify({ gig_id: "g1", token: "ctk_minted" }) }
      : { ok: true, status: 200, text: async () => "null" }) as unknown as Response,
  );
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockClear(); });
  afterEach(() => vi.unstubAllGlobals());

  const hit = (): string => String((fetchMock.mock.calls[0] as unknown as [string])[0]);

  // The mode's payload has to be SUFFICIENT to build the worker context. If a call site still has
  // to reach back into the environment for a field, the condition has two homes again and the
  // guard at src/worker.ts:345 is still doing real work.
  it("a venue answer builds a venue claim, and a player answer builds a player claim", async () => {
    const { workerCredentialMode } = await workerEnv();
    expect(workerCredentialMode, "the import is the specification").toBeTypeOf("function");

    const venue = workerCredentialMode({ ...STORE, COLTRANE_DRAIN_KEY: "cdk_placeholder", COLTRANE_INSTANCE: "my-laptop" });
    expect(venue.mode).toBe("venue");
    const venueCtx: WorkerContext = {
      baseUrl: STORE.COLTRANE_STORE_URL,
      anonKey: STORE.COLTRANE_STORE_ANON,
      agentToken: "", // venue mode holds nothing between gigs; the claim fills this in
      drainKey: (venue as { drainKey: string }).drainKey,
      instance: (venue as { instance: string }).instance,
    };
    await claimNextGig(venueCtx);
    expect(hit()).toContain("coltrane_drain_claim");
    expect(venueCtx.agentToken, "the claim replaces the bearer with the gig's own").toBe("ctk_minted");

    fetchMock.mockClear();
    const player = workerCredentialMode({ ...STORE, COLTRANE_AGENT_TOKEN: "ctk_placeholder" });
    expect(player.mode).toBe("player");
    await claimNextGig({
      baseUrl: STORE.COLTRANE_STORE_URL,
      anonKey: STORE.COLTRANE_STORE_ANON,
      agentToken: (player as { agentToken: string }).agentToken,
    });
    expect(hit()).toContain("coltrane_mcp_claim");
  });
});
