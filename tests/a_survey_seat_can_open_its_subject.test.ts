import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// residency-spec-v0 exists to "sweep the subject named in the dispatch input —
// its repository, configuration, runtime — and seal what actually exists." Its
// first parked run (gig 2a42ffef, 2026-08-23) sealed a contract whose own
// verdicts confess that NO chair could open a single file: the seats hold only
// registry tools, so every "runtime claim" was input attestation, never a read.
// A survey that cannot open its subject is theater. These pins give the two
// seats that ground claims from disk the same read-only hands context-reader
// already holds: Read, Glob, Grep — no write, no Bash, no network.
//
// Generalization named, not done here: derive a tool floor from chair intent
// (a SENSE seat over filesystem subjects must hold Read) the way behavioral
// floors are derived per agent family.

const ROOT = join(__dirname, "..");
const agent = (slug: string) =>
  JSON.parse(readFileSync(join(ROOT, "agents", `${slug}.json`), "utf8"));

const READ_ONLY_HANDS = ["Read", "Glob", "Grep"];

describe("residency-spec-v0's grounding seats can open their subject", () => {
  for (const slug of ["domain-explorer", "solution-developer"]) {
    it(`${slug} holds the read-only filesystem hands`, () => {
      const tools: string[] = agent(slug).allowed_tools ?? [];
      for (const t of READ_ONLY_HANDS) expect(tools, `${slug} missing ${t}`).toContain(t);
    });

    it(`${slug} gains no write or shell hands with them`, () => {
      const tools: string[] = agent(slug).allowed_tools ?? [];
      for (const t of tools) {
        expect(t === "Write" || t === "Edit" || t.startsWith("Bash"), `${slug} holds ${t}`).toBe(false);
      }
    });
  }
});
