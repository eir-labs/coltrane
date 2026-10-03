// A ROOM FURNISHES ITS TREES — the workspace clones every granted repository into its own folder,
// one credential per tree, and the change-request's tree (when there is one) is the seat's cwd.
// (spec: wiki spec.one-write-path.a-room-furnishes-its-reach; founder's ruling R38, 3 Oct 2026)
//
// THE SHAPE. A gig dispatched into a room whose github connector grants N repositories gets N
// clones under ONE workspace root, `<root>/<name>` each. Each clone is obtained with its OWN
// credential: the broker is asked once per tree, naming the repository, and mints a token scoped to
// that repository alone (one enforcement surface — the broker; the engine re-derives no grant).
// A change gig's change-request names the tree its change lands in; that tree is the cwd and the
// tree a change-set is stamped from. A reading gig names none; its cwd is the root, and the mounts
// are beside each other. There is no "primary": there is the tree the change lands in, or none.
//
//   W1  fetchGitCredential names the repository when given one, and sends exactly the old body when
//       not — a one-repository caller is byte-for-byte as before
//   W2  prepareWorkspaces clones every tree under one root, each in its own folder, and asks the
//       broker once PER TREE, naming it
//   W3  the cwd is the change-request's tree when it is among the trees; otherwise the root
//   W4  cleanup removes the whole root; revoke hands back every token
//   W5  no trees → null, the normal answer (a research gig in a room with no github connector)
import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { prepareWorkspaces, fetchGitCredential } from "../src/workspace.js";

afterEach(() => vi.unstubAllGlobals());

/** A real local origin with one commit on main, as tests/workspace.test.ts does. */
function origin(name: string, file: string): string {
  const bare = mkdtempSync(join(tmpdir(), `trees-${name}-origin-`));
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  const seed = mkdtempSync(join(tmpdir(), `trees-${name}-seed-`));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed]);
  writeFileSync(join(seed, file), name);
  const g = (args: string[]) => execFileSync("git", ["-C", seed, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  g(["add", "-A"]); g(["commit", "--quiet", "-m", "seed"]);
  g(["remote", "add", "origin", bare]); g(["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
  return bare;
}

/** The broker, faked: records every body, answers a token that names the repository it was asked for. */
function broker() {
  const bodies: Record<string, unknown>[] = [];
  const revoked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) => {
    if (String(u).includes("api.github.com/installation/token")) {
      revoked.push(String((init?.headers as Record<string, string>)["authorization"]));
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return new Response(JSON.stringify({ ok: true, token: `tok-for-${basename(String(body["repository"] ?? "primary"))}` }), { status: 200 });
  }));
  return { bodies, revoked };
}

describe("W1 — the credential request names the repository", () => {
  it("W1 with a repository the body carries it; without one the body is exactly the old shape", async () => {
    const b = broker();
    await fetchGitCredential("https://x/api", "dk_secret", "box-1", "gig-7", "https://github.com/eir-labs/coltrane");
    expect(b.bodies[0]).toEqual({ drain_key: "dk_secret", instance: "box-1", gig_id: "gig-7", repository: "https://github.com/eir-labs/coltrane" });
    await fetchGitCredential("https://x/api", "dk_secret", "box-1", "gig-7");
    expect(b.bodies[1], "a one-repository caller must send the old body byte-for-byte").toEqual({ drain_key: "dk_secret", instance: "box-1", gig_id: "gig-7" });
  });
});

describe("W2–W4 — every granted tree, its own folder, its own credential", () => {
  it("W2 two trees clone under one root, each in its own folder, with one broker call per tree naming it", async () => {
    const a = origin("alpha", "A.md");
    const b = origin("beta", "B.md");
    const br = broker();
    const ws = await prepareWorkspaces({ trees: [a, b], gigId: "gig-9", drainKey: "dk", instance: "box", endpoint: "https://x/api" });
    expect(ws, "two granted trees must prepare a workspace").not.toBeNull();
    if (!ws) return;
    try {
      expect(ws.mounts.map((m) => m.repoUrl)).toEqual([a, b]);
      expect(ws.mounts.every((m) => m.dir.startsWith(ws.root + "/")), "every mount sits under the one root").toBe(true);
      expect(new Set(ws.mounts.map((m) => m.dir)).size, "each tree has its own folder").toBe(2);
      expect(existsSync(join(ws.mounts[0]!.dir, "A.md"))).toBe(true);
      expect(existsSync(join(ws.mounts[1]!.dir, "B.md"))).toBe(true);
      expect(br.bodies.map((x) => x["repository"]), "the broker is asked once per tree, naming it").toEqual([a, b]);
      expect(br.bodies.every((x) => x["gig_id"] === "gig-9" && x["drain_key"] === "dk" && x["instance"] === "box")).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("W3 the cwd is the change-request's tree when it is among the trees; otherwise the root", async () => {
    const a = origin("gamma", "G.md");
    const b = origin("delta", "D.md");
    broker();
    const withCwd = await prepareWorkspaces({ trees: [a, b], cwdRepo: b, gigId: "g", drainKey: "dk", instance: "box", endpoint: "https://x/api" });
    try {
      expect(withCwd!.dir, "the change lands in delta, so delta is the cwd").toBe(withCwd!.mounts[1]!.dir);
    } finally { withCwd?.cleanup(); }
    const reading = await prepareWorkspaces({ trees: [a, b], gigId: "g", drainKey: "dk", instance: "box", endpoint: "https://x/api" });
    try {
      expect(reading!.dir, "a reading gig names no tree: its cwd is the root with the mounts beside each other").toBe(reading!.root);
    } finally { reading?.cleanup(); }
  });

  it("W4 cleanup removes the whole root; revoke hands back every token", async () => {
    const a = origin("eps", "E.md");
    const b = origin("zeta", "Z.md");
    const br = broker();
    const ws = await prepareWorkspaces({ trees: [a, b], gigId: "g", drainKey: "dk", instance: "box", endpoint: "https://x/api" });
    const root = ws!.root;
    await ws!.revoke();
    expect(br.revoked.length, "one revocation per credential").toBe(2);
    expect(br.revoked.sort()).toEqual([`Bearer tok-for-${basename(a)}`, `Bearer tok-for-${basename(b)}`].sort());
    ws!.cleanup();
    expect(existsSync(root), "cleanup removes the root and every tree under it").toBe(false);
  });

  it("W5 no trees is null — the normal answer for a gig in a room that grants no repositories", async () => {
    const ws = await prepareWorkspaces({ trees: [], gigId: "g", drainKey: "dk", instance: "box", endpoint: "https://x/api" });
    expect(ws).toBeNull();
  });
});
