/**
 * A completions seat's own conversation, kept so a maker amend can RESUME it.
 *
 * A Claude seat is spared this by the CLI, which keeps the transcript under its `--session-id`; the
 * chat-completions door is stateless — every request carries its whole message list — so the engine
 * has to hold the conversation itself. This is the port and the one file-backed implementation.
 *
 * WHY A PORT AND NOT A HARDCODED FILE. A deployment may keep transcripts anywhere (an object store, a
 * database) or nowhere; the invoker reads through the port and never names a filesystem. The engine
 * ships ONE implementation — one JSON file per session id under a directory it is given — because that
 * is what a single-host worker needs, and it is what `selectChairInvoker` wires by default.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnMessage } from "./turn_loop.js";

/** Load/save a seat's turn messages by its (gig_id, role) session id. */
export interface TranscriptStore {
  /** The saved conversation for this session, or `undefined` when none is held. */
  load(session_id: string): TurnMessage[] | undefined;
  /** Persist this session's conversation, overwriting any prior save. */
  save(session_id: string, messages: TurnMessage[]): void;
}

/**
 * A file-backed store: `<dir>/<session id>.json` holds the session's message array. The directory is
 * created on first save when absent. A read of a missing or unparseable file is `undefined` — never a
 * throw — so a corrupt or absent transcript falls back to the cold prompt rather than failing the chair.
 */
export function makeFileTranscriptStore(dir: string): TranscriptStore {
  const fileFor = (session_id: string): string => join(dir, `${session_id}.json`);
  return {
    load(session_id: string): TurnMessage[] | undefined {
      try {
        const parsed = JSON.parse(readFileSync(fileFor(session_id), "utf8")) as unknown;
        return Array.isArray(parsed) ? (parsed as TurnMessage[]) : undefined;
      } catch {
        // Missing file, unreadable directory, or malformed JSON — nothing to resume.
        return undefined;
      }
    },
    save(session_id: string, messages: TurnMessage[]): void {
      mkdirSync(dir, { recursive: true });
      writeFileSync(fileFor(session_id), JSON.stringify(messages));
    },
  };
}
