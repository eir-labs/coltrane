// THE PLAYER AUTHORS, THE ENGINE COMMITS — a pull request is opened by the engine under the lease,
// from an INTENT the publish seat sealed; no credential and no git identity ever reach a seat.
// (plan.one-write-path item 43; finding 37; adjudication c60 Q4, 4 Oct 2026; founder's R33/R37)
//
// Measured 3 Oct 2026 on gig acbdb1d0 (B01 run 4, engine 0.25.24): the publish chair spawned with
// its prompt and then hit three walls in its own transcript — `unable to auto-detect email address`
// (no git identity), `could not read Username for 'https://github.com'` (no push credential), no
// gh token — and spent 22 of its 30 tool calls hunting for a token the grant wall refused every
// time. By design the broker-minted credential is used for the clone only and never reaches a seat.
// The pattern (c60 Q4, from R37 "apply the proper pattern" and R33 "players and instruments; engine
// first"): the seat seals a pull-request INTENT (base, branch, title, body, commit_message, paths);
// at the write boundary the engine commits — author = the player, committer = the engine, trailers
// carrying the gig, the actor, the lease and the intent's sha — pushes with the credential it minted
// for that tree, opens the PR by API, and seals the receipt with commit_sha / pr_url / pr_number.
// Any refusal is in-turn, by name, and nothing is pushed. The engine-stamped change-set is the
// precedent (stampChangeAddresses): the seat names addresses, the engine stamps from git.
//
//   P1  no publisher in the run deps → publisher_unavailable; nothing pushed
//   P2  no tree_root → tree_root_unknown
//   P3  the stamp commits exactly the named paths (a stray file is left), author = the player,
//       committer = the engine, trailers present, pushes the branch, and seals commit_sha (the
//       origin's head of that branch), pr_url, pr_number and intent_sha (sha256 of the canonical intent)
//   P4  a protected or option-shaped branch is refused by name (protected_branch / bad_branch)
//   P5  a base the origin does not hold → base_unknown; nothing pushed, no PR opened
//   P6  a path outside the tree / a path the tree lacks → refused by name; nothing committed
//   P7  a push that fails opens no PR, and the refusal carries git's own words
//   P8  a branch the origin already holds → branch_exists (one fresh branch, one PR, per run)
//   G1  no agent whose output_types include pull-request holds a git or gh Bash grant
//   G2  the pull-request type requires the INTENT's fields and not the engine-stamped ones
//   W9  the workspace publisher pushes through the challenge-time helper: the token is never in
//       the clone's .git/config, and a non-GitHub origin opens no PR
//   W9c the push is BUILT with the credential helper in its environment — COLTRANE_GIT_TOKEN and
//       the GIT_CONFIG_* helper scoped to github.com — and publisher.ts spawns exactly what it built
//       (the grade at 5c0688e planted `process.env` in the push and no law noticed: a local origin
//       never challenges)
//   P9  an intent whose paths carry no change → nothing_to_commit, and the tree is left as it was
//       found: on its original branch, nothing staged, the new branch gone
//   P10 EVERY remote act of the stamp goes through the publisher — the base and branch checks are
//       publisher.remoteHeads calls, and runtime.ts never runs ls-remote through the bare seam.
//       (Measured 4 Oct on gig 44bd82b3, B01 run 5, engine 0.25.26: the seventh chair sealed its
//       intent and the stamp's first act, `ls-remote --heads origin main` through gitInTree, failed
//       against the private origin with no credential — the law file's local origins never challenge)
//   W9d remoteInvocation is built with the credential helper too, and publisher.ts runs every
//       invocation through one spawn
//   K1  the drain threads the workspace's publisher and the claim's attribution into the run deps
import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stampPullRequest, RuntimeError, type TreePublisher, type CommitAttribution } from "../src/runtime.js";
import { makePublisher } from "../src/workspace.js";
import { pushInvocation, remoteInvocation } from "../src/publisher.js";

afterEach(() => vi.unstubAllGlobals());

