// RED-first contract tests — skills as first-class, GRACEFUL DEGRADATION
// (docs/skills-as-first-class.md, "Graceful degradation"). The code half is an
// optimization, not a dependency: every code failure mode degrades to pure-reasoning,
// the model resolves the whole output, and the gig never dies. Degradation is never
// silent — the reason is surfaced (and logged).
//
//   code_hash mismatch  -> don't run unverified code; model handles everything
//   run() throws        -> code resolved nothing; model handles everything
//   code file missing   -> pure-reasoning mode
//   (run() returns invalid output -> rejected as null; covered in residual/validation)
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { resolveSkill, loadSkillPackage, skillChainEvents, type ResidualInvoker } from "../src/skills.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const F = (slug: string) => join(REPO_ROOT, "tests/_skill_fixtures", slug);
const fillLabel: ResidualInvoker = () => ({ label: "resolved-by-model" });

describe("graceful degradation — code is an optimization, not a dependency", () => {
  it("code_hash mismatch: the unverified code is NOT run; the model resolves everything", async () => {
    const r = await resolveSkill(F("bad-hash"), { text: "hi" }, () => ({ echo: "from-model" }));
    expect(r.degraded?.reason ?? "").toMatch(/hash|mismatch|unverified/i);
    expect(r.field_origins.echo).toBe("model");
    expect(r.output.echo).toBe("from-model");
  });

  it("run() throws: code resolved nothing, the model fills the whole schema, gig survives", async () => {
    const r = await resolveSkill(F("thrower"), { text: "hi" }, fillLabel);
    expect(r.degraded?.reason ?? "").toMatch(/throw|error|boom/i);
    expect(r.residual).toEqual(["label"]);
    expect(r.field_origins).toEqual({ label: "model" });
    expect(r.output).toEqual({ label: "resolved-by-model" });
  });

  it("missing code file is degradation, not a load error — the package still loads", () => {
    const pkg = loadSkillPackage(F("no-code"));
    expect(pkg.codeHash).toBeNull();
    expect(pkg.mdPath).toBe(join(F("no-code"), "skill.md"));
  });

  it("a package with no code half resolves the whole schema via the model", async () => {
    const r = await resolveSkill(F("no-code"), { text: "hi" }, fillLabel);
    expect(r.degraded?.reason ?? "").toMatch(/no code|missing|pure.?reason/i);
    expect(r.field_origins).toEqual({ label: "model" });
    expect(r.output).toEqual({ label: "resolved-by-model" });
  });

  it("degradation never throws — resolveSkill always returns a usable result", async () => {
    await expect(resolveSkill(F("thrower"), { text: "hi" }, fillLabel)).resolves.toBeTruthy();
  });

  it("records WHY it degraded on the chain event — audit-replay reads the reason, not just field_origins", async () => {
    // the reason lives on the ResolutionResult AND on the sealed event, so a replay of
    // "why did this skill degrade across N runs" reads from the durable chain.
    const chainDir = mkdtempSync(join(tmpdir(), "coltrane-chain-"));
    const r = await resolveSkill(F("thrower"), { text: "hi" }, fillLabel, { chainDir });
    const events = skillChainEvents("thrower", undefined, { chainDir });
    expect(events.length).toBe(1);
    expect(events[0]!.degraded_reason ?? "", "degraded reason was not sealed on the event").toMatch(/throw|error|boom/i);
    expect(events[0]!.degraded_reason).toBe(r.degraded?.reason);
  });
});
