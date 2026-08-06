// #234 — a tool's advertised schema and its handler are two statements of one fact.
//
// `gig_dispatch` accepted a `budget` argument and enforced a real spend ceiling with it, and
// `budget` appeared nowhere in the tool's advertised `input_schema`. An MCP client reads that
// schema to learn what a tool takes; a guardrail nobody can find is a guardrail nobody sets.
// That is #238's disease pointed the other way — not a fabricated number reported, but a real
// control not reported at all.
//
// The first version of this file checked gig_dispatch and nothing else. Sweeping the SAME two
// assertions across all 37 tools found drift in a further nine, three of them load-bearing:
//
//   output_write        — read `gig_id`/`agent_slug`/`phase`, advertised none of them. A skill
//                         prompt written against the schema omits `gig_id`, the handler defaults
//                         it to "", and the sealed output is attached to NO gig. A live run of
//                         the consuming product produced 509 such orphans.
//   capability_research — advertised `need`/`context`, read `query`/`capability`. Zero overlap,
//                         so every schema-following call searched for "", matched nothing, and
//                         was told `gap: true — propose a new tool/type`. The one tool whose job
//                         is to prevent redundant definitions recommended one unconditionally.
//   access_grant_check  — advertised `company_id`/`resource_uri`/`required_permissions`, read
//                         `grant`/`plan`/`now_ms`. A caller obeying the schema got an answer
//                         computed from an absent grant.
//
// Both directions are bugs, and the sweep found both:
//   read but not advertised → an undiscoverable control (this issue)
//   advertised but not read → a silent no-op (#237, `depth`; and `window`, `status`, …)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MCP_TOOLS } from "../src/mcp.js";

const SERVER_SRC = readFileSync(path.resolve(__dirname, "../src/server.ts"), "utf-8");

interface Handler { reads: Set<string>; dynamic: boolean }

/**
 * Map every tool slug to the `args["x"]` keys its `case` block reads.
 *
 * Consecutive `case` labels share one body (JS fallthrough), so they are grouped — otherwise
 * `agent_promote` in `case "agent_promote": case "standard_promote": … {…}` would parse as
 * having an empty body and vacuously pass every assertion below. (That is not hypothetical:
 * `current` went unadvertised on all three promote tools, and an ungrouped parser would have
 * reported them clean.)
 */
