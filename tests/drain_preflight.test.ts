// ════════════════════════════════════════════════════════════════════════════════════════════
// THE FIVE LAWS OF THE DRAIN PREFLIGHT — the checking half of the drain drill, testable with NO
// credentials at all. `drainPreflight(env)` reads the drain's five-variable environment contract
// and COLLECTS what it finds — present / missing / suspicious — instead of throwing. It is a pure
// function of an env-like record: no network, no filesystem, no process.env. See the change brief
// and src/drain_preflight.ts.
//
// The two endpoints operators conflate:
//   COLTRANE_STORE_URL   the Supabase project — the READ path (genome rows + claim RPCs)
//   COLTRANE_DRAIN_URL   the Coltrane SERVICE ORIGIN — the WRITE path
// They are DIFFERENT HOSTS. A COLTRANE_DRAIN_URL whose host equals the COLTRANE_STORE_URL host is
// the store/service conflation: the write path aimed at the read endpoint. Catching that is the
// preflight's whole reason to exist.
//
// The import is STATIC on purpose: until src/drain_preflight.ts exists these laws fail at import
// resolution — the RED state that proves they bind before the code does.
import { describe, it, expect } from "vitest";
import { drainPreflight, type DrainPreflightResult } from "../src/drain_preflight.js";

/** The five operator-facing variables the drain reads, by the names an operator actually sets. */
const FIVE = [
  "COLTRANE_STORE_URL",
  "COLTRANE_STORE_ANON",
  "COLTRANE_DRAIN_URL",
  "COLTRANE_DRAIN_KEY",
  "COLTRANE_INSTANCE",
];

/**
 * A fully-populated, correctly-configured env: store and service on DIFFERENT hosts, a cdk_ drain
 * key, an anon key. Placeholder hosts and placeholder secrets per the public-repo convention.
 */
function validEnv(): Record<string, string> {
  return {
    COLTRANE_STORE_URL: "https://store.example",
    COLTRANE_STORE_ANON: "anon-placeholder-key",
    COLTRANE_DRAIN_URL: "https://coltrane.example",
    COLTRANE_DRAIN_KEY: "cdk_placeholder_key",
    COLTRANE_INSTANCE: "drain-box-01",
  };
}

describe("drainPreflight — the drain environment-contract preflight", () => {
  // LAW 1 — PURE. It reads its argument and nothing else. Poison process.env, hand it an empty
  // object, and the poison stays invisible: the result reflects the ARGUMENT, not the ambient
  // environment. Deterministic on the same input, and it never throws — runnable with zero creds.
  it("is PURE — reads its argument, never process.env, and does no I/O", () => {
    const saved = process.env.COLTRANE_STORE_URL;
    process.env.COLTRANE_STORE_URL = "https://leaked-from-process-env.example";
    try {
      const result = drainPreflight({});
      expect(JSON.stringify(result)).not.toContain("leaked-from-process-env");
      expect(result.missing.map((m) => m.variable)).toContain("COLTRANE_STORE_URL");
      // Same input → same output: no hidden ambient state feeding the answer.
      expect(drainPreflight({})).toEqual(result);
    } finally {
      if (saved === undefined) delete process.env.COLTRANE_STORE_URL;
      else process.env.COLTRANE_STORE_URL = saved;
    }
  });

  // LAW 2 — MISSING VARIABLES ARE NAMED. Drop each of the five in turn; the result names THAT exact
  // variable in missing[], and reports nothing generic in its place.
  it("NAMES each missing variable specifically, one absent at a time", () => {
    const full = validEnv();
    for (const name of FIVE) {
      const env: Record<string, string | undefined> = { ...full };
      delete env[name];
      const result = drainPreflight(env);
      const missingNames = result.missing.map((m) => m.variable);
      expect(missingNames).toContain(name); // this exact variable, by name
      expect(result.missing).toHaveLength(1); // and only it — not a generic failure
    }
  });

  // LAW 3 — THE CONFLATION IS CAUGHT. A COLTRANE_DRAIN_URL whose host equals the COLTRANE_STORE_URL
  // host is suspicious, and the message says the write path is aimed at the read endpoint. The
  // check runs on NORMALIZED hosts, so a legacy /rest/v1 suffix on the store url cannot hide it.
  it("CATCHES the store/service conflation — DRAIN_URL host equal to STORE_URL host", () => {
    const env = {
      ...validEnv(),
      COLTRANE_STORE_URL: "https://store.example",
      COLTRANE_DRAIN_URL: "https://store.example",
    };
    const result = drainPreflight(env);
    const flagged = result.suspicious.find((x) => x.variable === "COLTRANE_DRAIN_URL");
    expect(flagged).toBeDefined();
    expect(flagged!.message).toContain("write path");
    expect(flagged!.message).toContain("read endpoint");
    // A legacy /rest/v1 suffix on the store url must not hide the same-host conflation.
    const withSuffix = {
      ...validEnv(),
      COLTRANE_STORE_URL: "https://store.example/rest/v1",
      COLTRANE_DRAIN_URL: "https://store.example",
    };
    expect(
      drainPreflight(withSuffix).suspicious.some((x) => x.variable === "COLTRANE_DRAIN_URL"),
    ).toBe(true);
  });

  // LAW 4 — NO SECRET LEAKS. A populated env with a real-shaped cdk_ key value and an anon-key value
  // yields a result whose serialization contains NEITHER literal — presence and class only.
  it("NEVER leaks a secret — neither the cdk_ key nor the anon key appears in the result", () => {
    const env = {
      ...validEnv(),
      COLTRANE_DRAIN_KEY: "cdk_super_secret_value_9f3a2b",
      COLTRANE_STORE_ANON: "anon-eyJhbGciOiJ-secret-value",
    };
    const serialized = JSON.stringify(drainPreflight(env));
    expect(serialized).not.toContain("cdk_super_secret_value_9f3a2b");
    expect(serialized).not.toContain("anon-eyJhbGciOiJ-secret-value");
  });

  // LAW 5 — STRUCTURE. A fully-present, valid env: empty missing[], empty suspicious[], present[]
  // naming all five, and the drain key reported only as its class prefix 'cdk_'.
  it("reports a fully-valid env as all-present, no suspicion, key as class only", () => {
    const result: DrainPreflightResult = drainPreflight(validEnv());
    expect(result.missing).toEqual([]);
    expect(result.suspicious).toEqual([]);
    expect(result.present.map((p) => p.variable).sort()).toEqual([...FIVE].sort());
    const key = result.present.find((p) => p.variable === "COLTRANE_DRAIN_KEY");
    expect(key?.key_class).toBe("cdk_");
  });
});
