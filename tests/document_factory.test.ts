// O19 — Document Factory: the 5-layer contract. Deterministic structure + bounded
// inference. The counter-claim that matters: a slot with NO fact is DROPPED (never
// filled with invented content), the inference contract REJECTS a non-conforming
// response (retry once, then fail loud), and no inference call sees the whole
// document except the final coherence pass. Inferer is mocked → deterministic
// test, no key.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  selectSkeleton, bindSlots, composePhrasings, smoothCoherence, render, runFactory,
  runInference, checkShape, FactoryError,
  buildInfererPrompt, makeClaudeInferer, loadSchemaPack,
  type IntentProfile, type Inferer, type InferenceRequest,
} from "../src/document_factory.js";

const intent: IntentProfile = {
  doc_type: "internal_update",
  classification: "internal",
  supplied_context: {
    summary: ["shipped the doc factory", "5 layers, 2 inference"],
    what_we_built: ["deterministic skeleton", "narrative-kill rule"],
    where_it_is: ["green, tested"],
    next: ["wire to genome"],
    // open_decisions intentionally absent → must be DROPPED
  },
};

// deterministic mock inferer: composes a slot from its facts; smooths by joining.
const mock: Inferer = (req) => {
  if ("facts" in req.dataset) return { text: (req.dataset["facts"] as string[]).join("; ") };
  if ("ordered_phrasings" in req.dataset) return { text: String(req.dataset["ordered_phrasings"]) + " [smoothed]" };
  return { text: "" };
};

describe("Document Factory: deterministic layers", () => {
  it("L0→1 selects a skeleton from the schema pack (deterministic)", () => {
    const sk = selectSkeleton(intent);
    expect(sk.sections[0]).toBe("summary");
    expect(sk.sections).toContain("open_decisions");
  });
  it("L1→2 narrative-kill: a section with NO facts is dropped, not filled", () => {
    const slots = bindSlots(selectSkeleton(intent), intent);
    const ids = slots.map((s) => s.id);
    expect(ids).not.toContain("open_decisions"); // had no facts → dropped
    expect(ids).toContain("summary");
    expect(slots.length).toBe(4); // 5 sections, 1 dropped
  });
  it("L4→5 renders audience-branded (internal dry, external branded)", () => {
    expect(render({ audience: "internal", doc_type: "x", body: "b" })).toContain("(internal)");
    expect(render({ audience: "external", doc_type: "x", body: "b" })).toContain("Eir Is Real");
  });
});

describe("Document Factory: the inference contract", () => {
  it("composes each slot from its facts ALONE (independence)", () => {
    const slots = bindSlots(selectSkeleton(intent), intent);
    let sawWholeDoc = false;
    const spy: Inferer = (req) => {
      // the model must only ever see one slot's facts, never sibling slots / the doc
      if ("ordered_phrasings" in req.dataset || Object.keys(req.dataset).length > 1) sawWholeDoc = true;
      return mock(req);
    };
    const phrasings = composePhrasings(slots, spy);
    expect(phrasings.length).toBe(4);
    expect(sawWholeDoc).toBe(false); // each compose call saw only {facts}
    expect(phrasings[0]!.text).toBe("shipped the doc factory; 5 layers, 2 inference");
  });
  it("rejects a non-conforming response, retries once, then succeeds", () => {
    let n = 0;
    const flaky: Inferer = () => (++n === 1 ? { wrong: "field" } : { text: "ok" });
    const req: InferenceRequest = { dataset: { facts: ["a"] }, instruction: "x", response_type: { fields: { text: "string" } }, constraints: [] };
    expect(runInference(req, flaky)).toEqual({ text: "ok" });
    expect(n).toBe(2); // failed once, retried, passed
  });
  it("fails loud when the response violates the contract twice (no silent pass)", () => {
    const broken: Inferer = () => ({ nope: 1 });
    const req: InferenceRequest = { dataset: { facts: ["a"] }, instruction: "x", response_type: { fields: { text: "string" } }, constraints: [] };
    expect(() => runInference(req, broken)).toThrow(FactoryError);
  });
  it("checkShape enforces field presence, type, and maxLength", () => {
    expect(checkShape({ text: "hi" }, { fields: { text: "string" } })).toBeNull();
    expect(checkShape({}, { fields: { text: "string" } })).toMatch(/missing/);
    expect(checkShape({ text: "toolong" }, { fields: { text: "string" }, maxLength: { text: 3 } })).toMatch(/maxLength/);
  });
});

