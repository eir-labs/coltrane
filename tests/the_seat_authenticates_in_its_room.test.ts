// THE SEAT AUTHENTICATES IN ITS ROOM (wiki spec.coltrane.the-seat-authenticates-in-its-room rev 1; Vör graded PASS, ledger 1ef94eea).
//
// Gig eec469f3 ran in eir-labs.drafting-room and the draft seat exited "Not logged in": only MCP servers' credential classes were ever
// resolved (venue_realizer.ts), the drain passed no resolver, and nothing put material where the installed claude reads it. Eugene:
// "Forseti provisions it". Vör's ruling: the CLI's OWN credentials file inside the container, never an environment variable (inherited by
// every MCP server the CLI spawns; what crash handlers log) and no shell wrapper. The target is DERIVED FROM THE IMAGE at realization (uid,
// gid, HOME), never a literal the image can drift from. Every value here is a fake; no credential is handled by this suite.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEAT_CREDENTIAL_CLASS, seatClassesFor, parseSeatProbe, seatProbeArgs, seatCredentialTar, fileCredentialResolver,
} from "../src/seat_credentials.js";
import { dockerComposeRealizer } from "../src/venue_realizer.js";

const FAKE = "FAKE-SEAT-TOKEN-not-a-credential-7f3a";
const DIGEST = "sha256:" + "cd".repeat(32);
const SRC = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");

/** A provisioning directory holding one class file, at the given mode. */
function provisioned(content: string | null, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "seat-cred-"));
  if (content !== null) { writeFileSync(join(dir, SEAT_CREDENTIAL_CLASS), content); chmodSync(join(dir, SEAT_CREDENTIAL_CLASS), mode); }
  return dir;
}

describe("SA-2 — the drain's resolver reads a provisioned 0600 file per class; four separate refusals", () => {
  it("twin: a non-empty 0600 file owned by the provisioning identity is the class's material", async () => {
    await expect(fileCredentialResolver(provisioned(FAKE))([SEAT_CREDENTIAL_CLASS])).resolves.toEqual({ [SEAT_CREDENTIAL_CLASS]: FAKE });
  });
  it("plant: an ABSENT file is refused, naming the class", async () => {
    await expect(fileCredentialResolver(provisioned(null))([SEAT_CREDENTIAL_CLASS])).rejects.toThrow(/claude-code-credentials.*(absent|no file)/);
  });
  it("plant: an EMPTY file is refused, separately from absent (the CLI cannot tell them apart; the engine must)", async () => {
    await expect(fileCredentialResolver(provisioned(""))([SEAT_CREDENTIAL_CLASS])).rejects.toThrow(/empty/);
    await expect(fileCredentialResolver(provisioned("  \n"))([SEAT_CREDENTIAL_CLASS])).rejects.toThrow(/empty/);
  });
  it("plant: a file readable by group or others is refused", async () => {
    await expect(fileCredentialResolver(provisioned(FAKE, 0o644))([SEAT_CREDENTIAL_CLASS])).rejects.toThrow(/group or others/);
    await expect(fileCredentialResolver(provisioned(FAKE, 0o640))([SEAT_CREDENTIAL_CLASS])).rejects.toThrow(/group or others/);
  });
  it("the mode refusal names what is checked (group and others), never an exact mode the check does not enforce (Vör, e1849f6b)", async () => {
    const err = await fileCredentialResolver(provisioned(FAKE, 0o644))([SEAT_CREDENTIAL_CLASS]).catch((e) => String(e));
    expect(err).toMatch(/group or others/);
    expect(err).not.toMatch(/must be 0600/);
    // the owner's own bits are not what is checked: 0400 and 0700 are admitted, as the message now says
    await expect(fileCredentialResolver(provisioned(FAKE, 0o400))([SEAT_CREDENTIAL_CLASS])).resolves.toEqual({ [SEAT_CREDENTIAL_CLASS]: FAKE });
    await expect(fileCredentialResolver(provisioned(FAKE, 0o700))([SEAT_CREDENTIAL_CLASS])).resolves.toEqual({ [SEAT_CREDENTIAL_CLASS]: FAKE });
  });
  it("plant: a 0600 file owned by another identity is refused (Vör, 1ef94eea)", async () => {
    const someoneElse = (process.getuid?.() ?? 0) + 4242;
    await expect(fileCredentialResolver(provisioned(FAKE), someoneElse)([SEAT_CREDENTIAL_CLASS])).rejects.toThrow(/owner/);
  });
  it("the refusal never carries the material", async () => {
    try { await fileCredentialResolver(provisioned(FAKE, 0o644))([SEAT_CREDENTIAL_CLASS]); } catch (e) { expect(String(e)).not.toContain(FAKE); }
  });
});

