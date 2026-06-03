// portfolio.test.ts — unit tests for the sprint-portfolio primitive.
//
// Each test gets a fresh tempdir as genomes_root → fully isolated jsonl.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listPortfolio,
  parkGenome,
  resumeGenome,
  suggestNextAction,
  SealMismatchError,
  type PortfolioEntry,
} from "../src/portfolio.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "portfolio-test-"));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("listPortfolio", () => {
  it("returns [] on empty directory", () => {
    const portfolio = listPortfolio(root);
    expect(portfolio).toEqual([]);
  });
});

describe("parkGenome", () => {
  it("parks a genome and listPortfolio surfaces it", () => {
    const state = { phase: "define", payload: { x: 1 } };
    const entry = parkGenome("project-alpha", state, {
      current_phase: "define",
      current_standard_slug: "project-bootstrap-v0",
      genomes_root: root,
    });
    expect(entry.genome_slug).toBe("project-alpha");
    expect(entry.current_phase).toBe("define");
    expect(entry.sealed_state_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.parked_at_utc).not.toBeNull();
    expect(entry.next_natural_action).toContain("Converge");

    const portfolio = listPortfolio(root);
    expect(portfolio).toHaveLength(1);
    expect(portfolio[0]?.genome_slug).toBe("project-alpha");
    expect(portfolio[0]?.sealed_state_hash).toBe(entry.sealed_state_hash);
  });

  it("parking the same slug twice shows LATEST entry only (latest-wins)", () => {
    parkGenome(
      "project-alpha",
      { v: 1 },
      { current_phase: "discover", current_standard_slug: "project-bootstrap-v0", genomes_root: root },
    );
    const second = parkGenome(
      "project-alpha",
      { v: 2 },
      { current_phase: "develop", current_standard_slug: "project-bootstrap-v0", genomes_root: root },
    );

    const portfolio = listPortfolio(root);
    expect(portfolio).toHaveLength(1);
    expect(portfolio[0]?.current_phase).toBe("develop");
    expect(portfolio[0]?.sealed_state_hash).toBe(second.sealed_state_hash);
  });
});

describe("resumeGenome", () => {
  it("restores parked state and seal verification passes", () => {
    const state = { phase: "develop", artifacts: ["a.ts", "b.ts"], cursor: 42 };
    parkGenome("project-alpha", state, {
      current_phase: "develop",
      current_standard_slug: "project-bootstrap-v0",
      genomes_root: root,
    });

    const { entry, restored_state } = resumeGenome("project-alpha", { genomes_root: root });
    expect(entry.genome_slug).toBe("project-alpha");
    expect(entry.current_phase).toBe("develop");
    expect(entry.parked_at_utc).toBeNull(); // resumed → not parked anymore
    expect(entry.sealed_state_hash).toBeNull();
    expect(restored_state).toEqual(state);
  });

  it("on tampered jsonl (modify state field) returns typed SealMismatchError", () => {
    const state = { phase: "develop", payload: "honest" };
    parkGenome("project-alpha", state, {
      current_phase: "develop",
      current_standard_slug: "project-bootstrap-v0",
      genomes_root: root,
    });

    // tamper: rewrite the jsonl with a modified state field but ORIGINAL hash
    const jsonlPath = join(root, ".coltrane", "portfolio.jsonl");
    const raw = readFileSync(jsonlPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const parsed = JSON.parse(lines[0]!);
    parsed.state.payload = "tampered"; // mutate the recorded state, leave hash alone
    const tampered = JSON.stringify(parsed) + "\n";
    writeFileSync(jsonlPath, tampered);

    expect(() => resumeGenome("project-alpha", { genomes_root: root })).toThrow(SealMismatchError);
  });
});

describe("suggestNextAction", () => {
  it("returns a non-empty string containing the phase and an action verb", () => {
    const entry: PortfolioEntry = {
      genome_slug: "project-alpha",
      current_phase: "define",
      current_standard_slug: "project-bootstrap-v0",
      last_touched_utc: new Date().toISOString(),
      sealed_state_hash: null,
      next_natural_action: "",
      parked_at_utc: null,
    };
    const action = suggestNextAction(entry);
    expect(action.length).toBeGreaterThan(0);
    expect(action).toContain("Converge"); // verb for the define phase
    expect(action).toContain("project-bootstrap-v0");
    expect(action).toContain("current"); // not parked → "current" status
  });

  it("flips status to [parked] when parked_at_utc is non-null", () => {
    const entry: PortfolioEntry = {
      genome_slug: "project-alpha",
      current_phase: "develop",
      current_standard_slug: "project-bootstrap-v0",
      last_touched_utc: new Date().toISOString(),
      sealed_state_hash: "abc",
      next_natural_action: "",
      parked_at_utc: new Date().toISOString(),
    };
    expect(suggestNextAction(entry)).toContain("parked");
  });
});

describe("canonical determinism of the seal", () => {
  it("same content produces same hash", () => {
    const a = parkGenome("p1", { x: 1, y: 2 }, { genomes_root: root });
    rmSync(join(root, ".coltrane"), { recursive: true, force: true });
    mkdirSync(join(root, ".coltrane"), { recursive: true });
    const b = parkGenome("p1", { y: 2, x: 1 }, { genomes_root: root }); // key-order differs
    expect(b.sealed_state_hash).toBe(a.sealed_state_hash);
    // and the jsonl exists
    expect(existsSync(join(root, ".coltrane", "portfolio.jsonl"))).toBe(true);
  });
});
