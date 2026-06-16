// The in-process network cage (skill_runner.mjs) — closes the gap that Node's permission model
// leaves open (there is no --allow-net; fetch works at every tier). Before the skill loads, the
// runner replaces fetch/http/https with an allowlist guard driven by meta.permission.network:
// deny-by-default, only allowlisted hosts, only declared methods. Deny cases are deterministic
// (the guard throws before any request leaves), so they're CI-safe; the allow case is COLTRANE_LIVE.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeSkill } from "../src/skill_subprocess.js";

// a skill whose code half tries to fetch and reports whether the cage blocked it.
const FETCH_SKILL = `export default async function run(input){
  try { const r = await fetch(input.url, { method: input.method || "GET" }); return { status: r.status }; }
  catch (e) { return { blocked: true, reason: String(e.message) }; }
}`;

function makeSkill(network: Record<string, unknown> | null) {
  const dir = mkdtempSync(join(tmpdir(), "cage-skill-"));
  const meta = { slug: "fetcher", version: 1, permission: { tier: 0, ...(network ? { network } : {}) } };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  writeFileSync(join(dir, "skill.mjs"), FETCH_SKILL);
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  return dir;
}

describe("skill network cage — deny-by-default, allowlist-scoped", () => {
  it("a skill with NO network grant is denied all egress", () => {
    const r = executeSkill(makeSkill(null), { url: "https://patents.google.com/" });
    expect(r.ok).toBe(true);
    const out = r.output as { blocked?: boolean; reason?: string };
    expect(out.blocked, "no-grant skill must be denied network").toBe(true);
    expect(out.reason).toMatch(/network cage/i);
  });

  it("a grant denies a host outside its allowlist", () => {
    const r = executeSkill(makeSkill({ allow: ["patents.google.com"], methods: ["GET"] }), { url: "https://example.com/" });
    const out = r.output as { blocked?: boolean; reason?: string };
    expect(out.blocked, "off-allowlist host must be blocked").toBe(true);
    expect(out.reason).toMatch(/not in allowlist/i);
  });

  it("a grant denies a method outside its allowlist (read-only GET)", () => {
    const r = executeSkill(makeSkill({ allow: ["patents.google.com"], methods: ["GET"] }), { url: "https://patents.google.com/", method: "POST" });
    const out = r.output as { blocked?: boolean; reason?: string };
    expect(out.blocked, "non-GET must be blocked under a GET-only grant").toBe(true);
    expect(out.reason).toMatch(/method POST not permitted/i);
  });
});
