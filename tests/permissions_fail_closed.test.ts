// "A permissions check silently defaults to 'granted' whenever a tool declares no required
// scopes." — reported by a consumer, and correct.
//
// `exposedTools` walked the agent's allowed list and filtered only the tools it RECOGNISED:
// members of READ_TOOLS, WRITE_TOOLS or DEPLOY_TOOLS. A tool in none of those three sets
// matched no branch and fell through to `result.push(tool)` — exposed, unconditionally,
// whatever the grant said. The gate's coverage was its own allowlist, so the tools it had
// never heard of were exactly the ones it could not stop.
//
// That is the wrong default for a capability gate. An unrecognised tool is not a safe tool; it
// is a tool nobody has classified, and the only honest answer is no.
import { describe, it, expect } from "vitest";
import { exposedTools, undeclaredScopeTools, type AccessGrant } from "../src/access_grant.js";

const grant = (p: Partial<AccessGrant["permissions"]>): AccessGrant => ({
  company_id: "c1",
  resource_uri: "repo://x",
  permissions: { read: false, write: false, deploy: false, ...p },
} as AccessGrant);

describe("the capability gate fails CLOSED", () => {
  it("refuses a tool whose scope class nobody declared", () => {
    // The reported defect, in one line. `mystery_tool` is in no scope set, so every branch
    // above skipped it and it was pushed.
    const out = exposedTools({
      phase: "SENSE",
      agent_allowed: ["mystery_tool"],
      grant: grant({ read: true, write: true, deploy: true }),
    });
    expect(
      out,
      "an unclassified tool is not a safe tool — it is one nobody has classified",
    ).toEqual([]);
  });

  it("refuses it even under a grant that permits everything", () => {
    // Guards against a fix that merely made the denial depend on the grant. The point is that
    // an undeclared tool has no scope to check the grant against.
    for (const g of [{ read: true }, { write: true }, { deploy: true }, { read: true, write: true, deploy: true }]) {
      expect(exposedTools({ phase: "CREATE", agent_allowed: ["not_a_known_tool"], grant: grant(g) })).toEqual([]);
    }
  });

  it("still exposes a declared tool the grant permits — the gate is not simply off", () => {
    // The failure mode of an over-broad fix: deny everything and every test above passes while
    // the engine can no longer run a chair.
    expect(
      exposedTools({ phase: "SENSE", agent_allowed: ["type_browse"], grant: grant({ read: true }) }),
    ).toEqual(["type_browse"]);
    expect(
      exposedTools({ phase: "CREATE", agent_allowed: ["file_write"], grant: grant({ write: true }) }),
    ).toEqual(["file_write"]);
  });

  it("still refuses a declared tool the grant withholds", () => {
    expect(exposedTools({ phase: "SENSE", agent_allowed: ["type_browse"], grant: grant({ read: false }) })).toEqual([]);
    expect(exposedTools({ phase: "CREATE", agent_allowed: ["file_write"], grant: grant({ write: false }) })).toEqual([]);
    expect(exposedTools({ phase: "CREATE", agent_allowed: ["deploy"], grant: grant({ deploy: false }) })).toEqual([]);
  });

  it("still respects the phase rules", () => {
    // A write tool outside CREATE stays refused regardless of the grant.
    expect(exposedTools({ phase: "SENSE", agent_allowed: ["file_write"], grant: grant({ write: true }) })).toEqual([]);
  });

  it("filters a mixed list rather than failing the whole call", () => {
    const out = exposedTools({
      phase: "SENSE",
      agent_allowed: ["type_browse", "mystery_tool", "output_query"],
      grant: grant({ read: true }),
    });
    expect(out).toEqual(["type_browse", "output_query"]);
  });
});

describe("the undeclared tools are visible BEFORE a denial", () => {
  // A gate that silently drops a tool at run time trades one silent failure for another: the
  // chair simply does not get its tool and the model works around it. Listing them lets an
  // operator see the problem while authoring, not while paying for a run.
  it("names the tools that have no declared scope", () => {
    expect(undeclaredScopeTools(["type_browse", "mystery_tool", "file_write"])).toEqual(["mystery_tool"]);
  });

  it("returns nothing when every tool is classified", () => {
    expect(undeclaredScopeTools(["type_browse", "file_write", "deploy"])).toEqual([]);
  });

  it("agrees with the gate — anything it names is refused, and vice versa", () => {
    // The two must not drift: a tool reported as undeclared but silently exposed, or exposed
    // but reported, is the same class of two-answers-to-one-question defect as the rest.
    const all = ["type_browse", "output_query", "file_write", "deploy", "zzz_unknown", "another_unknown"];
    const undeclared = new Set(undeclaredScopeTools(all));
    const exposed = new Set(
      exposedTools({ phase: "CREATE", agent_allowed: all, grant: grant({ read: true, write: true, deploy: true }) }),
    );
    for (const t of all) {
      expect(undeclared.has(t) && exposed.has(t), `${t} cannot be both undeclared and exposed`).toBe(false);
    }
    expect([...undeclared]).toEqual(["zzz_unknown", "another_unknown"]);
  });
});
