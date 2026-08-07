// #234, the behavioural half.
//
// `advertised_args_are_read.test.ts` proves the schema and the handler name the same arguments.
// That is a source-text check, and source text can agree while the code does the wrong thing —
// an argument can be READ and still not WORK. These tests call the tools.
//
// Each one below was advertised and ignored, so every caller who set it got an answer computed
// as though they had not. None of them failed loudly; all of them returned a confident number
// or list that quietly described something other than what was asked for.
import { describe, it, expect } from "vitest";
import { createRegistry, createOutputStore, MemoryLedger, type DomainType } from "../src/index.js";
import { dispatchTool, parseWindow, type ServerDeps } from "../src/server.js";

function deps(): ServerDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

describe("#234 — capability_research answers the question it was asked", () => {
  it("finds an existing capability when called as documented", async () => {
    // The regression in one line: `{need}` is the advertised argument, and the handler read
    // `query`. `gig_dispatch` unmistakably exists, and the documented call said it did not.
    const r = await dispatchTool("capability_research", { need: "gig_dispatch" }, deps());
    expect(r.ok, r.error).toBe(true);
    const d = r.data as { gap: boolean; existing_matches: string[]; recommendation: string };
    expect(d.existing_matches).toContain("gig_dispatch");
    expect(d.gap, "advertising `need` while reading `query` reported a gap for every capability").toBe(false);
    expect(d.recommendation).toMatch(/reuse/i);
  });

  it("still accepts the undocumented aliases it used to read", async () => {
    for (const key of ["query", "capability"]) {
      const r = await dispatchTool("capability_research", { [key]: "gig_dispatch" }, deps());
      expect((r.data as { gap: boolean }).gap, `alias ${key} must keep working`).toBe(false);
    }
  });

  it("REFUSES an empty search instead of reporting a gap", async () => {
    // The damage was not the empty search; it was answering it. "I looked for nothing, found
    // nothing, therefore build something new" is a confident wrong answer, and it is the
    // answer this tool gave every documented caller.
    const r = await dispatchTool("capability_research", { need: "   " }, deps());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/need/);
  });

  it("reports a real gap as a gap", async () => {
    const r = await dispatchTool("capability_research", { need: "zzz-no-such-capability" }, deps());
    expect((r.data as { gap: boolean }).gap).toBe(true);
  });
});

describe("#234 — type_browse actually filters by status", () => {
  // Distinct core + domain + schema per fixture. The registry enforces REUSE — it refuses a
  // type that scores >=80 against an existing one — so three near-identical shapes cannot
  // coexist for the filter to sort between.
  const t = (slug: string, core: string, domain: string, field: string, status?: string): DomainType => ({
    slug, extends: core, domain,
    schema: { properties: { [field]: { type: "string" } } }, required_fields: [],
    ...(status ? { status } : {}),
  } as DomainType);

  function withTypes(): ServerDeps {
    const d = deps();
    d.registry.registerType(t("live-one", "Signal", "alpha", "a", "active"));
    d.registry.registerType(t("old-one", "Interpretation", "beta", "b", "retired"));
    d.registry.registerType(t("undeclared", "Plan", "gamma", "c"));
    return d;
  }

  it("returns only the requested status", async () => {
    const r = await dispatchTool("type_browse", { status: "active" }, withTypes());
    const slugs = (r.data as { types: Array<{ slug: string }> }).types.map((x) => x.slug);
    expect(slugs).toContain("live-one");
    expect(
      slugs,
      "#203 gave types a lifecycle and this tool offered to filter on it while returning " +
        "retired definitions anyway — an operator browsing for what they may build on got them",
    ).not.toContain("old-one");
  });

  it("treats an undeclared status as active, rather than hiding the type from every filter", async () => {
    const slugs = ((await dispatchTool("type_browse", { status: "active" }, withTypes()))
      .data as { types: Array<{ slug: string }> }).types.map((x) => x.slug);
    expect(slugs).toContain("undeclared");
  });

  it("finds the retired ones when that is what was asked for", async () => {
    const slugs = ((await dispatchTool("type_browse", { status: "retired" }, withTypes()))
      .data as { types: Array<{ slug: string }> }).types.map((x) => x.slug);
    expect(slugs).toEqual(["old-one"]);
  });

  it("omitting status returns everything (unchanged behaviour)", async () => {
    const r = await dispatchTool("type_browse", {}, withTypes());
    expect((r.data as { types: unknown[] }).types).toHaveLength(3);
  });
});

