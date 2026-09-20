// Skill runner — the child harness executed under Node's --permission sandbox.
//
// The parent (skill_subprocess.ts) spawns:
//   node --permission --allow-fs-read=* [tier flags] skill_runner.mjs <skill-dir>
// and pipes the input as JSON on stdin. This harness imports the skill's execution
// half, calls run(input), and writes {ok, output} (or {ok:false, error}) to stdout.
//
// stdin/stdout are not gated by the permission model. Reads are scoped to this runner's
// directory and the skill's own package, writes and child_process are tier-gated — so a
// tier-0 skill can read its own code and inputs but cannot read elsewhere, write, or spawn.
//
// The network is now gated by Node itself: without --allow-net (passed only when the skill's
// meta declares permission.network) a fetch fails with ERR_ACCESS_DENIED. --allow-net is
// all-or-nothing, so the grant's `allow` list is enforced HERE: fetch is wrapped and a host the
// grant does not name is refused before the request is made. That bounds this skill's own code,
// not code that deliberately reaches around it — once the capability is granted, node:net is
// reachable. The credential is out of reach either way: the child gets an explicit minimal
// environment rather than the parent's.
import { argv, stdin, stdout, exit } from "node:process";
import { pathToFileURL } from "node:url";
import { join, isAbsolute, resolve } from "node:path";

const skillDir = argv[2];

/** Enforce the grant IN-PROCESS. `--allow-net` is all-or-nothing, so everything the grant promises
 *  beyond "may use the network" is enforced here, at the one chokepoint a skill's code goes through:
 *    allow[]       — the host must equal an entry or be a subdomain of one ("*" allows any host)
 *    methods[]     — the request method must be named (default GET when the caller sets none)
 *    max_requests  — a ceiling on calls; the next one throws
 *    max_bytes     — a ceiling on what a response BODY can hand back: the body readers are wrapped,
 *                    so an oversized response throws instead of being returned. It bounds what the
 *                    skill can read, not what crossed the wire.
 *  This bounds the skill's own code. Once the capability is granted, code that deliberately reaches
 *  around this wrapper (node:net, a fresh undici agent) is not stopped by it — the grant is a bound
 *  on an honest skill and a visible declaration for review, not a proof. No grant → nothing wrapped,
 *  and the absent --allow-net has already denied the capability at the syscall. */
function applyNetworkGrant(grant) {
  if (!grant) return;
  const allow = (Array.isArray(grant.allow) ? grant.allow : []).map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  const methods = Array.isArray(grant.methods) ? grant.methods.map((m) => String(m).toUpperCase()) : null;
  const maxBytes = typeof grant.max_bytes === "number" ? grant.max_bytes : null;
  const permitted = (url) => {
    let host;
    try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
    return allow.some((a) => a === "*" || host === a || host.endsWith(`.${a}`));
  };
  const original = globalThis.fetch;
  let used = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
    if (!permitted(url)) throw new Error(`network grant refuses ${url} — allowed hosts: ${allow.join(", ") || "(none)"}`);
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    if (methods && !methods.includes(method)) {
      throw new Error(`network grant refuses method ${method} — allowed: ${methods.join(", ")}`);
    }
    if (typeof grant.max_requests === "number" && ++used > grant.max_requests) {
      throw new Error(`network grant exhausted: max_requests=${grant.max_requests}`);
    }
    const res = await original(input, init);
    if (maxBytes === null) return res;
    const guard = (value) => {
      const size = typeof value === "string" ? Buffer.byteLength(value) : value?.byteLength ?? 0;
      if (size > maxBytes) throw new Error(`network grant refuses a ${size}-byte body — max_bytes=${maxBytes}`);
      return value;
    };
    return new Proxy(res, {
      get(target, prop, recv) {
        if (prop === "text") return async () => guard(await target.text());
        if (prop === "arrayBuffer") return async () => guard(await target.arrayBuffer());
        if (prop === "json") return async () => JSON.parse(guard(await target.text()));
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
}

async function main() {
  let raw = "";
  for await (const chunk of stdin) raw += chunk;
  const payload = raw.trim() ? JSON.parse(raw) : {};
  // The parent may wrap the input in an envelope carrying CONTEXT — today `upstream`, the list of
  // upstream outputs by role — so a skill can see N same-type inputs individually instead of only
  // the Object.assign merge (which silently collapses them). A bare payload is the legacy shape and
  // still calls run(input) with no context; a skill that ignores its second argument is unchanged.
  const isEnvelope = payload && typeof payload === "object" && payload.__coltrane_skill_envelope === 1;
  const input = isEnvelope ? payload.input : payload;
  const context = isEnvelope ? payload.context : undefined;

  // The allowlist travels with the input envelope (the parent reads meta; the child must not
  // re-read the package from disk under a tier-0 read scope).
  applyNetworkGrant(isEnvelope ? payload.network_grant : undefined);

  const dir = isAbsolute(skillDir) ? skillDir : resolve(skillDir);
  const mod = await import(pathToFileURL(join(dir, "skill.mjs")).href);
  const run = mod.default ?? mod.run;
  if (typeof run !== "function") {
    throw new Error(`skill at ${skillDir} exports no default run() function`);
  }
  const output = context === undefined ? await run(input) : await run(input, context);
  stdout.write(JSON.stringify({ ok: true, output }));
}

main().catch((e) => {
  stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  exit(1);
});
