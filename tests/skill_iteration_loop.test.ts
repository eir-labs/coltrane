// The skill iteration loop: browse → inspect → execute → evolve → promote.
//
// Before this the surface was define + promote. A skill could be created and given production
// status, and never RUN, TESTED, LISTED or REVISED through the engine. Adding the fixture gate
// to promotion made that gap sharper rather than better: a skill could be refused for failing
// fixtures with no supported way to run them and find out which.
//
// `evolveSkill` — candidate code into a throwaway copy, run against the CURRENT fixtures,
// accept only on a clean pass — has been implemented since before the open-source split and
// had no caller anywhere. That is the fourth gate in this release found built and unwired.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry, createOutputStore, MemoryLedger } from "../src/index.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "skill-loop-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const DOUBLER = "export async function run(i){ return { n: i.n * 2 }; }";

function pkg(opts: { slug: string; code?: string | null; fixtures?: Array<Record<string, unknown>>; domain?: string }): Record<string, unknown> {
  const dir = join(root, opts.slug);
  mkdirSync(dir, { recursive: true });
  const meta = {
    slug: opts.slug, version: 1, skill_type: "deterministic",
    input_type: "note", output_type: "note", domain: opts.domain ?? "demo",
    permission: { tier: 0 }, description: "d", determinism_ratio: 1,
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  if (opts.code !== null) writeFileSync(join(dir, "skill.mjs"), opts.code ?? DOUBLER);
  else writeFileSync(join(dir, "skill.md"), "# reasoning only");
  if (opts.fixtures?.length) {
    mkdirSync(join(dir, "fixtures"), { recursive: true });
    opts.fixtures.forEach((fx, i) =>
      writeFileSync(join(dir, "fixtures", `fixture-${String(i + 1).padStart(3, "0")}.json`), JSON.stringify(fx)));
  }
  return { ...meta, package_dir: dir, code_hash: opts.code === null ? null : "sha256:stub" };
}

function deps(...skills: Record<string, unknown>[]): ServerDeps {
  const registry = createRegistry();
  return {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    skills: new Map(skills.map((k) => [String(k["slug"]), k])),
    genome_dir: root,
  } as unknown as ServerDeps;
}

const FX = [
  { id: "two", input: { n: 2 }, expected_output: { n: 4 } },
  { id: "three", input: { n: 3 }, expected_output: { n: 6 } },
];

describe("skill_browse — you can see what exists", () => {
  it("lists skills with the axis that decides promotability", async () => {
    const d = deps(pkg({ slug: "coder", fixtures: FX }), pkg({ slug: "thinker", code: null }));
    const r = await dispatchTool("skill_browse", {}, d);
    expect(r.ok, r.error).toBe(true);
    const { skills, count } = r.data as { skills: Array<{ slug: string; has_code: boolean }>; count: number };
    expect(count).toBe(2);
    expect(skills.find((s) => s.slug === "coder")!.has_code).toBe(true);
    expect(skills.find((s) => s.slug === "thinker")!.has_code).toBe(false);
  });

  it("filters by has_code — the axis the promotion gate turns on", async () => {
    const d = deps(pkg({ slug: "coder", fixtures: FX }), pkg({ slug: "thinker", code: null }));
    const r = await dispatchTool("skill_browse", { has_code: true }, d);
    expect((r.data as { skills: Array<{ slug: string }> }).skills.map((s) => s.slug)).toEqual(["coder"]);
  });
});

describe("skill_inspect — you can see why a skill will or will not promote", () => {
  it("reports fixture count and promotability", async () => {
    const d = deps(pkg({ slug: "coder", fixtures: FX }));
    const r = await dispatchTool("skill_inspect", { slug: "coder" }, d);
    const got = r.data as { fixture_count: number; promotable: boolean; fixtures: Array<{ id: string; has_expected: boolean }> };
    expect(got.fixture_count).toBe(2);
    expect(got.promotable).toBe(true);
    expect(got.fixtures.map((f) => f.id)).toEqual(["two", "three"]);
  });

  it("says a code skill with no fixtures is NOT promotable, before anyone tries", async () => {
    const d = deps(pkg({ slug: "untested" }));
    expect((( await dispatchTool("skill_inspect", { slug: "untested" }, d)).data as { promotable: boolean }).promotable).toBe(false);
  });

  it("does not hand back expected outputs — a fixture's answer key is not inspection", async () => {
    const d = deps(pkg({ slug: "coder", fixtures: FX }));
    const r = await dispatchTool("skill_inspect", { slug: "coder" }, d);
    const fx = (r.data as { fixtures: Array<Record<string, unknown>> }).fixtures[0]!;
    expect(fx["has_expected"]).toBe(true);
    expect(fx["expected_output"], "reporting it would make the fixtures self-answering").toBeUndefined();
  });
});

describe("skill_execute — you can actually run one", () => {
  it("runs a skill against caller input", async () => {
    const d = deps(pkg({ slug: "coder", fixtures: FX }));
    const r = await dispatchTool("skill_execute", { slug: "coder", input: { n: 21 } }, d);
    expect(r.ok, r.error).toBe(true);
    expect((r.data as { output: { n: number } }).output.n).toBe(42);
  });

  it("a skill that throws is a RESULT, not a failed tool call", async () => {
    // The call succeeded; its answer is "the code errored". Collapsing the two loses the
    // distinction a caller needs to tell a broken skill from a broken invocation.
    const d = deps(pkg({ slug: "boom", code: "export async function run(){ throw new Error('nope'); }", fixtures: FX }));
    const r = await dispatchTool("skill_execute", { slug: "boom", input: {} }, d);
    expect(r.ok, "the tool call itself worked").toBe(true);
    expect((r.data as { ok: boolean; error?: string }).ok).toBe(false);
    expect(String((r.data as { error?: string }).error)).toMatch(/nope/);
  });

  it("mode:test runs the fixtures and says what promotion would decide", async () => {
    // The command that makes the promotion gate actionable.
    const d = deps(pkg({ slug: "coder", fixtures: FX }));
    const r = await dispatchTool("skill_execute", { slug: "coder", mode: "test" }, d);
    const got = r.data as { passed: number; total: number; threshold: number; would_promote: boolean };
    expect(got.passed).toBe(2);
    expect(got.threshold, "a deterministic skill is held to all of them").toBe(1);
    expect(got.would_promote).toBe(true);
  });

  it("mode:test on a failing skill names the failures and says it would NOT promote", async () => {
    const d = deps(pkg({ slug: "wrong", code: "export async function run(i){ return { n: i.n + 1 }; }", fixtures: FX }));
    const r = await dispatchTool("skill_execute", { slug: "wrong", mode: "test" }, d);
    const got = r.data as { would_promote: boolean; results: Array<{ id: string; passed: boolean }> };
    expect(got.would_promote).toBe(false);
    expect(got.results.filter((x) => !x.passed).map((x) => x.id)).toEqual(["two", "three"]);
  });

  it("refuses a reasoning-only skill — there is nothing to execute", async () => {
    const d = deps(pkg({ slug: "thinker", code: null }));
    const r = await dispatchTool("skill_execute", { slug: "thinker", input: {} }, d);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/no code half/);
  });
});

