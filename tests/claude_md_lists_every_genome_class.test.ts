/** EVERY CLASS THE LOADER RETURNS IS A CLASS THE COLD-START FILE NAMES.
 *
 *  CLAUDE.md's "Definition classes — your primary surface" table is the first thing a fresh session
 *  reads about what this system is made of. A class missing from it is not merely undocumented — it
 *  is invisible to the reader who most needs to know it exists, and the omission is silent because
 *  nothing compares the table to the code.
 *
 *  Measured 2026-08-20: `tours` — the committed-work class, six law files under tests/committed_work,
 *  its own spec at docs/specs/the-binding-middle-place.md, loaded by loadTours and returned in the
 *  genome alongside every documented class — appeared ZERO times in CLAUDE.md. The table listed eight
 *  classes; the loader returned nine.
 *
 *  This asserts the table against `loadGenome`'s OWN return shape, so a class added to the genome and
 *  not to the table fails at the moment it lands. It deliberately does NOT check the row's prose: what
 *  a class IS belongs to whoever writes it. Only presence is mechanical, and only presence is checked.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadGenome } from "../src/loader.js";

/** Keys on the loaded genome that are not definition classes. `load_errors` is a diagnostic, and
 *  core_types/domain_types are the two halves the table names once, as `types`.
 *
 *  `draft_standards` is a PARTITION OF `standards` BY STATUS, not a class of its own: nobody
 *  authors a "draft standard", they author a standard and its status makes it one. It exists as
 *  a separate map only because the drain must not run drafts while standard_promote must still
 *  be able to find them. Adding it to the table would tell a fresh session there is a ninth
 *  thing to author, which there is not — and this law's whole purpose is that the table is what
 *  a fresh session trusts. Excluded on that reasoning, not to make a failing law pass. */
const NOT_A_CLASS = new Set(["load_errors", "core_types", "domain_types", "draft_standards"]);

describe("CLAUDE.md names every class the genome loader returns", () => {
  const md = readFileSync(join(process.cwd(), "CLAUDE.md"), "utf8");
  const genome = loadGenome(process.cwd());

  const loaded = Object.keys(genome).filter((k) => !NOT_A_CLASS.has(k));
  // Scope the scan to the definition-class table itself. CLAUDE.md carries other tables with the
  // same row shape — the change-discipline one has `scope` / `non_goals` / `stop_condition` rows —
  // and sweeping the whole file makes the failure message name things that are not classes. The
  // table starts at its own header and ends at the first blank line after it.
  const classTable = /\|\s*class\s*\|[^\n]*\n(?:\|[^\n]*\n)+/.exec(md)?.[0] ?? "";
  const tabled = new Set([...classTable.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]!));

  it("the genome returns classes and the table has rows — neither side is empty", () => {
    expect(loaded.length).toBeGreaterThan(3);
    expect(tabled.size).toBeGreaterThan(3);
  });

  it("`types` covers the core/domain split the loader returns as two maps", () => {
    expect(genome).toHaveProperty("core_types");
    expect(genome).toHaveProperty("domain_types");
    expect(tabled.has("types"), "the table names the two type maps once, as `types`").toBe(true);
  });

  for (const cls of loaded) {
    it(`\`${cls}\` — returned by loadGenome, so CLAUDE.md must name it`, () => {
      expect(
        tabled.has(cls),
        `loadGenome returns "${cls}" but CLAUDE.md's definition-class table has no row for it. ` +
          `A class a fresh session cannot find is a class it will not use — add the row, or stop ` +
          `returning it. Table currently names: ${[...tabled].sort().join(", ")}`,
      ).toBe(true);
    });
  }
});
