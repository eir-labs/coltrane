// THE TERMINAL — bare `coltrane` in an interactive terminal opens a chat with the repo's chair on the
// shared bus (wiki spec.coltrane-bus, step 3).
//
// What the human types is posted as them. The chair's pass runs after each post, so a line that tags it
// comes back answered; an untagged line costs no model call. Lines other members post are shown when the
// terminal polls. The human's own lines are never echoed back.
import type { Bus } from "./bus.js";
import { chairPass, type BusChair } from "./bus_chair.js";
import type { ModelPort, ToolSource, ToolDef } from "./turn_loop.js";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where a named bus lives: `<COLTRANE_BUS_DIR or ~/.eir/bus>/<name>.jsonl`. A name is a plain name —
 * letters, digits, `.`, `_`, `-`, not starting with a dot — so it can never reach outside the bus
 * directory. Anything else throws, naming the rule.
 */
export function busPath(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`bus name ${JSON.stringify(name)} is not a plain name (letters, digits, . _ -, not starting with a dot)`);
  }
  const dir = process.env["COLTRANE_BUS_DIR"] ?? join(homedir(), ".eir", "bus");
  return join(dir, `${name}.jsonl`);
}

/** Bare `coltrane` in an interactive terminal is `coltrane chat`; to a script or a pipe it stays bare,
 *  so the usage-and-exit-2 contract CI relies on is untouched. */
export function entryArgv(argv: readonly string[], isTTY: boolean): string[] {
  return argv.length === 0 && isTTY ? ["chat"] : [...argv];
}

export function startChat(a: {
  bus: Bus;
  me: string;
  chair: BusChair;
  port: ModelPort;
  tools?: ToolSource | undefined;
  out: (s: string) => void;
}): { say(text: string): Promise<void>; poll(): Promise<void> } {
  let shown = a.bus.read(0).length; // start at the present; history is the reader's to ask for
  let passing: Promise<void> | undefined;
  const show = (): void => {
    const fresh = a.bus.read(shown);
    shown += fresh.length;
    for (const l of fresh) if (l.author !== a.me) a.out(`${l.author}: ${l.text}`);
  };
  const pass = async (): Promise<void> => {
    // One pass at a time: a second post while the chair is thinking is picked up by the pass after.
    while (passing) await passing;
    passing = (async () => {
      const r = await chairPass({ bus: a.bus, chair: a.chair, port: a.port, tools: a.tools });
      for (const f of r.failed) a.out(`(${a.chair.member} could not answer: ${f.reason})`);
    })();
    try { await passing; } finally { passing = undefined; }
  };
  return {
    async say(text) {
      a.bus.post({ author: a.me, text });
      shown = a.bus.read(0).length; // my own line: seen, not echoed
      await pass();
      show();
    },
    async poll() {
      show();
    },
  };
}

/**
 * `coltrane chat [--chair <agent>] [--bus <name>] [--as <me>]` — the interactive shell around
 * startChat. The chair is an agent in this repo's genome (COLTRANE_CHAIR or --chair; resolving it from
 * the repo's institution is the next step). Its model is the tier map the completions port already
 * reads (COLTRANE_COMPLETIONS_URL / _KEY / COLTRANE_TIER_*); its hands are the engine surface narrowed
 * to its grants. The bus is ~/.eir/bus/<name>.jsonl, shared with every member invited to it.
 */
export async function runChatTerminal(argv: readonly string[]): Promise<number> {
  const flag = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const { basename } = await import("node:path");
  const readline = await import("node:readline");
  const { openBus } = await import("./bus.js");
  const { bootstrapServerDeps, makeEngineToolSource } = await import("./server.js");
  const { makeChatCompletionsPort } = await import("./chat_completions_port.js");
  const { longWaitFetch } = await import("./long_wait_fetch.js");
  const { mcpServerOf, toolBaseName, ENGINE_MCP_SERVER } = await import("./tool_providers.js");

  const say = (s: string): void => { process.stdout.write(`${s}\n`); };
  const root = process.env["COLTRANE_GENOME"] ?? process.cwd();
  const { loadInstitutions } = await import("./institution_loader.js");
  const resolved = resolveBusChair(loadInstitutions(root).institutions as never, flag("chair") ?? process.env["COLTRANE_CHAIR"]);
  if ("error" in resolved) { say(resolved.error); return 2; }
  const slug = resolved.slug;
  const url = process.env["COLTRANE_COMPLETIONS_URL"];
  if (!url) { say("coltrane chat needs a model: set COLTRANE_COMPLETIONS_URL (and _KEY, COLTRANE_TIER_*)."); return 2; }
  const deps = bootstrapServerDeps(root);
  const agent = deps.agents?.get(slug);
  if (!agent) { say(`no agent "${slug}" in this genome.`); return 2; }
  const tier = String(agent.model_tier ?? "standard").toUpperCase();
  const model = process.env[`COLTRANE_TIER_${tier}`];
  if (!model) { say(`no model mapped for tier ${tier}: set COLTRANE_TIER_${tier}.`); return 2; }

  const chair = {
    member: slug,
    identity: [agent.identity, agent.method].filter(Boolean).join("\n\n"),
    model,
    allowed_tools: (agent.allowed_tools ?? []).map((g) => (mcpServerOf(g) ? g : `mcp__${ENGINE_MCP_SERVER}__${toolBaseName(g)}`)),
  };
  const busName = flag("bus") ?? basename(process.cwd());
  const bus = openBus(busPath(busName));
  const me = flag("as") ?? process.env["USER"] ?? "human";
  const port = makeChatCompletionsPort({ baseUrl: url, apiKey: process.env["COLTRANE_COMPLETIONS_KEY"] ?? "", fetchFn: longWaitFetch });
  // The chair's hands: the engine surface (commitments sealed and stamped) and the code tools, confined
  // to this repo. Its grants decide which of them it is actually offered.
  const { codeTools } = await import("./code_tools.js");
  const tools = unionSources([
    busCommitSource(makeEngineToolSource(() => deps, { seal: true }), { bus: busName, chair: slug }),
    codeTools({ root }),
  ]);
  const chat = startChat({ bus, me, chair, port, tools, out: say });

  say(`bus "${busName}" — you are ${me}, the chair is @${slug} (${model}). Tag @${slug} to ask it; Ctrl-D to leave.`);
  const timer = setInterval(() => { void chat.poll(); }, 1500);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  for await (const input of rl) {
    const text = input.trim();
    if (text) await chat.say(text);
    rl.prompt();
  }
  clearInterval(timer);
  return 0;
}

