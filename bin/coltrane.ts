#!/usr/bin/env node
// coltrane CLI entry point.
//
// Subcommands:
//   init --live-slack          — scaffold slack app manifest + .env template
//                                + 4 steve dirs under .coltrane/.
//   play --live-slack          — boot the 4 children + slack bridges.
//   resume <uuid>              — re-attach to a Steve's inner claude-code
//                                session in the user's terminal.
//   sleep <uuid> | --all       — manually trigger the bleach-wash that
//                                surfaces ratchet candidates from the
//                                last 24h audit.
//
// Kept minimal — argv parsing is hand-rolled (the live-slack surface is
// small enough that pulling in a parser dep would be over-built).

import { resolve } from "node:path";
import { materializeScaffold, renderSetupInstructions } from "../src/live/scaffold.js";
import { bootOrchestrator } from "../src/live/orchestrator.js";
import { resumeSteve } from "../src/live/resume.js";
import { sleepSteve, sleepAllSteves, noteSleepInAudit } from "../src/live/sleep.js";

interface ParsedArgs {
  subcommand: string | undefined;
  flags: Set<string>;
  positionals: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    subcommand: argv[0],
    flags: new Set(),
    positionals: [],
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) out.flags.add(a);
    else out.positionals.push(a);
  }
  return out;
}

export interface CliRunResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(argv: readonly string[], cwd: string = process.cwd()): Promise<CliRunResult> {
  const args = parseArgs(argv);
  let stdout = "";
  let stderr = "";

  if (!args.subcommand || args.flags.has("--help") || args.subcommand === "help") {
    stdout +=
      "coltrane — live-slack subcommands:\n" +
      "  coltrane init --live-slack    scaffold slack manifest + 4 steve dirs\n" +
      "  coltrane play --live-slack    boot the 4 steves + slack connections\n" +
      "  coltrane resume <uuid>        open Steve <uuid>'s inner claude thread\n" +
      "  coltrane sleep <uuid>         manually trigger bleach-wash for one Steve\n" +
      "  coltrane sleep --all          manually trigger bleach-wash for all Steves\n";
    return { exit_code: 0, stdout, stderr };
  }

  if (args.subcommand === "init" && args.flags.has("--live-slack")) {
    const result = await materializeScaffold({ root: cwd });
    stdout += renderSetupInstructions(result) + "\n";
    return { exit_code: 0, stdout, stderr };
  }

  if (args.subcommand === "resume") {
    const uuid = args.positionals[0];
    if (!uuid) {
      stderr += "resume requires a steve uuid: coltrane resume <uuid>\n";
      return { exit_code: 2, stdout, stderr };
    }
    try {
      const code = await resumeSteve(uuid, cwd);
      return { exit_code: code, stdout, stderr };
    } catch (err) {
      stderr += `${(err as Error).message}\n`;
      return { exit_code: 1, stdout, stderr };
    }
  }

  if (args.subcommand === "sleep") {
    if (args.flags.has("--all")) {
      const receipts = await sleepAllSteves(cwd);
      for (const r of receipts) await noteSleepInAudit(cwd, r);
      stdout += `slept ${receipts.length} steve(s)\n`;
      for (const r of receipts) {
        stdout += `  ${r.uuid}  candidates=${r.candidate_count}${r.error ? `  err=${r.error}` : ""}\n`;
      }
      return { exit_code: 0, stdout, stderr };
    }
    const uuid = args.positionals[0];
    if (!uuid) {
      stderr += "sleep requires a steve uuid or --all: coltrane sleep <uuid> | --all\n";
      return { exit_code: 2, stdout, stderr };
    }
    const receipt = await sleepSteve(uuid, cwd);
    await noteSleepInAudit(cwd, receipt);
    stdout +=
      `slept ${receipt.uuid}  candidates=${receipt.candidate_count}` +
      (receipt.error ? `  err=${receipt.error}` : "") +
      "\n";
    return { exit_code: 0, stdout, stderr };
  }

  if (args.subcommand === "play" && args.flags.has("--live-slack")) {
    const bookPath = process.env["COLTRANE_BOOK_PATH"] ?? resolve(cwd, "CLAUDE.md");
    const handle = await bootOrchestrator({ root: cwd, book_path: bookPath });
    stdout += `booted ${handle.steves.length} steve(s)\n`;
    // wait for SIGINT/SIGTERM
    await new Promise<void>((res) => {
      const shut = () => {
        void handle.shutdown().then(res);
      };
      process.once("SIGINT", shut);
      process.once("SIGTERM", shut);
    });
    return { exit_code: 0, stdout, stderr };
  }

  stderr += `unknown subcommand: ${args.subcommand}\n`;
  return { exit_code: 2, stdout, stderr };
}

const isDirectInvocation =
  typeof process.argv[1] === "string" && import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  runCli(process.argv.slice(2)).then((r) => {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exit_code);
  });
}
