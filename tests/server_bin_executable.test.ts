// #175 — a fresh build must ship an EXECUTABLE server bin. tsc emits dist/src/server_entry.js
// as 0644; npm sets the bin +x on a registry install, but a file:/git-linked consumer (the
// documented `npx coltrane-server` .mcp.json shape) inherits 0644 and the shell refuses to exec
// it — surfacing only as a bare `-32000` in the MCP client. The build script must chmod +x the
// bin. This guards the script (deterministic) and the built artifact's mode when dist exists.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
  build?: never; scripts: { build: string }; bin: Record<string, string>;
};

describe("#175 — the MCP server bin ships executable", () => {
  it("the build script sets +x on the declared bin", () => {
    const build = pkg.scripts.build;
    // every file under `bin` must be chmod'd +x by the build
    for (const rel of Object.values(pkg.bin)) {
      const base = rel.replace(/^\.\//, "");
      expect(build, `build must chmod +x ${base}`).toContain(`chmod +x`);
      expect(build, `build must name ${base} in its chmod`).toContain(base);
    }
  });

  it("the built bin is mode 0755 (owner-exec set) when dist exists", () => {
    const entry = join(REPO, "dist/src/server_entry.js");
    if (!existsSync(entry)) return; // dist not built in this run — the script-level guard covers it
    const mode = statSync(entry).mode & 0o777;
    expect(mode & 0o100, `server_entry.js mode ${mode.toString(8)} lacks owner-exec`).toBe(0o100);
  });
});
