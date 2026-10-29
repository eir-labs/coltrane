// THE DRAIN NAMES THE ROOMS IT CAN BUILD. WorkerContext.realizableVenues is the claim gate's answer to "can this box stand this room up"
// (venueMayClaim, worker.ts), and nothing on the drain path ever set it — measured 3 Oct (a_furnished_room_is_claimed_and_mounted's
// header) and again 29 Oct, when the testable charter's red pass (gig 605d5500, stack rp1) was refused at the claim with
// "realizable: []" by a worker that held a docker realizer (cli.ts wires dockerComposeRealizer()). Every test set the field by hand, so
// the gate's laws passed while the CLI could never claim a floored room.
//
// The box declares its rooms in COLTRANE_REALIZABLE_VENUES, comma-separated slugs. Deny-by-default holds: absent or empty declares none,
// and no wildcard exists ("*" is a slug that names no room). The CLI's work path reads it through one function and hands it to workOnce.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realizableVenuesFromEnv, WORKER_ENV_CONTRACT } from "../src/worker_env.js";
import { venueMayClaim } from "../src/worker.js";

const CLI = readFileSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf8");

describe("the drain names the rooms it can build", () => {
  it("absent or empty declares no room: a floored room's claim stays refused", () => {
    expect(realizableVenuesFromEnv({})).toEqual([]);
    expect(realizableVenuesFromEnv({ COLTRANE_REALIZABLE_VENUES: "" })).toEqual([]);
    expect(realizableVenuesFromEnv({ COLTRANE_REALIZABLE_VENUES: " , " })).toEqual([]);
    expect(venueMayClaim("eir-labs.drafting-room", realizableVenuesFromEnv({}))).toBe(false);
  });

  it("names parse exactly: comma-separated, trimmed; a declared room is claimable and another is not", () => {
    const r = realizableVenuesFromEnv({ COLTRANE_REALIZABLE_VENUES: " eir-labs.drafting-room ,other-room" });
    expect(r).toEqual(["eir-labs.drafting-room", "other-room"]);
    expect(venueMayClaim("eir-labs.drafting-room", r)).toBe(true);
    expect(venueMayClaim("eir-labs.laboratory", r)).toBe(false);
  });

  it("plant: there is no wildcard; '*' claims no room", () => {
    expect(venueMayClaim("eir-labs.drafting-room", realizableVenuesFromEnv({ COLTRANE_REALIZABLE_VENUES: "*" }))).toBe(false);
  });

  it("the variable is in the worker's environment contract, as tuning on the worker's own box", () => {
    const v = WORKER_ENV_CONTRACT.find((x) => x.name === "COLTRANE_REALIZABLE_VENUES");
    expect(v, "an undeclared variable is an undocumented dependency").toBeDefined();
    expect(v!.required).toBe("never");
  });

  it("REACHED: the CLI's work path hands the parsed set to workOnce (the field is no longer declared and never set)", () => {
    // the work subcommand's workOnce call carries realizableVenues from the one parser, read from process.env
    const call = CLI.slice(CLI.indexOf("res = await workOnce("), CLI.indexOf("res = await workOnce(") + 1200);
    expect(call).toMatch(/realizableVenues:\s*realizableVenuesFromEnv\(process\.env\)/);
  });
});
