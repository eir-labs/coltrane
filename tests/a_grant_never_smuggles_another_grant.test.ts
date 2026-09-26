// A GRANT NEVER SMUGGLES ANOTHER GRANT PAST THE CLI'S SPLITTER.
//
// Blocking finding 1 of the non-author grade (#553, issuecomment-5847662352). The engine joins a seat's
// grants with `,` into `--allowedTools`; the CLI splits that value back with its own grammar (`Hp` in
// 2.1.283, vendored in tests/support/cli_allowed_tools_splitter.ts): `,` and space split OUTSIDE
// parentheses, `(` enters, and the FIRST `)` leaves — no nesting. A layout entry carrying a `)` therefore
// closes its own grant early, and whatever follows becomes a grant of its own:
//   commands.laws: ["npx vitest run),Write,Bash(true"]  →  Bash(npx vitest run),Write,Bash(true:*)
// — a BARE `Write`, which no target_paths narrow and no protected-path denial covers. A path glob
// `src/**),Write(coltrane.layout.json` does the same through Write(@source).
//
// THE RULE: no layout entry (command prefix or path glob) may contain a character the CLI's grammar
// treats as structure — `(`, `)`, `,` — or leading/trailing whitespace; and every grant the engine emits
// must split, under the CLI's own splitter, into exactly itself.
//
//   law                                                         kind         drives                                        plant
//   LayoutSchema refuses ( ) , and edge whitespace in commands  behavioural  LayoutSchema — src/genome_schema.ts           drop the structure-character refusal
//   …and in path globs                                          behavioural  same                                          same
//   a loaded layout carrying one is a load_error                behavioural  loadGenome — src/loader.ts                     same
//   every expanded grant splits into exactly itself (property)  behavioural  resolveSeatGrants — src/layout_grants.ts       expand a role without checking its entries
//   the final argv splits into exactly the seat's grants        behavioural  makeClaudeInvoker(...) argv — src/claude_        emit a layout handed straight to ctx.layout
//   (injected layout: refused, or no smuggled grant)                         invoker.ts                                    without validating it
//   dispatch refuses a smuggling layout, naming the entry       behavioural  runGig preflight — src/runtime.ts              same
//   the vendored splitter IS the installed CLI's                 behavioural  the installed claude binary (bytes)           a CLI whose splitter changed
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { makeClaudeInvoker, createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker, type Agent } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { loadGenome } from "../src/loader.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { loadLayoutGrants, layoutSchema, genomeTree, type Layout } from "./layout_grants_fixtures.js";
import { cliSplitGrants, HP_SOURCE } from "./support/cli_allowed_tools_splitter.js";

const SMUGGLE_CMD = "npx vitest run),Write,Bash(true";
const SMUGGLE_GLOB = "src/**),Write(coltrane.layout.json";
const BAD_ENTRIES = [SMUGGLE_CMD, "npx vitest run(x", "a,b", "x)y", " npx vitest run", "npx vitest run ", "\tnpm test"];
const BAD_GLOBS = [SMUGGLE_GLOB, "src/(x)/**", "src/a,b", " src/**", "src/** "];

