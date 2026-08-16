// ════════════════════════════════════════════════════════════════════════════════════════════
// PENDING IMPLEMENTATION — this file is committed RED on purpose. See SPEC-worker-contract.md.
// A failure here is a feature not yet built. A failure in any file NOT named spec_* is a
// regression. Do not weaken these laws to make CI green; implement them.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// GAP 3 — ONE VARIABLE, THREE CONTRACTS. The most expensive bug of the week, and every fix for it
// was correct.
//
// COLTRANE_DRAIN_URL was read by three callers that did not agree on what it named. Two treated it
// as the database's PostgREST base; one treated it as the Coltrane service origin. The variable's
// own source comment said "ONE VARIABLE, TWO CONTRACTS" — and the count was already wrong when it
// was written, because a third reader existed and nobody had looked.
//
// HOW IT FAILED, in order, each step looking like a repair:
//   * Pointed at the database, the row writes SUCCEEDED — the definer RPCs are anon-exposed —
//     while the artifact upload answered 401 indefinitely. The only symptom was a missing blob,
//     which reads like a storage-permissions problem. Two days.
//   * Repointed at the service, the writes worked and boot-time provisioning broke, sitting in a
//     retry loop against an HTTP 307: a web framework's router answering a request meant for
//     PostgREST.
//   * Each fix moved the failure somewhere else, because the variable had never named one thing.
//
// 0.10.0 settled the MEANING (it names the service) and added a diagnostic at
// src/output_mirror.ts:331. It did not settle the NAME — "drain" names a role, not a host, which is
// how one variable came to hold both — and it did not move the check to startup, so a worker still
// learns it is misconfigured from a status code at its first write.
//
// The laws below pin the general form of the fix rather than this instance of it: one variable
// names one host; two hosts are two variables; the worker validates before it acts; legacy shapes
// are tolerated by NORMALIZING, never by appending (appending is what produced /rest/v1/rest/v1);
// and there is ONE place that enumerates the whole contract.
//
// THE IMPORTS BELOW ARE THE SPECIFICATION. `src/worker_env.ts` does not exist; each law loads it
// dynamically so it fails on its own line rather than taking the file down at link time.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Which host a value addresses — or "none" when it names no host at all. */
type EnvHost = "service" | "store" | "none";
/** What kind of thing it is. A url is the only role that may name a host. */
type EnvRole = "url" | "credential" | "identity" | "tuning";
/** When a worker must have it. "venue"/"player" are the two credential modes (Gap 4). */
type EnvRequired = "always" | "venue" | "player" | "conditional" | "never";

interface WorkerEnvVar {
  name: string;
  host: EnvHost;
  role: EnvRole;
  required: EnvRequired;
  /** one sentence: what it means and, for a url, WHICH host it names. */
  meaning: string;
  /** names tolerated for compatibility and normalized onto `name`. */
  legacy_names?: readonly string[];
}

interface WorkerEnvModule {
  WORKER_ENV_CONTRACT: readonly WorkerEnvVar[];
  normalizeWorkerEnv(env: Record<string, string | undefined>): Record<string, string>;
  assertWorkerEnv(env: Record<string, string | undefined>): void;
}
/** Loaded through a specifier held in a variable, for a reason worth stating: a STATIC import of a
 *  file that is not there fails the whole suite at link time, and — because this repo's vitest
 *  globalSetup builds first — a compile-time module error would stop EVERY band from running, so
 *  nobody could tell a pending spec from a regression. The variable keeps tsc clean and puts the
 *  red where it belongs: at runtime, on the law that needs the module. */
const WORKER_ENV_MODULE = "../src/worker_env.js";
const workerEnv = async (): Promise<WorkerEnvModule> =>
  (await import(WORKER_ENV_MODULE)) as unknown as WorkerEnvModule;

/** A worker in venue mode, complete and correct. Placeholder hosts — this repo is public. */
const VENUE_ENV: Record<string, string> = {
  COLTRANE_STORE_URL: "https://store.example",
  COLTRANE_STORE_ANON: "anon-key-placeholder",
  COLTRANE_SERVICE_URL: "https://coltrane.example",
  COLTRANE_DRAIN_KEY: "cdk_placeholder",
  COLTRANE_INSTANCE: "my-laptop",
};

