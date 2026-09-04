/**
 * The coltrane command line.
 *
 * Until now the package shipped exactly one executable — the MCP stdio server. That makes the
 * engine reachable from an MCP client and from nothing else: not CI, not cron, not a container,
 * not a queue worker, not a shell. A methodology engine whose only caller is an interactive
 * client cannot be part of a build.
 *
 * This is a thin wrapper, deliberately. `dispatchTool(slug, args, deps)` is already the entire
 * tool surface as a pure function, and `bootstrapServerDeps` already resolves the genome root,
 * the durable ledger and the output store. The MCP server is one wrapper over that pair; this
 * is a second. Almost nothing here is new behaviour, which is the point — two front doors that
 * disagreed about what a dispatch means would be the same defect this engine spent a release
 * removing.
 *
 * Conventions, chosen so this composes with other programs:
 *   - DATA goes to stdout, everything else to stderr. `coltrane dispatch … --json | jq` works.
 *   - Exit 0 success, 1 the command ran and failed, 2 the command was malformed. `validate`
 *     exits non-zero when the genome has load errors, which is what makes it a CI gate. A
 *     dispatch that PARKS at a human chair exits 0: waiting on a person is the standard
 *     working as written, and a job that read it as failure would retry a run that needs a
 *     signature rather than a fix.
 *   - `--json` prints the tool's `data` verbatim; without it, a short human summary.
 */
import { dispatchTool, bootstrapServerDeps, type ServerDeps, type ToolResult } from "./server.js";
import { detectGenomeOrphans } from "./genome_writer.js";
import { sealGenome, type SealGenomeReport } from "./seal_genome.js";
import { FileLedger, defaultGenomeLedgerPath } from "./ledger.js";
import { COLTRANE_VERSION } from "./version.js";
import { workOnce } from "./worker.js";
import { runReside } from "./reside.js";
import { openLocalQueue, selectQueueBacking, LOCAL_QUEUE_DIR_VAR } from "./local_queue.js";
import { workerCredentialMode } from "./worker_env.js";
import { drainPreflight } from "./drain_preflight.js";
import { makeClaudeInvoker } from "./claude_invoker.js";
import { dockerComposeRealizer } from "./venue_realizer.js";
import { readFileSync } from "node:fs";

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Injected for tests; production boots from the genome on disk. */
  deps?: ServerDeps;
  /** Injected for tests. Production reads stdin for `--input -`. */
  stdin?: () => string;
  /** Injected for tests; production reads the process environment. Only `reside` consults it —
   *  every other command reads process.env directly, and moving them is not this change's scope. */
  env?: Record<string, string | undefined>;
}

