// SPLIT 2026-09-17: the src-side stamping laws (I1, I2, I3, O2-deleted, O3, F1, F2, F3) moved,
// byte-identical, to tests/spec_records_stamping.test.ts. What stays here is the genome's shape.

// RECORDS BY ADDRESS — a red-spec carries its laws, and a change-set its changes, BY ADDRESS.
//
// THE MEASURED PROBLEM (seat-briefing census, 2026-09-17). gig c1771b13's attester hit the 32,000
// output-token cap THREE TIMES re-emitting ~150KB of verbatim law patches into `red-spec.diffs`, and
// every downstream seat receives the whole record through JSON.stringify(o.data) (claude_invoker.ts).
// The bytes are the cost. THE CONTRACT (decided by the operator): a seat supplies only WHERE the bytes
// are — {path, commit} for a law, {path, base} for a change — and the ENGINE stamps WHAT they are, from
// git, AT SEAL. No patch body is ever model output or a record field.
//
// These laws are RED by design: the address-stamping mechanism does not exist yet. Each law that needs
// the mechanism LEADS with the assertion that the mechanism is absent, stating the contract's reason —
// so the file COLLECTS (namespace import, no missing-export link error) and fails on the contract, not
// on a TypeError. The seal helpers are the real callsite: they are invoked from executeChair's seal
// loop, beside the *_sha backfill (runtime.ts), exactly as computeAppendCost/workingModel are exported
// seal helpers the runtime calls. See docs/specs/records-by-address.red-spec.md.
//
// Every git call runs in a temporary repository the law creates itself; nothing reads or writes this
// repository's own history.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { createRegistry } from "../src/registry.js";
import { sealDrill } from "../src/seal_drill.js";
import * as runtime from "../src/runtime.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── the not-yet-existing seal-path mechanism, reached reflectively so a missing export is `undefined`
//    (red for the contract's reason via the leading assertion below) rather than an ESM link error. ──
type Law = { path: string; commit: string; blob_sha?: string; tests?: string[] };
type StampLaws = (laws: readonly Law[], tree_root: string | undefined) => Array<Required<Law>>;
type Change = { path: string; base: string; blob_sha?: string; patch_sha256?: string; bytes?: number };
type StampChanges = (changes: readonly Change[], tree_root: string | undefined) => Array<Required<Change>>;
const rt = runtime as unknown as Record<string, unknown>;
function requireFn<T>(name: string, why: string): T {
  const fn = rt[name];
  // THE LEADING, CONTRACT-STATING ASSERTION. Red today because the engine stamps nothing from an
  // address; green once the seal path exports this mechanism. Failing here aborts the `it`, so a
  // later `.toThrow()` can never pass on a spurious "not a function".
  expect(typeof fn, why).toBe("function");
  return fn as T;
}

// ── temp-git-repo helpers (the workspace.test.ts house pattern) ──
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function newRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  return dir;
}
function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV }).toString();
}
function writeIn(repo: string, path: string, content: string): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const lawFile = (titles: string[]): string =>
  `import { it, expect } from "vitest";\n` +
  titles.map((t) => `it(${JSON.stringify(t)}, () => { expect(1).toBe(1); });`).join("\n") + "\n";

