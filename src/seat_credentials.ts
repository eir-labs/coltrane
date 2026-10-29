// THE SEAT AUTHENTICATES IN ITS ROOM (wiki spec.coltrane.the-seat-authenticates-in-its-room; Vör graded PASS, ledger 1ef94eea).
//
// A seat-bearing room runs `claude` inside its container, and the engine never forwards a host credential into a room. The seat's
// credential is a class on the venue's credential_surface (SEAT_CREDENTIAL_CLASS), resolved like any other, and delivered to the CLI's
// OWN credentials file inside the container: never an environment variable (inherited by every MCP server the CLI spawns, and what
// crash handlers log) and no shell wrapper. The target is DERIVED FROM THE FLOOR IMAGE at realization (its uid, gid and HOME), so a floor
// rebuilt with another user cannot leave a stale literal behind. Measured in the drafting room's floor (Claude Code 2.1.312, user node):
// no file and an empty file both print "Not logged in"; a well-formed 0600 file owned by the user gets past auth.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { floorIsPinned, type CredentialResolver } from "./venue_realizer.js";

/** The class a venue declares on its credential_surface for its seat's own login. */
export const SEAT_CREDENTIAL_CLASS = "claude-code-credentials";
/** Where the installed CLI reads its login, relative to its HOME. */
export const SEAT_CREDENTIAL_REL = ".claude/.credentials.json";

export interface SeatTarget { uid: number; gid: number; home: string; dir: string; path: string }

/** The seat classes a venue's realization must resolve: only a room whose floor is PINNED BY DIGEST (the engine's one predicate,
 *  floorIsPinned) has a seat whose target can be derived from the image it runs, and the surface is the ceiling. A tag floor is a
 *  mutable reference resolved twice (compose create, then the probe); an absent floor has no seat. Either with the seat class on the
 *  surface is refused by name at realization (seatClassUnpinned), never degraded to no seat (Vör, after 67c5b192). */
export function seatClassesFor(v: { floor?: string | undefined; credential_surface: readonly string[] }): string[] {
  return floorIsPinned(v) && v.credential_surface.includes(SEAT_CREDENTIAL_CLASS) ? [SEAT_CREDENTIAL_CLASS] : [];
}
/** The seat class a venue names on its surface without a floor pinned by digest: the realization refuses it by name. */
export function seatClassUnpinned(v: { floor?: string | undefined; credential_surface: readonly string[] }): string | undefined {
  return v.credential_surface.includes(SEAT_CREDENTIAL_CLASS) && !floorIsPinned(v) ? SEAT_CREDENTIAL_CLASS : undefined;
}

/** The probe that reads the uid, gid and HOME the SEAT WILL RUN AS: the floor image under the room's own rendered user (the realizer
 *  pins the room to the drain's uid:gid), a throwaway container with no network, running nothing but `id`. Probing the bare image's
 *  default user put the file under /home/node while the seat ran as the drain's uid with HOME=/ (gig da64edf7). */
export function seatProbeArgs(image: string, user?: string): string[] {
  return ["run", "--rm", "--network", "none", ...(user ? ["--user", user] : []), "--entrypoint", "sh", image, "-c", 'id -u; id -g; printf "%s\\n" "$HOME"'];
}

/** The probe's answer as a target. A non-numeric id or a HOME that is not absolute is refused: the target is never guessed. */
export function parseSeatProbe(out: string): SeatTarget {
  const [u, g, h] = String(out).split("\n").map((s) => s.trim());
  if (!/^\d+$/.test(u ?? "") || !/^\d+$/.test(g ?? "")) throw new Error(`the floor image's user did not probe as numeric uid and gid (got ${JSON.stringify([u, g])})`);
  if (!h || !h.startsWith("/") || h.includes("\0")) throw new Error(`the floor image's HOME did not probe as an absolute path (got ${JSON.stringify(h)})`);
  const home = h.replace(/\/+$/, "") || "/";
  const dir = home === "/" ? "/.claude" : `${home}/.claude`;
  return { uid: Number(u), gid: Number(g), home, dir, path: `${dir}/.credentials.json` };
}

