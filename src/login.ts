// `coltrane login` — A MEMBER AUTHENTICATES ONCE, AND NOTHING ELSE IS EVER ASKED OF THEM.
//
// WHY THIS EXISTS, in the words that earned it. Eugene, 7 Oct, shown the line a hosted user needed in
// order to boot — four exports, two of them grepped out of a different repo's .env.local:
//   "are you fucking kidding me? this is the experience people who use hosted need? THEY NEED OUR
//    FUCKING ANON KEY AND A SERVICE URL?! WHAT THE FUCK KIND OF USER EXPERIENCE IS THIS"
// He is right, and the argument that disposes of every objection is a property of those values:
// COLTRANE_STORE_URL and COLTRANE_STORE_ANON are `NEXT_PUBLIC_*` constants. They are inlined into the
// client bundle and shipped to every browser that loads the surface. They are not secrets a user is
// being trusted with — they are the SERVICE'S OWN PUBLISHED CONSTANTS, and the door's address is the
// service's too. Asking a user to supply them is asking them to configure the vendor's deployment.
//
// So the contract (BOOT-13, legs A–D) is: the only thing ever asked is WHO YOU ARE. After a login, a
// boot needs nothing else; a refusal may name a login or a seat and may name nothing else; and the
// login yields the HOSTED GENOME rather than whatever directory the operator happened to stand in.
//
// WHAT A LOGIN IS NOT. It does not make the mint callable by a seat. `agent_token_issue` stays
// member-only — a one-sitting credential issuing a standing one is an escalation no store-side gate
// catches. What a login changes is that a MEMBER'S OWN credential becomes available to the boot AS A
// VALUE, which is precisely the gap that made the mint path unreachable from two different chairs on
// 6 Oct: an MCP session that is itself member-authenticated holds that standing as a TRANSPORT, and a
// transport is not something a spawned process can be handed.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

export interface LoginIO {
  out: (s: string) => void;
  err: (s: string) => void;
  env?: Record<string, string | undefined>;
  /** Injected for tests; production reads the terminal. */
  ask?: (prompt: string) => Promise<string>;
  /** Injected for tests; production asks the real terminal whether it is one. */
  isTTY?: boolean;
}

/** THE SESSION LANDS IN THE HOME DIRECTORY, NOT THE WORKING ONE. A login is a fact about a person, not
 *  about a folder: a credential written per-directory is one a user re-establishes for every repo they
 *  walk into, which is the experience this command exists to delete. */
export const SESSION_PATH = (home: string): string => join(home, ".coltrane", "session.json");

export const DEFAULT_DOOR = "https://coltrane.eir.sh";

export interface ServiceConstants {
  store_url: string;
  store_anon: string;
  door: string;
}

/** THE SERVICE'S PUBLIC CONSTANTS, RESOLVED AND NEVER SUPPLIED — one seam, in priority order:
 *   1 · the environment, for a self-hoster pointing at their own deployment. An operator who exported
 *       it meant it, and this is the only tier a user can touch.
 *   2 · THE DOOR'S OWN ANSWER. The service is the authority on its own constants, so it serves them:
 *       one compiled address yields the rest, a fork changes one value, and no published key is baked
 *       into an npm package where a rotation would break every released version.
 *   3 · compiled defaults, if a build chose to carry them.
 *  Absent all three this REFUSES BY NAME and names a login — never a variable (leg C). */
