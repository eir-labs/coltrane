// CODE TOOLS — the engine's own hands for changing code, so a chair on ANY model can read, search and
// patch its repo and run its laws (wiki spec.coltrane-bus: toward coltrane editing itself).
//
// Confined to one tree. Every path is resolved through realpath and must stay inside the root's
// realpath, so `..`, an absolute path, or a symlink that points out all refuse. Secrets and git
// internals are never touched. A patch replaces text that occurs EXACTLY once, or changes nothing and
// says why — the same contract as an exact-string edit. There is no shell: the only command is running
// laws, and only a file under tests/.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { spawn } from "node:child_process";

type Result = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };
type LawRunner = (file: string) => Promise<{ passed: boolean; output: string }>;

const FORBIDDEN = [/^\.env/, /^secrets(\/|$)/, /^\.git(\/|$)/, /(^|\/)\.env[^/]*$/];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".coltrane", ".coltrane-cache"]);
const NAMES = {
  read: "mcp__coltrane__code_read",
  search: "mcp__coltrane__code_search",
  patch: "mcp__coltrane__code_patch",
  laws: "mcp__coltrane__code_run_laws",
} as const;

export function codeTools(o: { root: string; runLaws?: LawRunner }) {
  const root = realpathSync(o.root);
  const runLaws: LawRunner = o.runLaws ?? defaultLawRunner(root);

  /** A repo-relative path, resolved and proven to stay inside the root — or why not. */
  const resolve = (p: unknown, mustExist: boolean): { abs: string; rel: string } | { error: string } => {
    if (typeof p !== "string" || !p.trim()) return { error: "a path is required" };
    if (isAbsolute(p)) return { error: `"${p}" is absolute; paths are relative to the repo root` };
    const joined = join(root, p);
    // realpath of the deepest existing ancestor, so a symlink anywhere on the way is followed.
    let probe = joined;
    while (!existsSync(probe)) probe = dirname(probe);
    const real = join(realpathSync(probe), relative(probe, joined));
    const rel = relative(root, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { error: `"${p}" is outside the repo` };
    const posix = rel.split(sep).join("/");
    if (FORBIDDEN.some((re) => re.test(posix))) return { error: `"${p}" is a secret or git internal; code tools never touch it` };
    if (mustExist && !existsSync(real)) return { error: `"${p}" does not exist` };
    return { abs: real, rel: posix };
  };

  const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
    if (name === NAMES.read) {
      const r = resolve(args["path"], true);
      if ("error" in r) return { ok: false, error: r.error };
      if (statSync(r.abs).isDirectory()) return { ok: true, data: { entries: readdirSync(r.abs).sort() } };
      return { ok: true, data: { text: readFileSync(r.abs, "utf8") } };
    }
    if (name === NAMES.patch) {
      const r = resolve(args["path"], true);
      if ("error" in r) return { ok: false, error: r.error };
      const oldText = typeof args["old"] === "string" ? args["old"] : "";
      const newText = typeof args["new"] === "string" ? args["new"] : "";
      if (!oldText) return { ok: false, error: "code_patch needs `old`, the exact text to replace" };
      const text = readFileSync(r.abs, "utf8");
      const count = text.split(oldText).length - 1;
      if (count === 0) return { ok: false, error: `the text to replace was not found in ${r.rel}; nothing changed` };
      if (count > 1) return { ok: false, error: `the text to replace occurs ${count} times in ${r.rel}; give more surrounding text so it occurs once. Nothing changed` };
      writeFileSync(r.abs, text.replace(oldText, newText));
      return { ok: true, data: { path: r.rel } };
    }
    if (name === NAMES.search) {
      const pattern = typeof args["pattern"] === "string" ? args["pattern"] : "";
      if (!pattern) return { ok: false, error: "code_search needs a `pattern`" };
      const matches: string[] = [];
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (matches.length >= 200) return;
          const abs = join(dir, e.name);
          const rel = relative(root, abs).split(sep).join("/");
          if (e.isSymbolicLink() || FORBIDDEN.some((re) => re.test(rel))) continue;
          if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs); continue; }
          const lines = readFileSync(abs, "utf8").split("\n");
          lines.forEach((l, i) => { if (l.includes(pattern) && matches.length < 200) matches.push(`${rel}:${i + 1}: ${l.trim()}`); });
        }
      };
      walk(root);
      return { ok: true, data: { matches } };
    }
    if (name === NAMES.laws) {
      const r = resolve(args["file"], true);
      if ("error" in r) return { ok: false, error: r.error };
      if (!r.rel.startsWith("tests/")) return { ok: false, error: `code_run_laws runs only a law file under tests/, not "${r.rel}"` };
      const res = await runLaws(r.rel);
      return { ok: true, data: res };
    }
    return { ok: false, error: `unknown code tool "${name}"` };
  };

  return {
    list: async () => [
      { name: NAMES.read, description: "Read a file (or list a directory) in the repo, by path relative to its root.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: NAMES.search, description: "Find lines containing a string across the repo (skips dependencies and build output).", inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
      { name: NAMES.patch, description: "Replace text that occurs exactly once in a repo file. Give enough surrounding text to be unique.", inputSchema: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] } },
      { name: NAMES.laws, description: "Run one law file under tests/ and return whether it passed, with its output.", inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } },
    ],
    call,
  };
}

/** `npx vitest run <file>` in the root: the one command code tools can run. */
function defaultLawRunner(root: string): LawRunner {
  return (file) =>
    new Promise((resolve) => {
      const p = spawn("npx", ["vitest", "run", file], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      p.on("close", (code) => resolve({ passed: code === 0, output: out.slice(-4000) }));
    });
}
