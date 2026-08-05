// e2e: outputs persist across MCP sessions (PR #78 follow-up — Rob cold-trial gate).
//
// Pre-reg: BEFORE PR #78, outputs.all() was an in-memory Map. When an MCP
// session ended (process exit), every written output vanished. The user could
// not retrieve gig outputs after closing claude code — the audit chain did not
// survive across sessions.
//
// This test proves the RED→GREEN flip. It simulates two sequential sessions
// against the SAME on-disk persistDir:
//
//   session A:  fresh OutputStore → write 3 outputs (2 gigs) + 1 provenance edge → process ends
//   session B:  fresh OutputStore (different in-memory Map) pointed at the SAME persistDir
//               → all() must return the 3 outputs, get(id) must hydrate by id,
//                 refs() must return the edge, trace(child) must walk to the parent,
//                 findings() must project the eirtests finding
//
// Counter-claim: session B sees an empty store (the original bug). If this test
// goes green and the persist file shows on disk, the audit chain is durable.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, createOutputStore, type DomainType } from "../../src/index.js";

const pageModel: DomainType = {
  slug: "page-model",
  extends: "Signal",
  domain: "eirtests",
  schema: { properties: { url: { type: "string" } } },
  required_fields: ["url"],
};

const finding: DomainType = {
  slug: "finding",
  extends: "Verdict",
  domain: "eirtests",
  schema: { properties: { title: { type: "string" } } },
  required_fields: ["title"],
};

// Every sealed output carries its CORE's substance floor, enforced by outputs.write on every
// write, subtype or not (#227 ruling): a Signal names where it was acquired, a Verdict carries
// the evidence it verified. These fixtures were never valid instances of their own core — the
// seal path simply did not look until #227/#228 wired the check in.
const SOURCE = { source: "https://eirtests.example" };
const CHECKS = { checks: [{ method: "cold-trial-scan", target_ref: "page-model", result: "fail" }] };

function freshRegistry() {
  const r = createRegistry();
  r.registerType(pageModel);
  r.registerType(finding);
  return r;
}

