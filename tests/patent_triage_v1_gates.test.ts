// GATES — the negative form (must-fire). The load-bearing half of the v1 spec: the positive
// contracts ("FILEABLE requires X") pass against an implementation that silently never gates;
// these assert the gate actually BITES. The verdict-gate skill is the construction-time hard
// guard the triage-judge builds its verdict through, so it's directly + deterministically
// testable here — no live model needed.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeSkill } from "../src/skill_subprocess.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const VERDICT_GATE = join(REPO, "skills", "verdict-gate");
const gate = (input: Record<string, unknown>) => {
  const r = executeSkill(VERDICT_GATE, input);
  if (!r.ok) throw new Error(`verdict-gate failed: ${r.error}`);
  return r.output as { recommended: string; gated: boolean; gate_reasons: string[] };
};

describe("patent-triage v1 gates — must-fire (the half that bites a broken impl)", () => {
  it("coverage gate: FILEABLE with NO patent corpus searched is forced to INSUFFICIENT-EVIDENCE", () => {
    const out = gate({ recommended: "FILEABLE", corpora_searched: ["literature", "blogs"], survival_count: 2 });
    expect(out.recommended).toBe("INSUFFICIENT-EVIDENCE");
    expect(out.gated).toBe(true);
    expect(out.gate_reasons.join(" ")).toMatch(/coverage/i);
  });

  it("survival gate: FILEABLE with survival_count 0 is forced to INSUFFICIENT-EVIDENCE", () => {
    const out = gate({ recommended: "FILEABLE", corpora_searched: ["USPTO PatentsView"], survival_count: 0 });
    expect(out.recommended).toBe("INSUFFICIENT-EVIDENCE");
    expect(out.gated).toBe(true);
    expect(out.gate_reasons.join(" ")).toMatch(/survival/i);
  });

  it("FILEABLE is emittable ONLY with patent coverage AND a survived round", () => {
    const out = gate({ recommended: "FILEABLE", corpora_searched: ["USPTO PatentsView", "literature"], survival_count: 1 });
    expect(out.recommended).toBe("FILEABLE");
    expect(out.gated).toBe(false);
  });

  it("non-FILEABLE verdicts pass through the gate unchanged", () => {
    for (const rec of ["REFINE-FIRST", "NOT-FILEABLE", "INSUFFICIENT-EVIDENCE"]) {
      const out = gate({ recommended: rec, corpora_searched: [], survival_count: 0 });
      expect(out.recommended).toBe(rec);
      expect(out.gated).toBe(false);
    }
  });

  it("the gate cannot be bypassed by claiming coverage without a patent corpus", () => {
    // literature-only coverage is not patent coverage — the v0 failure, now structurally blocked
    const out = gate({ recommended: "FILEABLE", corpora_searched: ["arxiv", "google-scholar"], survival_count: 5 });
    expect(out.recommended).toBe("INSUFFICIENT-EVIDENCE");
  });
});
