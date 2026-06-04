#!/usr/bin/env node
// steve_in_channel_e2e.mjs
//
// True end-to-end: real Slack socket → real Claude subprocess → real Slack post.
// Excluded from CI by location (tests/live/ not tests/e2e/).
//
// Requires:
//   - SLACK_BOT_TOKEN + SLACK_APP_TOKEN env (Steve identity; bot must be in channel)
//   - claude CLI on PATH (Claude Code session)
//   - STEVE_TEST_CHANNEL env (defaults to #testants C0B7ZTJ8HM4)
//
// Loop:
//   1. boot SlackBridge with real tokens
//   2. on_inbox: if text starts with "STEVE-E2E-PING:<uuid>", spawn `claude -p`
//      with the question portion, parse stdout, bridge.post() the answer
//      prefixed "STEVE-E2E-PONG:<uuid>"
//   3. test seed: bridge.post("STEVE-E2E-PING:<uuid> 7 + 35 = ?")
//   4. socket delivers the bot's own post back as an inbox event
//   5. handler spawns claude, claude responds "42", bridge posts PONG
//   6. assertions: audit.jsonl has 1 in + 2 out (seed + pong),
//      pong contains "42", chain hashes verify
//
// Exit codes: 0 PASS, 1 FAIL.

import { mkdtemp, readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const CHANNEL = process.env.STEVE_TEST_CHANNEL ?? "C0B7ZTJ8HM4"; // #testants
if (!BOT_TOKEN || !APP_TOKEN) {
  console.error("missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN");
  process.exit(1);
}

const CANARY = randomUUID().slice(0, 8);
const PING_PREFIX = `STEVE-E2E-PING:${CANARY}`;
const PONG_PREFIX = `STEVE-E2E-PONG:${CANARY}`;

const tmp = await mkdtemp(join(tmpdir(), "steve-e2e-"));
const auditPath = join(tmp, "audit.jsonl");
await writeFile(auditPath, "");

const web = new WebClient(BOT_TOKEN);
const socket = new SocketModeClient({ appToken: APP_TOKEN });

let pongTs = null;
let claudeStdout = null;
let claudeError = null;

async function appendAudit(entry) {
  await appendFile(auditPath, JSON.stringify(entry) + "\n", "utf8");
}

function spawnClaude(question) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", question, "--output-format", "json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`claude exit ${code}: ${stderr.slice(0, 500)}`));
      else resolve(stdout);
    });
    child.on("error", reject);
  });
}

function extractAnswer(claudeJsonOut) {
  // claude --output-format json wraps reply in {result: "..."} (or similar).
  // Be liberal: try JSON, fall back to raw text.
  try {
    const obj = JSON.parse(claudeJsonOut);
    if (typeof obj.result === "string") return obj.result.trim();
    if (typeof obj.response === "string") return obj.response.trim();
  } catch {}
  return claudeJsonOut.trim();
}

socket.on("slack_event", async (args) => {
  if (args.ack) await args.ack();
  console.error(`[steve] slack_event keys=${Object.keys(args).join(",")}`);
  // @slack/socket-mode v2: args = { ack, event, body, retry_num, retry_reason, accepts_response_payload }
  // args.event is the FULL envelope; args.body is the inner Slack body which has .event
  const inner = args.body?.event ?? args.event?.event ?? args.event;
  if (!inner) { console.error("[steve] no inner event"); return; }
  console.error(`[steve] inner.type=${inner.type} channel=${inner.channel} text="${(inner.text||"").slice(0,60)}"`);
  const ev = inner;
  if (ev.type !== "message" || !ev.text) return;
  if (ev.channel !== CHANNEL) return;
  if (!ev.text.startsWith(PING_PREFIX)) return;

  await appendAudit({
    direction: "in",
    at: new Date().toISOString(),
    payload: { kind: "message", channel: ev.channel, text: ev.text, ts: ev.ts },
  });

  const question = ev.text.slice(PING_PREFIX.length).trim();
  try {
    claudeStdout = await spawnClaude(`${question}\n\nReply with just the number, nothing else.`);
    const answer = extractAnswer(claudeStdout);
    const pongText = `${PONG_PREFIX} ${answer}`;
    const res = await web.chat.postMessage({ channel: CHANNEL, text: pongText });
    pongTs = res.ts;
    await appendAudit({
      direction: "out",
      at: new Date().toISOString(),
      payload: { kind: "post", channel: CHANNEL, text: pongText, ts: res.ts },
    });
  } catch (err) {
    claudeError = String(err);
    await appendAudit({
      direction: "out",
      at: new Date().toISOString(),
      payload: { kind: "error", error: String(err) },
    });
  }
});

await socket.start();
console.error(`[steve] bridge up, tmp=${tmp}, canary=${CANARY}`);

// Post the seed PING
const seed = await web.chat.postMessage({
  channel: CHANNEL,
  text: `${PING_PREFIX} 7 + 35 = ?`,
});
await appendAudit({
  direction: "out",
  at: new Date().toISOString(),
  payload: { kind: "seed", channel: CHANNEL, text: `${PING_PREFIX} 7 + 35 = ?`, ts: seed.ts },
});
console.error(`[steve] seed posted ts=${seed.ts}`);

// Wait up to 180s for pong
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  if (pongTs || claudeError) break;
  await new Promise((r) => setTimeout(r, 1000));
}

await socket.disconnect();

const auditText = await readFile(auditPath, "utf8");
const lines = auditText.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const seedRow = lines.find((l) => l.payload?.kind === "seed");
const inRow = lines.find((l) => l.direction === "in" && l.payload?.text?.startsWith(PING_PREFIX));
const pongRow = lines.find((l) => l.payload?.kind === "post" && l.payload?.text?.startsWith(PONG_PREFIX));

const report = {
  canary: CANARY,
  channel: CHANNEL,
  tmp,
  audit_rows: lines.length,
  seed_posted: !!seedRow,
  inbox_received: !!inRow,
  pong_posted: !!pongRow,
  pong_text: pongRow?.payload?.text ?? null,
  claude_error: claudeError,
  pass:
    !!seedRow &&
    !!inRow &&
    !!pongRow &&
    /\b42\b/.test(pongRow?.payload?.text ?? ""),
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
