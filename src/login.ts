// `coltrane login` — A CONSOLE WITH A SWITCHER BETWEEN AUTH STORES, AND NOT ONE FIRST-PARTY BYTE.
//
// Eugene, 7 Oct, after being shown the four exports a hosted user needed in order to boot:
//   "my goal is to keep oss clean of any first party mandatories … coltrane login opens console menu
//    with switcher between auth stores, and its trivial to configure your own then. then id select
//    whatever option i prefer which in my case is literally coltrane.eir.sh … then some formal
//    connector protocol for authenticating me via the login via wiki method for mcp authentication we
//    already do for authing our own mcps."
//
// THE FIRST CUT OF THIS FILE FAILED THAT RULE and I had already shipped the violation before asking a
// question about it: it compiled `https://coltrane.eir.sh` in as a default door, and proposed baking a
// deployment's Supabase URL and anon key in beside it. A vendor's address inside an OSS engine is a
// first-party mandatory however politely it is spelled "default". Nothing in this file names a host.
//
// WHAT REPLACES IT IS NOT AN INVENTION — IT IS THE PROTOCOL THE DOOR ALREADY SPEAKS. Driven 7 Oct
// against a live deployment, which answers an unauthenticated call with:
//   www-authenticate: Bearer error="invalid_token",
//     resource_metadata="https://<host>/.well-known/oauth-protected-resource"
// and publishes, unauthenticated, {"resource": "...", "authorization_servers": ["..."]}; whose
// authorization server in turn advertises a registration_endpoint, PKCE S256, and
// token_endpoint_auth_methods_supported including "none". That is RFC 9728 + RFC 8414 + RFC 7591 +
// PKCE — MCP's own authorization story, the same one a client already uses to authenticate against
// these servers. It needs NO pre-shared client id, NO secret, and NO published constant: an operator
// pastes the address of a house they want to enter, and every other value is discovered from it.
//
// So a fork configures its own store by typing its own URL, and this file stays empty of ours.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";

export interface LoginIO {
  out: (s: string) => void;
  err: (s: string) => void;
  env?: Record<string, string | undefined>;
  ask?: (prompt: string) => Promise<string>;
  isTTY?: boolean;
}

const home = (env: Record<string, string | undefined>): string => env["HOME"] ?? "";
const configDir = (env: Record<string, string | undefined>): string => join(home(env), ".coltrane");
export const STORES_PATH = (env: Record<string, string | undefined>): string => join(configDir(env), "stores.json");
const sessionPath = (env: Record<string, string | undefined>, store: string): string =>
  join(configDir(env), "sessions", `${store.replace(/[^A-Za-z0-9.-]/g, "_")}.json`);

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// THE REGISTRY. Auth stores an operator has configured, and which one is current. A list rather than a
// setting, because switching between houses is the normal case for anyone who works in more than one.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface StoreRegistry {
  stores: { name: string; url: string }[];
  current?: string;
}

export function readStores(env: Record<string, string | undefined>): StoreRegistry {
  const p = STORES_PATH(env);
  if (!existsSync(p)) return { stores: [] };
  try {
    const r = JSON.parse(readFileSync(p, "utf8")) as StoreRegistry;
    return Array.isArray(r.stores) ? r : { stores: [] };
  } catch {
    return { stores: [] }; // a corrupt registry is no registry; login offers to configure one
  }
}

function writeStores(env: Record<string, string | undefined>, r: StoreRegistry): void {
  const p = STORES_PATH(env);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(r, null, 2) + "\n", { mode: 0o600 });
}

export interface StoreSession {
  store: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  obtained_at: string;
  /** The resource the token was issued FOR — an access token is not a bearer for any door that asks. */
  resource: string;
}

export function readStoreSession(env: Record<string, string | undefined>, store: string): StoreSession | undefined {
  const p = sessionPath(env, store);
  if (!existsSync(p)) return undefined;
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as StoreSession;
    return typeof s.access_token === "string" && s.access_token.length > 0 ? s : undefined;
  } catch {
    return undefined;
  }
}