/**
 * Which chair bare `coltrane` talks to: an explicit `--chair` / COLTRANE_CHAIR; else the ONE chair with
 * role "conductor" in the genome's institutions that has an agent seated. None seated, or more than
 * one, refuses and says how to fix it — the engine never guesses which chair you meant.
 */
export function resolveBusChair(
  institutions: ReadonlyMap<string, { slug: string; document: { chairs?: ReadonlyArray<{ id: string; role: string }>; assignments?: ReadonlyArray<{ chair_id: string; agent_slug?: string | undefined }> } }>,
  explicit: string | undefined,
): { slug: string } | { error: string } {
  if (explicit) return { slug: explicit };
  const seated: Array<{ institution: string; agent: string }> = [];
  for (const inst of institutions.values()) {
    for (const chair of inst.document.chairs ?? []) {
      if (chair.role !== "conductor") continue;
      for (const a of inst.document.assignments ?? []) {
        if (a.chair_id === chair.id && a.agent_slug) seated.push({ institution: inst.slug, agent: a.agent_slug });
      }
    }
  }
  if (seated.length === 1) return { slug: seated[0]!.agent };
  if (seated.length === 0) {
    return {
      error:
        `no conductor is seated in this genome's institutions. Add a chair with role "conductor" to ` +
        `institutions/<name>.json and seat an agent in it (define the agent with agent_define), or name ` +
        `the chair for this session: coltrane chat --chair <agent>.`,
    };
  }
  return {
    error: `more than one conductor is seated (${seated.map((s) => `${s.agent} in ${s.institution}`).join(", ")}); ` +
      `name the one you mean: coltrane chat --chair <agent>.`,
  };
}

/**
 * A bus chair's hands, with its commitments stamped: every `output_write` it makes is sealed under gig
 * `bus:<name>`, as the chair, in phase `bus` — whatever the model put in those fields, so a chair can
 * neither misfile a commitment nor sign another agent's name. Every other tool passes through untouched.
 */
export function busCommitSource<T extends { list: () => Promise<unknown>; call: (n: string, a: Record<string, unknown>) => Promise<unknown> }>(
  inner: T,
  where: { bus: string; chair: string },
): T {
  return {
    ...inner,
    call: (name: string, args: Record<string, unknown>) =>
      name === "output_write" || name.endsWith("__output_write")
        ? inner.call(name, { ...args, gig_id: `bus:${where.bus}`, agent_slug: where.chair, phase: "bus" })
        : inner.call(name, args),
  };
}

/** Several tool sources as one: every tool each lists, and each call routed to the source that listed
 *  that name. A name no source lists is refused, never guessed at. */
export function unionSources(sources: ReadonlyArray<{ list: () => Promise<ReadonlyArray<{ name: string; description?: string | undefined; inputSchema: Record<string, unknown> }>>; call: (n: string, a: Record<string, unknown>) => Promise<unknown> }>) {
  const owner = async (name: string) => {
    for (const s of sources) if ((await s.list()).some((d) => d.name === name)) return s;
    return undefined;
  };
  return {
    list: async (): Promise<ToolDef[]> =>
      (await Promise.all(sources.map((s) => s.list()))).flat().map((d) => ({
        name: d.name, inputSchema: d.inputSchema, ...(d.description !== undefined ? { description: d.description } : {}),
      })),
    call: async (name: string, args: Record<string, unknown>) => {
      const s = await owner(name);
      return s ? s.call(name, args) : { ok: false, error: `no tool named "${name}" is offered to this chair` };
    },
  };
}
