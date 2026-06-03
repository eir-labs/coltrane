/**
 * cc_session_binding.ts — bind a Claude Code session to a Steve.
 *
 * Each Steve runs as one long-lived Claude Code thread (per Eugene's
 * "one thread per Steve" architecture — restart cost reduces to cache-TTL,
 * conversation + accumulated identity-residue carry forward for free).
 *
 * The binding is sealed as an event on the Steve's audit.jsonl:
 *
 *   { kind: "cc_session_bound", steve_uuid, session_id, context, sha_seal, at }
 *
 * Outbound consumers:
 *   - miles's `coltrane resume <uuid>` CLI reads the latest cc_session_bound
 *     for that Steve, runs `claude --resume <session_id>`
 *   - worker.ts's on_inbox stub will (in a follow-up) call ensureSession()
 *     on first inbox event then pipe subsequent events through the same
 *     session via --resume
 *
 * Audit-stream integrity:
 *   - cc_session_bound events have sha_seal computed via canonical-form
 *     sha256, identical pattern to TuningSeal
 *   - bindings are append-only (one new binding per spawn/respawn);
 *     getActiveSessionId returns the most recent binding by `at` field
 *   - sealed json is forward-readable by external tools
 *
 * Authored by subhuti under chain-keeper discipline.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

export type CcSessionTrigger =
  | "first_inbox_event"
  | "manual_resume"
  | "bridge_restart"
  | "worker_boot";

/**
 * One cc_session_bound event on a Steve's audit.jsonl. Mirrors the
 * TuningSeal shape (kind, at, steve_uuid, payload-fields, sha_seal).
 */
export interface CcSessionBinding {
  kind: "cc_session_bound";
  at: string;
  steve_uuid: string;
  session_id: string;
  context: { trigger: CcSessionTrigger; note?: string };
  sha_seal: string;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Stable JSON (sorted keys) for deterministic seal hashing. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}

/**
 * Compute sha_seal for a binding event: sha256(stable-stringify of the
 * binding with sha_seal = "").
 */
export function computeBindingSealHash(
  body: Omit<CcSessionBinding, "sha_seal">,
): string {
  return sha256Hex(stableStringify({ ...body, sha_seal: "" }));
}

/**
 * Build a sealed CcSessionBinding. Pure: same inputs in, same binding out.
 * Session ids are passed in (so tests are deterministic); production
 * callers should pass `randomUUID()`.
 */
export function buildBinding(
  steve_uuid: string,
  session_id: string,
  trigger: CcSessionTrigger,
  at: string,
  note?: string,
): CcSessionBinding {
  const ctx = note ? { trigger, note } : { trigger };
  const body: Omit<CcSessionBinding, "sha_seal"> = {
    kind: "cc_session_bound",
    at,
    steve_uuid,
    session_id,
    context: ctx,
  };
  return { ...body, sha_seal: computeBindingSealHash(body) };
}

/**
 * Append a binding event to the Steve's audit.jsonl as one JSONL line.
 * Tests can inject `sink` to capture the line in memory.
 */
export async function appendBinding(
  binding: CcSessionBinding,
  auditPath: string,
  sink?: (line: string) => Promise<void>,
): Promise<void> {
  const line = JSON.stringify(binding) + "\n";
  if (sink) {
    await sink(line);
  } else {
    await appendFile(auditPath, line, "utf8");
  }
}

/**
 * Convenience: generate a fresh session id, seal a binding, write it,
 * return the binding. The standard production path for "Steve needs a
 * new CC session right now."
 */
export async function bindNewSession(
  steve_uuid: string,
  auditPath: string,
  trigger: CcSessionTrigger,
  options?: {
    now?: () => Date;
    rng?: () => string;
    sink?: (line: string) => Promise<void>;
    note?: string;
  },
): Promise<CcSessionBinding> {
  const at = (options?.now ?? (() => new Date()))().toISOString();
  const sid = (options?.rng ?? (() => randomUUID()))();
  const binding = buildBinding(steve_uuid, sid, trigger, at, options?.note);
  await appendBinding(binding, auditPath, options?.sink);
  return binding;
}

/**
 * Walk a Steve's audit.jsonl from disk and return the most recent
 * cc_session_bound event (by `at` timestamp). Returns null if no binding
 * exists yet.
 *
 * Skips lines that don't parse or aren't bindings, so it's safe on a
 * mixed audit stream (tuning + react + post + bindings interleaved).
 */
export async function getActiveSessionBinding(
  steve_uuid: string,
  auditPath: string,
  options?: { reader?: () => Promise<string> },
): Promise<CcSessionBinding | null> {
  let content: string;
  try {
    content = options?.reader
      ? await options.reader()
      : await readFile(auditPath, "utf8");
  } catch {
    return null;
  }
  let latest: CcSessionBinding | null = null;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const ev = parsed as Record<string, unknown>;
    if (ev["kind"] !== "cc_session_bound") continue;
    if (ev["steve_uuid"] !== steve_uuid) continue;
    if (typeof ev["session_id"] !== "string") continue;
    const candidate = ev as unknown as CcSessionBinding;
    if (!latest || candidate.at > latest.at) {
      latest = candidate;
    }
  }
  return latest;
}

/**
 * If a binding exists for this Steve, return its session_id; otherwise
 * mint a new one + seal it. The path miles's `coltrane resume <uuid>`
 * + worker.ts's on_inbox both call to "get me a session_id, fresh or
 * carried forward."
 */
export async function ensureSessionId(
  steve_uuid: string,
  auditPath: string,
  trigger: CcSessionTrigger,
  options?: {
    now?: () => Date;
    rng?: () => string;
    sink?: (line: string) => Promise<void>;
    reader?: () => Promise<string>;
    note?: string;
  },
): Promise<{ session_id: string; binding: CcSessionBinding; fresh: boolean }> {
  const existing = await getActiveSessionBinding(
    steve_uuid,
    auditPath,
    options?.reader ? { reader: options.reader } : undefined,
  );
  if (existing) {
    return { session_id: existing.session_id, binding: existing, fresh: false };
  }
  const binding = await bindNewSession(steve_uuid, auditPath, trigger, options);
  return { session_id: binding.session_id, binding, fresh: true };
}

/**
 * Verify a binding's sha_seal matches its body. Useful for downstream
 * consumers that need to assert the binding hasn't been tampered with
 * (independent of the broader forward-sha audit chain).
 */
export function verifyBindingSeal(binding: CcSessionBinding): boolean {
  const expected = computeBindingSealHash({
    kind: binding.kind,
    at: binding.at,
    steve_uuid: binding.steve_uuid,
    session_id: binding.session_id,
    context: binding.context,
  });
  return expected === binding.sha_seal;
}
