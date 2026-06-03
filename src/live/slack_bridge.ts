// slack ⇄ claude-code bridge primitive.
//
// One bridge instance corresponds to one Steve (one bot user / one socket
// connection). The bridge:
//   - opens a Socket Mode connection
//   - translates inbound slack events into "inbox events" the agent thread
//     consumes (channel msg, mention, reaction, DM)
//   - exposes post(channel, text) + react(channel, ts, emoji) for outbound
//   - appends every inbound and outbound to the Steve's audit.jsonl
//
// Vocabulary: identifiers are neutral ("inbox", "audit", "steve_uuid").
// No methodology terms in shipped code.

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { appendFile } from "node:fs/promises";

export type InboxEventKind = "message" | "app_mention" | "reaction_added" | "reaction_removed" | "im";

export interface InboxEvent {
  kind: InboxEventKind;
  channel?: string | undefined;
  user?: string | undefined;
  text?: string | undefined;
  ts?: string | undefined;
  thread_ts?: string | undefined;
  reaction?: string | undefined;
  raw: unknown;
  received_at: string;
}

export interface AuditEntry {
  direction: "in" | "out";
  at: string;
  steve_uuid: string;
  payload: unknown;
}

export interface SlackBridgeOptions {
  steve_uuid: string;
  bot_token: string;
  app_token: string;
  audit_path: string;
  on_inbox: (ev: InboxEvent) => void | Promise<void>;
  /** Optional override for the appendFile sink — tests inject a memory sink. */
  audit_sink?: (line: string) => Promise<void>;
  /** Optional override for the WebClient — tests inject a fake. */
  web_client?: Pick<WebClient, "chat" | "reactions">;
  /** Optional override for the socket client — tests inject a fake. */
  socket_client?: Pick<SocketModeClient, "on" | "start" | "disconnect">;
}

export interface SlackBridge {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  post: (channel: string, text: string, thread_ts?: string) => Promise<{ ok: boolean; ts?: string | undefined }>;
  react: (channel: string, ts: string, emoji: string) => Promise<{ ok: boolean }>;
}

/** Parse a raw socket-mode event envelope into an InboxEvent.
 * Returns null for envelopes the agent doesn't consume (acks, hello, etc). */
export function envelopeToInbox(envelope: unknown): InboxEvent | null {
  if (!envelope || typeof envelope !== "object") return null;
  const env = envelope as Record<string, unknown>;
  const type = env["type"];
  if (type !== "events_api") return null;
  const payload = env["payload"] as Record<string, unknown> | undefined;
  if (!payload) return null;
  const event = payload["event"] as Record<string, unknown> | undefined;
  if (!event) return null;
  const evType = event["type"] as string | undefined;
  if (!evType) return null;

  const base = {
    received_at: new Date().toISOString(),
    raw: event,
  };

  if (evType === "message" || evType === "app_mention") {
    return {
      ...base,
      kind: evType === "app_mention" ? "app_mention" : "message",
      channel: event["channel"] as string | undefined,
      user: event["user"] as string | undefined,
      text: event["text"] as string | undefined,
      ts: event["ts"] as string | undefined,
      thread_ts: event["thread_ts"] as string | undefined,
    };
  }
  if (evType === "reaction_added" || evType === "reaction_removed") {
    const item = event["item"] as Record<string, unknown> | undefined;
    return {
      ...base,
      kind: evType,
      channel: (item?.["channel"] as string | undefined) ?? undefined,
      user: event["user"] as string | undefined,
      ts: (item?.["ts"] as string | undefined) ?? undefined,
      reaction: event["reaction"] as string | undefined,
    };
  }
  return null;
}

/** Construct (do not start) a Slack bridge for a single Steve. */
export function createSlackBridge(opts: SlackBridgeOptions): SlackBridge {
  const web = (opts.web_client ?? new WebClient(opts.bot_token)) as WebClient;
  const socket = (opts.socket_client ?? new SocketModeClient({ appToken: opts.app_token })) as SocketModeClient;

  const writeAudit = async (entry: AuditEntry) => {
    const line = JSON.stringify(entry) + "\n";
    if (opts.audit_sink) {
      await opts.audit_sink(line);
      return;
    }
    await appendFile(opts.audit_path, line, "utf8");
  };

  const handleEnvelope = async (envelope: unknown, ack?: () => Promise<void>) => {
    if (ack) await ack();
    const inbox = envelopeToInbox(envelope);
    if (!inbox) return;
    await writeAudit({
      direction: "in",
      at: inbox.received_at,
      steve_uuid: opts.steve_uuid,
      payload: inbox,
    });
    await opts.on_inbox(inbox);
  };

  socket.on("slack_event", handleEnvelope);

  return {
    async start() {
      await socket.start();
    },
    async stop() {
      await socket.disconnect();
    },
    async post(channel, text, thread_ts) {
      const args: { channel: string; text: string; thread_ts?: string } = { channel, text };
      if (thread_ts !== undefined) args.thread_ts = thread_ts;
      const res = await web.chat.postMessage(args);
      await writeAudit({
        direction: "out",
        at: new Date().toISOString(),
        steve_uuid: opts.steve_uuid,
        payload: { action: "post", channel, text, thread_ts, ts: res.ts },
      });
      return { ok: !!res.ok, ts: res.ts };
    },
    async react(channel, ts, emoji) {
      const res = await web.reactions.add({ channel, timestamp: ts, name: emoji });
      await writeAudit({
        direction: "out",
        at: new Date().toISOString(),
        steve_uuid: opts.steve_uuid,
        payload: { action: "react", channel, ts, emoji },
      });
      return { ok: !!res.ok };
    },
  };
}