export function sessionIsExpired(s: StoreSession, now = Date.now()): boolean {
  return typeof s.expires_at === "number" && s.expires_at * 1000 <= now;
}

/** THE CURRENT SEAT'S DOOR, resolved and never compiled in. An override first, for a script or a
 *  self-hoster; then whichever store the operator selected. Absent both, there is no door — and the
 *  caller's business is to name a LOGIN, never a variable. */
export function currentDoor(env: Record<string, string | undefined>): { url: string; from: string } | undefined {
  const override = env["COLTRANE_SERVICE_URL"];
  if (override !== undefined && override.length > 0) return { url: override.replace(/\/$/, ""), from: "COLTRANE_SERVICE_URL" };
  const reg = readStores(env);
  const name = reg.current;
  const hit = reg.stores.find((s) => s.name === name) ?? reg.stores[0];
  return hit === undefined ? undefined : { url: hit.url.replace(/\/$/, ""), from: `the store you selected (${hit.name})` };
}

export function currentSession(env: Record<string, string | undefined>): StoreSession | undefined {
  const door = currentDoor(env);
  return door === undefined ? undefined : readStoreSession(env, door.url);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// THE CONNECTOR PROTOCOL. Discovery, then registration, then PKCE — each step reading only what the
// previous one returned, so no host, client id or key is ever assumed.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
interface Discovered {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  resource: string;
}

export async function discover(doorUrl: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; d: Discovered } | { ok: false; detail: string }> {
  const mcp = `${doorUrl.replace(/\/$/, "")}/api/mcp`;
  // 1 · ask the door. Its 401 names where its own metadata lives (RFC 9728) — we follow the pointer
  // rather than guessing a well-known path, because the pointer is the part the spec guarantees.
  let metaUrl: string | undefined;
  let resource = doorUrl.replace(/\/$/, "");
  try {
    const probe = await fetchImpl(mcp, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
    const wa = probe.headers.get("www-authenticate") ?? "";
    metaUrl = /resource_metadata="([^"]+)"/.exec(wa)?.[1];
  } catch (e) {
    return { ok: false, detail: `the door could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
  metaUrl ??= `${resource}/.well-known/oauth-protected-resource`;

  let servers: string[] = [];
  try {
    const res = await fetchImpl(metaUrl, { headers: { accept: "application/json" } });
    if (res.ok) {
      const body = (await res.json()) as { resource?: unknown; authorization_servers?: unknown };
      if (typeof body.resource === "string") resource = body.resource;
      if (Array.isArray(body.authorization_servers)) servers = body.authorization_servers.filter((s): s is string => typeof s === "string");
    }
  } catch { /* fall through to the refusal below */ }
  const as = servers[0];
  if (as === undefined) {
    return { ok: false, detail: `${metaUrl} named no authorization server, so there is nothing to log in to. That URL may not be a coltrane door.` };
  }

  // 2 · the authorization server describes itself (RFC 8414).
  try {
    const res = await fetchImpl(`${as.replace(/\/$/, "")}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, detail: `the authorization server at ${as} published no metadata (HTTP ${res.status})` };
    const m = (await res.json()) as { authorization_endpoint?: unknown; token_endpoint?: unknown; registration_endpoint?: unknown };
    if (typeof m.authorization_endpoint !== "string" || typeof m.token_endpoint !== "string") {
      return { ok: false, detail: `the authorization server at ${as} published metadata without the endpoints a login needs` };
    }
    return {
      ok: true,
      d: {
        authorization_endpoint: m.authorization_endpoint,
        token_endpoint: m.token_endpoint,
        ...(typeof m.registration_endpoint === "string" ? { registration_endpoint: m.registration_endpoint } : {}),
        resource,
      },
    };
  } catch (e) {
    return { ok: false, detail: `the authorization server at ${as} could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A PUBLIC CLIENT, REGISTERED ON THE SPOT (RFC 7591). The alternative is a client id shipped in the
 *  package, which is a first-party mandatory by another name — and worse here, since it would be one
 *  deployment's id compiled into everyone's engine. */
async function register(d: Discovered, redirect: string, fetchImpl: typeof fetch): Promise<{ ok: true; client_id: string } | { ok: false; detail: string }> {
  if (d.registration_endpoint === undefined) {
    return { ok: false, detail: "this authorization server does not offer dynamic client registration, so a client id would have to be configured by hand" };
  }
  const res = await fetchImpl(d.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "coltrane",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid email offline_access",
    }),
  });
  const raw = await res.text();
  if (!res.ok) return { ok: false, detail: `registration refused (HTTP ${res.status}): ${raw.slice(0, 200)}` };
  try {
    const b = JSON.parse(raw) as { client_id?: unknown };
    if (typeof b.client_id === "string" && b.client_id.length > 0) return { ok: true, client_id: b.client_id };
  } catch { /* fall through */ }
  return { ok: false, detail: "registration returned no client id" };
}

const b64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The loopback leg: a one-shot listener on 127.0.0.1 that receives the redirect and nothing else. */
function awaitCode(): { port: Promise<number>; code: Promise<{ code?: string; error?: string }>; close: () => void } {
  let resolvePort: (n: number) => void;
  let resolveCode: (v: { code?: string; error?: string }) => void;
  const port = new Promise<number>((r) => (resolvePort = r));
  const code = new Promise<{ code?: string; error?: string }>((r) => (resolveCode = r));
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const c = u.searchParams.get("code") ?? undefined;
    const e = u.searchParams.get("error") ?? undefined;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:3rem">${c ? "Signed in. You can close this tab and return to the terminal." : `Sign-in failed: ${e ?? "no code returned"}`}</body>`);
    resolveCode({ ...(c !== undefined ? { code: c } : {}), ...(e !== undefined ? { error: e } : {}) });
  });
  server.listen(0, "127.0.0.1", () => {
    const a = server.address();
    resolvePort(typeof a === "object" && a !== null ? a.port : 0);
  });
  return { port, code, close: () => server.close() };
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch { /* the URL is printed too; a browser that will not open is not a failure */ }
}