// ── a minimal ustar writer: two entries, numeric owners, exact modes ──────────────────────────────────────────────────────────────
function header(name: string, mode: number, uid: number, gid: number, size: number, type: "0" | "5"): Buffer {
  const b = Buffer.alloc(512, 0);
  const put = (s: string, off: number, len: number) => b.write(s.slice(0, len), off, len, "utf8");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(name, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(uid, 8), 108, 8);
  put(oct(gid, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(0, 12), 136, 12);
  b.fill(0x20, 148, 156); // the checksum field counts as spaces while it is summed
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const byte of b) sum += byte;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return b;
}
/** The CLI's state file, beside its login: measured as the seat's uid with HOME=/ (not writable), the CLI SILENTLY SKIPS its state when
 *  the file is absent, and with one owned by the seat it edits it IN PLACE (same inode, 2 → 852 bytes). So it is pre-created, owned by
 *  the seat, 0600, holding no credential (Vör: $HOME/.claude.json is written on state change, which a startup check cannot see). */
export const SEAT_STATE_REL = ".claude.json";
const pad512 = (n: number) => Buffer.alloc((512 - (n % 512)) % 512, 0);
/** The tar extracted at the target's HOME: .claude/ (0700), .claude/.credentials.json (0600) and .claude.json (0600, "{}"), all owned
 *  by the probed uid:gid. */
/** The seat's own settings, for a room with egress doors (spec.coltrane.the-room-reaches-only-its-doors): the CLI is started with
 *  `--setting-sources user`, so ~/.claude/settings.json's `env` reaches it. Measured (floor image, as the room's user, fake token): with
 *  HTTPS_PROXY only here, the CLI went out through the egress proxy and the API answered 401. So the room's compose document carries no
 *  environment at all (EP-0 holds literally), and the keys are exactly the engine's. */
export const SEAT_SETTINGS_REL = ".claude/settings.json";
export function seatSettings(proxyUrl: string): string {
  return JSON.stringify({ env: { HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
}
export function seatCredentialTar(material: string, t: SeatTarget, opts: { proxyUrl?: string } = {}): Buffer {
  const data = Buffer.from(material, "utf8");
  const state = Buffer.from("{}", "utf8");
  const settings = opts.proxyUrl ? Buffer.from(seatSettings(opts.proxyUrl), "utf8") : null;
  return Buffer.concat([
    header(".claude/", 0o700, t.uid, t.gid, 0, "5"),
    header(SEAT_CREDENTIAL_REL, 0o600, t.uid, t.gid, data.length, "0"),
    data, pad512(data.length),
    ...(settings ? [header(SEAT_SETTINGS_REL, 0o600, t.uid, t.gid, settings.length, "0"), settings, pad512(settings.length)] : []),
    header(SEAT_STATE_REL, 0o600, t.uid, t.gid, state.length, "0"),
    state, pad512(state.length),
    Buffer.alloc(1024, 0),
  ]);
}

/** THE DRAIN'S RESOLVER: one file per class under `dir`, provisioned by Forseti. Read only when a realization asks for the class.
 *  Four separate refusals, none carrying the material: absent, empty (blank), readable by group or others, owned by another identity. */
export function fileCredentialResolver(dir: string, owner: number | undefined = process.getuid?.()): CredentialResolver {
  return async (names) => {
    const out: Record<string, string> = {};
    for (const cls of names) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(cls)) throw new Error(`credential class ${JSON.stringify(cls)} is not a class name`);
      const p = join(dir, cls);
      if (!existsSync(p)) throw new Error(`credential class ${cls}: no file provisioned (absent) in the seat credentials directory`);
      const st = statSync(p);
      if (!st.isFile()) throw new Error(`credential class ${cls}: the provisioned path is not a file`);
      if ((st.mode & 0o077) !== 0) throw new Error(`credential class ${cls}: the provisioned file grants access to group or others (mode ${(st.mode & 0o777).toString(8)}); it must grant none to group or others`);
      if (owner !== undefined && st.uid !== owner) throw new Error(`credential class ${cls}: the provisioned file's owner is uid ${st.uid}, not the provisioning identity`);
      const v = readFileSync(p, "utf8");
      if (v.trim() === "") throw new Error(`credential class ${cls}: the provisioned file is empty`);
      out[cls] = v;
    }
    return out;
  };
}
