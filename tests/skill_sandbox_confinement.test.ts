// The skill sandbox claimed three guarantees it did not provide.
//
// `tierFlags(0)` returned `["--permission", "--allow-fs-read=*"]`, and the source asserted —
// in two places — that a tier-0 skill "cannot write, spawn, or reach the network". Probed on a
// real machine through the engine's own `executeSkill`, a tier-0 skill could:
//
//   read /etc/passwd        →  "##\n# User Da"
//   read process.env        →  77 variables
//   fetch("https://…")      →  status 200
//
// `--allow-fs-read=*` is literally "read every file", so the first was never confined. And
// Node's permission model has NO network gate at all, so the network guarantee was not
// merely misconfigured — it was unimplementable in that shape. The older pre-open-source
// engine ran skills under Deno (`--allow-read=<runtimeDir>` plus a net allowlist) and carried
// an adversarial test whose failure message read "CRITICAL: Tier 0 skill was able to read
// /etc/passwd!". The capability existed and was simplified away.
//
// The environment read is the one with teeth: `process.env` is where the Anthropic API key
// lives, so a skill could exfiltrate it with a single fetch. That is the path closed here.
//
// This file is deliberately written as a CAPABILITY PROBE rather than a flag assertion.
// Checking that `tierFlags` contains a particular string proves nothing about what the child
// can actually do — which is exactly how the false claim survived.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSkill, executeSkillAsync, tierFlags } from "../src/skill_subprocess.js";

let root: string;

/** A skill whose code half is `body`, declared at `tier`. */
function skill(body: string, tier = 0, network?: { allow: string[]; methods?: string[]; max_requests?: number; max_bytes?: number }): string {
  const dir = join(root, `s${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({
    slug: "probe", version: 1, skill_type: "deterministic",
    input_type: "note", output_type: "note",
    permission: network ? { tier, network } : { tier }, description: "probe", determinism_ratio: 1,
  }));
  writeFileSync(join(dir, "skill.mjs"), body);
  return dir;
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "sandbox-probe-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("tier 0 is confined — probed, not asserted", () => {
  it("CANNOT read a file outside the skill directory", () => {
    const dir = skill(`
      export async function run() {
        try { const fs = await import("node:fs");
              return { got: fs.readFileSync("/etc/passwd", "utf8").slice(0, 8) }; }
        catch (e) { return { blocked: e.code ?? e.name }; }
      }`);
    const r = executeSkill(dir, {});
    const out = r.output as { got?: string; blocked?: string };
    expect(out.got, "a tier-0 skill read /etc/passwd").toBeUndefined();
    expect(out.blocked).toBeTruthy();
  });

  it("CAN still read its own directory — confinement, not paralysis", () => {
    // The failure mode of an over-tight fix: deny everything, every assertion above passes,
    // and no skill can load its own fixtures or data files.
    const dir = skill(`
      export async function run() {
        const fs = await import("node:fs");
        const { join, dirname } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const here = dirname(fileURLToPath(import.meta.url));
        return { self: fs.readFileSync(join(here, "meta.json"), "utf8").length };
      }`);
    const r = executeSkill(dir, {});
    expect(r.ok, r.error).toBe(true);
    expect((r.output as { self: number }).self).toBeGreaterThan(0);
  });

  it("CANNOT see the parent's environment — the credential path", () => {
    // The one that mattered: process.env carries ANTHROPIC_API_KEY in any real deployment.
    process.env["COLTRANE_SANDBOX_PROBE_SECRET"] = "sk-do-not-leak";
    try {
      const dir = skill(`
        export async function run() {
          return { leaked: process.env.COLTRANE_SANDBOX_PROBE_SECRET ?? null,
                   count: Object.keys(process.env).length };
        }`);
      const r = executeSkill(dir, {});
      const out = r.output as { leaked: string | null; count: number };
      expect(out.leaked, "a skill read a secret out of the parent's environment").toBeNull();
      // A handful of variables the runtime needs is fine; inheriting the parent's whole
      // environment is what made exfiltration a one-liner.
      expect(out.count, `child saw ${out.count} env vars`).toBeLessThan(10);
    } finally {
      delete process.env["COLTRANE_SANDBOX_PROBE_SECRET"];
    }
  });

  it("CANNOT write outside its own directory", () => {
    const dir = skill(`
      export async function run() {
        try { const fs = await import("node:fs");
              fs.writeFileSync("/tmp/coltrane-tier0-escape", "x");
              return { wrote: true }; }
        catch (e) { return { blocked: e.code ?? e.name }; }
      }`);
    const out = executeSkill(dir, {}).output as { wrote?: boolean; blocked?: string };
    expect(out.wrote).toBeUndefined();
    expect(out.blocked).toBeTruthy();
  });

  it("CANNOT spawn a child process", () => {
    const dir = skill(`
      export async function run() {
        try { const cp = await import("node:child_process");
              return { out: cp.execSync("id").toString() }; }
        catch (e) { return { blocked: e.code ?? e.name }; }
      }`);
    const out = executeSkill(dir, {}).output as { out?: string; blocked?: string };
    expect(out.out).toBeUndefined();
    expect(out.blocked).toBeTruthy();
  });
});

describe("the tiers still grant what they say", () => {
  it("tier 1 can write, tier 0 cannot", () => {
    const body = `
      export async function run() {
        const fs = await import("node:fs");
        const { join, dirname } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const here = dirname(fileURLToPath(import.meta.url));
        try { fs.writeFileSync(join(here, "out.txt"), "x"); return { wrote: true }; }
        catch (e) { return { blocked: e.code ?? e.name }; }
      }`;
    expect((executeSkill(skill(body, 1), {}).output as { wrote?: boolean }).wrote).toBe(true);
    expect((executeSkill(skill(body, 0), {}).output as { wrote?: boolean }).wrote).toBeUndefined();
  });

  it("tier 2 can spawn, tier 1 cannot", () => {
    const body = `
      export async function run() {
        try { const cp = await import("node:child_process");
              return { ok: cp.execSync("echo hi").toString().trim() }; }
        catch (e) { return { blocked: e.code ?? e.name }; }
      }`;
    expect((executeSkill(skill(body, 2), {}).output as { ok?: string }).ok).toBe("hi");
    expect((executeSkill(skill(body, 1), {}).output as { ok?: string }).ok).toBeUndefined();
  });
});

function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0] ?? 0);
}

/** A local HTTP server, so these laws prove the GATE rather than the runner's internet access.
 *  These laws use executeSkillAsync, not executeSkill: the sync path is spawnSync, which blocks the
 *  parent's event loop for the child's whole timeout — so the server in THIS process could never
 *  answer the child's request and every such law timed out at 120s.
 *  `verify` runs offline; a law that reaches example.com fails there for a reason that has nothing
 *  to do with what it is testing. Loopback is also the honest shape: the grant's allowlist is about
 *  which host, not which network. */
async function localServer(bodyBytes = 4): Promise<{ url: string; host: string; close: () => void }> {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(bodyBytes));
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}/`, host: "127.0.0.1", close: () => srv.close() };
}

