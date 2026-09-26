// A PROTECTED PATH HAS NO OTHER SPELLING — not in Unicode, not through a link.
//
// Blocking finding 2 of the non-author grade (#553). APFS — the file system every macOS drain host runs
// on — is case-insensitive AND normalization-insensitive, with Unicode case folding: it opens
// `coltrane.layout.jſon` (U+017F LATIN SMALL LETTER LONG S) as `coltrane.layout.json` (the grader
// checked; this file re-checks on whatever host it runs on). The engine compared protected names with
// `toLowerCase`, so `Write(coltrane.layout.jſon)` was granted, escaped the bare-Write deny, and — though
// the diff gate refused the chair afterwards — the write had already happened.
//
// THE RULE (the conductor's): protection never compares literal names. A path is protected when its
// FOLD equals a protected path's fold, where the fold is Unicode case folding + NFKC (so ſ→s, fullwidth
// and mathematical letters → ASCII, ligatures → their letters) + confusable folding of combining marks
// (NFD, then drop Mn — so `.ġit` and `.ġit` are `.git`). And where the file EXISTS, protection
// follows the file itself (realpath / inode), so a symlink or hardlink to the layout file is the layout
// file. No protected name contains `st`, `fi`, `fl` or `ff`, so ligatures are exercised through NFKC
// itself (fullwidth and mathematical-alphanumeric letters are compatibility characters of the same kind).
//
//   law                                                      kind         drives                                      plant
//   no Unicode variant of a protected path is granted         behavioural  resolveSeatGrants — src/layout_grants.ts     compare protected names with toLowerCase only
//   as a target                                                           (isProtectedPath, src/grant_scope.ts)        (drop NFKC / confusable folding)
//   a grant spelled with a variant is denied the real path    behavioural  same (denials via grantMayReach)             match protected paths on the literal spelling
//   the diff gate never excuses a variant                     behavioural  runGig — src/runtime.ts (diff gate)          same
//   on a folding FS, the variant IS the file (probe)          behavioural  the host file system                         —  (a fact about the FS the law is run on)
//   a symlink / hardlink to the layout file is never granted  behavioural  runGig → resolveSeatGrants with the tree     protect by name only, not by realpath/inode
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker, type Agent, type GigProgressEvent } from "../src/index.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { loadLayoutGrants, type Layout } from "./layout_grants_fixtures.js";

const fw = (s: string) => [...s].map((c) => (/[a-z]/.test(c) ? String.fromCodePoint(c.codePointAt(0)! - 0x61 + 0xff41) : c)).join("");
const bold = (s: string) => [...s].map((c) => (/[a-z]/.test(c) ? String.fromCodePoint(c.codePointAt(0)! - 0x61 + 0x1d41a) : c)).join("");

/** Every spelling here names a protected path on a file system that folds as APFS does, or under NFKC. */
const VARIANTS: Array<{ spelling: string; is: string; how: string }> = [
  { spelling: "coltrane.layout.jſon", is: "coltrane.layout.json", how: "long s (U+017F)" },
  { spelling: `${fw("coltrane")}.layout.json`, is: "coltrane.layout.json", how: "fullwidth letters" },
  { spelling: "ċoltrane.layout.json", is: "coltrane.layout.json", how: "c with dot above, NFC" },
  { spelling: "ċoltrane.layout.json", is: "coltrane.layout.json", how: "c + combining dot, NFD" },
  { spelling: `.${fw("git")}/config`, is: ".git/config", how: "fullwidth letters" },
  { spelling: `.${bold("git")}/hooks/pre-commit`, is: ".git/hooks/pre-commit", how: "mathematical bold letters (NFKC)" },
  { spelling: ".ġit/config", is: ".git/config", how: "g with dot above, NFC" },
  { spelling: ".gi̇t/config", is: ".git/config", how: "i + combining dot above" },
  { spelling: `.${fw("claude")}/settings.json`, is: ".claude/settings.json", how: "fullwidth letters" },
  { spelling: ".ċlaude/settings.json", is: ".claude/settings.json", how: "c with dot above, NFC" },
  { spelling: ".ċlaude/settings.json", is: ".claude/settings.json", how: "c + combining dot, NFD" },
  { spelling: `.${fw("coltrane")}/ledger.jsonl`, is: ".coltrane/ledger.jsonl", how: "fullwidth letters" },
  { spelling: ".COLTRANE/x".normalize("NFD"), is: ".coltrane/x", how: "upper case (control of the folding)" },
];