export const USAGE = `coltrane ${COLTRANE_VERSION}

  coltrane validate                     load the genome; exit non-zero on load errors OR on an
                                        orphan — a standards/|domain_types/|agents/ file with no
                                        genome_mutation seal in the tracked genome ledger
  coltrane seal-genome [<genome_dir>]   bulk-seal a pre-sealing genome: append a genome_mutation
                                        seal for every standards/|domain_types/|agents/ file not yet
                                        sealed, via the blessed sealDefinition path. Content is
                                        byte-unchanged; a second run seals nothing already sealed.
                                        (default genome_dir: cwd)
  coltrane dispatch <standard>          run a standard
  coltrane monitor <gig-id>             report a gig's progress
  coltrane logs <gig-id>                per-chair logs for a gig
  coltrane abort <gig-id>               stop a running gig
  coltrane trace <output-id>            walk an output's provenance
  coltrane simulate <standard>          cost/shape a standard without running it
  coltrane health                       engine + store health
  coltrane serve                        run the MCP server on stdio
  coltrane enqueue <standard>           queue a gig on the LOCAL file queue (no store, no key)
                                        (env: COLTRANE_QUEUE_DIR — its absence is the whole
                                         difference between local and hosted)
  coltrane work                         claim one queued gig from the org store and run it
  coltrane work --check                  report whether this box's drain environment is configured
                                        and exit without claiming (0 ready, 1 not ready)
                                        (env: COLTRANE_STORE_URL, COLTRANE_STORE_ANON,
                                         COLTRANE_AGENT_TOKEN; results drain via
                                         COLTRANE_DRAIN_URL + COLTRANE_DRAIN_KEY;
                                         checkpoints under COLTRANE_WORKER_CHECKPOINTS,
                                         default ~/.coltrane/worker-checkpoints;
                                         exit 0 complete or parked, 1 failed, 3 queue empty)
  coltrane reside [--any|--residency <id>]  hold a residency: claim a seat, ack its channel in
                                         reflex, answer every wake, and drain the org's due work
                                         orders through the Envoy's governed verbs
                                        (env: the same contract work uses — COLTRANE_STORE_URL,
                                         COLTRANE_STORE_ANON, COLTRANE_SERVICE_URL, plus
                                         COLTRANE_DRAIN_KEY + COLTRANE_INSTANCE for venue mode;
                                         no new credential class
                                         exit 0 released, 1 cortex failed, 2 misconfigured or a
                                         seam no deployment wired, 3 nothing claimable)

Options
  --input <json|@file|->                dispatch payload; @file reads a file, - reads stdin
  --depth <skim|standard|deep>          tighten the per-chair turn cap
  --budget <dollars>                    per-gig ceiling; the run stops when it is gone
  --reuse                               allow chair-level reuse of prior sealed outputs
  --resume <gig-id>                     continue a gig that died mid-pipeline
  --approve <role>=<json|@file>         a human chair's verdict; repeat once per chair
  --as <name>                           who is approving; sealed as the verdict's author
  --wait                                block until the run finishes
  --follow                              poll until the gig reaches a terminal state
  --direction <upstream|downstream|both>  for trace
  --json                                print the raw result to stdout
  --genome <path>                       genome root (default: $COLTRANE_GENOME or cwd)
  --help, --version

A dispatch that reaches a chair a HUMAN holds parks: it names the waiting chair and exits 0,
because a gig waiting on a person is not a failed gig. Approve it on the resume —

  coltrane dispatch <standard> --resume <gig> \\
      --approve approve=@verdict.json --as eugene

--input is NOT required on an approve-only resume: when every remaining chair is human the
checkpoint's recorded payload stands and the omission inherits it. If you DO pass --input it is
checked against the checkpoint, and a disagreement still refuses the resume.
`;

interface Parsed {
  cmd: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  /** A flag given twice COLLECTS rather than overwrites — `--approve a=… --approve b=…` is two
   *  chairs, and last-wins would silently drop one of them (and with it one person's verdict). */
  const set = (name: string, value: string): void => {
    const prior = flags[name];
    if (typeof prior === "string") flags[name] = [prior, value];
    else if (Array.isArray(prior)) prior.push(value);
    else flags[name] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("--")) {
      positional.push(tok);
      continue;
    }
    const body = tok.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    // A flag takes the next token as its value UNLESS that token is itself a flag, which is
    // what makes `--reuse --json` parse as two booleans rather than one flag valued "--json".
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      set(body, next);
      i++;
    } else {
      flags[body] = true;
    }
  }
  return { cmd: positional[0], positional: positional.slice(1), flags };
}

