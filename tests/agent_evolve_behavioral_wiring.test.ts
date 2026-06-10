// RED-first contract tests — reconnect the evolve path to runtime behavior (full map).
//
// agent_evolve can change an agent's identity/method/constraints (governance machinery
// is intact), but the runtime never reads them back: the creative (base,next) branch
// seals a ledger claim and writes no genome file, and the (slug,changes) branch writes
// the JSON but loadGenome -> defineAgent drops the behavioral fields on load. So evolving
// behavior returns success yet changes nothing the runtime renders. This pins the full
// chain: evolve identity/method -> the agent the runtime LOADS reflects the change.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { loadGenome } from "../src/loader.js";

const I1 = "You are fact-checker v1, a cautious checker.";
const I2 = "You are fact-checker v2, a relentless checker who cites every source.";
const M2 = "Search for primary sources; cite the source URL for every claim.";

function deps(dir: string): ServerDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), skills: new Map(), genome_dir: dir };
}

describe("evolving an agent's behavior changes what the runtime loads", () => {
  it("agent_evolve of identity/method is reflected in the loaded Agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-evolve-"));
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(
      join(dir, "agents", "fact-checker.json"),
      JSON.stringify({ slug: "fact-checker", primitives: ["INTERPRET"], input_types: [], output_types: ["Interpretation"], domain: "verification", identity: I1, method: "old method" }),
    );

    const r = await dispatchTool("agent_evolve", { slug: "fact-checker", changes: { identity: I2, method: M2 } }, deps(dir));
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const g = loadGenome(dir);
    const agent = g.agents.get("fact-checker");
    expect(agent, "agent failed to load after evolve").toBeTruthy();
    expect(agent!.identity, "evolved identity not reflected in the loaded agent").toBe(I2);
    expect(agent!.method).toBe(M2);
  });
});
