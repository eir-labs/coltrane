// A REALIZED ROOM'S WORKSPACE IS POPULATED WITH A WORKING TREE — the explicit-source, one-mechanism,
// and declines-when-absent laws, driven HERMETICALLY (no live daemon).
//
// The realizer's docker steps run through the injected `run` seam as no-ops, and the tree is cloned
// from a LOCAL bare repository (no network) — the same pattern tests/workspace.test.ts uses. What is
// under test here is the DECISION the realizer makes about a working tree, not docker:
//
//   (b) EXPLICIT SOURCE — the tree comes from the declared source and NEVER from the host's cwd; a
//       bogus declared source FAILS ON THAT SOURCE rather than silently substituting the operator's
//       own checkout.
//   (c) ONE MECHANISM — population routes through prepareWorkspace (src/workspace.ts), the SAME shared
//       function the drain calls at src/worker.ts, not a second clone/credential/cleanup path.
//   (f) NO repo_url DECLINES — a room that declares no source produces an empty workspace and mints no
//       credential, so a read-only seat keeps working; it never reaches for an ambient source.
//
// These fail-to-run / are RED against pre-change code: there was no populate branch, no repo_url field,
// and the realizer never consulted any repository source.
import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerComposeRealizer } from "../../src/venue_realizer.js";
import { VenueSchema } from "../../src/genome_schema.js";
import * as workspace from "../../src/workspace.js";

afterEach(() => vi.unstubAllGlobals());

const noCredentials = async (): Promise<Record<string, string>> => ({});

/** A no-op ComposeRunner: the docker steps do nothing, so the realizer's DECISION about the workspace
 *  runs without a daemon. Records the argv it was handed for good measure. */
function noopRunner(): { run: (a: readonly string[], t: number) => void; calls: string[][] } {
  const calls: string[][] = [];
  return { run: (a) => { calls.push([...a]); }, calls };
}

/** A LOCAL bare repository with one committed marker file — no network. Returns the path (the room's
 *  `repo_url`) and the marker committed into it. */
