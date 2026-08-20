// THE TOOL CEILING BINDS ONLY OVER THE TOOLS IT ENUMERATES — SO THE ENUMERATION IS LOAD-BEARING.
//
// `hostBuiltinDenials` computes the deny list as the COMPLEMENT of a seat's grant over
// HOST_BUILTINS, because `--allowedTools` is advisory for host builtins and only `--disallowedTools`
// actually removes one. tool_providers.ts already says why that matters: "a seat granted only
// `type_browse` still called `Bash` and `Read`, unrefused and unrecorded (gig 782e89d8,
// room-prober, twice)".
//
// The consequence nobody wrote down: a host tool ABSENT from HOST_BUILTINS is never in the
// complement, so it is never denied, so it is never governed. The ceiling is not "deny by default";
// it is "deny what we listed".
//
// OBSERVED, NOT HYPOTHESISED. Gig 34ff466b's review chair is `spec-reviewer`, whose genome record
// declares allowed_tools: [] and code_tool_access: "none" — a seat entitled to nothing. Its actual
// calls that run:
//
//     Monitor x13   ToolSearch x10   LSP x6   ScheduleWakeup x2   ListAgents x1
//
// Monitor executes shell (`until <check>; do sleep 2; done`); LSP reads code. With those it read
// the working tree and produced a verdict citing "75 real expect() assertions: claim 11, enqueue
// 23, reclaim 25, lease 16" and "10175 bytes" — every number exactly correct. It did not fabricate;
// it reached capabilities its grant never mentioned, because none of those five were on the list.
//
// This inverts the defect class this codebase usually closes. Elsewhere the failure is GRANTED BUT
// UNPROVIDED — a dead name, which fails closed. Here it is PROVIDED BUT UNGRANTED, which fails
// OPEN, and silently: nothing refuses, and nothing records.
//
// WHAT THIS LAW CAN AND CANNOT DO. It cannot make the ceiling deny-by-default: `--disallowedTools`
// takes an enumeration, and there is no wildcard that would let the engine deny an open universe.
// So the enumeration must be maintained, and this law makes the maintenance VISIBLE — it pins the
// tools observed escaping, so a regression that drops one reds here, and it states the residual
// weakness in writing rather than leaving it implicit. A host tool introduced after this file is
// written is ungoverned until someone adds it. That is a known, stated limit, not a hidden one.
import { describe, it, expect } from "vitest";
import { hostBuiltinDenials, isHostBuiltin } from "../src/tool_providers.js";

/** Tools observed being called by a seat holding allowed_tools: [] (gig 34ff466b, review) that are
 *  capabilities over the world, and must therefore be governed. */
const OBSERVED_ESCAPES = ["Monitor", "LSP", "ListAgents", "ScheduleWakeup"] as const;

/** ToolSearch was observed on that same run and is DELIBERATELY not governed: it loads the tools a
 *  chair was already granted, including output_write. 226 of 289 ToolSearch calls across the gig
 *  logs were loading output_write, so denying it severs the seal path for every model chair. This
 *  law pins the carve-out so it stays a decision rather than becoming an oversight. */
const LOADER_NOT_CAPABILITY = "ToolSearch";

/** The classic builtins the complement has always covered — the regression floor. */
const LONG_STANDING = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "Task"] as const;

describe("the tool ceiling binds over what it names", () => {
  it("the oracle is reachable and non-vacuous — an empty grant denies a non-empty set", () => {
    const denied = hostBuiltinDenials([]);
    expect(denied.length, "a seat granted nothing is denied nothing — the ceiling does not bind").toBeGreaterThan(0);
  });

  it("a seat granted NOTHING is denied every long-standing builtin", () => {
    const denied = new Set(hostBuiltinDenials([]));
    for (const t of LONG_STANDING) {
      expect(denied.has(t), `"${t}" is not denied to a seat entitled to nothing`).toBe(true);
    }
  });

  it("every tool observed escaping a toolless seat is now governed", () => {
    const denied = new Set(hostBuiltinDenials([]));
    const ungoverned = OBSERVED_ESCAPES.filter((t) => !denied.has(t));
    expect(
      ungoverned,
      `these were CALLED by a seat declaring allowed_tools: [] and are still not denied: ` +
        `${ungoverned.join(", ")} — a tool absent from the enumeration is never in the complement, ` +
        `so it is never refused. Monitor executes shell; LSP reads code.`,
    ).toEqual([]);
  });

  it("ToolSearch stays ungoverned ON PURPOSE — it is the loader for granted tools, not a capability", () => {
    const denied = new Set(hostBuiltinDenials([]));
    expect(
      denied.has(LOADER_NOT_CAPABILITY),
      "ToolSearch was added to the ceiling — that severs the seal path, since a chair loads " +
        "output_write through it (226 of 289 observed calls). Govern what it can LOAD instead.",
    ).toBe(false);
  });

  it("isHostBuiltin agrees with the deny complement — one universe, not two", () => {
    for (const t of [...OBSERVED_ESCAPES, ...LONG_STANDING]) {
      expect(isHostBuiltin(t), `"${t}" is denied to an empty grant but isHostBuiltin says otherwise`).toBe(true);
    }
  });

  it("a GRANTED tool is not denied — the ceiling narrows, it does not confiscate", () => {
    const denied = new Set(hostBuiltinDenials(["Read", "Monitor"]));
    expect(denied.has("Read"), "a granted Read was denied").toBe(false);
    expect(denied.has("Monitor"), "a granted Monitor was denied").toBe(false);
    expect(denied.has("Bash"), "an ungranted Bash escaped the complement").toBe(true);
  });

  it("a SCOPED grant protects its base name — Bash(git add:*) keeps Bash", () => {
    const denied = new Set(hostBuiltinDenials(["Bash(git add:*)"]));
    expect(denied.has("Bash"), "a scoped Bash grant lost its base tool to the complement").toBe(false);
  });
});