describe("#234 — the health surfaces honour `window`", () => {
  it("parses the shapes it documents", () => {
    const now = Date.UTC(2026, 0, 31);
    expect(parseWindow("24h", now).after).toBe(new Date(now - 86_400_000).toISOString());
    expect(parseWindow("7d", now).after).toBe(new Date(now - 7 * 86_400_000).toISOString());
    expect(parseWindow("2w", now).after).toBe(new Date(now - 14 * 86_400_000).toISOString());
  });

  it("absent window means all time — the prior behaviour, now explicit", () => {
    expect(parseWindow(undefined, Date.now())).toEqual({});
    expect(parseWindow("", Date.now())).toEqual({});
  });

  it("an unparseable window is an ERROR, not a silent fallback to all time", async () => {
    // Falling back quietly is how the argument came to be ignored: the caller asked for a week,
    // got a year, and the response looked identical either way.
    expect(parseWindow("last tuesday", Date.now()).error).toBeTruthy();
    expect(parseWindow("0d", Date.now()).error).toBeTruthy();
    const r = await dispatchTool("system_health", { window: "last tuesday" }, deps());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/window/i);
  });

  it("system_health counts only gigs inside the window", async () => {
    const d = deps();
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    for (const [ts, id] of [[old, "g-old"], [recent, "g-new"]] as const) {
      // `after` compares against started_at (src/ledger.ts) — the field a window must key on.
      d.ledger.append({
        schema_version: 2, entry_id: id, kind: "gig", gig_id: id, standard_slug: "s",
        genome_hash: "a".repeat(64), run_fingerprint: "b".repeat(64), output_hashes: [],
        started_at: ts, finished_at: ts, usage: { total_cost_usd: 5 },
      } as never);
    }
    const all = (await dispatchTool("system_health", {}, d)).data as { gigs_run: number; cost: number };
    expect(all.gigs_run, "no window is still all time").toBe(2);
    expect(all.cost).toBe(10);

    const week = (await dispatchTool("system_health", { window: "7d" }, d)).data as { gigs_run: number; cost: number };
    expect(week.gigs_run, "a 7d window must exclude the 30-day-old gig").toBe(1);
    // The cost has to move with the count. A window that filtered the rows but not the money
    // would report a week's runs at a month's spend — worse than ignoring the argument.
    expect(week.cost).toBe(5);
  });
});

