// Import hygiene config (eslint flat config).
//
// Allowlist shape: only relative paths within the project tree (./*, ../*,
// ../../*) and packages declared in package.json are permitted. Absolute
// paths, home-relative paths, file:// URLs, and deep parent-traversal (3+
// levels, which by construction escapes the project root) are blocked.
//
// We use the `regex` form of `no-restricted-imports` rather than `group`,
// because `group` uses gitignore-style matching (via the `ignore` package)
// which over-matches when applied to import strings — `/**` ends up
// blocking everything, including legitimate package names. Regex form
// matches the literal start of the import string, which is what we want.
//
// Parser: @typescript-eslint/parser for .ts/.tsx (so TypeScript syntax like
// `import type` and parameter type annotations parse cleanly); the default
// parser handles plain .js. The TS parser is required only at lint time —
// not a project devDependency. Install with:
//   npm install --no-save eslint@^9 @typescript-eslint/parser@^8
//
// Local: `npm run lint:imports`
// CI:    `.github/workflows/lint-imports.yml`
// Hook:  `scripts/check_imports.sh` (opt-in)

const FORBIDDEN_PREFIXES = [
  // absolute Unix path
  "/",
  // home-relative absolute
  "~/",
  // file URL
  "file:",
  // parent traversal of 3+ levels — escapes the project root by construction
  "../../../",
];

// Build one alternation regex over the forbidden start-prefixes. Anchored
// at the beginning of the import string.
const FORBIDDEN_RE =
  "^(?:" +
  FORBIDDEN_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
  ")";

// Resolve the TS parser lazily so this config still loads (with .js-only
// coverage) when the TS parser isn't installed. The CI workflow installs it;
// local hook runs install it per the README instruction above.
let tsParser;
try {
  // dynamic require via createRequire keeps this ESM config compatible with
  // CJS-shaped @typescript-eslint/parser
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  tsParser = require("@typescript-eslint/parser");
} catch {
  tsParser = undefined;
}

const restrictedImports = [
  "error",
  {
    patterns: [
      {
        regex: FORBIDDEN_RE,
        message:
          "Imports must be relative within the project tree (./*, ../*, ../../*) or declared package.json dependencies. Absolute paths, home-relative paths, file:// URLs, and deep parent-traversal that escapes the project root are not permitted.",
      },
    ],
  },
];

const config = [
  {
    files: ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-restricted-imports": restrictedImports,
    },
  },
];

if (tsParser) {
  config.push({
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    rules: {
      "no-restricted-imports": restrictedImports,
    },
  });
}

export default config;
