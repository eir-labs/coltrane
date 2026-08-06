// The engine put the whole chair prompt on the command line.
//
// `buildInvokerArgs` returned `["-p", prompt, …]`, and Windows caps a process command line at
// roughly 32,767 characters. A strategize-phase prompt — blueprint plus draft plus review —
// exceeds that comfortably, so the spawn failed with ENAMETOOLONG and the run died. The
// consuming product's gap analysis recorded it as "Broken on Windows … local dev was
// practically unusable."
//
// It was fixed downstream, and that is the part worth understanding. The consumer could not
// modify the engine, so it monkey-patched `child_process.spawn` from the dashboard
// (`prompt-delivery.ts` + `claude-spawn-patch.ts`), detecting a claude spawn by argv shape and
// rewriting it. That works, and it is a standing liability: it is coupled to this module's
// internals through a dependency's built output, so any change to how the invoker builds argv
// breaks it SILENTLY — the patch simply stops matching and the prompt goes back on the command
// line. Every other consumer on Windows has to write the same patch, or discover the same bug.
//
// So the fix belongs here. `-p` is a BOOLEAN flag and the prompt is a positional argument,
// which is what makes this clean: keep the flag, move the positional to stdin. Note the
// downstream patch removes `-p` as well and relies on the CLI inferring print mode from a
// non-TTY stdin; keeping the flag is explicit and strictly safer.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildInvokerArgs, promptViaStdin, PROMPT_ARG_LIMIT_DEFAULT } from "../src/claude_invoker.js";

const CFG = "/tmp/mcp.json";
const small = "do the thing";
const huge = "x".repeat(40_000);

describe("prompt delivery — the Windows command-line limit", () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env };
    delete process.env["COLTRANE_PROMPT_MODE"];
    delete process.env["COLTRANE_PROMPT_ARG_LIMIT"];
  });
  afterEach(() => { process.env = env; });

  it("keeps a small prompt on the command line — unchanged behaviour", () => {
    const args = buildInvokerArgs(small, CFG, {});
    expect(args.slice(0, 2)).toEqual(["-p", small]);
    expect(promptViaStdin(small)).toBe(false);
  });

  it("moves a large prompt OFF the command line", () => {
    expect(promptViaStdin(huge)).toBe(true);
    const args = buildInvokerArgs(huge, CFG, {});
    expect(args.join(" ")).not.toContain(huge);
    expect(
      args.join(" ").length,
      "the whole point: the assembled command line must fit in the Windows limit",
    ).toBeLessThan(32_767);
  });

  it("KEEPS `-p` when the prompt moves to stdin", () => {
    // `-p` is boolean; the prompt is positional. Dropping the flag too would leave the CLI to
    // infer print mode from a non-TTY stdin — which is what the downstream patch does, and is
    // an inference this does not need to make.
    const args = buildInvokerArgs(huge, CFG, {});
    expect(args[0]).toBe("-p");
    expect(args[1], "the positional prompt is gone; the next token is the next flag").not.toBe(huge);
  });

  it("does not disturb the cage flags", () => {
    // The blast-radius cage is the reason this function is pure and tested. Moving the prompt
    // must not reorder or drop `--mcp-config` / `--strict-mcp-config` / the tool grants.
    const opts = { model: "sonnet", allowed_tools: ["Read"], disallowed_tools: ["Bash"], max_tool_calls: 8 };
    const big = buildInvokerArgs(huge, CFG, opts);
    const lil = buildInvokerArgs(small, CFG, opts);
    const strip = (a: string[]) => a.filter((t) => t !== huge && t !== small);
    expect(strip(big)).toEqual(strip(lil));
    expect(big).toContain("--strict-mcp-config");
    expect(big).toContain("--mcp-config");
    expect(big[big.indexOf("--allowedTools") + 1]).toBe("Read");
  });

  it("the threshold is well under the Windows limit, leaving room for the cage flags", () => {
    // The prompt is not the only thing on the line: the mcp-config path and the tool lists
    // ride along. A threshold at the limit would still overflow.
    expect(PROMPT_ARG_LIMIT_DEFAULT).toBeLessThan(32_767);
    expect(PROMPT_ARG_LIMIT_DEFAULT).toBeGreaterThan(1_000);
  });

  it("COLTRANE_PROMPT_MODE=stdin forces stdin for any size", () => {
    process.env["COLTRANE_PROMPT_MODE"] = "stdin";
    expect(promptViaStdin(small)).toBe(true);
  });

  it("COLTRANE_PROMPT_MODE=arg forces the command line, for a caller who needs the old shape", () => {
    process.env["COLTRANE_PROMPT_MODE"] = "arg";
    expect(promptViaStdin(huge)).toBe(false);
    expect(buildInvokerArgs(huge, CFG, {})[1]).toBe(huge);
  });

  it("an unrecognised mode falls back to auto rather than failing a run", () => {
    // A typo'd env var must not take down every dispatch; the size test is a safe default.
    process.env["COLTRANE_PROMPT_MODE"] = "sideways";
    expect(promptViaStdin(huge)).toBe(true);
    expect(promptViaStdin(small)).toBe(false);
  });

  it("COLTRANE_PROMPT_ARG_LIMIT overrides the threshold", () => {
    process.env["COLTRANE_PROMPT_ARG_LIMIT"] = "5";
    expect(promptViaStdin("123456")).toBe(true);
    expect(promptViaStdin("1234")).toBe(false);
  });

  it("a nonsensical limit falls back to the default", () => {
    for (const bad of ["0", "-1", "banana", ""]) {
      process.env["COLTRANE_PROMPT_ARG_LIMIT"] = bad;
      expect(promptViaStdin("y".repeat(PROMPT_ARG_LIMIT_DEFAULT + 1)), bad).toBe(true);
      expect(promptViaStdin("y"), bad).toBe(false);
    }
  });
});