describe("#234 — the two tools that minted receipts for work they never did", () => {
  // Both handlers were `const proposal_id = randomUUID(); return { ok: true, ... }` — every
  // argument discarded, nothing written anywhere. The receipt is what made that invisible: a
  // caller handed a `proposal_id` has been told their proposal exists and can be looked up.
  //
  // Their own tests lived in a describe block named "proposal tools (LEDGER-BACKED)", where the
  // proposal_create case asserts `ledger.query().length === 1` and these two asserted only
  // `typeof proposal_id === "string"` — which randomUUID() satisfies forever. That is why the
  // stub survived: the assertions were satisfied by the fabrication itself.
  it("tool_propose RECORDS the proposal it acknowledges", async () => {
    const d = deps();
    const r = await dispatchTool("tool_propose", { slug: "new_tool", type: "mcp", spec: { x: 1 }, reason: "need it" }, d);
    expect(r.ok, r.error).toBe(true);
    const id = (r.data as { proposal_id: string }).proposal_id;
    expect(typeof id).toBe("string");

    const rows = d.ledger.query({ kind: "governance", event: "tool_propose" });
    expect(rows.length, "the receipt must correspond to something written down").toBe(1);
    const detail = (rows[0] as unknown as { detail: Record<string, unknown>; subject_slug: string });
    expect(detail.subject_slug).toBe("new_tool");
    expect(detail.detail["proposal_id"], "and the id handed back must be the id recorded").toBe(id);
    // The spec and reason are the substance of a proposal. Recording the id alone would keep
    // the receipt honest and still lose what was proposed.
    expect(detail.detail["spec"]).toEqual({ x: 1 });
    expect(detail.detail["reason"]).toBe("need it");
  });

  it("tool_deprecate_propose records too — removing a tool is a governance act", async () => {
    const d = deps();
    const r = await dispatchTool("tool_deprecate_propose", { slug: "old_tool", reason: "unused", usage_stats: { calls: 0 } }, d);
    expect(r.ok, r.error).toBe(true);
    const rows = d.ledger.query({ kind: "governance", event: "tool_deprecate_propose" });
    expect(rows.length, "a proposal to REMOVE a tool that leaves no trace is the worse half").toBe(1);
    const detail = (rows[0] as unknown as { detail: Record<string, unknown> }).detail;
    expect(detail["reason"]).toBe("unused");
    expect(detail["usage_stats"]).toEqual({ calls: 0 });
    expect((r.data as { affected_agents: unknown[] }).affected_agents).toEqual([]);
  });

  it("both still require approval — recording is not granting", async () => {
    for (const slug of ["tool_propose", "tool_deprecate_propose"]) {
      const r = await dispatchTool(slug, { slug: "t" }, deps());
      expect(r.requires_approval, `${slug} must still gate on sign-off`).toBe(true);
    }
  });

  it("a proposal with no subject is REFUSED, not recorded against nothing", async () => {
    const d = deps();
    const r = await dispatchTool("tool_propose", {}, d);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/slug/);
    expect(d.ledger.query({ kind: "governance" }).length, "a refused call writes nothing").toBe(0);
  });
});

// ── the rest of the ignored arguments, now implemented ──────────────────────
// Each was advertised, discarded, and answered as though it had not been passed. They are
// grouped here because the failure is one failure: a filter that does nothing returns a
// confident superset, and the caller cannot tell a narrowed answer from an unnarrowed one.

describe("#234 — output_query filters by payload", () => {
  async function seeded(): Promise<ServerDeps> {
    const d = deps();
    d.registry.registerType({
      slug: "finding", extends: "Judgment", domain: "demo",
      schema: { properties: { title: { type: "string" }, severity: { type: "string" } } },
      required_fields: [],
    } as never);
    for (const [title, severity] of [["a", "high"], ["b", "low"], ["c", "high"]]) {
      await dispatchTool("output_write", {
        core_type: "Judgment", domain_type: "finding", domain: "demo", gig_id: "g1", agent_slug: "x",
        data: { title, severity, criteria: ["c"] },
      }, d);
    }
    return d;
  }

  it("narrows to matching rows, and total_count describes the narrowed set", async () => {
    const d = await seeded();
    const r = await dispatchTool("output_query", { data_filter: { severity: "high" } }, d);
    const got = r.data as { outputs: Array<{ data: { title: string } }>; total_count: number };
    expect(got.outputs.map((o) => o.data.title).sort()).toEqual(["a", "c"]);
    // A count that still described the whole set would be the same lie one layer down.
    expect(got.total_count).toBe(2);
  });

  it("ANDs multiple keys", async () => {
    const d = await seeded();
    const r = await dispatchTool("output_query", { data_filter: { severity: "high", title: "a" } }, d);
    expect((r.data as { total_count: number }).total_count).toBe(1);
  });

  it("an unmatched filter returns nothing, not everything", async () => {
    // The pre-fix behaviour: the filter was dropped, so this returned all three.
    const d = await seeded();
    const r = await dispatchTool("output_query", { data_filter: { severity: "nope" } }, d);
    expect((r.data as { total_count: number }).total_count).toBe(0);
  });

  it("omitting the filter is unchanged", async () => {
    const d = await seeded();
    const r = await dispatchTool("output_query", {}, d);
    expect((r.data as { total_count: number }).total_count).toBe(3);
  });
});

