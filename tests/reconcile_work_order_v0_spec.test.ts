// SPEC — reconcile-work-order-v0, defined by its acceptance tests (WO-B06).
//
// The reconciliation standard WO-F02 ("The Reconciliation", Documenso #1917537) was signed
// and never built. The chancery schema now carries the columns the mechanism runs against
// (chancery_work_order.reconciliation_owner / _budget / _due_at / _state, the
// chancery_work_order_receipt table, and the chancery_work_order_reconciliation_due sweep
// view) — this file IS the contract for standards/reconcile-work-order-v0.json, the standard
// the conductor's timed sweep fires. Each it() is a structural or compositional acceptance
// criterion that FAILS until the standard (and the agents + domain types it seats) is
// authored to meet it (RED — "contract defined, artefact missing").
//
// The five offices, in pipeline order:
//   1. cold-map            deterministic clause→receipt mapping; absences listed; no spend
//   2. hot-audit           refutation that SPENDS, within the order's declared budget
//   3. proof-of-work       the composed, content-addressed contract (cold-map + findings)
//   4. default-judgment    past reconciliation_due_at + clauses unreceipted ⇒ DEFAULTED
//   5. sovereign-settle the parked HUMAN seat; the owner settles ⇒ 'satisfied'
//
// default-judgment sits BEFORE the human seat deliberately: a human chair PARKS a gig
// awaiting approval, and a default record sealed downstream of a park could never land for
// exactly the abandoned orders it exists to expose. The default seals first; abandonment
// cannot hide behind an approval nobody gives.
//
// Structural assertions read the standard JSON off disk (RED while the file is absent, GREEN
// once authored). The composition assertion loads the whole repo genome and confirms the
// standard composes with no load_error — the same gate `npx coltrane validate` runs.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SLUG = "reconcile-work-order-v0";
const STD_PATH = `standards/${SLUG}.json`;

const AGENTS = [
  "receipt-mapper",
  "reconciliation-auditor",
  "proof-composer",
  "default-adjudicator",
] as const;
const DOMAIN_TYPES = ["reconciliation-map", "proof-of-work-contract", "reconciliation-record"] as const;

