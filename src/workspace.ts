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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
): Promise<GitCredential> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ drain_key: drainKey, instance, gig_id: gigId }),
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
 */
export function cloneInto(repoUrl: string, token: string): PreparedWorkspace {
  const dir = mkdtempSync(join(tmpdir(), "coltrane-gig-"));
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* a temp dir that will not delete is not worth failing a drained gig over */ }
  };
  const revoke = async () => {
    try {
      await fetch("https://api.github.com/installation/token", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      });
    } catch { /* best effort: the token expires on its own within the hour regardless */ }
  };

  try {
    execFileSync(
      "git",
      ["clone", "--quiet", "--depth", "1", repoUrl, dir],
      {
        // CONFIG VIA ENVIRONMENT, NOT `-c`. `git clone -c k=v` PERSISTS k into the new clone's
        // .git/config — so a helper passed that way survives into the very tree the gig's seats
        // read. The token itself would not be there, but the helper would, and a later
        // `git push` from a publish seat would consult it, find COLTRANE_GIT_TOKEN unset in that
        // seat's environment, and send an empty password. Caught by a test asserting on the
        // resulting .git/config rather than on the arguments passed.
        //
        // GIT_CONFIG_COUNT applies config to THIS process only and writes nothing to the clone.
        //
        // Scoped to https://github.com so a URL naming any other host is never offered the token.
        // The store constrains repo_url to https and this layer cannot be reached with a
        // gig-supplied string, but a credential helper that answers any host is one refactor away
        // from exfiltration and costs nothing to scope now.
        env: {
          ...process.env,
          COLTRANE_GIT_TOKEN: token,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
          GIT_CONFIG_VALUE_0:
            '!f() { echo username=x-access-token; echo "password=$COLTRANE_GIT_TOKEN"; }; f',
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
  } catch (e) {
    cleanup();
    // git writes the useful part to stderr; the message alone is usually just an exit status.
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`clone of ${repoUrl} failed${stderr ? `: ${stderr}` : ""}`);
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
  return cloneInto(opts.repoUrl, cred.token);
}
