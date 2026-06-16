// Skill runner — the child harness executed under Node's --permission sandbox.
//
// The parent (skill_subprocess.ts) spawns:
//   node --permission --allow-fs-read=* [tier flags] skill_runner.mjs <skill-dir>
// and pipes the input as JSON on stdin. This harness imports the skill's execution
// half, calls run(input), and writes {ok, output} (or {ok:false, error}) to stdout.
//
// stdin/stdout are not gated by the permission model; fs/child are. NETWORK, however,
// is NOT gated by Node's permission model (there is no --allow-net) — so without the
// in-process cage below, a tier-0 skill could fetch ANY host. The cage closes that gap:
// before the skill module is imported, we replace globalThis.fetch + node:http/https
// with allowlist-enforcing wrappers driven by meta.permission.network. A skill with no
// network grant is denied all egress (deny-by-default); a grant opens only its
// allowlisted hosts, only its methods (GET by default), and only up to its request
// budget. At tiers 0/1 the skill can't spawn a child or load native addons, so it can't
// reach an unpatched network primitive — making this a real cage, not a cooperative one.
import { argv, stdin, stdout, exit } from "node:process";
import { pathToFileURL } from "node:url";
import { join, isAbsolute, resolve } from "node:path";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const skillDir = argv[2];

// Install the network cage from a skill's permission.network grant (or deny-all when absent).
function installNetworkCage(net) {
  const allow = Array.isArray(net?.allow) ? net.allow.map(String) : [];
  const methods = (Array.isArray(net?.methods) ? net.methods : ["GET"]).map((m) => String(m).toUpperCase());
  const maxRequests = typeof net?.max_requests === "number" ? net.max_requests : Infinity;
  let count = 0;

  const hostAllowed = (host) => allow.some((a) => host === a || host.endsWith("." + a));
  const guard = (urlStr, method) => {
    let host;
    try { host = new URL(urlStr).hostname; } catch { throw new Error(`network cage: invalid URL "${urlStr}"`); }
    if (!hostAllowed(host)) {
      throw new Error(`network cage: host "${host}" not in allowlist [${allow.join(", ") || "(empty — deny-by-default)"}]`);
    }
    const m = String(method || "GET").toUpperCase();
    if (!methods.includes(m)) throw new Error(`network cage: method ${m} not permitted (allowed: ${methods.join(", ")})`);
    if (++count > maxRequests) throw new Error(`network cage: request budget exhausted (max_requests=${maxRequests})`);
  };

  // fetch (undici) — the primary path patent-fetch uses.
  const origFetch = globalThis.fetch;
  if (typeof origFetch === "function") {
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      const method = (init && init.method) || (input && typeof input === "object" && input.method) || "GET";
      guard(url, method);
      return origFetch(input, init);
    };
  }

  // node:http / node:https request+get — patched so a skill can't bypass the fetch guard by
  // dropping to the raw client. Extracts host + method from either the (url, opts) or (opts) form.
  for (const mod of [http, https]) {
    const scheme = mod === https ? "https:" : "http:";
    for (const fn of ["request", "get"]) {
      const orig = mod[fn];
      mod[fn] = function (arg1, arg2, arg3) {
        let urlStr, method;
        if (typeof arg1 === "string" || arg1 instanceof URL) {
          urlStr = String(arg1);
          const opts = (arg2 && typeof arg2 === "object") ? arg2 : {};
          method = opts.method || (fn === "get" ? "GET" : "GET");
        } else {
          const opts = arg1 || {};
          const host = opts.hostname || opts.host || "localhost";
          const path = opts.path || "/";
          urlStr = `${opts.protocol || scheme}//${host}${path}`;
          method = opts.method || "GET";
        }
        guard(urlStr, method);
        return orig.call(this, arg1, arg2, arg3);
      };
    }
  }
}

function readNetworkGrant(dir) {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    return meta?.permission?.network ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const dir = isAbsolute(skillDir) ? skillDir : resolve(skillDir);

  // Close the network before the skill loads. Absent grant → deny-all (allow: []).
  installNetworkCage(readNetworkGrant(dir) ?? { allow: [] });

  let raw = "";
  for await (const chunk of stdin) raw += chunk;
  const input = raw.trim() ? JSON.parse(raw) : {};

  const mod = await import(pathToFileURL(join(dir, "skill.mjs")).href);
  const run = mod.default ?? mod.run;
  if (typeof run !== "function") {
    throw new Error(`skill at ${skillDir} exports no default run() function`);
  }
  const output = await run(input);
  stdout.write(JSON.stringify({ ok: true, output }));
}

main().catch((e) => {
  stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  exit(1);
});
