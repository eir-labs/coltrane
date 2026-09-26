// THE LAYOUT-GRANTS CONTRACT, as types, plus runtime loaders for the not-yet-authored surface.
// Shared by the laws for "grants come from the repository's layout" (docs/specs/layout-grants.red-spec.json).
//
// WHY A LOADER, NOT AN IMPORT. vitest's globalSetup runs `tsc` over tests/ (tests/_support/build_once.ts),
// and ONE tsc error stops every band — at which point a pending law is indistinguishable from a regression.
// So no law statically imports a symbol that does not exist yet:
//   · src/layout_grants.ts is reached through a runtime URL, so tsc never resolves it; a THROWING PROXY
//     keeps every law individually executable, so each fails where it asserts rather than the whole file
//     failing to collect (same technique as spec_completions_fixtures.ts).
//   · LayoutSchema is read off the genome_schema MODULE NAMESPACE, which exists today — the missing export
//     is a runtime absence, never a compile error.
//   · New fields on existing shapes (ctx.layout, RunDeps.layout, LoadedGenome.layout, chair_complete's
//     resolved_grants / target_paths_applied) are written and read through casts.
//
// THE CONTRACT the implementer must create (pinned here, once):
//   src/genome_schema.ts   export const LayoutSchema — the ONE Zod source for coltrane.layout.json:
//                            { paths?: { source?, tests?, migrations?, scripts?, docs?: string[] },
//                              commands?: { build?, test?, laws?, ship_dry?: string[] } }, strict.
//   src/loader.ts          loadGenome(root).layout — parsed <root>/coltrane.layout.json; absent file →
//                            undefined; malformed → a load_errors entry naming the file, and undefined.
//   src/layout_grants.ts   export function resolveSeatGrants({ agent, layout, target_paths, venue })
//                            → { grants, refusals: {token, role, reason}[], target_paths_applied, denials }.
//                            target_paths: [] grants no Write/Edit (applied: true). The layout file is
//                            never writable: denials carry Write/Edit(coltrane.layout.json).
//   src/genome_store.ts    GenomeRows.layouts: {repository, definition}[] → LoadedGenome.layouts
//                            (repository → Layout), validated by LayoutSchema; the drain's run takes
//                            genome.layouts.get(<the gig's working repository>) — NEVER the clone's file.
//   src/runtime.ts         RunDeps.layout → the chair's ctx.layout; chair_complete records
//                            resolved_grants + target_paths_applied; a role refusal refuses the chair.
//   src/run_deps.ts        assembleRunDeps threads `layout`.
//   src/claude_invoker.ts, src/completions_invoker.ts
//                          the seat's grants come from resolveSeatGrants(agent, ctx.layout,
//                            ctx.gig_input.target_paths, ctx.venue).
// ROUND 3:
//   target_paths entries that are absolute, contain `..` segments or backslashes, or otherwise do not
//     name a path inside the tree are REFUSED at dispatch (runGig, naming the entry) and never
//     normalised into a grant by resolveSeatGrants.
//   the completions invoker refuses a chair whose effective grants hold ANY scoped grant (`X(...)`),
//     naming it, before any model call — it cannot enforce a scope.
//   BASH SANDBOX: the Claude invoker's single `--settings` JSON carries, for any seat whose resolved
//     grants include Bash, `sandbox: { enabled: true, failIfUnavailable: true,
//     allowUnsandboxedCommands: false, excludedCommands: [] | absent, filesystem: { denyWrite: [...] } }`
//     with ABSOLUTE paths only, denying <tree>/coltrane.layout.json, <tree>/.git and <tree>/.claude,
//     where <tree> is ctx.seatExec.workspace in a room, else ctx.tree_root (threaded by runGig from
//     RunDeps.tree_root). `--setting-sources` excludes project and local.
//   DIFF GATE: after a seat returns, runGig compares the tree's `git status --porcelain -z` against the
//     state before the seat ran; any changed path (modified, added, untracked, deleted, either side of a
//     rename) outside the seat's resolved Write/Edit scope refuses the chair, naming the paths, and
//     nothing from that chair is sealed.
// target_paths travel where the change-request already travels: the gig payload (ctx.gig_input), flat,
// exactly as `repository` does (resolveWorkingRepo reads claim.input.repository, src/run_deps.ts).
import * as GenomeSchemaModule from "../src/genome_schema.js";
import type { Agent } from "../src/composition.js";
import type { Venue } from "../src/chart.js";

export interface Layout {
  paths?: Partial<Record<"source" | "tests" | "migrations" | "scripts" | "docs", string[]>>;
  commands?: Partial<Record<"build" | "test" | "laws" | "ship_dry", string[]>>;
}

export interface RoleRefusal {
  token: string;
  role: string;
  reason: string;
}

