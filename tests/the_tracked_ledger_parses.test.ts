// The committed provenance log is the SUBJECT of a law, not just the capability that reads it.
//
// The engine can already detect a torn ledger: FileLedger.read() collects a LedgerCorruption per
// unreadable line (line_no, reason, preview), integrity() returns them, and system_health surfaces
// the report — #255 wired that after finding `integrity` had ZERO call sites. All of it is tested.
//
// What was missing is narrower: NOTHING WAS POINTED AT THIS REPO'S OWN genome/ledger.jsonl. The
// capability is exercised against tmpdir fixtures; the artifact that actually ships was never the
// subject. Found the way these are usually found — a rebase conflicted on the ledger, `git add -A`
// staged the conflicted file, and three conflict-marker lines went into the append-only log. The
// whole suite stayed green and reported its law count over the word "exact", because every ledger
// law was instrumented one layer away from the file.
//
// So this is a GATE over an artifact, not a fix to a broken mechanism. The artifact is clean today;
// the defect was the absence of the check. The proof that the gate can fail is the plant recorded in
// the PR — append a conflict marker, watch P1 go red with the line NAMED.
//
// It calls the engine's OWN integrity() rather than parsing the file itself. A law with its own
// parser would drift from the one the verb uses, and "two readers of one artifact, disagreeing" is
// the defect class this repo keeps finding.
//
// SCOPE, stated so a green here is not read as more than it is: this asserts PARSE-VALIDITY, not
// COMPLETENESS. system_health already says why — "a jsonl truncated at a line boundary loses whole
// rows without leaving a parse error". A clean report means no line was unreadable. It does not mean
// no row is missing, and no law here claims otherwise.
//
// ASSERTION DIRECTION DECIDES THE SUBJECT'S WIDTH, and this file gets it wrong twice before it gets it
// right, so the rule is written here rather than learned again:
//
//   a POSITIVE assertion must be as NARROW as the claim  — "it says X" over a whole payload passes if
//                                                           ANY field anywhere happens to say X
//   a NEGATIVE assertion may be as WIDE as you can reach — "it never says X" over a whole payload is
//                                                           STRICTER than over one field, not looser
//
// So the positives below read `counts_complete_basis`, the one field that carries the claim, and the
// negatives deliberately stringify the ENTIRE response. The width of the negatives is not an oversight
// and must not be "tidied" to the field reader — that would weaken them.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FileLedger, MemoryLedger, type LedgerEntry } from "../src/ledger.js";
import { dispatchTool } from "../src/server.js";
import { createRegistry, createOutputStore } from "../src/index.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRACKED = join(REPO, "genome", "ledger.jsonl");

const healthDeps = (ledger: FileLedger | MemoryLedger) => {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger };
};

/** The one field that carries the claim. Reading the WHOLE payload is how two laws in this file passed
 *  for the wrong reason: a positive substring match over a health report is satisfied by any field that
 *  happens to contain the words. Positives read this; negatives read the whole response on purpose. */
const basisOf = async (ledger: FileLedger | MemoryLedger): Promise<string> => {
  const r = await dispatchTool("system_health", {}, healthDeps(ledger) as never);
  const d = (r.data ?? {}) as { counts_complete_basis?: string };
  expect(d.counts_complete_basis, "system_health must carry counts_complete_basis").toBeTypeOf("string");
  return d.counts_complete_basis!;
};


