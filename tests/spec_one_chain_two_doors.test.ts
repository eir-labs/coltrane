// ════════════════════════════════════════════════════════════════════════════════════════════════
// SPEC — one chain, two doors. Laws C1–C6, RED-first. See docs/specs/SPEC-one-chain-two-doors.md.
//
// A gig arrives one of several ways; what happens to it afterwards is meant to be ONE thing. Today it
// is four: runGig has four call sites (server.ts:1113 wait:true, server.ts:1198 async, worker.ts:1096
// drain, chart.ts:1006 movement), each hand-assembling its deps — and they have already diverged. The
// measured divergence this spec was written for: a change-request carrying a TYPED `repository` (the
// field domain_types/change-request.json defines) is honoured by the drain (resolveWorkingRepo reads
// claim.input.repository, worker.ts:144) and IGNORED by a direct dispatch (which reads args['repo_url']
// at server.ts:771 and never input.repository). One fact, two names, one per door.
//
// These are the six laws, RED against unmodified main. A failure in a spec_* file is a feature not yet
// built; do not weaken a law to make CI green — implement it.
//
// ── HOW THESE LAWS STAY RED ON BEHAVIOUR, NOT ON A COMPILE ERROR ──────────────────────────────────
// This repo's vitest globalSetup builds first, and ONE tsc error stops every band — at which point a
// pending spec is indistinguishable from a regression. So no law here STATICALLY imports a symbol that
// does not exist yet:
//   · The shared assembler (C1/C5) and the relocated resolver (C2) are reached by TEXT-parsing source
//     files (readFileSync) and by DYNAMIC import through a string specifier — tsc cannot see the
//     missing export, so the law fails at RUNTIME (the export is absent) rather than at compile.
//   · C3/C6 drive the REAL gig_dispatch handler (dispatchTool) and the REAL drain resolver
//     (resolveWorkingRepo, which EXISTS on main), observing the repository each door actually resolves
//     — the behavioural defect, never a thrown import.
// The names the create-change phase must create are pinned in ONE place each, below, and are documented
// as the contract in docs/specs/SPEC-one-chain-two-doors.md.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createRegistry, createOutputStore, MemoryLedger,
  type AgentInvoker, type DomainType,
} from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { resolveWorkingRepo } from "../src/worker.js";
import type { Standard, Agent } from "../src";
import type { Venue } from "../src/chart.js";
import type { VenueRealizer, RealizationHandle } from "../src/venue_realizer.js";
import { testAgent } from "./_support/agents.js";

// ── THE CONTRACT SYMBOLS the create-change phase must create (pinned once) ─────────────────────────
/** The single exported run-deps assembler (C1/C4/C5), to live in src/run_deps.ts — the established
 *  neutral shared-boundary module that already exports engineToolProviders()/drainBudget(). */
const ASSEMBLER = "assembleRunDeps";
/** src/run_deps.ts is where the shared resolver (C2) moves to. Reached by DYNAMIC import so a missing
 *  export is a runtime absence, not a tsc error. run_deps.js exists on main (it just lacks the export),
 *  so the import itself always resolves. */
const RUN_DEPS_SPECIFIER = "../src/run_deps.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8");
/** Strip block + line comments, so a law about CODE is never satisfied by prose that merely names a
 *  symbol (run_deps.ts mentions `mcpServerConfigs` twice in its header comment). */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const countOccurrences = (s: string, needle: string): number => s.split(needle).length - 1;

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// DISPATCH HARNESS — the REAL gig_dispatch handler, with a realizer that RECORDS the repository the
// door resolved. runtime.ts:1093-1099 threads deps.repoUrl into venueRealizer.realize()'s opts, and a
// room that declares mcp_servers realizes even when repoUrl is absent — so opts.repoUrl is the exact,
// observable value the dispatch door resolved for the run. (Same instrument as
// tests/venue_dispatch/standard_path_honours_venue.test.ts.)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const note: DomainType = {
  slug: "note", extends: "Signal", domain: "demo",
  schema: { properties: { t: { type: "string" } } }, required_fields: ["t"],
};
const SIGNAL = { source: "fixture://demo/note" }; // note is Signal-cored: every payload names its origin

