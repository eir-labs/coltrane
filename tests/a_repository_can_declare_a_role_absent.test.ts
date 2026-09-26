// A REPOSITORY CAN DECLARE A ROLE ABSENT — and only an explicit declaration excuses it.
//
// The blocker (chancery #112; layouts in lighthouse-classic #17, coltrane-ui #256, cognition #18): a role
// token nobody answers refuses the WHOLE chair, and the schema had no way to say "this repository has no
// such role". Real repositories lack roles the shared agents hold — migrations (lighthouse-classic,
// cognition, chancery), ship_dry (coltrane-ui, cognition, chancery), build and scripts (cognition) — so every
// chair of, say, a code-implementer holding Write(@migrations) is refused there.
//
// THE CONTRACT (the conductor's): a DECLARED ABSENCE. In LayoutSchema a role set to `null` — in paths,
// commands, git.* and egress alike — means "this repository has none".
//   · a token for a declared-absent role grants NOTHING and does NOT refuse the chair; the resolver and
//     the chair's record carry it as `absent_by_declaration: [{ token, role }]`;
//   · an UNDECLARED role (the key missing entirely) still fails closed and refuses the chair;
//   · an empty list stays refused (min 1) — absence is only ever the explicit `null`.
//
//   law                                                         kind         drives                                        plant
//   LayoutSchema admits null for a role in paths, commands,      behavioural  LayoutSchema — src/genome_schema.ts           (red at head: null is refused)
//   git.* and egress; still refuses []
//   a declared-absent token grants nothing, refuses nothing,     behavioural  resolveSeatGrants — src/layout_grants.ts       null refuses the chair (treat null as undeclared)
//   and is recorded
//   an undeclared role still refuses the chair                   behavioural  same                                          missing == null (treat a missing key as declared absent)
//   no grant ever results from null (property)                   behavioural  same                                          expand null as `**` / as the empty-string prefix
//   git.push: null — Bash(@git_push) grants nothing, no refusal  behavioural  same                                          null refuses the chair
//   egress.publish: null — no host, the chair still seats       behavioural  makeClaudeInvoker(...) argv — src/claude_      null egress opens every host / refuses the chair
//                                                                             invoker.ts (sandbox.network)
//   runGig seats the chair and chair_complete records the       behavioural  runGig — src/runtime.ts                        drop absent_by_declaration from the record / refuse
//   absence; an undeclared role is refused at dispatch
//   each real layout (4 draft PRs), with its declared            behavioural  LayoutSchema + resolveSeatGrants over the      null refuses / missing == null
//   absences, validates and seats chancery's agents                          vendored drafts and chancery #112's agents
//   …and as published (no null), the same agents fail closed    behavioural  same                                          missing == null
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeClaudeInvoker, createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker, type Agent, type GigProgressEvent } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { loadLayoutGrants, layoutSchema, settingsOf, type Layout } from "./layout_grants_fixtures.js";