/** A worker in player mode: the same two hosts, one agent's own token instead of a venue key. */
const PLAYER_ENV: Record<string, string> = {
  COLTRANE_STORE_URL: "https://store.example",
  COLTRANE_STORE_ANON: "anon-key-placeholder",
  COLTRANE_SERVICE_URL: "https://coltrane.example",
  COLTRANE_AGENT_TOKEN: "ctk_placeholder",
};

describe("GAP 3 — the worker environment contract is written down in one place", () => {
  // A contract nobody can read is the state we are leaving. Each entry has to say what the value
  // MEANS, because "COLTRANE_DRAIN_URL" told three readers three different things and none of them
  // was lying about what they thought it said.
  it("every variable names its host, its role, and what it means", async () => {
    const { WORKER_ENV_CONTRACT } = await workerEnv();
    expect(WORKER_ENV_CONTRACT, "the import is the specification").toBeDefined();
    expect(WORKER_ENV_CONTRACT.length).toBeGreaterThan(0);
    for (const v of WORKER_ENV_CONTRACT) {
      expect(v.name, "a variable with no name documents nothing").toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(v.meaning.length, `${v.name} needs a meaning, not a category`).toBeGreaterThan(20);
      // A tuning knob or an identity that claims a host is the category error that produced this
      // whole gap: only the things that ADDRESS a host may name one.
      if (v.host !== "none") {
        expect(["url", "credential"], `${v.name}: only a url or a credential may name a host`)
          .toContain(v.role);
      }
      if (v.role === "url") {
        expect(v.host, `${v.name} is a url and must say which host it names`).not.toBe("none");
      }
    }
  });

  // ONE VARIABLE, ONE HOST. Stated as a counting law because that is how the defect presented: two
  // hosts sharing a name, then three readers disagreeing about which one it was.
  it("two hosts are two variables — exactly one always-required url per host", async () => {
    const { WORKER_ENV_CONTRACT } = await workerEnv();
    expect(WORKER_ENV_CONTRACT, "the import is the specification").toBeDefined();
    for (const host of ["store", "service"] as const) {
      const urls = WORKER_ENV_CONTRACT.filter(
        (v) => v.role === "url" && v.host === host && v.required === "always",
      );
      expect(urls.map((v) => v.name), `exactly one always-required url names the ${host}`).toHaveLength(1);
    }
    const names = WORKER_ENV_CONTRACT.map((v) => v.name);
    expect(new Set(names).size, "a name listed twice is a name that means two things").toBe(names.length);
    // A legacy alias that is also somebody's canonical name is the same collision wearing a hat.
    for (const v of WORKER_ENV_CONTRACT) {
      for (const legacy of v.legacy_names ?? []) {
        expect(names, `${legacy} is a legacy alias and must not also be canonical`).not.toContain(legacy);
      }
    }
  });

  // The demotion, made explicit. COLTRANE_DRAIN_URL is named for a ROLE, not a host, which is how
  // it came to hold both meanings. It stays readable — secrets outlive deploys — and it is never
  // again the name of anything.
  it("COLTRANE_DRAIN_URL survives only as a legacy alias of the service url", async () => {
    const { WORKER_ENV_CONTRACT } = await workerEnv();
    expect(WORKER_ENV_CONTRACT, "the import is the specification").toBeDefined();
    expect(
      WORKER_ENV_CONTRACT.map((v) => v.name),
      "the role-named variable is not canonical anywhere",
    ).not.toContain("COLTRANE_DRAIN_URL");
    const service = WORKER_ENV_CONTRACT.find((v) => v.role === "url" && v.host === "service");
    expect(service, "the service still needs a url").toBeDefined();
    expect(service!.legacy_names ?? [], "and the old name normalizes onto it").toContain(
      "COLTRANE_DRAIN_URL",
    );
  });

  // THE COMPLETENESS LAW, and the one that keeps the document honest. A contract enumerating a
  // SUBSET is the same defect one layer up: it reads as the whole truth and is not.
  //
  // This reads source text for the same reason tests/advertised_args_are_read.test.ts does — the
  // property is "a declaration matches what the code does", and only the code can testify to the
  // second half.
  it("enumerates every environment variable the worker path actually reads", async () => {
    const { WORKER_ENV_CONTRACT } = await workerEnv();
    expect(WORKER_ENV_CONTRACT, "the import is the specification").toBeDefined();

    const known = new Set<string>();
    for (const v of WORKER_ENV_CONTRACT) {
      known.add(v.name);
      for (const legacy of v.legacy_names ?? []) known.add(legacy);
    }

    const WORKER_PATH = ["worker.ts", "cli.ts", "output_mirror.ts", "workspace.ts", "run_deps.ts", "worker_env.ts"];
    const missing: string[] = [];
    for (const file of WORKER_PATH) {
      const path = join(SRC, file);
      if (!existsSync(path)) continue; // worker_env.ts is the module being specified
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/process\.env\["([A-Z][A-Z0-9_]*)"\]/g)) {
        const name = m[1]!;
        if (!known.has(name)) missing.push(`${file}: ${name}`);
      }
    }
    expect(missing, "a variable the worker reads and the contract omits is an undocumented dependency")
      .toEqual([]);
  });
});