export async function resolveServiceConstants(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; constants: ServiceConstants; from: string } | { ok: false; detail: string }> {
  const door = (env["COLTRANE_SERVICE_URL"] ?? DEFAULT_DOOR).replace(/\/$/, "");

  const envUrl = env["COLTRANE_STORE_URL"];
  const envAnon = env["COLTRANE_STORE_ANON"];
  if (envUrl !== undefined && envUrl.length > 0 && envAnon !== undefined && envAnon.length > 0) {
    return { ok: true, from: "the environment (a self-hosted deployment)", constants: { store_url: envUrl, store_anon: envAnon, door } };
  }

  // 2 · ask the service. Unauthenticated by design: it returns only what is already published to every
  // browser that loads the surface, so there is nothing here a visitor could not already read.
  try {
    const res = await fetchImpl(`${door}/api/config`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const body = (await res.json()) as { store_url?: unknown; store_anon?: unknown };
      if (typeof body.store_url === "string" && typeof body.store_anon === "string" && body.store_url.length > 0 && body.store_anon.length > 0) {
        return { ok: true, from: `the service's own answer (${door}/api/config)`, constants: { store_url: body.store_url, store_anon: body.store_anon, door } };
      }
    }
  } catch {
    /* unreachable or absent: fall through to the compiled tier, then to a named refusal */
  }

  if (COMPILED_CONSTANTS !== undefined) {
    return { ok: true, from: "this build's compiled defaults", constants: { ...COMPILED_CONSTANTS, door } };
  }

  return {
    ok: false,
    detail:
      `this build cannot resolve the service's public constants: ${door}/api/config did not answer with them, ` +
      `and no deployment was compiled in. Nothing is missing on your side — the SERVICE has to publish its own ` +
      `constants, which are the same values its web surface already ships to every browser.`,
  };
}

/** A build may carry a deployment's published constants. Left undefined so that no released package
 *  pins the engine to one vendor's store, and so that a key rotation cannot break versions already
 *  installed: the door's answer is the live tier, and this is only a fallback a distributor may set. */
const COMPILED_CONSTANTS: { store_url: string; store_anon: string } | undefined = undefined;

export interface MemberSession {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  email?: string;
  store_url: string;
  store_anon: string;
  door: string;
  logged_in_at: string;
}

/** The member's session, or undefined. Read by the boot so that a login is the ONLY thing a user does. */
export function readSession(home: string): MemberSession | undefined {
  const path = SESSION_PATH(home);
  if (!existsSync(path)) return undefined;
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as MemberSession;
    return typeof s.access_token === "string" && s.access_token.length > 0 ? s : undefined;
  } catch {
    return undefined; // a corrupt session is no session; the boot names a login, never a parse error
  }
}

export function sessionIsExpired(s: MemberSession, now = Date.now()): boolean {
  return typeof s.expires_at === "number" && s.expires_at * 1000 <= now;
}

