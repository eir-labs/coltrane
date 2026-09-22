// THE RESIDENT CHAIR — a bus member that answers what it owes and only hears the rest
// (wiki spec.coltrane-bus, step 2).
//
// One pass: every line tagging the chair that it has not answered gets exactly one model turn — the
// chair's identity, the recent bus as context, the owed line marked — and the answer is posted with
// reply_to that line. Its hands are its grants: the tool source's tools, narrowed to what the chair is
// allowed. Untagged lines cost nothing; the chair's cursor moves past them (the passive feed — which of
// them deserve a turn is the conductor's VOI, step 4). A turn that fails posts nothing and leaves the
// line owed: an absent answer must never look like one.
import type { Bus, BusLine } from "./bus.js";
import { runTurn, type ModelPort, type ToolSource, type TurnMessage } from "./turn_loop.js";

export interface BusChair {
  member: string;
  identity: string;
  /** The concrete model id the port serves this chair on. */
  model: string;
  allowed_tools: readonly string[];
}

export interface ChairPassResult {
  /** Ids of the lines the chair answered this pass. */
  answered: string[];
  /** How many unread lines the chair heard this pass (tagged or not). */
  heard: number;
  failed: Array<{ line: string; reason: string }>;
}

/** How many recent bus lines a turn sees as context. */
const CONTEXT_LINES = 30;
const MAX_ROUNDS = 8;

const render = (l: BusLine): string => `[${l.at}] ${l.author}: ${l.text}`;

export async function chairPass(a: {
  bus: Bus;
  chair: BusChair;
  port: ModelPort;
  tools?: ToolSource | undefined;
  timeout_ms?: number;
}): Promise<ChairPassResult> {
  const { bus, chair } = a;
  const heard = bus.unread(chair.member).length;
  bus.advance(chair.member, heard);

  const result: ChairPassResult = { answered: [], heard, failed: [] };
  const all = bus.read(0);
  for (const line of bus.owed(chair.member)) {
    const at = all.findIndex((l) => l.id === line.id);
    const context = all.slice(Math.max(0, at - CONTEXT_LINES), at);
    const messages: TurnMessage[] = [
      {
        role: "user",
        content:
          `# Identity\n${chair.identity}\n\n` +
          `You are "${chair.member}" on a shared message bus. Answer the line addressed to you below, ` +
          `briefly. Your reply is posted to the bus as it is.\n\n` +
          `# Recent bus\n${context.map(render).join("\n") || "(nothing before this)"}\n\n` +
          `# Addressed to you\n${render(line)}`,
      },
    ];
    let reason: string | undefined;
    let text = "";
    try {
      const turn = await runTurn(messages, {
        port: a.port,
        model: chair.model,
        ...(a.tools ? { tools: a.tools } : {}),
        allow: chair.allowed_tools,
        max_rounds: MAX_ROUNDS,
        timeout_ms: a.timeout_ms ?? 600_000,
      });
      if (turn.stop !== "done") reason = `${turn.stop}${turn.error ? `: ${turn.error}` : ""}`;
      else if (!turn.text.trim()) reason = "the turn ended with no answer";
      text = turn.text;
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    if (reason !== undefined) {
      result.failed.push({ line: line.id, reason });
      continue;
    }
    bus.post({ author: chair.member, text, reply_to: line.id });
    result.answered.push(line.id);
  }
  return result;
}