describe("the network is a declared capability", () => {
  // The previous release stated a gap honestly: Node's permission model had no network flag, so a
  // skill could reach out and the source said so rather than promising otherwise. Node 24 added
  // --allow-net, and the gap closed — measured, not assumed: every URL in a landscape run came
  // back ERR_ACCESS_DENIED until the flag was passed. So the grant that was already in the schema
  // and read by nothing (SkillPermissionSchema.network) is now what decides.
  it("passes no --allow-net when the skill declares no network grant", () => {
    expect(tierFlags(0).join(" ")).not.toContain("--allow-net");
    expect(tierFlags(2).join(" ")).not.toContain("--allow-net"); // not a tier — a declaration
  });

  it("passes --allow-net when the skill declares a grant", () => {
    expect(tierFlags(0, undefined, { allow: ["example.com"] }).join(" ")).toContain("--allow-net");
  });

  const FETCH = `export default async function run(input) {
    try { const r = await fetch(input.url, input.init); return { status: r.status }; }
    catch (e) { return { error: String(e.message) }; }
  }`;

  it("lets a granted skill reach a host its allow list names, and refuses one it does not", async () => {
    const srv = await localServer();
    try {
      const dir = skill(FETCH, 0, { allow: [srv.host] });
      const allowed = (await executeSkillAsync(dir, { url: srv.url }, 30000, {})).output as { status?: number };
      expect(allowed.status).toBe(200);
      const refused = (await executeSkillAsync(dir, { url: "http://127.0.0.2:1/" }, 30000, {})).output as { error?: string };
      expect(String(refused.error)).toContain("network grant refuses");
    } finally {
      srv.close();
    }
  });

  it("refuses a method the grant does not name", async () => {
    const srv = await localServer();
    try {
      const dir = skill(FETCH, 0, { allow: [srv.host], methods: ["GET"] });
      const out = (await executeSkillAsync(dir, { url: srv.url, init: { method: "POST" } }, 30000, {})).output as { error?: string };
      expect(String(out.error)).toContain("refuses method POST");
    } finally {
      srv.close();
    }
  });

  it("refuses past max_requests", async () => {
    const srv = await localServer();
    try {
      const body = `export default async function run(input) {
        const seen = [];
        for (let i = 0; i < 3; i++) {
          try { const r = await fetch(input.url); seen.push(String(r.status)); }
          catch (e) { seen.push(String(e.message)); }
        }
        return { seen };
      }`;
      const dir = skill(body, 0, { allow: [srv.host], max_requests: 2 });
      const out = (await executeSkillAsync(dir, { url: srv.url }, 30000, {})).output as { seen?: string[] };
      expect(out.seen?.[0]).toBe("200");
      expect(String(out.seen?.[2])).toContain("max_requests=2");
    } finally {
      srv.close();
    }
  });

  // One law per reader: a law that only exercises text() passes while the bound leaks through
  // blob() or body, which is exactly how three of six readers went unwrapped.
  for (const reader of ["blob", "bytes", "arrayBuffer", "text"]) {
    it(`refuses a body larger than max_bytes via ${reader}()`, async () => {
      const srv = await localServer(64);
      try {
        const body = `export default async function run(input) {
          const r = await fetch(input.url);
          try { const v = await r.${reader}(); return { got: v?.size ?? v?.byteLength ?? v?.length ?? 0 }; }
          catch (e) { return { error: String(e.message) }; }
        }`;
        const out = (await executeSkillAsync(skill(body, 0, { allow: [srv.host], max_bytes: 10 }), { url: srv.url }, 30000, {}))
          .output as { error?: string; got?: number };
        expect(out.got).toBeUndefined();
        expect(String(out.error)).toContain("max_bytes=10");
      } finally {
        srv.close();
      }
    });
  }

  it("counts res.body as the stream flows and refuses past max_bytes", async () => {
    const srv = await localServer(64);
    try {
      const body = `export default async function run(input) {
        const r = await fetch(input.url);
        try {
          let n = 0;
          for await (const chunk of r.body) n += chunk.byteLength;
          return { got: n };
        } catch (e) { return { error: String(e.message) }; }
      }`;
      const out = (await executeSkillAsync(skill(body, 0, { allow: [srv.host], max_bytes: 10 }), { url: srv.url }, 30000, {}))
        .output as { error?: string; got?: number };
      expect(out.got).toBeUndefined();
      expect(String(out.error)).toContain("max_bytes=10");
    } finally {
      srv.close();
    }
  });

  it("denies fetch to a skill with no grant — on a runtime that has the gate", async () => {
    // The gate is Node's, not ours: --allow-net exists from Node 24. On an older runtime there is no
    // network permission at all, so an ungranted skill reaches the network and this law says so
    // rather than asserting a denial the runtime cannot make. That is the same fact the loader acts
    // on when it refuses to admit a skill whose grant such a runtime cannot back.
    const srv = await localServer();
    try {
      const out = (await executeSkillAsync(skill(FETCH, 0), { url: srv.url }, 30000, {})).output as { status?: number; error?: string };
      if (nodeMajor() >= 24) {
        expect(out.status).toBeUndefined();
        expect(String(out.error)).toMatch(/fetch failed|ERR_ACCESS_DENIED/);
      } else {
        expect(out.status).toBe(200); // documented: this runtime cannot deny it
      }
    } finally {
      srv.close();
    }
  });
});