/** A one-chair standard whose sole agent grants Read — the room equips Read, so the ceiling
 *  intersection is non-empty and policy realization succeeds. */
function standard(): Standard {
  const scout = testAgent({
    slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo",
    allowed_tools: ["Read"],
  }) as Agent;
  return {
    slug: "room-probe-v1", domain: "demo", agents: [scout],
    phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
  };
}

/** A room that equips Read AND declares an mcp server — so runGig reaches the substrate realizer even
 *  when the run names no repository, making opts.repoUrl observable in every case. */
const engineRoom: Venue = {
  slug: "engine-room-v1", institution_slug: "quartet",
  equipment: { tools: ["Read"] }, doors: { ingress: [], egress: [] }, installs: [],
  credential_surface: [], mcp_servers: [{ slug: "engine", transport: "stdio", command: ["engine-mcp"], credential_names: [] }],
  lifecycle: { policy: "ephemeral" },
} as unknown as Venue;

/** A realizer that RECORDS the repoUrl handed to realize() — the repository the dispatch door resolved
 *  and threaded into the run. */
function recordingRealizer(): { realizer: VenueRealizer; repoUrls: () => Array<string | undefined> } {
  const seen: Array<string | undefined> = [];
  const handle: RealizationHandle = {
    state: "PLAYING", mcpServerConfigs: {}, configPath: "", artifacts: [],
    teardown: () => {}, tornDown: () => true,
  } as unknown as RealizationHandle;
  const realizer = {
    substrate: "test", guarantees: [], available: () => true,
    retention: { max_cached_build_artifacts: 0, max_unreferenced_environments: 0, cadence: "gig" },
    realize: async (_venue: unknown, _cr: unknown, opts: { repoUrl?: string }) => {
      seen.push(opts?.repoUrl);
      return handle;
    },
  } as unknown as VenueRealizer;
  return { realizer, repoUrls: () => seen };
}

function deps(invoke: AgentInvoker, extra: Partial<ServerDeps> = {}): ServerDeps {
  const registry = createRegistry();
  registry.registerType(note);
  const std = standard();
  return {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    standards: new Map([[std.slug, std]]), invoke, gig_runs: new Map(),
    venues: new Map([[engineRoom.slug, engineRoom]]),
    ...extra,
  };
}

/** The claim the DRAIN door sees for the same work — resolveWorkingRepo(claim) is the drain's REAL
 *  resolution (worker.ts:144), unit-covered by tests/the_repo_is_typed_input.test.ts. */
type Claim = Parameters<typeof resolveWorkingRepo>[0];
const drainClaim = (input: Record<string, unknown>, repo_url?: string): Claim =>
  ({ gig_id: "g", standard_slug: "s", standard_version: null, mode: "live", input, acting_for: "a", ...(repo_url ? { repo_url } : {}) }) as Claim;

/** A change-request carrying a TYPED repository and NO repo_url argument — the exact shape the drain
 *  honours and a direct dispatch ignores on unmodified main. */
const TYPED_REPO = "https://github.com/eir-labs/telescope";

const okInvoke: AgentInvoker = () => ({ t: "hi", ...SIGNAL });

