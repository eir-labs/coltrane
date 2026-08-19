// RED — a sealed output must stamp the REAL version of the domain type it conforms to, inside
// the content-hash pre-image, not the hardcoded constant 1.
//
// THE DEFECT (found 2026-08-20, immediately after PR #433 landed). Until #433 every domain type
// was version 1 — nothing could bump one, so stamping 1 was accurate. #433 made a type's version
// real: type_extend now persists a bumped definition and a second extend reaches v3 (see
// tests/type_extend_persist.test.ts AC6). The seal stamp did not follow. `domain_type_version: 1`
// is hardcoded at four seal sites:
//   • src/runtime.ts:2050  — the REUSE re-hash inside outputContentHash
//   • src/runtime.ts:2742  — the PRIMARY seal path (outputs.write omits the field → defaults to 1)
//   • src/worker.ts:732    — the DRAIN SHA-verification inside outputContentHash
//   • src/worker.ts:783    — the DRAIN write into the local row
// The value sits INSIDE outputContentHash's pre-image (src/canonical_form.ts:114), so it is in the
// record's IDENTITY, not merely a field beside it. Two outputs conforming to genuinely different
// versions of one type hash as though they conformed to the same — a hardcoded field inside the
// hash pre-image is the one way the readable-chain promise degrades without anything failing.
//
// THE DIRECTION (bill-change-plan / miles-change-decision): a new OutputStore.typeVersionOf(slug)
// parallels coreTypeOf; the four sites read the loaded genome's current version through it.
// outputs.write() keeps its `?? 1` default so a caller that omits the field, and every one of the
// 9,110 already-sealed v1 records, are byte-identical to before. src/server.ts:492 (type_register,
// genuinely v1 for a NEW type) is deliberately left unchanged.
//
// THE LAWS. A/B/C are RED on ae7954d — their failure IS the reproduction:
//   LAW A (AC1) — a runtime seal against a type at v3 records 3, observed on the sealed record.
//   LAW B (AC2) — the drain path re-derives v3 from the genome: it ACCEPTS a v3-sealed row and
//                 writes the local row at v3 (worker.ts:732 SHA-verify + worker.ts:783 write).
//   LAW C (AC3) — two records with identical data but different type versions hash DISTINCTLY.
// D/E are regression GUARDS, green by design — an invariance ("this must NOT move") is falsely
// stated as a RED law, so it is pinned green and turns red only if the fix wrongly moves a v1 hash
// or touches the type_register site:
//   LAW D (AC4) — a v1 seal produces a byte-identical content_sha (pinned vector).
//   LAW E (AC5) — type_register still stamps a freshly created type as v1 (server.ts:492 unchanged).
//
// METHOD. Axiomatic/example-based, exercising the REAL callsites end-to-end: LAW A/C/D drive the
// primary seal through composeStandard + runGig (the runtime.ts:2742 path); LAW B drives the
// exported resumeStateFromDrain (the worker.ts:732/:783 path); LAW E drives dispatchTool's
// type_register handler. No callsite is mocked or asserted-by-passed-argument.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  composeStandard,
  runGig,
  outputContentHash,
  type AgentInvoker,
  type PhaseDef,
  type Chair,
  type Registry,
} from "../src/index.js";
import { resumeStateFromDrain, type DrainedOutput } from "../src/worker.js";
import type { RunIdentity } from "../src/reuse.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { testAgent } from "./_support/agents.js";

// The motivating shape: a domain type that has been extended twice, so the loaded genome's copy
// carries version 3 — exactly what PR #433's second-extend produces. `probe-note` extends Signal
// (substance floor: `source`) and carries an explicit version so the registry reports it.
const SLUG = "probe-note";

function registryAtVersion(version: number): Registry {
  const registry = createRegistry();
  registry.registerType({
    slug: SLUG,
    extends: "Signal",
    domain: "demo",
    schema: { properties: { source: { type: "string" }, note: { type: "string" } } },
    required_fields: ["source"],
    version,
  });
  return registry;
}

// A SENSE root agent that seals a single probe-note, and the one-chair standard that seats it.
const scout = () => testAgent({ slug: "scout", primitives: ["SENSE"], input_types: [], output_types: [SLUG], domain: "demo" });

const scanChair: Chair = {
  role: "scan",
  agent_slug: "scout",
  depends_on: [],
  input_contract: [],
  output_contract: [SLUG],
  required_skills: [],
};

const probeStandard = () =>
  composeStandard({
    slug: "probe-std",
    domain: "demo",
    agents: [scout()],
    phases: [{ name: "scan", chairs: [scanChair] } as PhaseDef],
  });

// The bytes every seal in this file carries — held constant so a content_sha difference can only
// come from the version folded into the pre-image.
const DATA = { source: "fixture://demo/probe", note: "held constant across every seal" };