function writeSession(home: string, s: MemberSession): string {
  const path = SESSION_PATH(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// THE FLOW. An emailed one-time code, not a password and not a browser redirect: the hosted surface
// authenticates members through an auth callback, and a terminal cannot catch a redirect without
// standing up a local server. A six-digit code needs no listener, no browser on the same machine, and
// no password for accounts that have never had one.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
async function sendCode(c: ServiceConstants, email: string, fetchImpl: typeof fetch): Promise<{ ok: boolean; detail: string }> {
  const res = await fetchImpl(`${c.store_url.replace(/\/$/, "")}/auth/v1/otp`, {
    method: "POST",
    headers: { apikey: c.store_anon, "content-type": "application/json" },
    // create_user false: a login does not enrol anyone. Membership is granted by the institution,
    // never by having typed an address at a prompt.
    body: JSON.stringify({ email, create_user: false }),
  });
  if (res.ok) return { ok: true, detail: "sent" };
  return { ok: false, detail: `${res.status}: ${(await res.text()).slice(0, 200)}` };
}

async function verifyCode(
  c: ServiceConstants,
  email: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; session: Omit<MemberSession, "store_url" | "store_anon" | "door" | "logged_in_at"> } | { ok: false; detail: string }> {
  const res = await fetchImpl(`${c.store_url.replace(/\/$/, "")}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: c.store_anon, "content-type": "application/json" },
    body: JSON.stringify({ type: "email", email, token }),
  });
  const raw = await res.text();
  if (!res.ok) return { ok: false, detail: `${res.status}: ${raw.slice(0, 200)}` };
  let body: { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown; user?: { email?: unknown } };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return { ok: false, detail: `the service's answer did not parse: ${raw.slice(0, 160)}` };
  }
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    return { ok: false, detail: "the service accepted the code but returned no session" };
  }
  return {
    ok: true,
    session: {
      access_token: body.access_token,
      ...(typeof body.refresh_token === "string" ? { refresh_token: body.refresh_token } : {}),
      ...(typeof body.expires_at === "number" ? { expires_at: body.expires_at } : {}),
      ...(typeof body.user?.email === "string" ? { email: body.user.email } : {}),
    },
  };
}

export async function runLogin(argv: readonly string[], io: LoginIO): Promise<number> {
  const env = io.env ?? process.env;
  const home = env["HOME"] ?? "";
  if (home === "") {
    io.err("coltrane login: no home directory to keep a session in.\n");
    return 2;
  }

  // `--status` answers without authenticating anything, so a reader can tell whether they are logged
  // in without being prompted for a code they do not need.
  if (argv.includes("--status")) {
    const s = readSession(home);
    if (s === undefined) {
      io.out("not logged in. Run `coltrane login`.\n");
      return 1;
    }
    const state = sessionIsExpired(s) ? "EXPIRED — run `coltrane login` again" : "live";
    io.out(
      `logged in${s.email !== undefined ? ` as ${s.email}` : ""} (${state})\n` +
        `  session: ${SESSION_PATH(home)} (mode ${(statSync(SESSION_PATH(home)).mode & 0o777).toString(8)}, value never printed)\n` +
        `  door: ${s.door}\n  store: ${s.store_url}\n  since: ${s.logged_in_at}\n`,
    );
    return sessionIsExpired(s) ? 1 : 0;
  }

  const resolved = await resolveServiceConstants(env);
  if (!resolved.ok) {
    io.err(`coltrane login refused: ${resolved.detail}\n`);
    return 2;
  }
  const c = resolved.constants;
  io.out(`coltrane login — ${c.door}\n  constants resolved from ${resolved.from}\n`);

  const tty = io.isTTY ?? process.stdin.isTTY === true;
  const flagEmail = (() => {
    const i = argv.indexOf("--email");
    const v = i === -1 ? undefined : argv[i + 1];
    return v !== undefined && !v.startsWith("--") ? v : undefined;
  })();

  // A LOGIN THAT CANNOT ASK MUST NOT HANG. Without a terminal there is nobody to type a code, and a
  // command that blocks forever in a script is worse than one that refuses in a sentence.
  if (!tty && flagEmail === undefined) {
    io.err(
      "coltrane login refused: this is not a terminal, so there is nobody to type a one-time code. " +
        "Run it in a terminal, or pass --email <you@example.com> to have the code sent and then --code <code> to finish.\n",
    );
    return 2;
  }

  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = io.ask ?? (async (p: string): Promise<string> => (rl === undefined ? "" : (await rl.question(p)).trim()));
  try {
    const email = flagEmail ?? (await ask("  email: "));
    if (email === "" || !email.includes("@")) {
      io.err("coltrane login refused: that does not look like an email.\n");
      return 2;
    }

    const codeFlag = (() => {
      const i = argv.indexOf("--code");
      const v = i === -1 ? undefined : argv[i + 1];
      return v !== undefined && !v.startsWith("--") ? v : undefined;
    })();

    if (codeFlag === undefined) {
      const sent = await sendCode(c, email, fetch);
      if (!sent.ok) {
        io.err(
          `coltrane login refused: the service would not send a code to ${email} — ${sent.detail}. ` +
            `If that email is not a member, membership is granted by the institution, not by this command.\n`,
        );
        return 2;
      }
      io.out(`  a one-time code has been sent to ${email}\n`);
    }
    const code = codeFlag ?? (await ask("  code: "));
    if (code === "") {
      io.err("coltrane login refused: no code entered.\n");
      return 2;
    }

    const verified = await verifyCode(c, email, code, fetch);
    if (!verified.ok) {
      io.err(`coltrane login refused: the code was not accepted — ${verified.detail}\n`);
      return 2;
    }

    const path = writeSession(home, {
      ...verified.session,
      store_url: c.store_url,
      store_anon: c.store_anon,
      door: c.door,
      logged_in_at: new Date().toISOString(),
    });
    // The destination, never the value: the same discipline the boot's credential write holds to.
    io.out(
      `  logged in${verified.session.email !== undefined ? ` as ${verified.session.email}` : ""}\n` +
        `  session: ${path} (mode ${(statSync(path).mode & 0o777).toString(8)}, value never printed)\n` +
        `\nNothing else is needed. \`coltrane play\` will resolve the door, the store and the genome from this session.\n`,
    );
    return 0;
  } finally {
    rl?.close();
  }
}
