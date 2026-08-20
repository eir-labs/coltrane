/** AN EXPORT WITH NO CALLER IS A MECHANISM NOBODY CAN REACH.
 *
 *  A test suite proves a mechanism WORKS. Nothing in this repo asked whether one is REACHABLE, and
 *  the difference is where the defects have been living: `venue.repo_url` carried five unit laws and
 *  three live container laws while no dispatch could ever trigger it; `drainPreflight` was a complete
 *  123-line collector nothing called; `turn_reserve` had eleven passing laws and zero of twenty-two
 *  standards setting it. Each was green, and each did nothing.
 *
 *  A sweep on 2026-08-20 found 60 exported symbols that are exercised by tests, exported from no
 *  public entrypoint, and called nowhere in src/ — including `makeBifrostInvoker`, the second
 *  AgentInvoker implementation that is the whole point of the model-agnostic seam.
 *
 *  WHY THIS IS A RATCHET AND NOT A ZERO. Demanding zero today would fail on 59 pre-existing cases and
 *  make the suite red for reasons unrelated to whatever change is being reviewed — which teaches
 *  people to ignore it, the failure mode `isolate_audit_spine.ts` already documents for flaky gates.
 *  So it pins the CURRENT count and fails only when the number GROWS. It stops the bleeding without
 *  demanding a 59-item cleanup as the price of admission, and every genuine reduction is a chance to
 *  lower the pin.
 *
 *  THE PREDICATE IS DELIBERATELY CONSERVATIVE, because the first three drafts of this sweep were each
 *  wrong in a different direction. A symbol counts as unreachable only when ALL of: it is exported
 *  from src/; it appears nowhere else in src/ INCLUDING its own defining file (same-file use is real
 *  use); it is not re-exported from a public entrypoint (index.ts / tool_surface.ts / genome_store.ts,
 *  where "no internal caller" is correct by design); and tests reference it at least four times, so a
 *  barely-touched helper does not register as a load-bearing orphan. */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const TESTS = join(process.cwd(), "tests");

/** The count as measured on 2026-08-20. LOWER THIS when orphans are wired or removed; never raise it. */
const PINNED_ORPHANS = 60;

function readAll(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) readAll(p, out);
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function unreachableExports(): string[] {
  const srcFiles = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  const src = new Map(srcFiles.map((f) => [f, readFileSync(join(SRC, f), "utf8")]));
  const tests = readAll(TESTS).map((p) => readFileSync(p, "utf8")).join("\n");
  const publicSurface = ["index.ts", "tool_surface.ts", "genome_store.ts"]
    .map((f) => src.get(f) ?? "")
    .join("\n");

  const defs = new Map<string, string>();
  for (const [f, s] of src) {
    for (const m of s.matchAll(/^export (?:async )?function (\w+)|^export const (\w+)\s*[:=]/gm)) {
      defs.set((m[1] ?? m[2])!, f);
    }
  }

  const orphans: string[] = [];
  for (const [name, home] of defs) {
    if (name.length < 5) continue;
    const word = new RegExp(`\\b${name}\\b`, "g");
    let uses = 0;
    for (const [f, s] of src) {
      uses += (s.match(word) ?? []).length;
      // subtract the definition itself, which is not a use
      if (f === home) {
        uses -= (s.match(new RegExp(`^export (?:async )?(?:function |const )${name}\\b`, "gm")) ?? []).length;
      }
    }
    if (uses > 0) continue;
    if (word.test(publicSurface)) continue;
    if (((tests.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length) >= 4) orphans.push(name);
  }
  return orphans.sort();
}

describe("exported mechanisms have somewhere to be reached from", () => {
  const orphans = unreachableExports();

  it("the sweep finds symbols at all — the law is not vacuous", () => {
    expect(orphans.length).toBeGreaterThan(0);
  });

  it(`no NEW unreachable exports (pinned at ${PINNED_ORPHANS})`, () => {
    expect(
      orphans.length,
      `${orphans.length} exported symbols are tested but called nowhere in src/ and exported from no ` +
        `public entrypoint (pinned at ${PINNED_ORPHANS}). If this GREW, a mechanism was just built ` +
        `without a caller — wire it or export it. If it SHRANK, lower PINNED_ORPHANS to ${orphans.length}. ` +
        `Current: ${orphans.slice(0, 12).join(", ")}${orphans.length > 12 ? ", …" : ""}`,
    ).toBeLessThanOrEqual(PINNED_ORPHANS);
  });
});
