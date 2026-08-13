// RED-first — a chair that MUTATED THE WORKING TREE must not be able to fail silently. Its file
// writes have to be reported, so the run that made them can be reconciled or sealed.
//
// The hole, found by review rather than by a gig: outputs and file writes travel on different
// paths, and only one of them is transactional.
//
//   - `output_write` calls are scraped from the stream by captureOutputWrites and adjudicated
//     against the seal predicate. On a failed run they are discarded — correctly, because a
//     half-sealed contract is worse than none. That is all-or-nothing, and it is right.
//   - `Write` / `Edit` go straight to the filesystem through the CLI's own tools. They never pass
//     through captureOutputWrites, they are not part of the seal, and NOTHING in the engine looks
//     at them. There is no worktree isolation either — a gig runs against the tree it is given.
//
// So a chair granted code_tool_access can change the repo, fail, have its outputs thrown away, and
// leave the tree different with no ledger row anywhere saying why. The mutation is real and
// unattributed, and the NEXT run reads a tree whose state has no provenance.
//
// That contradicts the guarantee the whole model rests on — every sealed output carries its
// content_sha and the input_shas of exactly what it consumed, so provenance is proof-carrying and
// a consumer verifies rather than trusts. A repo mutation with no record is the one thing that
// cannot be verified, and it happens exactly where mutation matters most.
//
// It is also the MIRROR of the budget-stop bug fixed in 34a9e1d, and worth stating as a pair:
//   - budget stop:  validated work DENIED in the ledger though it was really done.
//   - this:         unvalidated work KEPT on disk though it was really refused.
// Both are one channel disagreeing with the other about whether something happened.
//
// WHAT THIS TEST DOES NOT ASSERT. It does not demand isolation, or sealing, or rollback — those are
// implementations and the right one is a governor's call. It asserts only the property that makes
// any of them possible: the engine must KNOW which files a run touched. It cannot currently tell
// you, though the information is sitting in the stream it already parses.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, ChildExitError } from "../src/claude_invoker.js";
import { defineAgent } from "../src/composition.js";
import type { AgentInvocationContext } from "../src/runtime.js";

const agent = () =>
  defineAgent({
    slug: "tree-mutator",
    primitives: ["CREATE"],
    input_types: [],
    output_types: ["red-spec"],
    identity: "a chair that edits the repository",
    method: "write the failing test, then seal the spec",
    constraints: ["never seal a spec you did not write a test for"],
    behavioral_primitives: ["planner", "executor"],
    allowed_tools: ["Write", "Edit"],
    code_tool_access: "write",
    max_tool_calls: 10,
  });

/** A Write tool_use — the CLI's own file tool, which never passes the engine's seal boundary. */
const fileWrite = (id: string, file_path: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name: "Write", input: { file_path, content: "// ..." } }],
    },
  });

const fileEdit = (id: string, file_path: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id, name: "Edit", input: { file_path, old_string: "a", new_string: "b" } },
      ],
    },
  });

const sealWrite = (id: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id,
          name: "mcp__coltrane__output_write",
          input: { domain_type: "red-spec", data: { spec: "the law" } },
        },
      ],
    },
  });

/** The chair edited two files, then died of an API error. Outputs are discarded; the files remain. */
const mutatedThenFailed = (): string =>
  [
    fileWrite("t1", "/repo/tests/new_law.test.ts"),
    fileEdit("t2", "/repo/src/composition.ts"),
    JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
  ].join("\n");

/** Same mutations, but the run completed and sealed. Attribution matters here too. */
const mutatedThenSealed = (): string =>
  [
    fileWrite("t1", "/repo/tests/new_law.test.ts"),
    sealWrite("w1"),
    JSON.stringify({ type: "result", subtype: "success", is_error: false }),
  ].join("\n");

const invokeFailing = (stdout: string) =>
  makeClaudeInvoker({
    model: "claude-sonnet-4-6",
    sealVia: "output_write",
    run: () => {
      throw new ChildExitError(`claude exited 1: `, stdout);
    },
  });

const invokeOk = (stdout: string) =>
  makeClaudeInvoker({
    model: "claude-sonnet-4-6",
    sealVia: "output_write",
    run: async () => stdout,
  });

const ctx = (): AgentInvocationContext =>
  ({
    agent: agent(),
    phase: "draft-red-spec",
    gig_id: "gig-tree-mutation",
    inputs: [],
    gig_input: {},
    output_types: ["red-spec"],
  }) as AgentInvocationContext;

describe("a chair that mutated the working tree cannot fail silently", () => {
  it("reports the files a FAILED run wrote, instead of losing them", async () => {
    // The run failed, so discarding its outputs is correct. What is not correct is that the two
    // files it changed are now unattributable: nothing the engine returns or throws names them.
    await expect(
      invokeFailing(mutatedThenFailed())(ctx()),
      "the chair changed two files and then failed; the tree is different and no record anywhere " +
        "says so, which is a repo mutation with no provenance",
    ).rejects.toMatchObject({
      mutations: expect.arrayContaining(["/repo/tests/new_law.test.ts", "/repo/src/composition.ts"]),
    });
  });

  it("reports the files a SUCCESSFUL run wrote alongside what it sealed", async () => {
    // Attribution is not only a failure concern. A sealed output whose sibling file writes are
    // invisible is still a partial account of what the run did.
    const out = await invokeOk(mutatedThenSealed())(ctx());
    expect(
      (out as { mutations?: string[] })?.mutations,
      "a successful run's file writes are as much a part of what it did as its sealed payload",
    ).toEqual(["/repo/tests/new_law.test.ts"]);
  });

  it("reports nothing when a run touched no files — absence must mean absence", async () => {
    // HONESTLY: this one passes VACUOUSLY today. `mutations` is always undefined, so `?? []`
    // always matches and nothing is being proven. It is kept because it becomes load-bearing the
    // moment the other two go green — it is what catches an implementation that reports phantom
    // mutations — but it is not evidence of anything right now, and counting it as a passing law
    // would be laundering a tautology into a result.
    const clean = [sealWrite("w1"), JSON.stringify({ type: "result", subtype: "success", is_error: false })].join("\n");
    const out = await invokeOk(clean)(ctx());
    expect((out as { mutations?: string[] })?.mutations ?? []).toEqual([]);
  });
});