function parseHandlers(): Map<string, Handler> {
  const labels = [...SERVER_SRC.matchAll(/^[ \t]*case "([a-z0-9_]+)":/gm)]
    .map((m) => ({ slug: m[1]!, start: m.index!, end: m.index! + m[0].length }));

  const groups: Array<{ slugs: string[]; start: number; end: number }> = [];
  for (const l of labels) {
    const prev = groups[groups.length - 1];
    if (prev && SERVER_SRC.slice(prev.end, l.start).trim() === "") {
      prev.slugs.push(l.slug);
      prev.end = l.end;
    } else {
      groups.push({ slugs: [l.slug], start: l.start, end: l.end });
    }
  }

  const out = new Map<string, Handler>();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const body = SERVER_SRC.slice(g.end, i + 1 < groups.length ? groups[i + 1]!.start : undefined);
    const reads = new Set([...body.matchAll(/args\["([a-z0-9_]+)"\]/g)].map((m) => m[1]!));
    // A handler that indexes `args` by a VARIABLE, spreads it, parses it wholesale with a zod
    // schema, or casts it, consumes keys this parser cannot enumerate. The unread direction is
    // genuinely uncheckable for those; the unadvertised direction still is not, and is enforced
    // for every tool below.
    const dynamic = /args\[[A-Za-z_$]/.test(body)
      || /\.parse\(\s*args\b/.test(body)
      || /\.\.\.\s*args\b/.test(body)
      || /\bargs\s+as\s+/.test(body);
    for (const s of g.slugs) out.set(s, { reads, dynamic });
  }
  return out;
}

const HANDLERS = parseHandlers();

function advertised(slug: string): Set<string> {
  const tool = MCP_TOOLS.find((t) => t.slug === slug);
  const schema = tool?.input_schema as { properties?: Record<string, unknown> } | undefined;
  return new Set(Object.keys(schema?.properties ?? {}));
}

describe("#234 — every tool's advertised schema matches what its handler reads", () => {
  // THE case that opened the issue.
  it("gig_dispatch advertises `budget`, which it has always enforced", () => {
    expect(
      advertised("gig_dispatch").has("budget"),
      "the spend ceiling is real; a caller reading the schema could not learn it exists",
    ).toBe(true);
    expect(HANDLERS.get("gig_dispatch")?.reads.has("budget"), "and the handler must actually read it").toBe(true);
  });

  // ── the sweep ─────────────────────────────────────────────────────────────
  it("NO tool reads an argument it does not advertise", () => {
    const drift: string[] = [];
    for (const tool of MCP_TOOLS) {
      const h = HANDLERS.get(tool.slug);
      if (!h) continue; // covered by the parser-integrity test below
      const ads = advertised(tool.slug);
      const undiscoverable = [...h.reads].filter((a) => !ads.has(a));
      if (undiscoverable.length) drift.push(`${tool.slug}: ${JSON.stringify(undiscoverable)}`);
    }
    expect(
      drift,
      "read by the handler and absent from the advertised schema — a control no client can find",
    ).toEqual([]);
  });

  it("NO tool advertises an argument it never reads", () => {
    const drift: string[] = [];
    for (const tool of MCP_TOOLS) {
      const h = HANDLERS.get(tool.slug);
      if (!h || h.dynamic) continue;
      const noOps = [...advertised(tool.slug)].filter((a) => !h.reads.has(a));
      if (noOps.length) drift.push(`${tool.slug}: ${JSON.stringify(noOps)}`);
    }
    expect(
      drift,
      "advertised to callers and never read — a filter that silently does nothing, cf. #237",
    ).toEqual([]);
  });

  it("every advertised tool HAS a handler", () => {
    // The sweeps above `continue` past a missing handler, so without this a tool that lost its
    // case block would be exempt from both of them rather than caught by either.
    const orphans = MCP_TOOLS.filter((t) => !HANDLERS.has(t.slug)).map((t) => t.slug);
    expect(orphans, "advertised with no case block in dispatchTool").toEqual([]);
  });

  // ── the specific regressions, named so a re-break says what it broke ──────
  it("output_write advertises `gig_id` — the field that anchors an output to its run", () => {
    expect(
      advertised("output_write").has("gig_id"),
      "509 orphaned outputs in one live run came from prompts written against a schema that " +
        "did not mention the argument the handler reads",
    ).toBe(true);
  });

  it("capability_research reads the name it advertises", () => {
    const h = HANDLERS.get("capability_research")!;
    expect(advertised("capability_research").has("need")).toBe(true);
    expect(h.reads.has("need"), "advertising `need` while reading `query` searched for nothing").toBe(true);
  });

  it("the promotion chain check is discoverable on all three promote tools", () => {
    // `current` is what turns standard_promote into a checked transition rather than a
    // recorded intent, and no caller could learn it existed.
    for (const slug of ["agent_promote", "standard_promote", "skill_promote"]) {
      expect(advertised(slug).has("current"), `${slug} must advertise \`current\``).toBe(true);
    }
  });

  // ── guards the guard ─────────────────────────────────────────────────────
  it("the handler parser actually finds arguments", () => {
    // Without this, a parser that silently stopped matching would make every sweep above pass
    // over empty sets and prove nothing.
    expect(HANDLERS.get("gig_dispatch")?.reads.has("standard_slug")).toBe(true);
    expect(HANDLERS.has("this_tool_does_not_exist")).toBe(false);
    expect(HANDLERS.size, "most tools should have been located").toBeGreaterThan(30);
  });

  it("the parser groups fallthrough case labels into one body", () => {
    // `case "agent_promote": case "standard_promote": case "skill_promote": {…}` — the first
    // two labels have no body of their own. Treating them as empty would exempt them from both
    // sweeps, which is how `current` stayed unadvertised on all three.
    const slugs = ["agent_promote", "standard_promote", "skill_promote"];
    const handlers = slugs.map((s) => HANDLERS.get(s));
    for (const [i, h] of handlers.entries()) {
      expect(h, `${slugs[i]} must resolve to a handler`).toBeTruthy();
    }
    expect(handlers[0]!.reads, "fallthrough labels share one body, so they share its reads").toEqual(handlers[1]!.reads);
    expect(handlers[1]!.reads).toEqual(handlers[2]!.reads);
    expect(handlers[0]!.reads.has("current"), "and the shared body's reads must be found at all").toBe(true);
  });

  it("tools with DIFFERENT arguments are not merged into one body", () => {
    // The inverse hazard, hit while fixing this issue: tool_propose and tool_deprecate_propose
    // were briefly written as one fallthrough block, which made each appear to read the
    // other's arguments — reintroducing schema/handler drift inside the fix for it.
    expect(HANDLERS.get("tool_propose")!.reads.has("usage_stats")).toBe(false);
    expect(HANDLERS.get("tool_deprecate_propose")!.reads.has("spec")).toBe(false);
  });

  it("the dynamic-access exemption is narrow, not a blanket", () => {
    // The unread sweep skips handlers that consume `args` in ways this parser cannot enumerate.
    // If that set grew to cover most tools the sweep would be decorative.
    const exempt = MCP_TOOLS.filter((t) => HANDLERS.get(t.slug)?.dynamic).map((t) => t.slug);
    expect(exempt.length, `exempt from the unread sweep: ${exempt.join(", ")}`).toBeLessThan(8);
  });
});