describe("GAP 3 — a legacy shape NORMALIZES, it never appends", () => {
  // The specific mechanical defect: 0.9.1 appended `/rest/v1/rpc/` to a value that already ended in
  // `/rest/v1`, producing `/rest/v1/rest/v1/rpc/…` and PGRST125. src/output_mirror.ts:317 states the
  // general fix — build from the ORIGIN — and this law pins it as a property of the normalizer
  // rather than of each caller that remembers to.
  it("strips a legacy path suffix instead of building on top of it", async () => {
    const { normalizeWorkerEnv } = await workerEnv();
    expect(normalizeWorkerEnv, "the import is the specification").toBeTypeOf("function");
    const out = normalizeWorkerEnv({ ...VENUE_ENV, COLTRANE_SERVICE_URL: "https://coltrane.example/rest/v1" });
    expect(out["COLTRANE_SERVICE_URL"]).toBe("https://coltrane.example");
  });

  it("maps the legacy name onto the canonical one", async () => {
    const { normalizeWorkerEnv } = await workerEnv();
    expect(normalizeWorkerEnv, "the import is the specification").toBeTypeOf("function");
    const legacy = { ...VENUE_ENV } as Record<string, string | undefined>;
    delete legacy["COLTRANE_SERVICE_URL"];
    legacy["COLTRANE_DRAIN_URL"] = "https://coltrane.example";
    const out = normalizeWorkerEnv(legacy);
    expect(out["COLTRANE_SERVICE_URL"], "the old name still works; it just is not the name")
      .toBe("https://coltrane.example");
  });

  // The instance fallback is a legacy alias too, and naming it as one is the point: a
  // provider-specific variable inside a provider-agnostic engine means a box can acquire a venue
  // identity nobody set. Tolerated and visible beats convenient and undocumented.
  it("treats the hosting provider's app name as a legacy alias of the instance", async () => {
    const { normalizeWorkerEnv } = await workerEnv();
    expect(normalizeWorkerEnv, "the import is the specification").toBeTypeOf("function");
    const env = { ...VENUE_ENV } as Record<string, string | undefined>;
    delete env["COLTRANE_INSTANCE"];
    env["FLY_APP_NAME"] = "my-laptop";
    expect(normalizeWorkerEnv(env)["COLTRANE_INSTANCE"]).toBe("my-laptop");
  });

  // Idempotence is the property that makes normalization safe to apply anywhere, which is what
  // stops the next caller from appending "just in case it was not done yet".
  it("is idempotent — applying it twice changes nothing", async () => {
    const { normalizeWorkerEnv } = await workerEnv();
    expect(normalizeWorkerEnv, "the import is the specification").toBeTypeOf("function");
    const once = normalizeWorkerEnv({ ...VENUE_ENV, COLTRANE_SERVICE_URL: "https://coltrane.example/rest/v1/" });
    expect(normalizeWorkerEnv(once)).toEqual(once);
    expect(JSON.stringify(once), "no doubled path segment may survive").not.toMatch(/rest\/v1\/rest\/v1/);
  });
});

