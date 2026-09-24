// THE CLAUDE DOOR REPORTS WHAT ITS SEAT READ, so law 9's stamping works on the door the drafting
// genome actually runs on (eir-drafting, 24 Sep: "today law 9 buys us nothing in practice").
//
// A completions seat's tools are in-process, so the invoker sees every result. A Claude seat calls its
// MCP server as a CHILD process, so its reads are only visible in the stream — the same place
// `captureOutputWrites` already reads the seat's seals from. This captures the sealed records its tool
// RESULTS carried, and reports them as the same `seat_read` event the runtime already verifies and
// stamps. Reported, never trusted: the runtime re-hashes each ref before it is named.
//
// The seat's OWN output_write results are not reads. On this door they carry no record (validate mode),
// but a seal-mode result would, and a chair naming its own seal as a read would be a false provenance.
import { describe, it, expect } from "vitest";
import { captureSeatReads, makeClaudeInvoker } from "../src/claude_invoker.js";
import { testAgent } from "./_support/agents.js";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) =>
  line({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id: string, payload: unknown) =>
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(payload) }] } });
const result = (text: string) => line({ type: "result", subtype: "success", result: text });

const PROVISION = { id: "rec-595", content_sha: "sha-595", domain_type: "provision", data: { text: "第五百九十五条 …" } };
const OTHER = { id: "rec-108", content_sha: "sha-108", domain_type: "provision", data: { text: "民法第百八条 …" } };

describe("captureSeatReads — the sealed records a Claude seat's tools returned", () => {
  it("C1 — a record an output_query result carried is captured, with its sha", () => {
    const stdout =
      toolUse("t1", "mcp__coltrane__output_query", { output_id: "rec-595" }) +
      toolResult("t1", { ok: true, data: { outputs: [PROVISION] } }) +
      result("done");
    expect(captureSeatReads(stdout)).toEqual([{ id: "rec-595", content_sha: "sha-595" }]);
  });

  it("C2 — several results, nested shapes, deduped and in order", () => {
    const stdout =
      toolUse("t1", "mcp__coltrane__output_query", {}) + toolResult("t1", { data: { outputs: [PROVISION, OTHER] } }) +
      toolUse("t2", "mcp__coltrane__output_trace", {}) + toolResult("t2", { data: { nodes: [{ record: OTHER }] } }) +
      result("done");
    expect(captureSeatReads(stdout)).toEqual([
      { id: "rec-595", content_sha: "sha-595" },
      { id: "rec-108", content_sha: "sha-108" },
    ]);
  });

  it("C3 — the seat's own output_write result is not a read", () => {
    const stdout =
      toolUse("w1", "mcp__coltrane__output_write", { domain_type: "rule" }) +
      toolResult("w1", { ok: true, data: { id: "rec-mine", content_sha: "sha-mine" } }) +
      toolUse("t1", "mcp__coltrane__output_query", {}) + toolResult("t1", { data: { outputs: [PROVISION] } }) +
      result("done");
    expect(captureSeatReads(stdout)).toEqual([{ id: "rec-595", content_sha: "sha-595" }]);
  });

  it("C4 — a seat that read nothing reports nothing; a torn stream is not fatal", () => {
    expect(captureSeatReads(result("nothing read"))).toEqual([]);
    expect(captureSeatReads('{"type":"user","message":{"content":[{"type":"tool_res')).toEqual([]);
  });

  it("C6 — asking for a record is not reading it: only what a RESULT carried counts", async () => {
    // A seat can name a record in a tool's arguments (a trace from an id and its sha) and get nothing
    // back — the store may not hold it, the call may be refused. What it was HANDED is the read.
    const stdout =
      toolUse("t1", "mcp__coltrane__output_trace", { id: "rec-595", content_sha: "sha-595" }) +
      toolResult("t1", { ok: false, error: "no such output" }) +
      result("done");
    expect(captureSeatReads(stdout)).toEqual([]);
  });

  it("C5 — the invoker emits what it captured as `seat_read`, the event the runtime verifies and stamps", async () => {
    const events: Array<{ type: string; raw?: unknown }> = [];
    const stdout =
      toolUse("t1", "mcp__coltrane__output_query", { output_id: "rec-595" }) +
      toolResult("t1", { data: { outputs: [PROVISION] } }) +
      result(JSON.stringify({ says: "self-dealing needs consent", claims: ["c"] }));
    const invoke = makeClaudeInvoker({ run: () => stdout });
    await invoke({
      agent: testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: [], output_types: ["rule"], domain: "law", allowed_tools: ["output_query"] }),
      phase: "read", role: "r", gig_id: "g-reads", inputs: [], gig_input: {}, output_types: ["rule"],
      onEvent: (e: { type: string; raw?: unknown }) => events.push(e),
    } as never);
    const read = events.find((e) => e.type === "seat_read");
    expect(read, "the Claude door reported no reads — law 9 cannot stamp what it is never told").toBeTruthy();
    expect(read!.raw).toMatchObject({ refs: [{ id: "rec-595", content_sha: "sha-595" }] });
  });
});