function seedBareRepo(marker: string): { origin: string; marker: string } {
  const origin = mkdtempSync(join(tmpdir(), "roomws-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const seed = mkdtempSync(join(tmpdir(), "roomws-seed-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed]);
  writeFileSync(join(seed, "TREE_MARKER"), marker);
  const g = (a: string[]): void => {
    execFileSync("git", ["-C", seed, ...a], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  };
  g(["add", "-A"]); g(["commit", "--quiet", "-m", "seed"]);
  g(["remote", "add", "origin", origin]); g(["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
  return { origin, marker };
}

/** The per-gig credential mint prepareWorkspace calls before cloning. A local bare-repo clone never
 *  offers the token to git, so any token satisfies it; the returned vi.fn lets a law assert it was — or
 *  was NOT — called. */
function stubGitCredential(): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => new Response(JSON.stringify({ token: "ghs_hermetic_token" }), { status: 200 }));
  vi.stubGlobal("fetch", f);
  return f;
}

/** A floored venue (so the handle exposes `seat.workspace`, naming the clone root), optionally carrying
 *  a declared `repo_url`. No mcp_servers, so nothing needs to stand up for the workspace decision. */
function flooredRoom(repoUrl?: string): unknown {
  return {
    slug: "populated-room-v1",
    institution_slug: "quartet",
    equipment: { tools: [] },
    credential_surface: [],
    floor: "seat",
    mcp_servers: [],
    lifecycle: { policy: "ephemeral" as const },
    ...(repoUrl ? { repo_url: repoUrl } : {}),
  };
}

describe("the repo_url field parses, and does not loosen the venue contract", () => {
  it("a venue may declare repo_url, a venue may omit it, and unknown keys are still rejected", () => {
    // The declaration site. An existing contract (no repo_url) stays valid; a new one may carry it; and
    // .strict() still refuses a key the contract never declared.
    expect(VenueSchema.parse(flooredRoom("https://github.com/eir-labs/x.git"))).toMatchObject({
      repo_url: "https://github.com/eir-labs/x.git",
    });
    expect(VenueSchema.parse(flooredRoom())).not.toHaveProperty("repo_url");
    expect(() => VenueSchema.parse({ ...(flooredRoom() as object), not_a_field: 1 })).toThrow();
  });
});

describe("LAW (b): the source is explicit — the tree comes from the declared source, never from cwd", () => {
  it("populates from the declared repo_url, and NOT from the host's working directory", async () => {
    const { run } = noopRunner();
    const { origin, marker } = seedBareRepo("came-from-the-declared-source");
    stubGitCredential();
    const gigId = "roomwsb1-0000-0000-0000-0000000000b1";
    const handle = await dockerComposeRealizer({ run }).realize(flooredRoom(origin), noCredentials, {
      gigId, repoUrl: origin, drainKey: "dk", instance: "box", gitCredentialsEndpoint: "https://x/api",
    });
    try {
      const ws = handle.seat!.workspace;
      // The tree came from THAT source: its committed marker is present with the source's content.
      expect(readFileSync(join(ws, "TREE_MARKER"), "utf8"), "the tree carries the declared source's marker").toBe(marker);
      // …and NOT from process.cwd(): the coltrane checkout has a package.json at its root; the clone of
      // the bare repo does not. Its presence would mean the room populated from the operator's checkout.
      expect(existsSync(join(ws, "package.json")), "the room must not have populated from the host's cwd").toBe(false);
    } finally {
      await handle.teardown();
    }
  });

  it("a bogus declared source FAILS ON THAT SOURCE — it does not silently substitute the host checkout", async () => {
    const { run } = noopRunner();
    stubGitCredential();
    const bogus = join(tmpdir(), "roomws-bogus-source-does-not-exist", String(process.pid));
    const gigId = "roomwsb2-0000-0000-0000-0000000000b2";
    // The refusal NAMES the source that failed (clone of <bogus> failed). It does not fall back to
    // cwd and return a handle — reaching into the operator's checkout is the failure this forecloses.
    await expect(
      dockerComposeRealizer({ run }).realize(flooredRoom(bogus), noCredentials, {
        gigId, repoUrl: bogus, drainKey: "dk", instance: "box", gitCredentialsEndpoint: "https://x/api",
      }),
    ).rejects.toThrow(new RegExp(`clone of .*${String(process.pid)}.* failed`));
  });
});

describe("LAW (c): one mechanism — population routes through prepareWorkspace, not a second clone path", () => {
  it("the room's tree is prepared by prepareWorkspace (the drain's own function), targeted at the room's workspace", async () => {
    const { run } = noopRunner();
    const { origin } = seedBareRepo("one-mechanism");
    stubGitCredential();

    // Observe the routing without weakening it: the seam DEFAULTS to the real prepareWorkspace, and here
    // we wrap that SAME real function so its call is recorded. It is the drain's function
    // (src/workspace.ts, called at src/worker.ts) — not a parallel implementation in the realizer.
    const seen: Array<{ repoUrl: string | null | undefined; target: string | undefined }> = [];
    const prepareSpy: typeof workspace.prepareWorkspace = (o) => {
      seen.push({ repoUrl: o.repoUrl, target: o.target });
      return workspace.prepareWorkspace(o);
    };

    const gigId = "roomwsc1-0000-0000-0000-0000000000c1";
    const handle = await dockerComposeRealizer({ run, prepareWorkspace: prepareSpy }).realize(
      flooredRoom(origin),
      noCredentials,
      { gigId, repoUrl: origin, drainKey: "dk", instance: "box", gitCredentialsEndpoint: "https://x/api" },
    );
    try {
      // Population went through prepareWorkspace exactly once, pointed at the declared source and THIS
      // room's workspace as its clone target.
      expect(seen, "prepareWorkspace is the single named mechanism the room populates through").toHaveLength(1);
      expect(seen[0]!.repoUrl, "…handed the declared source").toBe(origin);
      expect(seen[0]!.target, "…and targeted at the room's own workspace, the seat's cwd").toBe(handle.seat!.workspace);
      // And the mechanism's signature effect is present: a real clone leaves a .git directory. A second,
      // hand-rolled clone path in the realizer would not be observable on this spy.
      expect(existsSync(join(handle.seat!.workspace, ".git")), "the shared function actually cloned the tree").toBe(true);
    } finally {
      await handle.teardown();
    }
  });
});

describe("LAW (f): no repo_url declines to populate — an empty workspace, and no credential minted", () => {
  it("a room that declares no source gets an empty workspace and mints nothing — the read-only room still works", async () => {
    const { run } = noopRunner();
    const fetchSpy = stubGitCredential();
    const gigId = "roomwsf1-0000-0000-0000-0000000000f1";
    const handle = await dockerComposeRealizer({ run }).realize(flooredRoom(), noCredentials, { gigId });
    try {
      const ws = handle.seat!.workspace;
      // The workspace still EXISTS (a read-only seat, e.g. room-prober, has a cwd) but is EMPTY: no
      // clone, so no .git and no marker.
      expect(existsSync(ws), "an unpopulated room still has a workspace directory").toBe(true);
      expect(existsSync(join(ws, ".git")), "…but it is empty — no tree was cloned in").toBe(false);
      // And NO credential was minted: prepareWorkspace was never reached, so the mint endpoint was never
      // called. Declining is not refusing, and it is certainly not an ambient fallback.
      expect(fetchSpy, "no repo_url → no git credential is minted").not.toHaveBeenCalled();
    } finally {
      await handle.teardown();
    }
  });
});
