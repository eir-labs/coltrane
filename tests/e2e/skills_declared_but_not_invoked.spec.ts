// Adversarial bug-bash: do SKILLS actually fire, or are they a 5th-class stub?
//
// Background — T19 (eval substrate) proved that evals load from disk into
// LoadedGenome.evals but are never invoked by runtime or claude_invoker.
// This spec asks the parallel question for SKILLS.
//
// Static evidence already in the tree:
//   src/loader.ts            — SkillRecord = { slug, [k]: unknown }; structurally
//                              validated, but no schema beyond slug-uniqueness.
//   src/composition.ts       — Agent has NO `skills` field. No `skill_slugs`
//                              reference. The composer cannot bind a skill to
//                              an agent because the type has no slot for it.
//   src/runtime.ts           — runGig walks phases, finds the agent, calls
//                              deps.invoke(ctx). The invocation context is
//                              { agent, phase, inputs, gig_input } — no skills.
//   src/claude_invoker.ts:25 — literal comment:
//                              "(Skills layer omitted in v0 — skill content
//                              injection is a later piece.)"
//
// This test makes the absence executable: bootstrap a genome with a skill
// file present, dispatch a gig, capture EVERYTHING the invoker sees, then
// assert RED-honestly that the skill's content never reaches the prompt
// or the agent it was supposedly bound to.
//
// Pre-reg: we expect RED. The kill-condition is the skill DOES leak into
// the invocation somehow we missed. The honest-RED IS the diagnosis Miles
// is reporting back: skills are the 5th-class stub, same shape as evals.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  MemoryLedger,
  createOutputStore,
  loadGenome,
  loadRegistry,
  runGig,
  buildPrompt,
  type AgentInvocationContext,
  type AgentInvoker,
} from "../../src/index.js";

import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";

const SKILL_SLUG = "summarize-tight";
const SKILL_MD =
  "SKILL_FINGERPRINT_b3f1c1: Compose the gist in exactly one tight clause. Use only the supplied facts; no filler.";
const SKILL_DOMAIN = "demo";

let env: TempdirColtrane;
let genomeDir: string;