// ── the runtime floor ───────────────────────────────────────────────────────
// CI found this on the first run it was allowed to execute: `package.json` declared
// `engines: {"node": ">=20"}` and the matrix tested Node 20, but the sandbox spawns with
// `--permission`, which is Node 22+. Every code-bearing skill died with
// `node: bad option: --permission` — 18 test files on that leg alone.
//
// It could not surface locally: this machine is Node 24. A green local band cannot rule out a
// claim about a runtime it never runs on, which is the whole argument for the matrix.
import { MIN_NODE_FOR_SANDBOX } from "../src/skill_subprocess.js";
import { readFileSync as readPkg } from "node:fs";

describe("the sandbox states the runtime it needs", () => {
  it("declares an engines floor matching the flag it actually spawns with", () => {
    const pkg = JSON.parse(readPkg(new URL("../package.json", import.meta.url), "utf-8")) as
      { engines?: { node?: string } };
    const declared = pkg.engines?.node ?? "";
    const floor = Number(declared.replace(/[^\d]/g, "").slice(0, 2));
    expect(
      floor,
      "engines must not promise a Node the sandbox cannot run on — --permission is 22+",
    ).toBeGreaterThanOrEqual(MIN_NODE_FOR_SANDBOX);
  });

  it("refuses on an older runtime instead of running skills unsandboxed", () => {
    // The failure mode being prevented is not the error message. It is the alternative: a
    // runtime with no permission model executing skill code with none, silently.
    expect(MIN_NODE_FOR_SANDBOX).toBe(22);
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(MIN_NODE_FOR_SANDBOX);
  });
});