describe("SA-1 — the seat's class is resolved beside the servers'", () => {
  it("a floored room whose surface carries the seat class asks for it", () => {
    expect(seatClassesFor({ floor: DIGEST, credential_surface: [SEAT_CREDENTIAL_CLASS] })).toEqual([SEAT_CREDENTIAL_CLASS]);
  });
  it("twin: an unfloored room has no seat, so no seat class", () => {
    expect(seatClassesFor({ credential_surface: [SEAT_CREDENTIAL_CLASS] })).toEqual([]);
  });
  it("twin: a floored room whose surface does not carry it asks for nothing (the surface is the ceiling)", () => {
    expect(seatClassesFor({ floor: DIGEST, credential_surface: [] })).toEqual([]);
  });
});

describe("SA-1b — a seat credential is resolved only for a floor PINNED BY DIGEST; a seat class without one is refused by name (Vör, ledger after 67c5b192)", () => {
  // seatClassesFor tested floor TRUTHINESS: an absent floor gave [] (no seat) but a TAG floor was truthy, so the seat class was resolved
  // and the mutable tag resolved twice (compose create, then the probe). One gate per case, no overlap: the store's CHECK closed the tag,
  // the engine closed the absence. Now pinnedness is the predicate, and a surface naming the seat class without a pinned floor is a
  // refusal, never a silent degradation to no seat.
  async function realizeVenue(floor: string | undefined) {
    const calls: string[][] = [];
    const run = (args: readonly string[]) => { calls.push([...args]); return args[0] === "run" ? "1000\n1000\n/home/node\n" : ""; };
    const realizer = dockerComposeRealizer({ run: run as never });
    const venue = { slug: "drafting", institution_slug: "demo", mcp_servers: [], ...(floor !== undefined ? { floor } : {}), credential_surface: [SEAT_CREDENTIAL_CLASS] };
    let error: unknown;
    try { await realizer.realize(venue, async () => ({ [SEAT_CREDENTIAL_CLASS]: FAKE }), { gigId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } as never); } catch (e) { error = e; }
    return { calls, error };
  }
  it("plant: a TAG floor with the seat class is refused by name, before the room is created", async () => {
    const { calls, error } = await realizeVenue("chancery-drafting");
    expect(String(error)).toMatch(/claude-code-credentials.*not pinned by digest/);
    expect(calls.some((c) => c[0] === "compose")).toBe(false);
  });
  it("plant: an ABSENT floor with the seat class is refused by name, not degraded to no seat", async () => {
    const { calls, error } = await realizeVenue(undefined);
    expect(String(error)).toMatch(/claude-code-credentials.*not pinned by digest/);
    expect(calls.some((c) => c[0] === "compose")).toBe(false);
  });
  it("twin: a digest floor with the seat class is resolved", () => {
    expect(seatClassesFor({ floor: DIGEST, credential_surface: [SEAT_CREDENTIAL_CLASS] })).toEqual([SEAT_CREDENTIAL_CLASS]);
  });
});

describe("SA-3 — the CLI's own file, at a target DERIVED FROM THE IMAGE, 0600, owned by the image's user", () => {
  it("the probe reads uid, gid and HOME from the floor image itself, with no network", () => {
    const a = seatProbeArgs(DIGEST);
    expect(a.slice(0, 4)).toEqual(["run", "--rm", "--network", "none"]);
    expect(a).toContain(DIGEST);
  });
  it("the target is HOME/.claude/.credentials.json under the probed uid and gid", () => {
    expect(parseSeatProbe("1000\n1000\n/home/node\n")).toEqual({ uid: 1000, gid: 1000, home: "/home/node", dir: "/home/node/.claude", path: "/home/node/.claude/.credentials.json" });
  });
  it("plant: a probe that yields no absolute HOME, or no numeric uid, is refused", () => {
    expect(() => parseSeatProbe("1000\n1000\n\n")).toThrow();
    expect(() => parseSeatProbe("node\n1000\n/home/node\n")).toThrow();
  });
  it("the tar carries .claude/ at 0700 and .credentials.json at 0600, both owned by the probed uid:gid", () => {
    const tar = seatCredentialTar(FAKE, parseSeatProbe("1001\n1002\n/home/app\n"));
    const hdr = (off: number) => ({
      name: tar.subarray(off, off + 100).toString("utf8").replace(/\0.*$/s, ""),
      mode: parseInt(tar.subarray(off + 100, off + 108).toString("utf8"), 8),
      uid: parseInt(tar.subarray(off + 108, off + 116).toString("utf8"), 8),
      gid: parseInt(tar.subarray(off + 116, off + 124).toString("utf8"), 8),
      type: tar.subarray(off + 156, off + 157).toString("utf8"),
    });
    expect(hdr(0)).toEqual({ name: ".claude/", mode: 0o700, uid: 1001, gid: 1002, type: "5" });
    expect(hdr(512)).toEqual({ name: ".claude/.credentials.json", mode: 0o600, uid: 1001, gid: 1002, type: "0" });
    expect(tar.subarray(1024, 1024 + FAKE.length).toString("utf8")).toBe(FAKE);
  });
});

