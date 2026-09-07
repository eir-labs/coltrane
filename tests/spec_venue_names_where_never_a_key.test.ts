// A ROOM NAMES WHERE — THROUGH ITS OWN DOORS — AND NEVER A KEY.
//
// Three rules the store learned at its venue door (coltrane-ui 20260907100000 / 20260907120000) and
// the engine did not yet carry — ruling A4, "store matches engine", in BOTH directions, so a
// store-valid room is an engine-valid room and the reverse:
//
//   4 · an over-the-wire server is reached at a host the room's own `doors.egress` names. Three
//       live rooms declared the eir-wiki server at wiki.eir.sh through doors that did not name it;
//       `realize()`'s own egress probe would have answered "cannot reach" for the server the room
//       granted tools from. A declaration that contradicts the room's contract is refused at parse.
//   5 · one slug, one server. Two entries under one slug are two authors of WHERE.
//   6 · a url that carries material — userinfo before the host, or a query string — is a key
//       wearing an address. Refused, and the url is not repeated in the refusal.
//
// Each law has a control that shows the rule is what turned the parse, not a `.strict()` shape.
import { describe, expect, it } from "vitest";
import { VenueSchema, mcpServerHost, urlCarriesMaterial } from "../src/genome_schema.js";

const room = (over: Record<string, unknown>) => ({
  slug: "where-probe",
  institution_slug: "chancery",
  responsible_chair: "chancery.chair.steward",
  doors: { ingress: [], egress: ["wiki.eir.sh"] },
  credential_surface: ["wiki-agent-token"],
  equipment: { tools: [] },
  mcp_servers: [
    { slug: "eir-wiki", transport: "http", url: "https://wiki.eir.sh/api/mcp", credential_names: ["wiki-agent-token"] },
  ],
  lifecycle: { policy: "ephemeral", rebuild_cadence: "per-gig" },
  ...over,
});

const messages = (r: ReturnType<typeof VenueSchema.safeParse>): string =>
  r.success ? "" : r.error.issues.map((i) => i.message).join(" | ");

describe("rule 4 — a room reaches what its doors declare", () => {
  it("CONTROL: the wiki room — server at wiki.eir.sh, doors naming wiki.eir.sh — parses", () => {
    expect(messages(VenueSchema.safeParse(room({})))).toBe("");
  });

  it("refuses an over-the-wire server at a host the room's doors do not name, naming server and host", () => {
    const r = VenueSchema.safeParse(room({ doors: { ingress: [], egress: ["example.invalid"] } }));
    expect(r.success).toBe(false);
    expect(messages(r)).toContain(`"eir-wiki" is reached at host "wiki.eir.sh"`);
    expect(messages(r)).toContain("doors.egress");
  });

  it("compares hosts case-insensitively and ignores port, path and userinfo when extracting the host", () => {
    expect(mcpServerHost("https://Wiki.EIR.sh:8443/api/mcp")).toBe("wiki.eir.sh");
    expect(mcpServerHost("https://svc:secret@wiki.eir.sh/api")).toBe("wiki.eir.sh");
    expect(mcpServerHost("not a url")).toBeNull();
    const r = VenueSchema.safeParse(room({
      mcp_servers: [{ slug: "eir-wiki", transport: "http", url: "https://WIKI.eir.sh:443/api/mcp", credential_names: ["wiki-agent-token"] }],
    }));
    expect(messages(r)).toBe("");
  });

  it("a stdio server owes no door: it is a process in the room, not a wire out of it", () => {
    const r = VenueSchema.safeParse(room({
      doors: { ingress: [], egress: [] },
      credential_surface: [],
      mcp_servers: [{ slug: "engine", transport: "stdio", command: ["node", "dist/src/server_entry.js"], credential_names: [] }],
    }));
    expect(messages(r)).toBe("");
  });
});

describe("rule 5 — one slug, one server", () => {
  it("refuses one slug declared twice, naming the slug and both entries", () => {
    const r = VenueSchema.safeParse(room({
      doors: { ingress: [], egress: ["one.invalid", "two.invalid"] },
      credential_surface: [],
      mcp_servers: [
        { slug: "twin", transport: "http", url: "https://one.invalid/mcp", credential_names: [] },
        { slug: "twin", transport: "http", url: "https://two.invalid/mcp", credential_names: [] },
      ],
    }));
    expect(r.success).toBe(false);
    expect(messages(r)).toContain(`"twin" is declared more than once`);
    expect(messages(r)).toContain("entries 0 and 1");
  });

  it("CONTROL: two servers under two slugs parse", () => {
    const r = VenueSchema.safeParse(room({
      doors: { ingress: [], egress: ["one.invalid", "two.invalid"] },
      credential_surface: [],
      mcp_servers: [
        { slug: "one", transport: "http", url: "https://one.invalid/mcp", credential_names: [] },
        { slug: "two", transport: "http", url: "https://two.invalid/mcp", credential_names: [] },
      ],
    }));
    expect(messages(r)).toBe("");
  });
});

describe("rule 6 — a room names WHERE, never a key", () => {
  it("refuses userinfo before the host, and does not repeat the url in the refusal", () => {
    const r = VenueSchema.safeParse(room({
      mcp_servers: [{ slug: "eir-wiki", transport: "http", url: "https://svc:s3cr3tk3y@wiki.eir.sh/api/mcp", credential_names: ["wiki-agent-token"] }],
    }));
    expect(r.success).toBe(false);
    expect(messages(r)).toContain("carries material");
    expect(messages(r)).not.toContain("s3cr3tk3y");
  });

  it("refuses a query string — an api_key in the url is the same key in different clothes", () => {
    expect(urlCarriesMaterial("https://wiki.eir.sh/api/mcp?api_key=sk-live-1")).toBe(true);
    expect(urlCarriesMaterial("https://wiki.eir.sh/api/mcp")).toBe(false);
    const r = VenueSchema.safeParse(room({
      mcp_servers: [{ slug: "eir-wiki", transport: "http", url: "https://wiki.eir.sh/api/mcp?api_key=sk-live-1", credential_names: ["wiki-agent-token"] }],
    }));
    expect(r.success).toBe(false);
    expect(messages(r)).toContain("carries material");
    expect(messages(r)).not.toContain("sk-live-1");
  });
});
