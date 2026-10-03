// A ROOM FURNISHES ITS REACH — connectors with grants on the venue; the first kind is GitHub.
// (spec: wiki spec.one-write-path.a-room-furnishes-its-reach; founder's rulings R38, 3 Oct 2026)
//
// THE RULING. "one to many repos is a very common case for a gig … repositories if commonly empty
// seems like fluff in the wrong place which means also likely multiple contract enforcement
// surfaces." What a gig may reach — repositories, the wiki, Notion — is what its ROOM furnishes,
// segmented by grant profile per connector, of which GitHub is one. Typed input carries only what is
// genuinely input (a change-request's `repository`: the tree the change lands in). There is no
// "primary"; there is no `repositories[]` on any domain type.
//
// THIS FILE pins the engine half's first clause: the schema. A venue declares `connectors`, each
// `{ kind, slug?, grant, credential_names? }`; `kind: "github"` grants a flat list of repository URLs
// and a permission level. The rules a room is refused on, by name, are the same shape as the mcp
// rules beside them (R1–R3 on VenueSchema): a grant that cannot be understood is a breach, not a
// default.
//
//   C1  a github connector with a grant parses; the grant is read back normalized
//   C2  a repository that is not https://github.com/<owner>/<repo> is refused by name — the broker
//       mints only for GitHub, so a room cannot grant what no broker can honour
//   C3  two spellings of one repository (trailing slash, .git) are ONE grant; the duplicate is refused
//       by name rather than silently collapsed — the room's author meant one of them
//   C4  one github connector per room — a second is two versions of the same grant (the "primary"
//       antipattern at the connector level), refused by name
//   C5  an unknown connector kind is refused by name: the set of kinds is NAMED and grows by an edit
//       here plus a broker that honours it, exactly as KNOWN_TRANSPORTS does for servers
//   C6  a connector's credential_names must sit inside the room's credential_surface (rule 3,
//       generalized from servers to connectors)
//   C7  a room that declares no connectors is unchanged: `connectors` defaults to [] — every room on
//       the live store today parses as before
//   C8  the advertised venue_define surface names `connectors` (the hosted door's keys are
//       Object.keys(VenueObjectSchema.shape), so a key the schema holds is a key the door accepts)
//   C9  githubGrant(venue) is the ONE reader: the normalized repository list and permission, or
//       undefined for a room with no github connector — what the workspace, the broker request and
//       the simulate report all read, so none of them re-derives the grant
import { describe, expect, it } from "vitest";
import { VenueSchema, VenueObjectSchema, KNOWN_CONNECTOR_KINDS, githubGrant, normalizeRepoUrl } from "../src/genome_schema.js";

const room = (extra: Record<string, unknown>) => ({
  slug: "lineage-reading",
  institution_slug: "eir-labs",
  responsible_chair: "eir-labs.chair.root",
  doors: { ingress: [], egress: ["github.com", "api.github.com"] },
  credential_surface: [],
  equipment: { tools: ["Read", "Glob", "Grep"] },
  mcp_servers: [],
  lifecycle: { policy: "ephemeral", rebuild_cadence: "per-gig" },
  ...extra,
});

const FOUR = [
  "https://github.com/eir-labs/coltrane",
  "https://github.com/eir-labs/coltrane-ui",
  "https://github.com/eir-labs/chancery",
  "https://github.com/eir-labs/coltrane-conformance",
];

const issuesOf = (r: ReturnType<typeof VenueSchema.safeParse>): string =>
  r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");

