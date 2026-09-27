// A ROOM NEVER RUNS AS ROOT, AND ITS /proc/sys STAYS UNWRITABLE.
//
// Blocking finding 4 of the non-author grade (#553). A seat-bearing room runs with
// `systempaths=unconfined` (so bubblewrap can mount a fresh /proc for the seat's sandbox) and as the
// DRAIN's uid (`user: <uid>:<gid>`). A drain running as root therefore makes a ROOT room with an unmasked
// /proc — and the grader, as uid 0 under the room options, wrote the Docker VM's /proc/sys/kernel/sysrq
// (and could reach /proc/sysrq-trigger, next door to the core_pattern escape).
//
// THE RULE: a room process is never uid 0 — the rendered room refuses a root drain rather than inheriting
// it — the images carry a non-root USER, and /proc/sys/kernel/* is unwritable from inside a room.
//
// NO LAW HERE CHANGES A HOST SYSCTL. The live probe reads kernel.sysrq and writes back the SAME value — a
// no-op even where the write is (wrongly) permitted — and asserts the write is refused (EACCES / EPERM /
// EROFS). Live laws run only where Docker is up and the floor image is built; otherwise they are SKIPPED
// and printed UNVERIFIED.
//
//   law                                                    kind         drives                                        plant
//   a root drain's floor room is refused (or not root)      behavioural  renderComposeConfig — src/venue_realizer.ts     render `user: 0:0` (inherit a root drain's uid)
//   control: a non-root drain renders its own uid           behavioural  same                                           —
//   (the image-USER and LIVE laws are in tests/spec_room_runs_non_root_live.test.ts — the room band, since they
//   run real containers)
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderComposeConfig } from "../src/venue_realizer.js";
import { VenueSchema } from "../src/genome_schema.js";

afterEach(() => vi.restoreAllMocks());
/** process.getuid/getgid are optional on the type (non-POSIX hosts); spy through a widened view. */
const asUid = (uid: number, gid: number) => {
  const p = process as unknown as { getuid: () => number; getgid: () => number };
  vi.spyOn(p, "getuid").mockReturnValue(uid);
  vi.spyOn(p, "getgid").mockReturnValue(gid);
};

const FLOOR = () => VenueSchema.parse({
  slug: "seat-room-v1", institution_slug: "quartet", equipment: { tools: ["Read", "Bash"] }, credential_surface: [],
  floor: "seat", mcp_servers: [], lifecycle: { policy: "ephemeral" },
});
function render(dir = "/realizations/gig-rootcheck"): Record<string, unknown> {
  const doc = renderComposeConfig(FLOOR(), { gigId: "0f0f0000-0000-4000-8000-00000000000a", realizationDir: dir });
  return (doc["services"] as Record<string, Record<string, unknown>>)["room"]!;
}
const uidOf = (user: unknown): number | undefined => (typeof user === "string" ? Number(user.split(":")[0]) : undefined);

describe("a root drain never makes a root room", () => {
  it("with the drain running as uid 0, a floor room is refused — or rendered with a non-root user", () => {
    asUid(0, 0);
    let svc: Record<string, unknown> | undefined;
    let err = "";
    try { svc = render(); } catch (e) { err = String((e as Error)?.message ?? e); }
    if (svc === undefined) { expect(err, "refused without a reason").toMatch(/root|uid/i); return; }
    const uid = uidOf(svc["user"]);
    expect(uid === undefined ? "(image default)" : uid, "a root drain rendered a ROOT room with /proc unmasked").not.toBe(0);
  });

  it("control — a non-root drain renders its own uid", () => {
    asUid(501, 20);
    expect(render()["user"]).toBe("501:20");
  });
});
