// A ROOM NEVER RUNS AS ROOT — LIVE (room band: real containers). The unit half, and the full rationale,
// are in tests/a_room_never_runs_as_root.test.ts.
//
// NO LAW HERE CHANGES A HOST SYSCTL: the probe reads kernel.sysrq and writes back the SAME value — a no-op
// even where the write is (wrongly) permitted — and asserts the write is refused. Runs only where Docker
// is up and the image is built; otherwise SKIPPED and printed UNVERIFIED.
//
//   law                                                    kind         drives                                        plant
//   the room images declare a non-root USER                 behavioural  the built images (docker image inspect)         `USER root` (or no USER) in Dockerfile.room/floor
//   a room process is not uid 0                             behavioural  docker run with the RENDERED room options       render `user: 0:0` (src/venue_realizer.ts)
//   a no-op write to /proc/sys/kernel/sysrq is refused      behavioural  same                                           render `user: 0:0` (root + systempaths=unconfined)
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderComposeConfig } from "../src/venue_realizer.js";
import { roomSeatSeccompProfile } from "../src/room_seat_seccomp.js";
import { VenueSchema } from "../src/genome_schema.js";

const FLOOR = () => VenueSchema.parse({
  slug: "seat-room-v1", institution_slug: "quartet", equipment: { tools: ["Read", "Bash"] }, credential_surface: [],
  floor: "seat", mcp_servers: [], lifecycle: { policy: "ephemeral" },
});
function render(dir: string): Record<string, unknown> {
  const doc = renderComposeConfig(FLOOR(), { gigId: "0f0f0000-0000-4000-8000-00000000000a", realizationDir: dir });
  return (doc["services"] as Record<string, Record<string, unknown>>)["room"]!;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
const dockerUp = (() => { try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }); return true; } catch { return false; } })();
const has = (img: string) => dockerUp && spawnSync("docker", ["image", "inspect", img], { stdio: "ignore" }).status === 0;
const FLOOR_IMG = "coltrane/floor:seat";
const why = !dockerUp ? "Docker is not running" : !has(FLOOR_IMG) ? `${FLOOR_IMG} is not built` : "";
if (why) console.warn(`[UNVERIFIED] a_room_never_runs_as_root (live): SKIPPED — ${why}`);

describe("the room images declare a non-root USER (skipped as UNVERIFIED without Docker or the image)", () => {
  for (const img of ["coltrane/room:ephemeral", FLOOR_IMG]) {
    it.skipIf(!has(img))(`${img}: Config.User is set and is not root`, () => {
      const user = execFileSync("docker", ["image", "inspect", img, "--format", "{{.Config.User}}"], { encoding: "utf8" }).trim();
      expect(user, `${img} runs as root by default`).not.toMatch(/^(|root|0)(:.*)?$/);
    });
  }
});

describe("LIVE: a process in a room is not root and cannot write /proc/sys (skipped as UNVERIFIED without Docker or the floor image)", () => {
  it.skipIf(Boolean(why))("under the RENDERED room options: uid != 0, and a no-op write of kernel.sysrq's current value is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "rootcheck-"));
    writeFileSync(join(dir, "seat-seccomp.json"), JSON.stringify(roomSeatSeccompProfile()));
    const svc = render(dir);
    const args = ["run", "--rm", "--entrypoint", "sh"];
    if (typeof svc["user"] === "string") args.push("--user", svc["user"]);
    for (const o of (svc["security_opt"] ?? []) as string[]) args.push("--security-opt", o);
    for (const c of (svc["cap_add"] ?? []) as string[]) args.push("--cap-add", c);
    if (svc["privileged"] === true) args.push("--privileged");
    // Read the current value; write back THE SAME value (a no-op if the write were permitted); report both.
    const script = 'id -u; v=$(cat /proc/sys/kernel/sysrq); if (printf "%s" "$v" > /proc/sys/kernel/sysrq) 2>/tmp/e; then echo WRITE=ok; else echo "WRITE=refused $(cat /tmp/e)"; fi';
    const out = execFileSync("docker", [...args, FLOOR_IMG, "-c", script], { encoding: "utf8", timeout: 120_000 });
    const [uidLine, writeLine] = out.trim().split("\n");
    expect(Number(uidLine), `a room process runs as uid ${uidLine}`).not.toBe(0);
    expect(writeLine, `a room process could write /proc/sys/kernel/sysrq: ${writeLine}`).toMatch(/^WRITE=refused/);
    expect(writeLine, "the refusal was not a permission refusal").toMatch(/Permission denied|Operation not permitted|Read-only file system/i);
  }, 180_000);
});
