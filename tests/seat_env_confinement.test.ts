import { describe, it, expect } from "vitest";
import { withoutBoxCredentials } from "../src/claude_invoker.js";

describe("a seat never inherits the credentials that make the box the box", () => {
  // The live drain path builds no SeatRealization (worker.ts passes no venue to runGig), so before
  // this the spawn inherited process.env wholesale — and on Fly that env holds COLTRANE_DRAIN_KEY,
  // because Fly surfaces secrets to the whole container. Seats are `claude -p` with Bash.
  it("strips the venue's own identity", () => {
    const env = withoutBoxCredentials({
      COLTRANE_DRAIN_KEY: "dk_secret",
      COLTRANE_DRAIN_URL: "https://store.example",
      PATH: "/usr/bin",
    });
    expect(env.COLTRANE_DRAIN_KEY).toBeUndefined();
    expect(env.COLTRANE_DRAIN_URL).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("strips credentials that are strictly MORE powerful than the drain key", () => {
    const env = withoutBoxCredentials({
      COLTRANE_PROVISIONER_KEY: "pk_x",   // mints drain keys
      SUPABASE_SERVICE_ROLE_KEY: "srk_x", // bypasses RLS entirely
      FLY_API_TOKEN: "fly_x",             // creates and destroys machines
      GITHUB_APP_PRIVATE_KEY_B64: "b64",
    });
    expect(Object.keys(env)).toEqual([]);
  });

  it("keeps what a seat needs to run at all", () => {
    // Deliberately NOT denied: a seat is a `claude -p` process and this is how it authenticates.
    // Denying it would not harden the box, it would stop the box working.
    const env = withoutBoxCredentials({
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CONFIG_DIR: "/data/.claude",
      HOME: "/root",
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/data/.claude");
  });

  it("drops undefined values rather than passing them as the string 'undefined'", () => {
    const env = withoutBoxCredentials({ SET: "yes", UNSET: undefined });
    expect(env.SET).toBe("yes");
    expect("UNSET" in env).toBe(false);
  });
});
