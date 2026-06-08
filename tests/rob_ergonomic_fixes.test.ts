// Rob's three independent ergonomic fixes — #131, #133, #132.
//
// Three separate verify-gates in one file. Each test mirrors its issue body's
// example: the exact shape Rob's client sent that the server should now accept.
//
// Pre-reg
// =======
// #131 — type_register normalizes schema-without-properties wrapper
// #133 — output_write accepts no domain_type
// #132 — standard_compose resolves agent slugs from the genome
// test:    this file
// apoha:   NOT removing strictness on the well-formed path; only widening the
//          accepted input shapes that Rob hit when his client sent the obvious
//          (but unwrapped) form.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapServerDeps, dispatchTool, type ServerDeps } from "../src/server.js";

const REQUIRED_CORE_TYPES = [
  { slug: "Signal", primitive: "SENSE", description: "", schema: {} },
  { slug: "Interpretation", primitive: "INTERPRET", description: "", schema: {} },
  { slug: "Judgment", primitive: "JUDGE", description: "", schema: {} },
  { slug: "Plan", primitive: "PLAN", description: "", schema: {} },
  { slug: "Artifact", primitive: "CREATE", description: "", schema: {} },
  { slug: "Verdict", primitive: "VERIFY", description: "", schema: {} },
];

function writeJson(dir: string, name: string, body: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
}

function seedCoreTypes(root: string): void {
  for (const c of REQUIRED_CORE_TYPES) writeJson(join(root, "core_types"), `${c.slug}.json`, c);
}

describe("Rob #131 — type_register normalizes schema-without-properties wrapper", () => {
  let root: string;
  let deps: ServerDeps;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coltrane-fix131-"));
    seedCoreTypes(root);
    deps = bootstrapServerDeps(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("schema passed as {field: {type: ...}} is accepted and validates correctly", async () => {
    // The shape Rob sent (no .properties wrapper):
    await dispatchTool("type_register", {
      slug: "claim",
      extends: "Interpretation",
      domain: "scam-shield",
      schema: { title: { type: "string" }, count: { type: "integer" } },
      required_fields: ["title"],
    }, deps);

    // Validating data with the expected fields passes — proving the wrapper
    // got normalized (without normalization, every field would be rejected as
    // additionalProperties).
    const v = deps.registry.validate({
      core_type: "Interpretation",
      domain_type: "claim",
      data: { title: "elder phishing call", count: 3 },
    });
    expect(v.valid).toBe(true);
  });

  it("schema already wrapped in .properties is passed through unchanged", async () => {
    await dispatchTool("type_register", {
      slug: "claim",
      extends: "Interpretation",
      domain: "scam-shield",
      schema: { type: "object", properties: { title: { type: "string" } } },
      required_fields: ["title"],
    }, deps);
    const v = deps.registry.validate({
      core_type: "Interpretation",
      domain_type: "claim",
      data: { title: "hi" },
    });
    expect(v.valid).toBe(true);
  });
});

describe("Rob #133 — output_write accepts no domain_type (freeform output)", () => {
  let root: string;
  let deps: ServerDeps;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coltrane-fix133-"));
    seedCoreTypes(root);
    deps = bootstrapServerDeps(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("output_write with no domain_type writes a freeform output keyed on core_type only", async () => {
    const res = await dispatchTool("output_write", {
      core_type: "Interpretation",
      gig_id: "rob-test",
      agent_slug: "discover-phase",
      data: { theme: "elder-scam-domain-modeling", raw_notes: "..." },
    }, deps);

    expect(res.ok).toBe(true);
    const data = res.data as { output_id: string; output: { domain_type: string; core_type: string } };
    expect(data.output.core_type).toBe("Interpretation");
    // domain_type may be "" — the freeform marker. Either "" or absent is acceptable.
    expect(data.output.domain_type ?? "").toBe("");
  });

  it("output_write with a domain_type still enforces domain-schema validation", async () => {
    await dispatchTool("type_register", {
      slug: "strict-thing",
      extends: "Interpretation",
      domain: "demo",
      schema: { properties: { required_field: { type: "string" } } },
      required_fields: ["required_field"],
    }, deps);

    // Missing required field — should still reject (either throw OR return ok=false)
    let rejected = false;
    try {
      const res = await dispatchTool("output_write", {
        core_type: "Interpretation",
        domain_type: "strict-thing",
        gig_id: "rob-test-strict",
        agent_slug: "discover-phase",
        data: { unrelated: "value" },
      }, deps);
      // If it didn't throw, ok=false counts as a rejection
      if (!res.ok) rejected = true;
    } catch (e) {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

describe("Rob #132 — standard_compose resolves agent slugs from the genome", () => {
  let root: string;
  let deps: ServerDeps;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coltrane-fix132-"));
    seedCoreTypes(root);
    writeJson(join(root, "agents"), "scout.json", {
      slug: "scout",
      primitives: ["SENSE"],
      output_types: ["raw-note"],
      domain: "demo",
    });
    writeJson(join(root, "agents"), "summarizer.json", {
      slug: "summarizer",
      primitives: ["INTERPRET"],
      input_types: ["raw-note"],
      output_types: ["summary"],
      domain: "demo",
    });
    deps = bootstrapServerDeps(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("standard_compose accepts agents passed as string slugs and resolves from genome", async () => {
    const res = await dispatchTool("standard_compose", {
      slug: "summarize-from-slugs",
      domain: "demo",
      agents: ["scout", "summarizer"], // plain strings, NOT full Agent objects
      phases: [
        { name: "sense", chairs: [{ role: "sense", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] },
        { name: "interpret", chairs: [{ role: "interpret", agent_slug: "summarizer", depends_on: [], input_contract: [], output_contract: ["summary"], required_skills: [] }] },
      ],
    }, deps);

    expect(res.ok).toBe(true);
    expect(deps.standards?.has("summarize-from-slugs")).toBe(true);
  });

  it("standard_compose still accepts full Agent objects (back-compat)", async () => {
    const res = await dispatchTool("standard_compose", {
      slug: "summarize-from-objects",
      domain: "demo",
      agents: [
        { slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["raw-note"], domain: "demo" },
      ],
      phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] }],
    }, deps);

    expect(res.ok).toBe(true);
    expect(deps.standards?.has("summarize-from-objects")).toBe(true);
  });

  it("standard_compose rejects a slug not present in the genome", async () => {
    const res = await dispatchTool("standard_compose", {
      slug: "with-ghost",
      domain: "demo",
      agents: ["ghost-agent"],
      phases: [{ name: "x", chairs: [{ role: "x", agent_slug: "ghost-agent", depends_on: [], input_contract: [], output_contract: ["Interpretation"], required_skills: [] }] }],
    }, deps);

    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/ghost-agent|not found/);
  });
});
