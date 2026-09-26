// EVERY PROTECTED PATH IS DENIED TO EVERY GRANT THE CLI WOULD LET REACH IT — and to no other.
//
// The protected paths are coltrane.layout.json (the grant boundary), .git (hooks, config, refs), .claude
// (the CLI's own settings, whose hooks execute) and .coltrane (the engine's ledger and locks). The
// resolver must deny each one to every Write/Edit grant that could reach it UNDER THE CLI'S MATCHER —
// the oracle in tests/support/cli_scope_oracle.ts (ignore 7.0.5 + the CLI 2.1.283's own
// preprocessing, verified from the binary). "Could reach" for a directory means the directory or ANY
// path under it; the probe set below covers basenames an unanchored pattern could hit at depth
// (`config`, `*.json`, hooks) so the EXPECTED answer is not itself a single-probe guess.
//
// The iff matters in both directions: a missing denial is a hole; a denial for a grant that cannot
// reach the path (`Write(src/*)` → .git) is a matcher that stopped discriminating.
//
//   law                                                     kind         drives                                   plant
//   each grant × protected path: denied iff CLI-reachable    behavioural  resolveSeatGrants — src/layout_grants.ts  OWN-D `.git` dropped from PROTECTED_PATHS;
//                                                                         (grantMayReach, src/grant_scope.ts)       OWN-B grantMayReach judges an unanchored
//                                                                                                                  pattern by one probe path
//   Write(./**) is `**` to the CLI → every path denied        behavioural  same                                     (RED today: `./**` gets no denial at all)
//   the spawn carries the .git and .claude denials           behavioural  makeClaudeInvoker(...) argv —              OWN-D; or omit the .git/.claude denials from
//                                                                         src/claude_invoker.ts                    --disallowedTools
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { testAgent } from "./_support/agents.js";
import { loadLayoutGrants } from "./layout_grants_fixtures.js";
import { cliCovers } from "./support/cli_scope_oracle.js";

const PROTECTED: Array<{ path: string; kind: "file" | "dir" }> = [
  { path: "coltrane.layout.json", kind: "file" },
  { path: ".git", kind: "dir" },
  { path: ".claude", kind: "dir" },
  { path: ".coltrane", kind: "dir" },
];
const PROBES = (dir: string) => [dir, `${dir}/x`, `${dir}/config`, `${dir}/a.json`, `${dir}/sub/y.json`, `${dir}/hooks/pre-commit`, `${dir}/settings.json`, `${dir}/ledger.jsonl`];
const cliCouldReach = (scope: string, p: { path: string; kind: "file" | "dir" }): boolean =>
  p.kind === "file" ? cliCovers(scope, p.path) : PROBES(p.path).some((q) => cliCovers(scope, q));
const denialFor = (tool: string, p: { path: string; kind: "file" | "dir" }) => `${tool}(${p.kind === "file" ? p.path : `${p.path}/**`})`;

const GRANTS = ["*.json", "src/*", "**", ".*/**", "config"];
const seat = (allowed_tools: string[]) =>
  testAgent({ slug: "w", primitives: ["CREATE"], input_types: [], output_types: ["built-thing"], domain: "demo", allowed_tools } as never);

describe("every protected path is denied iff the CLI's matcher could reach it", () => {
  it("non-vacuity: the expected answers discriminate (some grants reach, `src/*` reaches none)", () => {
    expect(cliCouldReach("config", PROTECTED[1]!), "an unanchored `config` reaches .git/config").toBe(true);
    expect(cliCouldReach("*.json", PROTECTED[0]!)).toBe(true);
    expect(PROTECTED.some((p) => cliCouldReach("src/*", p)), "src/* reaches a protected path — the control is not a control").toBe(false);
  });

  for (const scope of GRANTS) {
    for (const p of PROTECTED) {
      const reach = cliCouldReach(scope, p);
      it(`Write(${scope}) × ${p.path}: ${reach ? "DENIED" : "not denied (control)"}`, async () => {
        const L = await loadLayoutGrants();
        const r = L.resolveSeatGrants({ agent: seat([`Write(${scope})`]) });
        if (reach) expect(r.denials, `Write(${scope}) can reach ${p.path} at the CLI and the resolver did not deny it`).toContain(denialFor("Write", p));
        else expect(r.denials, `Write(${scope}) cannot reach ${p.path} at the CLI, yet the resolver denies it — the matcher stopped discriminating`).not.toContain(denialFor("Write", p));
      });
    }
  }

  it("Write(./**) — the CLI drops the `./` and reads `**` — is denied every protected path", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: seat(["Write(./**)"]) });
    for (const p of PROTECTED) {
      expect(cliCouldReach("./**", p), `oracle sanity: ./** reaches ${p.path}`).toBe(true);
      expect(r.denials, `Write(./**) reaches ${p.path} at the CLI and the resolver denied nothing`).toContain(denialFor("Write", p));
    }
  });
});

describe("the spawn carries the .git and .claude denials, not only .coltrane", () => {
  it("a seat granted Write(**) and Edit(**) (code_tool_access unset) spawns with Write/Edit denials for .git/** and .claude/**", async () => {
    let args: string[] = [];
    const invoke = makeClaudeInvoker({ toolProviders: new Map(), mcpServerConfigs: {}, run: (_b, a) => { args = a; return "{}"; } });
    try {
      await invoke({ agent: seat(["Read", "Write(**)", "Edit(**)"]), phase: "build", inputs: [], gig_input: { request_text: "x" }, tree_root: "/srv/t" } as unknown as AgentInvocationContext);
    } catch { /* only the argv matters */ }
    const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1]!.split(",") : []; };
    expect(flag("--allowedTools"), "non-vacuity: Write(**) reached the spawn").toContain("Write(**)");
    const deny = flag("--disallowedTools");
    for (const d of ["Write(.git/**)", "Edit(.git/**)", "Write(.claude/**)", "Edit(.claude/**)"]) {
      expect(deny, `the spawn can write ${d.slice(d.indexOf("(") + 1, -4)} through its ** grant`).toContain(d);
    }
  });
});
