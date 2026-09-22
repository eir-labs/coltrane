// RED — Stage A of the cheap band: an OpenAI-compatible invoker whose HANDS ARE MCP.
//
// WHY THIS EXISTS. src/bifrost_invoker.ts is already a complete second AgentInvoker, and it is
// useless for research/synthesis because of one self-declared limit (bifrost_invoker.ts:5):
// "v0 is deliberately text-in/JSON-out — no tools, no MCP; a chair that needs tools keeps the
// Claude invoker." A research chair must retrieve, vet, seal and write — every one a governed
// verb over MCP. A toolless cheap invoker cannot do the work at all.
//
// AND THIS IS THE CHEAP HALF. The expensive part of a model-agnostic runtime is the HOST tool
// surface — Bash, Edit, filesystem, permissions. An invoker whose only hands are MCP inherits
// governance from the server and needs none of that machinery. So it REFUSES a host-builtin
// grant by name, which defers that work honestly instead of pretending it is solved.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { createRegistry, type DomainType, type Agent, type AgentInvocationContext } from "../src";
import {
  loadCompletions,
  fakeCompletions,
  recordingTools,
  saysJson,
  callsTool,
  type CompletionsModule,
  type McpToolDef,
} from "./spec_completions_fixtures.js";

const SRC = new URL("../src/", import.meta.url).pathname;

const note: DomainType = {
  slug: "research-note",
  extends: "Signal",
  domain: "research",
  schema: { properties: { claim: { type: "string" }, source: { type: "string" } } },
  required_fields: ["claim", "source"],
};

/** A research chair: MCP hands only. */
const researcher: Agent = {
  ...TEST_BEHAVIOR,
  slug: "researcher",
  primitives: ["SENSE"],
  input_types: [],
  output_types: ["research-note"],
  domain: "research",
  model_tier: "economy",
  allowed_tools: ["mcp__coltrane__output_query", "output_write"],
};

/** The same chair, reaching for a host builtin. */
const shellUser: Agent = { ...researcher, slug: "shell-user", allowed_tools: ["Bash", "mcp__coltrane__output_query"] };

// AMENDED 2026-09-22 (tests/completions_seal.test.ts K7): a granted tool the source does not LIST is now
// refused before any model call, where it used to be silently not offered. `researcher` grants
// output_write, so the source these laws hand it must list output_write — the laws' own subjects are
// unchanged; the fixture no longer relies on a grant quietly vanishing.
const TOOLS: McpToolDef[] = [
  { name: "mcp__coltrane__output_query", description: "read sealed outputs", inputSchema: { type: "object", properties: { gig_id: { type: "string" } }, required: ["gig_id"] } },
  { name: "mcp__coltrane__output_write", description: "seal an output", inputSchema: { type: "object", properties: { data: { type: "object" } } } },
];

function ctxFor(agent: Agent): AgentInvocationContext {
  return { agent, phase: "gather", inputs: [], gig_input: { goal: "find one claim" } };
}

function opts(over: Record<string, unknown> = {}) {
  const registry = createRegistry();
  registry.registerType(note);
  return { baseUrl: "https://endpoint.test/v1", apiKey: "k", registry, tierMap: { economy: "cheap-model-1" }, ...over };
}

describe("LAW 1 — it is an AgentInvoker, and it answers the typed blob", () => {
  it("returns the chair's output shape from a plain completion", async () => {
    const C: CompletionsModule = await loadCompletions();
    const { fn } = fakeCompletions([saysJson({ claim: "the sky is blue", source: "https://x.test/a" })]);
    const { source } = recordingTools(TOOLS);
    const invoke = C.makeCompletionsInvoker(opts({ fetchFn: fn, tools: source }));
    const out = await invoke(ctxFor(researcher));
    expect(out).toEqual({ claim: "the sky is blue", source: "https://x.test/a" });
  });

  it("sends the tier's concrete model, never a tier name", async () => {
    const C: CompletionsModule = await loadCompletions();
    const { fn, calls } = fakeCompletions([saysJson({ claim: "c", source: "s" })]);
    const { source } = recordingTools(TOOLS);
    await C.makeCompletionsInvoker(opts({ fetchFn: fn, tools: source }))(ctxFor(researcher));
    expect(calls[0]?.body["model"], "the wire carried a tier instead of a model").toBe("cheap-model-1");
  });
});

