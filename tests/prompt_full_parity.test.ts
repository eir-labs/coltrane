// RED-first contract tests — FULL-PROMPT behavioral parity with the old runtime.
//
// tests/fixtures/old_runtime_prompt__*.md are golden prompts generated through the OLD
// coltrane buildAgentPrompt across 10 lever scenarios (the baseline). Each carries the
// full behavioral stack the new runtime dropped: Belbin Disposition (2 roles in tension,
// with descriptions), Identity prose, Method, Constraints, and a tool catalog the model
// is told to use. These tests assert two things per scenario:
//   - ORACLE SANITY (green): the fixture really carries that behavioral load — proving the
//     spec below faithfully mirrors the old runtime.
//   - PARITY (RED until wired): the NEW buildPrompt, given the equivalent merged Agent,
//     reaches the same behavioral load. Structural divergence is fine (the new engine
//     drops Supabase-era scaffolding); the behavioral content must reach parity.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildPrompt, BELBIN_DESCRIPTIONS } from "../src";
import type { Agent, AgentInvocationContext, BelbinRole } from "../src";

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
const golden = (file: string): string => readFileSync(join(FIX, `old_runtime_prompt__${file}.md`), "utf8");

interface Spec {
  file: string;
  slug: string;
  disposition: BelbinRole[];
  identity: string;
  method: string;
  constraints: string[];
  tools: string[];
  depth: string;
  skills: string[];
}

const SPECS: Spec[] = [
  { file: "01_fact-checker", slug: "fact-checker", disposition: ["explorer", "critic"], depth: "standard", tools: ["web_search", "fetch_url"], skills: [],
    identity: "You are fact-checker. You never accept a plausible-sounding claim without a retrieved source — you read like an explorer and challenge like a critic.",
    method: "Take the claim, search for primary sources that confirm or refute it, and report a verdict with the supporting citations and quotes.",
    constraints: ["Never assert a fact you cannot cite.", "A source must be retrieved, not recalled from memory."] },
  { file: "02_code-writer", slug: "code-writer", disposition: ["planner", "executor"], depth: "deep", tools: ["repo_read", "repo_write"], skills: [],
    identity: "You are code-writer. You implement a change spec as a minimal, test-backed diff and open a PR.",
    method: "Read the change spec. Land the RED test first, then the implementation that makes it green. Keep the diff minimal and the commit message in forward-state.",
    constraints: ["Test must land RED before code.", "Do not ship hollow-green tests.", "Match the surrounding code's idiom."] },
  { file: "03_site-crawler", slug: "site-crawler", disposition: ["explorer", "analyst"], depth: "skim", tools: ["browser_navigate", "browser_snapshot"], skills: ["crawl-frontier"],
    identity: "You are site-crawler. You map a site into typed page-models without interpreting yet.",
    method: "Visit the seed URL, enumerate reachable pages within the depth cap, and record one page-model per page.",
    constraints: ["Stay within the depth cap.", "Do not submit forms or trigger destructive actions."] },
  { file: "04_cross-reviewer", slug: "cross-reviewer", disposition: ["critic", "analyst"], depth: "standard", tools: [], skills: [],
    identity: "You are cross-reviewer. You deduplicate findings across reviewers and score them against the rubric.",
    method: "Merge the findings, drop duplicates, and score each surviving finding against the quality rubric. Report the weighted overall.",
    constraints: ["Score only against the rubric metrics provided.", "A skipped metric is removed from the weights, not zeroed."] },
  { file: "05_incident-responder", slug: "incident-responder", disposition: ["planner", "synthesizer"], depth: "quick", tools: ["pager_ack", "metrics_query"], skills: [],
    identity: "You are incident-responder. You turn an alert into an ordered mitigation plan.",
    method: "Triage the alert against the runbook knowledge, then produce an ordered plan with owners and rollback steps.",
    constraints: ["Every step must have a rollback.", "Never propose an irreversible action without an explicit gate."] },
  { file: "06_migration-planner", slug: "migration-planner", disposition: ["planner", "executor"], depth: "deep", tools: ["repo_read"], skills: [],
    identity: "You are migration-planner. You sequence a large migration into safe, reversible steps.",
    method: "Read the repo context, group changes by blast radius, and order them so each step is independently shippable.",
    constraints: ["Each step must be independently revertible."] },
  { file: "07_audience-modeler", slug: "audience-modeler", disposition: ["audience_modeler", "synthesizer"], depth: "standard", tools: [], skills: ["register-match"],
    identity: "You are audience-modeler. You re-render technical content for a specific non-technical reader without losing the substance.",
    method: "Model the target reader, then re-shape the writeup to their register — keep every load-bearing claim, drop the jargon.",
    constraints: ["Never add a claim the source does not support.", "Match the reader's register, not your own."] },
  { file: "08_test-engineer", slug: "test-engineer", disposition: ["executor", "critic"], depth: "standard", tools: ["repo_read", "run_tests"], skills: [],
    identity: "You are test-engineer. You author the RED test that pins a change before any implementation exists.",
    method: "Translate the change spec into a failing test that asserts the behavior, then confirm it fails for the right reason.",
    constraints: ["The test must fail RED before implementation.", "Assert behavior, not implementation detail."] },
  { file: "09_literature-scout", slug: "literature-scout", disposition: ["explorer", "analyst"], depth: "standard", tools: ["scholar_search", "fetch_url"], skills: ["claim-bounding"],
    identity: "You are literature-scout. You find primary sources for a question and bound each claim to its evidence.",
    method: "Search for primary literature, extract candidate claims, and bind each to a citation with a confidence and a quote.",
    constraints: ["Every claim must bind to a retrievable source.", "Mark anything you cannot ground as open."] },
  { file: "10_minimal-no-output", slug: "scratch-thinker", disposition: ["analyst", "synthesizer"], depth: "quick", tools: [], skills: [],
    identity: "You are scratch-thinker, a side agent that reasons aloud and records nothing typed.",
    method: "Think through the prompt and use the available MCP tools; you have no typed output to record.",
    constraints: [] },
];

