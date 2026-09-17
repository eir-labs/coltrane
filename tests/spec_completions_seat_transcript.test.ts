// RED — contract-completions-seat-transcript-v1: a chat-completions seat keeps its OWN transcript, so
// a maker amend resumes the conversation it already had instead of being handed a "resuming the
// conversation…" note over a request that holds no conversation at all. Spec:
// docs/specs/completions-seat-transcript.red-spec.md.
//
// THE DEFECT THESE LAWS PIN. buildPrompt (src/claude_invoker.ts) returns the TRIMMED amend prompt
// whenever ctx.resume is set and resume_keep_prompt is not, and makeCompletionsInvoker builds its one
// seed message from buildPrompt (src/completions_invoker.ts:209) — but it holds no conversation:
// runTurn's final `messages` are discarded and never re-sent. So a DeepSeek/OpenAI-compatible maker
// amend ships 1 message reading "resuming the conversation that already holds your disposition,
// identity, method, tools and the gig input" while carrying NONE of it. Measured against dist@1066df9:
// round one 857 chars / amend 424 chars, neither the identity nor the gig input in the amend.
//
// WHY THE STANDING LAW DID NOT CATCH IT. tests/spec_completions_seat_every_door.test.ts LAW 6 runs
// this exact maker ⇄ verifier loop and stays green because its transport answers the maker the same
// way whatever the prompt says — it never inspects the request's messages. These laws DO: every one
// observes the requests the fake chat-completions transport (fetchFn) receives, run through the REAL
// examine ⇄ amend loop in runGig with makeCompletionsInvoker, exactly as LAW 6 wires the port.
//
// TESTING METHOD — example-based, at the two real seams the contract's outputs cross:
//   · the maker ⇄ verifier examine loop through runGig with makeCompletionsInvoker, a fake fetchFn
//     transport capturing every request's messages, an injected TranscriptStore observed for saves
//     (O1, O2, I1, I2, I3, F1).
//   · selectChairInvoker with an env OBJECT, observing the JSON transcript file the wired file-backed
//     store writes per session id (O3).
//
// The enforcement does NOT exist yet: CompletionsInvokerOptions carries no `transcripts` field, the
// invoker seeds exactly `[buildPrompt(ctx)]` and discards runTurn's messages, emits no resume_fallback,
// and selectChairInvoker wires no store. Because tsc compiles tests/**, the not-yet-existing
// `transcripts` option is passed through an `as CompletionsInvokerOptions` cast (excess-property safe),
// the not-yet-existing file-backed store is probed ONLY through selectChairInvoker's written file, and
// no not-yet-existing module is imported. Every law FAILS today on an assertion stating the contract's
// reason. CONTROLS that stay green (named in the spec): spec_completions_seat_every_door,
// spec_completions_invoker, spec_turn_loop, spec_reverify_resume_prompt, spec_amend_resume_prompt,
// spec_seat_context_ceiling.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type DomainType, type PhaseDef, type Agent, type GigProgressEvent,
} from "../src";
import { makeCompletionsInvoker, type CompletionsInvokerOptions } from "../src/completions_invoker.js";
import { sessionUuidFor, type ClaudeInvokerOptions } from "../src/claude_invoker.js";
import { selectChairInvoker } from "../src/invoker_selection.js";
import { testAgent } from "./_support/agents.js";

// ── the fixtures the debate loop runs on ───────────────────────────────────────────────────────────
const URL_BASE = "https://completions.test/v1";
const GIGMARKER = "GIGMARKER-thesis-8b21"; // in the round-one full prompt (gig input), never in the trim
const FAILMARKER = "FAILMARKER-9c2b";      // in the failing verdict the trimmed amend prompt carries
const DEFEND_IDENTITY = "SEAT-DEFEND. You defend the thesis, one move at a time, in a single JSON object.";
const FLOOR_IDENTITY = "SEAT-VERIFY. You hold the floor and rule on the maker's line in a single JSON object.";
const MAKER_OBJ = { text: "red is a colour", validation_criteria: ["answers the challenge"] };
const MAKER_REPLY = JSON.stringify(MAKER_OBJ); // the assistant content the maker turn appends and re-sends
const GIG_INPUT = { topic: { thesis: `${GIGMARKER} whatever is a colour is red`, source: "seed://colours" } };

