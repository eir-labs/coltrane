// RR-3 — drafting:the-graded-spec-travels-with-the-request (wiki spec.coltrane.the-red-pass-runs-in-its-room rev 2).
//
// The first charter red pass (gig 3243a92c) sealed `unsatisfiable-inputs` every round, correctly: the change-request carried
// the graded spec's slug and hash, and the text it graded lives somewhere the seat cannot reach. The request now carries the
// graded page as two readable fields, `spec_title` and `spec_body`, and before any seat DS-4 checks that
// sha256(spec_title + "\n" + spec_body), UTF-8, equals the grade's content_hash: the page's own content_sha expression (Vör,
// measured on two controlled probes). The payload is shaped to fit the hash, never the hash to fit the payload.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
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
const SPEC = "spec.example.a-graded-spec";
const TITLE = "A graded spec: one law, its plant and its twin";
const BODY = "# A graded spec\n\n| Id | Law |\n|---|---|\n| X-1 | `example:a-law` — the thing holds — red today because it does not exist |\n\nA line with a trailing space \nand no final newline — an em-dash, `backticks`.";
const pageHash = (title: string, body: string) => createHash("sha256").update(`${title}\n${body}`, "utf8").digest("hex");
const H = pageHash(TITLE, BODY);
const VOR = "principal:vor";
const L = "example:a-law";
const request = (over: Record<string, unknown> = {}) => ({
  source: "eugene", request_text: "Draft the RED law.", acceptance_criteria: ["observed red"], spec: SPEC, content_hash: H,
  spec_grade: "g1", scope: { files: ["crossing/laws.sx"], laws: [L], terms: [] }, baseline_commit: "0".repeat(40), branch: "red/x",
  spec_title: TITLE, spec_body: BODY, ...over,
});
const grades = { conformance_seat: VOR, grades: [{ id: "g1", record: { spec: SPEC, content_hash: H, verdict: "PASS", scope: [L], by: VOR, held_seat: true } }] };

async function drive(req: Record<string, unknown>): Promise<{ seated: boolean; message: string }> {
  const std = (genome.standards.get(SLUG) ?? genome.draft_standards.get(SLUG)) as Standard;
  let seated = false;
  const invoke: AgentInvoker = () => { seated = true; throw new Error("stub invoker: a model seat was invoked"); };
  let message = "";
  try {
    await runGig(std, { "change-request": req }, {
      outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, spec_grades: grades,
      skill_dirs: new Map([["scope-gate", `${ROOT}skills/scope-gate`], ["baseline-gate", `${ROOT}skills/baseline-gate`]]),
    } as never);
  } catch (e) { message = e instanceof Error ? e.message : String(e); }
  return { seated, message };
}

describe("RR-3 — the graded spec travels with the request, bound by the page's own hash", () => {
  it("twin, must be ALLOWED — the graded title and body, whose sha256(title + \"\\n\" + body) is the grade's hash, admit: the draft chair is seated", async () => {
    const d = await drive(request());
    expect(d.seated, `refused: ${d.message}`).toBe(true);
  });

  it("plant — spec_body carried alone, without its title: refused before any seat (the hash cannot match)", async () => {
    const d = await drive(request({ spec_title: undefined }));
    expect(d.seated).toBe(false);
    expect(d.message).toMatch(/spec_title/);
  });

  it("plant — spec_body absent: refused before any seat", async () => {
    const d = await drive(request({ spec_body: undefined }));
    expect(d.seated).toBe(false);
    expect(d.message).toMatch(/spec_body/);
  });

  it("plant — one word of the body changed: refused, naming both hashes", async () => {
    const changed = BODY.replace("holds", "stands");
    const d = await drive(request({ spec_body: changed }));
    expect(d.seated).toBe(false);
    expect(d.message).toContain(H);
    expect(d.message).toContain(pageHash(TITLE, changed));
  });

  it("plant — a trailing newline added to the body: refused (the bytes are the page's, exactly)", async () => {
    const d = await drive(request({ spec_body: `${BODY}\n` }));
    expect(d.seated).toBe(false);
  });

  it("plant — the body hashed alone is NOT the binding: a grade whose hash is sha256(body) does not admit title + body", async () => {
    const bodyOnly = createHash("sha256").update(BODY, "utf8").digest("hex");
    const g = { conformance_seat: VOR, grades: [{ id: "g1", record: { ...grades.grades[0]!.record, content_hash: bodyOnly } }] };
    const std = (genome.standards.get(SLUG) ?? genome.draft_standards.get(SLUG)) as Standard;
    let seated = false;
    try {
      await runGig(std, { "change-request": request({ content_hash: bodyOnly }) }, {
        outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke: () => { seated = true; throw new Error("stub"); }, spec_grades: g,
        skill_dirs: new Map([["scope-gate", `${ROOT}skills/scope-gate`], ["baseline-gate", `${ROOT}skills/baseline-gate`]]),
      } as never);
    } catch { /* refused */ }
    expect(seated, "a body-only hash admitted: the binding is the page's expression, title included").toBe(false);
  });
});
