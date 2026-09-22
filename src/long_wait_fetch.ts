// A fetch for chat-completions calls that may think for a long time before answering.
//
// THE DEFECT (gig 6acd89e2, 22 Sep, found by eir-drafting): the port used the global fetch, whose
// built-in client gives up when response HEADERS take longer than 300s. A non-streamed completion
// sends no headers until the whole answer exists, and a reasoning model working through ~150KB of
// documents thinks past five minutes — so all six fact seats died at 301s with "fetch failed", while
// COLTRANE_CHAIR_TIMEOUT_MS=600000 and the endpoint's own 900s never came into play. The chair's
// timeout must be the one that rules.
//
// This is node:http(s) with NO header or idle timeout of its own: the caller's AbortSignal (the turn
// loop's per-call timeout) is the only thing that ends the wait. It returns the small slice of the
// Response interface the port reads (ok, status, json, text). Server-side only, which is why the
// SELECTOR hands it to the port rather than the port importing it — the port stays transport-neutral.
import * as http from "node:http";
import * as https from "node:https";

export const longWaitFetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal | null }) => {
  const url = new URL(String(input));
  const mod = url.protocol === "https:" ? https : http;
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) throw abortError();
  return await new Promise((resolve, reject) => {
    const req = mod.request(url, { method: init?.method ?? "GET", headers: init?.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", (e) => reject(e));
      res.on("end", () => {
        signal?.removeEventListener("abort", onAbort);
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => text,
          json: async () => JSON.parse(text) as unknown,
        });
      });
    });
    const onAbort = (): void => { req.destroy(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e) => { signal?.removeEventListener("abort", onAbort); reject(e); });
    if (init?.body !== undefined) req.write(String(init.body));
    req.end();
  });
}) as unknown as typeof fetch;

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}
