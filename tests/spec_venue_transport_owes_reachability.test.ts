// EVERY DECLARED TRANSPORT OWES THE FIELD THAT MAKES IT REACHABLE — AND MUST BE ONE THE ENGINE KNOWS.
//
// THE DEFECT, found while repairing three rooms the engine was silently dropping: `transport` was a
// bare `z.string()`, and the cross-field rule named only `stdio` (owes a command) and `sse` (owes a
// url). So EVERY OTHER SPELLING owed nothing and was checked by nobody:
//
//   · `"http"` — the transport three live rooms actually use for the eir-wiki server — passed with
//     no url, no command, nothing.
//   · `"banana"` passed too. A typo declared a server the realizer would hand to a client that has
//     never heard of it, discovered at use on a box nobody is watching.
//
// The openness was deliberate — the schema's own comment says a bare string keeps a future
// transport an addition rather than a breaking change. That intent survives here; what changes is
// that the future transport must be ADDED rather than merely spelled. `KNOWN_TRANSPORTS` is a named
// set that grows by a one-line edit plus teaching `buildMcpConfigs` what the new transport means —
// the same discipline as this repo's exact law-count pins: openness to the future kept, silent
// acceptance of nonsense refused.
//
// And the reachability rule is stated once, generally: stdio is reached by the command the realizer
// execs; everything else is reached over the wire, by its url. That is what `buildMcpConfigs`
// already does — it special-cases stdio and lets every other transport fall through to url-based
// handling — so the schema now says what the realizer has always meant.
import { describe, expect, it } from "vitest";
import { VenueSchema, KNOWN_TRANSPORTS } from "../src/genome_schema.js";

const room = (server: Record<string, unknown>) => ({
  slug: "transport-probe",
  institution_slug: "chancery",
  responsible_chair: "chancery.chair.steward",
  doors: { ingress: [], egress: ["example.invalid"] },
  credential_surface: [],
  equipment: { tools: [] },
  mcp_servers: [server],
  lifecycle: { policy: "ephemeral", rebuild_cadence: "per-gig" },
});

describe("a declared transport is one the engine knows, and owes its reachability field", () => {
  it("refuses a transport the engine has never heard of — the nonsense case, by name", () => {
    const r = VenueSchema.safeParse(room({ slug: "s", transport: "banana", url: "https://x.invalid" }));
    expect(r.success, "a venue may not declare a transport nothing can act on").toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(" ");
      expect(msg).toContain("banana");
      // the refusal names what IS known, so the author is not left guessing
      for (const t of KNOWN_TRANSPORTS) expect(msg).toContain(t);
    }
  });

  it("refuses http with no url — the case that was live and unchecked", () => {
    // Three rooms (residency, research, live-signal-receiving) declare the eir-wiki server over
    // http. Before this rule, an http declaration with NO url parsed clean and failed at use.
    const r = VenueSchema.safeParse(room({ slug: "eir-wiki", transport: "http" }));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toContain("url");
    }
  });

  it("accepts http WITH a url — the real declaration those rooms carry", () => {
    const r = VenueSchema.safeParse(
      room({ slug: "eir-wiki", transport: "http", url: "https://wiki.eir.sh/api/mcp", credential_names: [] }),
    );
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });

  it("keeps both original rules: stdio owes a command, sse owes a url", () => {
    expect(VenueSchema.safeParse(room({ slug: "s", transport: "stdio", command: [] })).success).toBe(false);
    expect(VenueSchema.safeParse(room({ slug: "s", transport: "sse" })).success).toBe(false);
    expect(
      VenueSchema.safeParse(room({ slug: "s", transport: "stdio", command: ["node", "server.js"] })).success,
    ).toBe(true);
  });
});
