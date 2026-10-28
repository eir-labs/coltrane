// DS-4, the seat read at the grade's own moment (Vör, grading #598 at fb32460). DS-4 compared each grade's maker with
// the conformance seat's holder NOW, so a seat rotation would void every grade ever recorded, announced as "made by X,
// not the conformance seat Y", which reads as forgery rather than a handover. The store's ask now attests, per grade,
// whether its maker held the seat at the grade's act time (`held_seat`, chancery-os ask_spec_grades); DS-4 admits on
// that attestation and refuses on `false`. A grade carrying no attestation is judged as before, against the current
// holder: never looser.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { runGig, type AgentInvoker } from "../src/runtime.js";
import type { Standard } from "../src/composition.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const genome = loadGenome(ROOT);
const registry = createRegistry([...genome.domain_types.values()] as never);
const SLUG = "chancery-red-drafting-v0";
const SPEC = "eir:spec.chancery.the-testable-charter";
const H = "b".repeat(64);
const VOR = "principal:vor", NEW_HOLDER = "principal:the-next-conformance-seat";
const L = "drafting:scope-is-the-specs";
const request = { source: "eugene", request_text: "Draft the RED laws.", acceptance_criteria: ["each law is observed red"], spec: SPEC, content_hash: H, spec_grade: "g1", scope: { files: ["crossing/laws.sx"], laws: [L], terms: [] }, baseline_commit: "0".repeat(40), branch: "red/x" };
const grade = (over: Record<string, unknown> = {}) => ({ id: "g1", record: { spec: SPEC, content_hash: H, verdict: "PASS", scope: [L], by: VOR, ...over } });

async function drive(spec_grades: unknown): Promise<{ seated: boolean; message: string }> {
  const std = (genome.standards.get(SLUG) ?? genome.draft_standards.get(SLUG)) as Standard;
  let seated = false;
  const invoke: AgentInvoker = () => { seated = true; throw new Error("stub invoker: a model seat was invoked"); };
  let message = "";
  try { await runGig(std, { "change-request": request }, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, skill_dirs: new Map([["scope-gate", `${ROOT}skills/scope-gate`]]), spec_grades } as never); }
  catch (e) { message = e instanceof Error ? e.message : String(e); }
  return { seated, message };
}

describe("DS-4 reads the conformance seat at the grade's own moment", () => {
  it("twin, must be ALLOWED — a grade by the then-holder, read after the seat rotated, still admits (held_seat: true)", async () => {
    const d = await drive({ conformance_seat: NEW_HOLDER, grades: [grade({ held_seat: true })] });
    expect(d.seated, `a grade made by the seat's holder at its moment was refused after a rotation: ${d.message}`).toBe(true);
  });

  it("plant — a grade whose maker did not hold the seat at its moment is refused (held_seat: false), even if that maker holds it now", async () => {
    const d = await drive({ conformance_seat: VOR, grades: [grade({ held_seat: false })] });
    expect(d.seated).toBe(false);
    // Vör: the door already refuses a grade whose maker was not seated at its moment (DS-6, enforced), so on a landed grade
    // held_seat false means the seat's record was amended after the grade: a back-dated or rewritten seat. Say that.
    expect(d.message).toMatch(/the seat's record was amended after the grade/);
  });

  it("control — a grade with no attestation is judged as before, against the current holder", async () => {
    const admitted = await drive({ conformance_seat: VOR, grades: [grade()] });
    expect(admitted.seated, admitted.message).toBe(true);
    const refused = await drive({ conformance_seat: NEW_HOLDER, grades: [grade()] });
    expect(refused.seated).toBe(false);
    expect(refused.message).toMatch(/not the conformance seat/);
  });
});
