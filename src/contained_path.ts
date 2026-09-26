// No path the engine derives from a caller's value leaves the directory it belongs to (#559).
//
// FOUNDER RULING (Eugene, verbatim): "SLUGS ARE NOT IDENTIFIERS". This is NOT a slug grammar. A
// slug, a gig id, an institution name may be any string a caller likes; what the engine refuses is
// a value whose DERIVED PATH lands anywhere but inside the site's own directory — `agents/`,
// `skills/`, `genome/history/<class>/`, the outputs dir, the gig-log dir, the chain dir. Every site
// that joins a caller value into a path calls `containedPath` and uses the path it returns; none of
// them joins the value itself.
//
// The comparison is by RESOLVED ABSOLUTE PATH, whole segments: the resolved target must start with
// `<siteDir>` PLUS A SEPARATOR. A bare `startsWith(siteDir)` admits `../../g-sibling/x` whenever the
// site directory is named `g` — a directory whose NAME merely shares the prefix. The site directory
// itself is refused too (a skill slug `.` or `a/..` would otherwise name `skills/` as its package).
//
// Three values are refused before any resolving, because they cannot be a portable relative path at
// all: a NUL byte (every fs call would throw — but only AFTER a caller may already have sealed an
// identity for it), a backslash (a separator on Windows, an ordinary character on posix: the same
// value would land in two different places), and an absolute path (join() would discard the site).
import { isAbsolute, resolve, sep, win32 } from "node:path";

/** A caller's value would derive a path outside the directory it belongs to. The message always
 *  names the boundary ("root") and the site, so a refusal says WHERE it held and WHY. */
export class PathContainmentError extends Error {
  readonly site: string;
  readonly siteDir: string;
  readonly value: string;
  readonly why: string;
  constructor(site: string, siteDir: string, value: string, why: string) {
    super(
      `${site}: ${JSON.stringify(value)} ${why} — a path derived from a caller's value must stay inside ` +
        `its root (${siteDir}); refused before anything was read, written or sealed`,
    );
    this.name = "PathContainmentError";
    this.site = site;
    this.siteDir = siteDir;
    this.value = value;
    this.why = why;
  }
}

/**
 * The absolute path `<siteDir>/<value><suffix>`, or a PathContainmentError when it would not be
 * strictly inside `siteDir`.
 *
 * @param site    who is asking, for the refusal ("agent_evolve read", "skill chain append", …)
 * @param siteDir the directory this value's path belongs to — the SITE's own directory, not merely
 *                the genome root
 * @param value   the caller-supplied value (slug, gig id, institution slug)
 * @param suffix  an engine-owned suffix appended to the value (".json", ".jsonl"); never caller data
 */
export function containedPath(site: string, siteDir: string, value: string, suffix = ""): string {
  const root = resolve(siteDir);
  const refuse = (why: string): never => {
    throw new PathContainmentError(site, root, value, why);
  };
  if (typeof value !== "string") refuse("is not a string");
  if (value.includes("\u0000")) refuse("contains a NUL byte, which no portable path can hold, so it has no place inside the root");
  if (value.includes("\\")) refuse("contains a backslash, a separator on one platform and a character on another, so where it lands relative to the root is not one place");
  if (isAbsolute(value) || win32.isAbsolute(value)) refuse("is an absolute path, which discards the root it was joined to");
  const target = resolve(root, value + suffix);
  if (target === root) refuse("resolves to the root directory itself, not to anything inside the root");
  if (!target.startsWith(root + sep)) refuse(`resolves to ${target}, outside the root`);
  return target;
}