/** Drive the real realizer with a fake docker runner: record every call and its stdin, answer the probe. */
async function realizeWith(material: Record<string, string>) {
  const calls: { args: string[]; input?: Buffer }[] = [];
  const run = (args: readonly string[], _t: number, input?: Buffer) => {
    calls.push({ args: [...args], ...(input ? { input } : {}) });
    if (args[0] === "run" && args.includes("--entrypoint")) return "1000\n1000\n/home/node\n";
    return "";
  };
  const realizer = dockerComposeRealizer({ run: run as never });
  const venue = { slug: "drafting", institution_slug: "demo", mcp_servers: [], floor: DIGEST, credential_surface: [SEAT_CREDENTIAL_CLASS] };
  let error: unknown;
  let handle: unknown;
  try { handle = await realizer.realize(venue, async () => material, { gigId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } as never); } catch (e) { error = e; }
  return { calls, error, handle };
}

describe("SA-5 — \"Not logged in\" is never the first sign: no material refuses at realization, before the room starts", () => {
  it("plant: an empty seat material refuses, naming the class, and the room is never started", async () => {
    const { calls, error } = await realizeWith({ [SEAT_CREDENTIAL_CLASS]: "" });
    expect(String(error)).toMatch(/claude-code-credentials/);
    expect(calls.some((c) => c.args[0] === "compose" && c.args.includes("start")), "the room was started without its seat's credential").toBe(false);
  });
  it("twin: with material, the room is created, the credential is delivered by a tar stream to HOME, and then started", async () => {
    const { calls, error } = await realizeWith({ [SEAT_CREDENTIAL_CLASS]: FAKE });
    expect(error, String(error)).toBeUndefined();
    const cp = calls.find((c) => c.args[0] === "cp" && c.args[1] === "-");
    expect(cp, "no tar-stream delivery").toBeDefined();
    expect(cp!.args[2]).toMatch(/:\/home\/node$/);
    const start = calls.findIndex((c) => c.args[0] === "compose" && c.args.includes("start"));
    expect(calls.indexOf(cp!)).toBeLessThan(start);
  });
});

describe("the value goes nowhere else: not a world-readable secret, not an argument, not the compose file, not the handle (F3)", () => {
  it("the seat class is not delivered to /run/secrets (that path is 0444 by design)", async () => {
    const { calls } = await realizeWith({ [SEAT_CREDENTIAL_CLASS]: FAKE });
    expect(calls.some((c) => c.args[0] === "cp" && String(c.args[2] ?? "").endsWith(":/run")), "the seat credential went to the world-readable secrets path").toBe(false);
  });
  it("no docker argument, and nothing the realization hands back, carries the value; only the tar stream does", async () => {
    const { calls, handle } = await realizeWith({ [SEAT_CREDENTIAL_CLASS]: FAKE });
    for (const c of calls) expect(c.args.join(" ")).not.toContain(FAKE);
    expect(JSON.stringify(handle ?? {})).not.toContain(FAKE);
    expect(calls.filter((c) => c.input && c.input.includes(FAKE)).length).toBe(1);
  });
});

describe("REACHED — the drain and the CLI hand a resolver to the run", () => {
  it("workOnce threads its credentialResolver into the run's deps", () => {
    expect(SRC("worker.ts")).toMatch(/credentialResolver:\s*deps\.credentialResolver/);
  });
  it("the CLI's work path builds fileCredentialResolver from COLTRANE_SEAT_CREDENTIALS_DIR", () => {
    expect(SRC("cli.ts")).toMatch(/fileCredentialResolver\(process\.env\["COLTRANE_SEAT_CREDENTIALS_DIR"\]/);
  });
});
