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
  type GigProgressEvent,
} from "../../src/index.js";

import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";

const SKILL_SLUG = "summarize-tight";
const SKILL_FINGERPRINT = "FIRE_SKILL_b3f1c1";
const SKILL_MD = `${SKILL_FINGERPRINT}: Compose the gist in one tight clause. No filler.`;
const SKILL_DOMAIN = "demo";
const PHANTOM = "phantom-skill-that-does-not-exist";

// FIXTURE REPAIR (landed with #241). This spec had rotted where nothing could see it:
// `tests/e2e/` is executed by no npm script (#219), so two contract changes drifted past it —
// agents gained REQUIRED behavioral fields (identity/method/constraints/behavioral_primitives),
// and the flat `skills/<slug>.json` format was retired in favour of package DIRECTORIES. Every
// assertion below threw `GenomeIncompleteError` before reaching its subject. Repaired rather
// than skipped: an unrunnable spec proves nothing, and the rewrite below needs to be verifiable.
const BEHAVIOR = {
  identity: "a test agent in the skills-wiring band",
  method: "do the one thing the phase asks for and return typed JSON",
  constraints: [],
  behavioral_primitives: ["analyst", "synthesizer"],
};

// Every sealed output carries its CORE's substance floor, enforced by outputs.write on every
// write, subtype or not (#227 ruling): `raw-note` is Signal-cored and names where it was
// acquired, `summary` is Interpretation-cored and states its claims. These stubs were never
// valid instances of their own core — the seal path simply did not look, so every gig below
// died at its first chair and none of the skill-wiring assertions were reached.
const NOTE = (body: string): Record<string, unknown> => ({ body, source: "fixture://demo/sensor" });
const SUMMARY = (gist: string): Record<string, unknown> => ({ gist, claims: [gist] });

let env: TempdirColtrane;
let genomeDir: string;

