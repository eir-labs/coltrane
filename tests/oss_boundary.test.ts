/** LAWS FOR THE PUBLISHING BOUNDARY.
 *
 *  The gate exists because the rule it enforces previously had no failure mode. These laws therefore
 *  spend most of their attention on the ways a gate can LOOK enforced while enforcing nothing — an
 *  absent list read as a pass, a case change walking through, a scan that reports clean because it
 *  scanned nothing.
 *
 *  Every term used here is invented for the test. The real list is never in this repository, and a
 *  fixture drawn from it would defeat the whole arrangement. */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanBoundary, formatOutcome, BOUNDARY_LIST_ENV } from "../src/boundary_scan.js";

/** A private term list on disk, outside any repository — the shape CI provisions from a secret. */
function listAt(terms: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "boundary-list-"));
  const p = join(dir, "terms.txt");
  writeFileSync(p, ["# a comment line, ignored", "", ...terms].join("\n"));
  return p;
}

const envWith = (path: string): NodeJS.ProcessEnv => ({ [BOUNDARY_LIST_ENV]: path });

describe("the gate catches what it exists to catch", () => {
  it("a forbidden term in scanned content is a VIOLATION, located by path and line", () => {
    const env = envWith(listAt(["zarquon", "blortwave"]));
    const out = scanBoundary(
      [
        ["docs/a.md", "line one\nline two mentions zarquon here\nline three"],
        ["src/b.ts", "nothing of interest"],
      ],
      env,
    );
    expect(out.status).toBe("violation");
    if (out.status !== "violation") return;
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]).toMatchObject({ path: "docs/a.md", line: 2, term: "zarquon" });
  });

  it("case does not walk through — a boundary Title Case defeats is not a boundary", () => {
    const env = envWith(listAt(["zarquon"]));
    const out = scanBoundary([["docs/a.md", "The Zarquon Protocol"]], env);
    expect(out.status).toBe("violation");
  });

  it("content with no forbidden term is CLEAN, and says what it actually scanned", () => {
    const env = envWith(listAt(["zarquon"]));
    const out = scanBoundary([["docs/a.md", "entirely unremarkable prose"]], env);
    expect(out.status).toBe("clean");
    if (out.status !== "clean") return;
    expect(out.files).toBe(1);
    expect(out.terms).toBe(1);
  });
});

describe("the gate cannot pass by accident — every way of enforcing nothing is a distinct outcome", () => {
  // THE LAW THIS WHOLE FILE EXISTS FOR. An unset list must NOT read as clean. A gate that reports
  // success when it never ran is worse than no gate: it converts an unchecked push into a checked
  // one in the operator's mind. `unavailable` is a third state precisely so a caller must handle it.
  it("NO LIST is 'unavailable', never 'clean' — a check that did not run did not pass", () => {
    const out = scanBoundary([["docs/a.md", "anything at all"]], {});
    expect(out.status).toBe("unavailable");
    expect(out.status === "unavailable" && out.reason).toContain(BOUNDARY_LIST_ENV);
  });

  it("a list path that cannot be read is 'unavailable', and names the path it tried", () => {
    const out = scanBoundary([["docs/a.md", "anything"]], envWith("/nonexistent/terms.txt"));
    expect(out.status).toBe("unavailable");
    expect(out.status === "unavailable" && out.reason).toContain("/nonexistent/terms.txt");
  });

  // An empty list would scan every file and find nothing, reporting a triumphant clean. That is the
  // same failure as no list at all wearing a success badge, so it is the same outcome.
  it("an EMPTY list is 'unavailable', not a clean sweep of zero terms", () => {
    const out = scanBoundary([["docs/a.md", "anything"]], envWith(listAt([])));
    expect(out.status).toBe("unavailable");
  });

  // A clean verdict over nothing is the third disguise: the gate ran, the list was real, and the
  // caller passed it no content. The outcome carries `files` so a caller can refuse a zero-file scan.
  it("a clean verdict reports the file count, so a scan of NOTHING is visible as such", () => {
    const out = scanBoundary([], envWith(listAt(["zarquon"])));
    expect(out.status).toBe("clean");
    expect(out.status === "clean" && out.files).toBe(0);
  });
});

describe("the gate does not become the leak", () => {
  it("the scanner module ships no terms of its own — it is inert without the private list", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/boundary_scan.ts", import.meta.url), "utf8"),
    );
    // No default, fallback, or example list may exist in the published file. The only string literals
    // it may carry are the env var name and its own diagnostics.
    expect(src).not.toMatch(/const\s+(DEFAULT|FALLBACK|EXAMPLE)_?TERMS/i);
    expect(scanBoundary([["a", "b"]], {}).status).toBe("unavailable");
  });

  it("a violation renders for an operator who holds the list, and a clean one reveals no terms", () => {
    const env = envWith(listAt(["zarquon"]));
    expect(formatOutcome(scanBoundary([["docs/a.md", "zarquon"]], env))).toContain("docs/a.md:1");
    expect(formatOutcome(scanBoundary([["docs/a.md", "fine"]], env))).not.toContain("zarquon");
  });
});
