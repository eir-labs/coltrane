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

/** Enforce the grant's host allowlist in-process: --allow-net is all-or-nothing, so a skill that
 *  was granted the network can still only reach the hosts its grant names. A host is allowed when
 *  it equals an entry or is a subdomain of one; "*" allows any host. No grant → fetch is left as
 *  Node hands it over (already denied by the absent flag). */
function applyNetworkGrant(grant) {
  if (!grant || !Array.isArray(grant.allow)) return;
  const allow = grant.allow.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  const permitted = (url) => {
    let host;
    try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
    return allow.some((a) => a === "*" || host === a || host.endsWith(`.${a}`));
  };
  const original = globalThis.fetch;
  let used = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
    if (!permitted(url)) {
      throw new Error(`network grant refuses ${url} — allowed hosts: ${allow.join(", ")}`);
    }
    if (typeof grant.max_requests === "number" && ++used > grant.max_requests) {
      throw new Error(`network grant exhausted: max_requests=${grant.max_requests}`);
    }
    return original(input, init);
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
