/** A GENOME CLASS THE PACKAGE DOES NOT SHIP IS A CLASS THAT LOADS EMPTY.
 *
 *  `loadGenome` reads a directory per definition class. `package.json`'s `files` list decides what an
 *  `npm install` actually receives. Nothing compared the two — so a class could be added to the
 *  loader, documented in CLAUDE.md, covered by laws, and still be ABSENT from every installed copy.
 *
 *  Measured 2026-08-20: `evals/` and `tours/` were both on disk, both loaded, and neither was in the
 *  files list. An installed coltrane therefore had both classes silently empty. `evals` is the sharper
 *  case — it is wired into the runtime (`scoreEval`), so a gig running from an installed package would
 *  score against no evals at all, and an empty class is indistinguishable from "none were declared".
 *
 *  That is the failure this whole family shares: not an error, an ABSENCE that reads as a legitimate
 *  state. `tests/pack_content_audit.test.ts` already guards the package's vocabulary, name scope and
 *  bin entry; it had no notion of the genome's own shape.
 *
 *  The law derives the expected set from the loader's OWN return shape rather than a hand-kept list,
 *  so a class added to the genome and not to `files` fails when it lands — the same construction as
 *  `tests/claude_md_lists_every_genome_class.test.ts`, which pins the documentation side.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadGenome } from "../src/loader.js";

/** Genome keys that are not a shipped directory: a diagnostic, not a class. */
const NOT_A_DIRECTORY = new Set(["load_errors"]);

describe("every genome class directory is published in the package", () => {
  const root = process.cwd();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: string[] };
  const files = new Set(pkg.files ?? []);
  const genome = loadGenome(root);

  const classDirs = Object.keys(genome)
    .filter((k) => !NOT_A_DIRECTORY.has(k))
    .filter((k) => existsSync(join(root, k)));

  it("the loader returns classes that exist as directories — the law is not vacuous", () => {
    expect(classDirs.length).toBeGreaterThan(5);
    expect(files.size).toBeGreaterThan(3);
  });

  for (const dir of classDirs) {
    it(`\`${dir}/\` is in package.json files — an unshipped class loads empty`, () => {
      expect(
        files.has(dir),
        `loadGenome reads "${dir}/" but package.json's files list does not publish it, so every ` +
          `npm install receives that class EMPTY — and an empty class is indistinguishable from ` +
          `"none were declared". Add "${dir}" to files, or stop loading it. ` +
          `Currently published: ${[...files].join(", ")}`,
      ).toBe(true);
    });
  }
});
