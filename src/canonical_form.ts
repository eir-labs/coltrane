import { createHash } from "node:crypto";

export const CANONICAL_FORM_VERSION = "1.1";

const EXCLUDED_FIELDS = new Set(["content_hash", "materialized_at", "last_seen"]);

export function canonJson(value: unknown): string {
  return JSON.stringify(stripAndSortKeys(value));
}

export function canonText(value: string): string {
  const lf = value.replace(/\r\n/g, "\n");
  return lf.replace(/\n+$/, "") + "\n";
}

function stripAndSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAndSortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      if (EXCLUDED_FIELDS.has(k)) continue;
      sorted[k] = stripAndSortKeys((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fileHashJson(value: unknown): string {
  return sha256Hex(canonJson(value));
}

export function fileHashText(text: string): string {
  return sha256Hex(canonText(text));
}

export interface FileEntry {
  relpath: string;
  hash: string;
}

export function definitionHash(files: readonly FileEntry[]): string {
  const sorted = [...files].sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));
  const manifest = JSON.stringify(sorted.map((f) => [f.relpath, f.hash]));
  return sha256Hex(manifest);
}

export interface RunFingerprintInput {
  genome_hash: string;
  model_version: string;
  canonical_form_version: string;
  eval_scores: Readonly<Record<string, number>>;
  output_hashes: readonly string[];
}

export function runFingerprint(input: RunFingerprintInput): string {
  const scoreLines = Object.keys(input.eval_scores)
    .sort()
    .map((k) => `${k}:${input.eval_scores[k]}`);
  const outputLines = [...input.output_hashes].sort();
  const lines = [
    `genome_hash:${input.genome_hash}`,
    `model_version:${input.model_version}`,
    `canonical_form_version:${input.canonical_form_version}`,
    `eval_scores:${scoreLines.join(",")}`,
    `output_hashes:${outputLines.join(",")}`,
  ];
  return sha256Hex(lines.join("\n") + "\n");
}

export type DependencyClass = "type" | "agent" | "standard" | "skill" | "eval";

export interface DirectDependency {
  class: DependencyClass;
  slug: string;
  effective_hash: string;
}

export const EMPTY_DEPENDENCY_HASH =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

export function dependencyHash(deps: readonly DirectDependency[]): string {
  const sorted = [...deps]
    .map((d) => [d.class, d.slug, d.effective_hash] as const)
    .sort((a, b) => {
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
      return 0;
    });
  return sha256Hex(JSON.stringify(sorted));
}

export function effectiveHash(content_hash: string, dependency_hash: string): string {
  return sha256Hex(`${CANONICAL_FORM_VERSION}|${content_hash}|${dependency_hash}`);
}
