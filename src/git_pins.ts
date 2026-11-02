// The engine's pinned git settings — ONE source for every git read the engine makes in a tree it does not own.
//
// Moved out of src/runtime.ts (where gitInvocation still builds every engine read from them) so a skill chair that reads git
// on the HOST imports the same pins instead of restating them. scope-gate does: it runs `git diff --cached` and
// `git show :<path>` in the drafter's workspace, and an index read runs whatever command `core.fsmonitor` names. The drafter
// can write that workspace's .git/config (loop-result's plant SQL is a shell), so an unpinned read would run drafter code on
// the host (independent review of #598, finding 2). `-c` on the command line outranks every config file, including one the
// repository's own config pulls in through include/includeIf, so these settings hold whatever .git/config says.
//
// Every pin names git's own default, so on an ordinary checkout not one value moves.

/** Pinned environment: the host and the account contribute nothing to a read's answer. */
export const GIT_PINNED_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  // A snapshot is a commit object, and a commit object needs an identity. With the account's own
  // settings pinned away, git would otherwise guess one from the host's user database — which
  // differs per machine and is absent entirely in a bare container. Stated, so the snapshot is
  // written the same way everywhere and never fails for want of a name.
  GIT_AUTHOR_NAME: "coltrane",
  GIT_AUTHOR_EMAIL: "coltrane@invalid",
  GIT_COMMITTER_NAME: "coltrane",
  GIT_COMMITTER_EMAIL: "coltrane@invalid",
};

/** Pinned on EVERY invocation, ahead of the subcommand. */
export const GIT_PINNED_SETTINGS: readonly string[] = [
  "-c", "core.fsmonitor=",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.attributesFile=/dev/null",
];

/**
 * Pinned on ONE subcommand, where the general pins above have no equivalent: `diff` and `show` are asked for git's own rendering of
 * the objects, never one a repository's config or .gitattributes selects (diff.external, a diff driver, a textconv). Moved here from
 * src/runtime.ts so a host caller builds from the same table (Vör at 224d1fd, F-2: `show` was closed by its argument, not by a pin).
 */
export const GIT_SUBCOMMAND_PINS: ReadonlyMap<string, readonly string[]> = new Map([
  ["diff", ["--no-textconv", "--no-ext-diff"] as readonly string[]],
  ["show", ["--no-textconv", "--no-ext-diff"] as readonly string[]],
]);

/** The pinned argv for `git <args>`: the settings ahead of the subcommand, the subcommand's own pins right after it, the caller's
 *  arguments after those, in order. */
export function pinnedGitArgs(args: readonly string[]): string[] {
  const [subcommand, ...rest] = args;
  return [...GIT_PINNED_SETTINGS, ...(subcommand === undefined ? [] : [subcommand, ...(GIT_SUBCOMMAND_PINS.get(subcommand) ?? [])]), ...rest];
}

/** The pinned environment for a host git: the parent's environment with EVERY GIT_* removed (GIT_CONFIG_COUNT/KEY/VALUE and
 *  GIT_CONFIG_PARAMETERS would otherwise add config no pin names; GIT_DIR and friends would aim the read elsewhere), then
 *  GIT_PINNED_ENV laid over it (Vör at 224d1fd, F-1 and his pre-committed plant). */
export function pinnedGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("GIT_")) out[k] = v;
  return { ...out, ...GIT_PINNED_ENV };
}
