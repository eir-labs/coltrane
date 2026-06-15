// A skill-backed chair may seal a DOMAIN type (not just a bare core type). The runtime must
// resolve that domain type's core via the registry (coreTypeOf), the same way an agent chair
// does — otherwise a verdict-shaped skill output gets mislabeled core_type "Signal"/primitive
// "SENSE". This is the substrate fix that lets verdict-gate seal a real triage-verdict (Verdict).
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  composeStandard,
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type Chair,
  type PhaseDef,
  type DomainType,
  type AgentInvoker,
} from "../src";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERDICT_GATE = join(REPO_ROOT, "skills/verdict-gate");

const skillChair = (role: string, skill_slug: string, opts: Partial<Chair> = {}): Chair => ({
  role, agent_slug: "", skill_slug,
  depends_on: opts.depends_on ?? [],
  input_contract: opts.input_contract ?? [],
  output_contract: opts.output_contract ?? ["Signal"],
  required_skills: [],
});

describe("a skill-backed chair sealing a domain type resolves its core via the registry", () => {
  it("verdict-gate sealing triage-verdict gets core_type Verdict (not Signal)", async () => {
    const registry = createRegistry();
    const tv: DomainType = {
      slug: "triage-verdict", extends: "Verdict", domain: "patent-triage",
      schema: { properties: { recommended: { type: "string" }, rationale: { type: "string" }, gated: { type: "boolean" }, gate_reasons: { type: "array" }, original_recommended: { type: "string" }, has_patent_coverage: { type: "boolean" }, survival_count: { type: "number" } } },
      required_fields: ["recommended", "rationale"],
    };
    registry.registerType(tv);
    const outputs = createOutputStore(registry);

    const std = composeStandard({
      slug: "gate-only", domain: "patent-triage", agents: [],
      phases: [{ name: "gate", chairs: [skillChair("gate", "verdict-gate", { output_contract: ["triage-verdict"] })] } as PhaseDef],
    });

    const invoke: AgentInvoker = () => ({});
    const res = await runGig(
      std,
      { recommended: "FILEABLE", corpora_searched: ["literature"], survival_count: 2 },
      { outputs, ledger: new MemoryLedger(), invoke, skill_dirs: new Map([["verdict-gate", VERDICT_GATE]]) },
    );

    expect(res.status).toBe("complete");
    const verdict = res.outputs.find((o) => o.domain_type === "triage-verdict");
    expect(verdict, "gate must seal a triage-verdict").toBeTruthy();
    expect(verdict!.core_type).toBe("Verdict");
    expect(verdict!.primitive).toBe("VERIFY");
    // and it actually GATED: FILEABLE without a patent corpus → INSUFFICIENT-EVIDENCE
    expect(verdict!.data["recommended"]).toBe("INSUFFICIENT-EVIDENCE");
    expect(verdict!.data["rationale"], "the sealed verdict must carry a rationale").toBeTruthy();
  });
});
