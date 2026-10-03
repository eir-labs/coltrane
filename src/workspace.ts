/**
 * The working tree a gig runs in, obtained AFTER the claim.
 *
 * WHY THIS EXISTS. `drain-loop.sh` cloned a repository BEFORE claiming, from a `REPO_URL` fixed in
 * the box's environment at provisioning. That made a per-gig fact a per-box one — the same category
 * error as the `worker_agent` the venue design already removed — and it meant every gig an
 * organization ever dispatched had to work in the same repository.
 *
 * The obvious repair, letting a gig name its own repository through `input_data`, was refused on
 * review and the reasons are worth keeping close to the code:
 *
 *   - `input_data` is authored under a gate asking "may this agent RUN this standard". That is not
 *     "may it WRITE this repository", and nobody had asked the second question.
 *   - `git clone` accepts `ext::sh -c '…'` as a URL. A gig-supplied string is command execution.
 *
 * So the STORE names the repository, on the claim, from a governed column. Nothing the gig carries
 * can influence it, because there is no field in which to carry it.
 *
 * AND THE CREDENTIAL IS FETCHED PER GIG, against a live lease. Not held at boot, not in the
 * container's environment, not the same one twice. A drain between gigs holds no git credential at
 * all — which is the property the per-gig store credential already has, extended to the half that
 * previously sat in a Fly secret for the life of the machine.
 */

import { execFileSync } from "node:child_process";
import { isSafeGitRev } from "./run_deps.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** What the mint endpoint answers with. `expires_at` is GitHub's hour, not our thirty-minute lease
 *  — carried through so a caller can see the difference rather than assume they match. */
export interface GitCredential {
  token: string;
  expires_at?: string;
}

export interface PreparedWorkspace {
  /** Absolute path to the clone. The gig runs with this as cwd. */
  dir: string;
  /** Idempotent. Safe to call from a `finally` that may run after a partial failure. */
  cleanup: () => void;
  /**
   * Hand the git credential back when the gig is done.
   *
   * A GitHub installation token is fixed at ONE HOUR and the lease that justified it is thirty
   * minutes, so the git half outlives its own authority by at least 2x — and no revocation on our
   * side can recall it. GitHub exposes exactly one way to end one early: DELETE
   * /installation/token, authenticated WITH that token.
   *
   * Which means only a cooperative holder can do it. That is not a security control and must not be
   * described as one: a compromised drain simply declines to call this. It is a hygiene measure for
   * the ordinary case, and the ordinary case is every gig — a run that takes four minutes stops
   * holding a live credential fifty-six minutes early.
   *
   * Best-effort by construction: a failure here must never fail a drained gig.
   */
  revoke: () => Promise<void>;
}

/**
 * Trade the venue credential for a git credential scoped to ONE gig's repository.
 *
 * The endpoint decides nothing: it asks the store whether this instance currently holds a live
 * lease on this gig, and mints only for the repository the store names. So a stolen drain key
 * yields nothing here unless the thief is also, right now, doing that gig's work.
 */
export async function fetchGitCredential(
  endpoint: string,
  drainKey: string,
  instance: string,
  gigId: string,
  /** WHICH of the gig's trees this credential is for (R38: a room furnishes several; the broker mints
   *  one credential per repository, scoped to that repository alone). Absent = the broker's own
   *  answer for a one-repository gig, and the body is byte-for-byte what it was before. */
  repository?: string,
): Promise<GitCredential> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ drain_key: drainKey, instance, gig_id: gigId, ...(repository ? { repository } : {}) }),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch { /* keep the raw body */ }
    throw new Error(`git credential refused (${res.status}): ${detail}`);
  }
  const body = JSON.parse(text) as { token?: string; expires_at?: string };
  if (!body.token) throw new Error("git credential endpoint returned no token");
  return { token: body.token, ...(body.expires_at ? { expires_at: body.expires_at } : {}) };
}