describe("#234 — output_trace walks the direction it was asked for", () => {
  async function chain(): Promise<{ d: ServerDeps; ids: string[] }> {
    const d = deps();
    d.registry.registerType({
      slug: "step", extends: "Signal", domain: "demo",
      schema: { properties: { n: { type: "number" } } }, required_fields: [],
    } as never);
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) {
      const r = await dispatchTool("output_write", {
        core_type: "Signal", domain_type: "step", domain: "demo", gig_id: "g1", agent_slug: "x",
        data: { n, source: "fixture://demo" },
        input_refs: ids.length ? [ids[ids.length - 1]] : [],
      }, d);
      ids.push((r.data as { output_id: string }).output_id);
    }
    return { d, ids };
  }

  it("upstream (the default) reaches the ancestors", async () => {
    const { d, ids } = await chain();
    const r = await dispatchTool("output_trace", { output_id: ids[2] }, d);
    const nodes = (r.data as { graph: { nodes: Array<{ id: string }> } }).graph.nodes.map((n) => n.id);
    expect(nodes).toContain(ids[0]);
  });

  it("downstream reaches the DESCENDANTS — the question that used to be answered backwards", async () => {
    const { d, ids } = await chain();
    const r = await dispatchTool("output_trace", { output_id: ids[0], direction: "downstream" }, d);
    const nodes = (r.data as { graph: { nodes: Array<{ id: string }> } }).graph.nodes.map((n) => n.id);
    expect(
      nodes,
      "'what was derived from this?' returned this output's ancestors instead, and said nothing",
    ).toEqual(expect.arrayContaining([ids[1], ids[2]]));
    expect(nodes, "and must not include the ancestors").not.toContain(ids[0]);
  });

  it("both covers each end without repeating a node", async () => {
    const { d, ids } = await chain();
    const r = await dispatchTool("output_trace", { output_id: ids[1], direction: "both" }, d);
    const nodes = (r.data as { graph: { nodes: Array<{ id: string }> } }).graph.nodes.map((n) => n.id);
    expect(nodes).toEqual(expect.arrayContaining([ids[0], ids[2]]));
    expect(new Set(nodes).size, "a node reachable both ways must appear once").toBe(nodes.length);
  });

  it("an unrecognized direction is an error, not a silent upstream walk", async () => {
    const { d, ids } = await chain();
    const r = await dispatchTool("output_trace", { output_id: ids[0], direction: "sideways" }, d);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/direction/i);
  });
});

describe("#234 — system_audit honours scope and check", () => {
  function twoDomains(): ServerDeps {
    const d = deps();
    d.registry.registerType({
      slug: "alpha-type", extends: "Signal", domain: "alpha",
      schema: { properties: { a: { type: "string" } } }, required_fields: [],
    } as never);
    d.registry.registerType({
      slug: "beta-type", extends: "Plan", domain: "beta",
      schema: { properties: { b: { type: "string" } } }, required_fields: [],
    } as never);
    return d;
  }

  it("scope narrows the findings to one domain", async () => {
    const r = await dispatchTool("system_audit", { scope: "alpha" }, twoDomains());
    const got = r.data as { unused_types: string[]; type_count: number };
    expect(got.unused_types).toEqual(["alpha-type"]);
    // The count has to describe the same slice as the findings, or the response argues with
    // itself: two types reported over one domain's findings.
    expect(got.type_count).toBe(1);
  });

  it("no scope is still the whole system", async () => {
    const r = await dispatchTool("system_audit", {}, twoDomains());
    expect((r.data as { unused_types: string[] }).unused_types.sort()).toEqual(["alpha-type", "beta-type"]);
  });

  it("an unknown check is refused rather than silently running every check", async () => {
    const r = await dispatchTool("system_audit", { check: "not_a_check" }, twoDomains());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/check/i);
  });

  it("a known check runs", async () => {
    const r = await dispatchTool("system_audit", { check: "unused_type" }, twoDomains());
    expect(r.ok, r.error).toBe(true);
    expect((r.data as { findings: unknown[] }).findings.length).toBe(2);
  });
});

