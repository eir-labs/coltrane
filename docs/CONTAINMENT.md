# Project import hygiene

This project enforces an allowlist for module imports. Only two kinds of
imports are permitted:

1. Relative paths within the project tree: `./*`, `../*`, `../../*`.
2. Packages declared in `package.json` under `dependencies` or
   `devDependencies`.

Everything else is rejected: absolute paths (`/path/to/x`), home-relative
paths (`~/x`), `file://` URLs, and parent traversal of three or more
levels (which by construction escapes the project root).

## Rationale

The allowlist keeps the project self-contained. Every external code path the
project depends on is named in `package.json` and installed via `npm ci`, so
the build is reproducible and the dependency surface is auditable. Imports
that reach outside the project tree are easy to add by accident — typically
during local development against a sibling checkout — and they bind the
build to the developer's filesystem layout.

## Mechanism

Three layers:

1. **Pre-commit hook (opt-in).** `scripts/check_imports.sh` runs the
   allowlist eslint config against staged files. Enable by copying it to
   `.git/hooks/pre-commit`. Not auto-installed.
2. **CI workflow.** `.github/workflows/lint-imports.yml` runs on every PR.
   It scans the PR diff and the full source tree.
3. **eslint config.** `eslint.config.js` (flat config) expresses the rule
   via `no-restricted-imports`. Standalone — no plugins, no inheritance.

## Running locally

eslint is not a project devDependency. Install it locally without saving:

    npm install --no-save eslint@^9 @typescript-eslint/parser@^8
    npm run lint:imports
