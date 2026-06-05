// skills_now_fire — proves the wiring tonight/miles/wire-skills lands.
//
// Two assertions, end to end:
//   (1) An agent's `skill_slugs` flows: composition → runtime → invoker.
//       The runtime resolves the slugs against the genome's skills map; the
//       invoker sees the resolved SkillRecords on the AgentInvocationContext.
//   (2) The skill content appears in the prompt the invoker sends downstream.
//       The Layer-3 Skills section carries the skill's md text verbatim, so a
//       spawned `claude -p` would receive the discipline content.
//
// The original PR #95 (skills_declared_but_not_invoked.spec.ts) was a forensic-
// GREEN diagnosis: every step confirmed the absence. This spec is the contract
// that pairs with the fix — if either seam regresses (defineAgent drops the
// field, runtime stops resolving, invoker stops emitting the layer), the
// specific assertion that proves the seam will go red.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  MemoryLedger,
  buildPrompt,
  buildInvokerArgs,
  createOutputStore,
  loadGenome,
  loadRegistry,
  makeClaudeInvoker,
  runGig,
  type AgentInvocationContext,
  type AgentInvoker,
} from "../../src/index.js";

import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";

const SKILL_SLUG = "summarize-tight";
const SKILL_FINGERPRINT = "FIRE_SKILL_b3f1c1";
const SKILL_MD = `${SKILL_FINGERPRINT}: Compose the gist in one tight clause. No filler.`;
const SKILL_DOMAIN = "demo";

let env: TempdirColtrane;
let genomeDir: string;