async function authorize(
  io: LoginIO,
  doorUrl: string,
  d: Discovered,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; session: StoreSession } | { ok: false; detail: string }> {
  const listener = awaitCode();
  try {
    const port = await listener.port;
    const redirect = `http://127.0.0.1:${port}/callback`;
    const reg = await register(d, redirect, fetchImpl);
    if (!reg.ok) return { ok: false, detail: reg.detail };

    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(16));
    const auth = new URL(d.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: redirect,
      scope: "openid email offline_access",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: d.resource,
    })) auth.searchParams.set(k, v);

    io.out(`\n  opening your browser to sign in. If it does not open, paste this:\n\n    ${auth.toString()}\n\n  waiting…\n`);
    openBrowser(auth.toString());

    const got = await listener.code;
    if (got.code === undefined) return { ok: false, detail: got.error ?? "the browser returned no authorization code" };

    const res = await fetchImpl(d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: got.code,
        redirect_uri: redirect,
        client_id: reg.client_id,
        code_verifier: verifier,
        resource: d.resource,
      }).toString(),
    });
    const raw = await res.text();
    if (!res.ok) return { ok: false, detail: `the token endpoint refused (HTTP ${res.status}): ${raw.slice(0, 200)}` };
    const b = JSON.parse(raw) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (typeof b.access_token !== "string" || b.access_token.length === 0) return { ok: false, detail: "the token endpoint returned no access token" };
    return {
      ok: true,
      session: {
        store: doorUrl,
        access_token: b.access_token,
        ...(typeof b.refresh_token === "string" ? { refresh_token: b.refresh_token } : {}),
        ...(typeof b.expires_in === "number" ? { expires_at: Math.floor(Date.now() / 1000) + b.expires_in } : {}),
        obtained_at: new Date().toISOString(),
        resource: d.resource,
      },
    };
  } finally {
    listener.close();
  }
}