async function waitFor(pred: () => boolean, ms = 2500): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// C1 — ONE ASSEMBLER. There is exactly one exported function that builds a gig's run-deps, and every
// runGig call site obtains its deps from it.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("C1 — one assembler builds every gig's run-deps", () => {
  it("C1.a src/run_deps.ts exports the single run-deps assembler", () => {
    const src = read("src/run_deps.ts");
    expect(
      new RegExp(`export\\s+(async\\s+)?function\\s+${ASSEMBLER}\\b|export\\s+const\\s+${ASSEMBLER}\\b`).test(src),
      `src/run_deps.ts must export ${ASSEMBLER}() — the ONE place a gig's run-deps are built, so the ` +
        `four call sites stop hand-assembling four bodies that diverge.`,
    ).toBe(true);
  });

  it("C1.b the gig_dispatch door obtains its deps from the assembler (not a hand-rolled literal)", () => {
    const src = read("src/server.ts");
    expect(
      src.includes(ASSEMBLER),
      `src/server.ts must import and use ${ASSEMBLER} — the dispatch door builds its run-deps from the ` +
        `shared assembler, not from an inline object literal per branch.`,
    ).toBe(true);
    expect(
      countOccurrences(src, `${ASSEMBLER}(`),
      `${ASSEMBLER}() is never called in server.ts — the dispatch door still hand-assembles its deps.`,
    ).toBeGreaterThanOrEqual(1);
  });

  it("C1.c the drain door obtains its deps from the assembler", () => {
    const src = read("src/worker.ts");
    expect(
      countOccurrences(src, `${ASSEMBLER}(`),
      `${ASSEMBLER}() is never called in worker.ts — the drain still hand-assembles the nine wires ` +
        `run-deps parity had to pin by hand.`,
    ).toBeGreaterThanOrEqual(1);
  });

  it("C1.d the chart movement inherits assembled deps and resolves NO repository of its own", () => {
    // A PASS-THROUGH guard (green on main and after): chart.ts:1006 spreads its calling door's deps
    // (movementDeps = { ...deps }), so it inherits repoUrl from the assembler transitively. This law
    // forbids the fix — or any future edit — from growing an independent fourth resolver here, which
    // would re-introduce the very divergence the assembler removes (john, chart.ts:990-1001).
    const src = read("src/chart.ts");
    expect(
      /\bresolveWorkingRepo\b|["']repo_url["']/.test(src),
      `chart.ts must inherit repoUrl from its calling door's assembled deps, never resolve its own — a ` +
        `fourth independent resolver is a new divergence source.`,
    ).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// C2 — THE REPOSITORY HAS ONE RESOLVER. resolveWorkingRepo moves to the shared module and is the only
// thing that answers "which repository". The typed input is authoritative; an explicit dispatch
// argument (repo_url) and the org column are fallbacks, IN THAT ORDER, and the order is asserted.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("C2 — one shared resolver, three tiers, order asserted", () => {
  it("C2 typed input.repository ▸ explicit repo_url argument ▸ org column", async () => {
    // Reached by DYNAMIC import: on main src/run_deps.ts exports no resolver, so `resolve` is undefined
    // and the first assertion fails at RUNTIME (never a tsc error). The middle tier is the NEW one —
    // the only resolver on main (resolveWorkingRepo, worker.ts:144) has just two tiers (typed → org)
    // and honours no explicit repo_url argument, so the tier-2 assertion fails on behaviour.
    const mod = (await import(RUN_DEPS_SPECIFIER)) as {
      resolveWorkingRepo?: (claim: Claim, explicitRepoUrl?: string) => string | null;
    };
    const resolve = mod.resolveWorkingRepo;
    expect(
      typeof resolve,
      `src/run_deps.ts must export the shared resolveWorkingRepo(claim, explicitRepoUrl?) — moved here ` +
        `from worker.ts so both doors call ONE resolver. (Keep its arity 1 via a default initializer on ` +
        `explicitRepoUrl, so tests/the_repo_is_typed_input R0 — resolveWorkingRepo.length === 1 — stays green.)`,
    ).toBe("function");
    const r = resolve!;
    // TIER 1 — the typed input wins over BOTH fallbacks.
    expect(
      r(drainClaim({ repository: "typed" }, "org"), "explicit"),
      "the typed input.repository is authoritative over an explicit repo_url and the org column",
    ).toBe("typed");
    // TIER 2 — the explicit repo_url argument beats the org column when the typed input is absent.
    expect(
      r(drainClaim({}, "org"), "explicit"),
      "an explicit repo_url argument must beat the org column — the dispatch door's argument, honoured " +
        "beneath the typed input and above the org default",
    ).toBe("explicit");
    // TIER 3 — the org column is the last fallback (single-repo orgs keep working).
    expect(
      r(drainClaim({}, "org")),
      "the org column is the last-resort fallback, so existing single-repo deployments keep working",
    ).toBe("org");
    // NONE — a research standard names no repository and gets none.
    expect(
      r(drainClaim({})),
      "no repository named anywhere → null; a research standard touches no tree",
    ).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// C3 — A TYPED `repository` IS HONOURED BY EVERY DOOR. The SAME change-request, dispatched directly and
// resolved through the drain, yields the SAME repository. THE crown law — it is the one that would have
// caught the defect this spec was written for.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("C3 — a typed repository resolves the same through the dispatch door and the drain door", () => {
  it("C3 dispatch and drain resolve the SAME repository for one typed-`repository` change-request", async () => {
    const { realizer, repoUrls } = recordingRealizer();
    const d = deps(okInvoke, { venueRealizer: realizer });

    // THE DISPATCH DOOR (real handler): a change-request carrying input.repository and NO repo_url arg.
    const r = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "room-probe-v1", input: { repository: TYPED_REPO }, venue: "engine-room-v1", wait: true },
      d,
    );
    expect(r.ok, r.error).toBe(true);
    // Non-vacuity guard: realize() must have run, or repoUrl would read undefined for the WRONG reason.
    expect(repoUrls().length, "the room realized, so the resolved repoUrl is observable").toBeGreaterThan(0);
    const dispatchResolved = repoUrls()[0];

    // THE DRAIN DOOR (real resolver): the same typed input, resolved as worker.ts:975/1092 resolve it.
    const drainResolved = resolveWorkingRepo(drainClaim({ repository: TYPED_REPO }));

    expect(
      dispatchResolved,
      `the drain honours the typed repository (${drainResolved}) and the direct dispatch resolves ` +
        `${JSON.stringify(dispatchResolved)} — one fact, two names, one per door. gig_dispatch reads ` +
        `args['repo_url'] (server.ts:771) and never input.repository; the drain reads input.repository ` +
        `(worker.ts:144). Both doors must resolve the same repository through the ONE shared resolver.`,
    ).toBe(drainResolved);
    expect(dispatchResolved, "and that repository is the one the change-request typed").toBe(TYPED_REPO);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// C4 — THE TWO gig_dispatch BRANCHES CANNOT DIVERGE. wait:true and the default async path build their
// deps from the same assembler, so a wire added to one is present in the other BY CONSTRUCTION — not by
// a comment asking the next person to remember.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("C4 — the wait:true and async dispatch branches cannot diverge by construction", () => {
  it("C4.a the hand-carry comments are gone — the wire is inherited, not copied by reminder", () => {
    // server.ts:1202/1208 carry 'Same venue trio as the sync path above' and 'Same repository wire as
    // the sync path above' — a fix that landed on one branch and had to be carried to the other by
    // hand. A shared assembly makes the reminder meaningless; its continued presence is the duplication
    // tax, still owed. (CLAUDE.md: "a rule that cannot fail is remembered, not enforced".)
    const src = read("src/server.ts");
    expect(
      src.includes("Same venue trio as the sync path above"),
      "delete the 'Same venue trio' hand-carry comment: the async branch must INHERIT the venue wire " +
        "from the shared assembler, not be reminded to copy it.",
    ).toBe(false);
    expect(
      src.includes("Same repository wire as the sync path above"),
      "delete the 'Same repository wire' hand-carry comment: the async branch must inherit the repository " +
        "wire from the shared assembler.",
    ).toBe(false);
  });

  it("C4.b both dispatch branches route through the shared assembler", () => {
    // The structural guarantee behind C4.a: the dispatch door's run-deps come from the assembler, so a
    // wire is shared rather than hand-carried. On main server.ts hand-assembles two independent inline
    // literals (server.ts:1113 and :1198) and never names the assembler.
    const src = read("src/server.ts");
    expect(
      src.includes(ASSEMBLER),
      `server.ts must build both dispatch branches' deps from ${ASSEMBLER}; on main they are two ` +
        `independent inline literals that can (and did) diverge.`,
    ).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// C5 — A DOOR ADDS NOTHING SILENTLY. Every dep a door contributes beyond the shared set is named in one
// place and is door-specific BY ARGUMENT, not by accident. The wire that legitimately DIFFERS per door
// is mcpServerConfigs — empty on the drain (a freshly cloned, untrusted repo must not declare servers
// for the seat reading it; run_deps.ts:19-25) and the bootstrap map on the server. That difference must
// be an explicit argument handled in the ONE named place, never two hand-listed inline values.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("C5 — door-specific deps are supplied by argument in one named place", () => {
  it("C5 the assembler in run_deps.ts is where the enforcement environment (mcpServerConfigs) is set", () => {
    // CODE, not prose: run_deps.ts names `mcpServerConfigs` twice in its header comment already, so the
    // comment is stripped before the check. On main there is no assembler and no code reference to the
    // wire; the drain hand-lists `mcpServerConfigs: {}` at worker.ts:1105 and the server threads
    // `deps.mcpServerConfigs` at server.ts:1116/1201 — two silent, hand-kept copies.
    const code = stripComments(read("src/run_deps.ts"));
    expect(
      code.includes(ASSEMBLER),
      `the shared assembler must live in run_deps.ts so the enforcement environment is assembled in one ` +
        `named place.`,
    ).toBe(true);
    expect(
      code.includes("mcpServerConfigs"),
      `the assembler must SET mcpServerConfigs — the wire that legitimately differs drain(empty) vs ` +
        `dispatch(bootstrap) is supplied by explicit argument in the one named place, so a door cannot ` +
        `add or omit it silently.`,
    ).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// C6 — NON-VACUITY: BEHAVIOUR IS UNCHANGED. This is a unification, not a redesign. The ONE behaviour
// that changes is the C2/C3 defect being fixed (a typed repository is now honoured everywhere), and it
// is stated as such below. The non-goal — repo_url on gig_dispatch keeps working as a fallback beneath
// the typed input — is pinned so the fix cannot over-reach.
//
// NOTE (recorded in the sealed red-spec caveats): C6's full clause — "every existing dispatch, drain,
// chart-movement and venue law passes untouched" — is additionally verified by the whole root suite
// staying green at the seal gate; it is not, and cannot be, a single RED test. The capstone parity
// below is C6's RED-on-main anchor.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("C6 — one chain: all doors agree, and repo_url still works as a fallback", () => {
  it("C6.a capstone — dispatch(wait:true), dispatch(async) and the drain resolve ONE repository", async () => {
    const drainResolved = resolveWorkingRepo(drainClaim({ repository: TYPED_REPO }));

    // Door 1 — wait:true.
    const s = recordingRealizer();
    const rw = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "room-probe-v1", input: { repository: TYPED_REPO }, venue: "engine-room-v1", wait: true },
      deps(okInvoke, { venueRealizer: s.realizer }),
    );
    expect(rw.ok, rw.error).toBe(true);
    expect(s.repoUrls().length, "wait:true realized the room").toBeGreaterThan(0);
    const waitResolved = s.repoUrls()[0];

    // Door 2 — the default async path (the path the product actually dispatches through).
    const a = recordingRealizer();
    const ra = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "room-probe-v1", input: { repository: TYPED_REPO }, venue: "engine-room-v1" },
      deps(okInvoke, { venueRealizer: a.realizer }),
    );
    expect(ra.ok, ra.error).toBe(true);
    await waitFor(() => a.repoUrls().length > 0);
    expect(a.repoUrls().length, "the async path realized the room too").toBeGreaterThan(0);
    const asyncResolved = a.repoUrls()[0];

    // The whole point of one chain: every door agrees on the subject of the work.
    expect(waitResolved, "the wait:true dispatch must resolve the typed repository").toBe(drainResolved);
    expect(asyncResolved, "the async dispatch (the shipped path) must resolve it too").toBe(drainResolved);
    expect([waitResolved, asyncResolved, drainResolved].every((x) => x === TYPED_REPO), "all three doors → one repository").toBe(true);
  });

  it("C6.b non-goal preserved — a repo_url argument still resolves when no typed input is present", async () => {
    // PRESERVATION guard (green on main AND after): repo_url on gig_dispatch keeps working — it becomes
    // a fallback BENEATH the typed input, not the only source. A fix that dropped the dispatch door's
    // explicit argument would turn this red; that is the failure this guard forecloses.
    const { realizer, repoUrls } = recordingRealizer();
    const r = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "room-probe-v1", input: {}, repo_url: TYPED_REPO, venue: "engine-room-v1", wait: true },
      deps(okInvoke, { venueRealizer: realizer }),
    );
    expect(r.ok, r.error).toBe(true);
    expect(repoUrls().length, "the room realized").toBeGreaterThan(0);
    expect(
      repoUrls()[0],
      "an explicit repo_url with no typed input must still reach the run — the door keeps accepting what " +
        "it accepts (non-goal: doors' accepted inputs are unchanged).",
    ).toBe(TYPED_REPO);
  });
});
