/** EVERY COMMAND A METHOD NAMES IS A COMMAND THE SEAT MAY RUN.
 *
 *  An agent's `method` is prose and its `allowed_tools` is enforcement, and nothing held them
 *  together. So a method could instruct a seat to run something its own cage refuses — an
 *  instruction that is unexecutable the moment it is written, discovered only when a live run is
 *  refused mid-chair and has to improvise.
 *
 *  This is not hypothetical and it is not slow to happen: on 2026-08-20 a base-reachability check
 *  calling `git rev-list` was added to pr-publisher's method while its grant carried `git rev-parse`
 *  and not `rev-list`. Instruction and grant were authored minutes apart, by the same hand, and still
 *  diverged. That is the argument for a mechanical check rather than care.
 *
 *  SCOPE, deliberately narrow. Only shell invocations are checked, and only where a method names one
 *  in backticks — `git add -- <paths>`, `npx vitest ...`, `npm run verify`. A seat that holds no
 *  Bash grant at all is exempt: bill and miles reason over the upstream record and mention commands
 *  descriptively, and reading those as instructions would make the law noisy rather than binding.
 *  The check is one-directional: a granted tool the method never mentions is fine (a grant may be
 *  broader than any single run needs). Only the reverse — instructed but not granted — is a defect. */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const AGENTS = join(process.cwd(), "agents");

interface Agent { slug: string; method?: string; allowed_tools?: string[] }

function agents(): Agent[] {
  return readdirSync(AGENTS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(AGENTS, f), "utf8")) as Agent);
}

/** The binaries a Bash grant admits: `Bash(git add:*)` → "git add", `Bash(npx vitest:*)` → "npx vitest". */
function grantedCommands(tools: readonly string[]): string[] {
  return tools
    .map((t) => /^Bash\((.+?)(?::\*)?\)$/.exec(t)?.[1])
    .filter((x): x is string => Boolean(x))
    .map((x) => x.trim());
}

/** Shell invocations a method NAMES in backticks. Conservative: only lines that start with a known
 *  runner, so prose mentioning a word like "git" in passing is not read as an instruction. */
function instructedCommands(method: string): string[] {
  const out = new Set<string>();
  for (const m of method.matchAll(/`([^`]+)`/g)) {
    const cmd = m[1]!.trim();
    const runner = /^(git\s+[a-z-]+|npx\s+[a-z-]+|npm\s+run\s+[a-z:-]+)/.exec(cmd);
    if (runner) out.add(runner[1]!.replace(/\s+/g, " "));
  }
  return [...out];
}

describe("an agent's method may only name commands its grant admits", () => {
  const seats = agents().filter((a) => (a.allowed_tools ?? []).some((t) => t.startsWith("Bash(")));

  it("there are seats holding Bash grants — the law is not vacuous", () => {
    expect(seats.length).toBeGreaterThan(0);
  });

  for (const a of seats) {
    it(`${a.slug}: every command its method names is inside its grant`, () => {
      const granted = grantedCommands(a.allowed_tools ?? []);
      const ungranted = instructedCommands(a.method ?? "").filter(
        (cmd) => !granted.some((g) => cmd === g || cmd.startsWith(g + " ") || g.startsWith(cmd)),
      );
      expect(
        ungranted,
        `${a.slug}'s method instructs [${ungranted.join(", ")}] but its grant admits only [${granted.join(", ")}] — ` +
          `an instruction outside the cage is refused at runtime, mid-chair`,
      ).toEqual([]);
    });
  }
});