describe("LAW 2/3 — host builtins refused BY NAME; MCP chairs run", () => {
  it("a host-builtin grant is refused by name, before any network call", async () => {
    const C: CompletionsModule = await loadCompletions();
    const { fn, calls } = fakeCompletions([saysJson({ claim: "c", source: "s" })]);
    const { source } = recordingTools(TOOLS);
    const invoke = C.makeCompletionsInvoker(opts({ fetchFn: fn, tools: source }));

    const res = (await invoke(ctxFor(shellUser))) as Record<string, unknown>;
    expect(res["ok"], "a chair holding Bash was run on the cheap path").toBe(false);
    expect(res["refusal"]).toBe("host_tool_denied");
    // NAMING the tool is the difference between a usable refusal and a shrug.
    expect(String(res["message"] ?? "")).toContain("Bash");
    expect(calls.length, "a refused chair still reached the wire").toBe(0);
  });

  it("an MCP-only chair RUNS, and its tool call reaches the surface", async () => {
    // THE GUARD ON THE LAW ABOVE. Without this, the refusal law could be refusing everything
    // and proving nothing — the exact defect a reviewer found in the reside mount law.
    const C: CompletionsModule = await loadCompletions();
    const { fn } = fakeCompletions([
      callsTool("mcp__coltrane__output_query", { gig_id: "g1" }),
      saysJson({ claim: "found it", source: "sealed://g1" }),
    ]);
    const { source, called } = recordingTools(TOOLS, { mcp__coltrane__output_query: { rows: 1 } });
    const invoke = C.makeCompletionsInvoker(opts({ fetchFn: fn, tools: source }));

    const out = await invoke(ctxFor(researcher));
    expect(called.map((c) => c.name), "the tool call never reached the surface").toEqual([
      "mcp__coltrane__output_query",
    ]);
    expect(called[0]?.args).toEqual({ gig_id: "g1" });
    expect(out).toEqual({ claim: "found it", source: "sealed://g1" });
  });

  it("a chair with tool grants and NO tool source is refused, not run blind", async () => {
    const C: CompletionsModule = await loadCompletions();
    const { fn, calls } = fakeCompletions([saysJson({ claim: "c", source: "s" })]);
    const res = (await C.makeCompletionsInvoker(opts({ fetchFn: fn }))(ctxFor(researcher))) as Record<string, unknown>;
    expect(res["refusal"]).toBe("no_tool_source");
    expect(calls.length).toBe(0);
  });
});

describe("LAW 4 — the MCP↔OpenAI conversion is lossless", () => {
  it("an MCP tool becomes a function definition and its name reads back", async () => {
    const C: CompletionsModule = await loadCompletions();
    const def = C.toFunctionDef(TOOLS[0]!);
    expect(def.type).toBe("function");
    expect(def.function.parameters, "the tool's schema was not carried over").toEqual(TOOLS[0]!.inputSchema);
    expect(C.fromFunctionName(def.function.name), "the round trip lost the tool's identity").toBe(
      TOOLS[0]!.name,
    );
  });

  it("a tool whose name is not OpenAI-safe still round-trips", async () => {
    const C: CompletionsModule = await loadCompletions();
    const odd: McpToolDef = { name: "mcp__a.b__c-d", inputSchema: { type: "object" } };
    expect(C.fromFunctionName(C.toFunctionDef(odd).function.name)).toBe(odd.name);
  });
});

describe("LAW 8 — a transport failure is a typed refusal, never a throw", () => {
  it("a non-2xx becomes {ok:false, refusal:'transport_failed'}", async () => {
    const C: CompletionsModule = await loadCompletions();
    const { fn } = fakeCompletions([{ error: "upstream is down" }], 502);
    const { source } = recordingTools(TOOLS);
    let threw: unknown = null;
    let res: Record<string, unknown> = {};
    try {
      res = (await C.makeCompletionsInvoker(opts({ fetchFn: fn, tools: source }))(ctxFor(researcher))) as Record<string, unknown>;
    } catch (e) {
      threw = e;
    }
    expect(threw, "the invoker threw instead of refusing").toBe(null);
    expect(res["refusal"]).toBe("transport_failed");
  });

  it("a tier with no configured model refuses 'unresolved_tier' rather than guessing", async () => {
    const C: CompletionsModule = await loadCompletions();
    const { fn, calls } = fakeCompletions([saysJson({ claim: "c", source: "s" })]);
    const { source } = recordingTools(TOOLS);
    const res = (await C.makeCompletionsInvoker(opts({ fetchFn: fn, tools: source, tierMap: {} }))(
      ctxFor(researcher),
    )) as Record<string, unknown>;
    expect(res["refusal"]).toBe("unresolved_tier");
    expect(calls.length, "it guessed a model and spent anyway").toBe(0);
  });
});

