// THE TERMINAL — bare `coltrane` in an interactive terminal opens a chat with the repo's chair on the
// shared bus (wiki spec.coltrane-bus, step 3). A script or a pipe still gets usage and exit 2
// (tests/cli.test.ts "no command prints usage and exits 2"): the contract CI relies on is kept.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBus } from "../src/bus.js";
import { startChat, entryArgv } from "../src/bus_terminal.js";
import { scriptedPort, answers } from "./spec_turn_loop_fixtures.js";

const CHAIR = { member: "chair", identity: "the repo's chair", model: "m-1", allowed_tools: [] as string[] };
const room = () => openBus(join(mkdtempSync(join(tmpdir(), "coltrane-term-")), "room.jsonl"));

describe("the terminal", () => {
  it("T1 — what I type is posted as me; a line tagging the chair comes back answered, on screen", async () => {
    const bus = room();
    const out: string[] = [];
    const { port } = scriptedPort([answers("hello eugene")]);
    const chat = startChat({ bus, me: "eugene", chair: CHAIR, port, out: (s) => out.push(s) });
    await chat.say("@chair are you there?");
    expect(bus.read(0).map((l) => [l.author, l.text])).toEqual([["eugene", "@chair are you there?"], ["chair", "hello eugene"]]);
    expect(out.join("\n")).toContain("chair: hello eugene");
    expect(out.join("\n"), "my own line is not echoed back to me").not.toContain("eugene: @chair");
  });

  it("T2 — an untagged line costs no model call", async () => {
    const bus = room();
    const { port, requests } = scriptedPort([answers("unused")]);
    const chat = startChat({ bus, me: "eugene", chair: CHAIR, port, out: () => {} });
    await chat.say("just a thought");
    expect(requests.length).toBe(0);
  });

  it("T3 — lines other members post appear on screen when the terminal polls", async () => {
    const bus = room();
    const out: string[] = [];
    const chat = startChat({ bus, me: "eugene", chair: CHAIR, port: scriptedPort([answers("x")]).port, out: (s) => out.push(s) });
    bus.post({ author: "eir-drafting", text: "intake sealed" });
    await chat.poll();
    expect(out.join("\n")).toContain("eir-drafting: intake sealed");
  });

  it("T4 — bare `coltrane` opens chat in an interactive terminal, and prints usage to a script", () => {
    expect(entryArgv([], true)).toEqual(["chat"]);
    expect(entryArgv([], false)).toEqual([]);
    expect(entryArgv(["dispatch", "x"], true)).toEqual(["dispatch", "x"]);
  });
});
