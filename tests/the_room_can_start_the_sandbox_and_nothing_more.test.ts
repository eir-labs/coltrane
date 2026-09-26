// A SEAT-BEARING ROOM CAN START THE SEAT'S BASH SANDBOX — AND IS GIVEN NOTHING MORE.
//
// Every Bash seat spawns with sandbox.failIfUnavailable. Inside a room the sandbox is bubblewrap, which
// needs an unprivileged user namespace and mounts inside it; Docker's default seccomp profile denies
// those, so the implementer gave floor rooms a profile = Docker's default + ONE rule for the six calls
// bubblewrap uses, plus `systempaths=unconfined`. Two wires survived its mutation run: the room rendered
// WITHOUT security_opt (every room seat then refused at runtime, and no law noticed), and the profile
// WITHOUT the bubblewrap rule. The other direction matters as much: a room that can start a sandbox must
// not be handed privilege, capabilities, or a profile quietly wider than Docker's default.
//
// "Docker's default otherwise" is pinned by digest: the canonical-JSON SHA-256 of moby v24.0.2
// profiles/seccomp/default.json, fetched by the drafter on 26 Sep 2026 from
// raw.githubusercontent.com/moby/moby/v24.0.2/profiles/seccomp/default.json (12,751 bytes) =
// 2c2917c58715fe65258b72b9941cc9223f52f2b384b1353e3f78ba0e85147884. The profile minus its bubblewrap
// rule must hash to exactly that.
//
//   law                                          kind         drives                                            plant
//   the profile allows the six bwrap calls        behavioural  roomSeatSeccompProfile — src/room_seat_seccomp.ts  drop the appended bubblewrap rule
//   …and is Docker's default otherwise            behavioural  same                                              widen any default rule (e.g. allow
//                                                                                                                   `bpf` unconditionally)
//   a floor room renders the seccomp + /proc opts  behavioural  renderComposeConfig — src/venue_realizer.ts       drop `security_opt` from the floor room
//   …never privileged, never cap_add              behavioural  same                                              add `cap_add: [SYS_ADMIN]` (or privileged)
//   a production-only room keeps Docker defaults  behavioural  same                                              give every room the seat profile
//   realize() writes that exact profile           behavioural  dockerComposeRealizer({run}).realize —            write the profile without the bwrap rule
//                                                              src/venue_realizer.ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roomSeatSeccompProfile, BWRAP_SYSCALLS } from "../src/room_seat_seccomp.js";
import { renderComposeConfig, dockerComposeRealizer, roomSeccompPath } from "../src/venue_realizer.js";
import { VenueSchema } from "../src/genome_schema.js";

const MOBY_V24_0_2_DEFAULT_SHA256 = "2c2917c58715fe65258b72b9941cc9223f52f2b384b1353e3f78ba0e85147884";
const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v);

type Rule = { names: string[]; action: string; args?: unknown; includes?: unknown; excludes?: unknown };
const BWRAP = [...BWRAP_SYSCALLS].sort();
const EXPECTED_BWRAP = ["clone", "mount", "pivot_root", "setns", "umount2", "unshare"];

const floorRoom = (floor: boolean) => ({
  slug: "seat-room-v1", institution_slug: "quartet", equipment: { tools: ["Read", "Bash"] }, credential_surface: [],
  ...(floor ? { floor: "seat" } : {}), mcp_servers: [], lifecycle: { policy: "ephemeral" as const },
});

