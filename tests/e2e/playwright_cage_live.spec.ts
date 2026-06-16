// Live proof of the caged browser — coltrane's deny-by-default Playwright. An agent declares it may
// reach ONLY ppubs.uspto.gov; coltrane builds the server config that enforces it. We then dispatch
// a real browser agent through the coltrane invoker and assert: the allowlisted origin LOADS, and an
// off-allowlist origin is REFUSED at the network (never reached). This is the substrate's proof of
// usefulness — raw browser automation, made safe by construction. Gated behind COLTRANE_LIVE=1
// (real browser, real network).
//
// Run: COLTRANE_LIVE=1 npx vitest run --config tests/e2e/vitest.config.ts \
//   tests/e2e/playwright_cage_live.spec.ts
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeClaudeInvoker } from "../../src/claude_invoker.js";
import type { AgentInvocationContext } from "../../src/runtime.js";

const LIVE = process.env["COLTRANE_LIVE"] === "1";
const T = (n: string) => `mcp__playwright__${n}`;

describe.skipIf(!LIVE)("the caged browser is deny-by-default — allowlisted loads, off-list is refused", () => {
  it("an agent caged to ppubs.uspto.gov reaches USPTO and is blocked from example.com", async () => {
    const agent = {
      slug: "cage-proof", primitives: ["SENSE"], input_types: [], output_types: ["finding"], domain: "demo",
      identity: "You test a caged browser by attempting two navigations and reporting exactly what happens for each.",
      method: [
        "1. browser_navigate to https://ppubs.uspto.gov/pubwebapp/ . Note whether it loaded or was refused/errored.",
        "2. browser_navigate to https://example.com/ . Note whether it loaded or was refused/errored.",
        "3. Output ONLY JSON: {\"allowlisted_uspto_loaded\":<true|false>,\"offlist_example_loaded\":<true|false>}",
      ].join("\n"),
      constraints: [], behavioral_primitives: ["explorer", "critic"],
      allowed_tools: [T("browser_navigate"), T("browser_snapshot")],
      // coltrane builds the deny-by-default cage from THIS declaration — only ppubs.uspto.gov loads
      browser_grant: { allowed_origins: ["ppubs.uspto.gov"], trace_dir: join(tmpdir(), "coltrane-pw-cage") },
      max_tool_calls: 14,
    };
    const invoke = makeClaudeInvoker({ mcpServerConfigs: {}, timeout_ms: 240_000 });
    const out = await invoke({ agent, phase: "p", inputs: [], gig_input: {} } as unknown as AgentInvocationContext) as Record<string, unknown>;
    expect(out["allowlisted_uspto_loaded"], "the allowlisted origin must load").toBe(true);
    expect(out["offlist_example_loaded"], "an off-allowlist origin must be refused by the cage").toBe(false);
  }, 300_000);
});