// The maker (defend) and the floor-keeper (verify) — chat-completions seats, tools-less, each tiered so
// the invoker resolves a concrete model. Built through testAgent (validated) with model_tier attached
// the way a genome-loaded agent carries it.
const maker: Agent = {
  ...testAgent({ slug: "defend", primitives: ["CREATE"], input_types: ["topic"], output_types: ["line"], identity: DEFEND_IDENTITY, domain: "demo" }),
  model_tier: "standard",
};
const floor: Agent = {
  ...testAgent({ slug: "floor-keeper", primitives: ["VERIFY"], input_types: ["line"], output_types: ["floor"], identity: FLOOR_IDENTITY, domain: "demo" }),
  model_tier: "economy",
};

const makeBase = () => {
  const r = createRegistry();
  r.registerType({ slug: "topic", extends: "Signal", domain: "demo", schema: { properties: { thesis: { type: "string" } } }, required_fields: ["thesis"] } as DomainType);
  r.registerType({ slug: "line", extends: "Artifact", domain: "demo", schema: { properties: { text: { type: "string" }, validation_criteria: { type: "array" } } }, required_fields: ["text"] } as DomainType);
  r.registerType({ slug: "floor", extends: "Verdict", domain: "demo", schema: { properties: { pass: { type: "boolean" }, reason: { type: "string" }, checks: { type: "array" } } }, required_fields: ["pass"] } as DomainType);
  return { registry: r, outputs: createOutputStore(r), ledger: new MemoryLedger() };
};

// The defend ⇄ floor examine loop, verifier passing on the `maxRounds`-th look → the maker is amended
// (maxRounds − 1) times. The SAME structure LAW 6 dispatches, composed directly here.
const debate = (maxRounds: number) => composeStandard({
  slug: "mini-debate", domain: "demo", agents: [maker, floor], max_examine_rounds: maxRounds,
  input_types: ["topic"],
  phases: [
    { name: "defend", chairs: [{ role: "defend", agent_slug: "defend", depends_on: [], input_contract: ["topic"], output_contract: ["line"], required_skills: [] }] },
    { name: "floor", chairs: [{ role: "floor", agent_slug: "floor-keeper", depends_on: ["defend"], input_contract: ["line"], output_contract: ["floor"], required_skills: [] }] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any as PhaseDef[],
});
// A single defend chair — one completions invocation with a session id, for the file-backed store law.
const solo = () => composeStandard({
  slug: "solo-defend", domain: "demo", agents: [maker], input_types: ["topic"],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  phases: [{ name: "defend", chairs: [{ role: "defend", agent_slug: "defend", depends_on: [], input_contract: ["topic"], output_contract: ["line"], required_skills: [] }] }] as any as PhaseDef[],
});

// ── the transport + store seams ────────────────────────────────────────────────────────────────────
interface WireMsg { role: string; content: string | null }
interface Sent { body: { model: string; messages: WireMsg[] } }
const reply = (obj: unknown, model: string, usage: Record<string, unknown>) => ({
  choices: [{ message: { role: "assistant", content: JSON.stringify(obj) }, finish_reason: "stop" }], model, usage,
});
// A fake chat-completions transport. `answer` sees the joined prompt text of each request.
function transport(answer: (joined: string, n: number) => unknown): { fn: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fn = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Sent["body"];
    sent.push({ body });
    const joined = body.messages.map((m) => m.content ?? "").join("\n");
    const out = answer(joined, sent.length - 1);
    return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) };
  }) as unknown as typeof fetch;
  return { fn, sent };
}
type Msg = { role: string; content: string | null } & Record<string, unknown>;
// The TranscriptStore the contract adds to CompletionsInvokerOptions: load/save by session id.
const memStore = () => {
  const map = new Map<string, Msg[]>();
  return { map, load: (sid: string): Msg[] | undefined => map.get(sid), save: (sid: string, messages: Msg[]): void => { map.set(sid, messages); } };
};

// The maker's requests, in order — the ones whose prompt is NOT the verifier's (LAW 6's discriminator);
// the trimmed amend carries no identity, so "not the verifier" is what survives the trim.
const makerRequests = (sent: Sent[]): Sent[] =>
  sent.filter((s) => !s.body.messages.map((m) => m.content ?? "").join("\n").includes("SEAT-VERIFY"));

