// Nested test-case specs — the recursion that lets one generated artifact serve as a
// case at multiple pyramid layers. A TopologySpec is a small DAG of nodes; materialize()
// turns it into REAL coltrane artifacts (domain types + agents + a composed Standard +
// a registry/store/ledger). The agents are unit cases (assert their prompt/cage); the
// Standard is an integration case (run it through a deterministic invoker, assert the
// coordination invariants). Same spec, two layers.
import {
  composeStandard,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type Agent,
  type Standard,
  type DomainType,
  type Primitive,
  type BelbinRole,
  type Registry,
  type OutputStore,
  type Ledger,
} from "../../src/index.js";
import { testAgent } from "./agents.js";

// process primitive → the core type it outputs, and a Belbin disposition (for unit variety)
const CORE: Record<string, string> = {
  SENSE: "Signal", INTERPRET: "Interpretation", JUDGE: "Judgment",
  PLAN: "Plan", CREATE: "Artifact", VERIFY: "Verdict",
};
const DISPOSITION: Record<string, readonly [BelbinRole, BelbinRole]> = {
  SENSE: ["explorer", "analyst"], INTERPRET: ["analyst", "synthesizer"], JUDGE: ["critic", "analyst"],
  PLAN: ["planner", "synthesizer"], CREATE: ["executor", "planner"], VERIFY: ["critic", "executor"],
};

export interface NodeSpec {
  role: string;              // chair role + agent slug
  primitive: Primitive;      // its cognitive step (drives output type + disposition)
  phase: string;             // which phase it sits in
  depends_on?: string[];     // upstream roles — input types are derived from these
  tier?: "economy" | "standard" | "premium"; // optional, for unit-slice variety
}
export interface TopologySpec {
  name: string;
  nodes: NodeSpec[];
  valid: boolean;            // true → composes + runs; false → must fail closed
}

export interface MaterializedGenome {
  agents: Agent[];
  std: Standard;
  registry: Registry;
  outputs: OutputStore;
  ledger: Ledger;
}

// One shared domain type per PRIMITIVE (not per role): same-primitive nodes legitimately
// produce the same type, so the registry's type-reuse gate is satisfied. A node's input
// types are derived from the types its depends_on upstream produce.
const typeFor = (p: string): string => `gen-${(CORE[p] ?? "Signal").toLowerCase()}`;

/** Turn a TopologySpec into real coltrane artifacts. Throws (via composeStandard) for an
 *  invalid topology — that throw IS the integration "fail-closed" assertion. */
