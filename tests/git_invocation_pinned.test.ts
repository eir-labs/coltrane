// EVERY GIT READ THE RUNTIME MAKES IS BUILT IN ONE PLACE, AND IT IS BUILT PINNED.
//
// The runtime reads git inside `tree_root` — a seat's checkout, a drained workspace, someone's
// laptop — and folds what comes back into sealed fields (`blob_sha`, `patch_sha256`, `bytes`,
// a primer's per-file blob). git does not answer such a read from the objects alone: it also
// consults settings belonging to the machine, to the account, and to the directory being read.
// An answer that moves with those is not a claim about the objects, and a record built on it
// says something it cannot support.
//
// `gitInvocation` (src/runtime.ts) is the single construction site: argv and environment
// together, pinned. These laws hold TWO things — that the pins are there, on every invocation
// and in the right place; and that nothing else in src/runtime.ts can reach git without them.
// They are structural because that is what the invariant IS: a property of the invocation the
// engine constructs, not of any particular answer it gets back. P6 is the one behavioural law,
// and it holds the opposite direction — that on an ordinary repository the pins move nothing,
// so the seal keeps naming exactly what plain git names.
//
//   law  kind         drives                                        plant (observed red, then reverted)
//   P1   structural   gitInvocation — src/runtime.ts                drop "-c core.fsmonitor=" from GIT_PINNED_SETTINGS
//   P2   structural   gitInvocation — src/runtime.ts                drop GIT_CONFIG_GLOBAL from GIT_PINNED_ENV
//   P3   structural   gitInvocation — src/runtime.ts                empty GIT_SUBCOMMAND_PINS
//   P4   structural   gitInvocation — src/runtime.ts                drop `...rest` from the argv it builds
//   P5   structural   gitInTree — src/runtime.ts                    spawn git directly, bypassing gitInvocation
//   P6   behavioural  stampLawAddresses / stampChangeAddresses —    pin `diff` to ["--stat"] in GIT_SUBCOMMAND_PINS
//                       src/runtime.ts
//
// P6 runs real git in a throwaway repository this file creates and deletes. Nothing here reads or
// writes this repository's own history, and nothing here configures git anywhere.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInvocation, stampLawAddresses, stampChangeAddresses } from "../src/runtime.js";

const RUNTIME_SRC = fileURLToPath(new URL("../src/runtime.ts", import.meta.url));
const source = readFileSync(RUNTIME_SRC, "utf8");

/** The subcommands the runtime actually asks for today, one sample argv each. */
const READS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["rev-parse a commit:path", ["rev-parse", "deadbeef:tests/x.test.ts"]],
  ["rev-parse HEAD", ["rev-parse", "HEAD"]],
  ["show a commit:path", ["show", "deadbeef:tests/x.test.ts"]],
  ["diff against a base", ["diff", "deadbeef", "--", "src/x.ts"]],
  ["stash create", ["stash", "create"]],
];

/** Every `-c <setting>` pair in an argv, in order. */
const settingsIn = (argv: readonly string[]): string[] =>
  argv.flatMap((a, i) => (a === "-c" && i + 1 < argv.length ? [argv[i + 1]!] : []));

const PINNED_SETTINGS = ["core.fsmonitor=", "core.hooksPath=/dev/null", "core.attributesFile=/dev/null"];

const PINNED_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "coltrane",
  GIT_AUTHOR_EMAIL: "coltrane@invalid",
  GIT_COMMITTER_NAME: "coltrane",
  GIT_COMMITTER_EMAIL: "coltrane@invalid",
};

describe("P1 — every invocation carries the pinned settings, ahead of the subcommand", () => {
  for (const [name, args] of READS) {
    it(`${name} is built with every pinned setting, before its subcommand`, () => {
      const { file, argv } = gitInvocation("/some/tree", args);
      expect(file).toBe("git");
      expect(argv.slice(0, 2), "a read must be directed at tree_root and nowhere else").toEqual(["-C", "/some/tree"]);
      expect(settingsIn(argv), "the pinned settings are missing or reordered").toEqual(
        expect.arrayContaining(PINNED_SETTINGS),
      );
      const lastPin = Math.max(...PINNED_SETTINGS.map((s) => argv.lastIndexOf(s)));
      expect(argv.indexOf(args[0]!), "a setting pinned AFTER the subcommand is not a setting git reads")
        .toBeGreaterThan(lastPin);
    });
  }
});

