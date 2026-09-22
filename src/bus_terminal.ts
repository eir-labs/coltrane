// THE TERMINAL — bare `coltrane` in an interactive terminal opens a chat with the repo's chair on the
// shared bus (wiki spec.coltrane-bus, step 3).
//
// What the human types is posted as them. The chair's pass runs after each post, so a line that tags it
// comes back answered; an untagged line costs no model call. Lines other members post are shown when the
// terminal polls. The human's own lines are never echoed back.
import type { Bus } from "./bus.js";
import { chairPass, type BusChair } from "./bus_chair.js";
import type { ModelPort, ToolSource } from "./turn_loop.js";

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
  const { homedir } = await import("node:os");
  const { join, basename } = await import("node:path");
  const readline = await import("node:readline");
  const { openBus } = await import("./bus.js");
  const { bootstrapServerDeps, makeEngineToolSource } = await import("./server.js");
  const { makeChatCompletionsPort } = await import("./chat_completions_port.js");
  const { longWaitFetch } = await import("./long_wait_fetch.js");
  const { mcpServerOf, toolBaseName, ENGINE_MCP_SERVER } = await import("./tool_providers.js");

  const say = (s: string): void => { process.stdout.write(`${s}\n`); };
  const slug = flag("chair") ?? process.env["COLTRANE_CHAIR"];
  const url = process.env["COLTRANE_COMPLETIONS_URL"];
  if (!slug) { say("coltrane chat needs a chair: --chair <agent slug> or COLTRANE_CHAIR."); return 2; }
  if (!url) { say("coltrane chat needs a model: set COLTRANE_COMPLETIONS_URL (and _KEY, COLTRANE_TIER_*)."); return 2; }
  const deps = bootstrapServerDeps(process.env["COLTRANE_GENOME"] ?? process.cwd());
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
  const bus = openBus(join(homedir(), ".eir", "bus", `${busName}.jsonl`));
  const me = flag("as") ?? process.env["USER"] ?? "human";
  const port = makeChatCompletionsPort({ baseUrl: url, apiKey: process.env["COLTRANE_COMPLETIONS_KEY"] ?? "", fetchFn: longWaitFetch });
  const chat = startChat({ bus, me, chair, port, tools: makeEngineToolSource(() => deps), out: say });

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
