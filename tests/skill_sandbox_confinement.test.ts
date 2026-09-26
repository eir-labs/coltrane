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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSkill, tierFlags } from "../src/skill_subprocess.js";

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

describe("the network grant decides the flag", () => {
  // These two touch no network and belong in the unit band: they read the flag string tierFlags
  // builds, nothing more. The laws that need a real request — host allowlist, methods, the request
  // and byte ceilings, the stream counter, and the ungranted denial — live in tests/security, where
  // a band may reach out; the root suite may not (suite_reaches_no_remote).
  it("passes no --allow-net when the skill declares no network grant", () => {
    expect(tierFlags(0).join(" ")).not.toContain("--allow-net");
    expect(tierFlags(2).join(" ")).not.toContain("--allow-net"); // not a tier — a declaration
  });

  it("passes --allow-net when the skill declares a grant — and only where the flag exists", () => {
    // Asserted BOTH ways so the law is falsifiable on either runtime. Below Node 24 the flag does
    // not exist and passing it kills the child before it starts, so its ABSENCE is the correct
    // behaviour there and this law says so rather than going quiet.
    const flags = tierFlags(0, undefined, { allow: ["example.com"] }).join(" ");
    if (nodeMajor() >= 24) expect(flags).toContain("--allow-net");
    else expect(flags).not.toContain("--allow-net");
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
    expect(MIN_NODE_FOR_SANDBOX).toBe(24);
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(MIN_NODE_FOR_SANDBOX);
  });
});

// THE FLOOR BACKS EVERY GRANT, AND EVERYTHING WE RUN MEETS THE FLOOR (26 Sep 2026).
// The floor was 22 because Node 20 lacked --permission — a reactive minimum, never a chosen
// target. Network grants need --allow-net, which is 24+ (NODE_WITH_ALLOW_NET), so on 22 the
// hosted floor/room images could not run a fetching skill (#545's landscape-evidence-check) at
// all. The sovereign ruled the floor up to 24 (current LTS). These two laws keep the declared
// floor, the CI runtimes and the container images from drifting apart again.
import { NODE_WITH_ALLOW_NET } from "../src/skill_subprocess.js";
import { readdirSync as readDirPins } from "node:fs";

describe("the declared Node floor backs every grant, and every runtime we pin meets it", () => {
  const engines = (JSON.parse(readPkg(new URL("../package.json", import.meta.url), "utf-8")) as
    { engines?: { node?: string } }).engines?.node ?? "";
  const floor = Number((engines.match(/\d+/) ?? ["0"])[0]);

  it("engines.node is at least the runtime that can back a network grant", () => {
    expect(floor, `engines says ${engines}; a network grant needs Node ${NODE_WITH_ALLOW_NET}+`)
      .toBeGreaterThanOrEqual(NODE_WITH_ALLOW_NET);
  });

  it("every CI workflow and container image pins a Node at or above the floor", () => {
    const root = new URL("..", import.meta.url);
    const pins: Array<[string, number]> = [];
    const wf = new URL(".github/workflows/", root);
    for (const f of readDirPins(wf)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const text = readPkg(new URL(f, wf), "utf-8");
      for (const m of text.matchAll(/node-version:\s*"?(\d+)/g)) pins.push([f, Number(m[1])]);
      for (const m of text.matchAll(/node:\s*\[([^\]]*)\]/g))
        for (const v of (m[1] ?? "").matchAll(/(\d+)/g)) pins.push([`${f} matrix`, Number(v[1])]);
    }
    for (const f of ["Dockerfile.floor", "Dockerfile.room"]) {
      const text = readPkg(new URL(f, root), "utf-8");
      for (const m of text.matchAll(/FROM\s+node:(\d+)/g)) pins.push([f, Number(m[1])]);
    }
    expect(pins.length, "found no Node pins — the walk is broken, not the fleet green").toBeGreaterThan(0);
    const below = pins.filter(([, v]) => v < floor);
    expect(below, `runtimes below the declared floor ${floor}`).toEqual([]);
  });
});