// Run the debate through runGig on makeCompletionsInvoker. `wireStore` false omits the transcripts
// option entirely (the F1 "no store wired" case); otherwise an injected in-memory store is observed.
async function runDebate(o: {
  gig_id: string; maxRounds: number; wireStore?: boolean; store?: ReturnType<typeof memStore>;
  preload?: { sid: string; messages: Msg[] }; events?: GigProgressEvent[];
}): Promise<{ sent: Sent[]; store: ReturnType<typeof memStore>; status: string }> {
  const base = makeBase();
  const store = o.store ?? memStore();
  if (o.preload) store.save(o.preload.sid, o.preload.messages);
  let verifies = 0;
  const { fn, sent } = transport((joined) => {
    if (joined.includes("SEAT-VERIFY")) {
      verifies += 1;
      const pass = verifies >= o.maxRounds;
      return reply({ pass, reason: `look ${verifies} ${FAILMARKER}`, checks: [{ method: "floor rule", result: pass ? "holds" : "does not hold" }] }, "model-flash", { prompt_tokens: 100, completion_tokens: 10 });
    }
    return reply(MAKER_OBJ, "model-std", { prompt_tokens: 100, completion_tokens: 10 });
  });
  const opts = { baseUrl: URL_BASE, apiKey: "k", registry: base.registry, tierMap: { standard: "model-std", economy: "model-flash" }, fetchFn: fn };
  const invoke = o.wireStore === false
    ? makeCompletionsInvoker(opts as CompletionsInvokerOptions)
    // The `transcripts` option does not exist on CompletionsInvokerOptions YET — the enforcement adds
    // it. The cast keeps this law compiling (tsc builds tests/**) without inventing the type.
    : makeCompletionsInvoker({ ...opts, transcripts: store } as CompletionsInvokerOptions);
  const res = await runGig(debate(o.maxRounds), GIG_INPUT, {
    outputs: base.outputs, ledger: base.ledger, invoke, gig_id: o.gig_id,
    ...(o.events ? { onProgress: (e: GigProgressEvent) => o.events!.push(e) } : {}),
  });
  return { sent, store, status: res.status };
}

// ── O1 — every completions invocation with a session id saves runTurn's final messages ──────────────
describe("O1 — a completions seat saves its transcript under its (gig_id, role) session id", () => {
  it("after the run the store holds the maker's and the verifier's transcripts, each a user→assistant conversation", async () => {
    const gid = "gig-o1";
    const { store, status } = await runDebate({ gig_id: gid, maxRounds: 2 });
    expect(status, "the debate must complete on the completions port").toBe("complete");
    const makerSid = sessionUuidFor(gid, "defend")!;
    const floorSid = sessionUuidFor(gid, "floor")!;
    const makerT = store.load(makerSid);
    expect(makerT, "the maker's transcript was never saved — runTurn's final messages are discarded, so its (gig_id, role) session id holds nothing; a later amend has no conversation to resume")
      .toBeTruthy();
    expect(store.load(floorSid), "the verify seat's transcript was never saved either — no invocation with a session id saves today")
      .toBeTruthy();
    expect(makerT![0]!.role, "a saved transcript begins with the user turn the seat was seeded with").toBe("user");
    expect(makerT![makerT!.length - 1]!.role, "a saved transcript ends with the assistant turn runTurn appended").toBe("assistant");
  });
});

// ── O2 / I1 — a maker amend resumes the saved transcript, then exactly one new user message ──────────
describe("O2/I1 — a maker amend re-sends the saved transcript unchanged, then one new user message (the trimmed amend prompt)", () => {
  it("the amend request is [round-one user prompt, round-one assistant answer, trimmed amend prompt] — append-only over round one", async () => {
    const gid = "gig-o2";
    const { sent, status } = await runDebate({ gig_id: gid, maxRounds: 2 });
    expect(status, "the debate must complete").toBe("complete");
    const reqs = makerRequests(sent);
    expect(reqs.length, "the maker must be invoked twice: round one then one amend").toBe(2);
    const round1 = reqs[0]!;
    const amend = reqs[1]!;
    expect(round1.body.messages.length, "round one seeds exactly its full prompt (one user message)").toBe(1);

    // I1 — the amend re-sends round one's saved transcript UNCHANGED as its prefix (a provider prefix
    // cache can serve it); today the amend re-sends only the trimmed prompt, so nothing is cacheable.
    expect(amend.body.messages.slice(0, -1),
      "the amend request's messages minus the last must deep-equal round one's final messages (the round-one user prompt, then the assistant answer); today the maker's amend ships ONE message — the trimmed prompt — carrying none of the conversation it claims to resume")
      .toEqual([round1.body.messages[0], { role: "assistant", content: MAKER_REPLY }]);

    // O2 — followed by EXACTLY ONE new user message: the trimmed amend prompt buildPrompt builds.
    expect(amend.body.messages.length, "the amend must be the saved transcript (2 messages) plus exactly one new user message").toBe(3);
    const last = amend.body.messages[2]!;
    expect(last.role, "the one new message is a user message").toBe("user");
    expect(last.content ?? "", "the new message is the trimmed amend prompt — it names the amend round").toContain("# Amend round");
    expect(last.content ?? "", "the new message carries the failing verdict, the one thing round one did not have").toContain(FAILMARKER);
  });
});