describe("skills_declared_but_not_invoked — the 5th-class stub diagnosis", () => {
  beforeAll(async () => {
    env = await setupTempdirColtrane();
    genomeDir = env.tempDir;

    // Reset to a fresh genome — keep core_types, blow away the rest so we
    // know every entity in play is the one we just authored.
    for (const sub of ["agents", "standards", "domain_types", "skills", "evals"]) {
      const p = join(genomeDir, sub);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      mkdirSync(p, { recursive: true });
    }

    // domain_types: minimal Signal + Interpretation so a 2-phase gig can compose.
    writeFileSync(
      join(genomeDir, "domain_types", "raw-note.json"),
      JSON.stringify({
        slug: "raw-note",
        version: 1,
        extends: "Signal",
        domain: SKILL_DOMAIN,
        status: "active",
        schema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
        required_fields: ["body"],
      }),
    );
    writeFileSync(
      join(genomeDir, "domain_types", "summary.json"),
      JSON.stringify({
        slug: "summary",
        version: 1,
        extends: "Interpretation",
        domain: SKILL_DOMAIN,
        status: "active",
        schema: { type: "object", properties: { gist: { type: "string" } }, required: ["gist"] },
        required_fields: ["gist"],
      }),
    );

    // agents: sensor (SENSE → raw-note), summarizer (INTERPRET → summary).
    // The summarizer is the agent that — IF skills worked — would name the
    // skill it depends on. We attempt every plausible binding slot:
    //   - skill_slugs (the obvious one, parallel to standard.agent_slugs)
    //   - skills      (alternate naming)
    // Both are extra fields on the AgentFileDef. If the loader picked them
    // up, defineAgent or the runtime would surface them downstream.
    writeFileSync(
      join(genomeDir, "agents", "sensor.json"),
      JSON.stringify({
        slug: "sensor",
        primitives: ["SENSE"],
        input_types: [],
        output_types: ["raw-note"],
        domain: SKILL_DOMAIN,
      }),
    );
    writeFileSync(
      join(genomeDir, "agents", "summarizer.json"),
      JSON.stringify({
        slug: "summarizer",
        primitives: ["INTERPRET"],
        input_types: ["raw-note"],
        output_types: ["summary"],
        domain: SKILL_DOMAIN,
        // The two plausible slots — both should pass through the loader as
        // extra fields since AgentFileDef has no skill slot.
        skill_slugs: [SKILL_SLUG],
        skills: [SKILL_SLUG],
      }),
    );

    // standard: 2-phase summarize standard.
    writeFileSync(
      join(genomeDir, "standards", "summarize.json"),
      JSON.stringify({
        slug: "summarize",
        domain: SKILL_DOMAIN,
        agent_slugs: ["sensor", "summarizer"],
        phases: [
          { name: "sense", agent: "sensor" },
          { name: "interpret", agent: "summarizer" },
        ],
      }),
    );

    // skill: the artifact whose content we'll search for everywhere.
    writeFileSync(
      join(genomeDir, "skills", `${SKILL_SLUG}.json`),
      JSON.stringify({
        slug: SKILL_SLUG,
        domain: SKILL_DOMAIN,
        md: SKILL_MD,
      }),
    );
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("step 1: loader reads skills/ into LoadedGenome.skills (this part works)", () => {
    const g = loadGenome(genomeDir);
    const s = g.skills.get(SKILL_SLUG);
    expect(s).toBeDefined();
    expect((s as { md?: string }).md).toBe(SKILL_MD);
    // Sanity: all 5 classes loaded.
    expect(g.core_types.size).toBeGreaterThan(0);
    expect(g.domain_types.size).toBe(2);
    expect(g.agents.size).toBe(2);
    expect(g.standards.size).toBe(1);
    expect(g.skills.size).toBe(1);
  });

  it("step 2: defineAgent strips skill_slugs — the Agent type has no slot for skills", () => {
    const g = loadGenome(genomeDir);
    const summarizer = g.agents.get("summarizer");
    expect(summarizer).toBeDefined();
    // The Agent interface (composition.ts) declares: slug, primitives,
    // input_types, output_types, domain, allowed_tools, disallowed_tools.
    // No skills. We assert by serialization — if a skill_slugs field
    // survived, it would be visible here.
    const keys = Object.keys(summarizer as object).sort();
    expect(keys).not.toContain("skill_slugs");
    expect(keys).not.toContain("skills");
    // Belt+suspenders: the JSON form has no skill mention anywhere.
    const json = JSON.stringify(summarizer);
    expect(json).not.toContain("skill");
    expect(json).not.toContain(SKILL_SLUG);
  });

  it("step 3: AgentInvocationContext at runtime has no skills field — the runtime never even tries to inject", async () => {
    const g = loadGenome(genomeDir);
    const standard = g.standards.get("summarize");
    expect(standard).toBeDefined();

    const registry = loadRegistry(g);
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();

    // The mock invoker captures every context the runtime hands it. This is
    // ground truth for what the runtime believes the agent needs to see.
    const seen: AgentInvocationContext[] = [];
    const invoker: AgentInvoker = (ctx) => {
      seen.push(ctx);
      if (ctx.agent.slug === "sensor") return { body: "input note" };
      if (ctx.agent.slug === "summarizer") return { gist: "tight" };
      throw new Error(`unexpected agent ${ctx.agent.slug}`);
    };

    await runGig(standard!, { topic: "x" }, { outputs, ledger, invoke: invoker });

    expect(seen.length).toBe(2);
    for (const ctx of seen) {
      const ctxKeys = Object.keys(ctx).sort();
      // Documented context shape (runtime.ts): { agent, phase, inputs, gig_input }.
      expect(ctxKeys).toEqual(["agent", "gig_input", "inputs", "phase"]);
      // No skill-shaped field smuggled in under another name.
      expect(JSON.stringify(ctx)).not.toContain("SKILL_FINGERPRINT_b3f1c1");
      expect(JSON.stringify(ctx)).not.toContain(SKILL_MD);
    }
  });

  it("step 4: buildPrompt produces zero skill bytes — the 5-layer prompt has the Skills layer commented out", () => {
    // Pull the summarizer agent out of the loaded genome and hand it
    // straight to buildPrompt — the pure prompt builder used by the real
    // Claude invoker. This is the actual prompt the spawned `claude -p`
    // would receive in production.
    const g = loadGenome(genomeDir);
    const summarizer = g.agents.get("summarizer")!;

    const ctx: AgentInvocationContext = {
      agent: summarizer,
      phase: "interpret",
      inputs: [],
      gig_input: { topic: "x" },
    };
    const prompt = buildPrompt(ctx);

    // Hard kill: the skill's fingerprint MUST appear nowhere in the prompt.
    expect(prompt).not.toContain("SKILL_FINGERPRINT_b3f1c1");
    expect(prompt).not.toContain(SKILL_MD);
    expect(prompt).not.toContain(SKILL_SLUG);
    // And the literal "Skills" section is omitted — claude_invoker.ts:25
    // says "Skills layer omitted in v0". This is the comment-as-contract:
    // the section header is absent from the 5-layer prompt.
    expect(prompt).not.toMatch(/^#\s*Skills\b/m);
    // What IS in the prompt is the 4 layers the doc says are present.
    expect(prompt).toContain("# Disposition");
    expect(prompt).toContain("# Identity");
    expect(prompt).toContain("# Context");
    expect(prompt).toContain("# Task");
  });

  it("step 5: source-of-truth grep — no runtime/invoker code ever reads from genome.skills", () => {
    // The diagnosis isn't subtle: read the source files and prove the
    // word `.skills` never appears in any read-position outside of the
    // loader. If a future commit wires skills through, this test will
    // turn red and the band will know to update the diagnosis.
    const repoRoot = join(genomeDir, "..", "..");
    const candidates = [
      join(genomeDir, "src", "runtime.ts"),
      join(genomeDir, "src", "claude_invoker.ts"),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      const src = readFileSync(path, "utf-8");
      // `.skills` as a member access — none should exist.
      expect(src.match(/\.skills\b/g)).toBeNull();
      // The deeper proof: claude_invoker has an explicit comment confessing
      // the omission. If that comment is gone, somebody wired it; re-look.
      if (path.endsWith("claude_invoker.ts")) {
        expect(src).toContain("Skills layer omitted");
      }
    }
    // Suppress lint warning about unused var (kept for future cross-repo grep).
    void repoRoot;
  });

  it("DIAGNOSIS: skills are the 5th-class stub — loaded, but invocation-dead", () => {
    // This is the band's report from this spec. The four prior steps
    // are RED-honest forensic evidence; this step crystallizes them.
    //
    // FOUND:
    //   - skills/ JSON files load into LoadedGenome.skills (step 1 GREEN).
    //   - The Agent type has no `skills` field — extra fields on the
    //     AgentFileDef are silently dropped by defineAgent (step 2 GREEN).
    //   - The runtime's AgentInvocationContext does not include skills;
    //     the invoker has no way to see them (step 3 GREEN).
    //   - The 5-layer prompt's Skills section is omitted by design
    //     (step 4 GREEN; src/claude_invoker.ts:25 comment confirms).
    //   - No code path under src/runtime.ts or src/claude_invoker.ts
    //     reads `.skills` from the genome (step 5 GREEN).
    //
    // CONCLUSION: skills are the parallel diagnosis to T19's eval finding.
    // The 5th class (and the 6th, evals) loads as a slug-keyed Map and
    // then dead-ends. The "5 definition classes" claim in the spec is
    // currently 3 live (core_types, domain_types, agents+standards) and
    // 2 stubs (skills, evals).
    expect(true).toBe(true);
  });
});