describe("a room furnishes its reach — the github connector", () => {
  it("C1 a github connector with a grant parses, and the grant reads back normalized", () => {
    const r = VenueSchema.safeParse(room({
      connectors: [{ kind: "github", grant: { repositories: [...FOUR.slice(0, 3), "https://github.com/eir-labs/coltrane-conformance.git"], permissions: "contents:read" } }],
    }));
    expect(r.success, issuesOf(r)).toBe(true);
    if (!r.success) return;
    const g = githubGrant(r.data);
    expect(g, "githubGrant must read the connector back").toBeDefined();
    expect(g!.repositories, "the grant is normalized: no trailing .git").toEqual(FOUR);
    expect(g!.permissions).toBe("contents:read");
  });

  it("C2 a repository that is not https://github.com/<owner>/<repo> is refused by name", () => {
    for (const bad of ["git@github.com:eir-labs/coltrane.git", "https://gitlab.com/eir-labs/coltrane", "https://github.com/eir-labs", "ext::sh -c id", ""]) {
      const r = VenueSchema.safeParse(room({ connectors: [{ kind: "github", grant: { repositories: [bad] } }] }));
      expect(r.success, `accepted a repository no broker can honour: ${JSON.stringify(bad)}`).toBe(false);
      if (!r.success) expect(issuesOf(r)).toMatch(/connectors\.0\.grant\.repositories/);
    }
  });

  it("C3 two spellings of one repository are one grant; the duplicate is refused by name, never silently collapsed", () => {
    const r = VenueSchema.safeParse(room({
      connectors: [{ kind: "github", grant: { repositories: ["https://github.com/eir-labs/coltrane", "https://github.com/eir-labs/coltrane/"] } }],
    }));
    expect(r.success).toBe(false);
    if (!r.success) expect(issuesOf(r)).toMatch(/connectors\.0\.grant\.repositories.*twice|names .*coltrane.* twice/s);
    expect(normalizeRepoUrl("https://github.com/eir-labs/coltrane.git/")).toBe("https://github.com/eir-labs/coltrane");
  });

  it("C4 one github connector per room — a second is two versions of the same grant, refused by name", () => {
    const r = VenueSchema.safeParse(room({
      connectors: [
        { kind: "github", grant: { repositories: [FOUR[0]!] } },
        { kind: "github", grant: { repositories: [FOUR[1]!] } },
      ],
    }));
    expect(r.success).toBe(false);
    if (!r.success) expect(issuesOf(r)).toMatch(/connectors\.1.*one github connector|more than one github connector/s);
  });

  it("C5 an unknown connector kind is refused by name; the set of kinds is NAMED", () => {
    expect(KNOWN_CONNECTOR_KINDS).toContain("github");
    const r = VenueSchema.safeParse(room({ connectors: [{ kind: "ftp", grant: { host: "x" } }] }));
    expect(r.success).toBe(false);
    if (!r.success) expect(issuesOf(r)).toMatch(/connectors\.0/);
  });

  it("C6 a connector's credential_names must sit inside the room's credential_surface", () => {
    const r = VenueSchema.safeParse(room({
      credential_surface: [],
      connectors: [{ kind: "github", grant: { repositories: [FOUR[0]!] }, credential_names: ["github-app-token"] }],
    }));
    expect(r.success).toBe(false);
    if (!r.success) expect(issuesOf(r)).toMatch(/connectors\.0\.credential_names.*credential_surface/s);
    const ok = VenueSchema.safeParse(room({
      credential_surface: ["github-app-token"],
      connectors: [{ kind: "github", grant: { repositories: [FOUR[0]!] }, credential_names: ["github-app-token"] }],
    }));
    expect(ok.success, issuesOf(ok)).toBe(true);
  });

  it("C7 a room that declares no connectors is unchanged — connectors defaults to []", () => {
    const r = VenueSchema.safeParse(room({}));
    expect(r.success, issuesOf(r)).toBe(true);
    if (r.success) {
      expect(r.data.connectors).toEqual([]);
      expect(githubGrant(r.data), "no github connector → no grant, not an empty grant").toBeUndefined();
    }
  });

  it("C8 the advertised venue_define surface names `connectors`", () => {
    expect(Object.keys(VenueObjectSchema.shape)).toContain("connectors");
  });

  it("C9 githubGrant is the one reader: normalized list, permission defaulting to contents:read", () => {
    const r = VenueSchema.safeParse(room({ connectors: [{ kind: "github", grant: { repositories: ["https://github.com/eir-labs/coltrane-ui/"] } }] }));
    expect(r.success, issuesOf(r)).toBe(true);
    if (!r.success) return;
    expect(githubGrant(r.data)).toEqual({ repositories: ["https://github.com/eir-labs/coltrane-ui"], permissions: "contents:read" });
  });
});
