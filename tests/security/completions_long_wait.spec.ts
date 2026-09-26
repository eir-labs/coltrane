// A completions call that thinks for a long time must be ended by the CHAIR's timeout, not by a
// transport limit nobody chose. Gig 6acd89e2 (22 Sep, eir-drafting): six fact seats died at exactly
// 301s with "fetch failed" — the global fetch's own 300s header wait — while the chair allowed 600s.
//
// A real 300s wait cannot run in a suite, so the laws pin the two halves that make it impossible:
// (1) the transport's only limit is the caller's signal: a server that holds its headers is waited
//     for as long as the signal allows, and the signal's abort is what ends it;
// (2) the selector hands the completions port that transport by default — cut the wire and the
//     global fetch (with its 300s) is back.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { longWaitFetch } from "../../src/long_wait_fetch.js";
import { completionsFetchFor, selectChairInvoker } from "../../src/invoker_selection.js";
import { createRegistry } from "../../src/index.js";
import { testAgent } from "../_support/agents.js";

function slowServer(holdMs: number) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ echoed: JSON.parse(body || "{}") }));
    }, holdMs));
  });
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`, close: () => server.close() })));
}

describe("the completions transport waits as long as the chair allows", () => {
  it("W1 — headers held past a short client limit still arrive; the reply is read whole", async () => {
    const s = await slowServer(1200);
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 5000);
      const res = await longWaitFetch(s.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }), signal: ac.signal });
      clearTimeout(t);
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({ echoed: { a: 1 } });
    } finally { s.close(); }
  });

  it("W2 — the caller's signal is what ends the wait, as an abort", async () => {
    const s = await slowServer(5000);
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 300);
      const t0 = Date.now();
      await expect(longWaitFetch(s.url, { method: "POST", body: "{}", signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally { s.close(); }
  });

  it("W3 — the selector gives the completions port the long-wait transport unless a test injects one", () => {
    expect(completionsFetchFor(undefined)).toBe(longWaitFetch);
    const injected = (async () => ({})) as unknown as typeof fetch;
    expect(completionsFetchFor(injected)).toBe(injected);
  });
});

describe("a seat built by the selector talks through the long-wait transport", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("W4 — on an unmodified runtime, a completions seat reaches its endpoint through node:http, not the runtime fetch", async () => {
    // The runtime's fetch announces itself with fetch-metadata headers; plain node:http does not. The
    // endpoint refuses the runtime fetch, as a stand-in for its 300s header limit.
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.headers["sec-fetch-mode"] !== undefined) { res.writeHead(500); res.end("runtime fetch used"); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "m", choices: [{ message: { role: "assistant", content: JSON.stringify({ claim: "c", source: "s" }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    try {
      const registry = createRegistry();
      registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { claim: { type: "string" } } }, required_fields: ["claim"] } as never);
      const invoke = selectChairInvoker({ COLTRANE_COMPLETIONS_URL: url, COLTRANE_COMPLETIONS_KEY: "k", COLTRANE_TIER_STANDARD: "m", COLTRANE_TRANSCRIPTS_DIR: "/tmp/coltrane-long-wait-transcripts" }, { registry, claude: {} });
      const out = await invoke({
        agent: testAgent({ slug: "seat", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", model_tier: "standard" }),
        phase: "p", role: "s", gig_id: "g-long-wait", inputs: [], gig_input: {}, output_types: ["note"],
      } as never);
      expect(out).toMatchObject({ claim: "c" });
    } finally { server.close(); }
  });

  it("W5 — a host that replaced the global fetch keeps it", () => {
    const hosts = (async () => ({})) as unknown as typeof fetch;
    vi.stubGlobal("fetch", hosts);
    expect(completionsFetchFor(undefined)).toBe(hosts);
  });
});
