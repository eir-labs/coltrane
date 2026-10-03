// THE PLAYER AUTHORS, THE ENGINE COMMITS (plan.one-write-path item 43; finding 37; c60 Q4).
//
// A publish seat seals a pull-request INTENT; the engine — holding the credential it minted for the
// tree under the gig's lease — performs the commit, the push and the PR open. This module is the
// engine's hands: a TreePublisher closes over the token (never exported, never on disk) and does the
// two acts that need it. The seat never holds a credential, so there is nothing for its grant wall
// to guard: 22 denied hunts for GH_TOKEN on gig acbdb1d0 (3 Oct 2026) were the measured alternative.
import { execFileSync } from "node:child_process";

/** How the engine signs a commit it performs on a player's behalf. */
export interface CommitAttribution {
  /** The PLAYER — the seat the gig runs under (acting_for), with an address that carries its id. */
  author: { name: string; email: string };
  /** The ENGINE under the lease: the one that performed the commit. */
  committer: { name: string; email: string };
  /** Trailers appended to the message: the gig, the actor, the lease, the engine. */
  trailers: Record<string, string>;
}

/** The engine's hands on a tree: push a branch, open a pull request. The credential is inside. */
export interface TreePublisher {
  readonly repoUrl: string;
  /** Push `refs/heads/<branch>` of the clone at `dir` to origin, with the credential, through the
   *  challenge-time helper (GIT_CONFIG_* in the push process's env; nothing written to .git/config). */
  push(dir: string, branch: string): void;
  /** Open the pull request by API. Refuses by name for a repository that is not on GitHub. */
  openPullRequest(o: { base: string; head: string; title: string; body: string }): Promise<{ url: string; number: number }>;
  /** `git ls-remote --heads origin <ref>` with the credential — the origin's own answer about a
   *  branch, read through the engine's hands. Empty when the origin holds no such head. */
  remoteHeads(dir: string, ref: string): string;
}

/**
 * The credential helper environment, shared by the clone and the push: git consults the helper only
 * when the server challenges, and the helper reads the token from ITS OWN environment at that
 * moment. Supplied through GIT_CONFIG_* rather than `-c` because `git clone -c k=v` writes k into
 * the new clone's .git/config. Scoped to https://github.com so no other host is offered the token.
 */
export function credentialEnv(token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COLTRANE_GIT_TOKEN: token,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: '!f() { echo username=x-access-token; echo "password=$COLTRANE_GIT_TOKEN"; }; f',
  };
}

const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)\/([A-Za-z0-9_-][A-Za-z0-9_.-]*?)(?:\.git)?\/?$/;

/**
 * THE PUSH, BUILT BEFORE IT IS RUN — one construction site, so a law can read what the push carries
 * (W9c) without a GitHub origin to challenge it: the credential helper rides the push process's
 * environment exactly as it rides the clone's. `--` ends git's options, as the clone pins it: a
 * branch is a ref, never an option.
 */
export function pushInvocation(dir: string, branch: string, token: string): { file: string; argv: readonly string[]; env: NodeJS.ProcessEnv } {
  return {
    file: "git",
    argv: ["-C", dir, "push", "--quiet", "--", "origin", `refs/heads/${branch}:refs/heads/${branch}`],
    env: credentialEnv(token),
  };
}

/** A remote READ, built before it is run, with the same helper (W9d): a private origin challenges a
 *  read exactly as it challenges a push (gig 44bd82b3, 4 Oct 2026). */
export function remoteInvocation(dir: string, ref: string, token: string): { file: string; argv: readonly string[]; env: NodeJS.ProcessEnv } {
  // The full ref, not the short name: ls-remote matches a pattern on the TAIL of a ref, so a bare
  // `main` would also answer for refs/heads/x/main (the grade at 598d790, note 5).
  return { file: "git", argv: ["-C", dir, "ls-remote", "--heads", "--", "origin", `refs/heads/${ref}`], env: credentialEnv(token) };
}

/** THE ONE SPAWN in this module: it runs exactly what a builder built — argv and env. */
function run(built: { file: string; argv: readonly string[]; env: NodeJS.ProcessEnv }): string {
  return execFileSync(built.file, [...built.argv], { env: built.env, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

export function makePublisher(repoUrl: string, token: string): TreePublisher {
  return {
    repoUrl,
    push(dir, branch) { run(pushInvocation(dir, branch, token)); },
    remoteHeads(dir, ref) { return run(remoteInvocation(dir, ref, token)); },
    async openPullRequest(o) {
      const m = GITHUB_REPO.exec(repoUrl);
      if (!m) throw new Error(`not_a_github_repository: ${repoUrl} is not a GitHub repository, so no pull request can be opened on it`);
      const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/pulls`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
        body: JSON.stringify({ title: o.title, head: o.head, base: o.base, body: o.body }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`pull_request_refused: GitHub answered ${res.status} to the pull request: ${text.slice(0, 600)}`);
      const j = JSON.parse(text) as { html_url?: unknown; number?: unknown };
      if (typeof j.html_url !== "string" || typeof j.number !== "number") throw new Error(`pull_request_unreadable: GitHub's answer carried no html_url/number: ${text.slice(0, 300)}`);
      return { url: j.html_url, number: j.number };
    },
  };
}
