/**
 * ONE selector, for EVERY door.
 *
 * `coltrane dispatch` / MCP `gig_dispatch` (through `bootstrapServerDeps`) and `coltrane work` (the
 * drain) each need a chair invoker, and until now they chose it in two different places — so only the
 * drain could reach the cheap completions port, and only by code the dispatch door did not share.
 * Two doors that pick their executor by separate logic are two doors that drift; this is the single
 * place the choice is made, so a deployment that seats a cheap model at one door seats it at all.
 *
 * THE CHOICE IS BY PRESENCE, never by a guessed default. A completions base URL in the environment
 * selects the completions port; its absence keeps whatever host-tool invoker the caller configured.
 * The same policy shape `selectQueueBacking` and the drain's credential mode already use.
 *
 * THE ENGINE NAMES NO PROVIDER. No base URL, no model id, no vendor string lives here: the URL, the
 * bearer key, the tier→model map and the price table all arrive through the `env` object the caller
 * passes (the caller reads the process environment; this file reads only the object it is handed).
 * The host-tool invoker's options arrive whole from the caller and are passed through UNTOUCHED —
 * each door configures that path exactly as it did before, and this selector unifies only the choice,
 * not the configuration.
 */
import type { AgentInvoker } from "./runtime.js";
import type { Registry } from "./registry.js";
import type { ModelPrice, PriceTable } from "./turn_loop.js";
import { makeClaudeInvoker, type ClaudeInvokerOptions } from "./claude_invoker.js";
import { makeCompletionsInvoker } from "./completions_invoker.js";
import { makeFileTranscriptStore } from "./transcript_store.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Load and VALIDATE a deployment's price table: served model id → USD per million tokens.
 *
 * The contract is fail-at-startup, not fail-quiet. An absent file is the caller's decision to run
 * unpriced (this function is not called), but a file that is PRESENT and broken must stop the process
 * rather than let a run settle as $0 — a silent zero is a wrong number, and a cheap run priced at
 * nothing hides exactly the spend the table exists to report. Every refusal NAMES the file so an
 * operator can find it: malformed JSON, a non-object root, an entry that is not an object, an entry
 * missing `input` or `output`, or any rate that is non-finite or negative.
 */
export function loadPriceTable(path: string): PriceTable {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`could not read price table "${path}": ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`price table "${path}" is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `price table "${path}" must be a JSON object of model id → { input, output, cache_read?, cache_write? }`,
    );
  }
  const table: Record<string, ModelPrice> = {};
  for (const [model, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`price table "${path}" entry for "${model}" must be an object with input and output rates`);
    }
    const e = entry as Record<string, unknown>;
    const price: ModelPrice = { input: 0, output: 0 };
    for (const key of ["input", "output", "cache_read", "cache_write"] as const) {
      const v = e[key];
      if (v === undefined) {
        // input and output are the floor of a price; cache_read / cache_write are optional. A model
        // that only ever reports uncached tokens is fully priced by { input, output } alone.
        if (key === "input" || key === "output") {
          throw new Error(`price table "${path}" entry for "${model}" is missing "${key}"`);
        }
        continue;
      }
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new Error(
          `price table "${path}" entry for "${model}" has an invalid "${key}" (${String(v)}) — ` +
            `prices are non-negative USD per million tokens`,
        );
      }
      price[key] = v;
    }
    table[model] = price;
  }
  return table;
}

/** The deployment variables the completions seat reads, ALL through the passed env object. */
type EnvLike = Record<string, string | undefined>;

export interface SelectChairInvokerOptions {
  /** The registry the completions invoker resolves output-type schemas through. Each door passes its
   *  own; on the host-tool path the registry rides inside `claude` and this is unused. */
  registry?: Registry | undefined;
  /** The host-tool (Claude) invoker options THIS caller uses today, passed through UNCHANGED when no
   *  completions URL is configured. The selector never merges or unifies them across doors. */
  claude: ClaudeInvokerOptions;
  /** Injectable transport for the completions port (tests). Absent = the global fetch. */
  fetchFn?: typeof fetch | undefined;
}

/**
 * Choose the chair invoker for this door from the deployment environment.
 *
 * `COLTRANE_COMPLETIONS_URL` present → the completions port, wired from the deployment's variables:
 * bearer key, the tier→model map, the per-chair timeout, and the validated price table when
 * `COLTRANE_PRICES_FILE` is set. Absent → the caller's host-tool invoker, byte-for-byte its own
 * options. A malformed price table throws HERE, so a caller that constructs deps at startup fails at
 * startup with the file named.
 */
export function selectChairInvoker(env: EnvLike, opts: SelectChairInvokerOptions): AgentInvoker {
  const completionsUrl = env["COLTRANE_COMPLETIONS_URL"];
  if (completionsUrl) {
    // The tier→model map is deployment-defined; the engine names no model. An unmapped tier is a
    // typed refusal at the chair (the completions invoker's `unresolved_tier`), not a silent default.
    const tierMap: Record<string, string> = {};
    const eco = env["COLTRANE_TIER_ECONOMY"];
    const std = env["COLTRANE_TIER_STANDARD"];
    const prem = env["COLTRANE_TIER_PREMIUM"];
    if (eco) tierMap["economy"] = eco;
    if (std) tierMap["standard"] = std;
    if (prem) tierMap["premium"] = prem;
    const pricesFile = env["COLTRANE_PRICES_FILE"];
    const timeoutRaw = env["COLTRANE_CHAIR_TIMEOUT_MS"];
    // contract-completions-seat-transcript-v1 (O3) — a completions seat resumes across the door only if
    // its conversation is kept somewhere. Wire the engine's file-backed store: COLTRANE_TRANSCRIPTS_DIR
    // when set, else <COLTRANE_OUTPUTS_DIR or $HOME/.eir/coltrane_outputs>/transcripts — reading only
    // the env object handed in, the same "the caller reads process.env, this file reads the object"
    // discipline the rest of the selector keeps.
    const transcriptsDir =
      env["COLTRANE_TRANSCRIPTS_DIR"] ??
      join(env["COLTRANE_OUTPUTS_DIR"] ?? join(env["HOME"] ?? env["USERPROFILE"] ?? homedir(), ".eir/coltrane_outputs"), "transcripts");
    return makeCompletionsInvoker({
      baseUrl: completionsUrl,
      apiKey: env["COLTRANE_COMPLETIONS_KEY"] ?? "",
      ...(opts.registry ? { registry: opts.registry } : {}),
      tierMap,
      transcripts: makeFileTranscriptStore(transcriptsDir),
      // A price table is loaded and validated ONLY when configured. Absent = spend is reported
      // unpriced (never $0); malformed = loadPriceTable throws and the process refuses to start.
      ...(pricesFile ? { prices: loadPriceTable(pricesFile) } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      ...(timeoutRaw ? { timeoutMs: Number(timeoutRaw) } : {}),
    });
  }
  return makeClaudeInvoker(opts.claude);
}
