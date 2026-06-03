// resume tests — session.json read, validation, spawn wiring, missing-claude
// surfacing.

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidSessionId,
  readSessionRecord,
  resumeSteve,
} from "../src/live/resume.js";

function makeFakeChild(): EventEmitter {
  return new EventEmitter();
}

describe("isValidSessionId", () => {
  it("accepts hex / uuid / dash-hex", () => {
    expect(isValidSessionId("abc123def4567890")).toBe(true);
    expect(isValidSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidSessionId("a_b-c-1234")).toBe(true);
  });
  it("rejects empty / whitespace / shell-special", () => {
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("abc 123")).toBe(false);
    expect(isValidSessionId("abc;rm -rf /")).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
    expect(isValidSessionId(123)).toBe(false);
  });
});

describe("readSessionRecord", () => {
  it("reads session.json correctly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-resume-"));
    await mkdir(join(dir, ".coltrane", "steve_abc"), { recursive: true });
    await writeFile(
      join(dir, ".coltrane", "steve_abc", "session.json"),
      JSON.stringify({ session_id: "deadbeef1234" }),
      "utf8",
    );
    const rec = await readSessionRecord(dir, "abc");
    expect(rec.session_id).toBe("deadbeef1234");
  });

  it("errors cleanly when session.json missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-resume-"));
    await mkdir(join(dir, ".coltrane", "steve_abc"), { recursive: true });
    await expect(readSessionRecord(dir, "abc")).rejects.toThrow(
      /no session yet/,
    );
  });

  it("errors when session_id is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-resume-"));
    await mkdir(join(dir, ".coltrane", "steve_abc"), { recursive: true });
    await writeFile(
      join(dir, ".coltrane", "steve_abc", "session.json"),
      JSON.stringify({ session_id: "abc; rm -rf /" }),
      "utf8",
    );
    await expect(readSessionRecord(dir, "abc")).rejects.toThrow(
      /malformed session_id/,
    );
  });

  it("errors when session.json is not JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-resume-"));
    await mkdir(join(dir, ".coltrane", "steve_abc"), { recursive: true });
    await writeFile(
      join(dir, ".coltrane", "steve_abc", "session.json"),
      "not-json",
      "utf8",
    );
    await expect(readSessionRecord(dir, "abc")).rejects.toThrow(/valid JSON/);
  });
});

describe("resumeSteve", () => {
  it("spawns claude with --resume + correct session_id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-resume-"));
    await mkdir(join(dir, ".coltrane", "steve_xyz"), { recursive: true });
    await writeFile(
      join(dir, ".coltrane", "steve_xyz", "session.json"),
      JSON.stringify({ session_id: "abc123def456" }),
      "utf8",
    );
    const spawner = vi.fn(() => {
      const child = makeFakeChild();
      setImmediate(() => child.emit("exit", 0));
      return child as never;
    });
    const code = await resumeSteve("xyz", dir, { spawner: spawner as never });
    expect(code).toBe(0);
    expect(spawner).toHaveBeenCalledWith(
      "claude",
      ["--resume", "abc123def456"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("surfaces ENOENT when claude binary is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-resume-"));
    await mkdir(join(dir, ".coltrane", "steve_xyz"), { recursive: true });
    await writeFile(
      join(dir, ".coltrane", "steve_xyz", "session.json"),
      JSON.stringify({ session_id: "abc123def456" }),
      "utf8",
    );
    const spawner = vi.fn(() => {
      const child = makeFakeChild();
      setImmediate(() => {
        const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        child.emit("error", err);
      });
      return child as never;
    });
    await expect(
      resumeSteve("xyz", dir, { spawner: spawner as never }),
    ).rejects.toThrow(/claude binary not found/);
  });

  it("returns the child's exit code verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-resume-"));
    await mkdir(join(dir, ".coltrane", "steve_xyz"), { recursive: true });
    await writeFile(
      join(dir, ".coltrane", "steve_xyz", "session.json"),
      JSON.stringify({ session_id: "abc123def456" }),
      "utf8",
    );
    const spawner = vi.fn(() => {
      const child = makeFakeChild();
      setImmediate(() => child.emit("exit", 42));
      return child as never;
    });
    const code = await resumeSteve("xyz", dir, { spawner: spawner as never });
    expect(code).toBe(42);
  });
});