describe("skills_now_fire — the post-wire contract", () => {
  beforeAll(async () => {
    env = await setupTempdirColtrane();
    genomeDir = env.tempDir;

    for (const sub of ["agents", "standards", "domain_types", "skills", "evals"]) {
      const p = join(genomeDir, sub);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      mkdirSync(p, { recursive: true });
    }

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
        skill_slugs: [SKILL_SLUG],
      }),
    );

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

    writeFileSync(
      join(genomeDir, "skills", `${SKILL_SLUG}.json`),
      JSON.stringify({ slug: SKILL_SLUG, domain: SKILL_DOMAIN, md: SKILL_MD }),
    );
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("(1) composition: defineAgent propagates skill_slugs onto the Agent record", () => {
    const g = loadGenome(genomeDir);
    const summarizer = g.agents.get("summarizer")!;
    expect(summarizer.skill_slugs).toEqual([SKILL_SLUG]);
    // Sensor declares no skills; defineAgent still sets the field (empty array).
    expect(g.agents.get("sensor")!.skill_slugs).toEqual([]);
  });

  it("(1) runtime: runGig resolves skill_slugs against the genome map and passes SkillRecords through the ctx", async () => {
    const g = loadGenome(genomeDir);
    const standard = g.standards.get("summarize")!;
    const registry = loadRegistry(g);
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();

    const seen: AgentInvocationContext[] = [];
    const invoker: AgentInvoker = (ctx) => {
      seen.push(ctx);
      if (ctx.agent.slug === "sensor") return { body: "raw input" };
      if (ctx.agent.slug === "summarizer") return { gist: "tight" };
      throw new Error(`unexpected agent ${ctx.agent.slug}`);
    };

    await runGig(standard, { topic: "x" }, { outputs, ledger, invoke: invoker, skills: g.skills });

    const summarizerCtx = seen.find((c) => c.agent.slug === "summarizer")!;
    expect(summarizerCtx.skills).toHaveLength(1);
    const skill = summarizerCtx.skills![0]!;
    expect(skill.slug).toBe(SKILL_SLUG);
    expect((skill as { md?: string }).md).toBe(SKILL_MD);

    // Sensor declares no skills → empty array.
    const sensorCtx = seen.find((c) => c.agent.slug === "sensor")!;
    expect(sensorCtx.skills).toEqual([]);
  });

  it("(1) runtime: unknown skill_slugs are silently dropped (honest no-op, not a gig-kill)", async () => {
    // Re-author summarizer with a phantom slug appended so we can prove the
    // runtime resolves only what exists. This is the kill-condition for the
    // failure-mode where a typo in a genome file crashes the whole gig.
    writeFileSync(
      join(genomeDir, "agents", "summarizer.json"),
      JSON.stringify({
        slug: "summarizer",
        primitives: ["INTERPRET"],
        input_types: ["raw-note"],
        output_types: ["summary"],
        domain: SKILL_DOMAIN,
        skill_slugs: [SKILL_SLUG, "phantom-skill-that-does-not-exist"],
      }),
    );

    const g = loadGenome(genomeDir);
    const standard = g.standards.get("summarize")!;
    const registry = loadRegistry(g);
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();

    const seen: AgentInvocationContext[] = [];
    const invoker: AgentInvoker = (ctx) => {
      seen.push(ctx);
      if (ctx.agent.slug === "sensor") return { body: "raw" };
      return { gist: "ok" };
    };

    const res = await runGig(standard, {}, { outputs, ledger, invoke: invoker, skills: g.skills });
    expect(res.status).toBe("complete");

    const sCtx = seen.find((c) => c.agent.slug === "summarizer")!;
    // Only the known skill resolves; phantom drops.
    expect(sCtx.skills).toHaveLength(1);
    expect(sCtx.skills![0]!.slug).toBe(SKILL_SLUG);

    // Restore the canonical authoring for the prompt assertion below.
    writeFileSync(
      join(genomeDir, "agents", "summarizer.json"),
      JSON.stringify({
        slug: "summarizer",
        primitives: ["INTERPRET"],
        input_types: ["raw-note"],
        output_types: ["summary"],
        domain: SKILL_DOMAIN,
        skill_slugs: [SKILL_SLUG],
      }),
    );
  });

  it("(2) invoker: buildPrompt renders the resolved skill content into the Layer-3 Skills section", () => {
    const g = loadGenome(genomeDir);
    const summarizer = g.agents.get("summarizer")!;
    const skill = g.skills.get(SKILL_SLUG)!;

    const ctx: AgentInvocationContext = {
      agent: summarizer,
      phase: "interpret",
      inputs: [],
      gig_input: { topic: "x" },
      skills: [skill],
    };
    const prompt = buildPrompt(ctx);

    // The Skills header is present + the skill's md content is verbatim.
    expect(prompt).toMatch(/^#\s*Skills\b/m);
    expect(prompt).toContain(SKILL_SLUG);
    expect(prompt).toContain(SKILL_MD);
    expect(prompt).toContain(SKILL_FINGERPRINT);

    // Five-layer order is honored: Skills lands AFTER Identity and BEFORE Context.
    const idIdx = prompt.indexOf("# Identity");
    const skIdx = prompt.indexOf("# Skills");
    const ctxIdx = prompt.indexOf("# Context");
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(skIdx).toBeGreaterThan(idIdx);
    expect(ctxIdx).toBeGreaterThan(skIdx);
  });

  it("(2) invoker end-to-end: the prompt fed to the spawn carries the skill content", async () => {
    // Bind a captured-spawn invoker. The real production path runs Claude;
    // here we capture the prompt the cage would send and assert on its
    // contents — proves the skill content reaches the subprocess seam.
    const g = loadGenome(genomeDir);
    const standard = g.standards.get("summarize")!;
    const registry = loadRegistry(g);
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();

    const captured: string[] = [];
    const runSpy = (_bin: string, args: string[]): string => {
      const promptIdx = args.indexOf("-p");
      const prompt = promptIdx >= 0 && promptIdx + 1 < args.length ? args[promptIdx + 1]! : "";
      captured.push(prompt);
      // The Identity layer uniquely names the agent the prompt is FOR (the
      // sensor's prompt would still mention summarizer somewhere only via the
      // upstream-input rendering, which doesn't fire here for sensor).
      // We dispatch on whether the agent identified in Layer 2 is the sensor.
      if (prompt.includes('agent "sensor"')) {
        return JSON.stringify({ body: "raw" });
      }
      return JSON.stringify({ gist: "ok" });
    };

    const invoke = makeClaudeInvoker({ registry, run: runSpy });
    await runGig(standard, { topic: "x" }, { outputs, ledger, invoke, skills: g.skills });

    // Two prompts were sent (one per phase). The summarizer's prompt MUST
    // carry the skill content; the sensor's MUST NOT (sensor declares no
    // skill_slugs — the layer is omitted entirely).
    expect(captured).toHaveLength(2);
    const sensorPrompt = captured.find((p) => p.includes('agent "sensor"'))!;
    const summarizerPrompt = captured.find((p) => p.includes('agent "summarizer"'))!;

    expect(summarizerPrompt).toContain("# Skills");
    expect(summarizerPrompt).toContain(SKILL_SLUG);
    expect(summarizerPrompt).toContain(SKILL_MD);
    expect(summarizerPrompt).toContain(SKILL_FINGERPRINT);

    expect(sensorPrompt).not.toContain("# Skills");
    expect(sensorPrompt).not.toContain(SKILL_FINGERPRINT);
  });

  it("(2) invoker cage args still carry the prompt (no regression in buildInvokerArgs)", () => {
    // Sanity gate: the new Skills layer is an additive change to the prompt
    // body. The cage flags (--mcp-config, --strict-mcp-config) are unchanged.
    const args = buildInvokerArgs("# Skills\n## x\nhello", "/tmp/cfg.json", {});
    expect(args[0]).toBe("-p");
    expect(args[1]).toContain("# Skills");
    expect(args).toContain("--strict-mcp-config");
  });
});
