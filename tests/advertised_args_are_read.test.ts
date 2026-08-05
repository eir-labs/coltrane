// #234 — enforcement that no caller can discover.
//
// `gig_dispatch` accepted a `budget` argument and enforced a real spend ceiling with it, and
// `budget` appeared nowhere in the tool's advertised `input_schema`. An MCP client reads that
// schema to learn what a tool takes; a guardrail nobody can find is a guardrail nobody sets.
// That is #238's disease pointed the other way — not a fabricated number reported, but a real
// control not reported at all.
//
// The generalisation is the point of this file: the handler and the advertisement are two
// statements of one fact, and nothing was checking they agreed. `depth` had already drifted
// the other way once (#237: advertised and silently discarded), so this has happened in both
// directions.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MCP_TOOLS } from "../src/mcp.js";

const SERVER_SRC = readFileSync(path.resolve(__dirname, "../src/server.ts"), "utf-8");

/** The `args["x"]` reads inside one tool's `case` block in dispatchTool. */
function argsReadBy(slug: string): Set<string> {
  const start = SERVER_SRC.indexOf(`case "${slug}":`);
  if (start === -1) return new Set();
  // The next `case "` at the same nesting is the end of this handler.
  const next = SERVER_SRC.indexOf(`      case "`, start + 10);
  const body = SERVER_SRC.slice(start, next === -1 ? undefined : next);
  return new Set([...body.matchAll(/args\["([a-z0-9_]+)"\]/gi)].map((m) => m[1]!));
}

function advertised(slug: string): Set<string> {
  const tool = MCP_TOOLS.find((t) => t.slug === slug);
  const schema = tool?.input_schema as { properties?: Record<string, unknown> } | undefined;
  return new Set(Object.keys(schema?.properties ?? {}));
}

describe("#234 — a tool's advertised schema matches what its handler reads", () => {
  // THE case: budget was enforced and unadvertised.
  it("gig_dispatch advertises `budget`, which it has always enforced", () => {
    expect(
      advertised("gig_dispatch").has("budget"),
      "the spend ceiling is real; a caller reading the schema could not learn it exists",
    ).toBe(true);
    expect(argsReadBy("gig_dispatch").has("budget"), "and the handler must actually read it").toBe(true);
  });

  // The guard that stops this recurring. Both directions are bugs:
  //   read but not advertised → undiscoverable (this issue)
  //   advertised but not read → a silent no-op (#237, `depth`)
  it("every argument gig_dispatch reads is advertised, and every advertised one is read", () => {
    const reads = argsReadBy("gig_dispatch");
    const ads = advertised("gig_dispatch");
    expect(reads.size, "the handler body was located").toBeGreaterThan(3);

    const undiscoverable = [...reads].filter((a) => !ads.has(a));
    const noOps = [...ads].filter((a) => !reads.has(a));

    expect(undiscoverable, "read by the handler but absent from the advertised schema").toEqual([]);
    expect(noOps, "advertised to callers but never read — a silent no-op, cf. #237").toEqual([]);
  });

  // Guards the guard: if the parser stopped finding the handler, both assertions above would
  // pass over empty sets and prove nothing.
  it("the handler parser actually finds arguments", () => {
    expect(argsReadBy("gig_dispatch").has("standard_slug")).toBe(true);
    expect(argsReadBy("this_tool_does_not_exist").size).toBe(0);
  });
});
