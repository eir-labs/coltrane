// preview-deploy — the sealed design gig 0538105e (product-design-v1), implemented RED-first.
//
// The spec: SENSE a branch → PLAN/CREATE the Vercel preview deploy (POST then poll to a
// terminal readyState) → VERIFY the terminal state, sealing a preview-deployment Artifact
// and a deploy-verdict. It sits as movement-2 of a chart between software-change-v1 and a
// promote stub, behind a human approval gate.
//
// Every assertion here exercises a SIDE EFFECT — type registration, standard composition,
// chart composition, the skill's deterministic terminal-state logic — not a bare schema
// parse. That is the design-concept's own RED-test discipline (validation_criteria[6]).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadGenome,
  loadRegistry,
  composeStandard,
  composeChart,
  createOutputStore,
  OutputStoreError,
  type Agent,
} from "../src";
import { runSkillFixtures, executeSkill } from "../src/skill_subprocess.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERCEL_SKILL = join(REPO_ROOT, "skills/vercel-api");

function readJson(rel: string): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
}

const genome = loadGenome(REPO_ROOT);

// ─────────────────────────────────────────────────────────────────────────────
// The genome loads the whole arrangement cleanly.
// ─────────────────────────────────────────────────────────────────────────────
describe("preview-deploy: the arrangement loads without error", () => {
  it("registers the two result types, the branch signal, both agents, both standards, the chart and the venue", () => {
    // domain_types is keyed `slug@version`, so check by slug over the values.
    const typeSlugs = new Set([...genome.domain_types.values()].map((t) => t.slug));
    for (const t of ["preview-deployment", "deploy-verdict", "branch-state"]) {
      expect(typeSlugs.has(t), `domain type ${t} missing`).toBe(true);
    }
    for (const a of ["deploy-scout", "deploy-agent"]) {
      expect(genome.agents.has(a), `agent ${a} missing`).toBe(true);
    }
    for (const s of ["preview-deploy-v1", "promote-v1"]) {
      expect(genome.standards.has(s), `standard ${s} missing`).toBe(true);
    }
    expect(genome.charts.has("software-delivery-v2"), "chart missing").toBe(true);
    expect(genome.venues.has("ci-deploy-room-v1"), "venue missing").toBe(true);
  });

  it("no load error touches any preview-deploy artifact", () => {
    const mine = new Set([
      "preview-deployment", "deploy-verdict", "branch-state",
      "deploy-scout", "deploy-agent", "vercel-api",
      "preview-deploy-v1", "promote-v1", "software-delivery-v2", "ci-deploy-room-v1",
    ]);
    const touching = genome.load_errors.filter(
      (e) => (e.slug && mine.has(e.slug)) || /preview-deploy|deploy-agent|deploy-scout|vercel-api|ci-deploy-room|promote-v1|software-delivery-v2|branch-state|deploy-verdict|preview-deployment/.test(e.path ?? ""),
    );
    expect(touching, JSON.stringify(touching, null, 2)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two result types + the branch signal validate and enforce their required fields.
// ─────────────────────────────────────────────────────────────────────────────
describe("preview-deploy: the sealed types validate and enforce their contract", () => {
  const reg = loadRegistry(genome);

  it("preview-deployment extends Artifact, names eight fields, and enforces its required set", () => {
    const dt = readJson("domain_types/preview-deployment.json");
    expect(dt.extends).toBe("Artifact");
    for (const f of ["preview_url", "commit_sha", "branch", "project_id", "deployment_id", "build_status", "protection", "inspector_url"]) {
      expect(Object.keys(dt.schema.properties), `field ${f} not declared`).toContain(f);
    }
    expect(dt.required_fields.length).toBeGreaterThan(0);

    const store = createOutputStore(reg);
    const full = {
      validation_criteria: ["preview URL resolves over supabase-auth login"],
      input_refs: ["branch-state-1"],
      preview_url: "https://coltrane-git-feat-x.vercel.app",
      commit_sha: "9fceb02",
      branch: "feat/x",
      project_id: "prj_1",
      deployment_id: "dpl_1",
      build_status: "READY",
      protection: "supabase-auth",
      inspector_url: "https://vercel.com/eir/coltrane/dpl_1",
    };
    const rec = store.write({
      core_type: "Artifact", domain_type: "preview-deployment", domain: "preview-deploy",
      gig_id: "g-pd", agent_slug: "deploy-agent", primitive: "CREATE", data: full,
    });
    expect(rec.domain_type).toBe("preview-deployment");

    // required field dropped → rejected at write (side effect, not a parse).
    const { preview_url, ...dropped } = full;
    expect(() => store.write({
      core_type: "Artifact", domain_type: "preview-deployment", domain: "preview-deploy",
      gig_id: "g-pd2", agent_slug: "deploy-agent", primitive: "CREATE", data: dropped,
    })).toThrow(OutputStoreError);
  });

  it("deploy-verdict extends Verdict and enforces terminal_state + deadline_exceeded", () => {
    const dt = readJson("domain_types/deploy-verdict.json");
    expect(dt.extends).toBe("Verdict");
    for (const f of ["terminal_state", "logs_tail", "deadline_exceeded"]) {
      expect(Object.keys(dt.schema.properties), `field ${f} not declared`).toContain(f);
    }

    const store = createOutputStore(reg);
    const ok = store.write({
      core_type: "Verdict", domain_type: "deploy-verdict", domain: "preview-deploy",
      gig_id: "g-dv", agent_slug: "deploy-agent", primitive: "VERIFY",
      data: {
        checks: [{ method: "poll GET /v6/deployments", target_ref: "dpl_1", result: "READY" }],
        target_ref: "dpl_1", pass: true, terminal_state: "READY", deadline_exceeded: false,
      },
    });
    expect(ok.domain_type).toBe("deploy-verdict");

    // the honest never-settled path is a well-formed deploy-verdict: pass:false, UNSETTLED, deadline_exceeded:true
    const unsettled = store.write({
      core_type: "Verdict", domain_type: "deploy-verdict", domain: "preview-deploy",
      gig_id: "g-dv2", agent_slug: "deploy-agent", primitive: "VERIFY",
      data: {
        checks: [{ method: "poll budget spent", target_ref: "dpl_2", result: "no terminal readyState" }],
        target_ref: "dpl_2", pass: false, terminal_state: "UNSETTLED", deadline_exceeded: true,
        logs_tail: ["still BUILDING at poll 24"],
      },
    });
    expect((unsettled.data as any).deadline_exceeded).toBe(true);

    // terminal_state dropped → rejected.
    expect(() => store.write({
      core_type: "Verdict", domain_type: "deploy-verdict", domain: "preview-deploy",
      gig_id: "g-dv3", agent_slug: "deploy-agent", primitive: "VERIFY",
      data: { checks: [{ method: "m", target_ref: "t", result: "r" }], target_ref: "t", pass: true, deadline_exceeded: false },
    })).toThrow(OutputStoreError);
  });

  it("branch-state extends Signal and enforces branch + commit_sha", () => {
    const dt = readJson("domain_types/branch-state.json");
    expect(dt.extends).toBe("Signal");
    const store = createOutputStore(reg);
    const ok = store.write({
      core_type: "Signal", domain_type: "branch-state", domain: "preview-deploy",
      gig_id: "g-bs", agent_slug: "deploy-scout", primitive: "SENSE",
      data: { source: "git://HEAD", branch: "feat/x", commit_sha: "9fceb02", project_id: "prj_1" },
    });
    expect(ok.domain_type).toBe("branch-state");
    expect(() => store.write({
      core_type: "Signal", domain_type: "branch-state", domain: "preview-deploy",
      gig_id: "g-bs2", agent_slug: "deploy-scout", primitive: "SENSE",
      data: { source: "git://HEAD", branch: "feat/x" }, // commit_sha dropped
    })).toThrow(OutputStoreError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The deploy-agent: exactly one narrow WebFetch grant, a turn cap, and the two
// institution-bound Vercel credential slots on its carried skill.
// ─────────────────────────────────────────────────────────────────────────────
describe("preview-deploy: the deploy-agent holds least authority", () => {
  it("declares exactly one WebFetch(api.vercel.com) grant and a positive turn cap", () => {
    const a = readJson("agents/deploy-agent.json");
    expect(a.allowed_tools).toEqual(["WebFetch(https://api.vercel.com/*)"]);
    expect(a.max_tool_calls).toBeTypeOf("number");
    expect(a.max_tool_calls).toBeGreaterThan(0);
    expect(a.primitives).toEqual(["CREATE", "VERIFY"]);
  });

  it("carries the vercel-api skill with vercel_token + vercel_team_id as institution-bound required slots", () => {
    const a = readJson("agents/deploy-agent.json");
    const skill = (a.skills ?? []).find((s: any) => s.slug === "vercel-api");
    expect(skill, "deploy-agent must CARRY the vercel-api skill so the dead-slot check sees its hydration").toBeTruthy();
    for (const slot of ["vercel_token", "vercel_team_id"]) {
      expect(skill.hydration?.[slot]?.required).toBe(true);
      expect(skill.hydration?.[slot]?.binding).toBe("institution");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// composeStandard(preview-deploy-v1): output_types includes preview-deployment, and
// the standard REFUSES when a deploy chair supplies neither Vercel credential (dead slot).
// ─────────────────────────────────────────────────────────────────────────────
describe("preview-deploy: the standard composes and fails closed on an unfilled credential slot", () => {
  function resolveDef(): any {
    const def = readJson("standards/preview-deploy-v1.json");
    const agents: Agent[] = (def.agent_slugs as string[]).map((s) => {
      const a = genome.agents.get(s);
      if (!a) throw new Error(`test setup: agent ${s} not in genome`);
      return a;
    });
    return { def, agents };
  }

  it("the loaded standard declares preview-deployment in output_types", () => {
    const std = genome.standards.get("preview-deploy-v1")!;
    expect(std.output_types).toContain("preview-deployment");
    expect(std.output_types).toContain("deploy-verdict");
  });

  it("composeStandard succeeds with the credential slots supplied", () => {
    const { def, agents } = resolveDef();
    const std = composeStandard({ ...def, agents });
    expect(std.slug).toBe("preview-deploy-v1");
  });

  it("composeStandard refuses when the deploy chair supplies no Vercel credentials — a dead slot", () => {
    const { def, agents } = resolveDef();
    // strip the supplies off every chair — the carried skill's required institution slots go dead.
    const stripped = {
      ...def,
      agents,
      phases: def.phases.map((p: any) => ({
        ...p,
        chairs: p.chairs.map((c: any) => {
          const { supplies, ...rest } = c;
          return rest;
        }),
      })),
    };
    expect(() => composeStandard(stripped)).toThrow(/dead slot|hydration|vercel/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// composeChart(software-delivery-v2): three movements, the m2→m3 preview-deployment
// hard edge, the preview-approval gate that does not collide with software-change-v1's
// within-movement 'approve' chair (R8).
// ─────────────────────────────────────────────────────────────────────────────
describe("preview-deploy: the chart arranges change → preview → promote behind a gate", () => {
  function composeInput(chart: any) {
    return {
      chart,
      standards: genome.standards,
      agents: genome.agents,
      venues: genome.venues,
      payload_types: ["change-request"],
    };
  }

  it("composeChart succeeds and classifies the m2→m3 preview-deployment edge as hard", () => {
    const chart = readJson("charts/software-delivery-v2.json");
    const res = composeChart(composeInput(chart));
    expect(res.ok, JSON.stringify((res as any).violations ?? [], null, 2)).toBe(true);
    if (!res.ok) return;
    const m2m3 = res.edges_classified.find((e) => e.from_movement === "movement-2" && e.to_movement === "movement-3");
    expect(m2m3?.output_type).toBe("preview-deployment");
    expect(m2m3?.kind).toBe("hard");
    // the gate is keyed distinct from software-change-v1's within-movement human 'approve' chair
    expect(chart.approval_gates[0].gate_id).toBe("preview-approval");
    expect(chart.approval_gates[0].gate_id).not.toBe("approve");
  });

  it("R8 fires when a gate_id collides with the within-movement 'approve' human chair", () => {
    const chart = readJson("charts/software-delivery-v2.json");
    // move the gate to sit around movement-1 (software-change-v1, which HAS a human 'approve'
    // chair) and name it 'approve' — the exact collision R8 exists to refuse.
    const bad = {
      ...chart,
      approval_gates: [{ gate_id: "approve", after_movement: "movement-1", before_movement: "movement-2", chair: "approve" }],
    };
    const res = composeChart(composeInput(bad));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.violations.some((v) => v.rule === "R8")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The vercel-api skill: the deterministic terminal-state / deadline logic, proven by
// its fixtures. The build wait is a bounded poll, not a subprocess — this is the pure
// resolution the agent's WebFetch observations feed into.
// ─────────────────────────────────────────────────────────────────────────────
describe("preview-deploy: the vercel-api skill resolves terminal state deterministically", () => {
  it("its fixtures pass and are deterministic (pure, no I/O)", () => {
    const report = runSkillFixtures(VERCEL_SKILL);
    expect(report.total).toBeGreaterThan(0);
    expect(report.pass_rate, JSON.stringify(report.results)).toBe(1.0);
    expect(report.deterministic).toBe(true);
  });

  it("READY within budget → pass:true, no deadline, no logs_tail", () => {
    const r = executeSkill(VERCEL_SKILL, { polls: ["QUEUED", "BUILDING", "READY"], max_polls: 24 });
    expect(r.ok, r.error).toBe(true);
    expect((r.output as any).terminal_state).toBe("READY");
    expect((r.output as any).pass).toBe(true);
    expect((r.output as any).deadline_exceeded).toBe(false);
    expect((r.output as any).logs_tail).toBeUndefined();
  });

  it("ERROR terminal → pass:false with a logs_tail", () => {
    const r = executeSkill(VERCEL_SKILL, { polls: ["QUEUED", "BUILDING", "ERROR"], max_polls: 24, logs_tail: ["Type error: TS2322"] });
    expect(r.ok, r.error).toBe(true);
    expect((r.output as any).terminal_state).toBe("ERROR");
    expect((r.output as any).pass).toBe(false);
    expect((r.output as any).logs_tail).toEqual(["Type error: TS2322"]);
  });

  it("poll budget spent with no terminal readyState → UNSETTLED + deadline_exceeded:true", () => {
    const r = executeSkill(VERCEL_SKILL, { polls: ["QUEUED", "BUILDING", "BUILDING"], max_polls: 3 });
    expect(r.ok, r.error).toBe(true);
    expect((r.output as any).terminal_state).toBe("UNSETTLED");
    expect((r.output as any).deadline_exceeded).toBe(true);
    expect((r.output as any).pass).toBe(false);
  });
});
