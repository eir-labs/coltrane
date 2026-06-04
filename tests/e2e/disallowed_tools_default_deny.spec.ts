// PREREG: defineAgent applies a DEFAULT-DENY lower bound to every agent's
// disallowed_tools — the cage's sword. An agent that declares NOTHING still has
// Bash/Read/Write/Edit/Task/WebFetch/WebSearch/Shell/KillBash/BashOutput rejected
// at spawn. Explicit per-agent disallowed_tools EXTENDS the baseline (additive).
// Explicit per-agent allowed_tools WINS (a tool granted there is removed from
// the deny list — so a standard CAN explicitly opt back into Bash if it truly
// needs to).
//
// HYPOTHESIS:
//   (a) defineAgent({...no tools declared}) → effective disallowed_tools contains
//       the full DEFAULT_DENY_TOOLS baseline.
//   (b) defineAgent({disallowed_tools: ["custom_x"]}) → baseline ∪ ["custom_x"],
//       deduped.
//   (c) defineAgent({allowed_tools: ["Read"]}) → baseline MINUS "Read"
//       (allowed wins).
//   (d) buildInvokerArgs receives the merged list → --disallowedTools flag emitted
//       even when the agent declared nothing.
//
// GREEN → the sword is always raised; lower bound holds at spawn.
// RED   → defineAgent silently lets agents through with no disallow list.

import { describe, it, expect } from "vitest";
import {
  defineAgent,
  effectiveDisallowedTools,
  DEFAULT_DENY_TOOLS,
} from "../../src/composition.js";
import { buildInvokerArgs } from "../../src/claude_invoker.js";

describe("default-deny lower bound — disallowed_tools as the sword", () => {
  it("(a) agent with NO tool declarations still gets the full DEFAULT_DENY baseline", () => {
    const a = defineAgent({ slug: "bare", primitives: ["SENSE"] });
    // every tool in the baseline must be on the agent's effective deny list.
    for (const t of DEFAULT_DENY_TOOLS) {
      expect(
        a.disallowed_tools,
        `bare agent missing baseline-denied tool "${t}" — sword not raised`,
      ).toContain(t);
    }
    // and the canonical escapes are all there:
    for (const t of ["Bash", "Read", "Write", "Edit", "Task", "WebFetch", "WebSearch", "Shell", "KillBash", "BashOutput"]) {
      expect(a.disallowed_tools).toContain(t);
    }
  });

  it("(b) explicit disallowed_tools EXTEND the baseline (additive, deduped)", () => {
    const a = defineAgent({
      slug: "extender",
      primitives: ["SENSE"],
      disallowed_tools: ["mcp__custom__danger", "Bash"], // Bash overlaps the baseline
    });
    // baseline floor present
    for (const t of DEFAULT_DENY_TOOLS) expect(a.disallowed_tools).toContain(t);
    // explicit addition present
    expect(a.disallowed_tools).toContain("mcp__custom__danger");
    // de-duplicated: "Bash" appears exactly once
    const bashCount = a.disallowed_tools!.filter((x) => x === "Bash").length;
    expect(bashCount).toBe(1);
  });

  it("(c) explicit allowed_tools WIN — they're removed from the baseline deny list", () => {
    const a = defineAgent({
      slug: "grantee",
      primitives: ["SENSE"],
      allowed_tools: ["Read", "Bash"], // standard explicitly needs these
    });
    // the granted tools are NOT in the deny list (allowed wins)
    expect(a.disallowed_tools).not.toContain("Read");
    expect(a.disallowed_tools).not.toContain("Bash");
    // but other baseline tools are still denied
    expect(a.disallowed_tools).toContain("Write");
    expect(a.disallowed_tools).toContain("Task");
    expect(a.disallowed_tools).toContain("WebFetch");
  });

  it("(d) the sword reaches the CLI — buildInvokerArgs emits --disallowedTools for bare agents", () => {
    const a = defineAgent({ slug: "bare2", primitives: ["SENSE"] });
    const args = buildInvokerArgs("p", "/tmp/c.json", {
      allowed_tools: a.allowed_tools,
      disallowed_tools: a.disallowed_tools,
    });
    const i = args.indexOf("--disallowedTools");
    expect(
      i,
      `--disallowedTools missing from CLI args even though defineAgent populated the baseline`,
    ).toBeGreaterThan(-1);
    const csv = args[i + 1]!;
    // each baseline tool appears in the CSV
    for (const t of DEFAULT_DENY_TOOLS) {
      expect(csv).toContain(t);
    }
  });

  it("(e) effectiveDisallowedTools is the pure, testable computation", () => {
    // bare
    expect(effectiveDisallowedTools(undefined, undefined)).toEqual([...DEFAULT_DENY_TOOLS]);
    // additive
    const ext = effectiveDisallowedTools(["mcp__x__y"], undefined);
    expect(ext).toContain("mcp__x__y");
    expect(ext.length).toBe(DEFAULT_DENY_TOOLS.length + 1);
    // allow wins
    const granted = effectiveDisallowedTools(undefined, ["Bash", "Read"]);
    expect(granted).not.toContain("Bash");
    expect(granted).not.toContain("Read");
    expect(granted.length).toBe(DEFAULT_DENY_TOOLS.length - 2);
  });
});
