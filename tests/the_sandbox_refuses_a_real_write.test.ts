// D4 — THE SANDBOX THE INVOKER BUILDS REFUSES A REAL WRITE (real process; skipped as UNVERIFIED when the
// runtime is absent — never counted as a pass).
//
// The argv laws (a_seats_bash_runs_in_a_sandbox) prove the invoker ASKS for a sandbox. They cannot prove
// the request is ENFORCED: the conductor measured relative denies being silently ignored, so "the flag
// is on the argv" and "the write is refused" are different claims. This law runs a real process under
// the settings the invoker builds and watches the OS refuse the write.
//
// DETERMINISM. `claude -p` cannot run a Bash command without a model deciding to run it, and a law that
// depends on a model obeying a prompt is not a law. The CLI's sandbox is the open-source
// @anthropic-ai/sandbox-runtime (`srt`), which runs an arbitrary command under the same filesystem
// config with no model. So this law drives `srt` directly with the sandbox.filesystem the invoker put
// on its argv (plus `allowWrite: [<tree>]`, the CLI's own default of a writable cwd, which srt does not
// assume). What it proves is "these settings, enforced by this runtime, refuse these writes" — not that
// the CLI passes them through unaltered; the argv laws and the conductor's CLI probe cover that half.
//
// RUNS ONLY WHEN: an `srt` binary is on PATH (or COLTRANE_SRT names one) AND the OS has a sandbox
// (macOS /usr/bin/sandbox-exec, or Linux bwrap on PATH). Otherwise the law is SKIPPED and the reason is
// printed as UNVERIFIED. This repo does not add srt as a dependency; a CI job that wants this law
// verified installs it.
//
//   law                                             kind         drives                                          plant
//   a write outside the tree is refused              behavioural  makeClaudeInvoker(...) argv → srt enforcing it  drop allowWrite-by-default / deny nothing
//   a write to <tree>/coltrane.layout.json refused   behavioural  same                                            make the layout deny relative
//   control: a write inside src/ succeeds            behavioural  same                                            deny the whole tree
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { realpathSync } from "node:fs";
import { makeClaudeInvoker } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { testAgent } from "./_support/agents.js";
import { settingsOf, LAYOUT_FILE } from "./layout_grants_fixtures.js";

function onPath(bin: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    const p = join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}
const SRT = process.env["COLTRANE_SRT"] || onPath("srt");
const OS_SANDBOX = process.platform === "darwin" ? existsSync("/usr/bin/sandbox-exec") : process.platform === "linux" ? onPath("bwrap") !== undefined : false;
const UNAVAILABLE = !SRT ? "no srt (sandbox-runtime) on PATH and COLTRANE_SRT unset" : !OS_SANDBOX ? `no OS sandbox on ${process.platform} (sandbox-exec / bwrap)` : "";
if (UNAVAILABLE) console.warn(`[UNVERIFIED] the_sandbox_refuses_a_real_write: SKIPPED — ${UNAVAILABLE}. The sandbox's enforcement is not verified on this host.`);

describe("D4 — the sandbox the invoker builds refuses a real write (skipped as UNVERIFIED without srt + an OS sandbox)", () => {
  it.skipIf(Boolean(UNAVAILABLE))("a write outside the tree and a write to the layout file are refused; a write inside src/ succeeds", async () => {
    const tree = realpathSync(mkdtempSync(join(tmpdir(), "sbx-tree-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "sbx-outside-")));
    mkdirSync(join(tree, "src"));
    writeFileSync(join(tree, LAYOUT_FILE), "{}\n");
    execFileSync("git", ["init", "--quiet", tree]);

    let args: string[] = [];
    const invoke = makeClaudeInvoker({ toolProviders: new Map(), mcpServerConfigs: {}, run: (_b, a) => { args = a; return "{}"; } });
    const agent = testAgent({ slug: "builder", primitives: ["CREATE"], input_types: [], output_types: ["built-thing"], domain: "demo", allowed_tools: ["Read", "Bash(@laws)"] });
    try {
      await invoke({ agent, phase: "build", inputs: [], gig_input: { request_text: "x" }, layout: { commands: { laws: ["npx vitest run"] } }, tree_root: tree } as unknown as AgentInvocationContext);
    } catch { /* only the argv matters */ }
    const sb = settingsOf(args)[0]?.["sandbox"] as { filesystem?: Record<string, string[]> } | undefined;
    expect(sb?.filesystem, "the invoker built no sandbox filesystem config — there is nothing to enforce").toBeDefined();

    const cfg = join(outside, "srt-settings.json");
    writeFileSync(cfg, JSON.stringify({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: sb!.filesystem!["denyRead"] ?? [],
        allowWrite: [tree, ...(sb!.filesystem!["allowWrite"] ?? [])],
        denyWrite: sb!.filesystem!["denyWrite"] ?? [],
      },
    }));
    const sh = (cmd: string) => spawnSync(SRT!, ["--settings", cfg, "--", "sh", "-c", cmd], { cwd: tree, encoding: "utf8", timeout: 30_000 });

    const inside = sh(`echo ok > '${join(tree, "src", "ok.txt")}'`);
    expect(inside.status, `control: the sandbox refused a write inside src/ — it denies everything, so its refusals below prove nothing (${inside.stderr})`).toBe(0);
    expect(readFileSync(join(tree, "src", "ok.txt"), "utf8").trim()).toBe("ok");

    sh(`echo bad > '${join(outside, "escaped.txt")}'`);
    expect(existsSync(join(outside, "escaped.txt")), "a sandboxed Bash wrote OUTSIDE the tree").toBe(false);

    sh(`echo '{"paths":{"source":["**"]}}' > '${join(tree, LAYOUT_FILE)}'`);
    expect(readFileSync(join(tree, LAYOUT_FILE), "utf8").trim(), "a sandboxed Bash rewrote the layout file").toBe("{}");

    sh(`echo x > '${join(tree, ".git", "hooks", "pre-commit")}'`);
    expect(existsSync(join(tree, ".git", "hooks", "pre-commit")), "a sandboxed Bash planted a git hook").toBe(false);
  }, 120_000);
});
