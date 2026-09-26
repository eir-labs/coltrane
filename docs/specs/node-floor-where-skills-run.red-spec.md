# RED spec — Node 26 is enforced where skills run, not at install; the bus is not a hosted tool

Laws: `tests/node_floor_where_skills_run.test.ts` (F1–F4), `tests/bus_not_hosted.test.ts` (B1–B4).
Status: **RED** — F2a, F2b, F3a–c and B1–B3 fail today on an assertion stating the contract's reason;
F1, F4 and B4 already hold and were each turned red by their plant (observed, reverted).

## The measured problem

A non-author grade of coltrane-ui #252 (moving the hosted app to `@eir-labs/coltrane` 0.25.4) found two
engine-side blockers.

1. **The install refuses Node < 26.** `package.json` has `"preinstall": "node scripts/node_floor.cjs"`
   and `engines: {"node": ">=26"}`. coltrane-ui runs Node 24 everywhere (Vercel included) and never
   runs a skill — it mounts `createToolSurface` from `./tool_surface` — yet cannot install any release.
2. **`bus_post` / `bus_read` / `bus_owed` are not hosted-blocked.** On a hosted surface they return
   `ok:true` and write under the server process's home (`~/.eir/bus`), shared by every org, unscoped.

## The ruling

> "22 is no starter given lack of network controls, full stop." — Eugene, quoted in #552

The Node-26 floor exists because a skill's network grant is enforced by `--allow-net`, which is Node 25+
(052c136), and 25 is end-of-life. Founder ruling (26 Sep 2026, verified in the session that commissioned
this spec): **the floor lives where skills run, not at install.** Remove the install-time refusal; refuse
loudly, by name, any skill execution or drain sandbox below Node 26. Library consumers on Node 24 must be
able to install and import.

## Which doors refuse, and which do not

| door | below 26 | why |
|---|---|---|
| `executeSkill` (src/skill_subprocess.ts) — `skill_execute`, the fixture runner | refuse | runs skill code |
| `executeSkillAsync` (src/skill_subprocess.ts) — the runtime's skill chair, what the drain runs | refuse | runs skill code |
| `skill_execute` on the local surface (src/server.ts) | refuse | via `executeSkill`; hosted already blocks it (`HOSTED_BLOCKED`, src/server.ts ~3750 — verified) |
| `coltrane work` (src/cli_entry.ts → src/runtime_floor.ts) | refuse | the drain worker runs skills |
| `coltrane-server` (src/server_entry.ts) | refuse | serves `skill_execute`; pinned by node_floor_refuses "every entry point imports the start check first" |
| every `exports`-map entry imported as a library | **admit** | the hosted app's path; no skill runs |
| the install lifecycle (`preinstall`/`install`/`postinstall`) | **admit** | nothing runs at install |

## Testing method

vitest, example-based, no network. **The version seam:** a `--import data:` preload redefines
`process.versions.node` before any module loads, in a child of this runtime (the fake
`node_floor_refuses` already uses); in-process laws redefine it around one call and restore it. No
Node 24 binary is needed — and none was available to cross-check (`/opt/homebrew/opt/node@24` links to
26.7.0), so the seam proves "no version check refuses", not "the code parses on a real Node 24". F4's
control is also the seam's: the same preload makes the CLI refuse, so a green F1 is not a fake that
never landed. F1 and F4 drive the BUILT `dist/` (globalSetup builds once), i.e. the files the exports
map and the bin actually name. F3 uses a tier-1 skill that writes a marker file, so "before any skill
code runs" is observed on disk. B1–B3 point `HOME` at an empty temp dir with `COLTRANE_BUS_DIR` unset
(the default path that leaked) and assert the directory stays empty.

## Coverage map