// ── the prompt must ARRIVE ───────────────────────────────────────────────────
// Removing it from argv is half the change. If nothing writes it to the child, the model is
// handed no prompt at all — a worse bug than the one being fixed, and one every test above
// would still pass. This exercises the real spawn against a stand-in binary that echoes what
// it received, so the assertion is about delivery rather than intent.
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeClaudeInvoker } from "../src/claude_invoker.js";
import { testAgent } from "./_support/agents.js";

describe("prompt delivery — end to end through the real spawn", () => {
  let dir: string;
  let bin: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prompt-stdin-"));
    bin = join(dir, "fake-claude.sh");
    // Reads stdin, and reports its length plus the argv it saw, as one stream-json result line.
    writeFileSync(
      bin,
      `#!/bin/sh
IN=$(cat)
LEN=\${#IN}
printf '{"type":"result","subtype":"success","result":"{\\\\"stdin_len\\\\":%s,\\\\"argc\\\\":%s}"}\\n' "$LEN" "$#"
`,
    );
    chmodSync(bin, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const agent = testAgent({ slug: "a", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "d" });

  // The invoker composes the prompt itself (buildPrompt over the agent, inputs and output
  // specs); a caller does not supply one. So the assertion is on DELIVERY — that a real,
  // non-empty prompt reaches the child's stdin — rather than on a literal we chose.
  it("writes the prompt to the child's stdin", async () => {
    process.env["COLTRANE_PROMPT_MODE"] = "stdin";
    const invoke = makeClaudeInvoker({ bin });
    const out = (await invoke({ agent, inputs: [], output_specs: [] } as never)) as { stdin_len: number };
    expect(
      out.stdin_len,
      "the prompt must reach the child, not merely leave argv — otherwise the model is " +
        "handed nothing at all, which is worse than the bug being fixed",
    ).toBeGreaterThan(100);
  });

  it("delivers the SAME prompt either way — the route changes, the content does not", async () => {
    const invoke = makeClaudeInvoker({ bin });
    process.env["COLTRANE_PROMPT_MODE"] = "stdin";
    const viaStdin = (await invoke({ agent, inputs: [], output_specs: [] } as never)) as
      { stdin_len: number; argc: number };
    process.env["COLTRANE_PROMPT_MODE"] = "arg";
    const viaArg = (await invoke({ agent, inputs: [], output_specs: [] } as never)) as
      { stdin_len: number; argc: number };

    expect(viaArg.stdin_len, "nothing goes down stdin on the argv path").toBe(0);
    expect(viaStdin.stdin_len).toBeGreaterThan(0);
    // argv loses exactly one token — the positional prompt — and keeps `-p` and the cage.
    expect(viaArg.argc - viaStdin.argc).toBe(1);
  });

  it("closes stdin after writing, so the child is not left waiting on EOF", async () => {
    // The fake binary blocks on `cat` until EOF. Completing at all IS the assertion; a stdin
    // left open would hang here and surface as a timeout rather than an answer.
    process.env["COLTRANE_PROMPT_MODE"] = "stdin";
    const invoke = makeClaudeInvoker({ bin });
    await expect(
      invoke({ agent, inputs: [], output_specs: [] } as never),
    ).resolves.toBeTruthy();
  });

  it("sends nothing on stdin when the prompt rides on argv", async () => {
    process.env["COLTRANE_PROMPT_MODE"] = "arg";
    const invoke = makeClaudeInvoker({ bin });
    const out = (await invoke({ agent, inputs: [], output_specs: [] } as never)) as
      { stdin_len: number };
    // stdin is "ignore" on this path, so `cat` reads EOF immediately. The existing spawn
    // behaviour for every caller below the threshold is unchanged.
    expect(out.stdin_len).toBe(0);
  });
});
