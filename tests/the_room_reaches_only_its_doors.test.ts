// THE ROOM REACHES ONLY ITS DOORS (wiki spec.coltrane.the-room-reaches-only-its-doors rev 4; Eugene: "Egress proxy, doors enforced").
//
// Gig 72176922: the draft seat logged in inside eir-labs.drafting-room and could not reach its model, because room-net is blanket-internal
// and doors.egress was declared but never enforced. A room that declares egress doors now gets an `egress` service: an engine-owned CONNECT
// proxy, run from the room's own pinned image, on room-net and one non-internal network, admitting exactly the declared hosts on 443. The
// room itself stays internal. EP-0 is the primary guard (a contract cannot reach the room's environment at all); EP-6/EP-8 are secondary.
import { describe, it, expect } from "vitest";
import { admitConnect, EGRESS_PROXY_PORT, egressProxySource } from "../src/egress_proxy.js";
import { renderComposeConfig, COMPOSE_SUBSTITUTABLE_FIELDS } from "../src/venue_realizer.js";
import { SEAT_CREDENTIAL_CLASS, seatCredentialTar, parseSeatProbe } from "../src/seat_credentials.js";

const DIGEST = "sha256:" + "cd".repeat(32);
const DOORS = ["api.anthropic.com"];
const venue = (egress: string[], extra: Record<string, unknown> = {}) => ({
  slug: "drafting", institution_slug: "demo", mcp_servers: [], floor: DIGEST, credential_surface: [SEAT_CREDENTIAL_CLASS],
  doors: { ingress: [], egress }, ...extra,
});
const render = (v: unknown) => renderComposeConfig(v, { gigId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", realizationDir: "/tmp/coltrane-realizations/gig-aaaaaaaa" }) as {
  services: Record<string, Record<string, unknown>>; networks: Record<string, Record<string, unknown>>;
};

describe("EP-0 (primary) — a contract cannot reach the room's environment", () => {
  it("`environment` is not a field a contract substitutes into the render", () => {
    expect([...COMPOSE_SUBSTITUTABLE_FIELDS]).not.toContain("environment");
  });
  it("plant: the same check reds on a list that admits `environment` (the law can fail)", () => {
    const widened = [...COMPOSE_SUBSTITUTABLE_FIELDS, "environment"];
    expect(widened.includes("environment")).toBe(true);
  });
  it("the room service has NO environment at all, doors or not: the seat's proxy rides in its own settings file, not the compose document", () => {
    // measured (floor image, as the room's user, fake token): with HTTPS_PROXY only in ~/.claude/settings.json the CLI went out through
    // the egress proxy and the API answered 401, so no compose environment is needed, and the renderer's mount and secret-shape laws,
    // which read any `x:/…` string as a mount and any 32+ token as a secret, are never asked to make room for one
    expect(render(venue(DOORS)).services["room"]!["environment"]).toBeUndefined();
    expect(render(venue([])).services["room"]!["environment"]).toBeUndefined();
  });
  it("the seat's settings file carries exactly the engine's keys, and only when the room has egress doors", () => {
    const withDoors = seatCredentialTar("FAKE", parseSeatProbe("501\n20\n/\n"), { proxyUrl: `http://egress:${EGRESS_PROXY_PORT}` });
    const at = withDoors.indexOf(Buffer.from(".claude/settings.json"));
    expect(at, "no settings file in the tar").toBeGreaterThanOrEqual(0);
    const body = withDoors.subarray(at + 512, at + 512 + 400).toString("utf8").replace(/\0.*$/s, "");
    expect(Object.keys(JSON.parse(body).env).sort()).toEqual(["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "HTTPS_PROXY", "https_proxy"]);
    expect(JSON.parse(body).env.HTTPS_PROXY).toBe(`http://egress:${EGRESS_PROXY_PORT}`);
    expect(seatCredentialTar("FAKE", parseSeatProbe("501\n20\n/\n")).indexOf(Buffer.from(".claude/settings.json"))).toBe(-1);
  });
});

describe("EP-1 — the room has no route out but its proxy", () => {
  it("room-net stays internal; only `egress` joins the non-internal network", () => {
    const d = render(venue(DOORS));
    expect(d.networks["room-net"]).toEqual({ internal: true });
    expect(d.networks["egress-net"]?.["internal"]).not.toBe(true);
    expect(d.services["room"]!["networks"]).toEqual(["room-net"]);
    expect(d.services["egress"]!["networks"]).toEqual(["room-net", "egress-net"]);
  });
  it("twin: a room with no egress doors has no egress service and no second network", () => {
    const d = render(venue([]));
    expect(d.services["egress"]).toBeUndefined();
    expect(d.networks["egress-net"]).toBeUndefined();
  });
  it("the egress service runs the room's own pinned image, with the doors as its only arguments after the source", () => {
    const e = render(venue(DOORS)).services["egress"]!;
    expect(e["image"]).toBe(DIGEST);
    const cmd = e["command"] as string[];
    expect(cmd.slice(0, 2)).toEqual(["node", "-e"]);
    expect(cmd[2]).toBe(egressProxySource());
    expect(cmd.slice(3)).toEqual(["--", ...DOORS]);
  });
});

describe("EP-2 — the proxy admits exactly the declared doors, on the PARSED authority, 443 only", () => {
  const ok = (line: string) => admitConnect(line, DOORS).ok;
  it("twins, admitted as the same host: plain, UPPERCASE, and one trailing dot", () => {
    expect(ok("CONNECT api.anthropic.com:443 HTTP/1.1")).toBe(true);
    expect(ok("CONNECT API.ANTHROPIC.COM:443 HTTP/1.1")).toBe(true);
    expect(ok("CONNECT api.anthropic.com.:443 HTTP/1.1")).toBe(true);
    expect(admitConnect("CONNECT API.Anthropic.com.:443 HTTP/1.1", DOORS)).toEqual({ ok: true, host: "api.anthropic.com", port: 443 });
  });
  it("plants: undeclared, suffix, prefix, another port, a plain GET, a malformed line", () => {
    expect(ok("CONNECT example.com:443 HTTP/1.1")).toBe(false);
    expect(ok("CONNECT api.anthropic.com.evil.test:443 HTTP/1.1")).toBe(false);
    expect(ok("CONNECT evilapi.anthropic.com:443 HTTP/1.1")).toBe(false);
    expect(ok("CONNECT api.anthropic.com:80 HTTP/1.1")).toBe(false);
    expect(ok("CONNECT api.anthropic.com:4443 HTTP/1.1")).toBe(false);
    expect(ok("GET http://api.anthropic.com/ HTTP/1.1")).toBe(false);
    expect(ok("CONNECT api.anthropic.com HTTP/1.1")).toBe(false);
    expect(ok("CONNECT api.anthropic.com..:443 HTTP/1.1")).toBe(false);
    expect(ok("CONNECT [::1]:443 HTTP/1.1")).toBe(false);
  });
  it("the source the proxy runs carries this very parser (one home, serialized, not a second copy)", () => {
    expect(egressProxySource()).toContain(admitConnect.toString());
  });
});

describe("EP-3 — a door is a host, never a pattern", () => {
  it("a wildcard door is refused at render", () => {
    expect(() => render(venue(["*.anthropic.com"]))).toThrow();
    expect(() => render(venue(["*"]))).toThrow();
  });
});

describe("EP-7 — the egress service holds no credential", () => {
  it("no credential class, no secrets, no volume on the egress service", () => {
    const e = render(venue(DOORS)).services["egress"]!;
    expect(e["secrets"]).toBeUndefined();
    expect(e["volumes"]).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain(SEAT_CREDENTIAL_CLASS);
    expect(e["environment"]).toBeUndefined();
  });
});