/** Author `summarizer` with an explicit skill_slugs list. */
function writeSummarizer(slugs: string[]): void {
  writeFileSync(
    join(genomeDir, "agents", "summarizer.json"),
    JSON.stringify({
      slug: "summarizer",
      primitives: ["INTERPRET"],
      input_types: ["raw-note"],
      output_types: ["summary"],
      domain: SKILL_DOMAIN,
      skill_slugs: slugs,
      ...BEHAVIOR,
    }),
  );
}

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
        ...BEHAVIOR,
      }),
    );
    writeSummarizer([SKILL_SLUG]);

    writeFileSync(
      join(genomeDir, "standards", "summarize.json"),
      JSON.stringify({
        slug: "summarize",
        domain: SKILL_DOMAIN,
        agent_slugs: ["sensor", "summarizer"],
        phases: [
          { name: "sense", chairs: [{ role: "sense", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] },
          { name: "interpret", chairs: [{ role: "interpret", agent_slug: "summarizer", depends_on: [], input_contract: [], output_contract: ["summary"], required_skills: [] }] },
        ],
      }),
    );

    // A skill PACKAGE directory — meta + a reasoning half + its pre-registered contract.
    // (The flat `skills/<slug>.json` this spec used to write is silently ignored by the
    // loader, which reads package dirs only: `g.skills` came back empty.)
    const pkgDir = join(genomeDir, "skills", SKILL_SLUG);
    mkdirSync(join(pkgDir, "fixtures"), { recursive: true });
    writeFileSync(join(pkgDir, "meta.json"), JSON.stringify({ slug: SKILL_SLUG, version: 1, domain: SKILL_DOMAIN, permission: { tier: 0 } }));
    writeFileSync(join(pkgDir, "skill.md"), SKILL_MD);
    writeFileSync(join(pkgDir, "fixtures", "basic.json"), JSON.stringify({ id: "basic", input: {}, assertions: [] }));
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
      if (ctx.agent.slug === "sensor") return NOTE("raw input");
      if (ctx.agent.slug === "summarizer") return SUMMARY("tight");
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

  // ── CONSCIOUSLY REWRITTEN (#241) ───────────────────────────────────────────
  // This test was titled "unknown skill_slugs are silently dropped (honest no-op, not a
  // gig-kill)" and asserted the drop as CORRECT. Half of that is right and is kept: a
  // dangling binding the chair did not declare REQUIRED must not kill the gig — a typo in a
  // genome file crashing a whole run is a real failure mode and this spec still pins it shut.
  //
  // The other half was wrong. "Silent" was never the honest part, and the diagnostic surface
  // the old comment claimed ("the resulting empty Skills layer in the prompt") did not exist:
  // there is no empty Skills layer, ever. With ALL slugs dangling the prompt rendered
  // `# Skills` / `## phantom-…` with zero content — telling the model, in its own prompt, that
  // it holds a discipline that does not exist. With one dangling (the realistic case) the
  // prompt was byte-identical to an agent that never declared it. And the old test asserted
  // only on `ctx.skills`, never on the prompt, so it could not have caught either.
  //
  // The boundary this now pins: a skill package that LOADS is a legitimate degradation
  // candidate (see tests/skill_graceful_degradation.test.ts, entirely green). A slug that
  // resolves to NO PACKAGE has nothing to degrade — not fatal here, but never invisible.
  it("(1) runtime: an unknown skill_slug is NOT a gig-kill, but it is never silent either", async () => {
    writeSummarizer([SKILL_SLUG, PHANTOM]);

    const g = loadGenome(genomeDir);

    // (i) LOAD TIME — `load_errors: []` is the pass signal operators are instructed to trust.
    // A binding to a skill that does not exist has to break it. Soft: the agent still loads.
    const loadErr = g.load_errors.find((e) => e.slug === "summarizer" && e.error.includes(PHANTOM));
    expect(loadErr, "a dangling skill binding must surface in load_errors").toBeDefined();
    expect(loadErr!.kind).toBe("agent");
    expect(g.agents.get("summarizer"), "…but softly — the agent still loads").toBeDefined();

    const standard = g.standards.get("summarize")!;
    const registry = loadRegistry(g);
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();

    const seen: AgentInvocationContext[] = [];
    const events: GigProgressEvent[] = [];
    const invoker: AgentInvoker = (ctx) => {
      seen.push(ctx);
      if (ctx.agent.slug === "sensor") return NOTE("raw");
      return SUMMARY("ok");
    };

    const res = await runGig(standard, {}, {
      outputs, ledger, invoke: invoker, skills: g.skills, onProgress: (ev) => events.push(ev),
    });

    // (ii) NOT A GIG-KILL — the original contract, preserved verbatim in spirit.
    expect(res.status).toBe("complete");

    const sCtx = seen.find((c) => c.agent.slug === "summarizer")!;
    expect(sCtx.skills).toHaveLength(1);
    expect(sCtx.skills![0]!.slug).toBe(SKILL_SLUG);

    // (iii) NOT SILENT — the drop reaches the invocation context and the progress channel.
    expect(sCtx.missing_skills).toEqual([PHANTOM]);
    expect(
      events.find((e) => e.type === "skills_unresolved"),
      "an unskilled run is otherwise identical to a skilled one — same genome_hash, run_fingerprint AND content_sha",
    ).toMatchObject({ type: "skills_unresolved", agent: "summarizer", missing: [PHANTOM] });

    // (iv) NEVER ASSERTED TO THE MODEL — the prompt names the resolved skill and not the ghost.
    const prompt = buildPrompt(sCtx);
    expect(prompt).toContain(SKILL_SLUG);
    expect(prompt).toContain(SKILL_FINGERPRINT);
    expect(prompt, "the prompt must not claim a discipline the agent does not hold").not.toContain(PHANTOM);

    // Restore the canonical authoring for the prompt assertions below.
    writeSummarizer([SKILL_SLUG]);
  });

  it("(1) runtime: a chair's REQUIRED skill that resolves to no package fails CLOSED (#242)", async () => {
    // The other side of the same boundary. `required_skills` was validated exactly once, at
    // compose time, as a string-subset check against the agent's own declaration — so a chair
    // could declare a skill required, pass composition, and run unskilled. "Required" means
    // required; there is no degradation tension in this direction at all.
    writeSummarizer([SKILL_SLUG, PHANTOM]);
    writeFileSync(
      join(genomeDir, "standards", "summarize-strict.json"),
      JSON.stringify({
        slug: "summarize-strict",
        domain: SKILL_DOMAIN,
        agent_slugs: ["sensor", "summarizer"],
        phases: [
          { name: "sense", chairs: [{ role: "sense", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] },
          { name: "interpret", chairs: [{ role: "interpret", agent_slug: "summarizer", depends_on: [], input_contract: [], output_contract: ["summary"], required_skills: [PHANTOM] }] },
        ],
      }),
    );

    const g = loadGenome(genomeDir);
    const standard = g.standards.get("summarize-strict")!;
    const registry = loadRegistry(g);

    const fired: string[] = [];
    const invoker: AgentInvoker = (ctx) => {
      fired.push(ctx.agent.slug);
      return ctx.agent.slug === "sensor" ? NOTE("raw") : SUMMARY("ok");
    };

    await expect(
      runGig(standard, {}, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke: invoker, skills: g.skills }),
    ).rejects.toThrow(new RegExp(PHANTOM));

    expect(fired, "the sensor may run; the chair missing its REQUIRED skill must not").not.toContain("summarizer");

    rmSync(join(genomeDir, "standards", "summarize-strict.json"), { force: true });
    writeSummarizer([SKILL_SLUG]);
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
        return JSON.stringify(NOTE("raw"));
      }
      return JSON.stringify(SUMMARY("ok"));
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
