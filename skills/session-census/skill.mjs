// The deterministic half of a session review (determinism 1.0): read one Claude Code transcript and
// COUNT it. No model, no judgement — every number here is a fact a reviewer can be held to, and the
// review seat downstream may claim nothing this census does not carry.
//
// A transcript is JSONL, one record per line, and large (this session's is 23MB), so it is streamed
// line by line and never held whole. What comes out is small enough for a seat to read.
import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

const TOOL_BUCKET = (name) =>
  name.startsWith("mcp__") ? `mcp:${name.split("__")[1] ?? "?"}` : name;

export default async function run(input) {
  // A ROOT skill chair is handed the gig payload as the runtime holds it: keyed by type slug
  // (`{"session-target": {transcript}}`). A chair fed by upstream outputs gets the merged data
  // instead. Accept both rather than depending on where in a standard this chair happens to sit.
  const target = (input && typeof input === "object" && input["session-target"]) || input || {};
  const path = target && target.transcript ? String(target.transcript) : "";
  // A census that cannot read its transcript THROWS: returning an explanation object would fail the
  // seal's schema check instead, and the caller would read "required property 'records' missing"
  // rather than the reason. Fail with the reason.
  if (!path) throw new Error("session-census: no `transcript` path in the input");

  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    throw new Error(`session-census: cannot read "${path}"`);
  }

  const tools = new Map();
  const operatorByText = new Map();
  const denials = [];
  const errors = [];
  let records = 0;
  let assistantTurns = 0;
  let firstTs = null;
  let lastTs = null;
  let interruptions = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let maxContext = 0;
  const seenMessageIds = new Set();

  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    records += 1;
    const ts = typeof r.timestamp === "string" ? r.timestamp : null;
    if (ts) { if (firstTs === null) firstTs = ts; lastTs = ts; }

    if (r.type === "user") {
      const c = r.message?.content;
      // A STRING content is the operator typing; a list is a tool result coming back.
      if (typeof c === "string") {
        const text = c.trim();
        // The harness injects its own user-shaped records (command output, reminders). An operator
        // message is what is left once those are excluded — named, so the exclusion is auditable.
        const injected =
          text.startsWith("<command-") || text.startsWith("<local-command") ||
          text.startsWith("[Request interrupted") || text.includes("<system-reminder>") ||
          // Harness-delivered, not typed by the operator: a background task reporting in, and a message
          // from another session. Counting either as the operator's would credit them with decisions
          // nobody made.
          text.startsWith("<task-notification>") || text.startsWith("<cross-session-message");
        if (text.startsWith("[Request interrupted")) interruptions += 1;
        // A repeated message (a cron firing the same prompt) is ONE decision said many times, not many
        // decisions: collapse it to a count, first and last seen. Otherwise the census is mostly echo,
        // and a seat reading it would weigh the loop's cadence as if it were the operator's attention.
        if (!injected && text) {
          const key = text.length > 400 ? `${text.slice(0, 400)}…` : text;
          const prior = operatorByText.get(key);
          if (prior) { prior.count += 1; prior.last = ts; }
          else operatorByText.set(key, { text: key, count: 1, first: ts, last: ts });
        }
      }
    }

    if (r.type === "assistant") {
      const msg = r.message ?? {};
      const id = msg.id;
      if (id && !seenMessageIds.has(id)) {
        seenMessageIds.add(id);
        assistantTurns += 1;
        const u = msg.usage ?? {};
        inputTokens += u.input_tokens ?? 0;
        outputTokens += u.output_tokens ?? 0;
        cacheRead += u.cache_read_input_tokens ?? 0;
        cacheWrite += u.cache_creation_input_tokens ?? 0;
        const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (ctx > maxContext) maxContext = ctx;
      }
      for (const b of msg.content ?? []) {
        if (b && b.type === "tool_use" && typeof b.name === "string") {
          const k = TOOL_BUCKET(b.name);
          tools.set(k, (tools.get(k) ?? 0) + 1);
        }
      }
    }

    // A tool result carrying a refusal or an error is evidence a reviewer should not have to find.
    if (r.type === "user" && Array.isArray(r.message?.content)) {
      for (const b of r.message.content) {
        if (!b || b.type !== "tool_result") continue;
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        if (/permission[^\n]{0,40}denied|Blocked by classifier/i.test(text)) {
          denials.push({ at: ts, text: text.slice(0, 300) });
        } else if (b.is_error) {
          errors.push({ at: ts, text: text.slice(0, 300) });
        }
      }
    }
  }

  return {
    // The Signal core requires a non-empty `source`: what this reading is OF. For a census that is the
    // transcript it counted, named so a sealed census can be traced back to the file it read.
    source: `session-census://${path}`,
    transcript: path,
    bytes,
    records,
    span: { first: firstTs, last: lastTs },
    turns: {
      assistant: assistantTurns,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      max_context_tokens: maxContext,
    },
    tools: [...tools.entries()].sort((a, b) => b[1] - a[1]).map(([name, calls]) => ({ name, calls })),
    operator_messages: [...operatorByText.values()],
    interruptions,
    denials,
    errors: errors.slice(0, 40),
  };
}