function newPrompt(s: Spec): string {
  const agent: Agent = {
    slug: s.slug, primitives: ["INTERPRET"], input_types: [], output_types: ["Interpretation"], domain: "demo",
    identity: s.identity, method: s.method, constraints: s.constraints,
    behavioral_primitives: s.disposition, allowed_tools: s.tools, depth_profile: s.depth as "skim" | "quick" | "standard" | "deep",
    skill_slugs: s.skills,
  };
  const ctx: AgentInvocationContext = { agent, phase: "p", inputs: [], gig_input: {} };
  return buildPrompt(ctx);
}

// Assert every behavioral element is present in `text`. Used for both the golden (oracle)
// and the new prompt (parity) — same load-bearing checklist.
function expectBehavioralLoad(text: string, s: Spec, label: string): void {
  expect(text, `${label}: identity`).toContain(s.identity);
  expect(text, `${label}: method`).toContain(s.method);
  for (const c of s.constraints) expect(text, `${label}: constraint`).toContain(c);
  for (const t of s.tools) expect(text, `${label}: tool ${t}`).toContain(t);
  if (s.tools.length) expect(text, `${label}: tool-awareness`).toMatch(/available tools|call them directly|only these tools|you have the following tools/i);
  for (const role of s.disposition) {
    expect(text, `${label}: disposition role ${role}`).toContain(role);
    expect(text, `${label}: disposition description ${role}`).toContain(BELBIN_DESCRIPTIONS[role]);
  }
  expect(text, `${label}: disposition tension framing`).toMatch(/tension|equal tension|both modes/i);
  expect(text, `${label}: depth`).toContain(s.depth);
  for (const sk of s.skills) expect(text, `${label}: skill ${sk}`).toContain(sk);
}

describe("baseline fixtures faithfully carry the old runtime's behavioral load (oracle sanity)", () => {
  it.each(SPECS)("$file golden carries identity/method/constraints/tools/disposition/depth", (s) => {
    expectBehavioralLoad(golden(s.file), s, `golden ${s.file}`);
  });
});

describe("the new full prompt reaches behavioral parity with each baseline", () => {
  it.each(SPECS)("$file new buildPrompt matches the baseline's behavioral load", (s) => {
    expectBehavioralLoad(newPrompt(s), s, `new ${s.file}`);
  });
});