function saveSession(env: Record<string, string | undefined>, s: StoreSession): string {
  const p = sessionPath(env, s.store);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
export async function runLogin(argv: readonly string[], io: LoginIO): Promise<number> {
  const env = io.env ?? process.env;
  if (home(env) === "") {
    io.err("coltrane login: no home directory to keep a session in.\n");
    return 2;
  }
  const reg = readStores(env);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    const v = i === -1 ? undefined : argv[i + 1];
    return v !== undefined && !v.startsWith("--") ? v : undefined;
  };

  if (argv.includes("--status") || argv.includes("--list")) {
    if (reg.stores.length === 0) {
      io.out("no auth stores configured. Run `coltrane login` to add one.\n");
      return 1;
    }
    io.out("auth stores:\n");
    for (const s of reg.stores) {
      const sess = readStoreSession(env, s.url);
      const state = sess === undefined ? "not signed in" : sessionIsExpired(sess) ? "session EXPIRED" : "signed in";
      io.out(`  ${s.name === reg.current ? "*" : " "} ${s.name.padEnd(28)} ${s.url.padEnd(40)} ${state}\n`);
    }
    io.out("\n  * = current. Values are never printed; sessions live in ~/.coltrane/sessions (0600).\n");
    return 0;
  }

  const tty = io.isTTY ?? process.stdin.isTTY === true;
  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = io.ask ?? (async (p: string): Promise<string> => (rl === undefined ? "" : (await rl.question(p)).trim()));

  try {
    // WHICH HOUSE. Named outright by --store, or chosen from the console. Nothing is defaulted to a
    // vendor: an engine that already knows where to send you has made the choice for you.
    let url = flag("--store");
    if (url === undefined) {
      if (!tty) {
        io.err("coltrane login refused: this is not a terminal, so there is no console to choose a store in. Pass --store <url>.\n");
        return 2;
      }
      io.out("\ncoltrane login\n\n");
      reg.stores.forEach((s, i) => io.out(`  ${i + 1}) ${s.name}${s.name === reg.current ? " (current)" : ""} — ${s.url}\n`));
      io.out(`  ${reg.stores.length + 1}) add an auth store\n\n`);
      const pick = await ask("  choose: ");
      const n = Number(pick);
      if (Number.isInteger(n) && n >= 1 && n <= reg.stores.length) {
        url = reg.stores[n - 1]?.url;
      } else if (Number.isInteger(n) && n === reg.stores.length + 1) {
        url = await ask("  store url (e.g. the host of your coltrane deployment): ");
      } else {
        io.err("coltrane login refused: that was not one of the choices.\n");
        return 2;
      }
    }
    if (url === undefined || url === "") {
      io.err("coltrane login refused: no store named.\n");
      return 2;
    }
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    url = url.replace(/\/$/, "");

    io.out(`\n  discovering how ${url} authenticates…\n`);
    const disc = await discover(url);
    if (!disc.ok) {
      io.err(`coltrane login refused: ${disc.detail}\n`);
      return 2;
    }
    io.out(`  it uses the authorization server its own metadata names; registering this client\n`);

    const got = await authorize(io, url, disc.d, fetch);
    if (!got.ok) {
      io.err(`coltrane login refused: ${got.detail}\n`);
      return 2;
    }

    const path = saveSession(env, got.session);
    const name = flag("--name") ?? new URL(url).host;
    const next: StoreRegistry = {
      stores: [...reg.stores.filter((s) => s.url !== url), { name, url }],
      current: name,
    };
    writeStores(env, next);
    io.out(
      `\n  signed in to ${name}\n` +
        `  session: ${path} (mode ${(statSync(path).mode & 0o777).toString(8)}, value never printed)\n` +
        `  current store: ${name} — switch any time with \`coltrane login\`\n` +
        `\nNothing else is needed. \`coltrane play\` resolves the door and the genome from this.\n`,
    );
    return 0;
  } finally {
    rl?.close();
  }
}

/** Sessions on disk, for a status line that does not have to guess. */
export function configuredStores(env: Record<string, string | undefined>): number {
  const d = join(configDir(env), "sessions");
  try {
    return existsSync(d) ? readdirSync(d).length : 0;
  } catch {
    return 0;
  }
}