export function materialize(topo: TopologySpec): MaterializedGenome {
  const byRole = new Map(topo.nodes.map((n) => [n.role, n]));
  const inputTypes = (n: NodeSpec): string[] =>
    [...new Set((n.depends_on ?? []).map((r) => typeFor(byRole.get(r)!.primitive)))];

  const registry = createRegistry();
  const registered = new Set<string>();
  for (const n of topo.nodes) {
    const slug = typeFor(n.primitive);
    if (registered.has(slug)) continue;
    registered.add(slug);
    const dt: DomainType = {
      slug, extends: CORE[n.primitive] ?? "Signal", domain: "gen",
      schema: { properties: { value: { type: "string" } } }, required_fields: ["value"],
    };
    registry.registerType(dt);
  }
  const agents: Agent[] = topo.nodes.map((n) =>
    testAgent({
      slug: n.role,
      primitives: [n.primitive],
      input_types: inputTypes(n),
      output_types: [typeFor(n.primitive)],
      domain: "gen",
      behavioral_primitives: DISPOSITION[n.primitive] ?? (["analyst", "synthesizer"] as [BelbinRole, BelbinRole]),
      ...(n.tier ? { model_tier: n.tier } : {}),
    }),
  );
  const phaseNames = [...new Set(topo.nodes.map((n) => n.phase))];
  const phases = phaseNames.map((pn) => ({
    name: pn,
    chairs: topo.nodes
      .filter((n) => n.phase === pn)
      .map((n) => ({
        role: n.role,
        agent_slug: n.role,
        depends_on: n.depends_on ?? [],
        input_contract: inputTypes(n),
        output_contract: [typeFor(n.primitive)],
        required_skills: [] as string[],
      })),
  }));
  const std = composeStandard({ slug: topo.name, domain: "gen", agents, phases });
  return { agents, std, registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

// ── Combinatorial topology generator ─────────────────────────────────────────────
// Valid primitive progressions (legal paths through the cognitive DAG) × structural
// shapes (linear / fan-out / fan-in) → a matrix of coordination topologies. Each is a
// real, runnable standard; the cross-product gives combinatorial coverage of shapes.
const PROGRESSIONS: Primitive[][] = [
  ["SENSE", "INTERPRET"],
  ["SENSE", "INTERPRET", "JUDGE"],
  ["SENSE", "INTERPRET", "PLAN", "CREATE"],
  ["INTERPRET", "CREATE"],
  ["SENSE", "INTERPRET", "CREATE", "VERIFY"],
];
type Shape = "linear" | "fan-out" | "fan-in";
const SHAPES: Shape[] = ["linear", "fan-out", "fan-in"];
const TIERS = ["economy", "standard", "premium"] as const;
const slug = (p: string): string => p.toLowerCase();

function buildTopology(prog: Primitive[], shape: Shape): TopologySpec {
  const name = `${shape}__${prog.map(slug).join("-")}`;
  const tierOf = (i: number) => TIERS[i % TIERS.length]!; // spread tiers for unit variety
  const nodes: NodeSpec[] = [];

  if (shape === "linear") {
    prog.forEach((p, i) =>
      nodes.push({ role: `n${i}`, primitive: p, phase: `p${i}`, tier: tierOf(i), ...(i > 0 ? { depends_on: [`n${i - 1}`] } : {}) }),
    );
  } else if (shape === "fan-out") {
    // chain all but the last; the last primitive fans into two parallel chairs
    prog.slice(0, -1).forEach((p, i) =>
      nodes.push({ role: `n${i}`, primitive: p, phase: `p${i}`, tier: tierOf(i), ...(i > 0 ? { depends_on: [`n${i - 1}`] } : {}) }),
    );
    const li = prog.length - 1;
    for (const tag of ["a", "b"]) nodes.push({ role: `n${li}${tag}`, primitive: prog[li]!, phase: `p${li}`, depends_on: [`n${li - 1}`] });
  } else {
    // fan-in: the first primitive has two parallel sources; the 2nd merges both
    for (const tag of ["a", "b"]) nodes.push({ role: `n0${tag}`, primitive: prog[0]!, phase: "p0" });
    prog.slice(1).forEach((p, i) => {
      const idx = i + 1;
      nodes.push({ role: `n${idx}`, primitive: p, phase: `p${idx}`, tier: tierOf(idx), depends_on: idx === 1 ? ["n0a", "n0b"] : [`n${idx - 1}`] });
    });
  }
  return { name, nodes, valid: true };
}

/** The generated topology matrix: every (progression × shape) valid standard, plus a few
 *  deliberately-illegal shapes that must fail closed at compose time. */
export function genTopologies(): TopologySpec[] {
  const valid = PROGRESSIONS.flatMap((prog) => SHAPES.map((shape) => buildTopology(prog, shape)));
  const invalid: TopologySpec[] = [
    { name: "illegal__lone-create", valid: false, nodes: [{ role: "create", primitive: "CREATE", phase: "p1" }] },
    { name: "illegal__lone-verify", valid: false, nodes: [{ role: "verify", primitive: "VERIFY", phase: "p1" }] },
    { name: "illegal__create-before-reason", valid: false, nodes: [
      { role: "sense", primitive: "SENSE", phase: "p1" },
      { role: "create", primitive: "CREATE", phase: "p2", depends_on: ["sense"] },
    ] },
  ];
  return [...valid, ...invalid];
}

export const TOPOLOGIES: TopologySpec[] = genTopologies();
