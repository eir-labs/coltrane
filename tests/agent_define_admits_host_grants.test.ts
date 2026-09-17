// RED — agent_define can author a seat that touches code.
//
// THE GAP. agent_define's governance gate admits only slugs in REGISTERED_TOOL_SLUGS, the engine's
// own MCP surface (src/server.ts). A host builtin — Read, Write(src/**), Bash(npx vitest run:*) — is
// not in that set, so the MCP authoring surface could not create ANY agent that reads or writes
// code. Every such seat in the genome (code-implementer, red-spec-drafter, change-verifier) was
// committed straight to agents/*.json instead (#318, #319), which bypasses the genome_mutation seal
// agent_define exists to write. Found on 2026-09-16 while composing a build standard for the turn
// loop: its attester and builder could not be defined at all.
//
// WHY NOT tool_register. The registry is the engine's own tool surface; registering `Read` there
// would record the engine as serving a tool it does not serve. (It would not rename the grant at
// dispatch — resolveToolGrants checks host builtins before the registry — so that is not the harm.)
// Law 4 pins the end that matters: an agent authored here RESOLVES at dispatch, grant for grant,
// with no dead names. It goes red if resolution stops passing host builtins through.
//
// WHERE ENFORCEMENT STAYS. Admitting a host builtin at authoring time grants nothing by itself:
// dispatch still resolves every grant and fails closed on a dead name, and a venue still narrows the
// effective set to its equipment. Laws 2 and 3 keep the gate a gate: an unknown name is still
// refused, named, and nothing is persisted.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { bootstrapServerDeps, dispatchTool, type ServerDeps } from "../src/server.js";
import { resolveAgentGrants } from "../src/tool_providers.js";

const REQUIRED_CORE_TYPES = [
  { slug: "Signal", primitive: "SENSE", description: "", schema: {} },
  { slug: "Interpretation", primitive: "INTERPRET", description: "", schema: {} },
  { slug: "Judgment", primitive: "JUDGE", description: "", schema: {} },
  { slug: "Plan", primitive: "PLAN", description: "", schema: {} },
  { slug: "Artifact", primitive: "CREATE", description: "", schema: {} },
  { slug: "Verdict", primitive: "VERIFY", description: "", schema: {} },
];

const HOST_GRANTS = ["Read", "Grep", "Write(src/**)", "Edit(src/**)", "Bash(npx vitest run:*)", "Bash(git diff:*)"];

function builder(slug: string, allowed_tools: string[]) {
  return {
    ...TEST_BEHAVIOR,
    slug,
    primitives: ["CREATE"],
    input_types: [],
    output_types: ["built-thing"],
    domain: "demo",
    allowed_tools,
  };
}

describe("agent_define and host tool grants", () => {
  let root: string;
  let deps: ServerDeps;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coltrane-host-grants-"));
    mkdirSync(join(root, "core_types"), { recursive: true });
    for (const c of REQUIRED_CORE_TYPES) writeFileSync(join(root, "core_types", `${c.slug}.json`), JSON.stringify(c));
    deps = bootstrapServerDeps(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("LAW 1 — admits host builtin grants, bare and scoped, and persists them verbatim", async () => {
    const res = await dispatchTool("agent_define", builder("host-builder", HOST_GRANTS), deps);
    expect(res.ok, `a code-touching seat could not be defined: ${res.error ?? ""}`).toBe(true);

    const path = join(root, "agents", "host-builder.json");
    expect(existsSync(path), "agent_define reported ok but persisted nothing").toBe(true);
    const persisted = JSON.parse(readFileSync(path, "utf8")) as { allowed_tools?: string[] };
    expect(persisted.allowed_tools, "the grants were rewritten on the way to disk").toEqual(HOST_GRANTS);
  });

  it("LAW 2 — still refuses a name that is neither a host builtin nor a registered tool, and names it", async () => {
    const res = await dispatchTool(
      "agent_define",
      builder("bad-builder", ["Read", "Frobnicate", "Bash2(npx vitest run:*)"]),
      deps,
    );
    expect(res.ok, "the gate admitted an unknown tool name").toBe(false);
    expect(res.error ?? "").toContain("Frobnicate");
    expect(res.error ?? "").toContain("Bash2(npx vitest run:*)");
    expect(res.error ?? "", "a legitimate host grant was reported as unknown").not.toMatch(/\bRead\b(?!\w)/);
  });

  it("LAW 3 — a refused definition persists nothing", async () => {
    await dispatchTool("agent_define", builder("bad-builder", ["Frobnicate"]), deps);
    expect(existsSync(join(root, "agents", "bad-builder.json")), "a refused agent reached the genome").toBe(false);
  });

  it("LAW 4 — an agent authored here resolves at dispatch, each host grant as itself, with no dead names", async () => {
    const def = builder("host-builder", HOST_GRANTS);
    const res = await dispatchTool("agent_define", def, deps);
    expect(res.ok, res.error ?? "").toBe(true);

    const resolved = resolveAgentGrants(def, deps.toolProviders ?? new Map(), deps.mcpServerConfigs ?? {});
    expect(resolved.unknown, "a host grant became a dead name at dispatch").toEqual([]);
    for (const g of HOST_GRANTS) {
      expect(resolved.effectiveAllowed, `"${g}" did not survive resolution as itself`).toContain(g);
    }
    expect(
      resolved.effectiveAllowed.some((g) => g.startsWith("mcp__coltrane__Read")),
      "Read was renamed into the engine server's namespace — a dead name",
    ).toBe(false);
  });
});