describe("#234 — session_review_write keeps the reviewer's reasoning", () => {
  it("records notes, agent_version and domain instead of discarding them", async () => {
    const d = deps();
    await dispatchTool("session_review_write", {
      gig_id: "g1", output_id: "o1", agent_slug: "drafter", quality_scores: { clarity: 4 },
      agent_version: 3, domain: "grants", notes: "cited the wrong RFP section",
    }, d);
    const row = d.ledger.query({ kind: "governance", event: "session_review_write" })[0] as unknown as
      { detail: Record<string, unknown> };
    expect(row.detail["quality_scores"]).toEqual({ clarity: 4 });
    expect(
      row.detail["notes"],
      "keeping the score and dropping the why leaves a later evolution decision with half the input",
    ).toBe("cited the wrong RFP section");
    expect(row.detail["agent_version"]).toBe(3);
    expect(row.detail["domain"]).toBe("grants");
  });

  it("absent fields record as null, so 'no note' differs from 'field not kept yet'", async () => {
    const d = deps();
    await dispatchTool("session_review_write", {
      gig_id: "g1", output_id: "o1", agent_slug: "drafter", quality_scores: { clarity: 4 },
    }, d);
    const row = d.ledger.query({ kind: "governance", event: "session_review_write" })[0] as unknown as
      { detail: Record<string, unknown> };
    expect(row.detail).toHaveProperty("notes", null);
  });
});

describe("#234 — learning_synthesize honours `since`", () => {
  it("counts only reviews inside the window", async () => {
    const d = deps();
    for (let i = 0; i < 3; i++) {
      await dispatchTool("session_review_write", {
        gig_id: `g${i}`, output_id: `o${i}`, agent_slug: "drafter", quality_scores: { clarity: 4 },
      }, d);
    }
    const all = await dispatchTool("learning_synthesize", { agent_slug: "drafter", min_reviews: 3 }, d);
    expect((all.data as { review_count: number }).review_count).toBe(3);
    expect((all.data as { evidence_sufficient: boolean }).evidence_sufficient).toBe(true);

    // A cutoff in the future excludes everything written before now.
    const future = new Date(Date.now() + 60_000).toISOString();
    const none = await dispatchTool("learning_synthesize", { agent_slug: "drafter", min_reviews: 3, since: future }, d);
    expect(
      (none.data as { review_count: number }).review_count,
      "'has this agent earned an evolution on RECENT evidence?' was always answered over all history",
    ).toBe(0);
    expect((none.data as { evidence_sufficient: boolean }).evidence_sufficient).toBe(false);
  });

  it("an unparseable `since` is an error, not an all-history fallback", async () => {
    const r = await dispatchTool("learning_synthesize", { agent_slug: "drafter", since: "whenever" }, deps());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/since/i);
  });
});

describe("#234 — the authoring tools record WHY, not just what", () => {
  it("tool_register records the spec it was granted from", async () => {
    const d = deps();
    await dispatchTool("tool_register", { slug: "new_tool", type: "mcp", spec: { url: "x" }, category: "run" }, d);
    const row = d.ledger.query({ kind: "governance", event: "tool_register" })[0] as unknown as
      { detail: Record<string, unknown> };
    expect(
      row.detail["spec"],
      "this row is the audit answer to 'who granted this capability and what did they grant'",
    ).toEqual({ url: "x" });
    expect(row.detail["category"]).toBe("run");
  });
});