export interface SeatGrants {
  grants: string[];
  refusals: RoleRefusal[];
  target_paths_applied: boolean;
  /** NO SELF-WIDENING (round 2). The deny entries the spawn must carry so no grant can write the
   *  layout file: `Write(coltrane.layout.json)` / `Edit(coltrane.layout.json)` whenever a Write/Edit
   *  grant the seat holds covers it. A glob like `**` cannot be expressed minus one file in the CLI's
   *  permission syntax, so the form is a DENY beside the grant (a scoped deny beats an allow, and the
   *  NO OVER-DENIAL filter in src/claude_invoker.ts keeps a scoped deny unless an EXACT grant of the
   *  same string exists — so the exact grant is also never returned). */
  denials: string[];
}

export interface ResolveSeatGrantsArgs {
  agent: Agent;
  layout?: Layout | undefined;
  target_paths?: readonly string[] | undefined;
  venue?: Venue | undefined;
}

export interface LayoutGrantsModule {
  resolveSeatGrants(args: ResolveSeatGrantsArgs): SeatGrants;
}

export async function loadLayoutGrants(): Promise<LayoutGrantsModule> {
  const href = new URL("../src/layout_grants.js", import.meta.url).href;
  try {
    return (await import(href)) as unknown as LayoutGrantsModule;
  } catch (cause) {
    const why =
      `src/layout_grants.ts does not exist yet — this law is RED until resolveSeatGrants is authored ` +
      `to the surface in tests/layout_grants_fixtures.ts ` +
      `[${String((cause as Error)?.message ?? cause).slice(0, 100)}]`;
    return new Proxy({} as LayoutGrantsModule, {
      get(_t, prop) {
        if (prop === "then" || typeof prop === "symbol") return undefined;
        throw new Error(`${String(prop)}: ${why}`);
      },
    });
  }
}

/** The ONE Zod source for the layout file. Read off the module namespace so a missing export is a
 *  runtime refusal, not a tsc error. */
export function layoutSchema(): { safeParse(v: unknown): { success: boolean } } {
  const s = (GenomeSchemaModule as unknown as Record<string, unknown>)["LayoutSchema"];
  if (!s || typeof (s as { safeParse?: unknown }).safeParse !== "function") {
    throw new Error(
      "src/genome_schema.ts exports no LayoutSchema — the layout's shape must come from ONE Zod schema " +
        "there (the repo rule), not a hand-rolled check in the loader",
    );
  }
  return s as { safeParse(v: unknown): { success: boolean } };
}

/** The layout file's name at the root of the tree a gig runs against. */
export const LAYOUT_FILE = "coltrane.layout.json";

/** A layout for a TypeScript repository shaped like this one. */
export const TS_LAYOUT: Layout = {
  paths: { source: ["src/**"], tests: ["tests/**"], docs: ["docs/**"] },
  commands: { laws: ["npx vitest run"], build: ["npm run build"] },
};

/** A layout for an iOS repository — the shape amendments 000022/000023 widened every agent for. */
export const IOS_LAYOUT: Layout = {
  paths: { source: ["ios/Sources/**"], tests: ["ios/Tests/**"] },
  commands: { test: ["swift test --disable-keychain"] },
};

/** A room that equips exactly the named tools. */
export function room(tools: string[]): Venue {
  return {
    slug: "room-v1", institution_slug: "quartet",
    equipment: { tools }, doors: { ingress: [], egress: [] }, installs: [],
    credential_surface: [], lifecycle: { policy: "ephemeral" },
  } as unknown as Venue;
}

/** Deep-freeze, so a law can prove resolution never amends the agent it was handed. */
export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

// ── a genome tree on disk ─────────────────────────────────────────────────────────────────────────
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A minimal genome tree: this repo's core_types, the given agent files, and — when `layout` is
 *  supplied — a coltrane.layout.json at the root (an object is JSON-encoded; a string is written raw,
 *  so a law can plant malformed bytes). */
export function genomeTree(opts: { layout?: unknown; agents?: Record<string, unknown>[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "layout-grants-"));
  cpSync(join(REPO_ROOT, "core_types"), join(root, "core_types"), { recursive: true });
  mkdirSync(join(root, "agents"));
  for (const a of opts.agents ?? []) writeFileSync(join(root, "agents", `${String(a["slug"])}.json`), JSON.stringify(a, null, 2));
  if (opts.layout !== undefined) {
    writeFileSync(
      join(root, "coltrane.layout.json"),
      typeof opts.layout === "string" ? opts.layout : JSON.stringify(opts.layout, null, 2),
    );
  }
  return root;
}

/** An agent FILE (the on-disk shape, not a parsed Agent) holding a role token. */
export const IMPLEMENTER_FILE: Record<string, unknown> = {
  slug: "implementer",
  primitives: ["CREATE"],
  output_types: ["Artifact"],
  domain: "software-change",
  identity: "You are implementer. You make the change the request names, inside the paths the repository gives you.",
  method: "1. Read the change request.\n2. Make the change.",
  constraints: ["Write only where your grants reach."],
  behavioral_primitives: ["executor", "critic"],
  allowed_tools: ["Read", "Write(@source)", "Edit(@tests)"],
};

/** Every `--settings` JSON on an argv, parsed. */
export function settingsOf(args: readonly string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "--settings") continue;
    try { out.push(JSON.parse(args[i + 1]!) as Record<string, unknown>); } catch { out.push({ unparseable: args[i + 1] }); }
  }
  return out;
}