const agentOf = (allowed_tools: string[]): Agent =>
  testAgent({ slug: "impl", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", allowed_tools });

describe("no Unicode spelling of a protected path is granted as a target", () => {
  for (const v of VARIANTS) {
    it(`${JSON.stringify(v.spelling)} (${v.how}) is never granted — not even to a bare Write`, async () => {
      const L = await loadLayoutGrants();
      const r = L.resolveSeatGrants({ agent: agentOf(["Write"]), target_paths: [v.spelling, "src/a.ts"] });
      expect(r.grants, "non-vacuity: the plain target is granted").toContain("Write(src/a.ts)");
      expect(r.grants.filter((g) => g !== "Write(src/a.ts)"), `${v.spelling} names ${v.is} and became a grant`).toEqual([]);
    });
  }
});

describe("a grant spelled with a variant is denied the real protected path", () => {
  const CASES: Array<[string, string]> = [
    ["Write(coltrane.layout.jſon)", "Write(coltrane.layout.json)"],
    [`Write(.${fw("git")}/**)`, "Write(.git/**)"],
    [`Write(.${fw("claude")}/*)`, "Write(.claude/**)"],
    ["Write(.ġit/**)", "Write(.git/**)"],
    [`Write(.${fw("coltrane")}/**)`, "Write(.coltrane/**)"],
  ];
  for (const [grant, deny] of CASES) {
    it(`${grant} carries the denial ${deny}`, async () => {
      const L = await loadLayoutGrants();
      const r = L.resolveSeatGrants({ agent: agentOf([grant]) });
      expect(r.denials, `${grant} reaches ${deny.slice(6, -1)} on a folding FS and was not denied it`).toContain(deny);
    });
  }
});

// ── the real file system ────────────────────────────────────────────────────────────────────────

function gitTree(withLayout: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "spelling-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", root]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "a\n");
  if (withLayout) writeFileSync(join(root, "coltrane.layout.json"), JSON.stringify({ paths: { source: ["**"] } }));
  execFileSync("git", ["-C", root, "add", "-A"], { env });
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "seed"], { env });
  return root;
}
const WIDE: Layout = { paths: { source: ["**"] } };

async function run(allowed: string[], gigInput: Record<string, unknown>, deps: Record<string, unknown>, act: () => void = () => {}) {
  const registry = createRegistry();
  registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
  const outputs = createOutputStore(registry);
  const events: GigProgressEvent[] = [];
  let invoked = 0;
  const invoke: AgentInvoker = () => { invoked += 1; act(); return { ...coreInvariantFields("Signal"), value: "done" }; };
  const a = agentOf(allowed);
  const standard = { slug: "s", domain: "demo", agents: [a], phases: [{ name: "p", chairs: [{ role: "impl", agent_slug: "impl", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }] } as unknown as Standard;
  let said = "";
  try {
    said = JSON.stringify(await runGig(standard, gigInput, { outputs, ledger: new MemoryLedger(), invoke, onProgress: (e: GigProgressEvent) => events.push(e), ...deps } as never));
  } catch (e) { said = String((e as Error)?.message ?? e); }
  const done = events.find((e) => e.type === "chair_complete") as (GigProgressEvent & Record<string, unknown>) | undefined;
  return { invoked, said, sealed: outputs.all().filter((o) => (o as { agent_slug?: string }).agent_slug === "impl"), grants: (done?.["resolved_grants"] ?? []) as string[] };
}

describe("on the real file system", () => {
  it("probe: whether THIS host's file system opens coltrane.layout.jſon as coltrane.layout.json (APFS does)", () => {
    const d = mkdtempSync(join(tmpdir(), "fold-probe-"));
    writeFileSync(join(d, "coltrane.layout.json"), "{}");
    const folds = existsSync(join(d, "coltrane.layout.jſon"));
    console.info(`[fs-probe] ${process.platform}: the file system ${folds ? "FOLDS" : "does not fold"} U+017F onto s`);
    if (process.platform === "darwin") expect(folds, "an APFS host that does not fold ſ — this law's premise does not hold here").toBe(true);
  });

  for (const v of VARIANTS.filter((x) => !x.spelling.startsWith(".COLTRANE"))) {
    it(`a Write(**) seat that writes ${JSON.stringify(v.spelling)} (${v.how}) is refused and nothing it made is sealed`, async () => {
      const root = gitTree(false);
      const r = await run(["Read", "Write(@source)"], { request_text: "x" }, { layout: WIDE, tree_root: root }, () => {
        const parts = v.spelling.split("/");
        if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
        writeFileSync(join(root, ...parts), "{}\n");
      });
      expect(r.invoked, "non-vacuity: the seat ran").toBe(1);
      expect(r.sealed, `${JSON.stringify(v.spelling)} names ${v.is} and the diff gate excused it`).toHaveLength(0);
    });
  }

  for (const kind of ["symlink", "hardlink"] as const) {
    it(`a target that is a ${kind} to coltrane.layout.json is never granted — protection follows the file, not its name`, async () => {
      const root = gitTree(true);
      if (kind === "symlink") symlinkSync("coltrane.layout.json", join(root, "alias.json"));
      else linkSync(join(root, "coltrane.layout.json"), join(root, "alias.json"));
      const before = readFileSync(join(root, "coltrane.layout.json"), "utf8");
      const r = await run(["Read", "Write(@source)"], { request_text: "x", target_paths: ["alias.json", "src/a.ts"] }, { layout: WIDE, tree_root: root });
      const seated = r.invoked === 1;
      if (seated) expect(r.grants, `the seat was granted Write(alias.json) — a ${kind} to the layout file`).not.toContain("Write(alias.json)");
      else expect(r.said, "refused without naming the aliased target").toContain("alias.json");
      expect(readFileSync(join(root, "coltrane.layout.json"), "utf8")).toBe(before);
    });
  }
});
