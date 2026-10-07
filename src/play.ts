// `coltrane play` — THE SEAT'S BOOT. One command that resolves the genome it will read, proves the
// seat's credential is live, greets the door for the standing it will inject, installs the refusals
// the session must not be able to disobey, and only then hands over a Claude Code session.
//
// WHY THIS IS A COMMAND AND NOT A CHECKLIST (Eugene, 6 Oct 2026): "i want coltrane cli to allow me one
// command so i can drop into a folder and say coltrane play and it loads the list of envoys i can mint
// and then drops me into a claude code session after minting + booting + prepping … its also INSANELY
// VALUABLE to use it as a way to deterministically inject process into the claude code context window
// + operating parameters. low key standards can probably be held pretty tight just by good boot
// protocols."
//
// The boot is where a standard stops being prose and becomes machinery, and three of the seven laws
// that specify it are cures for defects committed in the session that wrote them:
//   · a watch lapsed for a day surfaced hours later as scattered reds in another contract — a dead
//     credential wearing the costume of a non-conformant subject. So the boot proves liveness with a
//     REAL VERB CALL, never a handshake: the hosted door answers 200 to `initialize` with a lapsed
//     delegation, because the handshake does not carry it.
//   · a room count typed into a file outlived its truth and was obeyed anyway. So every fact the boot
//     injects carries the door it came from and the moment it was read.
//   · the estate's hardest rules live in prose an agent is TRUSTED to honour. So the boot writes
//     PreToolUse guards that refuse outright, and `--check-hook` drives the same matcher the hook runs
//     — one matcher, so a guard cannot be asserted in one place and absent in the other.
//
// WHAT THIS DOES NOT DO. No model is called here: a CLI that reasons is a CLI nobody can grade. The
// session does the thinking; the boot hands it pointers and the few live facts, never a corpus. It
// reads no credential variable `reside` and `work` do not already read — a second path to standing is
// a second path to an unattributable act, which this estate ruled out on 4 Oct.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { GenomeLoadError, resolveExtendsChain, resolveGenome, type LoadedGenome } from "./loader.js";
import { doorGenomeStore, rpcGenomeStore } from "./genome_store.js";
import { currentDoor, currentSession, sessionIsExpired, type StoreSession } from "./login.js";

export interface PlayIO {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Injected for tests; production reads the process environment. */
  env?: Record<string, string | undefined>;
  /** Injected for tests; production reads stdin for `--check-hook -`. */
  stdin?: () => string;
}

const stamp = (): string => new Date().toISOString();

/** `--name value`, or undefined. Never defaulted: a boot does not guess which seat it is for, and a
 *  mint reason nobody wrote is a reason nobody can be held to. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// THE GUARD TABLE. ONE SOURCE, TWO READERS: the hook the boot installs and `--check-hook` both run
// `refuses()`. A guard that the installed hook enforces but the checker does not — or the reverse — is
// a rule that holds in a test and not in a session, which is the whole class this table exists to
// close. Adding a rule here installs it and makes it drivable in the same edit; there is no second
// place to remember.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface ForbiddenAct {
  readonly id: string;
  /** An invocation that MUST be refused — printed by --show-hooks, and the plant a law drives. */
  readonly example: string;
  readonly why: string;
  readonly test: (cmd: string) => boolean;
}

export const FORBIDDEN_ACTS: readonly ForbiddenAct[] = [
  {
    id: "manual-migration",
    example: "supabase db push --linked",
    why: "a manual migration to production. CLAUDE.md rules this illegal: the pipeline applies migrations, so a hand-run push is an unreviewed schema change against live data.",
    test: (c) => /\bsupabase\b/.test(c) && /\bdb\s+push\b/.test(c),
  },
  {
    id: "credential-through-transcript",
    example: "echo $COLTRANE_AGENT_TOKEN",
    why: "a credential value rendered into a transcript. The mint returns the value ONCE and stores only its hash, so a value reaching a scrollback, a CI log or a session transcript is published and cannot be unpublished by forgetting it.",
    test: (c) =>
      /\b(echo|printf|cat|env|printenv|set)\b/.test(c) &&
      /(COLTRANE_AGENT_TOKEN|vor\.env)/.test(c),
  },
  {
    id: "self-graded-merge",
    example: "gh pr merge 123",
    why: "merging a pull request you authored. Merging deploys in this estate (migrations, a public package, a drain pin), and the gate is a non-author grade.",
    test: (c) => /\bgh\s+pr\s+merge\b/.test(c),
  },
];