describe("GAP 3 — a misconfigured worker refuses at startup, in its own voice", () => {
  // The good cases first, so a refusal law cannot pass by refusing everything.
  it("accepts a complete venue environment and a complete player environment", async () => {
    const { assertWorkerEnv } = await workerEnv();
    expect(assertWorkerEnv, "the import is the specification").toBeTypeOf("function");
    expect(() => assertWorkerEnv(VENUE_ENV)).not.toThrow();
    expect(() => assertWorkerEnv(PLAYER_ENV)).not.toThrow();
  });

  it("names the required variable that is absent", async () => {
    const { assertWorkerEnv } = await workerEnv();
    expect(assertWorkerEnv, "the import is the specification").toBeTypeOf("function");
    const env = { ...VENUE_ENV } as Record<string, string | undefined>;
    delete env["COLTRANE_SERVICE_URL"];
    expect(() => assertWorkerEnv(env)).toThrow(/COLTRANE_SERVICE_URL/);
  });

  // THE GENERAL FORM OF THE DEFECT, detectable without knowing which of the two is wrong: two
  // variables that must name different hosts, naming the same one. This is what "pointed at the
  // database" looked like from inside the box, and nothing asked the question until a write failed.
  it("refuses an environment where the store and the service name the same host", async () => {
    const { assertWorkerEnv } = await workerEnv();
    expect(assertWorkerEnv, "the import is the specification").toBeTypeOf("function");
    expect(() =>
      assertWorkerEnv({ ...VENUE_ENV, COLTRANE_SERVICE_URL: VENUE_ENV["COLTRANE_STORE_URL"]! }),
    ).toThrow(/COLTRANE_SERVICE_URL[\s\S]*COLTRANE_STORE_URL|COLTRANE_STORE_URL[\s\S]*COLTRANE_SERVICE_URL/);
  });

  // The existing diagnostic (src/output_mirror.ts:331), moved to where it belongs. Today it fires
  // at the first write — after a gig has been claimed, loaded, run, and paid for. A worker pointed
  // at the wrong host must fail before it claims anything.
  it("refuses a service url that names the managed database, before the first request", async () => {
    const { assertWorkerEnv } = await workerEnv();
    expect(assertWorkerEnv, "the import is the specification").toBeTypeOf("function");
    expect(() =>
      assertWorkerEnv({ ...VENUE_ENV, COLTRANE_SERVICE_URL: "https://abcdefgh.supabase.co" }),
    ).toThrow(/COLTRANE_SERVICE_URL/);
  });

  // Two names for one host that DISAGREE is the defect in its purest form. Picking a winner
  // silently is how it survived three releases; refusing names both and ends it in one line.
  it("refuses a legacy alias that contradicts the canonical name", async () => {
    const { assertWorkerEnv } = await workerEnv();
    expect(assertWorkerEnv, "the import is the specification").toBeTypeOf("function");
    expect(() =>
      assertWorkerEnv({ ...VENUE_ENV, COLTRANE_DRAIN_URL: "https://something-else.example" }),
    ).toThrow(/COLTRANE_DRAIN_URL[\s\S]*COLTRANE_SERVICE_URL|COLTRANE_SERVICE_URL[\s\S]*COLTRANE_DRAIN_URL/);
    // …and agreeing is fine. A box carrying both after a redeploy is the ordinary case.
    expect(() =>
      assertWorkerEnv({ ...VENUE_ENV, COLTRANE_DRAIN_URL: VENUE_ENV["COLTRANE_SERVICE_URL"]! }),
    ).not.toThrow();
  });

  // A url that is not a url. Cheap, and it is the failure that presented as an HTTP 307 retry loop
  // — the value was reachable and answered, just not by the thing the caller thought it was.
  it("refuses a url-shaped variable that is not a url", async () => {
    const { assertWorkerEnv } = await workerEnv();
    expect(assertWorkerEnv, "the import is the specification").toBeTypeOf("function");
    expect(() => assertWorkerEnv({ ...VENUE_ENV, COLTRANE_SERVICE_URL: "coltrane.example" }))
      .toThrow(/COLTRANE_SERVICE_URL/);
  });
});
