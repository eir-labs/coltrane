// P2 — AN UNGRANTED SKILL CANNOT REACH THE NETWORK EVEN WHEN AN OLDER `node` IS FIRST ON PATH.
//
// The non-author grade of #557 (issuecomment-5847532054): parent Node 26.7.0, PATH node 24.21.0, a
// tier-0 skill with NO network grant fetched a local listener and got 200 — because executeSkill /
// executeSkillAsync spawned the bare string "node" from PATH while the floor checked the parent's
// process.version. The root-band law (tests/skill_runs_on_exec_path.test.ts, P1) proves the PATH node is
// never invoked; this law proves the consequence that matters, with a real request, which is why it is
// in the security band (the root suite may not open a socket).
//
// The shim stands in for an old Node without needing one installed: it runs the real binary with
// `--permission` and every `--allow-*` dropped — a Node with no permission model, which is what 24 is
// for the network. The listener counts hits; the law asserts ZERO, not just a thrown fetch.
//
//   law  kind         drives                                        plant (smallest production edit → red)
//   P2   behavioural  executeSkillAsync — src/skill_subprocess.ts   (red at ad9d5ec) · after: spawn("node", …) in executeSkillAsync
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { executeSkillAsync } from "../../src/skill_subprocess.js";

let root: string;
let shimLog: string;
let savedPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "exec-path-net-"));
  shimLog = join(root, "shim.log");
  const bin = join(root, "shim-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "node"), [
    "#!/bin/sh",
    `printf 'invoked\\n' >> ${JSON.stringify(shimLog)}`,
    'for a do shift; case "$a" in --permission|--allow-*) ;; *) set -- "$@" "$a" ;; esac; done',
    `exec ${JSON.stringify(process.execPath)} "$@"`,
    "",
  ].join("\n"));
  chmodSync(join(bin, "node"), 0o755);
  savedPath = process.env["PATH"];
  process.env["PATH"] = `${bin}${delimiter}${savedPath ?? ""}`;
});
afterEach(() => {
  if (savedPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = savedPath;
  rmSync(root, { recursive: true, force: true });
});

describe("P2 — an old `node` first on PATH does not open the network to an ungranted skill", () => {
  it("an ungranted tier-0 skill's fetch to a local listener is denied, and the listener sees no request", async () => {
    let hits = 0;
    const srv = createServer((_req, res) => { hits++; res.writeHead(200); res.end("leak"); });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/leak`;
    try {
      const dir = join(root, "probe");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "meta.json"), JSON.stringify({
        slug: "probe", version: 1, skill_type: "deterministic", input_type: "note", output_type: "note",
        permission: { tier: 0 }, description: "an ungranted fetch", determinism_ratio: 1,
      }));
      writeFileSync(join(dir, "skill.mjs"), `export default async function run(input) {
        try { const r = await fetch(input.url); return { status: r.status }; }
        catch (e) { return { error: String(e.code ?? e.cause?.code ?? e.message) }; }
      }`);
      const r = await executeSkillAsync(dir, { url }, 30_000, {});
      const out = (r.output ?? {}) as { status?: number; error?: string };
      expect(out.status, `an UNGRANTED skill fetched ${url} and got ${out.status} — it ran without the permission model (PATH node used: ${existsSync(shimLog)})`).toBeUndefined();
      expect(hits, "the listener was reached by a skill with no network grant").toBe(0);
      expect(r.ok, String(r.error)).toBe(true);
    } finally {
      srv.close();
    }
  });
});