describe("P1 — this repo's committed genome ledger is readable, every line", () => {
  it("the tracked ledger exists and is the subject of this law", () => {
    expect(existsSync(TRACKED), `${TRACKED} missing — the genome ledger is a tracked artifact`).toBe(true);
  });

  it("the engine's own integrity() reports it clean, and NAMES any line it cannot read", () => {
    const report = new FileLedger(TRACKED).integrity();
    // The failure message carries what integrity() already knows, so a red here is actionable
    // without a second investigation: line number, reason, and the offending text.
    const named = report.corrupt
      .map((c) => `  line ${c.line_no}: ${c.reason} — ${JSON.stringify(c.preview)}`)
      .join("\n");
    expect(report.ok, `genome/ledger.jsonl has ${report.corrupt.length} unreadable line(s):\n${named}`).toBe(true);
    expect(report.corrupt, "a clean report carries no corruption records").toEqual([]);
  });

  it("it holds real rows — a gate over an empty file would pass for the wrong reason", () => {
    const report = new FileLedger(TRACKED).integrity();
    expect(report.entries, "an empty ledger would satisfy 'no unreadable line' vacuously").toBeGreaterThan(0);
    expect(report.path, "the report names the artifact it read").toBe(TRACKED);
  });

  it("every entry it yields is a kind the ledger declares — parse-clean is not shape-clean", () => {
    const kinds = new Set(["gig", "genome_mutation", "governance", "chair_spend"]);
    const bad = new FileLedger(TRACKED)
      .query({})
      .filter((e: LedgerEntry) => !kinds.has(e.kind));
    expect(bad.map((e) => e.kind), "a row whose kind is outside the declared union").toEqual([]);
  });
});

describe("P2 — SCOPE: a clean report is not a claim of completeness", () => {
  it("the law asserts no line was UNREADABLE, and nothing about rows that are absent", () => {
    // Stated as an executable reminder rather than prose: a ledger truncated at a line boundary is
    // parse-clean and short. If a later reader wants completeness, that is a different law and it
    // needs a different signal (a count, a chain, a seal) — not this one going green.
    const report = new FileLedger(TRACKED).integrity();
    expect(report.ok, "precondition").toBe(true);
    expect(
      Object.keys(report).sort(),
      "the report offers ok/path/entries/corrupt — no completeness field, because it cannot know",
    ).toEqual(["corrupt", "entries", "ok", "path"]);
  });
});

describe("P3 — a ledger with no artifact must not report as 'checked and clean'", () => {
  it("MemoryLedger is honestly ok, and says so by carrying NO path", () => {
    // Not a defect: nothing is parsed from bytes, so there is no torn-line failure mode. The
    // distinguishing signal is the empty path, and it has to stay distinguishable.
    const mem = new MemoryLedger().integrity();
    expect(mem.ok, "a memory ledger has no unreadable lines by construction").toBe(true);
    expect(mem.path, "and it names no artifact, because it read none").toBe("");
  });

  it("a FILE ledger's clean report is distinguishable from a memory one — a path, not a bare ok", () => {
    const file = new FileLedger(TRACKED).integrity();
    const mem = new MemoryLedger().integrity();
    expect(file.ok).toBe(mem.ok);
    expect(
      file.path !== mem.path,
      "ok:true alone cannot tell a checked artifact from an absent one; the path is what does",
    ).toBe(true);
  });
});

describe("P4 — system_health must not report a check it did not perform", () => {
  const deps = (ledger: FileLedger | MemoryLedger) => {
    const registry = createRegistry();
    return { registry, outputs: createOutputStore(registry), ledger };
  };

  // THE case. `countsBasis` is built from `ok` alone, so a ledger that read NOTHING answers with the
  // same sentence as one that read an artifact and found it whole: "no unreadable line was found".
  // On a memory-backed surface that is a statement about a check that never happened — a green that
  // cannot go red, which is the defect this repo names most often.
  it("a memory-backed ledger does NOT claim 'no unreadable line was found'", async () => {
    const r = await dispatchTool("system_health", {}, deps(new MemoryLedger()) as never);
    // NEGATIVE -> deliberately the WHOLE response. If that sentence appears anywhere at all, in any
    // field, this fails. Do not narrow it to counts_complete_basis; that would weaken the law.
    const basis = JSON.stringify(r.data ?? {});
    expect(
      basis.includes("no unreadable line was found"),
      "nothing was read, so nothing can be said about unreadable lines — the honest answer is that " +
        "this ledger holds no artifact, not that its artifact is clean",
    ).toBe(false);
  });

  it("and it says WHY, so an operator can tell 'nothing to check' from 'checked and clean'", async () => {
    // POSITIVE -> narrow. Over the whole payload this passed BEFORE the fix, because "absent" and
    // "not applicable" are common enough to appear elsewhere in a health report.
    const basis = await basisOf(new MemoryLedger());
    expect(basis, "the report names the absence of an artifact").toMatch(/holds no artifact to check/);
  });

  it("a FILE-backed clean ledger still reports the real finding — the fix must not mute the true case", async () => {
    // POSITIVE -> narrow, for the same reason as the law above. This one was the same defect and went
    // unflagged; found by applying the rule to every site rather than the one that was named.
    const basis = await basisOf(new FileLedger(TRACKED));
    expect(basis, "a real check that found nothing still says so").toContain("no unreadable line was found");
  });
});

