// Promotion to `active` is where a skill acquires production status. Until now it checked that
// the skill's METADATA parsed and nothing else — a code half that failed every one of its own
// fixtures promoted cleanly, because nothing ran them.
//
// `runSkillFixtures` has been in the tree the whole time, and it is good: it executes each
// fixture N times, checks expected output and assertions, and checks that the runs AGREE. It
// simply had no caller outside the test suite. A real gate with nothing invoking it is the same
// shape as the capability gate closed earlier in this release, and the same shape as
// `exposedTools`. This lineage produces that defect repeatedly.
//
// The pre-open-source engine enforced exactly this at skill_evolve and skill_promote and
// refused the write on failure. The threshold rule is restored from it:
//
//     deterministic  → every fixture must pass
//     otherwise      → at least 80% must pass
//
// Keyed off MEASURED determinism rather than the declared `determinism_ratio`, so claiming
// determinism costs something. A skill that says it is deterministic and is held to 100% has
// made a real commitment; one that merely declares a number has not.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry, createOutputStore, MemoryLedger } from "../src/index.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "promote-gate-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A skill package on disk, plus the loader-shaped record the server holds. */
function skill(opts: {
  slug: string;
  code?: string | null;
  fixtures?: Array<{ id: string; input: unknown; expected_output?: unknown }>;
}): Record<string, unknown> {
  const dir = join(root, opts.slug);
  mkdirSync(dir, { recursive: true });
  const meta = {
    slug: opts.slug, version: 1, skill_type: "deterministic",
    input_type: "note", output_type: "note",
    permission: { tier: 0 }, description: "d", determinism_ratio: 1,
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  if (opts.code !== null) writeFileSync(join(dir, "skill.mjs"), opts.code ?? "export async function run(i){ return { n: i.n * 2 }; }");
  else writeFileSync(join(dir, "skill.md"), "# a reasoning-only skill");
  if (opts.fixtures?.length) {
    mkdirSync(join(dir, "fixtures"), { recursive: true });
    opts.fixtures.forEach((fx, i) =>
      writeFileSync(join(dir, "fixtures", `fixture-${String(i + 1).padStart(3, "0")}.json`), JSON.stringify(fx)));
  }
  return { ...meta, package_dir: dir, code_hash: opts.code === null ? null : "sha256:stub" };
}

function deps(sk: Record<string, unknown>): ServerDeps {
  const registry = createRegistry();
  return {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    skills: new Map([[String(sk["slug"]), sk]]),
  } as unknown as ServerDeps;
}

const promote = (d: ServerDeps, slug: string, status = "active") =>
  dispatchTool("skill_promote", { slug, status }, d);

describe("a skill must pass its own fixtures to become active", () => {
  it("promotes a skill whose fixtures pass", async () => {
    const sk = skill({ slug: "doubler", fixtures: [
      { id: "two", input: { n: 2 }, expected_output: { n: 4 } },
      { id: "three", input: { n: 3 }, expected_output: { n: 6 } },
    ]});
    const r = await promote(deps(sk), "doubler");
    expect(r.ok, r.error).toBe(true);
    const rep = (r.data as { fixture_report: { passed: number; total: number } }).fixture_report;
    expect(rep.passed).toBe(2);
    expect(rep.total).toBe(2);
  });

  it("REFUSES a skill whose code fails a fixture", async () => {
    // The defect: this promoted cleanly before, because only the metadata was checked.
    const sk = skill({
      slug: "broken",
      code: "export async function run(i){ return { n: i.n + 1 }; }", // should double
      fixtures: [
        { id: "two", input: { n: 2 }, expected_output: { n: 4 } },
        { id: "three", input: { n: 3 }, expected_output: { n: 6 } },
      ],
    });
    const r = await promote(deps(sk), "broken");
    expect(r.ok, "a skill that fails its own fixtures must not reach active").toBe(false);
    expect(String(r.error)).toMatch(/0\/2|fixtures/);
    expect(String(r.error), "and it must name which ones failed").toMatch(/two|three/);
  });

  it("REFUSES a code skill that carries no fixtures at all", async () => {
    // Silence must not be a pass. A code half nobody can test is exactly the thing that should
    // not hold production status, and allowing it would make the gate opt-out by omission.
    const sk = skill({ slug: "untested" });
    const r = await promote(deps(sk), "untested");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/no fixtures|nothing establishes/);
  });

  it("holds a DETERMINISTIC skill to every fixture — 80% is not enough", async () => {
    const sk = skill({ slug: "mostly", fixtures: [
      { id: "a", input: { n: 1 }, expected_output: { n: 2 } },
      { id: "b", input: { n: 2 }, expected_output: { n: 4 } },
      { id: "c", input: { n: 3 }, expected_output: { n: 6 } },
      { id: "d", input: { n: 4 }, expected_output: { n: 8 } },
      { id: "e", input: { n: 5 }, expected_output: { n: 99 } }, // 4/5 = 80%
    ]});
    const r = await promote(deps(sk), "mostly");
    expect(r.ok, "a skill whose runs agree is held to all of them").toBe(false);
    expect(String(r.error)).toMatch(/80%.*100%|4\/5/s);
  });

  it("does NOT gate a reasoning-only skill — there is no code to run", async () => {
    // Most skills in a real genome are prompt halves. Demanding fixtures of something with no
    // executable would gate on an impossibility.
    const sk = skill({ slug: "prompt-only", code: null });
    const r = await promote(deps(sk), "prompt-only");
    expect(r.ok, r.error).toBe(true);
    expect((r.data as { fixture_report?: unknown }).fixture_report).toBeUndefined();
  });

  it("does NOT gate promotion to a NON-active status", async () => {
    // draft → testing is how a skill gets somewhere to be worked on. Gating that would mean a
    // skill could never move far enough along to acquire the fixtures the gate wants.
    const sk = skill({ slug: "wip" });
    const r = await dispatchTool("skill_promote", { slug: "wip", status: "testing" }, deps(sk));
    expect(r.ok, r.error).toBe(true);
  });
});

describe("the gate leaves evidence", () => {
  it("records what it passed on, not merely that it passed", async () => {
    const sk = skill({ slug: "doubler", fixtures: [{ id: "two", input: { n: 2 }, expected_output: { n: 4 } }] });
    const d = deps(sk);
    await promote(d, "doubler");
    const row = d.ledger.query({ kind: "governance", event: "skill_promote" })[0] as unknown as
      { detail: Record<string, unknown> };
    const fx = row.detail["fixtures"] as { total: number; passed: number; deterministic: boolean };
    expect(fx, "a promotion that rested on evidence should record it").toBeTruthy();
    expect(fx.total).toBe(1);
    expect(fx.passed).toBe(1);
    expect(fx.deterministic).toBe(true);
  });

  it("writes NOTHING to the ledger when the gate refuses", async () => {
    const sk = skill({ slug: "broken", code: "export async function run(){ return { n: 0 }; }",
      fixtures: [{ id: "a", input: { n: 1 }, expected_output: { n: 2 } }] });
    const d = deps(sk);
    await promote(d, "broken");
    expect(d.ledger.query({ kind: "governance" }).length, "a refused promotion is not a promotion").toBe(0);
  });
});