type Chair = {
  role?: string;
  agent_slug?: string;
  human?: boolean;
  depends_on?: string[];
  input_contract?: string[];
  output_contract?: string[];
  turn_budget?: number;
};
type Phase = { name?: string; chairs?: Chair[]; intent?: string };
type Standard = {
  slug?: string;
  domain?: string;
  status?: string;
  description?: string;
  agent_slugs?: string[];
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
const intent = (name: string): string => String(phase(name)?.intent ?? "");

// ── INV-1 — presence: the standard, its seats, its types ─────────────────────────
describe(`${SLUG} · INV-1 presence`, () => {
  it("the standard file exists on disk", () => {
    expect(existsSync(join(REPO, STD_PATH)), `${STD_PATH} missing`).toBe(true);
  });
  for (const a of AGENTS) {
    it(`agent ${a} exists on disk`, () => {
      expect(existsSync(join(REPO, `agents/${a}.json`)), `agents/${a}.json missing`).toBe(true);
    });
  }
  for (const t of DOMAIN_TYPES) {
    it(`domain type ${t} exists on disk`, () => {
      expect(existsSync(join(REPO, `domain_types/${t}.json`)), `domain_types/${t}.json missing`).toBe(true);
    });
  }
});

// ── INV-2 — exactly five phases, in pipeline order ────────────────────────────────
describe(`${SLUG} · INV-2 phase count + order`, () => {
  it("has exactly the five offices, in order — and the default is sealed before the human seat", () => {
    expect(phases().map((p) => p.name)).toEqual([
      "cold-map",
      "hot-audit",
      "proof-of-work",
      "default-judgment",
      "sovereign-settle",
    ]);
  });
});

// ── INV-3 — cold-map: deterministic clause→receipt mapping, no judgment, no spend ──
describe(`${SLUG} · INV-3 cold-map chair`, () => {
  it("is seated by receipt-mapper (SENSE+INTERPRET — a clerk, not a judge)", () => {
    expect(chair("cold-map").agent_slug).toBe("receipt-mapper");
  });
  it("is the entry chair: depends_on is empty, input is the gig's change-request", () => {
    const c = phase("cold-map")?.chairs?.[0];
    expect(c, "cold-map chair missing").toBeDefined();
    expect(c!.depends_on ?? []).toEqual([]);
    expect(c!.input_contract).toEqual(["change-request"]);
  });
  it("seals the reconciliation-map", () => {
    expect(chair("cold-map").output_contract).toEqual(["reconciliation-map"]);
  });
  it("intent: deterministic, every clause matched to receipts, absences listed absent", () => {
    expect(intent("cold-map")).toMatch(/deterministic/i);
    expect(intent("cold-map")).toMatch(/absent/i);
    expect(intent("cold-map")).toMatch(/receipt/i);
  });
  it("intent: no model judgment, no spend against the budget", () => {
    expect(intent("cold-map")).toMatch(/no (model )?judgment/i);
    expect(intent("cold-map")).toMatch(/no spend|spends nothing/i);
  });
  it("receipt-mapper's hands are read-only — the cold map structurally cannot spend", () => {
    const ag = JSON.parse(readFileSync(join(REPO, "agents/receipt-mapper.json"), "utf8"));
    const tools: string[] = ag.allowed_tools ?? [];
    expect(tools.some((t) => t.startsWith("Bash")), "receipt-mapper must hold no Bash grant").toBe(false);
    expect(ag.code_tool_access).toBe("read");
  });
});

// ── INV-4 — hot-audit: refutation that spends, within the declared budget ─────────
describe(`${SLUG} · INV-4 hot-audit chair`, () => {
  it("is seated by reconciliation-auditor (VERIFY — the refutation seat)", () => {
    expect(chair("hot-audit").agent_slug).toBe("reconciliation-auditor");
  });
  it("depends on cold-map and consumes the order + the map", () => {
    expect(chair("hot-audit").depends_on).toEqual(["cold-map"]);
    expect(chair("hot-audit").input_contract).toEqual(["change-request", "reconciliation-map"]);
  });
  it("seals a change-verdict — the audit findings, every one cited", () => {
    expect(chair("hot-audit").output_contract).toEqual(["change-verdict"]);
  });
  it("declares a finite turn_budget — the structural ceiling on audit spend", () => {
    const tb = chair("hot-audit").turn_budget;
    expect(Number.isInteger(tb), "hot-audit must declare an integer turn_budget").toBe(true);
    expect(tb!).toBeGreaterThan(0);
  });
  it("intent: refutation within the order's declared reconciliation_budget, findings cited", () => {
    expect(intent("hot-audit")).toMatch(/refut/i);
    expect(intent("hot-audit")).toMatch(/reconciliation_budget/);
    expect(intent("hot-audit")).toMatch(/cite/i);
  });
});

// ── INV-5 — proof-of-work: the composed contract, content-addressed ───────────────
describe(`${SLUG} · INV-5 proof-of-work chair`, () => {
  it("is seated by proof-composer (CREATE — copies only, no new verdict)", () => {
    expect(chair("proof-of-work").agent_slug).toBe("proof-composer");
  });
  it("depends on cold-map + hot-audit and consumes exactly their seals", () => {
    expect(chair("proof-of-work").depends_on).toEqual(["cold-map", "hot-audit"]);
    expect(chair("proof-of-work").input_contract).toEqual(["reconciliation-map", "change-verdict"]);
  });
  it("seals the proof-of-work-contract", () => {
    expect(chair("proof-of-work").output_contract).toEqual(["proof-of-work-contract"]);
  });
  it("intent: cold-map + audit findings + a verdict per clause, content-addressed, written as an output", () => {
    expect(intent("proof-of-work")).toMatch(/per[- ]clause|per clause|every clause/i);
    expect(intent("proof-of-work")).toMatch(/content[- ]addressed/i);
    expect(intent("proof-of-work")).toMatch(/output/i);
  });
});

// ── INV-6 — default-judgment: abandonment cannot hide ─────────────────────────────
describe(`${SLUG} · INV-6 default-judgment chair`, () => {
  it("is seated by default-adjudicator (JUDGE — a deterministic rule, not mercy)", () => {
    expect(chair("default-judgment").agent_slug).toBe("default-adjudicator");
  });
  it("depends on cold-map + proof-of-work and consumes order, map, and contract", () => {
    expect(chair("default-judgment").depends_on).toEqual(["cold-map", "proof-of-work"]);
    expect(chair("default-judgment").input_contract).toEqual([
      "change-request",
      "reconciliation-map",
      "proof-of-work-contract",
    ]);
  });
  it("seals the reconciliation-record", () => {
    expect(chair("default-judgment").output_contract).toEqual(["reconciliation-record"]);
  });
  it("intent: past reconciliation_due_at with clauses unreceipted ⇒ state 'defaulted'", () => {
    expect(intent("default-judgment")).toMatch(/reconciliation_due_at/);
    expect(intent("default-judgment")).toMatch(/defaulted/);
    expect(intent("default-judgment")).toMatch(/absen|unreceipted/i);
  });
  it("is sealed BEFORE the human seat — a parked approval cannot mask a default", () => {
    const names = phases().map((p) => p.name);
    expect(names.indexOf("default-judgment")).toBeLessThan(names.indexOf("sovereign-settle"));
    expect(names.indexOf("default-judgment")).toBeGreaterThan(-1);
  });
});

// ── INV-7 — sovereign-settle: the parked human step ───────────────────────────
describe(`${SLUG} · INV-7 sovereign-settle chair`, () => {
  it("is a HUMAN chair — no agent, no skill; the gig PARKS awaiting the owner", () => {
    const c = phase("sovereign-settle")?.chairs?.[0];
    expect(c, "sovereign-settle chair missing").toBeDefined();
    expect(c!.human).toBe(true);
    expect(c!.agent_slug ?? "").toBe("");
  });
  it("consumes the proof-of-work contract and the adjudicated record", () => {
    expect(chair("sovereign-settle").input_contract).toEqual([
      "proof-of-work-contract",
      "reconciliation-record",
    ]);
    expect(chair("sovereign-settle").depends_on).toEqual(["proof-of-work", "default-judgment"]);
  });
  it("seals exactly one output — the settled reconciliation-record", () => {
    expect(chair("sovereign-settle").output_contract).toEqual(["reconciliation-record"]);
  });
  it("intent: settling records reconciliation_state 'satisfied' via settled_by", () => {
    expect(intent("sovereign-settle")).toMatch(/satisfied/);
    expect(intent("sovereign-settle")).toMatch(/settled_by/);
    expect(intent("sovereign-settle")).toMatch(/owner|governor|sovereign/i);
  });
});

// ── INV-8 — standard metadata ─────────────────────────────────────────────────────
describe(`${SLUG} · INV-8 metadata`, () => {
  it("domain is 'software-change'", () => {
    expect(readStandard()?.domain).toBe("software-change");
  });
  it("input_types are ['change-request'] — the sweep's dispatch names the order", () => {
    expect(readStandard()?.input_types).toEqual(["change-request"]);
  });
  it("output_types are ['reconciliation-record']", () => {
    expect(readStandard()?.output_types).toEqual(["reconciliation-record"]);
  });
  it("status is 'active'", () => {
    expect(readStandard()?.status).toBe("active");
  });
  it("agent_slugs list exactly the four seated agents", () => {
    expect(readStandard()?.agent_slugs).toEqual([...AGENTS]);
  });
  it("description names the debt it pays: WO-F02, Documenso #1917537", () => {
    expect(String(readStandard()?.description ?? "")).toMatch(/WO-F02/);
    expect(String(readStandard()?.description ?? "")).toMatch(/1917537/);
  });
  it("description names the DB contract it runs against", () => {
    const d = String(readStandard()?.description ?? "");
    expect(d).toMatch(/chancery_work_order_receipt/);
    expect(d).toMatch(/chancery_work_order_reconciliation_due/);
    expect(d).toMatch(/reconciliation_state/);
  });
});

// ── INV-9 — the reconciliation-record's state vocabulary matches the DB check ─────
describe(`${SLUG} · INV-9 record state vocabulary`, () => {
  it("reconciliation-record's reconciliation_state enum is exactly the DB's check constraint", () => {
    const t = JSON.parse(
      readFileSync(join(REPO, "domain_types/reconciliation-record.json"), "utf8"),
    );
    const en = t?.schema?.properties?.reconciliation_state?.enum;
    expect(en).toEqual(["pending", "satisfied", "defaulted"]);
  });
});

// ── INV-10 — composes green under the genome's own gate ───────────────────────────
describe(`${SLUG} · INV-10 composes under validate`, () => {
  it("loads into the genome — no load_error for the standard, its agents, or its types", () => {
    const g = loadGenome(REPO);
    const mine = new Set<string>([SLUG, ...AGENTS, ...DOMAIN_TYPES]);
    const errs = g.load_errors.filter((e) => e.slug != null && mine.has(e.slug));
    expect(errs, errs.map((e) => `${e.kind} ${e.slug}: ${e.error}`).join("\n")).toEqual([]);
    expect(g.standards.has(SLUG), `${SLUG} did not compose`).toBe(true);
  });
  it("the loaded graph seats the four agents then the human office, in order", () => {
    const g = loadGenome(REPO);
    const s = g.standards.get(SLUG);
    expect(s, `${SLUG} did not load`).toBeDefined();
    // The loader normalizes a human chair's agent_slug to "" — map both absent and "" to (human).
    expect((s!.phases ?? []).map((p) => p.chairs?.[0]?.agent_slug || "(human)")).toEqual([
      ...AGENTS,
      "(human)",
    ]);
  });
  it("the three domain types are in the loaded genome", () => {
    const g = loadGenome(REPO);
    for (const t of DOMAIN_TYPES) {
      expect(g.domain_types.has(t), `domain type ${t} did not load`).toBe(true);
    }
  });
});
