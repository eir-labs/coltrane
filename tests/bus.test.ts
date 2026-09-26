// THE BUS — one append-only JSONL file many members share (wiki spec.coltrane-bus).
//
// A line is {id, at, author, text, mentions, reply_to?}. Writers only ever APPEND; nobody rewrites a
// byte, so several processes may post at once. Each member keeps its OWN cursor (the next line it has
// not read), so reading is asynchronous and independent. `@member` in a line means that member OWES a
// reply — a later line from it with reply_to = that line's id — and `owed(member)` says which are
// outstanding. An untagged line owes nothing: it is passive signal.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openBus } from "../src/bus.js";

const fresh = () => join(mkdtempSync(join(tmpdir(), "coltrane-bus-")), "room.jsonl");

describe("the bus", () => {
  it("B1 — two processes posting at once lose nothing and tear nothing", async () => {
    const path = fresh();
    const writer = (who: string) => new Promise<void>((resolve, reject) => {
      const code = `import("${join(process.cwd(), "dist/src/bus.js")}").then(({openBus})=>{const b=openBus(${JSON.stringify(path)});for(let i=0;i<300;i++)b.post({author:"${who}",text:"line "+i+" "+"x".repeat(200)});})`;
      const p = spawn(process.execPath, ["-e", code], { stdio: "inherit" });
      p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`writer ${who} exited ${c}`))));
    });
    await Promise.all([writer("a"), writer("b")]);
    const lines = openBus(path).read(0);
    expect(lines.length).toBe(600);
    expect(lines.filter((l) => l.author === "a").length).toBe(300);
    // every physical line parsed: nothing torn
    const physical = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
    expect(physical.length).toBe(600);
    for (const l of physical) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("B2 — each member reads from its own cursor, and the cursor survives a restart", () => {
    const path = fresh();
    const bus = openBus(path);
    bus.post({ author: "eugene", text: "one" });
    bus.post({ author: "eugene", text: "two" });
    expect(bus.unread("chair").map((l) => l.text)).toEqual(["one", "two"]);
    bus.advance("chair", 1);
    expect(bus.unread("chair").map((l) => l.text)).toEqual(["two"]);
    expect(bus.unread("scribe").map((l) => l.text), "another member's cursor is its own").toEqual(["one", "two"]);
    bus.post({ author: "eugene", text: "three" });
    const again = openBus(path);
    expect(again.unread("chair").map((l) => l.text)).toEqual(["two", "three"]);
  });

  it("B3 — a tag owes a reply until the tagged member answers it; an untagged line owes nothing", () => {
    const bus = openBus(fresh());
    const q = bus.post({ author: "eugene", text: "@chair what broke? cc @Scribe" });
    bus.post({ author: "eugene", text: "just thinking out loud" });
    expect(q.mentions).toEqual(["chair", "scribe"]);
    expect(bus.owed("chair").map((l) => l.id)).toEqual([q.id]);
    expect(bus.owed("scribe").map((l) => l.id)).toEqual([q.id]);
    expect(bus.owed("eugene")).toEqual([]);
    bus.post({ author: "chair", text: "the 300s header limit", reply_to: q.id });
    expect(bus.owed("chair")).toEqual([]);
    expect(bus.owed("scribe").map((l) => l.id), "one member's answer does not discharge another's").toEqual([q.id]);
    // a reply from someone else to that line does not discharge the chair's debt either
    // tagging yourself is a note, not a debt
    bus.post({ author: "eugene", text: "note to @eugene: check the ledger" });
    expect(bus.owed("eugene")).toEqual([]);
    const q2 = bus.post({ author: "eugene", text: "@chair and now?" });
    bus.post({ author: "scribe", text: "I can answer", reply_to: q2.id });
    expect(bus.owed("chair").map((l) => l.id)).toEqual([q2.id]);
  });

  it("B4 — a torn last line (a writer killed mid-write) is skipped, and later lines still read", () => {
    const path = fresh();
    const bus = openBus(path);
    bus.post({ author: "a", text: "whole" });
    appendFileSync(path, '{"id":"torn","auth');
    bus.post({ author: "a", text: "after" });
    expect(openBus(path).read(0).map((l) => l.text)).toEqual(["whole", "after"]);
  });

  it("B5 — posting never rewrites what is already there", () => {
    const path = fresh();
    writeFileSync(path, "");
    const bus = openBus(path);
    bus.post({ author: "a", text: "first" });
    const before = readFileSync(path, "utf8");
    bus.post({ author: "b", text: "second" });
    expect(readFileSync(path, "utf8").startsWith(before)).toBe(true);
  });
});
