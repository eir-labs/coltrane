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
function skill(body: string, tier = 0): string {
  const dir = join(root, `s${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({
    slug: "probe", version: 1, skill_type: "deterministic",
    input_type: "note", output_type: "note",
    permission: { tier }, description: "probe", determinism_ratio: 1,
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

describe("what this sandbox does NOT claim", () => {
  it("states the network gap honestly rather than asserting a guarantee", () => {
    // Node's permission model has no network flag. Until skill execution moves to a runtime
    // that has one, an outbound request from a skill is POSSIBLE, and the source must say so —
    // a comment promising otherwise is the defect this release exists to remove.
    const src = tierFlags(0).join(" ");
    expect(src).not.toContain("--allow-net");
    // The confinement above removes the credential from reach, which is what makes the
    // remaining network capability survivable rather than critical.
  });
});
