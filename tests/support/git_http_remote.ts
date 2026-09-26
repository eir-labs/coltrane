// A LOCAL SMART-HTTP GIT REMOTE, standing in for github.com in the sandbox laws.
//
// `git http-backend` behind a node http server on 127.0.0.1. A seat's `git push` reaches it the way it
// would reach a real host: through the sandbox's network proxy (the sandbox exempts loopback from the
// proxy via NO_PROXY and blocks direct loopback connections, so a law clears NO_PROXY for the command
// to route it through the proxy exactly as a remote host's traffic is routed). The server itself runs
// outside the sandbox, so the bare repository it serves is written by the server, not by the seat.
import { createServer, type Server } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitHttpRemote { url: string; bare: string; close: () => Promise<void> }

export async function startGitHttpRemote(name = "remote.git"): Promise<GitHttpRemote> {
  const root = mkdtempSync(join(tmpdir(), "git-http-root-"));
  const bare = join(root, name);
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  execFileSync("git", ["-C", bare, "config", "http.receivepack", "true"]);
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: decodeURIComponent(u.pathname),
        QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method ?? "GET", CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
        HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""), REMOTE_USER: "seat", REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(child.stdin);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("close", () => {
      const out = Buffer.concat(chunks);
      const sep = out.indexOf("\r\n\r\n");
      const head = out.subarray(0, sep).toString("utf8");
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.split("\r\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.end(out.subarray(sep + 4));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/${name}`, bare, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A plain HTTP endpoint on loopback, standing in for an API host (api.github.com, api.vercel.com). */
export async function startApiStandIn(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = createServer((_req, res) => { hits += 1; res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/`, hits: () => hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Run a command WITHOUT blocking the event loop (the stand-in servers live in this process). */
export function runAsync(cmd: string, args: readonly string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { cwd: opts.cwd, env: opts.env ?? process.env });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, out }); });
  });
}