describe("P2 — every invocation carries the pinned environment, over an inherited one", () => {
  for (const [name, args] of READS) {
    it(`${name} is built with the pinned environment`, () => {
      const { env } = gitInvocation("/some/tree", args);
      for (const [k, v] of Object.entries(PINNED_ENV)) {
        expect(env[k], `${k} is not pinned on the invocation`).toBe(v);
      }
    });
  }

  it("the process environment is inherited, so a pinned read still finds git", () => {
    const { env } = gitInvocation("/some/tree", ["rev-parse", "HEAD"]);
    expect(env["PATH"], "an invocation that drops PATH cannot spawn anything").toBe(process.env["PATH"]);
  });

  it("the pinned keys survive a host that already set them to something else", () => {
    const before = process.env["GIT_CONFIG_GLOBAL"];
    process.env["GIT_CONFIG_GLOBAL"] = "/tmp/somewhere-else";
    try {
      expect(gitInvocation("/some/tree", ["rev-parse", "HEAD"]).env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    } finally {
      if (before === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
      else process.env["GIT_CONFIG_GLOBAL"] = before;
    }
  });
});

describe("P3 — a subcommand's own pins land on it, and only on it", () => {
  it("diff is pinned to git's own rendering, immediately after the subcommand", () => {
    const { argv } = gitInvocation("/some/tree", ["diff", "deadbeef", "--", "src/x.ts"]);
    const at = argv.indexOf("diff");
    expect(at, "the subcommand is missing").toBeGreaterThan(-1);
    expect(argv.slice(at + 1, at + 3), "diff's own pins are missing, reordered, or placed after the caller's arguments")
      .toEqual(["--no-textconv", "--no-ext-diff"]);
  });

  it("a subcommand with no pins of its own gets none invented for it", () => {
    const { argv } = gitInvocation("/some/tree", ["rev-parse", "HEAD"]);
    expect(argv.filter((a) => a.startsWith("--")), "an unrelated switch was added to a read that did not ask for it")
      .toEqual([]);
  });
});

describe("P4 — the caller's own arguments survive the pinning, in order", () => {
  for (const [name, args] of READS) {
    it(`${name} keeps its arguments, in order, after the pins`, () => {
      const { argv } = gitInvocation("/some/tree", args);
      const kept = argv.filter((a) => args.includes(a));
      expect(kept, "pinning dropped or reordered what the caller asked for").toEqual([...args]);
      expect(argv.indexOf(args[0]!), "the caller's arguments must follow -C tree_root").toBeGreaterThan(1);
    });
  }

  it("an empty argument list still produces a directed, pinned invocation", () => {
    const { argv } = gitInvocation("/some/tree", []);
    expect(argv.slice(0, 2)).toEqual(["-C", "/some/tree"]);
    expect(settingsIn(argv)).toEqual(expect.arrayContaining(PINNED_SETTINGS));
  });
});

describe("P5 — src/runtime.ts cannot reach git except through the one construction site", () => {
  /** The file's CODE: prose about a spawn is not a spawn, so comments are dropped before counting. */
  const code = source
    .split("\n")
    .filter((l) => { const t = l.trim(); return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")); })
    .join("\n");

  const fn = (() => {
    const at = code.indexOf("\nfunction gitInTree(");
    const end = code.indexOf("\n}", at);
    return at === -1 || end === -1 ? "" : code.slice(at, end + 2);
  })();

  it("the seam exists, and it is the only place in the file that starts a process", () => {
    expect(fn, "gitInTree could not be located in src/runtime.ts").not.toBe("");
    const spawns = (code.match(/\b(?:execFileSync|execSync|spawnSync|execFile|spawn|fork)\s*\(/g) ?? []).length;
    expect(spawns, "src/runtime.ts starts a process somewhere other than the seam").toBe(1);
    expect(fn.includes("execFileSync("), "the one spawn is not inside the seam").toBe(true);
  });

  it("the seam spawns what the construction site built — its argv AND its environment", () => {
    expect(fn.includes("gitInvocation("), "the seam builds its own invocation instead of using the one site").toBe(true);
    expect(/execFileSync\(\s*file\s*,\s*\[\s*\.\.\.argv\s*\]\s*,\s*\{\s*env\s*\}\s*\)/.test(fn),
      "the seam does not hand execFileSync both the built argv and the built environment").toBe(true);
  });

  it("no second git argv is assembled by hand anywhere in the file", () => {
    const directed = code.split('"-C"').length - 1;
    expect(directed, 'src/runtime.ts builds a "-C" argv outside the one construction site').toBe(1);
  });
});

// ── P6 — the pins move nothing on an ordinary repository ────────────────────────────────────────
// A pin that changed an answer would silently rewrite what a seal means. Each pin names git's own
// default, so the stamped values must be bit-identical to what plain git reports for the same
// objects. Driven through the production stampers, against a throwaway repo.
let repo: string;
let base: string;
const plainGit = (args: readonly string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "coltrane-git-pinned-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "law@example.invalid"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "law"]);
  writeFileSync(join(repo, "law.test.ts"), 'it("the first title", () => {});\nit("the second title", () => {});\n');
  writeFileSync(join(repo, "src.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  base = plainGit(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repo, "src.ts"), "export const a = 2;\n");
});

afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

describe("P6 — a pinned read returns exactly what plain git returns", () => {
  it("a law's stamped blob_sha and tests equal plain git's own answers", () => {
    const [law] = stampLawAddresses([{ path: "law.test.ts", commit: base }], repo);
    expect(law!.blob_sha).toBe(plainGit(["rev-parse", `${base}:law.test.ts`]).trim());
    expect(law!.tests).toEqual(["the first title", "the second title"]);
  });

  it("a change's stamped patch_sha256 and bytes equal plain git's own diff", () => {
    const diff = plainGit(["diff", base, "--", "src.ts"]);
    const [change] = stampChangeAddresses([{ path: "src.ts", base }], repo);
    expect(change!.bytes, "the stamped length is not the length of git's own diff").toBe(Buffer.byteLength(diff, "utf8"));
    expect(change!.patch_sha256).toBe(createHash("sha256").update(diff).digest("hex"));
  });

  it("a snapshot of the working tree still resolves, and holds the pre-edit bytes", () => {
    const { argv, env } = gitInvocation(repo, ["stash", "create"]);
    const snapshot = execFileSync("git", [...argv], { env, encoding: "utf8" }).trim();
    expect(snapshot, "a working tree with an edit in it produced no snapshot").toMatch(/^[0-9a-f]{40}$/);
    expect(execFileSync("git", ["-C", repo, "show", `${snapshot}:src.ts`], { encoding: "utf8" }))
      .toBe("export const a = 2;\n");
  });
});
