// SPEC — deliberation-before-amendment v1, defined by its acceptance tests.
//
// The landrace amendment (founding-pass Step 2): the institution amends its own law once
// through its own RED-first gate. This file IS the contract for
// standards/deliberation-before-amendment-v1.json — each it() is a structural or compositional
// acceptance criterion that FAILS until the standard is authored to meet it (RED — "contract
// defined, artefact missing"). The two-phase graph mends the founding finding recorded in
// docs/founding/RUNBOOK.md line 53: the seed's v0 sole-VERIFY phase is refused by the tip's
// NEEDS_TARGET rule (src/composition.ts:582-588) because it has no upstream phase target;
// v1 seats a non-drafting reader (context-reader, SENSE+INTERPRET) BEFORE the reviewer
// (spec-reviewer, VERIFY), so the VERIFY phase gains its upstream target.
//
// Structural assertions read the standard JSON off disk (RED while the file is absent, GREEN once
// authored). The composition assertion loads the whole repo genome and confirms the standard
// composes with no load_error — the same gate `npx coltrane validate` runs (src/cli.ts:351-354).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SLUG = "deliberation-before-amendment-v1";
const STD_PATH = `standards/${SLUG}.json`;

type Chair = {
  role?: string;
  agent_slug?: string;
  depends_on?: string[];
  input_contract?: string[];
  output_contract?: string[];
};
type Phase = { name?: string; chairs?: Chair[]; intent?: string };
type Standard = {
  slug?: string;
  domain?: string;
  status?: string;
  input_types?: string[];
  output_types?: string[];
  phases?: Phase[];
};

const readStandard = (): Standard | null =>
  existsSync(join(REPO, STD_PATH))
    ? (JSON.parse(readFileSync(join(REPO, STD_PATH), "utf8")) as Standard)
    : null;
const phases = (): Phase[] => readStandard()?.phases ?? [];
const phase = (name: string): Phase | undefined => phases().find((p) => p.name === name);
const chair = (name: string): Chair => phase(name)?.chairs?.[0] ?? {};

// ── INV-1 — presence ─────────────────────────────────────────────────────────────
describe("deliberation-before-amendment-v1 · INV-1 presence", () => {
  it("the standard file exists on disk", () => {
    expect(existsSync(join(REPO, STD_PATH)), `${STD_PATH} missing`).toBe(true);
  });
});

// ── INV-2 — exactly two phases, in order ──────────────────────────────────────────
describe("deliberation-before-amendment-v1 · INV-2 phase count + order", () => {
  it("has exactly two phases named, in order, read-proposal then deliberate", () => {
    expect(phases().map((p) => p.name)).toEqual(["read-proposal", "deliberate"]);
  });
});

// ── INV-3 — read-proposal chair (framing, no upstream) ────────────────────────────
describe("deliberation-before-amendment-v1 · INV-3 read-proposal chair", () => {
  it("is seated by context-reader (the SENSE+INTERPRET framer)", () => {
    expect(chair("read-proposal").agent_slug).toBe("context-reader");
  });
  it("takes input_contract ['change-request']", () => {
    expect(chair("read-proposal").input_contract).toEqual(["change-request"]);
  });
  it("produces output_contract ['change-context']", () => {
    expect(chair("read-proposal").output_contract).toEqual(["change-context"]);
  });
  it("has no upstream — depends_on is empty (it is the first phase)", () => {
    // Anchor to the chair's presence first, else an absent file yields an empty {} whose
    // missing depends_on trivially satisfies []-equality — a green that proves nothing.
    const c = phase("read-proposal")?.chairs?.[0];
    expect(c, "read-proposal chair missing").toBeDefined();
    expect(c!.depends_on ?? []).toEqual([]);
  });
});

// ── INV-4 — deliberate chair (judgment, targeting read-proposal) ──────────────────
describe("deliberation-before-amendment-v1 · INV-4 deliberate chair", () => {
  it("is seated by spec-reviewer (the VERIFY judge)", () => {
    expect(chair("deliberate").agent_slug).toBe("spec-reviewer");
  });
  it("depends_on ['read-proposal'] — the upstream target NEEDS_TARGET demands", () => {
    expect(chair("deliberate").depends_on).toEqual(["read-proposal"]);
  });
  it("takes input_contract ['red-spec','change-context']", () => {
    expect(chair("deliberate").input_contract).toEqual(["red-spec", "change-context"]);
  });
  it("produces output_contract ['change-verdict']", () => {
    expect(chair("deliberate").output_contract).toEqual(["change-verdict"]);
  });
});

// ── INV-5 — standard metadata ─────────────────────────────────────────────────────
describe("deliberation-before-amendment-v1 · INV-5 metadata", () => {
  it("domain is 'spec-drafting'", () => {
    expect(readStandard()?.domain).toBe("spec-drafting");
  });
  it("input_types are ['change-request','red-spec']", () => {
    expect(readStandard()?.input_types).toEqual(["change-request", "red-spec"]);
  });
  it("output_types are ['change-verdict']", () => {
    expect(readStandard()?.output_types).toEqual(["change-verdict"]);
  });
  it("status is 'active'", () => {
    expect(readStandard()?.status).toBe("active");
  });
});

// ── INV-6 — the thin-canon doctrine in the intent strings ─────────────────────────
// The reader frames and NEVER judges; the reviewer judges and NEVER drafts. The seam between
// framing and judgment is the whole point of the two-phase shape — assert it lives in the text.
describe("deliberation-before-amendment-v1 · INV-6 thin-canon intent doctrine", () => {
  it("read-proposal's intent says the reader frames the proposal", () => {
    expect(String(phase("read-proposal")?.intent ?? "")).toMatch(/frame/i);
  });
  it("read-proposal's intent says the reader never judges", () => {
    expect(String(phase("read-proposal")?.intent ?? "")).toMatch(/never judge/i);
  });
  it("deliberate's intent says the reviewer judges (soundness / non-vacuity / buildability)", () => {
    expect(String(phase("deliberate")?.intent ?? "")).toMatch(/judge/i);
  });
  it("deliberate's intent says the reviewer never drafts", () => {
    expect(String(phase("deliberate")?.intent ?? "")).toMatch(/never draft/i);
  });
});

// ── INV-7 — composes green (the mended founding finding, at its own gate) ──────────
// `npx coltrane validate` loads the genome and exits non-zero on any load_error
// (src/cli.ts:351-354). loadGenome runs composeStandard over every standard, so a
// NEEDS_TARGET refusal surfaces as a load_error for this slug. This asserts the founding
// finding is MENDED: the VERIFY phase has its upstream target and the graph composes.
describe("deliberation-before-amendment-v1 · INV-7 composes under validate", () => {
  it("loads into the genome — composeStandard raises no refusal", () => {
    const g = loadGenome(REPO);
    const err = g.load_errors.find((e) => e.kind === "standard" && e.slug === SLUG);
    expect(err, err ? `load_error: ${err.error}` : undefined).toBeUndefined();
    expect(g.standards.has(SLUG), `${SLUG} did not load`).toBe(true);
  });
  it("the loaded graph seats VERIFY (spec-reviewer) downstream of the SENSE+INTERPRET reader", () => {
    const g = loadGenome(REPO);
    const s = g.standards.get(SLUG);
    expect(s, `${SLUG} did not load`).toBeDefined();
    expect((s!.phases ?? []).map((p) => p.chairs?.[0]?.agent_slug)).toEqual([
      "context-reader",
      "spec-reviewer",
    ]);
  });
});
