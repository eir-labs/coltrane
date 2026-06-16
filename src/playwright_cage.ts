// The caged browser — coltrane's deny-by-default wrapper over @playwright/mcp. Raw browser
// automation is powerful and dangerous: an agent with a browser can reach anywhere, persist
// state, and exfiltrate. This cage hardens it into a safe, declared capability:
//   - nav allowlist  (--allowed-origins): the browser can ONLY reach the origins the agent
//     declares — deny-by-default. An off-list navigation is refused by the server itself, not
//     merely discouraged in the prompt.
//   - ephemeral      (--isolated): the profile is in-memory, disposed at session end — no cookie
//     or storage bleed across gigs.
//   - headless       (--headless): no UI, no human-session hijack.
//   - provenance     (--save-session + --output-dir): the MCP session (every navigation + tool
//     call) is written to disk, so "the browser actually went to ppubs.uspto.gov" is an artifact.
// An agent grants browser tools (mcp__playwright__*) AND declares its allowed origins; coltrane
// builds the server config from that declaration, so each agent's browser is scoped to exactly
// what it asked for. Ships default with the repo — the deny-by-default browser is the substrate.

export interface PlaywrightCageOptions {
  /** The nav allowlist — host/origin patterns the browser may reach. Deny-by-default: an empty
   *  list means the agent may browse nothing (a browser grant without origins is inert). */
  allowedOrigins: readonly string[];
  /** Origins to explicitly block even if otherwise allowed. */
  blockedOrigins?: readonly string[];
  /** Where Playwright writes its saved session (provenance). Omit to skip session capture. */
  traceDir?: string;
  /** Ephemeral in-memory profile (no persistence). Default true. */
  isolated?: boolean;
  /** Run headless. Default true. */
  headless?: boolean;
  /** Override the package spec (tests/pinning). Default "@playwright/mcp@latest". */
  packageSpec?: string;
}

export interface McpServerConfig {
  command: string;
  args: string[];
}

/** Build the @playwright/mcp server config for a caged browser. The allowlist + isolation +
 *  trace flags are enforced by the server itself, so the cage holds even though the browser runs
 *  out-of-process. Deny-by-default: origins not on `allowedOrigins` are refused at navigation. */
export function buildPlaywrightCage(opts: PlaywrightCageOptions): McpServerConfig {
  const args = ["-y", opts.packageSpec ?? "@playwright/mcp@latest"];
  if (opts.headless !== false) args.push("--headless");
  if (opts.isolated !== false) args.push("--isolated");
  // --allowed-origins is the deny-by-default boundary: only these origins load. Always pass it
  // (even empty) so a misconfigured grant fails closed (browses nothing) rather than open.
  args.push("--allowed-origins", opts.allowedOrigins.join(";"));
  if (opts.blockedOrigins && opts.blockedOrigins.length > 0) {
    args.push("--blocked-origins", opts.blockedOrigins.join(";"));
  }
  if (opts.traceDir) args.push("--save-session", "--output-dir", opts.traceDir);
  return { command: "npx", args };
}

// A browser grant declared on an agent: the origins it may reach + optional trace dir. The
// presence of this on an agent that also grants mcp__playwright__* tools is what makes coltrane
// build a caged browser for it. The shape is DERIVED from BrowserGrantSchema (the Zod DNA in
// genome_schema.ts) — re-exported here so the cage's call-sites keep importing it from one place.
export type { BrowserGrant } from "./genome_schema.js";
import type { BrowserGrant } from "./genome_schema.js";

/** Resolve an agent's declared browser grant into a caged playwright server config (server slug →
 *  config). Returns null when the agent declares no browser grant (no caged browser is wired). */
export function playwrightServerFor(grant: BrowserGrant | undefined): McpServerConfig | null {
  if (!grant || !Array.isArray(grant.allowed_origins)) return null;
  return buildPlaywrightCage({
    allowedOrigins: grant.allowed_origins,
    ...(grant.blocked_origins ? { blockedOrigins: grant.blocked_origins } : {}),
    ...(grant.trace_dir ? { traceDir: grant.trace_dir } : {}),
    ...(grant.isolated !== undefined ? { isolated: grant.isolated } : {}),
    ...(grant.headless !== undefined ? { headless: grant.headless } : {}),
  });
}
