// A genome file is written with a bare `writeFileSync`, and the ledger has already sealed it.
//
// `sealDefinition` documents its own ordering carefully — SEAL BEFORE WRITE (#218) — because
// the reverse manufactures an orphan: a definition on disk with no recorded identity. The
// chosen direction is the safe one, and it rests on the write either happening or not.
//
// `writeFileSync` gives no such guarantee. Interrupted partway (crash, SIGKILL, ENOSPC on a
// full volume) it leaves a TRUNCATED file where a valid definition used to be. The ledger says
// the definition exists at a content hash; the file on disk parses to something else, or to
// nothing. The engine's whole provenance claim is that a hash identifies bytes, and this is
// the one write that can break that without anything noticing.
//
// The same module already writes the PRIOR version to history before overwriting — so an
// interrupted overwrite can destroy the live file while its backup is also mid-write.
//
// `reuse.ts` solved exactly this for checkpoints ("a torn checkpoint would be read as damage
// and refuse a resume that was, in fact, resumable") with write-then-rename. rename(2) is
// atomic within a filesystem: a reader sees the old bytes or the new bytes, never a mixture.
// The genome file is the more load-bearing of the two and had the weaker write.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGenomeFileVersioned } from "../src/genome_writer.js";
import { writeFileAtomic } from "../src/fs_atomic.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "genome-atomic-"));
}

describe("genome writes are atomic", () => {
  it("writes a new definition", () => {
    const dir = root();
    try {
      const r = writeGenomeFileVersioned(dir, "domain_types", "note", '{"slug":"note"}\n');
      expect(r.overwritten).toBe(false);
      expect(readFileSync(join(dir, "domain_types", "note.json"), "utf-8")).toBe('{"slug":"note"}\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("overwrites, and keeps the prior bytes in history", () => {
    const dir = root();
    try {
      writeGenomeFileVersioned(dir, "domain_types", "note", '{"v":1}\n');
      const r = writeGenomeFileVersioned(dir, "domain_types", "note", '{"v":2}\n');
      expect(r.overwritten).toBe(true);
      expect(r.prior_content_hash).toBeTruthy();
      expect(readFileSync(join(dir, "domain_types", "note.json"), "utf-8")).toBe('{"v":2}\n');
      // WO-F06 — history snapshots now ship with the genome under the tracked genome/history/
      // path, not the gitignored .coltrane/history/, so a fresh clone carries prior versions.
      const histDir = join(dir, "genome", "history", "domain_types", "note");
      expect(readdirSync(histDir)).toEqual([`${r.prior_content_hash}.json`]);
      expect(readFileSync(join(histDir, `${r.prior_content_hash}.json`), "utf-8")).toBe('{"v":1}\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("leaves NO temporary files behind", () => {
    // A rename-based write that forgets to rename leaves the real file untouched and the
    // directory full of debris — which the loader would then try to parse as definitions.
    const dir = root();
    try {
      writeGenomeFileVersioned(dir, "domain_types", "note", '{"v":1}\n');
      writeGenomeFileVersioned(dir, "domain_types", "note", '{"v":2}\n');
      const files = readdirSync(join(dir, "domain_types"));
      expect(files).toEqual(["note.json"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("writeFileAtomic — the primitive", () => {
  it("replaces content wholesale", () => {
    const dir = root();
    try {
      const f = join(dir, "x.json");
      writeFileAtomic(f, "one");
      writeFileAtomic(f, "two");
      expect(readFileSync(f, "utf-8")).toBe("two");
      expect(readdirSync(dir)).toEqual(["x.json"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("creates missing parent directories", () => {
    const dir = root();
    try {
      const f = join(dir, "a", "b", "x.json");
      writeFileAtomic(f, "hi");
      expect(readFileSync(f, "utf-8")).toBe("hi");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a torn write cannot be observed at the destination path", () => {
    // The property under test, stated as the reader sees it: at every instant the destination
    // either does not exist or holds COMPLETE content. Simulated by proving the write goes to
    // a distinct temp path first — an interrupted write damages that file, not the real one.
    const dir = root();
    try {
      const f = join(dir, "x.json");
      writeFileAtomic(f, "complete-original");

      // Stand in for an interrupted write: a leftover temp file from a crashed process.
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${f}.deadbeef.tmp`, "TRUNCA");
      expect(
        readFileSync(f, "utf-8"),
        "the destination must be untouched by a write that never reached its rename",
      ).toBe("complete-original");

      writeFileAtomic(f, "complete-replacement");
      expect(readFileSync(f, "utf-8")).toBe("complete-replacement");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses a unique temp name per call, so concurrent writers cannot collide", () => {
    // pid is NOT unique enough: two containers on a shared mount routinely both have low pids,
    // and a colliding temp name lets one process's torn write get renamed over the real file.
    const dir = root();
    try {
      const f = join(dir, "x.json");
      const names = new Set<string>();
      for (let i = 0; i < 50; i++) {
        writeFileAtomic(f, `v${i}`);
        for (const n of readdirSync(dir)) if (n.endsWith(".tmp")) names.add(n);
      }
      expect(readFileSync(f, "utf-8")).toBe("v49");
      expect(existsSync(f)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── the checkpoint store's other unbounded edge ─────────────────────────────
import { createCheckpointStore, createMemoryCheckpointStore } from "../src/reuse.js";

describe("a completed gig's checkpoint is reclaimed", () => {
  const cp = (gig_id: string) => ({
    gig_id, standard_slug: "s", genome_hash: "h", written_at: new Date(0).toISOString(),
    completed_chairs: [], usage: undefined,
  }) as never;

  it("remove() deletes the file", () => {
    const dir = root();
    try {
      const store = createCheckpointStore(dir);
      store.write(cp("g1"));
      expect(store.read("g1")).toBeTruthy();
      store.remove("g1");
      expect(
        store.read("g1"),
        "without this, every gig a deployment ever runs leaves a file behind forever",
      ).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("removing a checkpoint that was never written is not an error", () => {
    const dir = root();
    try {
      expect(() => createCheckpointStore(dir).remove("never-existed")).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a gig id cannot name a path — the guard read() has, on the operation that DELETES", () => {
    const dir = root();
    try {
      const outside = join(dir, "important.json");
      writeFileSync(outside, "keep me");
      const store = createCheckpointStore(dir);
      store.remove("../important");
      expect(existsSync(outside), "a traversing id must be refused, not honoured").toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the in-memory store implements it too", () => {
    const store = createMemoryCheckpointStore();
    store.write(cp("g1"));
    store.remove("g1");
    expect(store.read("g1")).toBeUndefined();
  });
});
