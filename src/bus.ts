// THE BUS — one append-only JSONL file many members share (wiki spec.coltrane-bus).
//
// Writers only ever APPEND, one line per message, in a single O_APPEND write, so several processes can
// post at once without interleaving or losing lines, and no byte already written is ever rewritten.
// A line that does not parse (a writer killed mid-write) is skipped; the lines after it still read.
//
// Each member keeps its own cursor: the index of the next line it has not read, in its own small file
// beside the bus, so members read at their own pace and a restart resumes where it stopped.
//
// `@member` in a line means that member OWES a reply: a later line FROM that member with reply_to set
// to the tagged line's id. Anyone else answering does not discharge it. An untagged line owes nothing;
// it is passive signal a member may act on or ignore.
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface BusLine {
  id: string;
  at: string;
  author: string;
  text: string;
  /** Members tagged in `text`, lowercased, in order of first appearance. */
  mentions: string[];
  reply_to?: string | undefined;
}

export interface Bus {
  post(msg: { author: string; text: string; reply_to?: string | undefined }): BusLine;
  /** Every readable line from index `from` on. */
  read(from: number): BusLine[];
  /** The lines this member has not read yet. */
  unread(member: string): BusLine[];
  /** Mark `n` more lines read for this member. */
  advance(member: string, n: number): void;
  /** Lines tagging this member that it has not yet replied to. */
  owed(member: string): BusLine[];
}

const MENTION = /(?:^|[^\w@])@([A-Za-z0-9][\w-]*)/g;

export function mentionsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const who = m[1]!.toLowerCase();
    if (!out.includes(who)) out.push(who);
  }
  return out;
}

export function openBus(path: string): Bus {
  const cursorFile = (member: string): string => `${path}.cursor.${member.toLowerCase().replace(/[^\w-]/g, "_")}`;
  const cursorOf = (member: string): number => {
    try { return Number(readFileSync(cursorFile(member), "utf8")) || 0; } catch { return 0; }
  };
  const read = (from: number): BusLine[] => {
    if (!existsSync(path)) return [];
    const out: BusLine[] = [];
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try {
        const l = JSON.parse(raw) as BusLine;
        if (typeof l.id === "string" && typeof l.author === "string" && typeof l.text === "string") out.push(l);
      } catch { /* a torn line: skipped, never fatal */ }
    }
    return out.slice(from);
  };
  return {
    post({ author, text, reply_to }) {
      const line: BusLine = {
        id: randomUUID(), at: new Date().toISOString(), author, text, mentions: mentionsIn(text),
        ...(reply_to ? { reply_to } : {}),
      };
      mkdirSync(dirname(path), { recursive: true });
      // A leading newline guarantees this line starts fresh even after a torn line with no newline;
      // blank lines are skipped on read, so it costs nothing.
      appendFileSync(path, `\n${JSON.stringify(line)}\n`);
      return line;
    },
    read,
    unread: (member) => read(cursorOf(member)),
    advance(member, n) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(cursorFile(member), String(cursorOf(member) + n));
    },
    owed(member) {
      const who = member.toLowerCase();
      const all = read(0);
      return all.filter(
        (l) => l.mentions.includes(who) && l.author.toLowerCase() !== who &&
          !all.some((r) => r.reply_to === l.id && r.author.toLowerCase() === who),
      );
    },
  };
}
