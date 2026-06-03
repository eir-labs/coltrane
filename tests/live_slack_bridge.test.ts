// slack-bridge tests — envelope translation + audit semantics.
//
// We don't open real socket connections in unit tests; the bridge accepts
// fake web/socket clients via opts so we can exercise the wire without a
// network.

import { describe, it, expect, vi } from "vitest";
import { envelopeToInbox, createSlackBridge } from "../src/live/slack_bridge.js";

describe("envelopeToInbox", () => {
  it("translates a message event", () => {
    const env = {
      type: "events_api",
      payload: {
        event: {
          type: "message",
          channel: "C123",
          user: "U999",
          text: "hello",
          ts: "1700000000.000100",
        },
      },
    };
    const inbox = envelopeToInbox(env);
    expect(inbox?.kind).toBe("message");
    expect(inbox?.channel).toBe("C123");
    expect(inbox?.text).toBe("hello");
    expect(inbox?.ts).toBe("1700000000.000100");
  });

  it("translates an app_mention event", () => {
    const env = {
      type: "events_api",
      payload: {
        event: {
          type: "app_mention",
          channel: "C123",
          user: "U999",
          text: "<@U_BOT> hi",
          ts: "1700000000.000200",
        },
      },
    };
    expect(envelopeToInbox(env)?.kind).toBe("app_mention");
  });

  it("translates a reaction_added event", () => {
    const env = {
      type: "events_api",
      payload: {
        event: {
          type: "reaction_added",
          user: "U999",
          reaction: "+1",
          item: { channel: "C123", ts: "1700000000.000300" },
        },
      },
    };
    const inbox = envelopeToInbox(env);
    expect(inbox?.kind).toBe("reaction_added");
    expect(inbox?.reaction).toBe("+1");
    expect(inbox?.channel).toBe("C123");
    expect(inbox?.ts).toBe("1700000000.000300");
  });

  it("returns null for non-events_api envelopes", () => {
    expect(envelopeToInbox({ type: "hello" })).toBeNull();
    expect(envelopeToInbox(null)).toBeNull();
    expect(envelopeToInbox({})).toBeNull();
  });

  it("returns null for unsupported event types", () => {
    const env = {
      type: "events_api",
      payload: { event: { type: "team_join" } },
    };
    expect(envelopeToInbox(env)).toBeNull();
  });
});

describe("createSlackBridge", () => {
  function makeFakes() {
    const audit: string[] = [];
    const postMessage = vi.fn(async (_args: unknown) => ({ ok: true, ts: "1700.001" }));
    const reactionsAdd = vi.fn(async (_args: unknown) => ({ ok: true }));
    const onHandlers: Record<string, (env: unknown) => Promise<void>> = {};

    const fakeWeb = {
      chat: { postMessage },
      reactions: { add: reactionsAdd },
    };
    const fakeSocket = {
      on: (name: string, fn: (env: unknown) => Promise<void>) => {
        onHandlers[name] = fn;
      },
      start: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
    };
    return { audit, postMessage, reactionsAdd, fakeWeb, fakeSocket, onHandlers };
  }

  it("appends an audit entry on post", async () => {
    const fakes = makeFakes();
    const bridge = createSlackBridge({
      steve_uuid: "u-1",
      bot_token: "xoxb-fake",
      app_token: "xapp-fake",
      audit_path: "/tmp/unused",
      on_inbox: async () => {},
      audit_sink: async (line) => {
        fakes.audit.push(line);
      },
      web_client: fakes.fakeWeb as never,
      socket_client: fakes.fakeSocket as never,
    });
    const res = await bridge.post("C123", "hi");
    expect(res.ok).toBe(true);
    expect(fakes.postMessage).toHaveBeenCalledOnce();
    expect(fakes.audit).toHaveLength(1);
    const entry = JSON.parse(fakes.audit[0]!);
    expect(entry.direction).toBe("out");
    expect(entry.steve_uuid).toBe("u-1");
    expect(entry.payload.action).toBe("post");
  });

  it("appends an audit entry on react", async () => {
    const fakes = makeFakes();
    const bridge = createSlackBridge({
      steve_uuid: "u-2",
      bot_token: "xoxb-fake",
      app_token: "xapp-fake",
      audit_path: "/tmp/unused",
      on_inbox: async () => {},
      audit_sink: async (line) => {
        fakes.audit.push(line);
      },
      web_client: fakes.fakeWeb as never,
      socket_client: fakes.fakeSocket as never,
    });
    await bridge.react("C123", "1700.001", "raised_hands");
    expect(fakes.reactionsAdd).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1700.001",
      name: "raised_hands",
    });
    const entry = JSON.parse(fakes.audit[0]!);
    expect(entry.payload.action).toBe("react");
    expect(entry.payload.emoji).toBe("raised_hands");
  });

  it("fans inbound socket envelopes to on_inbox + audit", async () => {
    const fakes = makeFakes();
    const inbox: string[] = [];
    createSlackBridge({
      steve_uuid: "u-3",
      bot_token: "xoxb-fake",
      app_token: "xapp-fake",
      audit_path: "/tmp/unused",
      on_inbox: async (ev) => {
        inbox.push(ev.kind);
      },
      audit_sink: async (line) => {
        fakes.audit.push(line);
      },
      web_client: fakes.fakeWeb as never,
      socket_client: fakes.fakeSocket as never,
    });
    const ack = vi.fn(async () => {});
    await fakes.onHandlers["slack_event"]!(
      // mimic the (envelope, ack) signature the @slack/socket-mode lib uses
      {
        type: "events_api",
        payload: { event: { type: "message", channel: "C", user: "U", text: "x", ts: "1.0" } },
      } as never,
    );
    expect(inbox).toEqual(["message"]);
    expect(fakes.audit).toHaveLength(1);
    const entry = JSON.parse(fakes.audit[0]!);
    expect(entry.direction).toBe("in");
    expect(entry.payload.kind).toBe("message");
    expect(ack).not.toHaveBeenCalled(); // ack is optional in our handler
  });
});
