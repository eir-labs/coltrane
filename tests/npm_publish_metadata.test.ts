// Gate: npm-publish metadata shape (issue #148, slice of #144).
//
// Asserts the publisher-side ergonomics an npm consumer sees on the registry
// page + the bin surface a downstream `.mcp.json` invokes. RED-first: fails on
// the bare-`coltrane` / broken-bin / no-files-glob state, flips green as the
// packaging metadata lands.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG_PATH = join(REPO_ROOT, "package.json");

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  author?: string | { name: string; email?: string };
  repository?: string | { type: string; url: string };
  homepage?: string;
  bugs?: string | { url: string };
  keywords?: readonly string[];
  files?: readonly string[];
  bin?: string | Record<string, string>;
  main?: string;
  types?: string;
  exports?: Record<string, unknown>;
  engines?: { node?: string };
  publishConfig?: { access?: string; registry?: string };
  private?: boolean;
}

function readPkg(): PackageJson {
  return JSON.parse(readFileSync(PKG_PATH, "utf-8")) as PackageJson;
}

describe("npm-publish metadata — library import surface (downstream `import from \"@eir-labs/coltrane\"`)", () => {
  it("declares main → dist/src/index.js", () => {
    expect(readPkg().main).toBe("./dist/src/index.js");
  });
  it("declares types → dist/src/index.d.ts", () => {
    expect(readPkg().types).toBe("./dist/src/index.d.ts");
  });
  it("declares an exports map with a root entry", () => {
    const root = readPkg().exports?.["."] as { import?: string; types?: string } | undefined;
    expect(root?.import).toBe("./dist/src/index.js");
    expect(root?.types).toBe("./dist/src/index.d.ts");
  });
  it("the declared entry resolves to an existing file post-build", () => {
    expect(existsSync(join(REPO_ROOT, readPkg().main ?? ""))).toBe(true);
  });
});

describe("npm-publish metadata — name + scope", () => {
  it("name is scoped under @eir-labs", () => {
    expect(readPkg().name).toMatch(/^@eir-labs\//);
  });
  it("name matches @eir-labs/coltrane", () => {
    expect(readPkg().name).toBe("@eir-labs/coltrane");
  });
});

describe("npm-publish metadata — version + license + author", () => {
  it("declares a semver version", () => {
    expect(readPkg().version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  });
  it("declares Apache-2.0 license (matches LICENSE file)", () => {
    const pkg = readPkg();
    expect(pkg.license).toBe("Apache-2.0");
    expect(existsSync(join(REPO_ROOT, "LICENSE"))).toBe(true);
  });
  it("declares an author", () => {
    expect(readPkg().author).toBeDefined();
  });
});

describe("npm-publish metadata — repository + homepage + bugs", () => {
  it("declares a repository pointing at eir-dev/coltrane", () => {
    const pkg = readPkg();
    const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
    expect(url).toMatch(/eir-dev\/coltrane/i);
  });
  it("declares homepage + bugs", () => {
    const pkg = readPkg();
    expect(pkg.homepage).toBeDefined();
    expect(pkg.bugs).toBeDefined();
  });
});

describe("npm-publish metadata — bin field", () => {
  it("declares a bin field", () => {
    expect(readPkg().bin).toBeDefined();
  });
  it("bin includes coltrane-server → dist/src/server_entry.js", () => {
    const bin = readPkg().bin as Record<string, string>;
    expect(bin["coltrane-server"]).toBe("./dist/src/server_entry.js");
  });
  it("bin entry resolves to an existing file post-build", () => {
    const bin = readPkg().bin as Record<string, string>;
    const entry = bin["coltrane-server"];
    if (!entry) return;
    expect(existsSync(join(REPO_ROOT, entry))).toBe(true);
  });
});

describe("npm-publish metadata — files glob", () => {
  it("declares a files array", () => {
    const files = readPkg().files ?? [];
    expect(files.length).toBeGreaterThan(0);
  });
  it("files glob includes dist/", () => {
    const files = readPkg().files ?? [];
    expect(files.some((p) => p.startsWith("dist"))).toBe(true);
  });
  it("files glob includes the 5 genome dirs", () => {
    const files = readPkg().files ?? [];
    for (const dir of ["agents", "standards", "skills", "domain_types", "core_types"]) {
      expect(files.some((p) => p.startsWith(dir)), `missing ${dir}`).toBe(true);
    }
  });
  it("files glob excludes tests + src", () => {
    const files = readPkg().files ?? [];
    expect(files.some((p) => p.startsWith("tests"))).toBe(false);
    expect(files.some((p) => p.startsWith("src"))).toBe(false);
  });
});

describe("npm-publish metadata — publishConfig", () => {
  it("declares publishConfig.access = 'public'", () => {
    expect(readPkg().publishConfig?.access).toBe("public");
  });
  it("is not marked private", () => {
    expect(readPkg().private ?? false).toBe(false);
  });
});

describe("npm-publish metadata — keywords + engines", () => {
  it("declares keywords (≥3)", () => {
    expect((readPkg().keywords ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it("declares engines.node", () => {
    expect(readPkg().engines?.node).toBeDefined();
  });
});