const genome = loadGenome(REPO_ROOT);
const registry = createRegistry([...genome.domain_types.values()] as never);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("records by address — the type shape (O1, O2, F4)", () => {
  it("O1 — a red-spec v3 carrying `laws` [{path, commit, blob_sha, tests}] and no `diffs` validates", () => {
    // The seat supplies {path, commit}; the sealed record additionally carries the engine-stamped
    // {blob_sha, tests}. Red today: the type still REQUIRES `diffs`, so a laws-shaped record is refused.
    const data = {
      validation_criteria: ["every invariant has a failing test"],
      input_refs: ["subsystem-contract-x"],
      laws: [{ path: "tests/x.test.ts", commit: "a".repeat(40), blob_sha: "0".repeat(40), tests: ["a law holds"] }],
      // Kept: the review seat's COMPLETENESS check reads coverage_map, and this contract retires
      // `diffs` only. A fixture without it would let the build drop a required field nobody decided to drop.
      coverage_map: [{ invariant_id: "I1", test_name: "a law holds", test_file: "tests/x.test.ts", kind: "behavioural", drives: "f — src/f.ts", plant: "make f return the wrong value" }],
      testing_method: "property-based where universal",
    };
    const v = registry.validate({ core_type: "Artifact", domain_type: "red-spec", data } as never);
    expect(v.valid, `a v3 red-spec (laws, no diffs) was refused by the current type: ${JSON.stringify(v.errors)}`).toBe(true);
  });

  it("O2 — a change-set v2 carrying `changes` [{path, base, blob_sha, patch_sha256, bytes}] and no `diffs` validates", () => {
    const data = {
      validation_criteria: ["ran the laws; red for the contract's reason"],
      input_refs: ["red-spec-x"],
      changes: [{ path: "src/f.ts", base: "b".repeat(40), blob_sha: "0".repeat(40), patch_sha256: "0".repeat(64), bytes: 42 }],
      rationale: ["chose the address mechanism to keep the record small"],
    };
    const v = registry.validate({ core_type: "Artifact", domain_type: "change-set", data } as never);
    expect(v.valid, `a v2 change-set (changes, no diffs) was refused by the current type: ${JSON.stringify(v.errors)}`).toBe(true);
  });

  it("F4 — a retired-shape red-spec (carries `diffs`, no `laws`) is refused, and the refusal names `laws`", () => {
    const data = {
      validation_criteria: ["x"], input_refs: ["y"],
      diffs: [{ path: "tests/x.test.ts", patch: "+a" }],
      coverage_map: [{ invariant_id: "I1", test_name: "t", test_file: "f", kind: "behavioural", drives: "f — src/f.ts", plant: "make f return the wrong value" }],
      testing_method: "m",
    };
    const v = registry.validate({ core_type: "Artifact", domain_type: "red-spec", data } as never);
    expect(v.valid, "a red-spec still in the `diffs` shape was accepted against the current version").toBe(false);
    expect(v.errors.join(" "), "the refusal must name the missing `laws` field").toMatch(/\blaws\b/);
  });

  it("F4 — a retired-shape change-set (carries `diffs`, no `changes`) is refused, and the refusal names `changes`", () => {
    const data = {
      validation_criteria: ["x"], input_refs: ["y"],
      diffs: [{ path: "src/f.ts", patch: "+a" }],
      rationale: ["r"],
    };
    const v = registry.validate({ core_type: "Artifact", domain_type: "change-set", data } as never);
    expect(v.valid, "a change-set still in the `diffs` shape was accepted against the current version").toBe(false);
    expect(v.errors.join(" "), "the refusal must name the missing `changes` field").toMatch(/\bchanges\b/);
  });
});

describe("records by address — the surrounding genome (O4, I4)", () => {
  it("O4 — no agent declaring red-spec or change-set (input_types/output_types) names the retired field `diffs`", () => {
    // A field read that no type declares is the declared-fields defect, inverted: an agent whose method
    // still tells it to fill `diffs` will do B while the type says A. Red today — the attester and
    // builder still name it.
    const agentsDir = join(REPO_ROOT, "agents");
    const touching: string[] = [];
    const offenders: string[] = [];
    for (const f of readdirSync(agentsDir).filter((n) => n.endsWith(".json"))) {
      const a = JSON.parse(readFileSync(join(agentsDir, f), "utf8")) as {
        slug?: string; input_types?: string[]; output_types?: string[]; method?: string; constraints?: string[];
      };
      const types = [...(a.input_types ?? []), ...(a.output_types ?? [])];
      if (!types.includes("red-spec") && !types.includes("change-set")) continue;
      const slug = a.slug ?? f;
      touching.push(slug);
      const text = `${a.method ?? ""}\n${(a.constraints ?? []).join("\n")}`;
      if (/\bdiffs\b/.test(text)) offenders.push(slug);
    }
    expect(touching.length, "no agent declares red-spec/change-set — the O4 scan would be vacuous").toBeGreaterThan(0);
    expect(offenders, "these agents produce/consume red-spec or change-set yet still name the retired field `diffs` in method/constraints").toEqual([]);
  });

  it("I4 — the seal drill finds draft-red-laws-v0 and build-from-red-spec-v0 dispatchable under the address shape", () => {
    // First the shape precondition (red today): stamping is a SEAL step, so the migrated address types
    // must be what the drill validates. Then the regression guard from 30d1b48: the address-shaped
    // types must still stub-seal, or the whole RED-first loop goes undispatchable again.
    const props = (slug: string): string[] =>
      Object.keys(((genome.domain_types.get(slug)?.schema as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {});
    expect(props("red-spec"), "red-spec must carry `laws`").toContain("laws");
    expect(props("red-spec"), "red-spec must have retired `diffs`").not.toContain("diffs");
    expect(props("change-set"), "change-set must carry `changes`").toContain("changes");
    expect(props("change-set"), "change-set must have retired `diffs`").not.toContain("diffs");

    for (const slug of ["draft-red-laws-v0", "build-from-red-spec-v0"]) {
      const std = genome.standards.get(slug) ?? genome.draft_standards.get(slug);
      expect(std, `${slug} not loaded`).toBeDefined();
      const drill = sealDrill(std as never, registry);
      expect(drill.ok, `${slug} is unsealable under the address shape (a stub cannot satisfy it): ${JSON.stringify(drill.failures)}`).toBe(true);
    }
  });
});
