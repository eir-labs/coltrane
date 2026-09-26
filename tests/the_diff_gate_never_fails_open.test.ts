// THE DIFF GATE NEVER FAILS OPEN — not on an unreadable tree, not between concurrent chairs, not by
// reading the wrong tree, and not through its one exemption.
//
// Four wires survived the implementer's mutation run (OWN-4, 5, 8, 9):
//   · UNREADABLE. A gate that cannot read the tree and lets the seat through is no gate. A writing seat
//     whose tree cannot be read BEFORE it runs is refused (never invoked); one whose tree cannot be read
//     AFTER is refused and nothing it made is sealed.
//   · CONCURRENT CHAIRS share one tree, and a change inside an overlapping chair's scope is left to that
//     chair's gate. But an overlap must never excuse a change outside BOTH scopes.
//   · A ROOM SEAT writes in the room's workspace (bind-mounted on the host at the same path). The gate
//     must read THAT tree — reading the host tree_root sees nothing the seat did.
//   · THE ONE EXEMPTION is the engine's own state dir, `.coltrane`, which the engine writes while seats
//     run. It must stay exactly `.coltrane` / `.coltrane/…` — never `.claude/`, never `.coltrane-x/`.
//
//   law                                                 kind         drives                                 plant
//   unreadable tree BEFORE → not invoked, refused        behavioural  runGig — src/runtime.ts (diff gate)    catch the pre-seat read failure and skip the gate
//   unreadable tree AFTER → refused, nothing sealed      behavioural  same                                   catch the post-seat read failure and judge [] changed
//   concurrent: outside BOTH scopes refuses              behavioural  outOfScope via runGig — src/diff_gate  excuse every change when any chair overlapped
//   concurrent control: inside the other's scope passes  behavioural  same                                   ignore overlaps (a sibling's write blames this chair)
//   a room seat's gate reads the ROOM workspace          behavioural  runGig — src/runtime.ts                read deps.tree_root instead of the seat's workspace
//   `.claude/` is judged; `.coltrane-x/` is judged       behavioural  changedPaths — src/diff_gate.ts        widen the exemption (startsWith(".c"), or add .claude)
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker, type Agent } from "../src/index.js";
import type { Venue } from "../src/chart.js";
import type { VenueRealizer, RealizationHandle } from "../src/venue_realizer.js";
import { type Layout } from "./layout_grants_fixtures.js";

const LAYOUT: Layout = { paths: { source: ["src/**"], docs: ["docs/**"] } };

function gitTree(): string {
  const root = mkdtempSync(join(tmpdir(), "gate-open-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", root]);
  for (const d of ["src", "docs", "scripts"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "src", "a.ts"), "a\n");
  writeFileSync(join(root, "README.md"), "r\n");
  execFileSync("git", ["-C", root, "add", "-A"], { env });
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "seed"], { env });
  return root;
}

