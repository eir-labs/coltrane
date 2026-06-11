// The skill cage matrix — tier x capability as real subprocess enforcement. Each cell runs
// a capability PROBE skill at a given permission tier and asserts allow/deny from the
// derivation rule `tier >= threshold(capability)`. The cage itself is implemented
// (tierFlags + the Node --permission subprocess), so this matrix is GREEN: it proves the
// enforcement combinatorially and supersedes the hand-written cage cases in
// skill_execution.test.ts. Same shape as the agent code_tool_access ladder — permission
// enforcement is one cross-cutting concern (agents bring code_tool_access, skills bring tiers).
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { executeSkill } from "../src/skill_subprocess.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const probeDir = (slug: string): string => join(REPO, "tests/_skill_fixtures", slug);
const scratch = mkdtempSync(join(tmpdir(), "coltrane-cage-"));
const readable = join(scratch, "readable.txt");
writeFileSync(readable, "hello");

// capability → the probe that attempts it + the tier at/above which it's granted
const CAPABILITIES = [
  { name: "fs-read", probe: "probe-fs-read", threshold: 0 },
  { name: "fs-write", probe: "probe-fs-write", threshold: 1 },
  { name: "child-process", probe: "probe-child", threshold: 2 },
] as const;
const TIERS = [0, 1, 2] as const;

const inputFor = (cap: string, tier: number): Record<string, unknown> =>
  cap === "fs-read" ? { path: readable } : cap === "fs-write" ? { path: join(scratch, `w-${cap}-${tier}.txt`) } : {};

const cells = CAPABILITIES.flatMap((c) =>
  TIERS.map((t) => ({ id: `${c.name} @ tier ${t} → ${t >= c.threshold ? "ALLOW" : "DENY"}`, cap: c, tier: t, allowed: t >= c.threshold })),
);

describe("skill cage matrix: tier x capability is real enforcement", () => {
  it.each(cells)("$id", ({ cap, tier, allowed }) => {
    const r = executeSkill(probeDir(cap.probe), inputFor(cap.name, tier), 8000, tier);
    expect(r.ok, r.error).toBe(allowed);
  });
});

describe("skill cage: the denial ladder is monotone (a higher tier never revokes a lower one's grant)", () => {
  it.each(CAPABILITIES)("$name stays allowed once its threshold is crossed", (cap) => {
    for (const t of TIERS) {
      if (t < cap.threshold) continue;
      const r = executeSkill(probeDir(cap.probe), inputFor(cap.name, t), 8000, t);
      expect(r.ok, `${cap.name} denied at tier ${t} (>= threshold ${cap.threshold})`).toBe(true);
    }
  });
});
