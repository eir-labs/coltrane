// A SPELLING OR A CASE NEVER WIDENS A GRANT, AND NEVER HIDES A PROTECTED PATH.
//
// Four wires survived the implementer's round-5 mutation run:
//   1. LITERAL `./` / `//` GRANTS. The CLI silently rewrites `./**` to `**` and `src//a` to `src/a`
//      (tests/support/cli_scope_oracle.ts). The implementer chose to REFUSE such a literal Write/Edit
//      rather than normalise it — but nothing seated one and expected the refusal.
//   2. THE SAME SPELLINGS IN A LAYOUT. LayoutSchema refuses a path glob with a leading `./` or any `//`;
//      nothing loaded such a layout and expected the load_error.
//   3. CASE — see the_engine_matches_scopes_as_the_cli_does (uppercase rows and a mixed-case corpus).
//   4. CASE IN THE PROTECTED SET. The CLI's matcher is case-insensitive, and so are the file systems it
//      most often runs on (macOS, Windows): `.GIT/config` IS `.git/config` there. A case-sensitive
//      `isProtectedPath` would let `.GIT/config`, `.Claude/settings.json`, `.COLTRANE/x` or
//      `COLTRANE.LAYOUT.JSON` through as a target and past the diff gate.
//
//   law                                                   kind         drives                                    plant
//   literal Write(./**) / Write(src//a) refused at        behavioural  runGig preflight → resolveSeatGrants —     drop the literal-scope refusal (isAmbiguousSpelling)
//   dispatch, naming the grant, nothing invoked                        src/runtime.ts, src/layout_grants.ts      in resolveSeatGrants
//   …and by the Claude invoker, nothing spawned            behavioural  makeClaudeInvoker(...) argv               same
//   a layout glob ./src/** or src//** is a load_error      behavioural  loadGenome → LayoutSchema —               admit `./` and `//` in LayoutGlobsSchema's refine
//   naming the glob                                                    src/loader.ts, src/genome_schema.ts
//   upper-case protected targets are never granted         behavioural  resolveSeatGrants — src/layout_grants.ts  isProtectedPath case-sensitive (drop toLowerCase)
//   upper-case protected paths are denied to reaching      behavioural  same (denials)                           match protected paths case-sensitively
//   grants
//   the diff gate never excuses an upper-case protected    behavioural  runGig — src/runtime.ts (diff gate,      isProtectedPath case-sensitive
//   path                                                               inWriteScope)
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeClaudeInvoker, createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker, type Agent } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { loadGenome } from "../src/loader.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { loadLayoutGrants, genomeTree, type Layout } from "./layout_grants_fixtures.js";

