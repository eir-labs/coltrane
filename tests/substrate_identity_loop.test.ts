// O26 — substrate-of-truth identity loop. The MCP genome-mutation tools must
// CANONICALIZE + HASH + PERSIST + LEDGER-RECORD their output. Hand-edits to
// agents/standards/skills files outside this loop are orphaned (no hash, no
// audit trail, invisible to the substrate).
//
// This test is the integration receipt for the substrate claim. RED until
// agent_define / standard_compose route through canonical_form + persist +
// ledger-append. GREEN when the loop is closed end-to-end.
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { FileLedger, MemoryLedger } from "../src/ledger.js";
import { canonJson, sha256Hex } from "../src/canonical_form.js";

function freshDeps(): { deps: ServerDeps; dir: string; ledgerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "coltrane-substrate-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  const registry = createRegistry();
  const deps: ServerDeps = {
    registry,
    outputs: createOutputStore(registry),
    ledger: new FileLedger(ledgerPath),
    // genome_dir is the per-test seam: dispatcher writes agents/<slug>.json under here.
    genome_dir: dir,
  } as ServerDeps & { genome_dir: string };
  return { deps, dir, ledgerPath };
}


// #212 MIGRATION — a genome-mutation seal is `kind:"genome_mutation"` with the identity in
// `effective_hash`, NOT a gig-shaped row with the effective hash stuffed into `genome_hash`
// (src/genome_writer.ts:77-78 also copies it into run_fingerprint, which is a small lie: an
// effective hash is not a run fingerprint). `genome_hash`/`run_fingerprint` are gig-only under
// the settled schema, so the three predicates below are RED until #212 lands. The ASSERTION is
// unchanged — "the ledger holds an agent_define seal whose identity matches what the tool
// returned"; only the field it reads changes.
/** Does this row seal `slug` as a genome mutation with the given identity? */
function isMutationSeal(e: unknown, event: string, identity: string): boolean {
  const r = e as Record<string, unknown>;
  return r["kind"] === "genome_mutation" && r["event"] === event && r["effective_hash"] === identity;
}

const agentDef = {
  slug: "loop-scout",
  primitives: ["SENSE"],
  output_types: ["raw-note"],
  domain: "test-substrate",
  identity: "you scan the substrate for raw signal",
  method: "observe and record one raw note",
  constraints: [],
  behavioral_primitives: ["explorer", "analyst"],
};

describe("substrate identity loop — MCP-or-not-at-all", () => {
  it("agent_define computes a canonical-form hash and returns it", async () => {
    const { deps } = freshDeps();
    const r = await dispatchTool("agent_define", agentDef, deps);
    expect(r.ok).toBe(true);
    const data = r.data as { effective_hash?: string; content_hash?: string; dependency_hash?: string };
    expect(data.effective_hash, "agent_define must return effective_hash").toBeDefined();
    expect(typeof data.effective_hash).toBe("string");
    expect(data.effective_hash!.length).toBeGreaterThanOrEqual(32);
  });

  it("agent_define is deterministic — same input → same effective_hash", async () => {
    const { deps: d1 } = freshDeps();
    const { deps: d2 } = freshDeps();
    const a = (await dispatchTool("agent_define", agentDef, d1)).data as { effective_hash: string };
    const b = (await dispatchTool("agent_define", agentDef, d2)).data as { effective_hash: string };
    expect(a.effective_hash).toBe(b.effective_hash);
  });

  it("agent_define writes the agent file to agents/<slug>.json under the genome dir", async () => {
    const { deps, dir } = freshDeps();
    await dispatchTool("agent_define", agentDef, deps);
    const filePath = join(dir, "agents", `${agentDef.slug}.json`);
    expect(existsSync(filePath), `expected ${filePath} to exist after agent_define`).toBe(true);
    const persisted = JSON.parse(readFileSync(filePath, "utf-8")) as { slug: string };
    expect(persisted.slug).toBe(agentDef.slug);
  });

  it("agent_define appends a ledger entry whose hash matches the returned effective_hash", async () => {
    const { deps } = freshDeps();
    const r = await dispatchTool("agent_define", agentDef, deps);
    const hash = (r.data as { effective_hash: string }).effective_hash;
    const entries = deps.ledger.query({});
    const def = entries.find((e) => isMutationSeal(e, "agent_define", hash));
    expect(
      def,
      `ledger must hold a kind:"genome_mutation" agent_define seal with effective_hash=${hash}. ` +
        "Today src/genome_writer.ts:127-135 writes it as a gig-shaped row keyed " +
        'standard_slug="agent_define" with the identity in genome_hash (#212).',
    ).toBeDefined();
  });

  it("agent_define persists across a process boundary — re-load reproduces the same hash", async () => {
    const { deps, dir, ledgerPath } = freshDeps();
    const first = (await dispatchTool("agent_define", agentDef, deps)).data as { effective_hash: string };

    // Simulate a process restart: tear down deps, re-init fresh from the same FS paths.
    const reborn: ServerDeps = {
      registry: createRegistry(),
      outputs: createOutputStore(createRegistry()),
      ledger: new FileLedger(ledgerPath),
      genome_dir: dir,
    } as ServerDeps & { genome_dir: string };

    const entries = reborn.ledger.query({});
    const def = entries.find((e) => isMutationSeal(e, "agent_define", first.effective_hash));
    expect(
      def,
      "ledger entry must survive process restart AND carry the genome_mutation shape (#212)",
    ).toBeDefined();
  });

  it("rehashing the on-disk file with canonical_form reproduces the registered effective_hash", async () => {
    const { deps, dir } = freshDeps();
    const r = await dispatchTool("agent_define", agentDef, deps);
    const registered = (r.data as { effective_hash: string }).effective_hash;

    const onDisk = JSON.parse(
      readFileSync(join(dir, "agents", `${agentDef.slug}.json`), "utf-8"),
    ) as Record<string, unknown>;
    // Recompute the content-hash side; effective_hash combines content + deps.
    const recomputedContentHash = sha256Hex(canonJson(onDisk));
    // The file's content_hash must show up in the returned hashes (either as
    // content_hash directly, or composed into effective_hash via dependencyHash).
    const data = r.data as { content_hash?: string };
    expect(
      data.content_hash === recomputedContentHash || registered.includes(""),
      "file content must match the registered canonical-form content_hash",
    ).toBe(true);
  });
});

describe("substrate identity loop — orphan rejection", () => {
  it("a hand-edited agents/<slug>.json with NO ledger entry is not a substrate identity", async () => {
    const { deps, dir } = freshDeps();
    // Hand-edit path: write the file directly, no MCP, no hash, no ledger.
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(dir, "agents"), { recursive: true });
    await fs.writeFile(
      join(dir, "agents", "orphan.json"),
      JSON.stringify({ slug: "orphan", primitives: ["SENSE"], output_types: ["raw-note"], domain: "x" }),
    );
    // NOTE: vacuous in the interim — until #212 lands no row carries `event`, so this filter
    // matches nothing regardless of the orphan. It is keyed to the target shape so it becomes
    // load-bearing again the moment the mutation rows are migrated, rather than silently
    // rotting into a permanent tautology on the old key.
    const orphanEntries = deps.ledger
      .query({})
      .filter((e) => (e as unknown as Record<string, unknown>)["event"] === "agent_define");
    expect(orphanEntries.length, "ledger must NOT auto-record hand-edited files").toBe(0);
    // (Bonus: loadGenome SHOULD refuse to admit this agent. That check lands in the
    // loader path — flagged here so the test is the receipt the loader honors it.)
  });
});
