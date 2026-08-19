// RED — type_extend must PERSIST, not merely acknowledge.
//
// The defect (found 2026-08-20): the type_extend handler (src/server.ts:1582-1624) validates
// the merge, computes a next version through proposeTypeChange, then calls recordIdentity
// (src/genome_writer.ts:111) — a LEDGER-ONLY seal — and returns { ok:true, new_version:2, ... }.
// It never writes a file. So ok:true names a version that exists nowhere on disk: a fresh
// genome load still resolves version 1 without the field, and the ledger carries a
// genome_mutation row for a definition the genome does not hold.
//
// Direction (miles-decision-0d2f156b): PERSIST — materialize the extended definition exactly
// as type_register does (sealDefinition → writeGenomeFileVersioned overwriting
// domain_types/<slug>.json, plus registry registration), so ok:true means a loadable file.
// The loader keys domain types by slug@version from file CONTENT (src/loader.ts:283) and
// DomainTypeMap.get(slug) returns the highest-version record (src/loader.ts:35-43), so an
// in-place overwrite carrying version 2 resolves with today's loader — no @v filename, no new
// infrastructure.
//
// These laws call the REAL dispatchTool handlers against a real temp genome_dir. The AC1/AC3/
// ledger laws are RED on unmodified main (c203968) — their failure output IS the reproduction
// of the defect. The AC4/AC5 laws are GREEN baselines that pin the working door (type_register)
// and the "no unresolvable @v file" invariant so the fix cannot regress either.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { loadGenome } from "../src/loader.js";

// The change-request's motivating type: change-context, whose own law I10 (PR #424) needs an
// added optional field. We reproduce the exact shape — an optional field the extend must
// materialize — without touching the repo's real domain_types/change-context.json.
const BASE_SLUG = "change-context";
const NEW_FIELD = "index_revision";

function makeDeps(genome_dir: string): ServerDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), genome_dir };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "type-extend-persist-"));
}

// Seed the base type through the REAL, working door (type_register) — it persists a loadable
// domain_types/<slug>.json AND registers the type so type_extend can resolve its base.
async function registerBase(deps: ServerDeps, slug: string = BASE_SLUG): Promise<void> {
  const res = await dispatchTool(
    "type_register",
    {
      slug,
      extends: "Judgment",
      domain: "eirtests",
      schema: { type: "object", properties: { note: { type: "string" } } },
      required_fields: ["note"],
    },
    deps,
  );
  expect(res.ok, `precondition — type_register("${slug}") failed: ${res.error}`).toBe(true);
}

async function extendWithField(deps: ServerDeps): Promise<{ ok: boolean; new_version: number | undefined; error: string | undefined }> {
  const res = await dispatchTool(
    "type_extend",
    { slug: BASE_SLUG, fields_to_add: { [NEW_FIELD]: { type: "string" } }, reason: "PR #424 law I10 needs it" },
    deps,
  );
  return { ok: res.ok, new_version: (res.data as { new_version?: number } | undefined)?.new_version, error: res.error };
}

// Ledger entries are a union; genome_mutation rows carry `event`/`subject_slug`, others don't.
// Read as loose rows (the idiom in tests/ledger_event_records.test.ts) to inspect them.
function mutationRows(deps: ServerDeps): Array<Record<string, unknown>> {
  return deps.ledger.query({}) as unknown as Array<Record<string, unknown>>;
}

