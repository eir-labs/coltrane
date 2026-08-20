import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { LineageRecordRefOutput } from "./genome_schema.js";
import { applyLineageAdoption } from "./lineage_adoption.js";

export interface PersistResult {
  written: boolean;
  /** The file that was read, whether or not it was written. Absent when the slug did not resolve. */
  path?: string;
  /** Why nothing was written. Absent on a successful write. */
  reason?: "no-such-institution" | "already-adopted" | "unreadable" | "unexpected-shape";
  detail?: string;
}

/** Write an adopted lineage reference into an institution's genome document.
 *
 *  The LAST step of the chain, and the only one that touches a disk:
 *
 *    lineageAdoption      decides   — pass? signed? names a record? names an institution?
 *    applyLineageAdoption applies   — pure; returns a new document with the ref appended
 *    persistLineageAdoption writes  — this
 *    agentLineageGrounding inherits — the seated agent finally sees it
 *
 *  NOT WIRED INTO DISPATCH, deliberately. A gig that silently rewrites genome files would mutate
 *  a tree other sessions may be editing, and an implicit genome write is exactly the kind of act
 *  that should be visible in a command rather than a side effect of running a standard. Adoption
 *  is a governance act; persisting it is a second one, and the caller performs it on purpose.
 *
 *  This is also a STOPGAP and says so: LineageRecordRefSchema names `coltrane_institution_lineage`
 *  as the store-side home. Writing the genome file proves the loop end to end before a table
 *  exists, and a store-backed implementation replaces this without changing the three pure steps
 *  above it.
 *
 *  Fails closed on every ambiguity. An unresolved slug is a DEAD NAME — it writes nothing rather
 *  than creating an institution to hold a lineage nobody declared. A document whose shape is not
 *  what the loader expects is left alone rather than repaired, because a lineage write is not the
 *  place to discover a malformed institution. And re-adopting an already-present record reports
 *  `already-adopted` rather than touching the file, so re-running a signature is inert. */
export function persistLineageAdoption(
  genomeRoot: string,
  institution_slug: string,
  ref: LineageRecordRefOutput,
): PersistResult {
  const path = join(genomeRoot, "institutions", `${institution_slug}.json`);
  if (!existsSync(path)) {
    return { reason: "no-such-institution", written: false,
      detail: `no institutions/${institution_slug}.json — a dead name writes nothing rather than inventing an institution to hold a lineage` };
  }

  let doc: Record<string, unknown>;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return { written: false, path, reason: "unreadable", detail: String(e).slice(0, 160) };
  }

  const inst = doc["institution"];
  if (!inst || typeof inst !== "object" || Array.isArray(inst)) {
    return { written: false, path, reason: "unexpected-shape",
      detail: "no `institution` object at the document root; left untouched rather than repaired" };
  }

  const applied = applyLineageAdoption(inst as { lineage?: readonly LineageRecordRefOutput[] }, ref);
  if (!applied.changed) {
    return { written: false, path, reason: "already-adopted",
      detail: `record_ref ${ref.record_ref} is already present; the first seal stands and the file is untouched` };
  }

  // Preserve the file's own indentation rather than imposing one — a lineage write should not
  // show up in a diff as a whole-file reformat.
  const indent = /^\{\n(\s+)"/.exec(raw)?.[1]?.length ?? 2;
  doc["institution"] = applied.institution;
  writeFileSync(path, JSON.stringify(doc, null, indent) + "\n");
  return { written: true, path };
}
