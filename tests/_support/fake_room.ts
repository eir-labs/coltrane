// A realized seat-bearing room, DAEMON-FREE (Eugene, 2 Nov 2026: the baseline gate runs INSIDE the room, not on the host).
//
// A fake `docker` on the skill's PATH stands in for the daemon. It accepts exactly the seats' spawn shape,
// `exec [-i] -w <dir> <container> <argv…>` (src/claude_invoker.ts), logs it, and runs argv with FAKE_ROOM=<container> in its
// environment: what runs through it is marked as in the room, what runs without it is the HOST. A skill child's environment is
// scrubbed (skillEnv), so every path the fixtures log to is written into their text, never passed through the environment.
//
// `roomDeps` is the runGig half: a floored venue (pinned by digest, as the drafting room is) and a recording realizer whose handle
// carries `seat`, so the runtime's own wire from the realized room to a skill chair's context is what the laws exercise.
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VenueSchema } from "../../src/genome_schema.js";
import type { VenueRealizer, RealizationHandle } from "../../src/venue_realizer.js";
import type { Standard } from "../../src/composition.js";

export const ROOM_CONTAINER = "coltrane-gig-red-room-1";

export function fakeRoom(tmps: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "fake-room-")); tmps.push(dir);
  const bin = join(dir, "bin"); mkdirSync(bin);
  const execLog = join(dir, "docker.log"), ranLog = join(dir, "loop-result.log"), gitLog = join(dir, "fsmonitor.log");
  writeFileSync(join(bin, "docker"), `#!/bin/bash
[ "$1" = exec ] || { echo "fake docker: only exec" >&2; exit 125; }
shift; dir=""
while [ $# -gt 0 ]; do case "$1" in -i) shift;; -w) dir="$2"; shift 2;; -u|-e) shift 2;; *) break;; esac; done
[ -n "$dir" ] || { echo "fake docker: the seat's spawn names its -w" >&2; exit 125; }
container="$1"; shift
printf '%s\\t%s\\t%s\\n' "$container" "$dir" "$*" >> ${JSON.stringify(execLog)}
cd "$dir" && FAKE_ROOM="$container" exec "$@"
`);
  chmodSync(join(bin, "docker"), 0o755);
  // the hook a drafter could set as core.fsmonitor: it records where git ran it
  const hook = join(dir, "fsmonitor-hook");
  writeFileSync(hook, `#!/bin/bash\necho "\${FAKE_ROOM:-HOST}" >> ${JSON.stringify(gitLog)}\n`); chmodSync(hook, 0o755);
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
  return { bin, hook, ranLog, ran: () => lines(ranLog), execs: () => lines(execLog), fsmonitor: () => lines(gitLog) };
}
export type FakeRoom = ReturnType<typeof fakeRoom>;

/** A node loop result, marked: each run appends where it ran (the room's name, or HOST) before it answers. */
export const markedLoopResult = (ranLog: string, body: string): string => body.replace("#!/usr/bin/env node\n",
  `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(ranLog)}, (process.env.FAKE_ROOM || "HOST") + "\\n");\n`);

/** runGig deps for a realized floored room whose seat's workspace is `workspace` (bind-mounted at the same path, as in production). */
export function roomDeps(std: Standard, workspace: string) {
  const tools = [...new Set(std.agents.flatMap((a) => a.allowed_tools ?? []))];
  const venue = VenueSchema.parse({ slug: "red-room", institution_slug: "quartet", equipment: { tools }, floor: `sha256:${"a".repeat(64)}`, lifecycle: { policy: "ephemeral" } });
  const handle = { state: "PLAYING", mcpServerConfigs: {}, configPath: "", artifacts: [], teardown: () => {}, tornDown: () => true, seat: { container: ROOM_CONTAINER, workspace } } as unknown as RealizationHandle;
  const venueRealizer = { substrate: "test", guarantees: [], available: () => true, retention: { max_cached_build_artifacts: 0, max_unreferenced_environments: 0, cadence: "gig" },
    realize: async () => handle, sweep: async () => [], release: async () => ({ released: false, said: "" }) } as unknown as VenueRealizer;
  return { venue: "red-room", venues: new Map([["red-room", venue]]), venueRealizer };
}

/** Run `fn` with the fake docker first on PATH (a skill child inherits PATH, and nothing else that matters here). */
export async function withRoomOnPath<T>(room: FakeRoom, fn: () => Promise<T>): Promise<T> {
  const PATH = process.env["PATH"];
  process.env["PATH"] = `${room.bin}:${PATH ?? ""}`;
  try { return await fn(); } finally { process.env["PATH"] = PATH; }
}