const T_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { env: T_ENV, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

/** A bare origin with one commit on main, and a working clone of it with two uncommitted files. */
function tree(): { origin: string; root: string } {
  const origin = mkdtempSync(join(tmpdir(), "pr-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const seed = mkdtempSync(join(tmpdir(), "pr-seed-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "-A"); git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "remote", "add", "origin", origin); git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const root = mkdtempSync(join(tmpdir(), "pr-tree-"));
  execFileSync("git", ["clone", "--quiet", origin, root]);
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "spec_b01.md"), "# red-spec\n");
  writeFileSync(join(root, "STRAY.md"), "not named by any output\n");
  return { origin, root };
}

/** The publisher, faked: a real push to the local bare origin, a recorded PR open. */
function fakePublisher(origin: string, opts: { pushFails?: boolean } = {}): TreePublisher & { pushes: string[]; opened: unknown[]; reads: string[] } {
  const pushes: string[] = []; const opened: unknown[] = []; const reads: string[] = [];
  return {
    repoUrl: origin, pushes, opened, reads,
    remoteHeads(dir, ref) { reads.push(ref); return git(dir, "ls-remote", "--heads", "origin", ref); },
    push(dir, branch) {
      if (opts.pushFails) throw new Error("fatal: unable to access 'origin': the credential was refused");
      git(dir, "push", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`); pushes.push(branch);
    },
    async openPullRequest(o) { opened.push(o); return { url: "https://github.com/eir-labs/x/pull/7", number: 7 }; },
  };
}

const ATTR: CommitAttribution = {
  author: { name: "forseti", email: "forseti+gig-g1@seats.coltrane" },
  committer: { name: "coltrane-engine", email: "engine+box-1@coltrane" },
  trailers: { "Coltrane-Gig": "g1", "Coltrane-Acting-For": "forseti", "Coltrane-Lease": "box-1" },
};
const intent = (over: Record<string, unknown> = {}) => ({
  validation_criteria: ["opened, not merged"], input_refs: [],
  base: "main", branch: "changeset/g1", title: "B01 — the red-spec, recorded after the fact",
  body: "Delivered 2026-08-25; this run records it.", commit_message: "red-spec: B01, recorded after the fact",
  paths: ["tests/spec_b01.md"], ...over,
});

describe("P1–P2 — the stamp needs a tree and a publisher", () => {
  it("P1 no publisher → publisher_unavailable, and the origin gained no branch", async () => {
    const { origin, root } = tree();
    await expect(stampPullRequest(intent(), { tree_root: root, attribution: ATTR }, "g1")).rejects.toThrow(/publisher_unavailable/);
    expect(git(origin, "branch", "--list", "changeset/g1")).toBe("");
  });
  it("P2 no tree_root → tree_root_unknown", async () => {
    const { origin } = tree();
    await expect(stampPullRequest(intent(), { publisher: fakePublisher(origin), attribution: ATTR }, "g1")).rejects.toThrow(/tree_root_unknown/);
  });
});

describe("P3 — the player authors, the engine commits, pushes and opens", () => {
  it("P3 exactly the named paths, the right identities, the trailers, the push, and a sealed receipt from git and the API", async () => {
    const { origin, root } = tree();
    const pub = fakePublisher(origin);
    const sealed = await stampPullRequest(intent(), { tree_root: root, publisher: pub, attribution: ATTR }, "g1");
    const head = git(origin, "rev-parse", "refs/heads/changeset/g1");
    expect(sealed["commit_sha"], "commit_sha is the origin's head of the pushed branch").toBe(head);
    expect(sealed["pr_url"]).toBe("https://github.com/eir-labs/x/pull/7");
    expect(sealed["pr_number"]).toBe(7);
    expect(pub.opened[0]).toEqual({ base: "main", head: "changeset/g1", title: intent().title, body: intent().body });
    const files = git(root, "show", "--name-only", "--format=", head).split("\n").filter(Boolean);
    expect(files, "the commit carries the named path and nothing else").toEqual(["tests/spec_b01.md"]);
    expect(git(root, "status", "--porcelain"), "the stray file is left uncommitted").toContain("STRAY.md");
    const [an, ae, cn, ce] = git(root, "log", "-1", "--format=%an%n%ae%n%cn%n%ce", head).split("\n");
    expect([an, ae], "author = the player").toEqual(["forseti", "forseti+gig-g1@seats.coltrane"]);
    expect([cn, ce], "committer = the engine under the lease").toEqual(["coltrane-engine", "engine+box-1@coltrane"]);
    const msg = git(root, "log", "-1", "--format=%B", head);
    expect(msg).toContain("Coltrane-Gig: g1");
    expect(msg).toContain("Coltrane-Acting-For: forseti");
    expect(msg).toContain("Coltrane-Lease: box-1");
    const canon = JSON.stringify({ base: "main", branch: "changeset/g1", body: intent().body, commit_message: intent().commit_message, paths: ["tests/spec_b01.md"], title: intent().title });
    const sha = createHash("sha256").update(canon).digest("hex");
    expect(sealed["intent_sha"], "intent_sha is the sha256 of the canonical intent").toBe(sha);
    expect(msg).toContain(`Coltrane-Intent-Sha: ${sha}`);
  });
});

describe("P4–P8 — refusals by name, and nothing pushed", () => {
  it("P4 a protected branch, a branch equal to the base, and an option-shaped branch are refused", async () => {
    const { origin, root } = tree();
    const pub = fakePublisher(origin);
    await expect(stampPullRequest(intent({ branch: "main" }), { tree_root: root, publisher: pub, attribution: ATTR }, "g1")).rejects.toThrow(/protected_branch/);
    await expect(stampPullRequest(intent({ base: "release", branch: "release" }), { tree_root: root, publisher: pub, attribution: ATTR }, "g1")).rejects.toThrow(/protected_branch/);
    await expect(stampPullRequest(intent({ branch: "--upload-pack=x" }), { tree_root: root, publisher: pub, attribution: ATTR }, "g1")).rejects.toThrow(/bad_branch/);
    expect(pub.pushes).toEqual([]); expect(pub.opened).toEqual([]);
  });
  it("P5 a base the origin does not hold → base_unknown; nothing pushed, no PR", async () => {
    const { origin, root } = tree();
    const pub = fakePublisher(origin);
    await expect(stampPullRequest(intent({ base: "changeset/nope" }), { tree_root: root, publisher: pub, attribution: ATTR }, "g1")).rejects.toThrow(/base_unknown/);
    expect(pub.pushes).toEqual([]); expect(pub.opened).toEqual([]);
  });
  it("P6 a path outside the tree or absent from it is refused; nothing is committed", async () => {
    const { origin, root } = tree();
    const pub = fakePublisher(origin);
    await expect(stampPullRequest(intent({ paths: ["../etc/passwd"] }), { tree_root: root, publisher: pub, attribution: ATTR }, "g1")).rejects.toThrow(/path_outside_tree/);
    await expect(stampPullRequest(intent({ paths: ["tests/not_here.md"] }), { tree_root: root, publisher: pub, attribution: ATTR }, "g1")).rejects.toThrow(/path_missing/);
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "the tree is still on main").toBe("main");
    expect(pub.pushes).toEqual([]);
  });
  it("P7 a push that fails opens no PR, and the refusal carries git's own words", async () => {
    const { origin, root } = tree();
    const pub = fakePublisher(origin, { pushFails: true });
    await expect(stampPullRequest(intent(), { tree_root: root, publisher: pub, attribution: ATTR }, "g1")).rejects.toThrow(/push_failed.*credential was refused/);
    expect(pub.opened).toEqual([]);
  });
  it("P8 a branch the origin already holds → branch_exists; a LOCAL branch of that name too, and it survives", async () => {
    const { origin, root } = tree();
    git(root, "push", "--quiet", "origin", "HEAD:refs/heads/changeset/g1");
    const pub = fakePublisher(origin);
    await expect(stampPullRequest(intent(), { tree_root: root, publisher: pub, attribution: ATTR }, "g1")).rejects.toThrow(/branch_exists/);
    expect(pub.opened).toEqual([]);
    const t2 = tree();
    git(t2.root, "branch", "changeset/local");
    await expect(stampPullRequest(intent({ branch: "changeset/local" }), { tree_root: t2.root, publisher: fakePublisher(t2.origin), attribution: ATTR }, "g1")).rejects.toThrow(/branch_exists/);
    expect(git(t2.root, "branch", "--list", "changeset/local"), "the branch the tree was found with is never deleted").toContain("changeset/local");
  });
});

describe("G1–G2 — the genome: no seat holds the means, the type asks for the intent", () => {
  it("G1 no agent that seals pull-request holds a git or gh Bash grant", () => {
    const dir = new URL("../agents/", import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const a = JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { slug: string; output_types?: string[]; allowed_tools?: string[] };
      if (!(a.output_types ?? []).includes("pull-request")) continue;
      const offending = (a.allowed_tools ?? []).filter((t) => /^Bash\((git|gh)\b/.test(t));
      expect(offending, `${a.slug} seals pull-request and must hold no git/gh grant — the engine commits`).toEqual([]);
    }
  });
  it("G2 the pull-request type requires the intent's fields, and the engine-stamped ones are not asked of the seat", () => {
    const t = JSON.parse(readFileSync(new URL("../domain_types/pull-request.json", import.meta.url), "utf8")) as { required_fields: string[]; schema: { properties: Record<string, unknown> } };
    for (const f of ["branch", "title", "commit_message", "paths"]) expect(t.required_fields, `${f} is the seat's to state`).toContain(f);
    for (const f of ["commit_sha", "pr_url", "pr_number"]) expect(t.required_fields, `${f} is the engine's to stamp`).not.toContain(f);
    for (const f of ["body", "commit_message", "paths", "intent_sha"]) expect(Object.keys(t.schema.properties)).toContain(f);
  });
});