| id | law | kind | drives | plant | failing reason today |
|---|---|---|---|---|---|
| F1 | every exports-map entry imports under Node 24.21.0; createToolSurface builds a hosted surface under it | behavioural | every `exports` entry → `dist/src/*.js` (package.json); `createToolSurface` — src/server.ts | add `import "./runtime_floor.js";` to src/tool_surface.ts | holds today; under plant: `importing ./tool_surface … exited 1: coltrane requires Node 26 or newer` |
| F2a | no install lifecycle script refuses Node 24.21.0 (each present is RUN, NODE_OPTIONS-faked) | behavioural | `package.json` scripts.preinstall/install/postinstall, executed | (red today) | `"preinstall": node scripts/node_floor.cjs refused Node 24.21.0 (exit 1)` |
| F2b | engines.node is a plain `>=24` | structural | package.json `engines.node` | (red today) | `engines.node >=26 blocks a Node 24 install: expected 26 to be 24` |
| F3a | executeSkill under 24 refuses naming Node 26 and the network controls; the skill never runs | behavioural | `executeSkill` — src/skill_subprocess.ts | delete `assertSandboxCapableRuntime()` from executeSkill | `the refusal does not name the network controls it exists for` (the message names Node 26 and `--permission`, never the network) |
| F3b | same, executeSkillAsync (the drain's skill chair) | behavioural | `executeSkillAsync` — src/skill_subprocess.ts | delete `assertSandboxCapableRuntime()` from executeSkillAsync | same message defect; under plant `the drain's skill spawn RAN below the floor` |
| F3c | same, skill_execute on the local surface | behavioural | `createToolSurface(...).skill_execute` — src/server.ts | delete the assert from executeSkill | same message defect; under plant `skill_execute RAN a skill below the floor` |
| F4 | `coltrane work` under 24 exits 1 naming Node 26 and the network controls, before the verb runs | behavioural | `dist/src/cli_entry.js work` (src/runtime_floor.ts) | delete `import "./runtime_floor.js"` from src/cli_entry.ts | holds today; under plant: `coltrane work started under Node 24.21.0: work needs COLTRANE_STORE_URL…` |
| B1 | hosted bus_post refused (`hosted_unsupported`, names `bus_post`), nothing written | behavioural | `createToolSurface({hosted:true}).bus_post` — src/server.ts | after the fix: drop bus_post from HOSTED_BLOCKED | `hosted bus_post answered ok:true — the bus leaked onto the hosted route`; a refusal that still writes reds on `wrote under the server's home: ['.eir', '.eir/bus', …]` (planted, observed) |
| B2 | same, bus_read | behavioural | `…bus_read` — src/server.ts | drop bus_read from HOSTED_BLOCKED | `hosted bus_read answered ok:true` |
| B3 | same, bus_owed | behavioural | `…bus_owed` — src/server.ts | drop bus_owed from HOSTED_BLOCKED | `hosted bus_owed answered ok:true` |
| B4 | control: the local surface keeps bus_post/bus_owed/bus_read on the default bus file | behavioural | `createToolSurface({hosted:false}).bus_*` — src/server.ts | refuse the bus on every surface | holds today; under plant (`bus_post` always refuses): `planted: expected false to be true` |

F2b is structural because `engines` is read by package managers (yarn v1 and engine-strict npm/pnpm
hard-fail on it), never by code in this repo — there is no production symbol to call. `>=24` exactly:
24 is the hosted app's runtime, and the ruling keeps 22 out.

## Laws retired with the ruling

The install floor they pinned is what the ruling removes:

- `node_floor_refuses`: "install refuses Node 22, 24 and 25", "install accepts Node 26 and newer",
  "the install check is wired: preinstall runs it and the package ships it" (−3). The start-floor laws stay.
- `skill_sandbox_confinement`: "declares an engines floor matching the flag it actually spawns with" and
  "engines.node is at least the runtime that can back a network grant" (−2). The CI/container pin law
  stays, re-pointed from `engines` to `MIN_NODE_FOR_SANDBOX` — CI and the images run skills.

## Non-goals

No src/ or package.json change here (the implementing seat does that). No org-scoped hosted bus — the
hosted bus is refused, not built. The server entry's start refusal is unchanged.
