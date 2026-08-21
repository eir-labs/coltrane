// RED-first — a denial must say WHICH KIND of denial it is, because the two kinds demand opposite
// responses and the seat cannot currently tell them apart.
//
// THE AMBIGUITY. `permission_denied` means BOTH:
//   · "you may not do this"                     → abandon the approach
//   · "you phrased it in a form your grant       → rephrase and continue
//      does not match"
// A chair that cannot distinguish them does the expensive thing: it reasons about the refusal.
// Gig 486e0e6c spent its remaining budget doing exactly that and died having written no law.
//
// THE PURE CASE, measured: that chair HELD `Bash(git add:*)` and was refused `git -C /repo add -A`.
// The `-C` flag sits between the verb and the prefix the grant matches on. It had the authority and
// could not reach it — and the refusal looked identical to being forbidden outright.
//
// IT IS DIAGNOSABLE WITHOUT CHANGING THE GRANT MODEL. If the words of a grant the seat HOLDS appear
// IN ORDER in the refused command, the seat was authorised for that verb and the FORM was wrong.
// That is a heuristic, not a proof, and it must fail toward "undetermined" rather than assert —
// telling an agent to rephrase when it is genuinely forbidden would send it in a loop.
//
// Every fixture below is verbatim from a real gig log.
import { describe, it, expect } from "vitest";
import { diagnoseDenial } from "../src/claude_invoker.js";

const GRANTS = ["Read", "Glob", "Grep", "Bash(git add:*)", "Bash(git diff:*)", "Bash(git status:*)"];

describe("a denial says which kind it is", () => {
  it("K1 — a granted verb in a form the grant does not match is a FORM MISMATCH", () => {
    // The measured case. The seat holds Bash(git add:*); `-C` breaks the prefix.
    const d = diagnoseDenial(
      { tool: "Bash", reason: "This Bash command contains multiple operations. The following parts require approval: git -C /repo add -A" },
      GRANTS,
    );
    expect(d.kind).toBe("form-mismatch");
    expect(d.detail).toMatch(/git add/);
  });

  it("K2 — a verb no grant covers is NOT-GRANTED, and must not suggest rephrasing", () => {
    const d = diagnoseDenial(
      { tool: "Bash", reason: "This Bash command contains multiple operations. The following part requires approval: awk -F: '$1 > 2961'" },
      GRANTS,
    );
    expect(d.kind).toBe("not-granted");
    expect(d.detail).not.toMatch(/rephrase/i);
  });

  it("K3 — a message with no extractable command is UNDETERMINED, never a guess", () => {
    // "Absent must mean DECLINE." Asserting a kind here would send an agent looping on a rephrase
    // that cannot work, which is worse than saying nothing.
    const d = diagnoseDenial({ tool: "Bash", reason: "This command requires approval" }, GRANTS);
    expect(d.kind).toBe("undetermined");
  });

  it("K4 — a non-Bash denial is UNDETERMINED: this heuristic is about command text only", () => {
    const d = diagnoseDenial(
      { tool: "Write", reason: "Claude requested permissions to write to /tmp/x.md, but you haven't granted it yet." },
      GRANTS,
    );
    expect(d.kind).toBe("undetermined");
  });

  // ── NON-VACUITY ───────────────────────────────────────────────────────────────────────────────
  it("K5 — a seat holding NO Bash grants never gets a form-mismatch verdict", () => {
    // Without this, an implementation that returned "form-mismatch" whenever it saw a command would
    // pass K1 and tell every refused agent to rephrase.
    const d = diagnoseDenial(
      { tool: "Bash", reason: "The following parts require approval: git -C /repo add -A" },
      ["Read", "Glob", "Grep"],
    );
    expect(d.kind).toBe("not-granted");
  });

  it("K6 — the words must appear IN ORDER, not merely both be present", () => {
    // Both `add` and `git` appear here as whole words, in the WRONG order. A bag-of-words match
    // would call this a form mismatch and tell the agent to rephrase a command it cannot run.
    //
    // This fixture replaces one that was VACUOUS: `add-user git-helper` also returned not-granted,
    // but for the word-BOUNDARY check rather than the order check — so dropping the in-order
    // requirement entirely left the law green. Caught by sabotage, not by reading.
    const d = diagnoseDenial(
      { tool: "Bash", reason: "The following part requires approval: add stuff && git status" },
      ["Bash(git add:*)"],
    );
    expect(d.kind).toBe("not-granted");
  });
});
