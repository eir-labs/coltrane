/** THE COLD-START FILE'S NUMBERS ARE CHECKED AGAINST THE CODE.
 *
 *  CLAUDE.md is not documentation in the ordinary sense — it is the file a fresh session reads
 *  BEFORE it knows anything else, and it reads it as true. A number that has quietly drifted there
 *  is worse than an absent one: it is a fact a reader will not think to verify, arriving with the
 *  authority of the protocol it sits inside.
 *
 *  Measured 2026-08-20: the file said "the 49 tools" while src/mcp.ts declared 53. Nothing caught it,
 *  because nothing was looking — tests/mcp_server.test.ts asserts only that the surface is non-empty.
 *  Four tools had been added since someone last counted by hand, which is exactly how long a
 *  hand-counted number stays right.
 *
 *  This law is deliberately about COUNTABLE claims only. Prose in CLAUDE.md is a matter of judgement
 *  and belongs to whoever edits it; a cardinal number that names something the code also knows is a
 *  fact with two sources, and two sources of one fact is the drift this repository already collapses
 *  everywhere else (one Zod schema, one shared oracle, one clone mechanism). */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const claudeMd = () => readFileSync(join(process.cwd(), "CLAUDE.md"), "utf8");
const mcpSrc = () => readFileSync(join(process.cwd(), "src", "mcp.ts"), "utf8");

describe("CLAUDE.md's countable claims match the code", () => {
  it("the tool count it advertises is the number of tools the surface declares", () => {
    const declared = [...mcpSrc().matchAll(/\{ slug: "([a-z_]+)",\s+category:/g)].map((m) => m[1]!);
    const unique = new Set(declared);
    expect(unique.size, "duplicate tool slugs in src/mcp.ts").toBe(declared.length);

    const claim = /the (\d+) tools/.exec(claudeMd());
    expect(claim, "CLAUDE.md no longer states a tool count in the form 'the N tools' — update this law with it").not.toBeNull();

    expect(
      Number(claim![1]),
      `CLAUDE.md advertises ${claim![1]} tools; src/mcp.ts declares ${unique.size}. ` +
        `A fresh session reads that number as true before it knows anything else — correct the file, not this law.`,
    ).toBe(unique.size);
  });
});
