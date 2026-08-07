// vitest globalSetup — build `dist/` exactly once, before any test file runs.
//
// Two pack-audit files (`pack_content_audit`, `pack_contents_audit`) each call
// `npm pack --dry-run`, which fires the `prepare` lifecycle, which is `npm run build`, which
// is `tsc` writing into `dist/`. Vitest runs test files in parallel, so both builds ran at
// once and one process read `dist/src/runtime.js` while the other was still writing it:
//
//   npm error code EOF
//   npm error path .../dist/src/runtime.js
//   npm error encountered unexpected EOF
//
// It never reproduced locally — scheduling differed — and failed on all four CI matrix legs
// on the first run that was allowed to execute. A race that only appears under someone else's
// scheduler is exactly the class of thing a green local band cannot rule out.
//
// The two files are deliberately NOT merged (see the header on `pack_content_audit`: they are
// two different gates, one asking which files ship and one asking what is inside them). So the
// fix is not to remove a build, it is to stop two of them overlapping: build once here, and
// let each pack call run with `--ignore-scripts` against the artifact this produced.
//
// It is also strictly faster. The duplicated build was ~2 x 4s and its own header called that
// "the price" of keeping both gates. The price is now zero.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export default function setup(): void {
  // `npm run build` is tsc + copying the skill runner + chmod on the three bin entrypoints.
  // Failing here should fail the run loudly: every pack assertion downstream describes an
  // artifact that would not exist.
  execFileSync("npm", ["run", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    encoding: "utf-8",
  });
}
