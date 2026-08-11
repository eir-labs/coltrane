// The engine's version identity — the thing a consumer can assert against.
//
// Why this exists: a consumer needs to answer "is the engine I just loaded the engine I
// was built against?" The only available check was duck-typing two function names, which
// passes for *every* revision of the engine and therefore proves nothing. A version
// mismatch then surfaces as a contract failure deep inside a running gig, minutes and
// dollars in, instead of at boot.
//
// This predates publication — it was written when downstreams vendored the engine as a
// git clone and the range in their package.json could not be the answer. It still is not:
// a semver range says what npm was asked to install, not what got loaded, and the vendored
// path remains supported.
//
// COLTRANE_VERSION is the single source of truth in code and MUST equal package.json's
// `version` — `tests/version_identity.test.ts` fails the build if they drift.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Engine semver. Keep in lockstep with package.json `version` (enforced by test). */
export const COLTRANE_VERSION = "0.7.3";

/**
 * The commit this engine checkout is sitting on, or null when it can't be determined.
 *
 * Resolution order:
 *   1. COLTRANE_BUILD_COMMIT — set it when baking an image from a source tree with no .git.
 *      This is the only source that is genuinely "the commit dist was built from".
 *   2. The engine checkout's own .git/HEAD, read live (pure fs, no subprocess). A *pinned*
 *      checkout is detached, so HEAD holds the sha directly — exactly the case a consumer
 *      wants to verify. An attached branch is resolved one hop through .git/<ref>.
 *   3. null — vendored without .git, or a packed-ref branch tip we won't guess at.
 *
 * Note the deliberate asymmetry in (2): COLTRANE_VERSION is compiled into dist, while the
 * commit is read from the working checkout. They can therefore disagree — and that
 * disagreement is the signal, not a bug. It is precisely how you catch an engine directory
 * that was `git checkout`-ed to something else after it was built and pinned, which is the
 * way a pin silently comes undone on a machine that is also a dev checkout.
 *
 * Deliberately a function, not a const: it touches the filesystem, and importing the
 * engine should not pay for that unless someone asks.
 */
export function coltraneBuildCommit(): string | null {
  const fromEnv = process.env["COLTRANE_BUILD_COMMIT"]?.trim();
  if (fromEnv) return fromEnv;

  try {
    // Walk up to the engine root. Depth differs between built output (dist/src/version.js)
    // and running from source under vitest (src/version.ts), so find it rather than assume.
    let dir = dirname(fileURLToPath(import.meta.url));
    let gitDir: string | null = null;
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, ".git"))) {
        gitDir = join(dir, ".git");
        break;
      }
      const up = resolve(dir, "..");
      if (up === dir) break;
      dir = up;
    }
    if (!gitDir) return null;

    // In a linked worktree `.git` is a FILE holding `gitdir: <path>`, not a directory.
    if (!statSync(gitDir).isDirectory()) {
      const pointer = readFileSync(gitDir, "utf8").trim();
      const m = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (!m?.[1]) return null;
      gitDir = resolve(dir, m[1].trim());
    }

    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head; // detached == pinned
    const ref = head.startsWith("ref: ") ? head.slice(5).trim() : null;
    if (!ref) return null;
    const refPath = join(gitDir, ref);
    if (!existsSync(refPath)) return null; // packed-refs; not worth parsing
    const sha = readFileSync(refPath, "utf8").trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Version + build commit in one call — what a consumer's boot-time handshake reads. */
export function coltraneIdentity(): { version: string; commit: string | null } {
  return { version: COLTRANE_VERSION, commit: coltraneBuildCommit() };
}