describe("W9 — the workspace publisher pushes through the challenge-time helper", () => {
  it("W9 a real push lands on the origin, the token is never in .git/config, and a non-GitHub origin opens no PR", async () => {
    const { origin, root } = tree();
    git(root, "switch", "--quiet", "-c", "changeset/w9");
    git(root, "add", "--", "tests/spec_b01.md"); git(root, "commit", "--quiet", "-m", "w9");
    const pub = makePublisher(origin, "tok-secret-w9");
    pub.push(root, "changeset/w9");
    expect(git(origin, "rev-parse", "refs/heads/changeset/w9")).toBe(git(root, "rev-parse", "HEAD"));
    expect(readFileSync(join(root, ".git", "config"), "utf8")).not.toContain("tok-secret-w9");
    await expect(pub.openPullRequest({ base: "main", head: "changeset/w9", title: "t", body: "" })).rejects.toThrow(/not_a_github_repository/);
  });
  it("W9b against GitHub the publisher POSTs the pull with the token as a bearer and reads url and number from the answer", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) => {
      calls.push({ url: String(u), init: init ?? {} });
      return new Response(JSON.stringify({ html_url: "https://github.com/eir-labs/coltrane-ui/pull/281", number: 281 }), { status: 201 });
    }));
    const pub = makePublisher("https://github.com/eir-labs/coltrane-ui", "ghs_t0k");
    const pr = await pub.openPullRequest({ base: "main", head: "changeset/g1", title: "T", body: "B" });
    expect(pr).toEqual({ url: "https://github.com/eir-labs/coltrane-ui/pull/281", number: 281 });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/eir-labs/coltrane-ui/pulls");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer ghs_t0k");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ title: "T", head: "changeset/g1", base: "main", body: "B" });
  });
});

