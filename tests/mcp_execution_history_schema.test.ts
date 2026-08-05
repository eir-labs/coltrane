// RED — issue #217: execution_history_read's advertised schema matches its handler in
// neither direction.
//
// The ledger's ONLY read API advertises `company_id`/`domain` in and `gigs`/
// `performance_summary` out (src/mcp.ts:40). The handler reads `gig_id`/`standard_slug`/
// `genome_hash`/`after`/`before` and returns `executions`/`count` (src/server.ts:355-363).
// Zero overlap either way.
//
// An MCP client following the advertised contract passes company_id/domain — both silently
// ignored, producing an UNFILTERED DUMP of the entire ledger — then looks for data.gigs and
// finds data.executions. The five filters that actually work are undiscoverable.
//
// Scope note: charter_read (src/mcp.ts:39) has the same disease, so this is likely systemic.
// Issue #217 is deliberately scoped to the ledger's read API because a mis-advertised AUDIT
// tool is a different order of problem from a mis-advertised convenience tool. A surface-wide
// drift sweep is a separate piece of work.

import { describe, it, expect } from "vitest";
import { MCP_TOOLS } from "../src/mcp.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger, type LedgerEntry } from "../src/ledger.js";

/** The filters src/server.ts:359 actually iterates. */
const HANDLER_FILTERS = ["gig_id", "standard_slug", "genome_hash", "after", "before"] as const;
/** The keys src/server.ts:363 actually returns under `data`. */
const HANDLER_OUTPUTS = ["executions", "count"] as const;

/** Per-key values that genuinely match nothing. The time filters are lexicographic string
 *  comparisons over ISO-8601, so their non-matching sentinel must be a TIMESTAMP on the
 *  correct side of the seeded rows — not an arbitrary string. */
const NO_MATCH: Record<string, string> = {
  after: "2099-01-01T00:00:00.000Z",  // nothing started after this
  before: "1999-01-01T00:00:00.000Z", // nothing started before this
};

function schemaProps(which: "input_schema" | "output_schema"): string[] {
  const tool = MCP_TOOLS.find((t) => t.slug === "execution_history_read");
  expect(tool, "execution_history_read missing from MCP_TOOLS").toBeDefined();
  const schema = (tool as unknown as Record<string, { properties?: Record<string, unknown> }>)[which];
  return Object.keys(schema?.properties ?? {});
}

function makeDeps(): ServerDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

function seed(deps: ServerDeps, gig_id: string, standard_slug: string): void {
  deps.ledger.append({
    kind: "gig", schema_version: 2, entry_id: gig_id, gig_id, standard_slug,
    genome_hash: "a".repeat(64), run_fingerprint: "b".repeat(64), output_hashes: [],
    started_at: "2026-05-25T20:00:00.000Z", finished_at: "2026-05-25T20:01:00.000Z",
  } as unknown as LedgerEntry);
}

describe("#217 — execution_history_read input_schema matches its handler", () => {
  it.each(HANDLER_FILTERS)("advertises the %s filter", (filter) => {
    expect(
      schemaProps("input_schema"),
      `the handler reads "${filter}" (src/server.ts:359) but src/mcp.ts:40 advertises ` +
        `{company_id, domain}. The five filters that actually work are undiscoverable to ` +
        `any client reading the surface.`,
    ).toContain(filter);
  });

  it("does not advertise inputs the handler ignores", () => {
    const props = schemaProps("input_schema");
    for (const ghost of ["company_id", "domain"]) {
      expect(
        props,
        `src/mcp.ts:40 advertises "${ghost}", which src/server.ts:358-361 never reads. A client ` +
          "following the contract gets an UNFILTERED DUMP of the entire ledger and no error.",
      ).not.toContain(ghost);
    }
  });
});

describe("#217 — execution_history_read output_schema matches its handler", () => {
  it.each(HANDLER_OUTPUTS)("advertises the %s output key", (key) => {
    expect(
      schemaProps("output_schema"),
      `the handler returns data.${key} (src/server.ts:363) but src/mcp.ts:40 advertises ` +
        "{gigs, performance_summary}",
    ).toContain(key);
  });

  it("does not advertise outputs the handler never returns", () => {
    const props = schemaProps("output_schema");
    for (const ghost of ["gigs", "performance_summary"]) {
      expect(
        props,
        `src/mcp.ts:40 advertises data.${ghost}; the handler returns executions/count. A client ` +
          "reads the advertised key and finds undefined.",
      ).not.toContain(ghost);
    }
  });

  it("every advertised output key is actually present on a real response", async () => {
    const deps = makeDeps();
    seed(deps, "g1", "readiness-scan");

    const res = await dispatchTool("execution_history_read", {}, deps);
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    for (const key of schemaProps("output_schema")) {
      expect(
        Object.prototype.hasOwnProperty.call(data, key),
        `output_schema advertises "${key}" but the response has keys [${Object.keys(data).join(", ")}]. ` +
          "This is the behavioral half of the drift: the contract is not merely stale, it is unmet.",
      ).toBe(true);
    }
  });

  it("every advertised input key actually filters", async () => {
    const deps = makeDeps();
    seed(deps, "g1", "readiness-scan");
    seed(deps, "g2", "audit-pass");

    for (const key of schemaProps("input_schema")) {
      // Feed a value that matches nothing. An advertised filter that genuinely filters must
      // narrow the result; one that is silently ignored dumps the whole ledger.
      //
      // The sentinel MUST be per-key. after/before are LEXICOGRAPHIC string comparisons
      // (src/ledger.ts:83-84), so a generic "__no_such_value__" is not a non-matching value
      // for them: '_' is 0x5F and '2' is 0x32, so `"2026-…Z" > "__no_such_value__"` is FALSE
      // and the `before` filter correctly keeps every row. A shared sentinel would make this
      // assertion permanently red against a CORRECT handler and blame it for discarding an
      // argument that works. (`after` would pass only by the accident of the same ordering.)
      const probe = NO_MATCH[key] ?? "__no_such_value__";
      const res = await dispatchTool("execution_history_read", { [key]: probe }, deps);
      expect(res.ok).toBe(true);
      const count = (res.data as { count?: number; executions?: unknown[] }).count
        ?? (res.data as { executions?: unknown[] }).executions?.length;
      expect(
        count,
        `input_schema advertises "${key}", but passing it the non-matching value ` +
          `"${probe}" returned ${count} of 2 rows — the argument is silently discarded and ` +
          "the caller gets an unfiltered dump of the audit trail while believing it was scoped.",
      ).toBe(0);
    }
  });
});
