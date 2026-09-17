// RED — trimming a chat-completions base URL is linear, whatever the URL contains.
//
// CodeQL js/polynomial-redos on PR eir-labs/coltrane#534 (alert 13, 2026-09-18): makeChatCompletionsPort
// builds its endpoint with `opts.baseUrl.replace(/\/+$/, "")`. On a base URL holding a long run of
// slashes that is NOT at the end, the regex retries the run from every start position: measured 169 ms
// at 10,000 slashes, 675 ms at 20,000, 2,707 ms at 40,000 — quadratic. The base URL is configuration
// (COLTRANE_COMPLETIONS_URL), so this is not remote input, but a port constructor that can stall on its
// own argument is a defect, and the scanner fails the PR check on it.
import { describe, it, expect } from "vitest";
import { makeChatCompletionsPort } from "../src/chat_completions_port.js";

type Req = { model: string; messages: unknown[]; tools: unknown[] };

async function urlCalled(baseUrl: string): Promise<string> {
  let seen = "";
  const port = makeChatCompletionsPort({
    baseUrl,
    apiKey: "k",
    fetchFn: (async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch,
  } as never);
  await port({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] } as Req as never);
  return seen;
}

describe("the chat-completions base URL is trimmed in linear time", () => {
  it("a base URL with 40,000 interior slashes builds its port in well under a second", () => {
    const pathological = "https://example.invalid" + "/".repeat(40_000) + "x";
    const t0 = performance.now();
    makeChatCompletionsPort({ baseUrl: pathological, apiKey: "k", fetchFn: (async () => new Response("{}")) as unknown as typeof fetch } as never);
    const ms = performance.now() - t0;
    expect(ms, `trimming the base URL took ${Math.round(ms)} ms: the trailing-slash regex backtracks quadratically over interior slashes`).toBeLessThan(200);
  });

  it("control — trailing slashes are still stripped before /chat/completions", async () => {
    // Green today. A fix that stops trimming, or trims interior slashes, goes red.
    expect(await urlCalled("https://api.deepseek.com///")).toBe("https://api.deepseek.com/chat/completions");
    expect(await urlCalled("https://host.invalid/v1")).toBe("https://host.invalid/v1/chat/completions");
  });
});
