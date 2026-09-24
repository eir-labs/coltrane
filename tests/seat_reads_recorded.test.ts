// WHAT A SEAT PULLS IS RECORDED, like what it was pushed (spec.coltrane-sealed-inputs law 9, un-deferred
// at eir-drafting's request 24 Sep).
//
// THE GAP. A seat granted `output_query` can already reach sealed records through the engine surface —
// "give me 会社法595" is a grant away. But a chair's `input_refs` are stamped from the records the ENGINE
// fed it, so a record the seat PULLED was named nowhere: a rule quoting a statute did not name the bytes
// it read. Pull without a record is exactly the provenance a caller asserts rather than the engine stamps.
//
// THE CONTRACT. Every sealed record a seat reads through its tools is added to what that chair seals —
// re-hashed first, with the same check the dispatch door makes, so a record whose bytes no longer match
// is NOT stamped (and says so). Dedup against what was pushed. A seat that pulls nothing is unchanged.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootstrapServerDeps, dispatchTool, type ServerDeps } from "../src/server.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";

const CORE = ["Signal:SENSE", "Interpretation:INTERPRET", "Judgment:JUDGE", "Plan:PLAN", "Artifact:CREATE", "Verdict:VERIFY"].map(
  (s) => ({ slug: s.split(":")[0], primitive: s.split(":")[1], description: "", schema: {} }),
);
const ENV = ["COLTRANE_COMPLETIONS_URL", "COLTRANE_COMPLETIONS_KEY", "COLTRANE_TIER_STANDARD", "COLTRANE_LEDGER_PATH", "COLTRANE_OUTPUTS_DIR", "COLTRANE_COMPLETIONS_MAX_TOKENS"] as const;
const write = (dir: string, name: string, body: unknown) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), JSON.stringify(body)); };

/** A seat that calls `tool` once (if given), then seals `data`. */
function seat(tool: { name: string; args: Record<string, unknown> } | undefined, data: Record<string, unknown>) {
  const sent: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string }> };
    sent.push(body as never);
    const wire = (t: string) => body.tools?.map((x) => x.function.name).find((n) => n.endsWith(t)) ?? t;
    const n = sent.length;
    const call = (name: string, args: Record<string, unknown>) => ({
      role: "assistant", content: null,
      tool_calls: [{ id: `c${n}`, type: "function", function: { name: wire(name), arguments: JSON.stringify(args) } }],
    });
    const message = tool && n === 1 ? call(tool.name, tool.args)
      : (tool ? n === 2 : n === 1) ? call("output_write", { domain_type: "rule", data })
        : { role: "assistant", content: "done" };
    const reply = { model: "m", choices: [{ message, finish_reason: "content" in message ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
    return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) };
  });
  let target = tool?.args["output_id"];
  return { fn, sent, target: (id: string) => { if (tool) tool.args["output_id"] = (target = id); } };
}