describe("e2e: outputs persist across MCP sessions (PR #78 follow-up)", () => {
  let persistDir: string;

  beforeEach(() => {
    persistDir = mkdtempSync(join(tmpdir(), "coltrane-outputs-persist-"));
  });

  afterEach(() => {
    rmSync(persistDir, { recursive: true, force: true });
  });

  it("session B sees outputs that session A wrote, after session A's store is gone", () => {
    // ---------- session A: write + edge, then drop the in-memory store ----------
    let parentId = "";
    let childId = "";
    {
      const registry = freshRegistry();
      const sessionA = createOutputStore(registry, { persistDir });

      const parent = sessionA.write({
        core_type: "Signal",
        domain_type: "page-model",
        domain: "eirtests",
        gig_id: "gig-rob-cold-trial",
        agent_slug: "scout",
        primitive: "SENSE",
        data: { url: "/landing", ...SOURCE },
      });
      parentId = parent.id;

      const child = sessionA.write({
        core_type: "Verdict",
        domain_type: "finding",
        domain: "eirtests",
        gig_id: "gig-rob-cold-trial",
        agent_slug: "verifier",
        primitive: "VERIFY",
        data: { title: "landing-broke", ...CHECKS },
        input_refs: [parent.id],
      });
      childId = child.id;

      sessionA.addRef(child.id, parent.id, "derived_from", "VERIFY");

      // Also write to a SECOND gig — proves multi-gig fan-out persists.
      sessionA.write({
        core_type: "Signal",
        domain_type: "page-model",
        domain: "eirtests",
        gig_id: "gig-second",
        agent_slug: "scout",
        primitive: "SENSE",
        data: { url: "/about", ...SOURCE },
      });

      // Sanity: session A sees its own writes.
      expect(sessionA.all().length).toBe(3);
      expect(sessionA.refs().length).toBe(1);
      // sessionA goes out of scope here — its in-memory Map is GC'd, the process
      // (conceptually) ends. The jsonl files on disk are the only survivors.
    }

    // ---------- verify on-disk shape: <persistDir>/outputs/<gig_id>.jsonl ----------
    const gigFile = join(persistDir, "outputs", "gig-rob-cold-trial.jsonl");
    expect(existsSync(gigFile)).toBe(true);
    const lines = readFileSync(gigFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    // Each line is a full OutputRecord (json), parseable.
    for (const line of lines) {
      const rec = JSON.parse(line);
      expect(rec.gig_id).toBe("gig-rob-cold-trial");
      expect(rec.id).toBeTruthy();
    }
    expect(existsSync(join(persistDir, "outputs", "gig-second.jsonl"))).toBe(true);
    expect(existsSync(join(persistDir, "refs", "gig-rob-cold-trial.jsonl"))).toBe(true);

    // ---------- session B: brand-new store, same persistDir, no shared memory ----------
    const sessionB = createOutputStore(freshRegistry(), { persistDir });

    // all() must hydrate from disk and return all 3.
    const all = sessionB.all();
    expect(all.length).toBe(3);
    const ids = new Set(all.map((o) => o.id));
    expect(ids.has(parentId)).toBe(true);
    expect(ids.has(childId)).toBe(true);

    // get(id) must hydrate by id (the key MCP path: output_query → get).
    const reread = sessionB.get(parentId);
    expect(reread).toBeDefined();
    expect(reread?.data["url"]).toBe("/landing");

    // refs() must hydrate the provenance edge.
    const refs = sessionB.refs();
    expect(refs.length).toBe(1);
    expect(refs[0]?.from_output_id).toBe(childId);
    expect(refs[0]?.to_output_id).toBe(parentId);
    expect(refs[0]?.relation).toBe("derived_from");

    // trace(child) must walk through input_refs + derived_from edge back to parent.
    const ancestors = sessionB.trace(childId).map((o) => o.id);
    expect(ancestors).toContain(parentId);

    // findings() projection must surface the eirtests finding.
    const findings = sessionB.findings();
    expect(findings.length).toBe(1);
    expect(findings[0]?.title).toBe("landing-broke");
    expect(findings[0]?.agent_role).toBe("verifier");
  });

  it("session B can append to a gig that session A started — chain accumulates", () => {
    // ---------- session A writes 1 ----------
    {
      const sessionA = createOutputStore(freshRegistry(), { persistDir });
      sessionA.write({
        core_type: "Signal",
        domain_type: "page-model",
        domain: "eirtests",
        gig_id: "gig-accumulate",
        agent_slug: "scout",
        primitive: "SENSE",
        data: { url: "/a", ...SOURCE },
      });
    }

    // ---------- session B appends 1 more to the SAME gig ----------
    {
      const sessionB = createOutputStore(freshRegistry(), { persistDir });
      // Hydrate first.
      expect(sessionB.all().length).toBe(1);
      sessionB.write({
        core_type: "Signal",
        domain_type: "page-model",
        domain: "eirtests",
        gig_id: "gig-accumulate",
        agent_slug: "scout",
        primitive: "SENSE",
        data: { url: "/b", ...SOURCE },
      });
      expect(sessionB.all().length).toBe(2);
    }

    // ---------- session C sees both ----------
    const sessionC = createOutputStore(freshRegistry(), { persistDir });
    const all = sessionC.all();
    expect(all.length).toBe(2);
    const urls = all.map((o) => o.data["url"]).sort();
    expect(urls).toEqual(["/a", "/b"]);
  });

  it("no persistDir == in-memory only (backward compat with existing callers)", () => {
    const s1 = createOutputStore(freshRegistry());
    s1.write({
      core_type: "Signal",
      domain_type: "page-model",
      domain: "eirtests",
      gig_id: "gig-x",
      agent_slug: "scout",
      primitive: "SENSE",
      data: { url: "/", ...SOURCE },
    });
    const s2 = createOutputStore(freshRegistry());
    // Two unrelated in-memory stores; s2 sees nothing.
    expect(s1.all().length).toBe(1);
    expect(s2.all().length).toBe(0);
  });
});
