// EDGE CASES FAIL CLOSED (the conductor's rulings, 26 Sep).
//
//   · target_paths: [] — PRESENT but empty. The change names no path, so Write/Edit grant NOTHING, and
//     the result says the target narrowing WAS applied. Reading [] as "absent" would hand a seat the
//     whole source for a change that named no file.
//   · A layout role declared as an EMPTY list. LayoutSchema refuses it (min 1), so the file is a
//     load_error — never a role that silently answers "nothing" to one token and passes review as
//     declared.
//   · A target_paths entry carrying glob metacharacters (* ? [ {). target_paths are PATHS; a glob in one
//     would become a grant pattern and widen the seat through the payload. The chair is refused at
//     dispatch, naming the entry.
//
//   law                                          kind         drives                                    plant
//   [] grants no Write/Edit, applied: true       behavioural  resolveSeatGrants — src/layout_grants.ts  treat target_paths.length === 0 as absent
//   empty role list refused by the schema        behavioural  LayoutSchema — src/genome_schema.ts       drop .min(1) from the role lists
//   empty role list is a load_error              behavioural  loadGenome — src/loader.ts                same plant
//   a globbed target refuses the chair           behavioural  runGig — src/runtime.ts                   skip the metacharacter check on
//                                                                                                       gig_input.target_paths
import { describe, it, expect } from "vitest";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker } from "../src/index.js";
import { loadGenome } from "../src/loader.js";
import { loadLayoutGrants, layoutSchema, genomeTree, TS_LAYOUT } from "./layout_grants_fixtures.js";

const implementer = testAgent({
  slug: "implementer", primitives: ["CREATE"], input_types: [], output_types: ["note"], domain: "demo",
  allowed_tools: ["Read", "Write(@source)", "Edit(src/**)", "Bash(@laws)"],
});

describe("target_paths: [] — present but empty", () => {
  it("grants no Write and no Edit, keeps Read and the laws command, and records target_paths_applied: true", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: implementer, layout: TS_LAYOUT, target_paths: [] });
    expect(r.target_paths_applied, "an empty target list was treated as no target list").toBe(true);
    expect(r.grants.filter((g) => /^(Write|Edit)\b/.test(g)), "a change that names no path was handed write access").toEqual([]);
    expect([...r.grants].sort(), "non-write grants must survive an empty target list").toEqual(["Bash(npx vitest run:*)", "Read"]);
  });
});

describe("a layout role declared as an empty list", () => {
  it("LayoutSchema refuses an empty path role and an empty command role (min 1)", () => {
    const S = layoutSchema();
    expect(S.safeParse({ paths: { source: ["src/**"] } }).success, "non-vacuity: a one-glob role is admitted").toBe(true);
    expect(S.safeParse({ paths: { source: [] } }).success, "an empty path role was admitted").toBe(false);
    expect(S.safeParse({ commands: { laws: [] } }).success, "an empty command role was admitted").toBe(false);
  });

  it("the loader turns it into a load_error and carries no layout", () => {
    const g = loadGenome(genomeTree({ layout: { paths: { source: [] } } }));
    expect(g.load_errors.some((e) => e.path.endsWith("coltrane.layout.json")), "an empty role loaded without a load_error").toBe(true);
    expect((g as unknown as { layout?: unknown }).layout).toBeUndefined();
  });
});

describe("a target_paths entry with glob metacharacters refuses the chair at dispatch", () => {
  const standard = {
    slug: "change-v1", domain: "demo", agents: [implementer],
    phases: [{ name: "p", chairs: [{ role: "impl", agent_slug: "implementer", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
  } as unknown as Standard;

  async function dispatch(target_paths: string[]): Promise<{ invoked: number; said: string }> {
    const registry = createRegistry();
    registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
    let invoked = 0;
    const invoke: AgentInvoker = () => { invoked += 1; return { ...coreInvariantFields("Signal"), value: "done" }; };
    let said = "";
    try {
      said = JSON.stringify(await runGig(standard, { request_text: "x", target_paths }, {
        outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, layout: TS_LAYOUT,
      } as never));
    } catch (e) {
      said = String((e as Error)?.message ?? e);
    }
    return { invoked, said };
  }

  it("control — plain paths dispatch", async () => {
    const { invoked } = await dispatch(["src/a.ts", "src/b.ts"]);
    expect(invoked).toBe(1);
  });

  for (const entry of ["src/*.ts", "src/a?.ts", "src/[ab].ts", "src/{a,b}.ts"]) {
    it(`"${entry}" is refused, by name, before any seat is invoked`, async () => {
      const { invoked, said } = await dispatch(["src/ok.ts", entry]);
      expect(invoked, `a globbed target (${entry}) was handed to a seat`).toBe(0);
      expect(said, `the refusal does not name the offending entry: ${said.slice(0, 300)}`).toContain(entry);
    });
  }
});