describe("type_extend — an ok:true result must mean the extended definition is materialized and loadable", () => {
  // ── AC1 (RED) ────────────────────────────────────────────────────────────────
  // The added field is LOADABLE — a fresh genome load resolves the type with the new field.
  // Asserts the observable fact (loader resolution), not the return value.
  it("AC1/RED: after ok:true, a fresh loadGenome resolves the type with the new field at the bumped version", async () => {
    const dir = freshDir();
    try {
      const deps = makeDeps(dir);
      await registerBase(deps);

      const ext = await extendWithField(deps);
      expect(ext.ok, `type_extend failed: ${ext.error}`).toBe(true);

      const genome = loadGenome(dir);
      const resolved = genome.domain_types.get(BASE_SLUG);
      expect(resolved, `fresh load could not resolve "${BASE_SLUG}" at all`).toBeDefined();
      expect(
        resolved!.version,
        `fresh load resolves version ${resolved?.version}, but type_extend returned new_version=${ext.new_version}`,
      ).toBe(ext.new_version);
      const props = ((resolved!.schema as { properties?: Record<string, unknown> }).properties) ?? {};
      expect(
        props[NEW_FIELD],
        `fresh load resolved "${BASE_SLUG}" WITHOUT the added field "${NEW_FIELD}" — ok:true/new_version:${ext.new_version} named a version nothing wrote`,
      ).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── AC3 (RED) — observe the CURRENT defect, paste the failure ──────────────────
  // After ok:true, reading domain_types/<slug>.json directly from disk shows the added field.
  it("AC3/RED: after ok:true, domain_types/<slug>.json on disk carries the bumped version and the added field", async () => {
    const dir = freshDir();
    try {
      const deps = makeDeps(dir);
      await registerBase(deps);

      const ext = await extendWithField(deps);
      expect(ext.ok, `type_extend failed: ${ext.error}`).toBe(true);

      const path = join(dir, "domain_types", `${BASE_SLUG}.json`);
      expect(existsSync(path), `no file at ${path} though ok:true was returned`).toBe(true);
      const rec = JSON.parse(readFileSync(path, "utf-8")) as {
        version?: number;
        schema?: { properties?: Record<string, unknown> };
      };
      expect(
        rec.version,
        `on disk version=${rec.version}, but type_extend returned new_version=${ext.new_version} — the caller was told a version that is not on disk`,
      ).toBe(ext.new_version);
      expect(
        rec.schema?.properties?.[NEW_FIELD],
        `field "${NEW_FIELD}" ABSENT on disk though ok:true/new_version:${ext.new_version} was returned — the mutation was acknowledged, never performed`,
      ).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── AC2 / ledger integrity (RED) ───────────────────────────────────────────────
  // The ledger MUST NOT assert what the genome does not hold: every genome_mutation row sealed
  // by type_extend must correspond to a file loadable at the version the row claims.
  it("AC2/ledger/RED: a genome_mutation row sealed by type_extend must resolve to a loadable file at the claimed version", async () => {
    const dir = freshDir();
    try {
      const deps = makeDeps(dir);
      await registerBase(deps);

      const before = mutationRows(deps).filter((r) => r["event"] === "type_extend").length;
      const ext = await extendWithField(deps);
      expect(ext.ok, `type_extend failed: ${ext.error}`).toBe(true);

      const rows = mutationRows(deps).filter((r) => r["event"] === "type_extend");
      // Persist branch: a genome_mutation row WAS sealed for this extension. (Were refusal
      // chosen instead, no row would be sealed and this law would not apply — but persist is
      // the chosen direction, so a row exists and it must be truthful.)
      expect(rows.length, "no type_extend genome_mutation row was sealed").toBeGreaterThan(before);
      const row = rows[rows.length - 1] as Record<string, unknown>;
      expect(row["kind"], "the sealed row is not kind:genome_mutation").toBe("genome_mutation");

      // The version the ledger claims exists (parsed from subject_slug "<slug>@vN", else the
      // returned new_version).
      const claimed = /@v(\d+)$/.exec(String(row["subject_slug"]))?.[1];
      const claimedVersion = claimed ? Number(claimed) : ext.new_version;

      const resolved = loadGenome(dir).domain_types.get(BASE_SLUG);
      expect(
        resolved?.version,
        `ledger sealed genome_mutation subject "${String(row["subject_slug"])}" claiming version ${claimedVersion}, but a fresh load resolves version ${resolved?.version} — the ledger asserts what the genome does not hold`,
      ).toBe(claimedVersion);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── AC4 (GUARD, green) ─────────────────────────────────────────────────────────
  // type_register already persists a loadable file; this pins the working door so the fix
  // cannot regress it. Green before AND after.
  it("AC4/GUARD: type_register persists a loadable domain_types/<slug>.json and a fresh load resolves it", async () => {
    const dir = freshDir();
    try {
      const deps = makeDeps(dir);
      await registerBase(deps, "regression-door");

      const path = join(dir, "domain_types", "regression-door.json");
      expect(existsSync(path), "type_register wrote no file — the working door regressed").toBe(true);
      const rec = JSON.parse(readFileSync(path, "utf-8")) as {
        slug?: string;
        schema?: { properties?: Record<string, unknown> };
      };
      expect(rec.slug).toBe("regression-door");
      expect(rec.schema?.properties?.note, "type_register dropped the registered field").toBeDefined();

      const resolved = loadGenome(dir).domain_types.get("regression-door");
      expect(resolved, "fresh load could not resolve the type_register'd type").toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── AC5 (GUARD, green) ─────────────────────────────────────────────────────────
  // The persist path must introduce NO @v filename. An unresolvable domain_types/<slug>@v2.json
  // is the same defect wearing a version number; the fix overwrites <slug>.json in place, whose
  // resolution AC1 already proves.
  it("AC5/GUARD: the persist path introduces no unresolvable @v filename in domain_types/", async () => {
    const dir = freshDir();
    try {
      const deps = makeDeps(dir);
      await registerBase(deps);
      const ext = await extendWithField(deps);
      expect(ext.ok, `type_extend failed: ${ext.error}`).toBe(true);

      const files = readdirSync(join(dir, "domain_types")).filter((f) => f.endsWith(".json"));
      const versioned = files.filter((f) => f.includes("@"));
      expect(
        versioned,
        `an @v filename is the same defect wearing a version number: ${versioned.join(", ")}`,
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