/** The ONE matcher. Returns the acts a command would commit, in table order. */
export function refuses(cmd: string): readonly ForbiddenAct[] {
  return FORBIDDEN_ACTS.filter((a) => a.test(cmd));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// SOURCE. Which genome answered, declared rather than inferred: every later claim in the session is
// relative to it, and a seat that cannot say where its definitions came from is ungradeable.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
type SourceReport =
  | { ok: true; backing: "hosted" | "local"; lines: readonly string[] }
  | { ok: false; lines: readonly string[]; refusal: string };

async function sourceReport(
  env: Record<string, string | undefined>,
  cwd: string,
  session: StoreSession | undefined,
  bearer: string | undefined,
): Promise<SourceReport> {
  const read = stamp();

  // A HOSTED BACKING IS DELIVERED, NOT DECLARED. Measured 7 Oct: an authenticated hosted seat standing
  // in ~/eir/eir-drafting — a directory with no agents/, no standards/, no genome files at all —
  // reported `backing: local, this directory's genome files answer` and BOOT-2 passed it, because
  // BOOT-2 grades whether the boot DECLARES its backing and names its layer stack. It did, impeccably,
  // about an empty folder. Declaring a wrong answer precisely is not delivering a right one. So this
  // step now LOADS the genome it claims and reports what came back; a count is delivery, a name is not.
  const count = (g: LoadedGenome): string =>
    `${g.agents.size} agents · ${g.standards.size} standards · ${g.domain_types.size} domain types · ${g.core_types.size} core types`;

  // 1 · A MEMBER SESSION. The member's own JWT rides the REST tables directly.
  if (session !== undefined && !sessionIsExpired(session)) {
    try {
      const g = await doorGenomeStore({ door: session.store, bearer: session.access_token }).load();
      return {
        ok: true,
        backing: "hosted",
        lines: [
          "  backing: hosted — the organization's genome store answered, not this directory",
          `  through: ${session.store} (the door you signed in to; its bearer reads the genome, no store credentials)`,
          `  delivered: ${count(g)}`,
          `  read at ${stamp()}`,
        ],
      };
    } catch (e) {
      return {
        ok: false,
        refusal: "hosted_genome_unreadable",
        lines: [
          `  backing: hosted (claimed) — signed in to ${session.store}, but the genome did not come back`,
          `  REFUSED: ${e instanceof Error ? e.message : String(e)}`,
          "  this is named rather than fallen back from: answering with this directory instead would seat an",
          "    agent against the wrong world while reporting success.",
          `  read at ${stamp()}`,
        ],
      };
    }
  }

  // 2 · A SEAT'S OWN CREDENTIAL. A ctk_ is not a JWT and cannot ride the REST tables: the definer RPC
  // resolves the token's hash inside the store and returns that org's rows. The mechanism already
  // existed and nothing joined it to this caller, which is why an authenticated seat read a folder.
  if (bearer !== undefined && bearer.length > 0) {
    const storeUrl = env["COLTRANE_STORE_URL"];
    const storeAnon = env["COLTRANE_STORE_ANON"];
    if (storeUrl !== undefined && storeUrl.length > 0 && storeAnon !== undefined && storeAnon.length > 0) {
      try {
        const g = await rpcGenomeStore({
          baseUrl: storeUrl,
          anonKey: storeAnon,
          agentToken: bearer,
        }).load();
        return {
          ok: true,
          backing: "hosted",
          lines: [
            "  backing: hosted — the organization's genome store answered, not this directory",
            `  store: ${storeUrl} (from this environment — a self-hosted deployment)`,
            "  as: the seat's own credential, through the definer RPC that can read a ctk_",
            `  delivered: ${count(g)}`,
            `  read at ${read}`,
          ],
        };
      } catch (e) {
        return {
          ok: false,
          refusal: "hosted_genome_unreadable",
          lines: [
            "  backing: hosted (claimed) — but the store did not answer",
            `  REFUSED: ${e instanceof Error ? e.message : String(e)}`,
            `  read at ${read}`,
          ],
        };
      }
    }
  }

  // LOCAL. resolveExtendsChain is the SAME walk resolveGenome performs, so the stack reported here
  // cannot drift from the stack actually loaded. Reporting the root without the layers beneath it is
  // precisely the case where the npm-shipped base and a local override read identically.
  const root = env["COLTRANE_GENOME"] ?? cwd;
  let roots: readonly string[];
  try {
    roots = resolveExtendsChain(root).roots;
  } catch (e) {
    const why = e instanceof GenomeLoadError ? e.message : e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      refusal: "bad_genome",
      lines: [
        "  backing: local",
        `  genome root: ${root}`,
        `  REFUSED: the extends chain does not resolve — ${why}`,
        `  read at ${read}`,
      ],
    };
  }

  const stack = roots.map((r, i) => `    ${i === 0 ? "base" : `layer ${i}`}: ${r}`);
  const single =
    roots.length === 1
      ? ["    (one layer: no genome.json `extends` manifest at this root, so no base is layered under it)"]
      : [];

  // AN EMPTY FOLDER IS NOT A GENOME, AND ADOPTING ONE SILENTLY IS THE DEFECT. A directory with no
  // definitions in it answers every question with "nothing", which is indistinguishable from a genome
  // that loaded and happens to be bare — so the boot would seat an agent against an empty world and
  // say so in a true, useless sentence. If there is nothing here and nobody has logged in, the thing
  // the operator needs is a login, and that is the only thing this names (leg C).
  const local = resolveGenome(root);
  const empty = local.agents.size === 0 && local.standards.size === 0 && local.domain_types.size === 0;
  if (empty) {
    return {
      ok: false,
      refusal: "no_genome",
      lines: [
        `  backing: local — and ${root} holds no definitions at all (no agents, no standards, no types)`,
        "  REFUSED: there is nothing here to boot a seat against, and no member is logged in, so there is",
        "    no hosted genome to fall back to. An empty directory adopted as a genome is a seat working",
        "    against an empty world while reporting success.",
        "  Run `coltrane login` and the organization's genome answers instead of this folder.",
        `  read at ${read}`,
      ],
    };
  }

  return {
    ok: true,
    backing: "local",
    lines: [
      "  backing: local — this directory's genome files answer",
      `  genome root: ${root}`,
      "  layers (base first), flattened by resolveGenome's extends chain:",
      ...stack,
      ...single,
      `  delivered: ${count(local)}`,
      `  read at ${read}`,
    ],
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// WATCH. No session starts on a lapsed credential, and a handshake is not proof of one.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
interface WatchReport {
  lines: readonly string[];
  /** Proved live by a real verb call THIS RUN. A boot WINDS a live watch and never issues a second
   *  standing one: a second path to standing is a second path to an unattributable act. */
  live?: boolean;
  refusal?: { code: number; lines: readonly string[] };
}

const HANDSHAKE_NOTE =
  "  liveness is proved by a REAL VERB CALL (health_check through the engine's own surface — the only door that " +
  "can read a ctk_; PostgREST answers PGRST301 to one, which is a probe fault and not a lapse), never by an `initialize` handshake: " +
  "the door answers HTTP 200 to initialize with a LAPSED delegation, because the handshake does not carry it. " +
  "A 200 there is not standing and is never read as standing.";

// WHICH DOOR CAN READ A ctk_ — measured 6 Oct, and this was a real defect that stopped the boot dead.
// The first cut probed liveness with `postgrestGenomeStore(...).load()`, i.e. a PostgREST read carrying
// the credential as a Bearer. PostgREST expects a three-part Supabase JWT, so it answered
// `PGRST301 — Expected 3 parts in JWT; got 1` for a credential that was PERFECTLY LIVE: the same ctk_,
// put to coltrane.eir.sh/api/mcp `tools/call health_check` seconds later, answered {"ok":true}. An agent
// capability token is validated by the ENGINE'S OWN SURFACE, not by PostgREST's JWT gate.
// So the probe rejected every genuine agent credential and the boot refused to hand over on a good watch.
// Two faults, one line: the wrong door, AND a classifier that read the word `jwt` in the failure as
// evidence of a lapse. A probe fault must never be rendered as a refusal by the door — that is the same
// false-signal shape as a dead credential wearing the costume of a non-conformant subject, inverted.
async function watchReport(env: Record<string, string | undefined>): Promise<WatchReport> {
  const bearer = env["COLTRANE_AGENT_TOKEN"];
  const chosen = currentDoor(env);
  const door = chosen === undefined ? undefined : `${chosen.url}/api/mcp`;
  const read = stamp();

  if (bearer === undefined || bearer.length === 0) {
    return {
      lines: [
        "  bearer: none supplied (COLTRANE_AGENT_TOKEN unset)",
        "  the boot would MINT one. agent_token_issue requires a human member — a seated agent may not issue a",
        "    standing token, and must refuse by name rather than appear to half-work.",
        "  ttl: at the tenure ceiling, not below it. A mint of 24h against a 168h ceiling died in a day with six",
        "    days of authorised tenure unused; that lapse is why this check exists.",
        HANDSHAKE_NOTE,
        `  read at ${read}`,
      ],
    };
  }

  // A BEARER WAS SUPPLIED. It is never trusted on presentation — presence is not liveness, and the
  // whole defect this guards against was a token that existed, parsed, and was dead.
  if (door === undefined) {
    const lines = [
      "  bearer: supplied (value never read back here)",
      "  REFUSED: watch unverified — no auth store is selected, so there is no door to prove it against.",
      "    An unverified watch is indistinguishable from a lapsed one. Run `coltrane login` and choose the",
      "    house this seat belongs to.",
      `  read at ${read}`,
    ];
    return { lines, refusal: { code: 2, lines } };
  }

  // THE REAL VERB CALL, through the engine's own surface — the only door that can read a ctk_. A lapsed
  // delegation refuses here even though `initialize` at the same URL answers 200.
  const probe = await callDoor(door, bearer, "health_check", {});
  if (probe.ok) {
    return {
      live: true,
      lines: [
        "  bearer: supplied (value never read back here)",
        `  watch: LIVE — proved by a real verb call (health_check) at ${door} (${probe.detail}), which carries the delegation`,
        HANDSHAKE_NOTE,
        `  read at ${read}`,
      ],
    };
  }

  // UNREACHABLE IS NOT REFUSED. Naming a watch lapsed because the probe could not ask is the inverse of
  // the defect this law exists for, and it is how a good credential gets thrown away.
  if (probe.unreachable === true) {
    const lines = [
      "  bearer: supplied (value never read back here)",
      `  REFUSED: watch UNVERIFIED — ${probe.detail}`,
      "    This is NOT a lapse and must not be read as one: the door could not be asked, so the watch's state",
      "    is unknown. The boot still refuses, because handing over on an unproved credential is the defect,",
      "    but the cure here is reaching the door — not minting over a watch that may be perfectly good.",
      `  read at ${read}`,
    ];
    return { lines, refusal: { code: 2, lines } };
  }

  const lines = [
    "  bearer: supplied (value never read back here)",
    `  REFUSED: the door refused the delegation on a real verb call — ${probe.detail}`,
    "    Only a MINT cures it (agent_token_issue), or a governor's agent_token_extend moves expires_at toward",
    "    the tenure ceiling. Both are member-only: the seat never winds its own watch.",
    HANDSHAKE_NOTE,
    `  read at ${read}`,
  ];
  return { lines, refusal: { code: 2, lines } };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// INSTRUMENT. The value never crosses a transcript; the destination is named, the mode is owned.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
const CREDENTIAL_REL = join(".claude", "vor.env");

// A DRY RUN CREATES NOTHING HERE, AND THAT IS A CORRECTION. This step used to pre-create the file empty
// at 0600 so its mode could be graded. Driven 6 Oct: BOOT-4's leg B then PASSED on two comment lines with
// no value — the law demanded the artifact EXIST rather than that the run PRODUCE it, and a placeholder
// was the cheapest way to satisfy it. Both sides changed: the leg now grades the mode only of a file
// carrying a value, and this step no longer manufactures the thing it is graded on. A dry run REPORTS the
// destination and whatever is actually there; only a real mint writes.
function credentialReport(cwd: string): { path: string; lines: readonly string[] } {
  const path = join(cwd, CREDENTIAL_REL);
  const state = !existsSync(path)
    ? "absent — no boot has written one here yet (a dry run does not create it)"
    : /ctk_[A-Za-z0-9_.-]{8,}/.test(readFileSync(path, "utf8"))
      ? `present, carrying a value, mode ${(statSync(path).mode & 0o777).toString(8)}`
      : `present but carrying NO value — a placeholder, which is not a credential`;
  return {
    path,
    lines: [
      `  destination: ${CREDENTIAL_REL} (written 0600, owner read/write only, by a real boot)`,
      `  current state: ${state}`,
      "  the boot says WHERE it wrote and never WHAT it wrote: the mint returns the value once and the store",
      "    holds only its hash, so an echoed value is a credential published for good.",
      `  read at ${stamp()}`,
    ],
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// THE MINT. A CALL, NOT A SENTENCE. Driven 6 Oct and this is the correction: the first cut of this file
// named a mint eighteen times and called it zero times — every occurrence sat inside a message saying a
// mint WOULD happen — and seven green laws said nothing, because all seven drove `--dry-run`, which the
// banner itself calls "everything except the mint and the exec".
// agent_token_issue is wired by the DEPLOYMENT (ToolSurfaceDeps.issueAgentToken, gating on an
// authenticated human member and storing only the token's hash), so the call goes to the door over the
// same MCP surface every other verb uses. The value comes back ONCE and goes straight to a 0600 file.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
interface MintOutcome {
  ok: boolean;
  lines: readonly string[];
  /** The value, held only long enough to write it. Never returned into any rendered output. */
  token?: string;
  key_id?: string;
}

async function callDoor(
  door: string,
  bearer: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; detail: string; unreachable?: boolean; result?: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(door, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(bearer !== undefined && bearer.length > 0 ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
  } catch (e) {
    // A DOOR THAT COULD NOT BE REACHED IS NOT A DOOR THAT REFUSED. Keeping these apart is the whole
    // lesson of the probe fault below: "could not ask" must never be rendered as "the answer was no".
    return { ok: false, unreachable: true, detail: `the door could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
  const raw = await res.text();
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${raw.slice(0, 300)}` };
  // The surface answers either a JSON body or an SSE frame; both carry one JSON-RPC envelope.
  const json = /^\s*\{/.test(raw) ? raw : (/^data:\s*(\{.*)$/m.exec(raw)?.[1] ?? raw);
  let env: { result?: { isError?: boolean; structuredContent?: unknown; content?: unknown }; error?: { message?: string } };
  try {
    env = JSON.parse(json) as typeof env;
  } catch {
    return { ok: false, detail: `the door's answer did not parse: ${raw.slice(0, 200)}` };
  }
  if (env.error) return { ok: false, detail: `the door refused: ${env.error.message ?? JSON.stringify(env.error)}` };
  if (env.result?.isError === true) {
    const text = JSON.stringify(env.result.content ?? env.result.structuredContent ?? {});
    return { ok: false, detail: `the verb refused: ${text.slice(0, 300)}` };
  }
  const structured = env.result?.structuredContent;
  return { ok: true, detail: `HTTP ${res.status}`, ...(structured !== undefined && structured !== null ? { result: structured as Record<string, unknown> } : {}) };
}

/** TTL AT THE CEILING, NEVER BELOW IT. The 4 Oct mint took ttl 24h against a 168h ceiling and died in a
 *  day with six days of authorised tenure unused; that lapse is the whole reason the watch check exists,
 *  so the boot does not repeat it. */
const TENURE_CEILING_HOURS = 168;

async function mint(
  door: string,
  bearer: string | undefined,
  org: string,
  agent: string,
  reason: string,
): Promise<MintOutcome> {
  const read = stamp();
  const r = await callDoor(door, bearer, "agent_token_issue", {
    org_slug: org,
    agent_slug: agent,
    ttl_hours: TENURE_CEILING_HOURS,
    tenure_ceiling_hours: TENURE_CEILING_HOURS,
    reason,
  });
  if (!r.ok) {
    // NAME WHICH WALL WAS HIT, because the two look identical in a transcript and send the reader to
    // opposite places. Measured 6 Oct: with NO bearer the request carries no Authorization header at all,
    // so the door answers 401 "No authorization provided" BEFORE the verb is reached — the member-only
    // refusal never fires, and a reader who saw only "the mint was refused" would go hunting for a
    // permission problem that was never consulted. A member's standing has to arrive here AS A VALUE: a
    // session that is itself member-authenticated holds that standing as a TRANSPORT, which is not
    // something this process can be handed.
    const unauthenticated = bearer === undefined || bearer.length === 0;
    return {
      ok: false,
      lines: [
        `  mint: REFUSED by the door — ${r.detail}`,
        ...(unauthenticated
          ? [
              "  NOTE: this boot sent NO bearer, so the door refused the REQUEST, not the mint — the member-only",
              "    check was never reached. agent_token_issue needs a human member's credential as a VALUE in",
              "    COLTRANE_AGENT_TOKEN. This is not a permission problem to go hunting for; it is an",
              "    unauthenticated call. Until a member's bearer is wired in, WIND is the reachable path: present",
              "    a live watch and the boot winds it instead of issuing a second standing credential.",
            ]
          : [
              "  agent_token_issue requires an authenticated HUMAN MEMBER: a seated agent's own token may not issue",
              "    a standing one, and the engine fails that closed rather than appearing to half-work. A member must",
              "    mint, or a governor must agent_token_extend an existing watch.",
            ]),
        `  attempted_at: ${read}`,
      ],
    };
  }
  const token = typeof r.result?.["agent_token"] === "string" ? (r.result["agent_token"] as string) : undefined;
  const keyId = typeof r.result?.["key_id"] === "string" ? (r.result["key_id"] as string) : undefined;
  if (token === undefined || token.length === 0) {
    return {
      ok: false,
      lines: [
        "  mint: the door answered without a credential value — nothing was written, and the boot does not",
        "    proceed on a mint it cannot evidence.",
        `  attempted_at: ${read}`,
      ],
    };
  }
  return {
    ok: true,
    token,
    ...(keyId !== undefined ? { key_id: keyId } : {}),
    lines: [
      `  mint: PERFORMED via agent_token_issue at the door (${r.detail})`,
      `  key_id: ${keyId ?? "(not returned)"} · ttl ${TENURE_CEILING_HOURS}h at a ${TENURE_CEILING_HOURS}h ceiling`,
      "  the value is NOT rendered here and appears in no stream: it goes straight to a 0600 file.",
      `  minted_at: ${read}`,
    ],
  };
}

/** Write the credential, owner-only, created 0600 so it is never briefly world-readable. */
function writeCredential(path: string, token: string, keyId: string | undefined): readonly string[] {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `# coltrane play — written ${stamp()}. Owner-only. Never commit, never echo.\n` +
      // The key_id goes in as a COMMENT, not a second env key. BOOT-7 reads this file's text for
      // COLTRANE_[A-Z0-9_]+ and holds play to the vars reside and work already take, so inventing one
      // here — even only as a string written into a file — would be inventing a credential class.
      (keyId !== undefined ? `# key_id: ${keyId}\n` : "") +
      `COLTRANE_AGENT_TOKEN=${token}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return [
    `  wrote: ${CREDENTIAL_REL} (mode ${(statSync(path).mode & 0o777).toString(8)}, value not rendered)`,
  ];
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// STANDING. What the door returned, never what a file remembers.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
// THE CONTEXT BLOCK IS STRUCTURED, NOT PROSE, AND THAT IS A CORRECTNESS PROPERTY RATHER THAN A STYLE
// ONE. Measured 6 Oct: BOOT-5 graded this step by grepping the whole boot report for `seat|initialize`
// and an ISO date, and every one of those matched incidental text elsewhere in the report — so the law
// stayed GREEN against a boot whose context block literally read "injects a remembered standing and
// never asks a door". A claim about standing has to be gradeable on its own terms, so each injected
// fact is emitted as ONE line carrying its key, its value, the door it came from and the moment it was
// read, and the count is declared. Prose cannot forge a fact line, and a boot that greets nothing
// declares `injected_facts: 0` and emits none.
const FACT = (key: string, value: string, door: string, read: string): string =>
  `    ${key} = ${value} · source: ${door} · read: ${read}`;

async function greetReport(env: Record<string, string | undefined>): Promise<readonly string[]> {
  const service = currentDoor(env)?.url ?? "";
  const read = stamp();

  if (service.length === 0) {
    return [
      "  greeting: NOT PERFORMED",
      "  door: unconfigured",
      `  attempted_at: ${read}`,
      "  injected_facts: 0",
      "  nothing is injected. Standing this boot did not receive THIS RUN is not supplied from memory:",
      "    a count typed into a file outlived its truth once and was obeyed anyway, and that is the whole",
      "    reason this step reports an absence instead of filling it in.",
    ];
  }

  const door = `${service.replace(/\/$/, "")}/api/mcp`;
  try {
    const res = await fetch(door, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env["COLTRANE_AGENT_TOKEN"] !== undefined
          ? { authorization: `Bearer ${env["COLTRANE_AGENT_TOKEN"]}` }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "coltrane play", version: "1" } },
      }),
    });
    const raw = await res.text();
    if (!res.ok) {
      return [
        "  greeting: FAILED",
        `  door: ${door} (HTTP ${res.status})`,
        `  attempted_at: ${read}`,
        "  injected_facts: 0",
        "  the door did not answer, so there is no standing to inject and none is invented.",
      ];
    }
    // Read for STANDING only. Liveness is the watch check's job above, because this very call answers
    // 200 to a LAPSED delegation — so a greeting is evidence of what the door says, never that the
    // credential is alive.
    let info: { name?: unknown; version?: unknown } = {};
    let instructions = "";
    try {
      const parsed = JSON.parse(raw) as {
        result?: { serverInfo?: { name?: unknown; version?: unknown }; instructions?: unknown };
      };
      info = parsed.result?.serverInfo ?? {};
      instructions = typeof parsed.result?.instructions === "string" ? parsed.result.instructions : "";
    } catch {
      instructions = "";
    }
    const facts: string[] = [];
    if (typeof info.name === "string") facts.push(FACT("server", info.name, door, read));
    if (typeof info.version === "string") facts.push(FACT("server_version", info.version, door, read));
    // The greeting's instructions are the door's own statement of the seat's standing — its rooms, its
    // authorizer, its org. They are injected VERBATIM and never summarised into a count: a number is
    // what rots, the sentence that produced it is what can be re-read.
    if (instructions.length > 0) {
      facts.push(FACT("standing", JSON.stringify(instructions.slice(0, 1200)), door, read));
    }
    return [
      "  greeting: PERFORMED",
      `  door: ${door} (HTTP ${res.status})`,
      `  read_at: ${read}`,
      `  injected_facts: ${facts.length}`,
      ...facts,
    ];
  } catch (e) {
    return [
      "  greeting: FAILED",
      `  door: ${door} (unreachable — ${e instanceof Error ? e.message : String(e)})`,
      `  attempted_at: ${read}`,
      "  injected_facts: 0",
      "  a greeting that did not answer leaves the seat with nothing to inject, and a remembered list is",
      "    not a substitute for one.",
    ];
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// OPERATING PARAMETERS. The boot writes its OWN settings file and launches against it with
// `--settings`. It never edits the operator's hand-maintained `.claude/settings.local.json`: a boot
// that rewrites a human's allowlist on every run is a boot nobody can leave installed.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
const SETTINGS_REL = join(".claude", "coltrane-boot.settings.json");
const CONTEXT_REL = join(".claude", "coltrane-boot.context.md");

function hookSettings(cliEntry: string): Record<string, unknown> {
  return {
    _generated_by: "coltrane play — regenerated every boot; never hand-edited, never read as a memory",
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              // THE SAME MATCHER the law drives. The hook does not re-state the rules; it calls back
              // into the one table, so a rule cannot be installed here and missing there.
              command: `node ${JSON.stringify(cliEntry)} play --check-hook -`,
            },
          ],
        },
      ],
    },
  };
}

function hooksReport(cwd: string, cliEntry: string, write: boolean): readonly string[] {
  const path = join(cwd, SETTINGS_REL);
  if (write) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(hookSettings(cliEntry), null, 2) + "\n");
  }
  return [
    `  written to: ${SETTINGS_REL} (a PreToolUse hook on Bash; the session is launched with --settings against it)`,
    "  the operator's own .claude/settings.local.json is NEVER edited by the boot",
    "  these are REFUSALS, not reminders: the hook exits non-zero and the call does not happen.",
    "  each guard below is driven by the same matcher the hook runs — `play --check-hook '<cmd>'`:",
    ...FORBIDDEN_ACTS.flatMap((a) => [
      `    · ${a.id} — refuses: ${a.example}`,
      `        ${a.why}`,
    ]),
    `  read at ${stamp()}`,
  ];
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// --check-hook — the guard, driven. Exit 2 is Claude Code's "block this call"; stderr reaches the model.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
function checkHook(value: string, io: PlayIO): number {
  let cmd = value;
  if (value === "-") {
    const raw = (io.stdin ?? (() => readFileSync(0, "utf8")))();
    try {
      const parsed = JSON.parse(raw) as { tool_input?: { command?: unknown } };
      cmd = typeof parsed.tool_input?.command === "string" ? parsed.tool_input.command : "";
    } catch {
      // A hook that cannot read its payload must not silently permit. Absent means DECLINE.
      io.err("coltrane play --check-hook: could not parse the hook payload on stdin — refusing the call rather than permitting an act it could not read.\n");
      return 2;
    }
  }
  const hit = refuses(cmd);
  if (hit.length === 0) {
    io.out(`permitted: no installed guard refuses this call\n`);
    return 0;
  }
  for (const a of hit) {
    io.err(`REFUSED by coltrane play's ${a.id} guard: ${a.why}\n`);
  }
  io.err("This is a guard the boot installed, not a preference. It cannot be talked out of the refusal; change the approach.\n");
  return 2;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
export async function runPlay(argv: readonly string[], io: PlayIO): Promise<number> {
  const env = io.env ?? process.env;
  const cwd = process.cwd();

  // Flags. --check-hook takes a value and answers alone: it is the guard being driven, not a boot.
  const hookIdx = argv.indexOf("--check-hook");
  if (hookIdx !== -1) {
    const value = argv[hookIdx + 1];
    if (value === undefined) {
      io.err("coltrane play --check-hook needs the command to check (or `-` to read the hook payload on stdin).\n");
      return 2;
    }
    return checkHook(value, io);
  }

  const dryRun = argv.includes("--dry-run");
  const showContext = argv.includes("--show-context");
  const showHooks = argv.includes("--show-hooks");
  const cliEntry = join(cwd, "dist", "src", "cli_entry.js");

  const out: string[] = [];
  out.push(`coltrane play — boot report${dryRun ? " (DRY RUN: everything except the mint and the exec)" : ""}`);
  out.push(`  at ${stamp()} · cwd ${cwd}`);
  out.push("");

  // 1 · SOURCE
  const session = currentSession(env);
  const seatBearer = env["COLTRANE_AGENT_TOKEN"];
  const src = await sourceReport(env, cwd, session, seatBearer);
  out.push("source — which genome answered");
  out.push(...src.lines);
  out.push("");

  // 2 · WATCH
  const watch = await watchReport(env);
  out.push("watch — the seat's credential");
  out.push(...watch.lines);
  out.push("");

  // 3 · INSTRUMENT DESTINATION
  const credential = credentialReport(cwd);
  out.push("credential — where the value lands");
  out.push(...credential.lines);
  out.push("");

  // 4 · STANDING (only when asked: a greeting is a network call)
  if (showContext) {
    out.push("context — the standing this boot would inject");
    out.push(...(await greetReport(env)));
    out.push("");
  }

  // 5 · OPERATING PARAMETERS
  if (showHooks) {
    out.push("hooks — the refusals this boot installs");
    out.push(...hooksReport(cwd, cliEntry, true));
    out.push("");
  }

  io.out(out.join("\n") + "\n");

  // A REFUSAL IS A REFUSAL IN A DRY RUN TOO. The dry run reports a plan; a dead credential is not a
  // gap in the plan, it is a boot that must not happen.
  if (!src.ok) {
    // THE REFUSAL ITSELF CARRIES THE CURE. "see the block above" makes a reader scroll to learn what to
    // do, and what they must do is always the same one thing: say who they are.
    io.err(
      src.refusal === "no_genome"
        ? "play refused: there is no genome here and nobody is logged in. Run `coltrane login` — that is the only thing asked of you.\n"
        : src.refusal === "hosted_genome_unreadable"
          ? "play refused: the organization's genome did not answer. Your login may have expired — run `coltrane login` again.\n"
          : `play refused: ${src.refusal} — see the source block above.\n`,
    );
    return 2;
  }
  if (watch.refusal) {
    io.err("play refused: the watch is not live — no session is handed over on an unproved credential.\n");
    return watch.refusal.code;
  }

  if (dryRun) return 0;

  // A REAL BOOT needs the door: the mint and the greeting both go through it. An unwired seam is a
  // NAMED refusal naming the variable it wants — never a throw, and never a silent local default that
  // hands over a session with no credential at all.
  // NOTHING IS DEMANDED OF A USER BUT WHO THEY ARE. There is no variable left to refuse for: the door
  // resolves to the service's own address, and the store's constants are the service's to publish. If a
  // boot cannot proceed, the refusal names a LOGIN or a SEAT and names nothing else — a hosted user sent
  // to an environment variable is this contract's red, and was the whole of the experience before it.
  if (session === undefined && (seatBearer === undefined || seatBearer.length === 0)) {
    io.err(
      "play refused: nobody is logged in, and this seat holds no credential of its own. " +
        "Run `coltrane login` — that is the only thing asked of you.\n",
    );
    return 2;
  }

  // ── THE TWO ACTS. Everything above this line is a report; a boot is these two things or it has not
  // happened. The previous cut of this function wrote two files and printed "boot complete — handing
  // over a session" with no mint call and no process primitive anywhere in the file. The sentence was
  // the whole boot. It is now unreachable without both acts succeeding.
  const chosen = currentDoor(env);
  const door = chosen === undefined ? undefined : `${chosen.url}/api/mcp`;
  const bearer = env["COLTRANE_AGENT_TOKEN"];
  const credentialPath = join(cwd, CREDENTIAL_REL);
  const acts: string[] = [];

  // ACT ONE · establish a credential THIS RUN. A watch proved live above is wound, not re-minted — a
  // second standing credential is a second path to an unattributable act. Otherwise: mint.
  if (watch.live && bearer !== undefined && bearer.length > 0) {
    acts.push("mint: NOT NEEDED — the watch presented was proved live by a real verb call above, so this");
    acts.push("  boot wound the existing credential rather than issuing a second standing one.");
    acts.push(...writeCredential(credentialPath, bearer, undefined));
  } else {
    // THE PICKER. Which seat is being booted is the operator's call, never the CLI's guess: a mint names
    // an org and an agent, and a boot that picked for you would mint standing nobody asked for.
    const org = flagValue(argv, "--org");
    const agent = flagValue(argv, "--agent");
    if (org === undefined || agent === undefined) {
      io.err(
        `play refused: no_seat (seam: the picker) — a mint names the seat it is for, and this boot was given ` +
          `${org === undefined ? "no --org" : `--org ${org}`} and ${agent === undefined ? "no --agent" : `--agent ${agent}`}. ` +
          `Name both: coltrane play --org <slug> --agent <slug>. The CLI does not choose a seat for you; ` +
          `standing nobody asked for is standing nobody can account for.\n`,
      );
      return 2;
    }
    const reason =
      flagValue(argv, "--reason") ??
      `coltrane play: booting a seat in ${cwd} at ${stamp()}`;
    if (door === undefined) {
      io.err("play refused: no auth store is selected, so there is no door to mint through. Run `coltrane login`.\n");
      return 2;
    }
    const minted = await mint(door, bearer, org, agent, reason);
    io.out(["mint — establishing a credential", ...minted.lines, ""].join("\n") + "\n");
    if (!minted.ok || minted.token === undefined) {
      io.err("play refused: the mint did not produce a credential — no session is handed over without one.\n");
      return 2;
    }
    acts.push(...writeCredential(credentialPath, minted.token, minted.key_id));
  }

  // The operating parameters and the standing, written before the handover so the session opens holding them.
  hooksReport(cwd, cliEntry, true);
  writeFileSync(
    join(cwd, CONTEXT_REL),
    [
      "# Session standing — written by `coltrane play`, regenerated every boot.",
      "",
      ...(await greetReport(env)),
      "",
      "## Operating parameters",
      "Guards are installed as PreToolUse refusals, not reminders:",
      ...FORBIDDEN_ACTS.map((a) => `- \`${a.example}\` — ${a.why}`),
    ].join("\n") + "\n",
  );

  // ACT TWO · the handover is an EXEC. The argv is named BEFORE the launch, so a reader can tell a
  // handover from a print statement even if the child never starts.
  const sessionArgv = [
    "--settings",
    relative(cwd, join(cwd, SETTINGS_REL)),
    "--append-system-prompt-file",
    relative(cwd, join(cwd, CONTEXT_REL)),
  ];
  acts.push(`launched: claude ${sessionArgv.join(" ")}`);
  acts.push(`argv: ${JSON.stringify(["claude", ...sessionArgv])}`);
  io.out(["handover — the session", ...acts.map((l) => `  ${l}`), ""].join("\n") + "\n");

  const child = spawnSync("claude", sessionArgv, { cwd, stdio: "inherit" });
  if (child.error !== undefined) {
    io.err(
      `play refused: the handover did not happen — could not launch \`claude\`: ${child.error.message}. ` +
        `The credential was written; the session was not started, so this is not a completed boot.\n`,
    );
    return 2;
  }
  io.out(`boot complete — the session exited ${child.status ?? "(signalled)"}.\n`);
  return child.status ?? 0;
}