// ── I2 — ONLY a resume reads a transcript ───────────────────────────────────────────────────────────
describe("I2 — a first invocation seeds exactly its full prompt even when the store holds messages for its session id; only a resume reads the transcript", () => {
  it("round one ignores a pre-loaded transcript under its session id (one full-prompt message), while the amend DOES resume the transcript", async () => {
    const gid = "gig-i2";
    const makerSid = sessionUuidFor(gid, "defend")!;
    const sentinel: Msg[] = [{ role: "user", content: "SENTINEL-should-never-be-read" }, { role: "assistant", content: "SENTINEL-assistant" }];
    const { sent, status } = await runDebate({ gig_id: gid, maxRounds: 2, preload: { sid: makerSid, messages: sentinel } });
    expect(status, "the debate must complete").toBe("complete");
    const reqs = makerRequests(sent);
    const round1 = reqs[0]!;

    // The "only" guard: a NON-resume invocation must not read the store even though it holds messages
    // for this exact session id. (This half is correct today and must stay correct under the fix.)
    expect(round1.body.messages.length, "the first invocation seeds exactly one message — its full prompt").toBe(1);
    expect(round1.body.messages[0]!.content ?? "", "the first invocation carries its full prompt (its identity)").toContain("SEAT-DEFEND");
    expect(round1.body.messages[0]!.content ?? "", "the first invocation carries the gig input").toContain(GIGMARKER);
    expect(round1.body.messages.map((m) => m.content ?? "").join("\n"), "a first invocation must NOT read the store, even pre-loaded under its own session id")
      .not.toContain("SENTINEL");

    // The other half of "only a resume reads": the resume MUST read the transcript. Red today — the
    // amend reads nothing, so it ships a single message and the biconditional is unmet.
    const amend = reqs[1]!;
    expect(amend.body.messages.length, "a resume must read the saved transcript and re-send it as a prefix; today the amend reads no transcript and ships one message")
      .toBeGreaterThan(1);
  });
});

// ── I3 — a second amend resumes the FIRST amend's transcript ─────────────────────────────────────────
describe("I3 — a second amend resumes the first amend's transcript", () => {
  it("with the verifier failing twice, the second amend's prefix deep-equals the first amend's final messages", async () => {
    const gid = "gig-i3";
    const { sent, status } = await runDebate({ gig_id: gid, maxRounds: 3 });
    expect(status, "the debate must complete").toBe("complete");
    const reqs = makerRequests(sent);
    expect(reqs.length, "the maker must be invoked three times: round one, then two amends").toBe(3);
    const amend1 = reqs[1]!;
    const amend2 = reqs[2]!;
    // The first amend's FINAL messages = its request (round one prefix + first amend prompt) plus the
    // assistant answer runTurn appended to it. The second amend must re-send exactly that as its prefix.
    const amend1Final = [...amend1.body.messages, { role: "assistant", content: MAKER_REPLY }];
    expect(amend2.body.messages.slice(0, -1),
      "the second amend must resume the FIRST amend's conversation (its transcript, ending in the first amend's answer); today the second amend ships one message and resumes nothing")
      .toEqual(amend1Final);
    expect(amend2.body.messages[amend2.body.messages.length - 1]!.role, "the second amend appends exactly one new user message").toBe("user");
  });
});

