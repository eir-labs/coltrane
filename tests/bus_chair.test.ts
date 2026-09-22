// THE RESIDENT CHAIR — a bus member that answers what it owes and only hears the rest
// (wiki spec.coltrane-bus, build step 2).
//
// One pass of `chairPass`: every line tagging the chair that it has not answered gets exactly one turn,
// and the answer is posted with reply_to that line. Untagged lines cost nothing: no model call, the
// chair's cursor simply moves past them (the passive feed; VOI over it is step 4). A turn that fails
// posts nothing and leaves the line owed — an absent answer must not look like one.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBus } from "../src/bus.js";
import { chairPass } from "../src/bus_chair.js";
import { scriptedPort, answers, calls } from "./spec_turn_loop_fixtures.js";

const bus = () => openBus(join(mkdtempSync(join(tmpdir(), "coltrane-chair-")), "room.jsonl"));
const CHAIR = { member: "chair", identity: "CHAIR-ID-7f3: the coltrane repo's chair.", model: "m-1", allowed_tools: ["mcp__coltrane__output_query"] };
const tools = (seen: string[]) => ({
  list: async () => [
    { name: "mcp__coltrane__output_query", inputSchema: { type: "object" } },
    { name: "mcp__coltrane__gig_dispatch", inputSchema: { type: "object" } },
  ],
  call: async (name: string) => { seen.push(name); return { ok: true, data: [] }; },
});

describe("the resident chair", () => {
  it("C1 — a tagged line gets exactly one reply, threaded to it; a second pass does not answer again", async () => {
    const b = bus();
    const q = b.post({ author: "eugene", text: "@chair what is left on PR 550?" });
    const { port, requests } = scriptedPort([answers("the conductor hook")]);
    const r1 = await chairPass({ bus: b, chair: CHAIR, port, tools: tools([]) });
    expect(r1.answered).toEqual([q.id]);
    const reply = b.read(0).find((l) => l.author === "chair")!;
    expect(reply.reply_to).toBe(q.id);
    expect(reply.text).toBe("the conductor hook");
    expect(b.owed("chair")).toEqual([]);
    await chairPass({ bus: b, chair: CHAIR, port, tools: tools([]) });
    expect(requests.length, "no second turn for a line already answered").toBe(1);
  });

  it("C2 — untagged lines cost no model call, and the chair's cursor moves past them", async () => {
    const b = bus();
    b.post({ author: "eugene", text: "thinking out loud" });
    b.post({ author: "scribe", text: "noted" });
    const { port, requests } = scriptedPort([answers("unused")]);
    const r = await chairPass({ bus: b, chair: CHAIR, port, tools: tools([]) });
    expect(requests.length).toBe(0);
    expect(r.heard).toBe(2);
    expect(b.unread("chair")).toEqual([]);
  });

  it("C3 — the chair's turn carries its identity and the recent bus, with the owed line marked", async () => {
    const b = bus();
    b.post({ author: "scribe", text: "context-line-9a1: the intake sealed" });
    b.post({ author: "eugene", text: "@chair summarise" });
    const { port, requests } = scriptedPort([answers("ok")]);
    await chairPass({ bus: b, chair: CHAIR, port, tools: tools([]) });
    const sent = JSON.stringify(requests[0]!.messages);
    expect(sent).toContain("CHAIR-ID-7f3");
    expect(sent).toContain("context-line-9a1");
    expect(sent).toContain("@chair summarise");
  });

  it("C4 — the chair's hands are its grants: a granted tool is offered and reached, an ungranted one is not offered", async () => {
    const b = bus();
    b.post({ author: "eugene", text: "@chair any sealed notes?" });
    const seen: string[] = [];
    const { port, requests } = scriptedPort([calls("mcp__coltrane__output_query", {}), answers("none")]);
    await chairPass({ bus: b, chair: CHAIR, port, tools: tools(seen) });
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(["mcp__coltrane__output_query"]);
    expect(seen).toEqual(["mcp__coltrane__output_query"]);
  });

  it("C5 — a turn that fails posts nothing, leaves the line owed, and says why", async () => {
    const b = bus();
    const q = b.post({ author: "eugene", text: "@chair hello?" });
    const port = async () => { throw new Error("upstream 503"); };
    const r = await chairPass({ bus: b, chair: CHAIR, port: port as never, tools: tools([]) });
    expect(b.read(0).filter((l) => l.author === "chair")).toEqual([]);
    expect(b.owed("chair").map((l) => l.id)).toEqual([q.id]);
    expect(r.failed[0]).toMatchObject({ line: q.id });
    expect(String(r.failed[0]!.reason)).toMatch(/503|transport/);
  });
});