describe("W9c — the push is built with the credential helper, and spawned as built", () => {
  it("W9c pushInvocation carries the token and the github-scoped helper in its env, and the one spawn in publisher.ts uses what it built", () => {
    const built = pushInvocation("/tmp/x", "changeset/g1", "tok-w9c");
    expect(built.file).toBe("git");
    expect(built.argv).toEqual(["-C", "/tmp/x", "push", "--quiet", "--", "origin", "refs/heads/changeset/g1:refs/heads/changeset/g1"]);
    expect(built.env["COLTRANE_GIT_TOKEN"], "the token rides the push process's env for the helper to read at challenge time").toBe("tok-w9c");
    expect(built.env["GIT_CONFIG_KEY_0"]).toBe("credential.https://github.com.helper");
    expect(built.env["GIT_CONFIG_VALUE_0"]).toContain("password=$COLTRANE_GIT_TOKEN");
    expect(built.env["GIT_CONFIG_COUNT"]).toBe("1");
    const src = readFileSync(new URL("../src/publisher.ts", import.meta.url), "utf8");
    const spawns = (src.match(/\b(?:execFileSync|execSync|spawnSync|execFile|spawn|fork)\s*\(/g) ?? []).length;
    expect(spawns, "publisher.ts starts a process somewhere other than the push seam").toBe(1);
    expect(/execFileSync\(\s*built\.file\s*,\s*\[\s*\.\.\.built\.argv\s*\]\s*,\s*\{\s*env:\s*built\.env\b/.test(src), "the push does not spawn what pushInvocation built (argv AND env)").toBe(true);
  });
});

describe("P9 — nothing to commit leaves the tree as it was found", () => {
  it("P9 paths that carry no change → nothing_to_commit; the tree is back on its branch, nothing staged, the new branch gone", async () => {
    const { origin, root } = tree();
    const pub = fakePublisher(origin);
    await expect(stampPullRequest(intent({ paths: ["README.md"] }), { tree_root: root, publisher: pub, attribution: ATTR }, "g1")).rejects.toThrow(/nothing_to_commit/);
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "the tree is back on the branch it was found on").toBe("main");
    expect(git(root, "diff", "--cached", "--name-only"), "nothing is left staged").toBe("");
    expect(git(root, "branch", "--list", "changeset/g1"), "the new branch is gone").toBe("");
    expect(pub.pushes).toEqual([]); expect(pub.opened).toEqual([]);
  });
});

describe("P10 / W9d — every remote act is the publisher's", () => {
  it("P10 the base and branch checks are publisher.remoteHeads calls, and runtime.ts never runs ls-remote through the bare seam", async () => {
    const { origin, root } = tree();
    const pub = fakePublisher(origin);
    await stampPullRequest(intent(), { tree_root: root, publisher: pub, attribution: ATTR }, "g1");
    expect(pub.reads, "the base and the branch are read through the engine's hands").toEqual(["main", "changeset/g1"]);
    const rt = readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8");
    expect(rt.includes("ls-remote"), "runtime.ts reaches the origin only through the publisher").toBe(false);
  });
  it("W9d remoteInvocation carries the helper, and publisher.ts has exactly one spawn that runs what a builder built", () => {
    const built = remoteInvocation("/tmp/x", "main", "tok-w9d");
    expect(built.argv).toEqual(["-C", "/tmp/x", "ls-remote", "--heads", "--", "origin", "main"]);
    expect(built.env["COLTRANE_GIT_TOKEN"]).toBe("tok-w9d");
    expect(built.env["GIT_CONFIG_KEY_0"]).toBe("credential.https://github.com.helper");
    const src = readFileSync(new URL("../src/publisher.ts", import.meta.url), "utf8");
    const spawns = (src.match(/\b(?:execFileSync|execSync|spawnSync|execFile|spawn|fork)\s*\(/g) ?? []).length;
    expect(spawns).toBe(1);
    expect(/execFileSync\(\s*built\.file\s*,\s*\[\s*\.\.\.built\.argv\s*\]\s*,\s*\{\s*env:\s*built\.env\b/.test(src)).toBe(true);
  });
});

describe("K1 — the drain threads the publisher and the attribution", () => {
  it("K1 worker.ts hands the workspace's publisher and the claim's attribution to assembleRunDeps; run_deps threads them", () => {
    const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(worker).toMatch(/publisher: workspaces\?\.publisher \?\? workspace\?\.publisher/);
    expect(worker).toMatch(/attribution: commitAttribution\(/);
    const rd = readFileSync(new URL("../src/run_deps.ts", import.meta.url), "utf8");
    expect(rd).toMatch(/\.\.\.\(args\.publisher \? \{ publisher: args\.publisher \} : \{\}\)/);
    expect(rd).toMatch(/\.\.\.\(args\.attribution \? \{ attribution: args\.attribution \} : \{\}\)/);
  });
});
