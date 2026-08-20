// ════════════════════════════════════════════════════════════════════════════════════════════
// THE LAWS OF `coltrane work --check` — the drain-environment preflight given a CLI SURFACE.
//
// src/drain_preflight.ts already exports drainPreflight(env), a PURE collector over the drain's
// five-variable environment contract (present / missing / suspicious). NOTHING CALLS IT. This change
// gives it a surface: `coltrane work --check` runs the collector, renders it BY VARIABLE NAME AND
// PRESENCE (never value) to io.err, and returns an exit code that distinguishes a ready box (0) from
// an unready one (1) — WITHOUT claiming a gig, contacting a store, or running anything.
//
// runCli(argv, io) is a pure function over an injected IO record, so the whole surface is exercised
// here with no process spawned. The `work` branch reads process.env DIRECTLY (not through io), so
// each law stubs process.env in beforeEach and restores it in afterEach — the hermetic pattern from
// tests/venue_dispatch/cli_work_wires_venue_realizer.test.ts.
//
// SIX LAWS:
//   READY      — all five required vars present, drain host != store host  ⇒ exit 0, each var named present
//   MISSING    — one required var absent                                   ⇒ exit 1, the absent var named
//   CONFLATION — DRAIN_URL host equals STORE_URL host                      ⇒ exit 1, the conflation surfaced
//   NO-SECRET  — a report IS produced and carries no env-var VALUE          (a report the operator can paste)
//   NO-CLAIM   — --check invokes no workOnce and touches no store           (claims nothing, runs nothing)
//   PIN        — flagless `coltrane work` behaves exactly as it does today  (the --check branch disturbs nothing)
//
// RED STATE: before src/cli.ts grows a --check branch, `work --check` is an unrecognized flag that
// falls THROUGH to the credential/claim path — it either reaches the workOnce call (so NO-CLAIM's
// double is invoked and no presence report reaches io.err) or exits on the credential check. Either
// way the READY/MISSING/CONFLATION/NO-SECRET reports do not exist and NO-CLAIM's not-invoked
// assertion is violated. PIN is GREEN before and after — its role is to fail only if the new branch
// or the USAGE edit disturbs the flagless command.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Every env var the `work` branch (or drainPreflight, via normalizeWorkerEnv) may read. Cleared
// before each law so the HOST environment cannot leak a var into (or out of) a case.
const ENV_KEYS = [
  "COLTRANE_STORE_URL",
  "COLTRANE_STORE_ANON",
  "COLTRANE_DRAIN_URL",
  "COLTRANE_DRAIN_KEY",
  "COLTRANE_INSTANCE",
  "COLTRANE_AGENT_TOKEN",
  "COLTRANE_SERVICE_URL",
  "FLY_APP_NAME",
  "COLTRANE_MODEL",
  "COLTRANE_CHAIR_TIMEOUT_MS",
  "COLTRANE_WORKER_CHECKPOINTS",
];

// Sentinel secret VALUES. A cdk_-shaped drain key and an anon-key value, both distinctive enough that
// their presence anywhere in the rendered output is unambiguous. NO-SECRET proves neither is echoed.
const SECRET_DRAIN_KEY = "cdk_super_secret_value_9f3a2b";
const SECRET_ANON = "anon-eyJhbGciOiJ-secret-sentinel-value";

/** A fully-populated venue box: all five required vars, drain host != store host, no conflation. */
function readyEnv(): Record<string, string> {
  return {
    COLTRANE_STORE_URL: "https://store.example",
    COLTRANE_STORE_ANON: SECRET_ANON,
    COLTRANE_DRAIN_URL: "https://coltrane.example",
    COLTRANE_DRAIN_KEY: SECRET_DRAIN_KEY,
    COLTRANE_INSTANCE: "drain-box-01",
  };
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
  vi.doUnmock("../src/worker.js");
  vi.unstubAllGlobals();
});

function setEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

/**
 * Load a FRESH src/cli.ts with src/worker.js's workOnce replaced by a spy. The spy stands in for a
 * completed claim, so if a case ever falls through to the claim path it does no network I/O — and
 * NO-CLAIM/PIN can inspect whether it was reached. worker_env.js (workerCredentialMode) is left
 * REAL, so the credential derivation the `work` branch depends on runs unchanged.
 */