// ── F1 — a maker amend with NO saved transcript falls back to the FULL prompt + records resume_fallback ─
describe("F1 — a maker amend with no saved transcript is seeded with the full prompt (never the resume-only prompt) and records resume_fallback", () => {
  it("with no store wired, the amend carries the full prompt (identity + gig input) and chair_complete records resume_fallback, and the chair does not fail", async () => {
    const gid = "gig-f1";
    const events: GigProgressEvent[] = [];
    const { sent, status } = await runDebate({ gig_id: gid, maxRounds: 2, wireStore: false, events });
    expect(status, "the fallback must never fail the chair").toBe("complete");
    const reqs = makerRequests(sent);
    expect(reqs.length, "the maker must be invoked twice: round one then one amend").toBe(2);
    const amend = reqs[1]!;
    const amendText = amend.body.messages.map((m) => m.content ?? "").join("\n");
    expect(amendText,
      "with no saved transcript there is nothing to resume, so the amend must be seeded with the FULL prompt (its identity) — never the resume-only prompt that claims a conversation it does not have; today it ships the trimmed resume-only prompt")
      .toContain("SEAT-DEFEND");
    expect(amendText,
      "the full-prompt fallback must re-carry the gig input — nothing else conveys it once there is no conversation to resume; today the trimmed amend drops it")
      .toContain(GIGMARKER);

    const defendCompletes = events.filter(
      (e) => e.type === "chair_complete" && (e as GigProgressEvent & { role?: string }).role === "defend",
    ) as Array<GigProgressEvent & Record<string, unknown>>;
    const amendComplete = defendCompletes[defendCompletes.length - 1];
    expect(amendComplete, "no chair_complete for the amended maker").toBeTruthy();
    expect(amendComplete!["resume_fallback"],
      "the invoker must emit resume_fallback so chair_complete records that a resume was ATTEMPTED and fell back cold; today the completions invoker emits no such event and the fallback is silent")
      .toBe(true);
  });
});

// ── O3 — the engine ships a file-backed store and selectChairInvoker wires it from the env object ─────
describe("O3 — selectChairInvoker wires a file-backed TranscriptStore that writes one JSON file per session id", () => {
  const runSolo = async (env: Record<string, string | undefined>, gig_id: string): Promise<string> => {
    const base = makeBase();
    const { fn } = transport(() => reply(MAKER_OBJ, "model-std", { prompt_tokens: 10, completion_tokens: 5 }));
    const invoke = selectChairInvoker(env, { registry: base.registry, claude: {} as ClaudeInvokerOptions, fetchFn: fn });
    const res = await runGig(solo(), GIG_INPUT, { outputs: base.outputs, ledger: base.ledger, invoke, gig_id });
    expect(res.status, "the solo defend chair must complete on the completions port").toBe("complete");
    return sessionUuidFor(gig_id, "defend")!;
  };

  it("at COLTRANE_TRANSCRIPTS_DIR when set: <dir>/<session id>.json holds the saved messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-transcripts-o3-"));
    try {
      const sid = await runSolo({
        COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k",
        COLTRANE_TIER_STANDARD: "model-std", COLTRANE_TRANSCRIPTS_DIR: dir,
      }, "gig-o3a");
      const file = join(dir, `${sid}.json`);
      expect(existsSync(file),
        "selectChairInvoker wired no transcript store, so no per-session JSON file was written under COLTRANE_TRANSCRIPTS_DIR; a completions seat cannot resume across the door without it")
        .toBe(true);
      const saved = JSON.parse(readFileSync(file, "utf8")) as unknown;
      expect(Array.isArray(saved), "the file holds the seat's saved messages array").toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("else under <COLTRANE_OUTPUTS_DIR>/transcripts: the store defaults there, reading only the env object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-outputs-o3-"));
    try {
      const sid = await runSolo({
        COLTRANE_COMPLETIONS_URL: URL_BASE, COLTRANE_COMPLETIONS_KEY: "k",
        COLTRANE_TIER_STANDARD: "model-std", COLTRANE_OUTPUTS_DIR: dir, // no COLTRANE_TRANSCRIPTS_DIR
      }, "gig-o3b");
      const file = join(dir, "transcripts", `${sid}.json`);
      expect(existsSync(file),
        "with no COLTRANE_TRANSCRIPTS_DIR the store must default under <COLTRANE_OUTPUTS_DIR>/transcripts; today selectChairInvoker reads neither variable and wires no store, so nothing is written")
        .toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
