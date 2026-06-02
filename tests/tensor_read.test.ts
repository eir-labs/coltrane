import { describe, it, expect } from "vitest";
import {
  emptyTensorRead,
  addChannel,
  readChannel,
  compareTensorReads,
  channelCount,
  uniqueChannels,
  TensorReadError,
  type TensorRead,
} from "../src";

function withChannels(gig_id: string, channels: { channel: string; produced_by: string; payload: unknown }[]): TensorRead {
  let t = emptyTensorRead(gig_id);
  for (const c of channels) t = addChannel(t, c);
  return t;
}

describe("TensorRead — multi-channel container", () => {
  it("empty tensor has zero channels", () => {
    const t = emptyTensorRead("gig-1");
    expect(channelCount(t)).toBe(0);
  });

  it("addChannel appends without collapsing", () => {
    const t = withChannels("gig-1", [
      { channel: "score", produced_by: "composer-agent", payload: { phases: 3 } },
      { channel: "song",  produced_by: "modulation_path", payload: { keys: ["C", "G"] } },
    ]);
    expect(channelCount(t)).toBe(2);
    expect(readChannel(t, "score")?.payload).toEqual({ phases: 3 });
    expect(readChannel(t, "song")?.payload).toEqual({ keys: ["C", "G"] });
  });

  it("rejects duplicate channel name", () => {
    const t = withChannels("gig-1", [
      { channel: "score", produced_by: "a", payload: 1 },
    ]);
    expect(() =>
      addChannel(t, { channel: "score", produced_by: "b", payload: 2 }),
    ).toThrow(TensorReadError);
  });
});

describe("compareTensorReads — preserves per-channel structure (no scalar collapse)", () => {
  it("returns a per-channel diff array, never a single boolean verdict", () => {
    const a = withChannels("gig-a", [
      { channel: "score", produced_by: "x", payload: {} },
      { channel: "song",  produced_by: "y", payload: {} },
    ]);
    const b = withChannels("gig-b", [
      { channel: "score",  produced_by: "x", payload: {} },
      { channel: "output", produced_by: "z", payload: {} },
    ]);
    const d = compareTensorReads(a, b);
    expect(d.channels).toHaveLength(3); // score (both) + song (a-only) + output (b-only)
    expect(d).not.toHaveProperty("verdict");
    expect(d).not.toHaveProperty("pass");
  });

  it("flags channel-presence asymmetries: a_only / b_only / present_in_both", () => {
    const a = withChannels("gig-a", [
      { channel: "score", produced_by: "x", payload: {} },
      { channel: "song",  produced_by: "y", payload: {} },
    ]);
    const b = withChannels("gig-b", [
      { channel: "score",  produced_by: "x", payload: {} },
      { channel: "output", produced_by: "z", payload: {} },
    ]);
    const d = compareTensorReads(a, b);
    const u = uniqueChannels(d);
    expect(u.in_both).toBe(1);
    expect(u.a_only).toBe(1);
    expect(u.b_only).toBe(1);
  });

  it("attribution carried in the diff (produced_by per side)", () => {
    const a = withChannels("gig-a", [
      { channel: "score", produced_by: "composer-v1", payload: {} },
    ]);
    const b = withChannels("gig-b", [
      { channel: "score", produced_by: "composer-v2", payload: {} },
    ]);
    const d = compareTensorReads(a, b);
    const sd = d.channels.find((c) => c.channel === "score")!;
    expect(sd.a_produced_by).toBe("composer-v1");
    expect(sd.b_produced_by).toBe("composer-v2");
  });
});

describe("uniqueChannels — feature, not verdict", () => {
  it("returns counts as numbers, not pass/fail", () => {
    const a = withChannels("a", [{ channel: "x", produced_by: "p", payload: 1 }]);
    const b = withChannels("b", [{ channel: "x", produced_by: "p", payload: 1 }]);
    const d = compareTensorReads(a, b);
    const u = uniqueChannels(d);
    expect(typeof u.in_both).toBe("number");
    expect(typeof u.a_only).toBe("number");
    expect(typeof u.b_only).toBe("number");
  });
});