describe("Document Factory: end-to-end (intent → artifact)", () => {
  it("runs all 5 layers and records the dropped slot", () => {
    const r = runFactory(intent, mock);
    expect(r.dropped).toEqual(["open_decisions"]); // narrative-kill record
    expect(r.phrasings.length).toBe(4);
    expect(r.artifact).toContain("# internal_update (internal)");
    expect(r.artifact).toContain("[smoothed]"); // coherence pass ran
    expect(r.artifact).toContain("shipped the doc factory");
  });
  it("only ONE inference call (coherence) ever sees more than one slot", () => {
    let multiSlotCalls = 0;
    const counter: Inferer = (req) => { if ("ordered_phrasings" in req.dataset) multiSlotCalls++; return mock(req); };
    runFactory(intent, counter);
    expect(multiSlotCalls).toBe(1); // exactly the 3→4 coherence beat
  });
});

describe("Document Factory: the real claude inferer (seam)", () => {
  const req: InferenceRequest = {
    dataset: { facts: ["shipped it", "green"] },
    instruction: "Compose this section from its facts alone.",
    response_type: { fields: { text: "string" }, maxLength: { text: 400 } },
    constraints: ["Use only the facts.", "No hedging."],
  };

  it("buildInfererPrompt is pure: dataset, every constraint, and the field contract", () => {
    const p = buildInfererPrompt(req);
    expect(p).toBe(buildInfererPrompt(req)); // deterministic
    expect(p).toContain("shipped it"); // the only material
    expect(p).toContain("Use only the facts."); // hard constraint carried
    expect(p).toContain("No hedging.");
    expect(p).toContain('"text": string (max 400 characters)'); // exact response contract
    expect(p).toContain("single JSON object");
  });

  it("makeClaudeInferer builds the prompt, runs the seam, parses JSON (fence-tolerant)", () => {
    let sawPrompt = "";
    const fakeRun = (_bin: string, args: string[]) => {
      sawPrompt = args[1]!; // ["-p", prompt]
      return "here you go:\n```json\n{\"text\": \"shipped it, green\"}\n```"; // fenced + prose
    };
    const infer = makeClaudeInferer({ run: fakeRun });
    expect(infer(req)).toEqual({ text: "shipped it, green" });
    expect(sawPrompt).toContain("shipped it"); // the request actually reached the seam
  });

  it("plugs into runInference: a conforming claude response passes the contract", () => {
    const infer = makeClaudeInferer({ run: () => '{"text": "ok"}' });
    expect(runInference(req, infer)).toEqual({ text: "ok" });
  });
});

describe("Document Factory: schema-pack as genome data", () => {
  const packPath = join(__dirname, "..", "eir_document_schemas.json");

  it("loadSchemaPack reads the genome file and honors per-section density targets", () => {
    const pack = loadSchemaPack(packPath);
    expect(pack["internal_update"]!.sections[0]).toBe("summary");
    expect(pack["grant_update"]).toBeDefined(); // a doc_type only the genome file knows
    const sk = selectSkeleton({ doc_type: "internal_update", classification: "internal", supplied_context: {} }, pack);
    expect(sk.density_targets["what_we_built"]).toBe(700); // from the file, not the 600 default
  });

  it("the loaded genome pack drives a full factory run (genome → artifact)", () => {
    const pack = loadSchemaPack(packPath);
    const r = runFactory(intent, mock, pack);
    expect(r.dropped).toEqual(["open_decisions"]); // narrative-kill still holds under genome pack
    expect(r.phrasings.length).toBe(4);
  });

  it("fails loud on a malformed pack (no silent degrade to the bootstrap default)", () => {
    expect(() => loadSchemaPack(join(__dirname, "fixtures", "does_not_exist.json"))).toThrow();
  });
});
