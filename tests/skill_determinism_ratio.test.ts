// RED-first contract tests — skills as first-class, determinism_ratio is COMPUTED,
// not declared (docs/skills-as-first-class.md, "The determinism gradient", Phase 3).
// Every resolution appends a record of which output fields the code resolved vs the
// model. determinism_ratio is the rolling average of the code-resolved fraction across
// recent records — it reflects ACTUAL behavior, so a skill cannot lie about how
// deterministic it is by editing a number in meta.json.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  resolveSkill,
  skillChainEvents,
  computeDeterminismRatio,
  type ResidualInvoker,
} from "../src/skills.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DUAL_EXTRACT = join(REPO_ROOT, "tests/_skill_fixtures/dual-extract");
const NUMBER_ADDER = join(REPO_ROOT, "skills/number-adder");
const sentiment: ResidualInvoker = () => ({ sentiment: "positive" });

describe("determinism_ratio is computed from the recorded log, not declared", () => {
  it("a half-code skill scores ~0.5 — one of two output fields is code-resolved", async () => {
    const chainDir = mkdtempSync(join(tmpdir(), "coltrane-skilllog-"));
    for (let i = 0; i < 3; i++) {
      await resolveSkill(DUAL_EXTRACT, { text: "good day" }, sentiment, { chainDir });
    }
    const report = computeDeterminismRatio("dual-extract", 1, { chainDir, window: 10 });
    expect(report.ratio).toBeCloseTo(0.5, 5);
    expect(report.samples).toBe(3);
  });

  it("a pure-code skill scores 1.0", async () => {
    const chainDir = mkdtempSync(join(tmpdir(), "coltrane-skilllog-"));
    await resolveSkill(NUMBER_ADDER, { a: 1, b: 2 }, () => ({}), { chainDir });
    await resolveSkill(NUMBER_ADDER, { a: 4, b: 5 }, () => ({}), { chainDir });
    const report = computeDeterminismRatio("number-adder", 1, { chainDir });
    expect(report.ratio).toBe(1.0);
  });

  it("each resolution appends a record carrying the skill code_hash and per-field origins", async () => {
    const chainDir = mkdtempSync(join(tmpdir(), "coltrane-skilllog-"));
    await resolveSkill(DUAL_EXTRACT, { text: "a" }, sentiment, { chainDir });
    await resolveSkill(DUAL_EXTRACT, { text: "bb" }, sentiment, { chainDir });

    const events = skillChainEvents("dual-extract", 1, { chainDir });
    expect(events.length).toBe(2);
    expect(events[0]!.code_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(events[0]!.field_origins).toEqual({ char_count: "code", sentiment: "model" });
  });
});
