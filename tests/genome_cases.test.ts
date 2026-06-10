// Genome-spec case table — the LOADING layer of the recursion. Each case is a declarative
// genome (agents/standards/types, valid or deliberately deficient); the runner materializes
// it to a dir via the shared scaffolding and asserts loadGenome's outcome. Subsumes the
// old genome_loading + loader_soft_fail imperative suites.
//
// Two failure classes are pinned here, and they differ on PURPOSE:
//   - INCOMPLETE against the schema (an agent missing required behavioral representation)
//     → HARD-fails the whole load. An underdeveloped genome must be upgraded, not skipped.
//   - MALFORMED / illegal (bad JSON, empty primitives, a broken standard) → SOFT-fails:
//     skip the offending file, record it, keep loading (Rob #129).
import { describe, it, expect } from "vitest";
import { loadGenome, GenomeLoadError, GenomeIncompleteError, CompositionError } from "../src";
import type { Primitive } from "../src";
import { agentDef } from "./_support/agents.js";
import { makeGenomeDir, rmGenome, seedCoreTypes, writeAgent, writeRawAgent, writeStandard } from "./_support/genome.js";

interface AgentFix {
  slug: string;
  primitives?: Primitive[];
  output_types?: string[];
  lean?: boolean;       // write WITHOUT behavioral fields → incomplete → HARD fail
  emptyPrims?: boolean; // valid behavioral but no primitives → malformed → soft fail
}
interface GenomeCase {
  name: string;
  cores?: number; // default 6; fewer → core gate HARD-fails
  agents?: AgentFix[];
  rawAgents?: { file: string; content: string }[];
  standards?: ({ slug: string } & Record<string, unknown>)[];
  expect: {
    present?: string[];
    absent?: string[];
    standardsPresent?: string[];
    standardsAbsent?: string[];
    errors?: { kind: string; matches?: string }[];
    clean?: boolean;
    throws?: "incomplete" | "core" | "malformed";
  };
}

const std = (slug: string, agentSlug: string, output: string) => ({
  slug, domain: "demo", agent_slugs: [agentSlug],
  phases: [{ name: "p", chairs: [{ role: "r", agent_slug: agentSlug, depends_on: [], input_contract: [], output_contract: [output], required_skills: [] }] }],
});

const CASES: GenomeCase[] = [
  { name: "valid agents load cleanly",
    agents: [{ slug: "scout", primitives: ["SENSE"] }, { slug: "summarizer", primitives: ["INTERPRET"] }],
    expect: { present: ["scout", "summarizer"], clean: true } },

  { name: "a LEAN agent (no behavioral representation) HARD-fails the whole load",
    agents: [{ slug: "good", primitives: ["SENSE"] }, { slug: "lean", primitives: ["SENSE"], lean: true }],
    expect: { throws: "incomplete" } },

  { name: "an empty-primitives agent HARD-fails (a malformed agent blocks the load too)",
    agents: [{ slug: "good", primitives: ["SENSE"] }, { slug: "broken", emptyPrims: true }],
    expect: { throws: "malformed" } },

  { name: "malformed JSON SOFT-fails; good agent loads",
    agents: [{ slug: "good", primitives: ["SENSE"] }],
    rawAgents: [{ file: "bad.json", content: "{not valid json" }],
    expect: { present: ["good"], errors: [{ kind: "agent", matches: "json|parse|malformed" }] } },

  { name: "a broken standard SOFT-fails; good standard + agent load",
    agents: [{ slug: "scout", primitives: ["SENSE"], output_types: ["raw-note"] }],
    standards: [std("good-standard", "scout", "raw-note"), std("broken-standard", "ghost-agent", "raw-note")],
    expect: { present: ["scout"], standardsPresent: ["good-standard"], standardsAbsent: ["broken-standard"], errors: [{ kind: "standard", matches: "ghost|unknown|undefined" }] } },

  { name: "missing a core type HARD-fails (strict gate, never soft)",
    cores: 5, agents: [{ slug: "scout", primitives: ["SENSE"] }],
    expect: { throws: "core" } },

  { name: "clean genome reports empty load_errors",
    agents: [{ slug: "scout", primitives: ["SENSE"] }],
    expect: { clean: true } },

  { name: "duplicate agent slug SOFT-fails",
    rawAgents: [
      { file: "a.json", content: JSON.stringify(agentDef({ slug: "dup", primitives: ["SENSE"] })) },
      { file: "b.json", content: JSON.stringify(agentDef({ slug: "dup", primitives: ["SENSE"] })) },
    ],
    expect: { errors: [{ kind: "agent", matches: "duplicate" }] } },
];

describe("genome-spec loading cases", () => {
  it.each(CASES)("$name", (c) => {
    const root = makeGenomeDir();
    try {
      seedCoreTypes(root, c.cores ?? 6);
      for (const a of c.agents ?? []) {
        if (a.lean) {
          writeRawAgent(root, `${a.slug}.json`, JSON.stringify({ slug: a.slug, primitives: a.primitives ?? ["SENSE"], output_types: a.output_types ?? ["raw-note"], domain: "demo" }));
        } else if (a.emptyPrims) {
          writeRawAgent(root, `${a.slug}.json`, JSON.stringify(agentDef({ slug: a.slug, primitives: [] as unknown as Primitive[] })));
        } else {
          writeAgent(root, { slug: a.slug, primitives: a.primitives ?? ["SENSE"], output_types: a.output_types ?? ["raw-note"], domain: "demo" });
        }
      }
      for (const r of c.rawAgents ?? []) writeRawAgent(root, r.file, r.content);
      for (const s of c.standards ?? []) writeStandard(root, s);

      if (c.expect.throws === "incomplete") {
        expect(() => loadGenome(root)).toThrow(GenomeIncompleteError);
        return;
      }
      if (c.expect.throws === "malformed") {
        expect(() => loadGenome(root)).toThrow(CompositionError);
        return;
      }
      if (c.expect.throws === "core") {
        expect(() => loadGenome(root)).toThrow(GenomeLoadError);
        return;
      }

      const g = loadGenome(root);
      for (const s of c.expect.present ?? []) expect(g.agents.has(s), `${s} should be present`).toBe(true);
      for (const s of c.expect.absent ?? []) expect(g.agents.has(s), `${s} should be absent`).toBe(false);
      for (const s of c.expect.standardsPresent ?? []) expect(g.standards.has(s)).toBe(true);
      for (const s of c.expect.standardsAbsent ?? []) expect(g.standards.has(s)).toBe(false);
      for (const e of c.expect.errors ?? []) {
        expect(g.load_errors.some((le) => le.kind === e.kind && (!e.matches || new RegExp(e.matches, "i").test(le.error))), `expected a ${e.kind} load_error${e.matches ? ` matching /${e.matches}/` : ""}`).toBe(true);
      }
      if (c.expect.clean) expect(g.load_errors).toEqual([]);
    } finally {
      rmGenome(root);
    }
  });
});
