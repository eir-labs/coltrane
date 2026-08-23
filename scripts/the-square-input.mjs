// The square's input composer: reads the merge at HEAD and emits the dispatch
// input for square-review-v0 — a change-request (what landed, as the merge
// states it) and a change-set (the diffs themselves) — on stdout.
import { execFileSync } from "node:child_process";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const sha = git("rev-parse", "HEAD").trim();
const subject = git("log", "-1", "--format=%s", "HEAD").trim();
const body = git("log", "-1", "--format=%b", "HEAD").trim();
const files = git("diff", "--name-only", "HEAD^", "HEAD")
  .split("\n")
  .filter(Boolean);

const MAX_PATCH = 60_000; // per-file cap so one giant diff cannot drown the seat
const diffs = files.map((path) => {
  let patch = git("diff", "HEAD^", "HEAD", "--", path);
  if (patch.length > MAX_PATCH) {
    patch =
      patch.slice(0, MAX_PATCH) +
      `\n[the square truncated this patch at ${MAX_PATCH} bytes of ${patch.length}]`;
  }
  return { path, patch };
});

const input = {
  "change-request": {
    request_text: `Review the change-set merged to main as ${sha.slice(0, 12)}: "${subject}"${body ? `\n\n${body}` : ""}`,
    repository: "eir-labs/coltrane",
    target_paths: files,
    acceptance_criteria: [
      "every file in the merged change-set is read turn by turn",
      "the verdict states plainly what was checked, what could not be run, and any scope drift",
    ],
    out_of_scope: ["re-executing the repository's CI", "amending the change"],
    requested_by: "the square (the open review venue, on the merge event)",
  },
  "change-set": {
    diffs,
    tests_added: files.filter((f) => /(^|\/)tests?\//.test(f) || /\.test\./.test(f)),
    rationale: [
      "composed mechanically from the merge commit by the venue; the commit message above is the author's own statement of the change",
    ],
    departures: [],
  },
};

process.stdout.write(JSON.stringify(input, null, 1));