describe("the seat room's seccomp profile", () => {
  it("allows exactly unshare, clone, mount, umount2, pivot_root and setns — unconditionally, in one appended rule", () => {
    expect(BWRAP, "the exported bubblewrap set drifted").toEqual(EXPECTED_BWRAP);
    const rules = (roomSeatSeccompProfile() as { syscalls: Rule[] }).syscalls;
    const last = rules[rules.length - 1]!;
    expect([...last.names].sort(), "the profile has no bubblewrap rule — every room seat's sandbox is refused").toEqual(EXPECTED_BWRAP);
    expect(last.action).toBe("SCMP_ACT_ALLOW");
    expect(last.args ?? last.includes ?? last.excludes, "the bubblewrap rule is conditional (on args or capabilities), so an unprivileged seat still cannot use it").toBeUndefined();
  });

  it("is Docker's default profile (moby v24.0.2) in every other rule and key — pinned by digest", () => {
    const p = roomSeatSeccompProfile() as { syscalls: Rule[] } & Record<string, unknown>;
    const rest = { ...p, syscalls: p.syscalls.slice(0, -1) };
    expect(createHash("sha256").update(canon(rest)).digest("hex"), "the profile differs from Docker's default beyond the one bubblewrap rule").toBe(MOBY_V24_0_2_DEFAULT_SHA256);
    expect(p["defaultAction"], "the profile's default is not deny").toBe("SCMP_ACT_ERRNO");
  });
});

describe("the rendered room", () => {
  const room = (floor: boolean) => {
    const dir = `/realizations/gig-seatroom${floor ? "1" : "0"}`;
    const doc = renderComposeConfig(VenueSchema.parse(floorRoom(floor)), { gigId: "5ea70000-0000-4000-8000-00000000000a", realizationDir: dir });
    return { dir, svc: (doc["services"] as Record<string, Record<string, unknown>>)["room"]! };
  };

  it("a FLOOR room runs under the seat profile with /proc unmasked", () => {
    const { dir, svc } = room(true);
    expect(svc["security_opt"], "a seat-bearing room was rendered with Docker's default seccomp — its seats' sandboxes cannot start").toEqual(
      expect.arrayContaining([`seccomp=${roomSeccompPath(dir)}`, "systempaths=unconfined"]),
    );
  });

  it("a floor room is never privileged, holds no added capability, and shares no host namespace", () => {
    const { svc } = room(true);
    expect(svc["privileged"] ?? false, "the seat room is privileged").toBe(false);
    expect(svc["cap_add"], `the seat room was handed capabilities: ${JSON.stringify(svc["cap_add"])}`).toBeUndefined();
    for (const k of ["pid", "ipc", "userns_mode", "network_mode"]) {
      expect(String(svc[k] ?? ""), `the seat room shares the host's ${k}`).not.toMatch(/^host$/);
    }
    const opts = (svc["security_opt"] ?? []) as string[];
    expect(opts.filter((o) => /unconfined/.test(o) && !/^systempaths=unconfined$/.test(o)), "a second confinement was switched off (seccomp/apparmor unconfined)").toEqual([]);
  });

  it("a production-only room (no floor) runs no seat and keeps Docker's defaults", () => {
    const { svc } = room(false);
    expect(svc["security_opt"], "a seat-less room was given the seat profile").toBeUndefined();
  });
});

describe("realize() writes that exact profile beside the compose document", () => {
  it("the file the room's seccomp= points at is roomSeatSeccompProfile()", async () => {
    const root = mkdtempSync(join(tmpdir(), "seat-seccomp-"));
    const handle = await dockerComposeRealizer({ run: () => {}, realizationsRoot: root } as never).realize(
      floorRoom(true), async () => ({}), { gigId: "5ea70000-0000-4000-8000-00000000000b" } as never,
    );
    try {
      const composePath = (handle as { configPath?: string }).configPath ?? "";
      expect(composePath, "the realizer reported no compose path").not.toBe("");
      const dir = composePath.slice(0, composePath.lastIndexOf("/"));
      const file = roomSeccompPath(dir);
      expect(existsSync(file), `the realizer wrote no seccomp profile at ${file}`).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8")), "the profile on disk is not the seat profile").toEqual(roomSeatSeccompProfile());
    } finally {
      try { await (handle as { teardown?: () => unknown }).teardown?.(); } catch { /* best effort */ }
    }
  });
});
