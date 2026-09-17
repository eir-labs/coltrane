// RED — the address stamp is REACHED: a real gig seals a stamped record, not only an exported helper.
//
// tests/spec_records_by_address.test.ts pins the stamping mechanism by calling
// stampLawAddresses / stampChangeAddresses directly. Every one of those laws goes green on a build
// that exports the helpers and never calls them from the seal path, and the attester would go on
// typing patches. This file is the join: runGig with RunDeps.tree_root seals a red-spec whose laws
// carry the engine's blob_sha and tests, seals a change-set whose changes carry the engine's
// patch_sha256 and bytes, and refuses an unresolvable address before anything is sealed.
// (Conducting-session amendment to the drafted slice, 2026-09-17; the review seat passed the draft
// because it checks that each contract item has a law, not that the law goes through a door.)
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore, MemoryLedger, runGig, type AgentInvoker, type Standard } from "../src";
import { testAgent } from "./_support/agents.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const genome = loadGenome(REPO_ROOT);
const types = [...genome.domain_types.values()];

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (repo: string, args: string[]): string => execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV }).toString();
function repoWith(files: Record<string, string>): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), "coltrane-seal-stamp-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "fixture"]);
  return { dir, commit: git(dir, ["rev-parse", "HEAD"]).trim() };
}

const LAW = `import { it, expect } from "vitest";\nit("the first law", () => { expect(1).toBe(1); });\nit("the second law", () => { expect(2).toBe(2); });\n`;

function oneChair(output: "red-spec" | "change-set"): Standard {
  const seat = testAgent({ slug: "sealer", primitives: ["CREATE"], input_types: [], output_types: [output], domain: "software" });
  return {
    slug: `stamp-${output}`, domain: "software", agents: [seat],
    phases: [{ name: "seal", chairs: [{ role: "seal", agent_slug: "sealer", depends_on: [], input_contract: [], output_contract: [output], required_skills: [] }] }],
  } as unknown as Standard;
}

async function run(output: "red-spec" | "change-set", data: Record<string, unknown>, tree_root: string) {
  const outputs = createOutputStore(createRegistry(types as never));
  const invoke: AgentInvoker = () => data;
  let error: unknown;
  try {
    await runGig(oneChair(output), {}, { outputs, ledger: new MemoryLedger(), invoke, tree_root } as never);
  } catch (e) {
    error = e;
  }
  const sealed = outputs.all().find((o) => o.domain_type === output);
  return { error, sealed };
}

describe("a gig seals records stamped by the engine", () => {
  it("a red-spec sealed through runGig carries the blob_sha and test titles git holds, from RunDeps.tree_root", async () => {
    const { dir, commit } = repoWith({ "tests/x.test.ts": LAW });
    try {
      const { error, sealed } = await run("red-spec", {
        validation_criteria: ["every invariant has a failing test"], input_refs: ["contract-x"],
        laws: [{ path: "tests/x.test.ts", commit }],
        coverage_map: [{ invariant_id: "I1", test_name: "the first law", test_file: "tests/x.test.ts" }],
        testing_method: "vitest",
      }, dir);
      expect(sealed, `the seal path refused or never sealed an address-shaped red-spec: ${String((error as Error)?.message ?? error).slice(0, 300)}`).toBeDefined();
      const law = ((sealed!.data as { laws?: Array<Record<string, unknown>> }).laws ?? [])[0];
      expect(law?.["blob_sha"], "the red-spec was sealed without the engine stamping it: the helper exists but the seal never calls it")
        .toBe(git(dir, ["rev-parse", `${commit}:tests/x.test.ts`]).trim());
      expect(law?.["tests"]).toEqual(["the first law", "the second law"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a change-set sealed through runGig carries the patch_sha256 and bytes of `git diff <base> -- <path>` in tree_root", async () => {
    const { dir, commit } = repoWith({ "src/f.ts": "export const a = 1;\n" });
    try {
      writeFileSync(join(dir, "src/f.ts"), "export const a = 2;\n");
      const diff = git(dir, ["diff", commit, "--", "src/f.ts"]);
      const { error, sealed } = await run("change-set", {
        validation_criteria: ["the laws ran green"], input_refs: ["red-spec-x"],
        changes: [{ path: "src/f.ts", base: commit }],
        rationale: ["a one-line change"],
      }, dir);
      expect(sealed, `the seal path refused or never sealed an address-shaped change-set: ${String((error as Error)?.message ?? error).slice(0, 300)}`).toBeDefined();
      const change = ((sealed!.data as { changes?: Array<Record<string, unknown>> }).changes ?? [])[0];
      expect(change?.["patch_sha256"], "the change-set was sealed without the engine stamping it")
        .toBe(createHash("sha256").update(diff, "utf8").digest("hex"));
      expect(change?.["bytes"]).toBe(diff.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unresolvable law address fails the chair with law_record_unresolvable, and nothing is sealed", async () => {
    const { dir, commit } = repoWith({ "tests/x.test.ts": LAW });
    try {
      const { error, sealed } = await run("red-spec", {
        validation_criteria: ["x"], input_refs: ["y"],
        laws: [{ path: "tests/nope.test.ts", commit }],
        coverage_map: [{ invariant_id: "I1", test_name: "t", test_file: "tests/nope.test.ts" }],
        testing_method: "vitest",
      }, dir);
      expect(String((error as Error)?.message ?? error), "the chair did not fail with the typed refusal naming the address").toMatch(/law_record_unresolvable[\s\S]*tests\/nope\.test\.ts/);
      expect(sealed, "a red-spec naming a law git does not hold was sealed").toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
