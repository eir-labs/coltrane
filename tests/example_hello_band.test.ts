import { describe, it, expect } from "vitest";
import { runHelloBand } from "../examples/hello_band/run.js";

describe("hello_band example", () => {
  it("runs a gig end-to-end with zero external infrastructure", async () => {
    const result = await runHelloBand();
    expect(result.status).toBe("complete");
    expect(result.outputs.map((o) => o.domain_type)).toEqual(["raw-note", "summary"]);
  });

  it("produces validated outputs carrying the invoker's data", async () => {
    const result = await runHelloBand();
    const summary = result.outputs.find((o) => o.domain_type === "summary");
    expect((summary?.data as { gist?: string }).gist).toBe("loud room");
  });
});
