// THE BASE IS IN THE TREE — a change-set names the commit it is measured from, and the tree holds it.
//
// WHY (3 Oct 2026, spec.order-lifecycle.transition-law R27: the receipts of DELIVERED work). A
// change-set is recorded by address: {path, base}, and the engine stamps patch_sha256 from
// `git diff <base> -- <path>` in the gig's tree. The drain clones that tree `--depth 1`, so a base
// that is not HEAD is not in it, and the first change-set written against a delivered commit's
// parent died inside git with no name for what was missing. Two things were wrong at once:
//
//   1. The request could not say which base it meant. `change-request` carries `repository` and
//      `change_set_branch`; it carried no base. Added: `change_set_base` — the commit the change-set
//      is measured from, CARRIED, never inferred from the tree.
//   2. Even named, nothing fetched it. prepareWorkspace now fetches the named base into the shallow
//      clone while the gig's credential is in hand (`git fetch --depth=1 origin <base>`), and
//      stampChangeAddresses refuses by name — `base_not_in_tree` — when a base is absent, instead
//      of surfacing git's own failure.
//
// And one more, found reading the path: resolveWorkingRepo read `repository` only at the top of the
// input, while a dispatched gig's input is keyed by type slug ({"change-request": {...}}) — the
// hosted dispatch refuses a bare payload as MissingGigInput. So the typed field the fix was built
// on was never reached for a real dispatch. Both resolvers now read the top level and one level
// down, first match.
//
// RED first: every law below was observed failing before the change (no field, no resolver, a raw
// git error instead of base_not_in_tree, no fetch).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkingRepo, resolveChangeSetBase, isSafeGitRev } from "../src/run_deps.js";
import { stampChangeAddresses, RuntimeError } from "../src/runtime.js";
import { cloneInto } from "../src/workspace.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString().trim();
}

/** An origin with two commits; a `--depth 1` clone of it holds only the second. */
function originWithTwoCommits(): { origin: string; first: string; second: string } {
  const origin = mkdtempSync(join(tmpdir(), "base-origin-"));
  git(origin, "init", "-q", "-b", "main");
  mkdirSync(join(origin, "src"));
  writeFileSync(join(origin, "src", "a.txt"), "one\n");
  git(origin, "add", "."); git(origin, "commit", "-q", "-m", "first");
  const first = git(origin, "rev-parse", "HEAD");
  writeFileSync(join(origin, "src", "a.txt"), "one\ntwo\n");
  git(origin, "commit", "-q", "-am", "second");
  const second = git(origin, "rev-parse", "HEAD");
  return { origin, first, second };
}

