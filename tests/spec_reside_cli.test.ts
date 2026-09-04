// RED — LAW 1 and LAW 8 of WI-3: `reside` is ON THE REAL SURFACE, and an unwired deployment gets a
// named refusal instead of an exception.
//
// WHY LAW 1 IS WRITTEN AGAINST THE MOUNT AND NOT THE SYMBOL. `runReside` has existed since the
// state machine landed (src/residency.ts:419): exported, driven by spec_reside_surface.test.ts:123,
// pinned as law I20/O14 in docs/specs/residency_contract.md — and it is a three-line stub that
// nothing calls, because src/cli.ts's KNOWN table has no "reside" in it. A law proved the mechanism
// WORKS; nothing asked whether it is REACHED, so `coltrane reside` answers `unknown command` on a
// green suite. That is this repo's own most-repeated defect (CLAUDE.md: "a field on a surface
// nothing serves is a field no client can send"), and a law that asserted `typeof runReside ===
// "function"` would restate the pass rather than close it.
//
// So these laws assert REACHABILITY, three ways, and each one goes red today:
//   • the KNOWN table names it (structural — the 0.9.3 precedent),
//   • the usage text teaches it (a command no one is told about is unreachable in practice),
//   • and the command, when RUN, does not answer "unknown command" (behavioural — the one that
//     cannot be satisfied by a declaration alone).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, USAGE, type CliIO } from "../src/cli.js";
import { loadReside, recordingDeps, type ResideModule } from "./spec_reside_loop_fixtures.js";

const CLI_SRC = readFileSync(join(new URL("../src", import.meta.url).pathname, "cli.ts"), "utf8");

function io(over: Partial<CliIO> = {}): CliIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    out: (s) => { stdout.push(s); },
    err: (s) => { stderr.push(s); },
    stdout,
    stderr,
    ...over,
  } as CliIO & { stdout: string[]; stderr: string[] };
}

/** The three bootstrap values `work` actually reads, per src/worker_env.ts's WORKER_ENV_CONTRACT —
 *  NOT the spec's original M1 wording, which named the deprecated COLTRANE_DRAIN_URL. Amended on
 *  spec.envoy-residency.coltrane-reside before this was written. */
const BOOT_ENV = {
  COLTRANE_STORE_URL: "https://store.example",
  COLTRANE_STORE_ANON: "anon-key",
  COLTRANE_SERVICE_URL: "https://coltrane.example",
  COLTRANE_DRAIN_KEY: "cdk_house",
  COLTRANE_INSTANCE: "box.A",
};

describe("LAW 1 — `reside` is on the real surface, beside `work` (spec_reside_cli)", () => {
  it("the KNOWN command table names reside — not just the module that implements it", () => {
    // Structural, and deliberately reading the source: the property is "the dispatcher can reach
    // it", and only the dispatcher's own table can testify to that.
    const known = /const KNOWN = \[(.*?)\]/s.exec(CLI_SRC)?.[1] ?? "";
    expect(known, "src/cli.ts has a KNOWN table this law could not find").not.toBe("");
    expect(known, 'KNOWN has no "reside" — the command is unreachable however complete the loop is')
      .toContain('"reside"');
  });

  it("the usage text teaches reside, and teaches the env contract work actually uses", () => {
    expect(USAGE, "usage never mentions reside").toContain("coltrane reside");
    // The amended M1: the canonical names. COLTRANE_DRAIN_URL is a deprecated legacy alias
    // (src/worker_env.ts) and must not be taught again on a new command.
    expect(USAGE).toContain("COLTRANE_STORE_URL");
    const resideHelp = USAGE.slice(USAGE.indexOf("coltrane reside"));
    const resideBlock = resideHelp.slice(0, resideHelp.indexOf("\n\n") + 1);
    expect(resideBlock, "reside's own help teaches the deprecated COLTRANE_DRAIN_URL")
      .not.toContain("COLTRANE_DRAIN_URL");
  });

  it("running `coltrane reside` does not answer `unknown command`", async () => {
    // THE LAW THAT CANNOT BE SATISFIED BY A DECLARATION. Today this is exactly what happens.
    const o = io();
    const code = await runCli(["reside"], o);
    expect(o.stderr.join(""), "coltrane reside is not a command the CLI knows")
      .not.toContain("unknown command");
    // Missing store env is a USAGE refusal — exit 2, the same door `work` uses (law I20/O14).
    expect(code).toBe(2);
  });

  it("--any and --residency <uuid> are accepted, not rejected as malformed", async () => {
    for (const argv of [["reside", "--any"], ["reside", "--residency", "res-viola-1"]]) {
      const o = io();
      await runCli(argv, o);
      const err = o.stderr.join("");
      expect(err, `${argv.join(" ")} was not understood`).not.toContain("unknown command");
      expect(err, `${argv.join(" ")} was rejected as an unknown option`).not.toContain("unknown option");
    }
  });

  it("reside and work take the SAME bootstrap contract — no new credential class", () => {
    // The whole point of M1: a residency's hands materialize from the drain key that already
    // exists. A law here rather than a comment, because "no new credential class" is exactly the
    // kind of promise that rots silently.
    const forbidden = ["COLTRANE_RESIDENCY_KEY", "COLTRANE_RESIDE_KEY", "COLTRANE_CORTEX_TOKEN"];
    for (const name of forbidden) {
      expect(CLI_SRC, `reside invented a new credential class (${name})`).not.toContain(name);
    }
  });
});

describe("LAW 8 — an unwired seam is a NAMED refusal, never a throw", () => {
  let R: ResideModule;
  it("with channelListener absent the loop answers refusal:'no_backend' and names the seam", async () => {
    R = await loadReside();
    const { deps } = recordingDeps();
    delete (deps as { channelListener?: unknown }).channelListener;
    const r = R.createResidency({ residency: "any" }, deps);

    // The gig_dispatch shape: {ok:false, refusal}. NEVER an exception — a deployment that has not
    // wired a transport is a fact to report, not a crash to catch.
    const booted = await r.boot();
    expect(booted.ok, "an unwired listener booted anyway").toBe(false);
    if (!booted.ok) {
      expect(booted.refusal).toBe("no_backend");
      expect(booted.seam, "the refusal does not say WHICH seam is unwired").toBe("channelListener");
      expect(booted.message, "a refusal with no message is not information").toBeTruthy();
    }
  });

  it("`hosted_unsupported` is not reused for a missing backend", async () => {
    R = await loadReside();
    expect(R.RESIDE_REFUSALS).toContain("no_backend");
    expect(R.RESIDE_REFUSALS, "an unwired seam and an unsupported deployment are different facts")
      .not.toContain("hosted_unsupported");
  });

  it("the command with a complete env but no wired backend refuses without throwing", async () => {
    const o = io({ env: BOOT_ENV } as Partial<CliIO>);
    let threw: unknown = null;
    let code = -1;
    try {
      code = await runCli(["reside", "--any"], o);
    } catch (e) {
      threw = e;
    }
    expect(threw, "reside threw at an unwired seam instead of refusing").toBe(null);
    expect(o.stderr.join(""), "the refusal does not name the seam").toContain("no_backend");
    expect(code, "an unwired deployment is a misconfiguration — exit 2").toBe(2);
  });
});