describe("LAW 10 — the engine names no platform and reads no environment", () => {
  it("the invoker reads no process.env and names no vendor", () => {
    const path = join(SRC, "completions_invoker.ts");
    expect(existsSync(path), "src/completions_invoker.ts does not exist yet").toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text, "the invoker reads the environment; config belongs in opts").not.toMatch(
      /process\.env\[/,
    );
    for (const name of ["openrouter", "openai.com", "anthropic", "bifrost", "deepseek"]) {
      expect(text.toLowerCase(), `the engine names the provider "${name}"`).not.toContain(name);
    }
  });
});

describe("LAW 11 — a typed refusal REACHES the operator, it is not buried in a schema error", () => {
  // FOUND BY PROBING MY OWN DOUBT BEFORE ASKING FOR REVIEW. The invoker returns typed refusals and
  // never throws — but AgentInvoker's contract is "return the typed blob", so the seal path fed the
  // refusal to validateWrite and the operator got:
  //
  //   chair "r" cannot seal "p": ... required property 'v' ... additionalProperties: must NOT have
  //   additional properties 'ok' ... 'refusal'
  //
  // instead of "this chair grants Bash, which this invoker does not carry". The reason was right
  // there in the returned object and nothing read it. A refusal that is typed and then discarded is
  // the same defect as a law with nothing behind it, one seam over: the mechanism exists and is
  // never reached.
  it("the refusal's own message is what the chair fails with", async () => {
    const { runGig, createRegistry, createOutputStore, MemoryLedger } = await import("../src");
    const registry = createRegistry();
    registry.registerType(note);
    const std = {
      slug: "one", domain: "research", agents: [shellUser],
      phases: [{ name: "gather", chairs: [{ role: "r", agent_slug: "shell-user", depends_on: [], input_contract: [], output_contract: ["research-note"], required_skills: [] }] }],
    };
    const { fn } = fakeCompletions([saysJson({ claim: "c", source: "s" })]);
    const { source } = recordingTools(TOOLS);
    const C: CompletionsModule = await loadCompletions();

    let msg = "";
    try {
      await runGig(std as never, {}, {
        outputs: createOutputStore(registry),
        ledger: new MemoryLedger(),
        invoke: C.makeCompletionsInvoker(opts({ fetchFn: fn, tools: source })),
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    // The positive: the operator is told the actual reason, naming the actual tool.
    expect(msg, "the refusal reason never reached the operator").toContain("host_tool_denied");
    expect(msg, "the refusal did not name the offending tool").toContain("Bash");
    // And NOT drowned in the shape complaint that hid it.
    expect(msg, "the refusal is still buried in a schema error").not.toContain("additionalProperties");
  });
});

describe("LAW 12 — an encoded tool name is LEGAL, not merely lossless", () => {
  // VÖR'S FINDING on #534, and the sharper half of the review. The round-trip law proves the
  // encoding is LOSSLESS. Nothing proved the output is LEGAL — two different properties, and only
  // one had a law. A control standing next to the defect rather than on it.
  //
  // Measured: the escape path is 3 + 2n, so a 68-character name did not merely exceed the wire's
  // 64-character bound, it became 139. The branch that exists to fix the problem made it worse.
  // And the bound is tighter than it looks: a name needing escaping was legal only to 30 BYTES.
  //
  // The cure is NOT to refuse the tool. The invoker holds the tool list, so it can encode legally
  // and resolve the reply by map — a long-named tool stays usable, which is the better outcome than
  // a chair that cannot see it.
  const LIMIT = 64;

  it("EVERY name the invoker sends fits the wire's bound", async () => {
    const C: CompletionsModule = await loadCompletions();
    for (const name of [
      "mcp__coltrane__output_query",
      "mcp__coltrane__agent_validate_pipeline",
      "mcp__srv__tool.with.dots",
      "a".repeat(65),                      // safe characters, over the bound
      "a".repeat(31) + ".",                // needs escaping; 3 + 2n put it over
      "mcp__very-long-server-name__a.tool.with.punctuation",
      "mcp__srv__" + "x".repeat(80),
    ]) {
      const encoded = C.encodeToolName(name);
      expect(encoded.length, `"${name.slice(0, 20)}…" encoded to ${encoded.length}`).toBeLessThanOrEqual(LIMIT);
      expect(encoded, `"${name.slice(0, 20)}…" encoded to an illegal name`).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("distinct long names do not collide once truncated", async () => {
    const C: CompletionsModule = await loadCompletions();
    const a = C.encodeToolName("mcp__srv__" + "x".repeat(80) + "-alpha");
    const b = C.encodeToolName("mcp__srv__" + "x".repeat(80) + "-beta");
    expect(a, "two distinct tools collapsed onto one wire name").not.toBe(b);
  });

  it("a long-named tool is still CALLABLE, and reaches the surface under its real name", async () => {
    // The positive that matters: legality must not cost the tool. The invoker resolves the reply
    // through the list it already has, so a name it cannot invert is still dispatched correctly.
    const C: CompletionsModule = await loadCompletions();
    const longName = "mcp__srv__" + "x".repeat(80);
    const huge: McpToolDef = { name: longName, inputSchema: { type: "object", properties: {} } };
    const wire = C.encodeToolName(longName);
    const { fn } = fakeCompletions([callsTool(wire, {}), saysJson({ claim: "c", source: "s" })]);
    // AMENDED 2026-09-22: the source lists every tool the chair is granted (see TOOLS above).
    const { source, called } = recordingTools([huge, ...TOOLS], { [longName]: { ok: true } });

    // AMENDED 2026-09-16: the chair is GRANTED the long-named tool. This law predates grant filtering
    // and called an ungranted tool; once grants bound the chair, the only way to keep it green without
    // this grant was a carve-out letting every non-engine tool bypass grants (build gig 13ea0d99).
    // Its point was always that a long NAME stays callable, never that an ungranted tool does.
    await C.makeCompletionsInvoker(opts({ fetchFn: fn, tools: source }))(
      ctxFor({ ...researcher, allowed_tools: [...(researcher.allowed_tools ?? []), longName] }),
    );
    expect(called.map((c) => c.name), "the long-named tool never reached the surface").toEqual([longName]);
  });

  it("the round trip still holds for everything short enough to invert", async () => {
    const C: CompletionsModule = await loadCompletions();
    for (const name of ["mcp__coltrane__output_query", "mcp__a.b__c-d", "x".repeat(30)]) {
      expect(C.fromFunctionName(C.encodeToolName(name))).toBe(name);
    }
  });
});

describe("LAW 13 — the refusal sentinel is RESERVED, not merely unoccupied", () => {
  // VÖR'S #4. The runtime treats `{ok:false, refusal:"…", message:"…"}` from an invoker as a
  // refusal rather than an output. I argued a domain type is not plausibly carrying all three, and
  // they measured that no genome file does — so the judgement holds as fact today.
  //
  // But it IS a natural shape for a domain object reporting a domain-level refusal, and nothing
  // prevented the next type from claiming it. "Currently unoccupied" is not a guarantee; it is a
  // coincidence with good manners. So the guard makes it reserved, and the "wrong once" becomes
  // impossible rather than unlikely.
  it("a domain type declaring all three of ok/refusal/message is refused at registration", async () => {
    const { createRegistry } = await import("../src");
    const registry = createRegistry();
    expect(() =>
      registry.registerType({
        slug: "colliding-verdict",
        extends: "Verdict",
        domain: "research",
        schema: {
          properties: {
            ok: { type: "boolean" },
            refusal: { type: "string" },
            message: { type: "string" },
          },
        },
        required_fields: [],
      } as never),
    ).toThrow(/reserved|refusal/i);
  });

  it("declaring any TWO of them is fine — only the full triple is reserved", async () => {
    // The guard must be narrow, or it forbids ordinary vocabulary. `ok` + `message` is a
    // perfectly reasonable shape and nothing should stop it.
    const { createRegistry } = await import("../src");
    const registry = createRegistry();
    expect(() =>
      registry.registerType({
        slug: "fine-verdict",
        extends: "Verdict",
        domain: "research",
        schema: { properties: { ok: { type: "boolean" }, message: { type: "string" } } },
        required_fields: [],
      } as never),
    ).not.toThrow();
  });
});