async function loadCli() {
  const workOnce = vi.fn(async () => ({
    claimed: true,
    gig_id: "g-mock-0000",
    status: "complete",
    outputs_count: 0,
  }));
  vi.resetModules();
  vi.doMock("../src/worker.js", () => ({ workOnce }));
  const { runCli } = await import("../src/cli.js");
  const errParts: string[] = [];
  const outParts: string[] = [];
  const io = {
    out: (s: string) => outParts.push(s),
    err: (s: string) => errParts.push(s),
  };
  return {
    runCli,
    workOnce,
    io,
    err: () => errParts.join(""),
    out: () => outParts.join(""),
    all: () => errParts.join("") + outParts.join(""),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// LAW READY — a fully-configured box reports ready. All five required vars present, drain host !=
// store host: exit 0, and io.err names each required variable as present. RED today: --check is an
// unrecognized flag, so no presence report is rendered to io.err.
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("work --check READY — a satisfied environment exits 0 and names each var present", () => {
  it("returns 0 and renders each required variable by name and present", async () => {
    setEnv(readyEnv());
    const cli = await loadCli();
    const code = await cli.runCli(["work", "--check"], cli.io);

    expect(code, "a ready box exits 0").toBe(0);
    const err = cli.err();
    for (const name of [
      "COLTRANE_STORE_URL",
      "COLTRANE_STORE_ANON",
      "COLTRANE_DRAIN_URL",
      "COLTRANE_DRAIN_KEY",
      "COLTRANE_INSTANCE",
    ]) {
      expect(err, `the report must name ${name}`).toContain(name);
    }
    // A presence report, not a claim summary — the report says these vars are present.
    expect(err, "the report classifies vars as present").toMatch(/present/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// LAW MISSING — a required variable absent makes the box unready. Drop COLTRANE_DRAIN_URL (a var the
// credential check does NOT read, so on RED code control still falls through to the claim path rather
// than the credential refusal): exit 1, and io.err names THAT variable specifically. RED today: no
// preflight report is rendered and the readiness exit code is never returned.
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("work --check MISSING — an absent required var exits 1 and names it", () => {
  it("returns 1 and names the specific missing variable on io.err", async () => {
    const env = readyEnv();
    delete (env as Record<string, string | undefined>)["COLTRANE_DRAIN_URL"];
    setEnv(env as Record<string, string>);
    const cli = await loadCli();

    const code = await cli.runCli(["work", "--check"], cli.io);
    expect(code, "an unready box exits 1").toBe(1);
    const err = cli.err();
    expect(err, "the absent variable is named specifically").toContain("COLTRANE_DRAIN_URL");
    expect(err, "and reported as absent/missing, not generic").toMatch(/missing|absent|not set/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// LAW CONFLATION — the store/service conflation drainPreflight already collects is SURFACED, not
// silently swallowed. All five vars present but COLTRANE_DRAIN_URL host equal to COLTRANE_STORE_URL
// host (write path aimed at the read endpoint): exit 1, and io.err says so. Includes the /rest/v1
// suffix variant, which normalizeWorkerEnv strips — so a surviving suffix cannot mask the same-host
// conflation. RED today: nothing calls the collector from the CLI, so the conflation is never told.
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("work --check CONFLATION — drain host == store host exits 1 and is surfaced", () => {
  it("returns 1 and surfaces the store/service conflation to the operator", async () => {
    setEnv({
      ...readyEnv(),
      COLTRANE_STORE_URL: "https://store.example",
      COLTRANE_DRAIN_URL: "https://store.example",
    });
    const cli = await loadCli();

    const code = await cli.runCli(["work", "--check"], cli.io);
    expect(code, "a conflated box is unready — exit 1").toBe(1);
    const err = cli.err();
    expect(err, "the conflation names the drain variable").toContain("COLTRANE_DRAIN_URL");
    // drainPreflight's message says the write path is aimed at the read endpoint; the surface must
    // carry that reason through, not merely count the variable as present.
    expect(err, "the reason — write path aimed at read endpoint — is surfaced").toMatch(
      /write path|read endpoint|conflat|same host/i,
    );
  });

  it("surfaces the conflation even when the store url carries a legacy /rest/v1 suffix", async () => {
    setEnv({
      ...readyEnv(),
      COLTRANE_STORE_URL: "https://store.example/rest/v1",
      COLTRANE_DRAIN_URL: "https://store.example",
    });
    const cli = await loadCli();

    const code = await cli.runCli(["work", "--check"], cli.io);
    expect(code, "the suffix must not hide the same-host conflation").toBe(1);
    expect(cli.err()).toContain("COLTRANE_DRAIN_URL");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// LAW NO-SECRET — a report is produced AND carries no secret VALUE. Across a ready render and a
// conflation render, the serialized io.err+io.out names the drain key and anon variables (proving a
// report exists) yet contains NEITHER the cdk_ key value NOR the anon-key value. RED today: no report
// is produced for --check, so the "report present" precondition (the var is named) is unmet.
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("work --check NO-SECRET — a report is produced and echoes no secret value", () => {
  it("names the secret-bearing variables but never prints their values (ready case)", async () => {
    setEnv(readyEnv());
    const cli = await loadCli();
    await cli.runCli(["work", "--check"], cli.io);

    const err = cli.err();
    // Report present: the variables are named. (This is the precondition that is RED before the surface exists.)
    expect(err, "COLTRANE_DRAIN_KEY is named").toContain("COLTRANE_DRAIN_KEY");
    expect(err, "COLTRANE_STORE_ANON is named").toContain("COLTRANE_STORE_ANON");
    // No secret: neither VALUE appears anywhere in the rendered output.
    const all = cli.all();
    expect(all, "the cdk_ drain key value must never be printed").not.toContain(SECRET_DRAIN_KEY);
    expect(all, "the anon key value must never be printed").not.toContain(SECRET_ANON);
  });

  it("prints no secret value in the conflation case either", async () => {
    setEnv({
      ...readyEnv(),
      COLTRANE_STORE_URL: "https://store.example",
      COLTRANE_DRAIN_URL: "https://store.example",
    });
    const cli = await loadCli();
    await cli.runCli(["work", "--check"], cli.io);

    const all = cli.all();
    expect(all).toContain("COLTRANE_DRAIN_KEY"); // report present
    expect(all).not.toContain(SECRET_DRAIN_KEY);
    expect(all).not.toContain(SECRET_ANON);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// LAW NO-CLAIM — --check claims nothing and runs nothing. With workOnce replaced by a spy, running
// `work --check` on a fully-ready venue env NEVER invokes workOnce and NEVER contacts a store. RED
// today: --check falls through to the claim path, so the workOnce double IS invoked.
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("work --check NO-CLAIM — claims nothing, runs nothing, touches no store", () => {
  it("never invokes workOnce and issues no fetch", async () => {
    setEnv(readyEnv());
    // A fetch spy proves no store is contacted directly, independent of the workOnce double.
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const cli = await loadCli();

    const code = await cli.runCli(["work", "--check"], cli.io);
    expect(code, "a ready box exits 0").toBe(0);
    expect(cli.workOnce, "--check must not claim or run a gig").toHaveBeenCalledTimes(0);
    expect(fetchSpy, "--check must not contact a store").toHaveBeenCalledTimes(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// LAW PIN (regression) — `coltrane work` with NO flags behaves exactly as it does today. This law is
// GREEN before AND after the change; it fails only if the new --check branch or the USAGE edit
// disturbs the flagless path. Two characterizations: a fully-credentialled flagless run still reaches
// workOnce and returns its status-derived exit code; a flagless run with no credentials still exits 2
// on the pre-existing credential check.
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("work PIN — flagless `coltrane work` is unchanged", () => {
  it("a credentialled flagless run still reaches workOnce and exits 0 on a completed claim", async () => {
    setEnv(readyEnv());
    const cli = await loadCli();

    const code = await cli.runCli(["work"], cli.io);
    expect(cli.workOnce, "flagless work must still claim and run").toHaveBeenCalledTimes(1);
    expect(code, "a completed claim exits 0, exactly as today").toBe(0);
  });

  it("a flagless run with no credentials still exits 2 on the credential check", async () => {
    // No env set — the pre-existing credential path must refuse with exit 2 and never reach workOnce.
    const cli = await loadCli();

    const code = await cli.runCli(["work"], cli.io);
    expect(code, "the flagless credential refusal is exit 2, unchanged").toBe(2);
    expect(cli.workOnce, "a refused flagless run never claims").toHaveBeenCalledTimes(0);
    expect(cli.err(), "the refusal names the store credentials it needs").toContain("COLTRANE_STORE_URL");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// LAW REACHABLE — the command is reachable from an INSTALLED package, not only this working tree.
// The bin maps `coltrane` to the compiled cli entry and the published `files` list ships that
// compiled tree, so behaviour compiled from src/cli.ts is what an installed operator runs. Pinned as
// an executable law (a static read of package.json) so a future files/bin edit that stranded the
// command outside the published surface would fail here. GREEN before and after — the mapping already
// holds; this guards it against regression while the surface is added.
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("work --check REACHABLE — the compiled command ships in the published package", () => {
  it("bin.coltrane points at the compiled cli entry and files ships dist/src", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const pkg = JSON.parse(readFileSync(repo + "package.json", "utf8")) as {
      bin: Record<string, string>;
      files: string[];
    };
    // cli_entry.ts delegates to runCli (src/cli_entry.ts:7,18) — so the compiled cli.ts IS the surface run.
    expect(pkg.bin["coltrane"], "the coltrane bin is the compiled cli entry").toBe("./dist/src/cli_entry.js");
    expect(pkg.files, "the published package must ship the compiled source tree").toContain("dist/src");
  });
});
