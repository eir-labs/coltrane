// D3 — THE DIFF GATE: A SEAT THAT CHANGED A PATH OUTSIDE ITS GRANT IS REFUSED, AND NOTHING IT MADE IS SEALED.
//
// The founder's ruling ("sandbox + diff gate"). The sandbox bounds what Bash CAN touch; the gate checks
// what the seat DID. After a seat returns, runGig compares the tree's `git status --porcelain -z` with the
// state before the seat ran. Every path that changed — modified, added, untracked, deleted, and BOTH
// sides of a rename — must lie inside the seat's resolved Write/Edit scope (target_paths-narrowed when
// applied; the expanded globs when not). One that does not refuses the chair: the refusal names the
// paths, and no output of that chair is sealed.
//
// Driven through the real runGig against a real temporary git tree, with a fake invoker that edits the
// tree the way a seat's Bash would.
//
//   law                                                   kind         drives                           plant
//   an untracked file outside the grant refuses          behavioural  runGig — src/runtime.ts (the     skip the gate / ignore untracked (`??`) entries
//                                                                     post-seat diff gate)
//   a tracked edit outside refuses                        behavioural  same                             skip the gate
//   a deletion outside refuses                            behavioural  same                             count only additions/modifications
//   a rename OUT of scope refuses (by its source)         behavioural  same                             count a rename by its destination only
//   with target_paths, a sibling in the glob refuses      behavioural  same                             gate on the expanded globs even when
//                                                                                                       target_paths applied
//   no target_paths: the expanded globs gate              behavioural  same                             skip the gate when target_paths_applied is false
//   a ** seat that rewrote the layout file refuses        behavioural  same                             exempt nothing / judge only the globs
//   control: in-scope work seals                          behavioural  same                             gate refuses everything
//   control: dirt that predates the seat is not its own   behavioural  same                             diff against HEAD instead of the pre-seat state
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker, type GigProgressEvent } from "../src/index.js";
import { LAYOUT_FILE, type Layout } from "./layout_grants_fixtures.js";

const SRC: Layout = { paths: { source: ["src/**"] } };
const WIDE: Layout = { paths: { source: ["**"] } };

function gitTree(): string {
  const root = mkdtempSync(join(tmpdir(), "diff-gate-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { env, stdio: "pipe" });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", root]);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "src", "existing.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "docs", "keep.md"), "# keep\n");
  writeFileSync(join(root, "README.md"), "# readme\n");
  writeFileSync(join(root, LAYOUT_FILE), JSON.stringify(SRC));
  g("add", "-A");
  g("commit", "--quiet", "-m", "seed");
  return root;
}

const implementer = testAgent({
  slug: "implementer", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo",
  allowed_tools: ["Read", "Write(@source)", "Edit(@source)"],
});
const standard = {
  slug: "change-v1", domain: "demo", agents: [implementer],
  phases: [{ name: "p", chairs: [{ role: "impl", agent_slug: "implementer", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
} as unknown as Standard;

async function run(tree: string, layout: Layout, act: (tree: string) => void, gigInput: Record<string, unknown> = { request_text: "x" }) {
  const registry = createRegistry();
  registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
  const outputs = createOutputStore(registry);
  const events: GigProgressEvent[] = [];
  let invoked = 0;
  const invoke: AgentInvoker = () => { invoked += 1; act(tree); return { ...coreInvariantFields("Signal"), value: "done" }; };
  let said = "";
  try {
    said = JSON.stringify(await runGig(standard, gigInput, {
      outputs, ledger: new MemoryLedger(), invoke, layout, tree_root: tree, onProgress: (e: GigProgressEvent) => events.push(e),
    } as never));
  } catch (e) {
    said = String((e as Error)?.message ?? e);
  }
  said += " " + JSON.stringify(events);
  const sealed = outputs.all().filter((o) => (o as { agent_slug?: string }).agent_slug === "implementer");
  return { invoked, said, sealed };
}

function expectRefused(r: { invoked: number; said: string; sealed: readonly unknown[] }, path: string, why: string) {
  expect(r.invoked, "non-vacuity: the seat ran and changed the tree").toBe(1);
  expect(r.sealed, `${why} — and the chair's output was SEALED anyway`).toHaveLength(0);
  expect(r.said, `the refusal does not name the offending path "${path}"`).toContain(path);
}

describe("D3 — the diff gate", () => {
  it("control — a seat that changes only paths inside its grant seals as usual", async () => {
    const r = await run(gitTree(), SRC, (t) => {
      writeFileSync(join(t, "src", "new.ts"), "export const y = 2;\n");
      writeFileSync(join(t, "src", "existing.ts"), "export const x = 3;\n");
    });
    expect(r.sealed, `in-scope work was refused: ${r.said.slice(0, 300)}`).toHaveLength(1);
  });

  it("control — a change that was already in the tree BEFORE the seat ran is not the seat's", async () => {
    const tree = gitTree();
    writeFileSync(join(tree, "docs", "predates.md"), "already here\n");
    const r = await run(tree, SRC, (t) => writeFileSync(join(t, "src", "new.ts"), "x\n"));
    expect(r.sealed, `pre-existing dirt was blamed on the seat: ${r.said.slice(0, 300)}`).toHaveLength(1);
  });

  it("an UNTRACKED file outside the grant refuses the chair", async () => {
    const r = await run(gitTree(), SRC, (t) => writeFileSync(join(t, "docs", "evil.md"), "x\n"));
    expectRefused(r, "docs/evil.md", "the seat created a file outside src/**");
  });

  it("a TRACKED file edited outside the grant refuses the chair", async () => {
    const r = await run(gitTree(), SRC, (t) => writeFileSync(join(t, "README.md"), "# rewritten\n"));
    expectRefused(r, "README.md", "the seat rewrote a tracked file outside src/**");
  });

  it("a tracked file DELETED outside the grant refuses the chair", async () => {
    const r = await run(gitTree(), SRC, (t) => rmSync(join(t, "docs", "keep.md")));
    expectRefused(r, "docs/keep.md", "the seat deleted a file outside src/**");
  });

  it("a RENAME out of scope refuses by its SOURCE, even though its destination is in scope", async () => {
    const r = await run(gitTree(), SRC, (t) => { execFileSync("git", ["-C", t, "mv", "docs/keep.md", "src/keep.md"]); });
    expectRefused(r, "docs/keep.md", "the seat moved a file out of docs/ — judged by the rename's destination only");
  });

  it("with target_paths [src/a.ts], a sibling inside src/** refuses — the gate uses the NARROWED scope", async () => {
    const r = await run(gitTree(), SRC, (t) => writeFileSync(join(t, "src", "b.ts"), "x\n"), { request_text: "x", target_paths: ["src/a.ts"] });
    expectRefused(r, "src/b.ts", "the seat wrote a path its change never named");
  });

  it("with NO target_paths (target_paths_applied: false), the expanded globs gate — docs/ is still outside src/**", async () => {
    const r = await run(gitTree(), SRC, (t) => writeFileSync(join(t, "docs", "notes.md"), "x\n"), { request_text: "x" });
    expectRefused(r, "docs/notes.md", "an un-narrowed seat was not gated at all");
  });

  it("a ** seat that rewrote the layout file refuses — no grant ever covers coltrane.layout.json", async () => {
    const r = await run(gitTree(), WIDE, (t) => writeFileSync(join(t, LAYOUT_FILE), JSON.stringify({ paths: { source: ["**"], scripts: ["**"] } })));
    expectRefused(r, LAYOUT_FILE, "the seat rewrote the layout that grants it");
  });
});
