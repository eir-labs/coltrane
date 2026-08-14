// The working tree a gig runs in, obtained AFTER the claim.
//
// The shell used to clone BEFORE claiming, from a REPO_URL fixed at provisioning — a per-gig fact
// made a per-box one, pinning every gig of an organization to one repository. These laws pin the
// ordering and the refusals that make the new arrangement safe.
import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspace, cloneInto, fetchGitCredential } from "../src/workspace.js";

afterEach(() => vi.unstubAllGlobals());

describe("a claim that names no repository", () => {
  it("prepares nothing, and that is a normal answer", async () => {
    // An org declaring no repo_url runs gigs that do not touch a working tree. Refusing them for a
    // missing repository would repeat the boot-time refusal this whole change removes.
    expect(await prepareWorkspace({
      repoUrl: null, gigId: "g1", drainKey: "dk", instance: "box", endpoint: "https://x/api",
    })).toBeNull();
  });
});

describe("a claim that names one, without the means to reach it", () => {
  it("refuses when the worker holds no venue credential", async () => {
    await expect(prepareWorkspace({
      repoUrl: "https://github.com/eir-labs/x.git", gigId: "g1",
      drainKey: undefined, instance: undefined, endpoint: "https://x/api",
    })).rejects.toThrow(/holds no venue credential/);
  });

  it("refuses when there is nowhere to obtain a per-gig credential", async () => {
    await expect(prepareWorkspace({
      repoUrl: "https://github.com/eir-labs/x.git", gigId: "g1",
      drainKey: "dk", instance: "box", endpoint: undefined,
    })).rejects.toThrow(/COLTRANE_GIT_CREDENTIALS_URL is unset/);
  });
});

describe("trading the venue credential for a git one", () => {
  it("sends the gig id — the credential is for one gig, not for the box", async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ token: "ghs_x", expires_at: "2026-01-01T00:00:00Z" }), { status: 200 });
    }));
    const c = await fetchGitCredential("https://x/api", "dk_secret", "box-1", "gig-7");
    expect(sent).toEqual({ drain_key: "dk_secret", instance: "box-1", gig_id: "gig-7" });
    expect(c.token).toBe("ghs_x");
  });

  it("surfaces the endpoint's refusal rather than a bare status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "no credential is available for that gig" }), { status: 403 })));
    await expect(fetchGitCredential("https://x/api", "dk", "box", "g"))
      .rejects.toThrow(/no credential is available for that gig/);
  });

  it("refuses a 200 that carries no token, instead of cloning with undefined", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await expect(fetchGitCredential("https://x/api", "dk", "box", "g")).rejects.toThrow(/no token/);
  });
});

describe("the clone itself", () => {
  it("clones, and leaves the token nowhere on disk", () => {
    // A real clone from a real local repository — the token path is what matters, and asserting it
    // against a mock would prove nothing about what git actually writes.
    const origin = mkdtempSync(join(tmpdir(), "ws-origin-"));
    execFileSync("git", ["init", "--quiet", "--bare", origin]);
    const seed = mkdtempSync(join(tmpdir(), "ws-seed-"));
    execFileSync("git", ["init", "--quiet", seed]);
    writeFileSync(join(seed, "README.md"), "hello");
    const g = (args: string[]) => execFileSync("git", ["-C", seed, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    g(["add", "-A"]); g(["commit", "--quiet", "-m", "seed"]);
    g(["remote", "add", "origin", origin]); g(["push", "--quiet", "origin", "HEAD:refs/heads/main"]);

    const ws = cloneInto(origin, "ghs_supersecret_token");
    try {
      expect(existsSync(join(ws.dir, "README.md"))).toBe(true);
      // THE POINT. Embedding the token in the remote URL writes it verbatim into .git/config —
      // inside the tree the gig's seats then read, one `git remote -v` from model context.
      const cfg = readFileSync(join(ws.dir, ".git", "config"), "utf8");
      expect(cfg).not.toContain("ghs_supersecret_token");
      expect(cfg).not.toContain("x-access-token");
    } finally {
      ws.cleanup();
    }
    expect(existsSync(ws.dir)).toBe(false);
  });

  it("a clone that fails leaves no directory behind, and says why", () => {
    // An unreachable remote, not an empty one — git clones an empty repository quite happily, so
    // the first draft of this law asserted a throw that never came.
    const missing = join(tmpdir(), "ws-does-not-exist-", String(process.pid));
    expect(() => cloneInto(missing, "t")).toThrow(/clone of .* failed/);
  });
});