describe("P5 — THREE states, not two: an artifact that was never created is not a clean one", () => {
  const deps = (ledger: FileLedger | MemoryLedger) => {
    const registry = createRegistry();
    return { registry, outputs: createOutputStore(registry), ledger };
  };

  // FileLedger.read() returns empty when the path does not exist, so integrity() answers
  // { ok: true, path: "<a real path>", entries: 0, corrupt: [] }. P4 branches on the EMPTY path, so
  // this case took the FILE branch and reported "no unreadable line was found" — a line looked for
  // and not found, in a file that does not exist.
  //
  // Operationally this is the state that matters most: a drain that has never written a row, or whose
  // outputs directory was wiped, reports IDENTICALLY to a healthy one. A box that looks fine and has
  // done nothing. Measured instance: a system_health run reporting ledger_integrity ok:true against a
  // .coltrane/ledger.jsonl whose directory did not exist.

  const absentPath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "absent-ledger-"));
    const p = join(dir, "never-written", "ledger.jsonl");
    rmSync(dir, { recursive: true, force: true }); // and now even the parent is gone
    return p;
  };

  it("integrity() cannot distinguish it — ok:true, a real path, zero entries, no corruption", () => {
    const r = new FileLedger(absentPath()).integrity();
    expect(r.ok, "nothing was unreadable, because nothing was read").toBe(true);
    expect(r.path, "and the path is SET, so the empty-path signal does not fire").not.toBe("");
    expect(r.entries).toBe(0);
    expect(r.corrupt).toEqual([]);
  });

  it("system_health does NOT claim a line was looked for in a file that does not exist", async () => {
    const r = await dispatchTool("system_health", {}, deps(new FileLedger(absentPath())) as never);
    // NEGATIVE -> deliberately the WHOLE response, as above. Wider is stronger here.
    const basis = JSON.stringify(r.data ?? {});
    expect(
      basis.includes("no unreadable line was found"),
      "the artifact does not exist; no line was looked for, so none can be reported as not found",
    ).toBe(false);
  });

  it("and it says the artifact is absent, distinctly from 'checked and clean'", async () => {
    const basis = await basisOf(new FileLedger(absentPath()));
    expect(basis, "an operator must be able to tell 'never written' from 'whole'").toMatch(/DOES NOT EXIST/);
    expect(basis, "and it must say plainly that this is not the clean case").toMatch(/not a clean ledger/i);
  });

  it("the three states are mutually distinguishable in the report text", async () => {
    const mem = JSON.stringify((await dispatchTool("system_health", {}, deps(new MemoryLedger()) as never)).data ?? {});
    const gone = JSON.stringify((await dispatchTool("system_health", {}, deps(new FileLedger(absentPath())) as never)).data ?? {});
    const says = (h: string, needle: string): boolean => h.includes(needle);
    // The POSITIVE reads the field; the two NEGATIVES read the whole response.
    expect(await basisOf(new FileLedger(TRACKED)), "the real finding still reports").toContain("no unreadable line was found");
    expect(says(mem, "no unreadable line was found")).toBe(false);
    expect(says(gone, "no unreadable line was found")).toBe(false);
    expect(mem === gone, "no artifact and a missing artifact are different claims").toBe(false);
  });
});
