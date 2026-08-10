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
import { COLTRANE_VERSION } from "./version.js";
import { workOnce } from "./worker.js";
import { makeClaudeInvoker } from "./claude_invoker.js";
import { readFileSync } from "node:fs";

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Injected for tests; production boots from the genome on disk. */
  deps?: ServerDeps;
  /** Injected for tests. Production reads stdin for `--input -`. */
  stdin?: () => string;
}

export const USAGE = `coltrane ${COLTRANE_VERSION}

  coltrane validate                     load the genome; exit non-zero on load errors
  coltrane dispatch <standard>          run a standard
  coltrane monitor <gig-id>             report a gig's progress
  coltrane logs <gig-id>                per-chair logs for a gig
  coltrane abort <gig-id>               stop a running gig
  coltrane trace <output-id>            walk an output's provenance
  coltrane simulate <standard>          cost/shape a standard without running it
  coltrane health                       engine + store health
  coltrane serve                        run the MCP server on stdio
  coltrane work                         claim one queued gig from the org store and run it
                                        (env: COLTRANE_STORE_URL, COLTRANE_STORE_ANON,
                                         COLTRANE_AGENT_TOKEN; results drain via
                                         COLTRANE_DRAIN_URL + COLTRANE_DRAIN_KEY;
                                         checkpoints under COLTRANE_WORKER_CHECKPOINTS,
                                         default ~/.coltrane/worker-checkpoints;
                                         exit 0 complete or parked, 1 failed, 3 queue empty)

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

  coltrane dispatch <standard> --resume <gig> --input @orig.json \\
      --approve approve=@verdict.json --as eugene
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

  const KNOWN = ["validate", "dispatch", "monitor", "logs", "abort", "trace", "simulate", "health", "serve", "work"];
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

  // `work` runs against the ORG STORE, not a genome root — the seated agent's token is the
  // read scope and the chair contract is the authorization, so no file genome boots here.
  if (cmd === "work") {
    const baseUrl = process.env["COLTRANE_STORE_URL"];
    const anonKey = process.env["COLTRANE_STORE_ANON"];
    const agentToken = process.env["COLTRANE_AGENT_TOKEN"];
    if (!baseUrl || !anonKey || !agentToken) {
      line(io, "work needs COLTRANE_STORE_URL, COLTRANE_STORE_ANON and COLTRANE_AGENT_TOKEN in the environment");
      return 2;
    }
    const res = await workOnce(
      {
        baseUrl,
        anonKey,
        agentToken,
        ...(typeof flags["worker"] === "string" ? { worker: flags["worker"] } : {}),
      },
      {
        makeInvoke: (registry) =>
          makeClaudeInvoker({
            registry,
            model: process.env["COLTRANE_MODEL"],
            ...(process.env["COLTRANE_CHAIR_TIMEOUT_MS"] ? { timeout_ms: Number(process.env["COLTRANE_CHAIR_TIMEOUT_MS"]) } : {}),
          }),
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
      if (emitJson(io, json, r.data)) return errs.length === 0 ? 0 : 1;
      if (errs.length === 0) {
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
      // Non-zero exit is the whole feature: this is what a CI job branches on.
      line(io, `genome has ${errs.length} load error(s):`);
      for (const e of errs) line(io, `  ${typeof e === "string" ? e : JSON.stringify(e)}`);
      return 1;
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
