// The square's verdict sealer: finds the change-verdict the dispatch just
// sealed in .coltrane/outputs and publishes it as a check run named
// "the square" on the reviewed commit — the venue's own voice, in daylight.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const OUT = ".coltrane/outputs";
const metaDir = join(OUT, "meta");
const newestFirst = readdirSync(metaDir)
  .map((f) => join(metaDir, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

let verdict = null;
for (const file of newestFirst) {
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const v = rows.reverse().find((r) => r.domain_type === "change-verdict");
  if (v) {
    const art = JSON.parse(
      readFileSync(join(OUT, "artifacts", `${v.content_sha}.json`), "utf8"),
    );
    verdict = art.content?.data ?? art.content ?? art;
    break;
  }
}
if (!verdict) {
  console.error("the square sealed no change-verdict — refusing to invent one");
  process.exit(1);
}

const unmet = verdict.criteria_unmet ?? [];
const failures = verdict.failures_verbatim ?? [];
const clean = unmet.length === 0 && failures.length === 0;

const section = (title, items) =>
  items?.length ? `\n\n**${title}**\n${items.map((i) => `- ${typeof i === "string" ? i : JSON.stringify(i)}`).join("\n")}` : "";

let summary =
  (clean
    ? "The square reviewed the merged change-set and found the acceptance criteria met."
    : "The square reviewed the merged change-set and states its findings plainly.") +
  section("Criteria unmet", unmet) +
  section("Failures, verbatim", failures) +
  section("Scope drift", verdict.scope_drift) +
  section("Checked by reasoning, not run", verdict.inferred_not_run) +
  (verdict.recommendation ? `\n\n**Recommendation:** ${verdict.recommendation}` : "");
if (summary.length > 60_000) summary = summary.slice(0, 60_000) + "\n[truncated]";

const sha = process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const payload = JSON.stringify({
  name: "the square",
  head_sha: sha,
  status: "completed",
  conclusion: clean ? "success" : "failure",
  output: { title: clean ? "reviewed in the open — clean" : "reviewed in the open — findings", summary },
});

execFileSync(
  "gh",
  ["api", `repos/${process.env.GITHUB_REPOSITORY ?? "eir-labs/coltrane"}/check-runs`, "--input", "-"],
  { input: payload, stdio: ["pipe", "inherit", "inherit"] },
);
console.log(`the square sealed its verdict on ${sha.slice(0, 12)} (${clean ? "clean" : "findings"})`);