const implementer = (): Agent =>
  testAgent({ slug: "impl", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", allowed_tools: ["Read", "Write(@source)", "Bash(@laws)"] });

describe("the CLI's grant grammar, as the engine must respect it", () => {
  it("non-vacuity: the vendored splitter really does smuggle a bare Write out of the example", () => {
    expect(cliSplitGrants([`Read,Write(src/a.ts),Bash(${SMUGGLE_CMD}:*)`])).toContain("Write");
    expect(cliSplitGrants(["Bash(npx vitest run:*),Write(src/a b.ts)"])).toEqual(["Bash(npx vitest run:*)", "Write(src/a b.ts)"]);
  });

  it("the vendored splitter is byte-for-byte the installed CLI's (skipped as UNVERIFIED when no claude binary is installed)", () => {
    let bin: string | undefined = process.env["CLAUDE_BIN"];
    if (!bin) { try { bin = realpathSync(execFileSync("which", ["claude"], { encoding: "utf8" }).trim()); } catch { bin = undefined; } }
    if (!bin || !existsSync(bin)) { console.warn("[UNVERIFIED] the installed CLI's splitter was not compared: no claude binary"); return; }
    const bytes = readFileSync(bin);
    expect(bytes.includes(Buffer.from(HP_SOURCE)), `the installed CLI (${bin}) no longer contains the vendored splitter — its --allowedTools grammar changed; re-derive the structure characters`).toBe(true);
  });
});

describe("LayoutSchema refuses every entry the grammar would treat as structure", () => {
  for (const cmd of BAD_ENTRIES) {
    it(`command prefix ${JSON.stringify(cmd)} is refused`, () => {
      expect(layoutSchema().safeParse({ commands: { laws: [cmd] } }).success, `a command prefix carrying grant structure was admitted: ${JSON.stringify(cmd)}`).toBe(false);
    });
  }
  for (const glob of BAD_GLOBS) {
    it(`path glob ${JSON.stringify(glob)} is refused`, () => {
      expect(layoutSchema().safeParse({ paths: { source: [glob] } }).success, `a path glob carrying grant structure was admitted: ${JSON.stringify(glob)}`).toBe(false);
    });
  }
  it("control — ordinary prefixes and globs with INNER spaces are admitted", () => {
    expect(layoutSchema().safeParse({ commands: { laws: ["npx vitest run"] }, paths: { source: ["src/**", "my dir/**"] } }).success).toBe(true);
  });
  it("a tree whose coltrane.layout.json smuggles a grant loads with a load_error and no layout", () => {
    const g = loadGenome(genomeTree({ layout: { commands: { laws: [SMUGGLE_CMD] } } }));
    expect(g.load_errors.some((e) => e.path.endsWith("coltrane.layout.json")), "the smuggling layout loaded clean").toBe(true);
    expect((g as unknown as { layout?: unknown }).layout).toBeUndefined();
  });
});

describe("every grant the engine emits splits, under the CLI's grammar, into exactly itself", () => {
  it("property: for any layout LayoutSchema admits, each expanded grant is one grant to the CLI", async () => {
    const L = await loadLayoutGrants();
    const S = layoutSchema();
    const ch = fc.constantFrom("a", "b", "/", "*", ".", "-", " ", "(", ")", ",", "x", "\t");
    const entry = fc.array(ch, { minLength: 1, maxLength: 12 }).map((c) => c.join(""));
    fc.assert(
      fc.property(fc.array(entry, { minLength: 1, maxLength: 2 }), fc.array(entry, { minLength: 1, maxLength: 2 }), (globs, cmds) => {
        const layout = { paths: { source: globs }, commands: { laws: cmds } };
        if (!S.safeParse(layout).success) return true;
        const r = L.resolveSeatGrants({ agent: implementer(), layout: layout as Layout });
        for (const g of r.grants) {
          const split = cliSplitGrants([g]);
          if (split.length !== 1 || split[0] !== g) throw new Error(`the admitted layout ${JSON.stringify(layout)} produced ${JSON.stringify(g)}, which the CLI reads as ${JSON.stringify(split)}`);
        }
        return true;
      }),
      { numRuns: 2000 },
    );
  });
});

describe("the final argv never carries a smuggled grant", () => {
  async function spawnFlags(layout: Layout, gig_input: Record<string, unknown> = { request_text: "x", target_paths: ["src/a.ts"] }): Promise<{ spawned: boolean; allowed: string; error: string }> {
    let args: string[] | undefined;
    const invoke = makeClaudeInvoker({ toolProviders: new Map(), mcpServerConfigs: {}, run: (_b, a) => { args = a; return "{}"; } });
    let error = "";
    try {
      await invoke({ agent: implementer(), phase: "p", inputs: [], gig_input, layout, tree_root: "/srv/t" } as unknown as AgentInvocationContext);
    } catch (e) { error = String((e as Error)?.message ?? e); }
    const i = (args ?? []).indexOf("--allowedTools");
    return { spawned: args !== undefined, allowed: i >= 0 ? args![i + 1]! : "", error };
  }

  it("a smuggling COMMAND handed straight to the invoker: refused before the spawn, or the CLI reads no bare Write", async () => {
    const r = await spawnFlags({ paths: { source: ["src/**"] }, commands: { laws: [SMUGGLE_CMD] } });
    if (!r.spawned) { expect(r.error, "refused without a reason").toMatch(/\S/); return; }
    const tokens = cliSplitGrants([r.allowed]);
    expect(tokens, `the CLI reads a BARE Write out of the spawn's --allowedTools (${r.allowed})`).not.toContain("Write");
    expect(tokens.filter((t) => t.startsWith("Write(") && t !== "Write(src/a.ts)"), `the CLI reads a Write beyond target_paths: ${JSON.stringify(tokens)}`).toEqual([]);
  });

  it("a smuggling PATH GLOB handed straight to the invoker (no target_paths): refused before the spawn, or the CLI reads no Write of the layout file", async () => {
    const r = await spawnFlags({ paths: { source: [SMUGGLE_GLOB] }, commands: { laws: ["npx vitest run"] } }, { request_text: "x" });
    if (!r.spawned) { expect(r.error, "refused without a reason").toMatch(/\S/); return; }
    const tokens = cliSplitGrants([r.allowed]);
    expect(tokens, `the CLI reads Write(coltrane.layout.json) out of the spawn's --allowedTools (${r.allowed})`).not.toContain("Write(coltrane.layout.json)");
  });

  it("control — an honest layout's argv splits into exactly the seat's grants", async () => {
    const r = await spawnFlags({ paths: { source: ["src/**"] }, commands: { laws: ["npx vitest run"] } });
    expect(r.spawned, r.error).toBe(true);
    const tokens = cliSplitGrants([r.allowed]);
    expect(tokens).toEqual(r.allowed.split(","));
    expect(tokens).toContain("Write(src/a.ts)");
  });

  it("dispatch refuses a smuggling layout, naming the entry — no seat is invoked", async () => {
    const registry = createRegistry();
    registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
    let invoked = 0;
    const invoke: AgentInvoker = () => { invoked += 1; return { ...coreInvariantFields("Signal"), value: "x" }; };
    const a = implementer();
    const standard = { slug: "s", domain: "demo", agents: [a], phases: [{ name: "p", chairs: [{ role: "impl", agent_slug: "impl", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }] } as unknown as Standard;
    let said = "";
    try {
      said = JSON.stringify(await runGig(standard, { request_text: "x", target_paths: ["src/a.ts"] }, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, layout: { paths: { source: ["src/**"] }, commands: { laws: [SMUGGLE_CMD] } } } as never));
    } catch (e) { said = String((e as Error)?.message ?? e); }
    expect(invoked, "a seat was invoked under a layout that smuggles a bare Write").toBe(0);
    expect(said, "the refusal does not name the smuggling entry").toContain(SMUGGLE_CMD);
  });
});
