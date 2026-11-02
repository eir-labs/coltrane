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
