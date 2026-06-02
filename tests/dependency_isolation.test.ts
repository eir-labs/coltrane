import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "examples"];
const FORBIDDEN_IMPORTS = [/@supabase\b/, /from\s+['"]supabase['"]/, /@eir\//, /eir-internal/, /slack_ant/, /steve_on_the_decks/];
const INTERNAL_HOSTS = [/supabase\.co/, /\beir\.inc\b/, /eirtests\.com/];

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|js|mjs|cjs|json)$/.test(name)) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap(sources);

describe("dependency isolation", () => {
  it("imports no external infrastructure package", () => {
    const hits = files.filter((f) => FORBIDDEN_IMPORTS.some((re) => re.test(readFileSync(f, "utf8"))));
    expect(hits).toEqual([]);
  });

  it("hardcodes no internal endpoint", () => {
    const hits = files.filter((f) => INTERNAL_HOSTS.some((re) => re.test(readFileSync(f, "utf8"))));
    expect(hits).toEqual([]);
  });
});