describe("a seat's reads are recorded on what it seals", () => {
  let root: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coltrane-reads-"));
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const c of CORE) write(join(root, "core_types"), `${c.slug}.json`, c);
    write(join(root, "domain_types"), "provision.json", { slug: "provision", extends: "Signal", domain: "law", schema: { properties: { text: { type: "string" }, cites: { type: "array" } } }, required_fields: ["text"] });
    write(join(root, "domain_types"), "rule.json", { slug: "rule", extends: "Interpretation", domain: "law", schema: { properties: { says: { type: "string" } } }, required_fields: ["says"] });
    write(join(root, "agents"), "reader.json", { ...TEST_BEHAVIOR, slug: "reader", primitives: ["INTERPRET"], input_types: [], output_types: ["rule"], domain: "law", model_tier: "standard", allowed_tools: ["output_query"] });
    write(join(root, "standards"), "read-the-law.json", {
      slug: "read-the-law", domain: "law", status: "active", agent_slugs: ["reader"],
      phases: [{ name: "read", chairs: [{ role: "r", agent_slug: "reader", depends_on: [], input_contract: [], output_contract: ["rule"], required_skills: [] }] }],
    });
    for (const k of ENV) delete process.env[k];
    Object.assign(process.env, {
      COLTRANE_COMPLETIONS_URL: "https://model.test/v1", COLTRANE_COMPLETIONS_KEY: "k",
      COLTRANE_TIER_STANDARD: "m", COLTRANE_LEDGER_PATH: join(root, "ledger.jsonl"), COLTRANE_OUTPUTS_DIR: join(root, "outputs"),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(root, { recursive: true, force: true });
  });

  const provision = (deps: ServerDeps, text: string) =>
    deps.outputs.write({ core_type: "Signal", domain_type: "provision", domain: "law", gig_id: "gig-library", agent_slug: "fetcher", primitive: "SENSE", data: { text, source: "egov://x" } });

  const run = async (deps: ServerDeps) => dispatchTool("gig_dispatch", { standard_slug: "read-the-law", input: {}, wait: true }, deps);
  const sealedRule = (deps: ServerDeps) => deps.outputs.all().filter((o) => o.domain_type === "rule").at(-1)!;

  it("P1 — a provision the seat pulled is named in what it seals, and the walk reaches it", async () => {
    const s = seat({ name: "output_query", args: { output_id: "PLACEHOLDER" } }, { says: "self-dealing needs consent", claims: ["c"] });
    vi.stubGlobal("fetch", s.fn);
    const deps = bootstrapServerDeps(root);
    const p = provision(deps, "第五百九十五条 …");
    s.target(p.id);
    const res = await run(deps);
    expect(res.ok, String(res.error)).toBe(true);
    const rule = sealedRule(deps);
    expect(rule.input_refs, "the seat read it; the seal must name it").toContain(p.id);
    expect(rule.input_shas[rule.input_refs.indexOf(p.id)]).toBe(p.content_sha);
    expect(deps.outputs.trace(rule.id, { direction: "upstream" }).some((n) => n.id === p.id)).toBe(true);
  });

  it("P2 — a record whose bytes no longer hash to its content_sha is NOT stamped", async () => {
    const s = seat({ name: "output_query", args: { output_id: "PLACEHOLDER" } }, { says: "read a tampered record", claims: ["c"] });
    vi.stubGlobal("fetch", s.fn);
    const deps = bootstrapServerDeps(root);
    const p = provision(deps, "original bytes");
    s.target(p.id);
    (deps.outputs.get(p.id)!.data as Record<string, unknown>)["text"] = "altered after sealing";
    await run(deps);
    expect(sealedRule(deps).input_refs, "a record that is not what was sealed must not be named as read").not.toContain(p.id);
  });

  it("P3 — a seat that pulls nothing seals exactly what it did before", async () => {
    const s = seat(undefined, { says: "no reading", claims: ["c"] });
    vi.stubGlobal("fetch", s.fn);
    const deps = bootstrapServerDeps(root);
    provision(deps, "never read");
    await run(deps);
    expect(sealedRule(deps).input_refs).toEqual([]);
  });

  it("P5 — a ref that merely APPEARS in content is not a read: a wrong sha is never stamped", async () => {
    // A record's own data can carry something shaped like a reference (a citation index, a manifest).
    // What is stamped is what the ENGINE can verify: the store's record whose bytes still hash to the
    // sha reported. A pair naming a real record with the wrong sha is refused.
    const s = seat({ name: "output_query", args: { output_id: "PLACEHOLDER" } }, { says: "read a manifest", claims: ["c"] });
    vi.stubGlobal("fetch", s.fn);
    const deps = bootstrapServerDeps(root);
    const real = provision(deps, "the real provision");
    const manifest = deps.outputs.write({
      core_type: "Signal", domain_type: "provision", domain: "law", gig_id: "gig-library", agent_slug: "fetcher", primitive: "SENSE",
      data: { text: "a manifest that NAMES another record", source: "egov://m", cites: [{ id: real.id, content_sha: "deadbeef" }] },
    });
    s.target(manifest.id);
    await run(deps);
    const refs = sealedRule(deps).input_refs;
    expect(refs, "the record actually read is stamped").toContain(manifest.id);
    expect(refs, "a ref its CONTENT claims, with a sha that does not match, is not a read").not.toContain(real.id);
  });

  it("P6 — a record both fed to the chair and read by it is named once", async () => {
    write(join(root, "standards"), "read-the-law.json", {
      slug: "read-the-law", domain: "law", status: "active", agent_slugs: ["reader"], input_types: ["provision"],
      phases: [{ name: "read", chairs: [{ role: "r", agent_slug: "reader", depends_on: [], input_contract: ["provision"], output_contract: ["rule"], required_skills: [] }] }],
    });
    write(join(root, "agents"), "reader.json", { ...TEST_BEHAVIOR, slug: "reader", primitives: ["INTERPRET"], input_types: ["provision"], output_types: ["rule"], domain: "law", model_tier: "standard", allowed_tools: ["output_query"] });
    const s = seat({ name: "output_query", args: { output_id: "PLACEHOLDER" } }, { says: "fed and read", claims: ["c"] });
    vi.stubGlobal("fetch", s.fn);
    const deps = bootstrapServerDeps(root);
    const p = provision(deps, "fed to the chair, then read again");
    s.target(p.id);
    const res = await dispatchTool("gig_dispatch", { standard_slug: "read-the-law", input: { provision: { $output: p.id } }, wait: true }, deps);
    expect(res.ok, String(res.error)).toBe(true);
    expect(sealedRule(deps).input_refs.filter((r) => r === p.id).length).toBe(1);
  });

  it("P4 — the same record read twice is named once", async () => {
    const sent: string[] = [];
    let pid = "";
    const fn = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function: { name: string } }> };
      const wire = (t: string) => body.tools?.map((x) => x.function.name).find((n) => n.endsWith(t)) ?? t;
      sent.push("x");
      const n = sent.length;
      const message = n <= 2
        ? { role: "assistant", content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: wire("output_query"), arguments: JSON.stringify({ output_id: pid }) } }] }
        : n === 3
          ? { role: "assistant", content: null, tool_calls: [{ id: "w", type: "function", function: { name: wire("output_write"), arguments: JSON.stringify({ domain_type: "rule", data: { says: "twice", claims: ["c"] } }) } }] }
          : { role: "assistant", content: "done" };
      const reply = { model: "m", choices: [{ message, finish_reason: "content" in message ? "stop" : "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 1 } };
      return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) };
    });
    vi.stubGlobal("fetch", fn);
    const deps = bootstrapServerDeps(root);
    const p = provision(deps, "read me twice");
    pid = p.id;
    await run(deps);
    const refs = sealedRule(deps).input_refs;
    expect(refs.filter((r) => r === p.id).length).toBe(1);
  });
});