/** Seal one probe-note through the PRIMARY seal path (runtime.ts:2742) against a registry pinned
 *  at `version`, and hand back the sealed record. */
async function sealThroughRuntime(version: number) {
  const registry = registryAtVersion(version);
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  const invoke: AgentInvoker = async () => ({ ...DATA });
  const res = await runGig(probeStandard(), { q: "x" }, { outputs, ledger, invoke });
  expect(res.status, "the probe gig must complete so a record exists to inspect").toBe("complete");
  const rec = outputs.all().find((o) => o.gig_id === res.gig_id && o.domain_type === SLUG);
  expect(rec, "the runtime sealed no probe-note record").toBeDefined();
  return rec!;
}

describe("domain_type_version — a sealed output stamps the type's REAL version, not the constant 1", () => {
  // ── LAW A (AC1, RED) — the primary seal path records the real version, end to end ───────────
  it("LAW A/AC1/RED: a runtime seal against a type at v3 records domain_type_version 3 on the sealed record", async () => {
    const rec = await sealThroughRuntime(3);

    // The observation is on the SEALED RECORD, not on an argument passed to write(): the record is
    // read back out of the store after the whole seal path ran.
    expect(
      rec.domain_type_version,
      "the primary seal path (src/runtime.ts:2742) calls outputs.write WITHOUT domain_type_version, " +
        "so outputs.ts defaults it to 1 — a record sealed against v3 of the type claims it conforms to v1",
    ).toBe(3);

    // And the stored content_sha must be reproducible from the record's OWN fields — the version it
    // carries is the version folded into its identity, with no silent constant substituted.
    const recomputed = outputContentHash({
      core_type: rec.core_type,
      domain_type: rec.domain_type,
      domain_type_version: rec.domain_type_version,
      domain: rec.domain,
      primitive: rec.primitive,
      phase: rec.phase,
      agent_slug: rec.agent_slug,
      data: rec.data,
    });
    expect(recomputed, "the stored content_sha must fold the record's own version").toBe(rec.content_sha);
  });

  // ── LAW C (AC3, RED) — hash-distinctness across versions ────────────────────────────────────
  it("LAW C/AC3/RED: two records with identical data but conforming to v1 vs v3 of one type hash DIFFERENTLY", async () => {
    const v1 = await sealThroughRuntime(1);
    const v3 = await sealThroughRuntime(3);

    // Same bytes, same agent, same phase, same core/domain/primitive — the ONLY difference is the
    // version the type carried at seal. If the version is not in the identity, these collide.
    expect(v1.data).toEqual(v3.data);
    expect(
      v3.content_sha,
      "two outputs conforming to genuinely different versions of one type must NOT hash identically — " +
        "with the constant 1 folded into both pre-images they collide, which is the identity corruption " +
        "the change-request names",
    ).not.toBe(v1.content_sha);
  });

  // ── LAW D (AC4, GUARD/green) — a v1 seal is byte-identical to before this change ─────────────
  // Pinned vector: the content_sha a probe-note sealed at v1 with DATA produces on ae7954d. Every
  // one of the 9,110 already-sealed outputs was sealed while its type was v1, so their hashes must
  // not move. Red ONLY if the fix wrongly shifts a v1 hash. The literal is the frozen baseline; the
  // independent recompute proves the seal path folds exactly {version:1, these fields}.
  it("LAW D/AC4/GUARD: a seal against a type still at v1 reproduces the exact prior content_sha", async () => {
    const rec = await sealThroughRuntime(1);
    expect(rec.domain_type_version, "a v1 type must still stamp 1").toBe(1);

    // The FROZEN byte-vector: the content_sha this probe-note produced on ae7954d (captured this
    // run, before any src change). A hardcoded literal, not a recompute, so it also catches a shift
    // in the pre-image encoding — the fix must not move it by a single byte.
    const V1_PINNED = "a8cb0e05084101aea17661fe191b8c8ebd720d84a913953bd44ab4d7d3ecaa37";
    expect(
      rec.content_sha,
      "the v1 pre-image {Signal, probe-note, v1, demo, SENSE, scan, scout, DATA} must hash exactly as it " +
        "did before this change — moving a v1 hash rewrites a sealed record's identity, the one thing an " +
        "append-only ledger may never do",
    ).toBe(V1_PINNED);
    // Cross-check: the frozen literal IS the hash of the fixed v1 pre-image, so a future reader can
    // see what the vector pins without re-running the seal.
    expect(
      outputContentHash({
        core_type: "Signal", domain_type: SLUG, domain_type_version: 1, domain: "demo",
        primitive: "SENSE", phase: "scan", agent_slug: "scout", data: DATA,
      }),
      "the pinned vector must equal the hash of the {v1, fixed-fields} pre-image",
    ).toBe(V1_PINNED);
  });

  // ── LAW B (AC2, RED) — the drain path re-derives the version from the genome ─────────────────
  // resumeStateFromDrain (src/worker.ts:679) is the exported reconstruction the drain worker runs.
  // The sink deliberately omits domain_type_version (worker.ts:479), so it is RE-DERIVED from the
  // loaded genome and proved against the sha the sink recorded. A row sealed at v3 must therefore be
  // ACCEPTED (worker.ts:732 must re-hash with 3, not 1) and the local row it writes must carry 3
  // (worker.ts:783 must stamp 3, not 1).
  it("LAW B/AC2/RED: a v3-sealed drained row is accepted and the local row it writes records version 3", () => {
    const registry = registryAtVersion(3);
    const outputs = createOutputStore(registry);
    const standard = probeStandard();

    // The content_sha this row WAS sealed under: v3, with the exact spec the drain re-derivation
    // reconstructs from the genome (core Signal, primitive SENSE, domain demo, phase scan, scout).
    const content_sha = outputContentHash({
      core_type: "Signal",
      domain_type: SLUG,
      domain_type_version: 3,
      domain: "demo",
      primitive: "SENSE",
      phase: "scan",
      agent_slug: "scout",
      data: DATA,
    });
    const drained: DrainedOutput[] = [
      {
        id: "sink-row-1",
        domain_type: SLUG,
        agent_slug: "scout",
        phase: "scan",
        content_sha,
        input_shas: [],
        created_at: "2026-08-20T00:00:00.000Z",
        data: { ...DATA },
      },
    ];
    const identity: RunIdentity = {
      standard_slug: "probe-std",
      genome_hash: "0".repeat(64),
      producers_sha: "0".repeat(64),
      gig_input_sha: "0".repeat(64),
      model_version: "unknown",
      depth: "",
      canonical_form_version: "test",
    };

    const res = resumeStateFromDrain({ gig_id: "gig-drain-b", standard, identity, rows: drained, outputs });

    // The drain SHA-verification (worker.ts:732) must accept the v3 row. Hardcoded 1 re-hashes to a
    // different sha than the sink recorded, so the WHOLE reconstruction is refused — this is RED.
    expect(
      res.ok,
      res.ok ? "" : `drain reconstruction refused a v3-sealed row — ${(res as { reason: string }).reason}. ` +
        "worker.ts:732 re-hashes with the hardcoded 1 instead of the version the genome shows (3), so the " +
        "row no longer matches its claimed content_sha.",
    ).toBe(true);

    // And the local row the drain wrote (worker.ts:783) must carry the version the type held at seal.
    const local = outputs.all().find((o) => o.gig_id === "gig-drain-b" && o.domain_type === SLUG);
    expect(local, "the drain wrote no local probe-note row").toBeDefined();
    expect(
      local!.domain_type_version,
      "worker.ts:783 writes domain_type_version:1 into the local row — a drained record must carry the " +
        "version its type held when it was sealed (3), re-derived from the genome",
    ).toBe(3);
    // The locally written row re-hashes to the sink's sha — the chain crosses the drain intact.
    expect(local!.content_sha, "the reconstructed row must re-hash to the sha the sink recorded").toBe(content_sha);
  });

  // ── LAW E (AC5, GUARD/green) — type_register still stamps a NEW type as v1, untouched ────────
  // src/server.ts:492 hardcodes version 1 in the type_register handler. That is CORRECT and must
  // stay: type_register creates a NEW type, which genuinely is v1. This guard proves the behavior
  // (a freshly registered type is v1 on disk) and turns red only if that site is wrongly "fixed".
  it("LAW E/AC5/GUARD: type_register persists a freshly created type at version 1 (server.ts:492 unchanged)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtv-register-"));
    try {
      const deps: ServerDeps = {
        registry: createRegistry(),
        outputs: createOutputStore(createRegistry()),
        ledger: new MemoryLedger(),
        genome_dir: dir,
      };
      const res = await dispatchTool(
        "type_register",
        {
          slug: "freshly-registered",
          extends: "Signal",
          domain: "dtvtests",
          schema: { type: "object", properties: { source: { type: "string" } } },
          required_fields: ["source"],
        },
        deps,
      );
      expect(res.ok, `type_register failed: ${res.error}`).toBe(true);

      const rec = JSON.parse(readFileSync(join(dir, "domain_types", "freshly-registered.json"), "utf-8")) as {
        version?: number;
      };
      expect(
        rec.version,
        "a NEW type is genuinely v1; server.ts:492 must stay hardcoded to 1 — do not 'fix' the site that is correct",
      ).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