/**
 * Shallow-clone `repoUrl` into a fresh temp directory.
 *
 * THE TOKEN NEVER TOUCHES DISK, and that is not incidental. Embedding it in the remote URL
 * (`https://x-access-token:$TOKEN@github.com/…`) writes it verbatim into `.git/config` — inside the
 * very tree the gig's seats then read and write, one `git remote -v` away from model context. A
 * credential helper is consulted only when the server challenges, and reads the token from the
 * helper's own environment at that moment.
 *
 * The helper is supplied through GIT_CONFIG_* rather than `-c`, because `git clone -c k=v` writes k
 * into the NEW clone's .git/config — see the note at the call site. Scoped to `https://github.com`
 * so a URL naming any other host is never offered the token.
 *
 * `targetDir`, when given, is WHERE the clone lands — a caller-supplied directory instead of this
 * function's own throwaway tmpdir. It is the one addition a venue room needs over the drain: the room
 * clones into `<realizationDir>/workspace` (the seat's cwd, subsumed by the realizer's own teardown)
 * rather than a detached tmpdir. Everything else — the token-never-on-disk GIT_CONFIG_* path, cleanup,
 * revoke — is IDENTICAL, because a room's working tree and the drain's must be the same thing prepared
 * the same way. Omitted (the drain's call) keeps the original mkdtempSync behaviour byte-for-byte.
 */
/** GitHub's only early-revocation path for an installation token, authenticated with the token itself.
 *  Never throws: the token expires on its own within the hour regardless. */
