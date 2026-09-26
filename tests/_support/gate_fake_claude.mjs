#!/usr/bin/env node
// A stand-in for the `claude` CLI that behaves like it at the ONE place tests/one_output_gate.test.ts
// cares about: the MCP servers named in `--mcp-config`. Unlike ./fake_claude.mjs (which emits scripted
// bytes and ignores argv), this one READS the per-gig mcp-config the invoker wrote, STARTS the engine
// server entry exactly as that config says (command/args/env, or url), and CALLS its output_write —
// so the in-turn gate a law observes is the real server's, spawned the way the real CLI spawns it.
//
// Contract (env — the invoker gives the spawn no other seam):
//   GATE_FAKE_PAYLOAD  JSON {core_type, domain_type, data} — what the "model" sends to output_write
//   GATE_FAKE_LOG      a path; a JSON report is written there:
//                        { offered: false, servers: [...] }                       — no engine server
//                        { offered: true, tools: [...], isError, result }         — the in-turn answer
//
// Emits stream-json the way the CLI does: an assistant tool_use, a user tool_result carrying the
// server's text and `is_error` exactly as the server flagged it, then a result. With no engine server
// it answers in final TEXT (the payload as JSON), which is what a text-sealing chair does.
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.stdin.on("data", () => {});
process.stdin.on("error", () => {});

const argv = process.argv.slice(2);
const at = argv.indexOf("--mcp-config");
const cfg = at >= 0 ? JSON.parse(readFileSync(argv[at + 1], "utf8")) : { mcpServers: {} };
const servers = cfg.mcpServers ?? {};
const payload = JSON.parse(process.env["GATE_FAKE_PAYLOAD"] ?? "{}");
const log = (o) => writeFileSync(process.env["GATE_FAKE_LOG"], JSON.stringify(o));
const out = (o) => new Promise((r) => process.stdout.write(JSON.stringify(o) + "\n", r));

const engine = servers["coltrane"];
if (!engine) {
  log({ offered: false, servers: Object.keys(servers) });
  await out({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(payload.data) });
  process.exit(0);
}

const transport = typeof engine.url === "string"
  ? new StreamableHTTPClientTransport(new URL(engine.url))
  : new StdioClientTransport({
      command: engine.command,
      args: engine.args ?? [],
      env: { ...process.env, ...(engine.env ?? {}) },
      cwd: engine.cwd ?? process.cwd(),
      stderr: "ignore",
    });
const client = new Client({ name: "gate-fake-claude", version: "0.0.0" });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const r = await client.callTool({ name: "output_write", arguments: payload });
  const text = (r.content ?? []).map((c) => c.text ?? "").join("");
  let result;
  try { result = JSON.parse(text); } catch { result = text; }
  log({ offered: true, tools, isError: r.isError === true, result });
  await out({ type: "system", subtype: "init", session_id: "gate-fake" });
  await out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_gate_1", name: "mcp__coltrane__output_write", input: payload }] } });
  await out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_gate_1", content: [{ type: "text", text }], ...(r.isError ? { is_error: true } : {}) }] } });
  await out({ type: "result", subtype: "success", is_error: false, result: "done" });
} catch (e) {
  log({ offered: true, crashed: String(e && e.stack || e) });
  await out({ type: "result", subtype: "success", is_error: false, result: "done" });
} finally {
  try { await client.close(); } catch { /* the server may already be gone */ }
}
process.exit(0);