const agentOf = (slug: string, allowed_tools: string[]): Agent =>
  testAgent({ slug, primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", allowed_tools });
const standardOf = (agents: Agent[]): Standard => ({
  slug: "gate-v1", domain: "demo", agents,
  phases: [{ name: "p", chairs: agents.map((a) => ({ role: a.slug, agent_slug: a.slug, depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] })) }],
}) as unknown as Standard;

async function run(standard: Standard, invoke: AgentInvoker, deps: Record<string, unknown>) {
  const registry = createRegistry();
  registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
  const outputs = createOutputStore(registry);
  let said = "";
  try {
    said = JSON.stringify(await runGig(standard, { request_text: "x" }, { outputs, ledger: new MemoryLedger(), invoke, layout: LAYOUT, ...deps } as never));
  } catch (e) {
    said = String((e as Error)?.message ?? e);
  }
  return { said, sealedBy: (slug: string) => outputs.all().filter((o) => (o as { agent_slug?: string }).agent_slug === slug) };
}
const note = () => ({ ...coreInvariantFields("Signal"), value: "done" });

describe("an unreadable tree refuses the writing seat", () => {
  it("BEFORE the seat: a tree_root that cannot be read → the seat is never invoked, and the refusal says why", async () => {
    let invoked = 0;
    const missing = join(mkdtempSync(join(tmpdir(), "gate-gone-")), "no-such-tree");
    const r = await run(standardOf([agentOf("impl", ["Read", "Write(@source)"])]), () => { invoked += 1; return note(); }, { tree_root: missing });
    expect(invoked, "a writing seat ran over a tree its gate could not read").toBe(0);
    expect(r.sealedBy("impl")).toHaveLength(0);
    expect(r.said, "the refusal does not say the tree could not be read").toMatch(/cannot read|unreadable|could not read/i);
  });

  it("AFTER the seat: a seat that leaves the tree unreadable is refused, and nothing it made is sealed", async () => {
    const tree = gitTree();
    let invoked = 0;
    const r = await run(standardOf([agentOf("impl", ["Read", "Write(@source)"])]), () => {
      invoked += 1;
      chmodSync(join(tree, ".git"), 0o000);
      return note();
    }, { tree_root: tree });
    chmodSync(join(tree, ".git"), 0o755);
    expect(invoked, "non-vacuity: the seat ran").toBe(1);
    expect(r.sealedBy("impl"), `a seat whose effect could not be judged was sealed: ${r.said.slice(0, 200)}`).toHaveLength(0);
  });
});

describe("concurrent chairs on one tree", () => {
  /** Two seats in one phase; each waits until BOTH are inside their window before touching the tree. */
  function barrier(n: number): () => Promise<void> {
    let arrived = 0;
    let release!: () => void;
    const all = new Promise<void>((r) => { release = r; });
    return async () => {
      arrived += 1;
      if (arrived >= n) release();
      await Promise.race([all, new Promise((r) => setTimeout(r, 2000))]);
    };
  }

  it("an overlapping chair never excuses a change outside BOTH scopes", async () => {
    const tree = gitTree();
    const src = agentOf("src-seat", ["Read", "Write(@source)"]);
    const docs = agentOf("docs-seat", ["Read", "Write(@docs)"]);
    const both = barrier(2);
    const r = await run(standardOf([src, docs]), async (ctx) => {
      await both();
      if (ctx.agent.slug === "src-seat") writeFileSync(join(tree, "scripts", "evil.sh"), "rm -rf /\n");
      else writeFileSync(join(tree, "docs", "ok.md"), "ok\n");
      return note();
    }, { tree_root: tree });
    expect(r.said, "the refusal does not name the path outside both scopes").toContain("scripts/evil.sh");
    expect(r.sealedBy("src-seat"), "a change outside BOTH chairs' scopes was excused by the overlap").toHaveLength(0);
  });

  it("control — a change inside the OTHER chair's scope is left to that chair: both seal", async () => {
    const tree = gitTree();
    const src = agentOf("src-seat", ["Read", "Write(@source)"]);
    const docs = agentOf("docs-seat", ["Read", "Write(@docs)"]);
    const both = barrier(2);
    const r = await run(standardOf([src, docs]), async (ctx) => {
      await both();
      writeFileSync(join(tree, ctx.agent.slug === "src-seat" ? "src" : "docs", "mine.txt"), "x\n");
      return note();
    }, { tree_root: tree });
    expect(r.sealedBy("src-seat").length + r.sealedBy("docs-seat").length, `in-scope concurrent work was refused: ${r.said.slice(0, 300)}`).toBe(2);
  });
});

describe("a room seat's gate reads the ROOM's workspace", () => {
  it("a seat that writes outside its grant IN THE ROOM WORKSPACE is refused — the host tree_root is not the tree it ran in", async () => {
    const hostTree = gitTree();
    const roomWs = gitTree();
    const room = {
      slug: "seat-room-v1", institution_slug: "quartet", equipment: { tools: ["Read", "Write"] }, doors: { ingress: [], egress: [] },
      installs: [], credential_surface: [], floor: "seat",
      mcp_servers: [{ slug: "engine", transport: "stdio", command: ["engine-mcp"], credential_names: [] }],
      lifecycle: { policy: "ephemeral" },
    } as unknown as Venue;
    const handle = {
      state: "PLAYING", mcpServerConfigs: {}, configPath: "", artifacts: [], teardown: () => {}, tornDown: () => true,
      seat: { container: "room-1", workspace: roomWs },
    } as unknown as RealizationHandle;
    const realizer = {
      substrate: "test", guarantees: [], available: () => true,
      retention: { max_cached_build_artifacts: 0, max_unreferenced_environments: 0, cadence: "gig" },
      realize: async () => handle,
    } as unknown as VenueRealizer;
    let sawWorkspace: string | undefined;
    const r = await run(standardOf([agentOf("impl", ["Read", "Write(@source)"])]), (ctx) => {
      sawWorkspace = (ctx as { seatExec?: { workspace: string } }).seatExec?.workspace;
      writeFileSync(join(roomWs, "scripts", "evil.sh"), "x\n");
      return note();
    }, { tree_root: hostTree, venue: room.slug, venues: new Map([[room.slug, room]]), venueRealizer: realizer });
    expect(sawWorkspace, `non-vacuity: the seat ran inside the room (${r.said.slice(0, 200)})`).toBe(roomWs);
    expect(r.sealedBy("impl"), "the gate read the host tree_root and never saw the room seat's write").toHaveLength(0);
    expect(r.said).toContain("scripts/evil.sh");
  });
});

describe("the .coltrane exemption is exactly .coltrane", () => {
  for (const [path, mk] of [
    [".claude/settings.json", (t: string) => { mkdirSync(join(t, ".claude"), { recursive: true }); writeFileSync(join(t, ".claude", "settings.json"), "{}"); }],
    [".coltrane-evil/x", (t: string) => { mkdirSync(join(t, ".coltrane-evil"), { recursive: true }); writeFileSync(join(t, ".coltrane-evil", "x"), "x"); }],
    [".coltranex", (t: string) => writeFileSync(join(t, ".coltranex"), "x")],
  ] as Array<[string, (t: string) => void]>) {
    it(`a seat that writes ${path} is judged — and refused`, async () => {
      const tree = gitTree();
      const r = await run(standardOf([agentOf("impl", ["Read", "Write(@source)"])]), () => { mk(tree); return note(); }, { tree_root: tree });
      expect(r.sealedBy("impl"), `${path} was treated as the engine's own state and not judged`).toHaveLength(0);
      expect(r.said).toContain(path);
    });
  }

  it("control — the engine's own .coltrane/ changing during a seat is not blamed on it", async () => {
    const tree = gitTree();
    const r = await run(standardOf([agentOf("impl", ["Read", "Write(@source)"])]), () => {
      mkdirSync(join(tree, ".coltrane"), { recursive: true });
      writeFileSync(join(tree, ".coltrane", "ledger.jsonl"), "{}\n");
      return note();
    }, { tree_root: tree });
    expect(r.sealedBy("impl"), `the engine's own state dir was blamed on the seat: ${r.said.slice(0, 200)}`).toHaveLength(1);
  });
});