describe("the base is in the tree", () => {
  it("law 1 — change-request carries change_set_base: the commit the change-set is measured from", () => {
    const t = JSON.parse(readFileSync(new URL("../domain_types/change-request.json", import.meta.url), "utf8"));
    expect(t.schema.properties.change_set_base?.type).toBe("string");
    expect(t.required_fields, "optional and additive, like change_set_branch").not.toContain("change_set_base");
  });

  it("law 2 — resolveWorkingRepo reads repository at the top of the input AND one level down (a gig's input is keyed by type slug)", () => {
    const top = resolveWorkingRepo({ input: { repository: "https://github.com/eir-labs/top" } });
    const keyed = resolveWorkingRepo({ input: { "change-request": { repository: "https://github.com/eir-labs/keyed", request_text: "x" } } });
    const neither = resolveWorkingRepo({ input: { "change-request": { request_text: "x" } }, repo_url: "https://github.com/eir-labs/org" });
    expect(top).toBe("https://github.com/eir-labs/top");
    expect(keyed).toBe("https://github.com/eir-labs/keyed");
    expect(neither, "the org default still answers when neither level names one").toBe("https://github.com/eir-labs/org");
    expect(resolveWorkingRepo({ input: { "change-request": { repository: 42 } } }), "a number one level down is not a repo").toBeNull();
  });

  it("law 3 — resolveChangeSetBase reads change_set_base the same two ways, trims, and answers null for anything but a non-empty string", () => {
    expect(resolveChangeSetBase({ input: { change_set_base: " b330313 " } })).toBe("b330313");
    expect(resolveChangeSetBase({ input: { "change-request": { change_set_base: "b330313" } } })).toBe("b330313");
    expect(resolveChangeSetBase({ input: { "change-request": { change_set_base: "" } } })).toBeNull();
    expect(resolveChangeSetBase({ input: { "change-request": { change_set_base: 7 } } })).toBeNull();
    expect(resolveChangeSetBase({ input: {} })).toBeNull();
  });

  it("law 4 — a base the shallow tree does not hold is refused BY NAME (base_not_in_tree), never as a raw git failure", () => {
    const { origin, first } = originWithTwoCommits();
    const shallow = mkdtempSync(join(tmpdir(), "base-shallow-"));
    git(shallow, "clone", "-q", "--depth", "1", `file://${origin}`, ".");
    let err: unknown;
    try { stampChangeAddresses([{ path: "src/a.txt", base: first }], shallow); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RuntimeError);
    expect(String((err as Error).message)).toMatch(/^base_not_in_tree: /);
    expect(String((err as Error).message)).toContain(first);
    expect(String((err as Error).message)).toMatch(/change_set_base/);
  });

  it("law 5 — once the base is fetched into the shallow tree, the same change stamps: the diff is the delivered change, the blob sha the file's", () => {
    const { origin, first } = originWithTwoCommits();
    const shallow = mkdtempSync(join(tmpdir(), "base-shallow-"));
    git(shallow, "clone", "-q", "--depth", "1", `file://${origin}`, ".");
    git(shallow, "fetch", "-q", "--depth=1", "origin", first);
    const c = stampChangeAddresses([{ path: "src/a.txt", base: first }], shallow)[0]!;
    expect(c.bytes).toBeGreaterThan(0);
    expect(c.patch_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.blob_sha).toBe(git(shallow, "hash-object", "src/a.txt"));
  });

  it("law 7 — a base is a revision, never an option: a value git could read as an option is refused by name before git sees it, in the clone and at the seal (the grade's F1)", () => {
    const { origin, first } = originWithTwoCommits();
    for (const bad of ["--depth=999999", "--upload-pack=echo", "-x", "a b", "main..HEAD", "", " "]) {
      expect(isSafeGitRev(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const ok of [first, first.slice(0, 7), "main", "v1.2.3", "HEAD~3", "release/2026-10"]) {
      expect(isSafeGitRev(ok), ok).toBe(true);
    }
    // the clone: refused before any fetch, dir cleaned, still a clone of nothing
    let err: unknown;
    try { cloneInto(`file://${origin}`, "unused-token", undefined, "--depth=999999"); } catch (e) { err = e; }
    expect(String((err as Error).message)).toMatch(/^bad_base: /);
    // the seal: refused before cat-file
    const shallow = mkdtempSync(join(tmpdir(), "base-shallow-"));
    git(shallow, "clone", "-q", "--depth", "1", `file://${origin}`, ".");
    let err2: unknown;
    try { stampChangeAddresses([{ path: "src/a.txt", base: "--batch" }], shallow); } catch (e) { err2 = e; }
    expect(err2).toBeInstanceOf(RuntimeError);
    expect(String((err2 as Error).message)).toMatch(/^bad_base: /);
    // and a lawful fetch still passes --end-of-options: the clone stays shallow with the base present
    const ws = cloneInto(`file://${origin}`, "unused-token", undefined, first);
    try { expect(git(ws.dir, "rev-parse", "--is-shallow-repository")).toBe("true"); } finally { ws.cleanup(); }
  });

  it("law 8 — the room-realization path threads the base exactly as the drain's does: realize()'s prepare receives it from the run (the grade's F2)", () => {
    const realizer = readFileSync(new URL("../src/venue_realizer.ts", import.meta.url), "utf8");
    const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(realizer).toMatch(/changeSetBase\?: string \| null;/);
    expect(realizer).toMatch(/base: opts\.changeSetBase \?\? null,/);
    expect(worker).toMatch(/changeSetBase: claim\.venue \? resolveChangeSetBase\(claim\)/);
    const runDeps = readFileSync(new URL("../src/run_deps.ts", import.meta.url), "utf8");
    const runtime = readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8");
    expect(runDeps).toMatch(/changeSetBase: args\.changeSetBase/);
    expect(runtime).toMatch(/changeSetBase: deps\.changeSetBase/);
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(server, "the server door threads the base beside the repository, as the drain does (F2b)").toMatch(/changeSetBase: resolveChangeSetBase\(\{ input: gigInput \}\)/);
    expect(worker).toMatch(/base: resolveChangeSetBase\(claim\),/);
  });

  it("law 6 — cloneInto with a base fetches it while the credential is in hand: the clone is shallow and still holds the base; a base the origin does not have is refused by name", () => {
    const { origin, first, second } = originWithTwoCommits();
    const ws = cloneInto(`file://${origin}`, "unused-token", undefined, first);
    try {
      expect(git(ws.dir, "rev-parse", "HEAD")).toBe(second);
      expect(git(ws.dir, "cat-file", "-t", first)).toBe("commit");
      expect(git(ws.dir, "rev-parse", "--is-shallow-repository")).toBe("true");
    } finally { ws.cleanup(); }
    let err: unknown;
    try { cloneInto(`file://${origin}`, "unused-token", undefined, "0000000000000000000000000000000000000000"); } catch (e) { err = e; }
    expect(String((err as Error).message)).toMatch(/base_not_in_origin: /);
  });
});
