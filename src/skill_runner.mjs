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
// It CAN still reach the network: Node's permission model has no network gate, and this
// comment previously claimed otherwise. The credential is out of reach instead — the child
// is given an explicit minimal environment rather than the parent's, so there is nothing
// worth exfiltrating. A real network gate needs a runtime that has one.
import { argv, stdin, stdout, exit } from "node:process";
import { pathToFileURL } from "node:url";
import { join, isAbsolute, resolve } from "node:path";

const skillDir = argv[2];

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