describe("skill_evolve — a skill cannot regress through this door", () => {
  it("ACCEPTS a candidate that still passes the fixtures, and bumps the version", async () => {
    const sk = pkg({ slug: "coder", fixtures: FX });
    const d = deps(sk);
    const better = "export async function run(i){ const n = i.n; return { n: n + n }; }"; // same answers
    const r = await dispatchTool("skill_evolve", { slug: "coder", code: better, reason: "clearer" }, d);
    expect(r.ok, r.error).toBe(true);
    expect((r.data as { accepted: boolean; new_version: number }).new_version).toBe(2);
    expect(readFileSync(join(root, "coder", "skill.mjs"), "utf8"), "accepted code must land").toBe(better);
  });

  it("REJECTS a candidate that breaks a fixture, and writes NOTHING", async () => {
    const sk = pkg({ slug: "coder", fixtures: FX });
    const d = deps(sk);
    const worse = "export async function run(i){ return { n: i.n + 1 }; }";
    const r = await dispatchTool("skill_evolve", { slug: "coder", code: worse }, d);
    expect(r.ok).toBe(false);
    expect((r.data as { failing_fixtures: string[] }).failing_fixtures.sort()).toEqual(["three", "two"]);
    expect(
      readFileSync(join(root, "coder", "skill.mjs"), "utf8"),
      "a rejected candidate must not touch the package — this is the whole guarantee",
    ).toBe(DOUBLER);
  });

  it("refuses to evolve a skill with no fixtures — there is nothing to hold it to", async () => {
    const d = deps(pkg({ slug: "untested" }));
    const r = await dispatchTool("skill_evolve", { slug: "untested", code: DOUBLER }, d);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/no fixtures/);
  });

  it("records the evolution, with the reason", async () => {
    const d = deps(pkg({ slug: "coder", fixtures: FX }));
    await dispatchTool("skill_evolve", { slug: "coder", code: DOUBLER, reason: "no-op rewrite" }, d);
    const rows = d.ledger.query({ kind: "genome_mutation", event: "skill_evolve" });
    expect(rows.length).toBe(1);
    expect((rows[0] as unknown as { detail?: { reason?: string } }).detail?.reason).toBe("no-op rewrite");
  });
});

describe("the loop closes", () => {
  it("browse → inspect → test → evolve → promote", async () => {
    const sk = pkg({ slug: "coder", fixtures: FX });
    const d = deps(sk);

    expect((( await dispatchTool("skill_browse", { has_code: true }, d)).data as { count: number }).count).toBe(1);
    expect((( await dispatchTool("skill_inspect", { slug: "coder" }, d)).data as { promotable: boolean }).promotable).toBe(true);
    expect((( await dispatchTool("skill_execute", { slug: "coder", mode: "test" }, d)).data as { would_promote: boolean }).would_promote).toBe(true);

    const ev = await dispatchTool("skill_evolve", { slug: "coder", code: "export async function run(i){ return { n: 2 * i.n }; }" }, d);
    expect(ev.ok, ev.error).toBe(true);

    const pr = await dispatchTool("skill_promote", { slug: "coder", status: "active" }, d);
    expect(pr.ok, pr.error).toBe(true);
    expect((pr.data as { fixture_report: { passed: number } }).fixture_report.passed).toBe(2);
  });
});