const agentOf = (allowed_tools: string[]): Agent =>
  testAgent({ slug: "impl", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", allowed_tools });
const standardOf = (a: Agent): Standard => ({
  slug: "s-v1", domain: "demo", agents: [a],
  phases: [{ name: "p", chairs: [{ role: "impl", agent_slug: "impl", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
}) as unknown as Standard;

async function run(a: Agent, gigInput: Record<string, unknown>, deps: Record<string, unknown>, act: () => void = () => {}) {
  const registry = createRegistry();
  registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
  const outputs = createOutputStore(registry);
  let invoked = 0;
  const invoke: AgentInvoker = () => { invoked += 1; act(); return { ...coreInvariantFields("Signal"), value: "done" }; };
  let said = "";
  try {
    said = JSON.stringify(await runGig(standardOf(a), gigInput, { outputs, ledger: new MemoryLedger(), invoke, ...deps } as never));
  } catch (e) {
    said = String((e as Error)?.message ?? e);
  }
  return { invoked, said, sealed: outputs.all().filter((o) => (o as { agent_slug?: string }).agent_slug === "impl") };
}

describe("1 — a literal Write/Edit spelled `./` or `//` is refused, never seated", () => {
  for (const g of ["Write(./**)", "Write(src//a)", "Edit(./src/**)"]) {
    it(`${g}: refused at dispatch, naming the grant — the seat is never invoked`, async () => {
      const r = await run(agentOf(["Read", g]), { request_text: "x" }, {});
      expect(r.invoked, `a seat holding ${g} — which the CLI reads wider than it is written — was invoked`).toBe(0);
      expect(r.said, `the refusal does not name ${g}: ${r.said.slice(0, 200)}`).toContain(g);
    });
  }

  it("the Claude invoker refuses Write(./**) before the spawn", async () => {
    let spawned = false;
    const invoke = makeClaudeInvoker({ toolProviders: new Map(), mcpServerConfigs: {}, run: () => { spawned = true; return "{}"; } });
    let err = "";
    try {
      await invoke({ agent: agentOf(["Read", "Write(./**)"]), phase: "p", inputs: [], gig_input: { request_text: "x" }, tree_root: "/srv/t" } as unknown as AgentInvocationContext);
    } catch (e) { err = String((e as Error)?.message ?? e); }
    expect(spawned, "a seat holding Write(./**) — `**` to the CLI — was spawned").toBe(false);
    expect(err).toContain("Write(./**)");
  });

  it("control — the same scopes spelled plainly are seated", async () => {
    const r = await run(agentOf(["Read", "Write(src/**)", "Write(src/a)"]), { request_text: "x" }, {});
    expect(r.invoked, `plainly spelled literals were refused: ${r.said.slice(0, 200)}`).toBe(1);
  });
});

describe("2 — a layout glob spelled `./` or `//` is a load_error naming it", () => {
  for (const glob of ["./src/**", "src//**", "./**"]) {
    it(`source: ["${glob}"] → load_error naming "${glob}", and no layout`, () => {
      const g = loadGenome(genomeTree({ layout: { paths: { source: [glob] } } }));
      const errs = g.load_errors.filter((e) => e.path.endsWith("coltrane.layout.json"));
      expect(errs.length, `a layout glob the CLI reads wider (${glob}) loaded without a load_error`).toBeGreaterThan(0);
      expect((g as unknown as { layout?: unknown }).layout, "the layout was half-read").toBeUndefined();
      expect(JSON.stringify(errs), "the load_error does not say which glob, or why").toMatch(/\.\/|\/\/|plainly spelled/);
    });
  }

  it("control — `src/**` loads", () => {
    const g = loadGenome(genomeTree({ layout: { paths: { source: ["src/**"] } } }));
    expect(g.load_errors).toEqual([]);
  });
});

const UPPER = [".GIT/config", ".Claude/settings.json", ".COLTRANE/x", "COLTRANE.LAYOUT.JSON"];

describe("4 — case never hides a protected path", () => {
  it("upper-cased protected targets are never granted — not even to a bare Write", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: agentOf(["Write"]), target_paths: [...UPPER, "src/a.ts"] });
    expect(r.grants, "non-vacuity: the plain target is granted").toContain("Write(src/a.ts)");
    expect(r.grants.filter((g) => g !== "Write(src/a.ts)"), "an upper-cased spelling of a protected path became a grant").toEqual([]);
  });

  it("an upper-cased grant reaching a protected path is denied it (Write(.GIT/**), Write(.Claude/*), Write(COLTRANE.LAYOUT.JSON))", async () => {
    const L = await loadLayoutGrants();
    const cases: Array<[string, string]> = [["Write(.GIT/**)", "Write(.git/**)"], ["Write(.Claude/*)", "Write(.claude/**)"], ["Write(COLTRANE.LAYOUT.JSON)", "Write(coltrane.layout.json)"], ["Write(.COLTRANE/x)", "Write(.coltrane/**)"]];
    for (const [grant, deny] of cases) {
      const r = L.resolveSeatGrants({ agent: agentOf([grant]) });
      expect(r.denials, `${grant} reaches a protected path at the (case-insensitive) CLI and was not denied it`).toContain(deny);
    }
  });

  describe("the diff gate never excuses an upper-cased protected path", () => {
    function tree(git: boolean): string {
      const root = mkdtempSync(join(tmpdir(), "case-gate-"));
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "a.ts"), "a\n");
      if (git) {
        const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
        execFileSync("git", ["init", "--quiet", "--initial-branch=main", root]);
        execFileSync("git", ["-C", root, "add", "-A"], { env });
        execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "seed"], { env });
      }
      return root;
    }
    const WIDE: Layout = { paths: { source: ["**"] } };
    // .GIT is judged in a NON-git tree (the gate reads the filesystem there): in a git tree on a
    // case-folding file system `.GIT` IS the real `.git`, which `git status` never lists.
    for (const [path, git] of [[".GIT/config", false], [".Claude/settings.json", true], [".COLTRANE/x", true], ["COLTRANE.LAYOUT.JSON", true]] as Array<[string, boolean]>) {
      it(`a Write(**) seat that writes ${path} is refused, and nothing it made is sealed`, async () => {
        const root = tree(git);
        const r = await run(agentOf(["Read", "Write(@source)"]), { request_text: "x" }, { layout: WIDE, tree_root: root }, () => {
          const parts = path.split("/");
          if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
          writeFileSync(join(root, ...parts), "{}\n");
        });
        expect(r.invoked, "non-vacuity: the seat ran").toBe(1);
        expect(r.sealed, `${path} was excused by the gate — a case spelling hid a protected path`).toHaveLength(0);
        expect(r.said.toLowerCase(), "the refusal does not name the path").toContain(path.toLowerCase());
      });
    }
  });
});
