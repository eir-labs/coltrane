// The caged browser — coltrane's deny-by-default wrapper over @playwright/mcp. An agent declares
// the origins it may reach; coltrane builds the server config that enforces exactly that
// (--allowed-origins), in an ephemeral profile (--isolated), headless, with the session saved for
// provenance. The deny-by-default + allowlist behavior is proven LIVE in
// tests/e2e/playwright_cage_live.spec.ts (allowlisted origin loads; off-list is refused at the
// network). Here: the config the builder ships is exactly right, and the grant→cage resolution.
import { describe, it, expect } from "vitest";
import { buildPlaywrightCage, playwrightServerFor } from "../src/playwright_cage.js";

describe("buildPlaywrightCage — the deny-by-default browser cage config", () => {
  it("enforces the nav allowlist via --allowed-origins (the deny-by-default boundary)", () => {
    const cfg = buildPlaywrightCage({ allowedOrigins: ["ppubs.uspto.gov", "patents.google.com"] });
    const i = cfg.args.indexOf("--allowed-origins");
    expect(i, "--allowed-origins must be present").toBeGreaterThan(0);
    expect(cfg.args[i + 1]).toBe("ppubs.uspto.gov;patents.google.com"); // semicolon-separated
  });

  it("hardens by default: isolated (ephemeral) + headless", () => {
    const cfg = buildPlaywrightCage({ allowedOrigins: ["ppubs.uspto.gov"] });
    expect(cfg.args).toContain("--isolated");
    expect(cfg.args).toContain("--headless");
  });

  it("saves the session for provenance when a trace dir is given", () => {
    const cfg = buildPlaywrightCage({ allowedOrigins: ["x.gov"], traceDir: "/tmp/t" });
    expect(cfg.args).toContain("--save-session");
    expect(cfg.args[cfg.args.indexOf("--output-dir") + 1]).toBe("/tmp/t");
  });

  it("always passes --allowed-origins even when empty (fail closed — browses nothing)", () => {
    const cfg = buildPlaywrightCage({ allowedOrigins: [] });
    const i = cfg.args.indexOf("--allowed-origins");
    expect(i).toBeGreaterThan(0);
    expect(cfg.args[i + 1]).toBe(""); // empty allowlist = deny all, never "no flag = allow all"
  });

  it("supports a blocked-origins denylist", () => {
    const cfg = buildPlaywrightCage({ allowedOrigins: ["*.gov"], blockedOrigins: ["evil.gov"] });
    expect(cfg.args[cfg.args.indexOf("--blocked-origins") + 1]).toBe("evil.gov");
  });
});

describe("playwrightServerFor — an agent's declared browser grant builds its cage", () => {
  it("returns a caged config scoped to the agent's declared origins", () => {
    const cfg = playwrightServerFor({ allowed_origins: ["ppubs.uspto.gov"], trace_dir: "/tmp/tr" });
    expect(cfg, "a grant with origins yields a caged server").toBeTruthy();
    expect(cfg!.args).toContain("--allowed-origins");
    expect(cfg!.args[cfg!.args.indexOf("--allowed-origins") + 1]).toBe("ppubs.uspto.gov");
  });

  it("returns null when the agent declares no browser grant (no caged browser is wired)", () => {
    expect(playwrightServerFor(undefined)).toBeNull();
  });
});
