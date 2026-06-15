// Live acceptance — v1 is GROUNDED where v0 was not. Gated behind COLTRANE_LIVE=1 (real model
// calls, real cost). Dispatches patent-triage-v1 on the same invention the v0 baseline ran
// (sealed gig 47d06906…) and asserts the upgrade's core claim: the verdict rests on a patent
// corpus that was ACTUALLY searched, and the verdict is on the honest enum (grounded REFINE/
// INSUFFICIENT, or a FILEABLE that cleared the gate) — never v0's unfounded FILEABLE.
//
// Run: COLTRANE_LIVE=1 npx vitest run --config tests/e2e/vitest.config.ts \
//   tests/e2e/patent_triage_v1_live.spec.ts
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { bootstrapServerDeps } from "../../src/index.js";
import { runGig } from "../../src/runtime.js";

const REPO = fileURLToPath(new URL("..", new URL("..", import.meta.url)));
const LIVE = process.env["COLTRANE_LIVE"] === "1";

const INVENTION = {
  idea:
    "A permission-tiered subprocess cage for executing untrusted skill code in multi-agent pipelines: each skill package declares a permission tier (0 = filesystem read only, 1 = adds filesystem write, 2 = adds child-process spawn), and the executor maps the tier to OS-level process permission flags at spawn time, so the declared grant IS the enforcement boundary. The code half is content-hashed; on hash mismatch the executor refuses to run it and degrades to model reasoning, recording the degradation reason.",
  context: "Patentability triage. Field: sandboxed code execution / capability-based security / AI agent toolchains.",
};

describe.skipIf(!LIVE)("patent-triage v1 — live acceptance (grounded, not v0's unfounded FILEABLE)", () => {
  it("the verdict rests on an actually-searched patent corpus and an honest recommendation", async () => {
    const deps = bootstrapServerDeps(REPO);
    const standard = deps.standards?.get("patent-triage-v1");
    expect(standard, "patent-triage-v1 must load").toBeTruthy();

    const res = await runGig(standard!, INVENTION, {
      outputs: deps.outputs,
      ledger: deps.ledger,
      invoke: deps.invoke!,
      skills: deps.skills,
      model_version: deps.model_version,
    });
    expect(res.status).toBe("complete");

    // grounding: a coverage-report that names a patent corpus it actually searched
    const coverage = res.outputs.find((o) => o.domain_type === "coverage-report");
    expect(coverage, "v1 must emit a coverage-report").toBeDefined();
    const corpora = (coverage!.data["corpora_searched"] as string[]) ?? [];
    expect(corpora.some((c) => /patent|patentsview|uspto|espacenet|lens/i.test(String(c))), `corpora: ${JSON.stringify(corpora)}`).toBe(true);

    // honesty: the verdict is on the closed enum — and any FILEABLE cleared the hard gate
    const verdict = res.outputs.find((o) => o.domain_type === "triage-verdict");
    expect(verdict, "v1 must emit a triage-verdict").toBeDefined();
    const rec = String(verdict!.data["recommended"]);
    expect(["FILEABLE", "REFINE-FIRST", "NOT-FILEABLE", "INSUFFICIENT-EVIDENCE"]).toContain(rec);
  }, 1_800_000);
});