type Absent = { token: string; role: string };
type SeatGrantsR8 = { grants: string[]; refusals: Array<{ token: string; role: string }>; absent_by_declaration?: Absent[] };
const L8 = async () => (await loadLayoutGrants()) as unknown as { resolveSeatGrants(a: Record<string, unknown>): SeatGrantsR8 };
const agentOf = (allowed_tools: string[], slug = "impl"): Agent =>
  testAgent({ slug, primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", allowed_tools });

const WITH_ABSENCE = { paths: { source: ["src/**"], migrations: null }, commands: { laws: ["npx vitest run"], ship_dry: null } } as unknown as Layout;
const UNDECLARED = { paths: { source: ["src/**"] }, commands: { laws: ["npx vitest run"] } } as unknown as Layout;

describe("LayoutSchema: null is a declared absence; [] is still refused", () => {
  const S = () => layoutSchema();
  for (const [where, layout] of [
    ["paths.migrations", { paths: { source: ["src/**"], migrations: null } }],
    ["commands.ship_dry", { commands: { test: ["npm test"], ship_dry: null } }],
    ["git.push", { git: { stage: ["git add"], push: null } }],
    ["egress.publish", { commands: { publish: ["gh pr create"] }, egress: { publish: null } }],
  ] as Array<[string, unknown]>) {
    it(`${where}: null is admitted`, () => {
      expect(S().safeParse(layout).success, `a declared absence (${where}: null) was refused — the schema still cannot say "this repo has none"`).toBe(true);
    });
  }
  it("an empty list is still refused — absence is only ever the explicit null", () => {
    expect(S().safeParse({ paths: { migrations: [] } }).success).toBe(false);
    expect(S().safeParse({ commands: { ship_dry: [] } }).success).toBe(false);
  });
});

describe("the resolver: a declared absence grants nothing and refuses nothing; an undeclared role still refuses", () => {
  it("Write(@migrations) and Bash(@ship_dry) under declared absences: no grant, no refusal, both recorded", async () => {
    const L = await L8();
    const r = L.resolveSeatGrants({ agent: agentOf(["Read", "Write(@source)", "Write(@migrations)", "Bash(@ship_dry)"]), layout: WITH_ABSENCE });
    expect(r.refusals, `a declared absence refused the chair: ${JSON.stringify(r.refusals)}`).toEqual([]);
    expect([...r.grants].sort(), "a grant resulted from a declared absence").toEqual(["Read", "Write(src/**)"]);
    expect(r.absent_by_declaration, "the result does not record the declared absence").toEqual(
      expect.arrayContaining([{ token: "Write(@migrations)", role: "migrations" }, { token: "Bash(@ship_dry)", role: "ship_dry" }]),
    );
  });

  it("the same tokens under a layout that simply LACKS the keys: refused, naming the roles — missing is not null", async () => {
    const L = await L8();
    const r = L.resolveSeatGrants({ agent: agentOf(["Read", "Write(@source)", "Write(@migrations)", "Bash(@ship_dry)"]), layout: UNDECLARED });
    expect(r.refusals.map((x) => x.role).sort(), "an undeclared role was treated as declared absent").toEqual(["migrations", "ship_dry"]);
    expect(r.absent_by_declaration ?? [], "an undeclared role was recorded as a declared absence").toEqual([]);
  });

  it("git.push: null — Bash(@git_push) grants nothing and does not refuse; git.stage still expands", async () => {
    const L = await L8();
    const r = L.resolveSeatGrants({ agent: agentOf(["Bash(@git_stage)", "Bash(@git_push)"]), layout: { git: { stage: ["git add"], push: null } } as unknown as Layout });
    expect(r.refusals).toEqual([]);
    expect(r.grants).toEqual(["Bash(git add:*)"]);
    expect(r.absent_by_declaration).toEqual([{ token: "Bash(@git_push)", role: "git_push" }]);
  });

  it("property: no grant ever results from a null role, and a null role never refuses", async () => {
    const L = await L8();
    const PATH_ROLES = ["source", "tests", "migrations", "scripts", "docs"];
    const CMD_ROLES = ["build", "test", "laws", "ship_dry", "publish"];
    fc.assert(
      fc.property(fc.subarray(PATH_ROLES), fc.subarray(CMD_ROLES), (nullPaths, nullCmds) => {
        const paths = Object.fromEntries(PATH_ROLES.map((r) => [r, nullPaths.includes(r) ? null : [`${r}/**`]]));
        const commands = Object.fromEntries(CMD_ROLES.map((r) => [r, nullCmds.includes(r) ? null : [`run-${r}`]]));
        const tokens = [...PATH_ROLES.map((r) => `Write(@${r})`), ...CMD_ROLES.map((r) => `Bash(@${r})`)];
        const res = L.resolveSeatGrants({ agent: agentOf(tokens), layout: { paths, commands } as unknown as Layout });
        if (res.refusals.length > 0) throw new Error(`a null role refused: ${JSON.stringify(res.refusals)}`);
        for (const r of nullPaths) if (res.grants.some((g) => g.startsWith("Write(") && !PATH_ROLES.filter((x) => !nullPaths.includes(x)).some((x) => g === `Write(${x}/**)`))) throw new Error(`a Write grant came from null role ${r}: ${JSON.stringify(res.grants)}`);
        for (const r of nullCmds) if (res.grants.includes(`Bash(run-${r}:*)`) || res.grants.some((g) => g === "Bash" || g === "Bash(:*)")) throw new Error(`a Bash grant came from null role ${r}`);
        if (res.grants.length !== (PATH_ROLES.length - nullPaths.length) + (CMD_ROLES.length - nullCmds.length)) throw new Error(`grant count ${res.grants.length} ≠ the non-null roles`);
        return true;
      }),
      { numRuns: 300 },
    );
  });
});

describe("the spawn and the dispatch", () => {
  it("egress.publish: null — a seat holding Bash(@publish) spawns with no network host, and is not refused", async () => {
    let args: string[] | undefined;
    const invoke = makeClaudeInvoker({ toolProviders: new Map(), mcpServerConfigs: {}, run: (_b, a) => { args = a; return "{}"; } });
    let error = "";
    try {
      await invoke({ agent: agentOf(["Bash(@publish)"]), phase: "p", inputs: [], gig_input: { request_text: "x" }, tree_root: "/srv/t",
        layout: { commands: { publish: ["gh pr create"] }, egress: { publish: null } } } as unknown as AgentInvocationContext);
    } catch (e) { error = String((e as Error)?.message ?? e); }
    expect(args, `a declared-absent egress refused the chair: ${error}`).toBeDefined();
    const sb = settingsOf(args!)[0]?.["sandbox"] as { network?: { allowedDomains?: string[] } } | undefined;
    expect(sb?.network?.allowedDomains ?? [], "a null egress opened hosts").toEqual([]);
  });

  async function dispatch(layout: Layout) {
    const registry = createRegistry();
    registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
    const events: GigProgressEvent[] = [];
    let invoked = 0;
    const invoke: AgentInvoker = () => { invoked += 1; return { ...coreInvariantFields("Signal"), value: "x" }; };
    const a = agentOf(["Read", "Write(@source)", "Write(@migrations)", "Bash(@ship_dry)"]);
    const standard = { slug: "s", domain: "demo", agents: [a], phases: [{ name: "p", chairs: [{ role: "impl", agent_slug: "impl", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }] } as unknown as Standard;
    let said = "";
    try { said = JSON.stringify(await runGig(standard, { request_text: "x" }, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, layout, onProgress: (e: GigProgressEvent) => events.push(e) } as never)); }
    catch (e) { said = String((e as Error)?.message ?? e); }
    return { invoked, said, done: events.find((e) => e.type === "chair_complete") as (GigProgressEvent & Record<string, unknown>) | undefined };
  }

  it("runGig seats the chair under declared absences, and chair_complete records them", async () => {
    const r = await dispatch(WITH_ABSENCE);
    expect(r.invoked, `a chair whose absent roles were DECLARED was refused: ${r.said.slice(0, 300)}`).toBe(1);
    expect(r.done?.["absent_by_declaration"], "the chair's record does not show the declared absence").toEqual(
      expect.arrayContaining([{ token: "Write(@migrations)", role: "migrations" }, { token: "Bash(@ship_dry)", role: "ship_dry" }]),
    );
    expect((r.done?.["resolved_grants"] as string[] | undefined)?.sort()).toEqual(["Read", "Write(src/**)"]);
  });

  it("runGig refuses the chair when the roles are merely missing — naming them", async () => {
    const r = await dispatch(UNDECLARED);
    expect(r.invoked, "a chair holding undeclared roles was seated").toBe(0);
    expect(r.said).toMatch(/migrations/);
  });
});

// ── the four real layouts (vendored from the draft PRs) ─────────────────────────────────────────
type Real = { layouts: Record<string, { repo: string; pr: number; head: string; layout: Record<string, Record<string, unknown>> }>; chancery_agents: { allowed_tools: Record<string, string[]> } };
const REAL = JSON.parse(readFileSync(fileURLToPath(new URL("./support/real_layouts.json", import.meta.url)), "utf8")) as Real;
const SECTION_OF = (role: string): "paths" | "commands" | "git" =>
  role.startsWith("git_") ? "git" : ["source", "tests", "migrations", "scripts", "docs"].includes(role) ? "paths" : "commands";
const rolesHeld = (tools: string[]) => tools.map((t) => /\(@([\w-]+)\)$/.exec(t)?.[1]).filter((x): x is string => Boolean(x));

/** The draft, with a declared absence (null) for every role chancery's agents hold that the draft lacks. */
function withDeclaredAbsences(layout: Record<string, Record<string, unknown>>): { layout: Record<string, Record<string, unknown>>; absent: string[] } {
  const out = JSON.parse(JSON.stringify(layout)) as Record<string, Record<string, unknown>>;
  const absent: string[] = [];
  for (const role of new Set(Object.values(REAL.chancery_agents.allowed_tools).flatMap(rolesHeld))) {
    const sec = SECTION_OF(role);
    const key = sec === "git" ? role.slice(4) : role;
    out[sec] ??= {};
    if (out[sec]![key] === undefined) { out[sec]![key] = null; absent.push(role); }
  }
  return { layout: out, absent: absent.sort() };
}

describe("each real repository's layout, with its declared absences, validates and seats chancery's agents", () => {
  const EXPECTED_ABSENT: Record<string, string[]> = {
    chancery: ["migrations", "ship_dry"],
    "lighthouse-classic": ["migrations"],
    "coltrane-ui": ["ship_dry"],
    cognition: ["build", "migrations", "scripts", "ship_dry"],
  };
  for (const [name, real] of Object.entries(REAL.layouts)) {
    const { layout, absent } = withDeclaredAbsences(real.layout);
    it(`${name} (${real.repo}#${real.pr}): the absences it must declare are exactly the ones the conductor named`, () => {
      expect(absent).toEqual(EXPECTED_ABSENT[name]);
    });
    it(`${name}: validates with its declared absences`, () => {
      const r = layoutSchema().safeParse(layout);
      expect(r.success, `${name}'s layout with declared absences is refused: ${JSON.stringify((r as { error?: unknown }).error ?? "").slice(0, 300)}`).toBe(true);
    });
    for (const [slug, tools] of Object.entries(REAL.chancery_agents.allowed_tools)) {
      it(`${name}: ${slug} is seated — no refusal, and every absent role it holds is recorded`, async () => {
        const L = await L8();
        const r = L.resolveSeatGrants({ agent: agentOf(tools, slug), layout: layout as unknown as Layout });
        expect(r.refusals, `${slug} is refused in ${name}: ${JSON.stringify(r.refusals)}`).toEqual([]);
        const heldAbsent = rolesHeld(tools).filter((x) => absent.includes(x)).sort();
        expect((r.absent_by_declaration ?? []).map((x) => x.role).sort()).toEqual(heldAbsent);
      });
    }
    it(`${name} AS PUBLISHED (no null): code-implementer still fails closed on the roles the draft lacks`, async () => {
      const L = await L8();
      const r = L.resolveSeatGrants({ agent: agentOf(REAL.chancery_agents.allowed_tools["code-implementer"]!, "code-implementer"), layout: real.layout as unknown as Layout });
      const lacking = rolesHeld(REAL.chancery_agents.allowed_tools["code-implementer"]!).filter((x) => EXPECTED_ABSENT[name]!.includes(x));
      if (lacking.length === 0) return;
      expect(r.refusals.map((x) => x.role).sort(), "a missing role was excused without a declaration").toEqual(expect.arrayContaining(lacking));
    });
  }
});