export async function revokeGithubToken(token: string): Promise<void> {
  try {
    await fetch("https://api.github.com/installation/token", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
  } catch { /* best effort */ }
}

export function cloneInto(repoUrl: string, token: string, targetDir?: string, base?: string | null): PreparedWorkspace {
  const dir = targetDir ?? mkdtempSync(join(tmpdir(), "coltrane-gig-"));
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* a temp dir that will not delete is not worth failing a drained gig over */ }
  };
  const revoke = async () => { await revokeGithubToken(token); };

  const env = {
    ...process.env,
    COLTRANE_GIT_TOKEN: token,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0:
      '!f() { echo username=x-access-token; echo "password=$COLTRANE_GIT_TOKEN"; }; f',
  };
  try {
    execFileSync(
      "git",
      // THE TREE IS A REPOSITORY, NEVER AN OPTION. `--` ends git's options, so a tree whose name begins
      // with a dash is read as a repository (and refused by git), never as `--upload-pack=<program>`.
      ["clone", "--quiet", "--depth", "1", "--", repoUrl, dir],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (e) {
    cleanup();
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`clone of ${repoUrl} failed${stderr ? `: ${stderr}` : ""}`);
  }
  // THE BASE IS IN THE TREE. A change-set names the commit it is measured from (change_set_base);
  // a one-commit clone does not hold it. Fetched HERE, while the credential is in hand — nothing
  // later in the run holds one — and only to depth 1: the base itself, not its history. A base the
  // origin does not have is refused by name: the request named a commit that is not this repository's.
  if (typeof base === "string" && base.trim().length > 0) {
    const rev = base.trim();
    // THE BASE IS A REVISION, NEVER AN OPTION. git reads a positional that begins with a dash as an
    // option even after `origin` (`--depth=999999` would un-shallow the clone; `--upload-pack=…`
    // would name a program). Refused by name before git sees it, and `--end-of-options` is pinned so
    // nothing positional is ever read as one.
    if (!isSafeGitRev(rev)) {
      cleanup();
      throw new Error(
        `bad_base: change_set_base ${JSON.stringify(rev)} is not a git revision the engine will hand to git — ` +
          `a sha, a tag or a branch name; nothing beginning with a dash, no whitespace, no '..'`,
      );
    }
    try {
      execFileSync(
        "git",
        ["-C", dir, "fetch", "--quiet", "--depth", "1", "--end-of-options", "origin", rev],
        { env, stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (e) {
      cleanup();
      const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim();
      throw new Error(
        `base_not_in_origin: change_set_base ${rev} could not be fetched from ${repoUrl} — the ` +
          `request named a commit this repository does not have${stderr ? `: ${stderr}` : ""}`,
      );
    }
  }
  return { dir, cleanup, revoke };
}

/**
 * Everything above, for one claimed gig — or null when the claim names no repository.
 *
 * NULL IS A NORMAL ANSWER, not a degraded one. An organization that declares no `repo_url` runs
 * gigs that do not touch a working tree, and refusing to run them because a repository is absent
 * would repeat the boot-time refusal this whole change removes. A gig that DOES need a tree will
 * fail on its own terms, naming what it could not find, which is a better error than any this
 * layer could invent.
 */
export async function prepareWorkspace(opts: {
  repoUrl: string | null | undefined;
  gigId: string;
  drainKey: string | undefined;
  instance: string | undefined;
  endpoint: string | undefined;
  /** Where the clone lands. Omitted (the drain) → cloneInto's own throwaway tmpdir. Supplied (a venue
   *  room) → `<realizationDir>/workspace`, so the seat's cwd is the room's tree and the realizer's
   *  existing teardown subsumes the clone. The credential path is unchanged either way. */
  target?: string | undefined;
  /** The commit a change-set is measured from (change_set_base on the typed input): fetched into the
   *  shallow clone while the credential is in hand, so the seal can diff against it. */
  base?: string | null | undefined;
}): Promise<PreparedWorkspace | null> {
  if (!opts.repoUrl) return null;
  if (!opts.drainKey || !opts.instance) {
    throw new Error(
      `the claim named ${opts.repoUrl} but this worker holds no venue credential, so it cannot ` +
        `obtain a git credential for it — set COLTRANE_DRAIN_KEY and COLTRANE_INSTANCE`,
    );
  }
  if (!opts.endpoint) {
    throw new Error(
      `the claim named ${opts.repoUrl} but COLTRANE_GIT_CREDENTIALS_URL is unset, so there is ` +
        `nowhere to obtain a credential scoped to this gig`,
    );
  }
  const cred = await fetchGitCredential(opts.endpoint, opts.drainKey, opts.instance, opts.gigId);
  return cloneInto(opts.repoUrl, cred.token, opts.target, opts.base ?? null);
}

/**
 * A folder name for a tree under the workspace root: the repository's last path segment, with .git
 * dropped — `coltrane-ui` for https://github.com/eir-labs/coltrane-ui, and the basename for a local
 * origin. Collisions (two owners, one name) are made unique by suffixing the owner.
 */
function mountName(repoUrl: string, taken: Set<string>): string {
  let t = repoUrl;
  let end = t.length;
  while (end > 0 && t.charCodeAt(end - 1) === 47 /* "/" */) end--;   // a scan, not /\/+$/ (CodeQL js/polynomial-redos)
  t = t.slice(0, end);
  if (t.endsWith(".git")) t = t.slice(0, -4);
  const parts = t.split(/[\/:]/).filter((seg) => seg.length > 0 && seg !== "." && seg !== "..");
  const base = parts[parts.length - 1] ?? "tree";
  let name = base;
  if (taken.has(name) && parts.length >= 2) name = `${parts[parts.length - 2]}__${base}`;
  let n = 2;
  while (taken.has(name)) name = `${base}-${n++}`;
  taken.add(name);
  return name;
}

/** One mounted tree of a furnished workspace. */
export interface MountedTree { repoUrl: string; dir: string }

/** A workspace of several trees: ONE root, a folder per tree, the cwd the change lands in (or the root). */
export interface PreparedWorkspaces {
  /** The directory every tree sits under; removed whole by cleanup. */
  root: string;
  /** The seat's cwd: the change-request's tree when it is among the mounts, otherwise the root. */
  dir: string;
  mounts: MountedTree[];
  cleanup: () => void;
  revoke: () => Promise<void>;
}

/**
 * A ROOM FURNISHES ITS TREES (R38). Every granted repository is cloned under one root, each in its own
 * folder, each with its OWN credential — the broker is asked once per tree, naming it, and mints a token
 * scoped to that repository alone. The engine re-derives no grant: what it asks for is what the room
 * furnished (githubGrant) plus the change-request's own tree, and the broker is the one surface that
 * refuses a tree the room does not grant. `cwdRepo` names the tree a change lands in; when it is among
 * the trees, its folder is the cwd and the tree a change-set is stamped from. Absent, the cwd is the root
 * and the mounts sit beside each other — a reading gig has no working tree, it has mounted trees.
 * `base` fetches a change-set base into ONE named tree (the change-request's), as prepareWorkspace does.
 * No trees → null, the normal answer.
 */
export async function prepareWorkspaces(opts: {
  trees: readonly string[];
  cwdRepo?: string | null | undefined;
  gigId: string;
  drainKey: string | undefined;
  instance: string | undefined;
  endpoint: string | undefined;
  base?: { repoUrl: string; rev: string } | null | undefined;
  /** Where the root lands; omitted → a throwaway tmpdir. */
  root?: string | undefined;
}): Promise<PreparedWorkspaces | null> {
  const trees = opts.trees.map((t) => t.trim()).filter((t) => t.length > 0);
  if (trees.length === 0) return null;
  if (!opts.drainKey || !opts.instance) {
    throw new Error(
      `the room furnishes ${trees.length} repositor${trees.length === 1 ? "y" : "ies"} but this worker holds no venue credential, so it cannot ` +
        `obtain a git credential for any of them — set COLTRANE_DRAIN_KEY and COLTRANE_INSTANCE`,
    );
  }
  if (!opts.endpoint) {
    throw new Error(
      `the room furnishes ${trees.length} repositor${trees.length === 1 ? "y" : "ies"} but COLTRANE_GIT_CREDENTIALS_URL is unset, so there is ` +
        `nowhere to obtain a credential scoped to this gig`,
    );
  }
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "coltrane-gig-"));
  const prepared: PreparedWorkspace[] = [];
  const mounts: MountedTree[] = [];
  const minted: string[] = [];
  const taken = new Set<string>();
  const cleanupAll = () => {
    for (const p of prepared) p.cleanup();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  try {
    for (const repoUrl of trees) {
      // THE TARGET STAYS UNDER THE ROOT. mountName drops "." and ".." segments, and this asserts it:
      // cloneInto's own failure path removes its target directory, and a target that escaped the
      // root would have removed the root's parent (the grade at a3db254, B2).
      // THE TREE IS A REPOSITORY, NEVER AN OPTION. The grant reaches the drain from the store; the
      // engine re-derives no grant, but it refuses by name a tree git would read as an option
      // (`--upload-pack=<program>` names a program; `--depth=999999` un-shallows) — before the broker
      // is asked and before git is run. The clone line pins `--` as well: two walls, one rule.
      if (repoUrl.startsWith("-") || /\s/.test(repoUrl)) {
        throw new Error(`refusing to mount ${JSON.stringify(repoUrl)}: a tree is a repository URL, never an option`);
      }
      const target = join(root, mountName(repoUrl, taken));
      if (!resolve(target).startsWith(resolve(root) + sep)) {
        throw new Error(`refusing to mount ${repoUrl}: its folder would fall outside the workspace root`);
      }
      const cred = await fetchGitCredential(opts.endpoint, opts.drainKey, opts.instance, opts.gigId, repoUrl);
      minted.push(cred.token);
      const base = opts.base && opts.base.repoUrl === repoUrl ? opts.base.rev : null;
      const ws = cloneInto(repoUrl, cred.token, target, base);
      prepared.push(ws);
      mounts.push({ repoUrl, dir: ws.dir });
    }
  } catch (e) {
    // A mid-way failure hands back EVERY credential it minted — the trees that cloned and the one
    // that did not — before it reaps the directories; a token left to live out GitHub's hour for a
    // workspace that no longer exists is the leak the grade named (note 4). Best effort, never awaited
    // past the failure: the failure is what the caller must hear.
    void Promise.all(minted.map((token) => revokeGithubToken(token)));
    cleanupAll();
    throw e;
  }
  const cwd = opts.cwdRepo ? mounts.find((m) => m.repoUrl === opts.cwdRepo) : undefined;
  return {
    root,
    dir: cwd?.dir ?? root,
    mounts,
    cleanup: cleanupAll,
    revoke: async () => { await Promise.all(prepared.map((p) => p.revoke())); },
  };
}