/** `@file` reads a file, `-` reads stdin, anything else is parsed as inline JSON. */
export function readInput(spec: string | undefined, io: CliIO, label = "--input"): { value?: unknown; error?: string } {
  if (spec === undefined) return { value: {} };
  try {
    if (spec === "-") {
      const raw = io.stdin ? io.stdin() : readFileSync(0, "utf8");
      return { value: JSON.parse(raw) };
    }
    if (spec.startsWith("@")) return { value: JSON.parse(readFileSync(spec.slice(1), "utf8")) };
    return { value: JSON.parse(spec) };
  } catch (e) {
    return { error: `could not read ${label}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * `--approve <role>=<json|@file>`, once per human chair, into the role→verdict map the dispatch
 * surface takes.
 *
 * A malformed verdict is refused BEFORE the dispatch, like a malformed `--input`: a run that
 * silently dropped an unreadable approval would park again after paying for every chair before
 * the seat, and the operator would be told nothing about why their yes did not land.
 */
export function readApprovals(
  spec: string | boolean | string[] | undefined,
  io: CliIO,
): { value?: Record<string, unknown>; error?: string } {
  if (spec === undefined) return {};
  const specs = typeof spec === "string" ? [spec] : Array.isArray(spec) ? spec : [];
  if (specs.length === 0) return { error: `--approve needs <role>=<json|@file>` };
  const out: Record<string, unknown> = {};
  for (const s of specs) {
    const eq = s.indexOf("=");
    if (eq <= 0) return { error: `--approve must be <role>=<json|@file>, got "${s}"` };
    const role = s.slice(0, eq);
    const read = readInput(s.slice(eq + 1), io, `--approve ${role}`);
    if (read.error) return { error: read.error };
    const verdict = read.value;
    if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict)) {
      return { error: `--approve ${role} must be a JSON object — the verdict seals as a typed output` };
    }
    out[role] = verdict;
  }
  return { value: out };
}

// What `--follow` stops on. `awaiting_approval` belongs here: the run has settled and will not
// move again until a person acts, so polling for it forever is a loop that cannot end.
const TERMINAL = new Set(["complete", "failed", "aborted", "awaiting_approval"]);

function line(io: CliIO, s: string): void { io.err(s + "\n"); }

/** Print `data` as JSON on stdout, or hand back false so the caller can print a summary. */
function emitJson(io: CliIO, wantJson: boolean, data: unknown): boolean {
  if (!wantJson) return false;
  io.out(JSON.stringify(data ?? null, null, 2) + "\n");
  return true;
}

export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const { cmd, positional, flags } = parseArgs(argv);
  const json = flags["json"] === true || flags["json"] === "true";

  if (flags["version"]) { io.out(COLTRANE_VERSION + "\n"); return 0; }
  if (cmd === undefined || flags["help"] || cmd === "help") { io.out(USAGE); return cmd === undefined ? 2 : 0; }

  const KNOWN = ["validate", "seal-genome", "dispatch", "enqueue", "monitor", "logs", "abort", "trace", "simulate", "health", "serve", "work", "reside"];
  if (!KNOWN.includes(cmd)) {
    line(io, `unknown command "${cmd}"\n`);
    io.err(USAGE);
    return 2;
  }
  if (cmd === "serve") {
    // Handled by the entry shim, which must not have booted deps twice.
    line(io, "coltrane serve is handled by the entrypoint");
    return 2;
  }

  // `enqueue` is the LOCAL queue's front door. src/local_queue.ts shipped with 34 laws and nothing
  // could reach it: deps.queueGig is consulted only in callSurfaceTool's HOSTED branch, so a local
  // caller's gig_dispatch spawns in-process and never queues. This is that door — the half a person
  // needs before `coltrane work` has anything local to claim.
  //
  // It DECIDES NOTHING itself. selectQueueBacking is the single policy, already law-covered, and it
  // answers from environment PRESENCE alone, never by reading a drain variable's value. A conflict
  // means both backings are configured, and the honest answer is to refuse rather than pick a
  // precedence order: which store owns a gig is not a thing to guess.
  if (cmd === "enqueue") {
    const standard = positional[0];
    if (!standard) { line(io, "enqueue needs a standard slug"); return 2; }
    const backing = selectQueueBacking(process.env);
    if (backing.backing === "conflict") { line(io, `enqueue refused: ${backing.why}`); return 2; }
    if (backing.backing === "hosted") {
      line(io, `enqueue is the LOCAL queue's door; this box is configured for the hosted drain. ` +
        `Dispatch through the surface, or unset the drain environment and set ${LOCAL_QUEUE_DIR_VAR}.`);
      return 2;
    }
    if (backing.backing !== "file") {
      line(io, `enqueue needs a local queue directory: set ${LOCAL_QUEUE_DIR_VAR} to a path this box may write.`);
      return 2;
    }
    const qin = readInput(typeof flags["input"] === "string" ? flags["input"] : undefined, io);
    if (qin.error) { line(io, qin.error); return 2; }
    const payload: Record<string, unknown> = { standard_slug: standard, input: qin.value };
    if (typeof flags["acting_for"] === "string") payload["acting_for"] = flags["acting_for"];
    if (typeof flags["venue"] === "string") payload["venue"] = flags["venue"];
    try {
      const res = await openLocalQueue(backing.root).enqueue(payload);
      line(io, JSON.stringify(res));
      return 0;
    } catch (e) {
      line(io, `enqueue failed: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  // `reside` stands beside `work` and shares its bootstrap contract exactly — the residency's hands
  // materialize from the drain key that already exists, so there is no new credential class here.
  // The verb owns the env check and the exit codes (src/reside.ts); this is only the mount, and the
  // mount is the half that was missing: runReside has been exported and law-covered since the state
  // machine landed while nothing could reach it.
  if (cmd === "reside") {
    return await runReside(argv, io);
  }

  // `work` runs against the ORG STORE, not a genome root — the seated agent's token is the
  // read scope and the chair contract is the authorization, so no file genome boots here.
  if (cmd === "work") {
    // `--check` asks the box a question BEFORE it spends a gig to learn the answer: is this box's
    // drain environment actually configured? It runs the existing drainPreflight collector — the
    // single source of what the drain reads, reused so it cannot drift from normalizeWorkerEnv —
    // renders what it found BY VARIABLE NAME AND PRESENCE (never a value: these vars carry keys),
    // and returns 0 for a ready box / 1 for an unready one. It claims nothing, contacts no store,
    // and returns here — before the credential derivation and the workOnce call below.
    if (flags["check"] === true || flags["check"] === "true") {
      const report = drainPreflight(process.env);
      for (const p of report.present) {
        // Name and class only. `key_class` is a prefix like `cdk_`, never the key itself.
        line(io, `present  ${p.variable}${p.key_class ? ` (${p.key_class})` : ""}`);
      }
      for (const m of report.missing) line(io, `missing  ${m.variable}`);
      for (const s of report.suspicious) line(io, `suspicious  ${s.variable} — ${s.message}`);
      // A check that cannot fail is not a check: a satisfied contract is ready (0), and either an
      // absent required var OR the store/service conflation makes the box unready (1). The specific
      // reason is in the rendered report; the code only says ready-or-not.
      const ready = report.missing.length === 0 && report.suspicious.length === 0;
      line(io, ready ? "drain environment ready" : "drain environment NOT ready");
      return ready ? 0 : 1;
    }
    const baseUrl = process.env["COLTRANE_STORE_URL"];
    const anonKey = process.env["COLTRANE_STORE_ANON"];
    // The credential mode is DERIVED IN ONE PLACE — workerCredentialMode in worker_env.ts. The CLI
    // door asks it and prints its refusal verbatim rather than re-deriving `drainKey && instance`
    // and composing a second error; the claim path (worker.ts) asks the same function's answer.
    const mode = workerCredentialMode(process.env);

    if (!baseUrl || !anonKey || mode.mode === "none") {
      if (!baseUrl || !anonKey) {
        line(io, "work needs COLTRANE_STORE_URL and COLTRANE_STORE_ANON.");
      }
      if (mode.mode === "none") {
        line(io, mode.why);
      }
      return 2;
    }
    const res = await workOnce(
      {
        baseUrl,
        anonKey,
        // Empty in venue mode, and deliberately so: the credential arrives with the work.
        agentToken: mode.mode === "player" ? mode.agentToken : "",
        ...(mode.mode === "venue" ? { drainKey: mode.drainKey, instance: mode.instance } : {}),
        ...(typeof flags["worker"] === "string" ? { worker: flags["worker"] } : {}),
      },
      {
        makeInvoke: (registry) =>
          makeClaudeInvoker({
            registry,
            model: process.env["COLTRANE_MODEL"],
            ...(process.env["COLTRANE_CHAIR_TIMEOUT_MS"] ? { timeout_ms: Number(process.env["COLTRANE_CHAIR_TIMEOUT_MS"]) } : {}),
          }),
        // The SAME realizer the interactive path constructs at src/server.ts:3486 — one bootstrap,
        // so the drain and the server cannot drift on which substrate a venue-named room is stood up
        // on. A box's claim gate (venueMayClaim) already promised it can stand this room up; without
        // this line workOnce would then refuse EVERY such gig with "…need a realizer this worker was
        // not given — refusing rather than running the room unbuilt" (worker.ts:1023-1028), because
        // nothing here supplied one. dockerComposeRealizer() is real docker by default and must not
        // throw on construction (venue_realizer.ts:808); runGig only realizes when the venue declares
        // mcp_servers, so a server-less venue's behaviour is unchanged.
        venueRealizer: dockerComposeRealizer(),
        log: (l) => line(io, l),
      },
    );
    if (!res.claimed) {
      line(io, "queue empty — nothing this seat's chair contract may claim");
      return 3;
    }
    // A claim that PARKED at a human chair exits 0: the row was run correctly and now waits on
    // a person. Exiting 1 would make every supervisor restart a worker that did its job.
    const code = res.status === "failed" ? 1 : 0;
    if (emitJson(io, json, res)) return code;
    io.out(res.gig_id + "\n");
    line(io, `${res.status}` +
      (res.awaiting ? ` at human chair "${res.awaiting.role}" (phase "${res.awaiting.phase}")` : "") +
      (res.outputs_count !== undefined ? ` — ${res.outputs_count} sealed output(s)` : "") +
      (res.error ? ` — ${res.error}` : ""));
    return code;
  }

  // `seal-genome` is the bulk-migration door (WO-F07 Article I). It needs ONLY the genome ledger
  // and the genome dir — not bootstrapServerDeps, which would load every definition and couple the
  // command to server init for no benefit. It reuses sealDefinition (the blessed write path), so it
  // never reimplements sealing; it only iterates it. Exit 0 when every file is sealed-or-skipped,
  // exit 1 if any file errored — a partial seal leaves detectGenomeOrphans non-empty, so exit 0
  // would falsely signal a fully-sealed genome (matching the validate exit-code contract).
  if (cmd === "seal-genome") {
    const genome_dir = positional[0] ?? process.cwd();
    let report: SealGenomeReport;
    try {
      report = sealGenome(genome_dir, new FileLedger(defaultGenomeLedgerPath(genome_dir)));
    } catch (e) {
      line(io, `seal-genome failed: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    for (const { path, error } of report.errors) line(io, `error  ${path}: ${error}`);
    if (emitJson(io, json, report)) return report.errors.length === 0 ? 0 : 1;
    line(io, `sealed ${report.sealed.length}, skipped ${report.skipped.length}` +
      (report.errors.length ? `, ${report.errors.length} error(s)` : ""));
    return report.errors.length === 0 ? 0 : 1;
  }

  // Booting loads the genome and constructs the invoker, so it happens only after the command
  // is known to be real — `--help` and a typo must not pay for it or fail inside it.
  let deps: ServerDeps;
  try {
    deps = io.deps ?? bootstrapServerDeps(typeof flags["genome"] === "string" ? flags["genome"] : undefined);
  } catch (e) {
    line(io, `could not load the genome: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const call = async (slug: string, args: Record<string, unknown>): Promise<ToolResult> =>
    dispatchTool(slug, args, deps);

  switch (cmd) {
    // ── the CI gate ──────────────────────────────────────────────────────────
    case "validate": {
      const r = await call("genome_reload", {});
      const data = r.data as { load_errors?: unknown[]; changes?: Record<string, unknown[]> } | undefined;
      const errs = data?.load_errors ?? [];

      // WO-F06 — the orphan invariant, folded into the CI gate so it ships wherever a genome repo
      // already runs `coltrane validate`, with no per-repo .github/ wiring. Every genome file under
      // standards/ | domain_types/ | agents/ must carry a genome_mutation seal in the git-tracked
      // genome ledger; a file with none is an orphan — "no identity, outside the substrate"
      // (src/genome_writer.ts:1-6). deps.ledger reads the genome ledger (defaultGenomeLedgerPath),
      // so the seals CI sees are exactly the ones the repo shipped.
      //
      // Enforced ONLY when the genome ledger actually holds seals. A genome that ships no ledger at
      // all predates sealing and has nothing to enforce against — failing it would break every bare,
      // unsealed fixture and every pre-WO-F06 genome, which is not this gate's job. deps.genome_dir
      // is absent in hosted/bare-deps mode, where there are no genome files on disk to scan.
      let orphans: string[] = [];
      if (deps.genome_dir) {
        const seals = deps.ledger.query({ kind: "genome_mutation" });
        if (seals.length > 0) orphans = detectGenomeOrphans(deps.genome_dir, deps.ledger);
      }

      if (emitJson(io, json, r.data)) return errs.length === 0 && orphans.length === 0 ? 0 : 1;

      // Non-zero exit is the whole feature: this is what a CI job branches on. Load errors first —
      // a genome that will not load is a harder failure than one that loads with an unsealed file.
      if (errs.length > 0) {
        line(io, `genome has ${errs.length} load error(s):`);
        for (const e of errs) line(io, `  ${typeof e === "string" ? e : JSON.stringify(e)}`);
        return 1;
      }
      if (orphans.length > 0) {
        line(io, `genome has ${orphans.length} orphan(s) — a genome file with no ledger seal has no identity:`);
        for (const o of orphans) line(io, `  ${o}`);
        return 1;
      }
      // `changes` is {added|modified|removed} -> {class -> slug[]}, so a count means summing
      // the leaf arrays. Reporting a bare `undefined` here would be its own small dishonesty.
      const c = data?.changes as Record<string, Record<string, unknown[]>> | undefined;
      const counts = c
        ? Object.entries(c)
            .map(([k, byClass]) => [k, Object.values(byClass ?? {}).reduce((n, a2) => n + (a2?.length ?? 0), 0)] as const)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${n} ${k}`)
            .join(", ")
        : "";
      io.out(`genome ok${counts ? ` — ${counts}` : ", no changes"}\n`);
      return 0;
    }

    case "dispatch": {
      const standard = positional[0];
      if (!standard) { line(io, "dispatch needs a standard slug"); return 2; }
      const input = readInput(typeof flags["input"] === "string" ? flags["input"] : undefined, io);
      if (input.error) { line(io, input.error); return 2; }

      const approvals = readApprovals(flags["approve"], io);
      if (approvals.error) { line(io, approvals.error); return 2; }

      const args: Record<string, unknown> = { standard_slug: standard, input: input.value };
      if (typeof flags["depth"] === "string") args["depth"] = flags["depth"];
      if (typeof flags["resume"] === "string") args["resume_gig_id"] = flags["resume"];
      // #20 — --input NOT supplied (the readInput(undefined) path above yields {}, which is
      // indistinguishable from an explicit `--input {}`). Signal the omission so an approve-only
      // resume inherits the checkpoint's recorded gig_input_sha rather than refusing on the drift
      // to sha256('{}'). A supplied --input (even `{}`) leaves this unset, so a disagreeing payload
      // still refuses (see src/runtime.ts #20).
      if (typeof flags["input"] !== "string") args["gig_input_omitted"] = true;
      if (flags["reuse"] === true) args["reuse"] = true;
      if (flags["wait"] === true) args["wait"] = true;
      if (approvals.value) args["approvals"] = approvals.value;
      if (typeof flags["as"] === "string") args["approved_by"] = flags["as"];
      if (typeof flags["budget"] === "string") {
        const opening = Number(flags["budget"]);
        if (!Number.isFinite(opening) || opening <= 0) { line(io, `--budget must be a positive number`); return 2; }
        args["budget"] = { opening };
      }

      const r = await call("gig_dispatch", args);
      if (!r.ok) { line(io, `dispatch failed: ${r.error ?? "unknown error"}`); return 1; }
      const d = r.data as {
        gig_id: string; status?: string; awaiting?: { phase: string; role: string };
        warnings?: string[]; manifest?: Record<string, unknown>;
      };
      for (const w of d.warnings ?? []) line(io, `warning: ${w}`);
      if (emitJson(io, json, r.data)) return 0;

      // The gig id is the ONLY thing on stdout for a bare dispatch, so it pipes into the
      // other subcommands without parsing.
      io.out(d.gig_id + "\n");
      // A parked gig must SAY it parked. The manifest line below would otherwise print
      // "complete" over a run that sealed nothing at its final chair — and the operator whose
      // signature the run is waiting for would have no way to know it is theirs to give.
      if (d.status === "awaiting_approval") {
        line(io, `awaiting approval` +
          (d.awaiting ? ` at human chair "${d.awaiting.role}" (phase "${d.awaiting.phase}")` : "") +
          `; nothing after it ran. Approve with: --resume ${d.gig_id} --approve <role>=<verdict> --as <name>`);
        return 0; // waiting on a person is not a failure
      }
      if (d.manifest) {
        const m = d.manifest as { output_count?: number; run_fingerprint?: string; usage?: { total_cost_usd?: number } };
        line(io, `complete — ${m.output_count ?? 0} sealed output(s)` +
          (m.usage?.total_cost_usd !== undefined ? `, $${m.usage.total_cost_usd.toFixed(2)}` : "") +
          (m.run_fingerprint ? `, fingerprint ${m.run_fingerprint.slice(0, 12)}` : ""));
      }
      return 0;
    }

    case "monitor": {
      const gig = positional[0];
      if (!gig) { line(io, "monitor needs a gig id"); return 2; }
      const follow = flags["follow"] === true;
      for (;;) {
        const r = await call("gig_monitor", { gig_id: gig });
        if (!r.ok) { line(io, `monitor failed: ${r.error ?? "unknown error"}`); return 1; }
        const d = r.data as { status?: string; phases_complete?: number; current_phase?: string };
        if (!follow) {
          if (emitJson(io, json, r.data)) return 0;
          io.out(`${d.status ?? "unknown"} — ${d.phases_complete ?? 0} phase(s) complete` +
            (d.current_phase ? `, in ${d.current_phase}` : "") + "\n");
          return d.status === "failed" ? 1 : 0;
        }
        if (TERMINAL.has(String(d.status))) {
          // Parked is not failed — same reasoning as the dispatch reply.
          const settled = d.status === "complete" || d.status === "awaiting_approval" ? 0 : 1;
          if (emitJson(io, json, r.data)) return settled;
          io.out(`${d.status}\n`);
          return settled;
        }
        line(io, `${d.status ?? "running"} — ${d.phases_complete ?? 0} phase(s)` +
          (d.current_phase ? `, in ${d.current_phase}` : ""));
        await new Promise((res) => setTimeout(res, 2000));
      }
    }

    case "logs": {
      const gig = positional[0];
      if (!gig) { line(io, "logs needs a gig id"); return 2; }
      const args: Record<string, unknown> = { gig_id: gig };
      if (typeof flags["role"] === "string") args["role"] = flags["role"];
      const r = await call("gig_logs", args);
      if (!r.ok) { line(io, `logs failed: ${r.error ?? "unknown error"}`); return 1; }
      if (emitJson(io, json, r.data)) return 0;
      io.out(JSON.stringify(r.data, null, 2) + "\n");
      return 0;
    }

    case "abort": {
      const gig = positional[0];
      if (!gig) { line(io, "abort needs a gig id"); return 2; }
      const args: Record<string, unknown> = { gig_id: gig };
      if (typeof flags["reason"] === "string") args["reason"] = flags["reason"];
      const r = await call("gig_abort", args);
      if (!r.ok) { line(io, `abort failed: ${r.error ?? "unknown error"}`); return 1; }
      if (emitJson(io, json, r.data)) return 0;
      const d = r.data as { status?: string; aborted?: boolean; cancellable?: boolean };
      io.out(`${d.status ?? "unknown"}\n`);
      // `cancellable: false` means this process could not reach the run — worth saying, because
      // "aborted" would otherwise imply we stopped something we never touched.
      if (d.cancellable === false) line(io, "note: this process held no handle on that gig; the ledger was marked, nothing was killed");
      return 0;
    }

    case "trace": {
      const id = positional[0];
      if (!id) { line(io, "trace needs an output id"); return 2; }
      const args: Record<string, unknown> = { output_id: id };
      if (typeof flags["direction"] === "string") args["direction"] = flags["direction"];
      if (typeof flags["max-depth"] === "string") args["max_depth"] = Number(flags["max-depth"]);
      const r = await call("output_trace", args);
      if (!r.ok) { line(io, `trace failed: ${r.error ?? "unknown error"}`); return 1; }
      if (emitJson(io, json, r.data)) return 0;
      const d = r.data as { graph?: { nodes?: Array<{ id: string; domain_type: string; agent_slug?: string }> } };
      for (const n of d.graph?.nodes ?? []) {
        io.out(`${n.id}  ${n.domain_type}${n.agent_slug ? `  ${n.agent_slug}` : ""}\n`);
      }
      return 0;
    }

    case "simulate": {
      const standard = positional[0];
      if (!standard) { line(io, "simulate needs a standard slug"); return 2; }
      const args: Record<string, unknown> = { standard_slug: standard };
      if (typeof flags["depth"] === "string") args["depth"] = flags["depth"];
      const r = await call("standard_simulate", args);
      if (!r.ok) { line(io, `simulate failed: ${r.error ?? "unknown error"}`); return 1; }
      if (emitJson(io, json, r.data)) return 0;
      const d = r.data as { phases?: unknown[]; estimated_cost?: number; basis?: string };
      io.out(`${(d.phases ?? []).length} phase(s)` +
        (d.estimated_cost !== undefined ? `, ~$${d.estimated_cost.toFixed(2)}` : "") +
        (d.basis ? ` (${d.basis})` : "") + "\n");
      return 0;
    }

    case "health": {
      const args: Record<string, unknown> = {};
      if (typeof flags["window"] === "string") args["window"] = flags["window"];
      const r = await call("system_health", args);
      if (!r.ok) { line(io, `health failed: ${r.error ?? "unknown error"}`); return 1; }
      if (emitJson(io, json, r.data)) return 0;
      const d = r.data as {
        gigs_run?: number; cost?: number; load_errors?: unknown[];
        counts_complete?: boolean | null; counts_complete_basis?: string;
      };
      io.out(`${d.gigs_run ?? 0} gig(s), $${(d.cost ?? 0).toFixed(2)}\n`);
      if ((d.load_errors ?? []).length > 0) line(io, `${(d.load_errors ?? []).length} genome load error(s)`);
      // The engine refuses to claim its counts are whole; the CLI must not claim it for it.
      if (d.counts_complete !== true && d.counts_complete_basis) line(io, d.counts_complete_basis);
      return 0;
    }
  }
  return 2;
}
