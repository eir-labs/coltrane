# RED spec — Node 26 is enforced where skills run, not at install; the bus is not a hosted tool

Laws: `tests/node_floor_where_skills_run.test.ts` (F1–F4), `tests/bus_not_hosted.test.ts` (B1–B4),
`tests/skill_runs_on_exec_path.test.ts` (P1, P3) and `tests/security/skill_runs_on_exec_path.spec.ts` (P2).
Status: round 1 (F, B) is green at `ad9d5ec`, and every law in it has been turned red by its own plant
(observed, reverted). Round 2 (P) is **RED** at `ad9d5ec`: P1a–c, P2 and P3a fail on an assertion that
states the contract's reason. P3b already holds and goes red under its plant.

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

vitest, example-based. Only P2 opens a socket, on loopback, in the security band. **The version seam:** a `--import data:` preload redefines
`process.versions.node` before any module loads, in a child of this runtime (the fake
`node_floor_refuses` already uses); in-process laws redefine it around one call and restore it. The
LAWS still fake the version. Real Node 24.21.0 was exercised outside the laws, twice: the implementer's
comment 5847451491 (an engine-strict install of the packed tarball exits 0, the imports load, 58 hosted
tools, the refusals hold) and the non-author grade issuecomment-5847532054, which confirmed it
independently. CI has no real-24 job yet. F4's
control is also the seam's: the same preload makes the CLI refuse, so a green F1 is not a fake that
never landed. F1 and F4 drive the BUILT `dist/` (globalSetup builds once), i.e. the files the exports
map and the bin actually name. F3 uses a tier-1 skill that writes a marker file, so "before any skill
code runs" is observed on disk. B1–B3 point `HOME` at an empty temp dir with `COLTRANE_BUS_DIR` unset
(the default path that leaked) and assert the directory stays empty.

## Coverage map

| id | law | kind | drives | plant | failing reason at 471169e (origin/main), or under its plant |
|---|---|---|---|---|---|
| F1 | every exports-map entry imports under Node 24.21.0; createToolSurface builds a hosted surface under it | behavioural | every `exports` entry → `dist/src/*.js` (package.json); `createToolSurface` — src/server.ts | add `import "./runtime_floor.js";` to src/tool_surface.ts | holds today; under plant: `importing ./tool_surface … exited 1: coltrane requires Node 26 or newer` |
| F2a | no install lifecycle script refuses Node 24.21.0 (each present is RUN, NODE_OPTIONS-faked) | behavioural | `package.json` scripts.preinstall/install/postinstall, executed | add `"preinstall": "node -e \"process.exit(Number(process.versions.node.split('.')[0])<26?1:0)\""` (or re-add scripts/node_floor.cjs) | `"preinstall": node scripts/node_floor.cjs refused Node 24.21.0 (exit 1)` |
| F2b | engines.node is a plain `>=24` | structural | package.json `engines.node` | set `engines.node` back to `">=26"` | `engines.node >=26 blocks a Node 24 install: expected 26 to be 24` |
| F3a | executeSkill under 24 refuses naming Node 26 and the network controls; the skill never runs | behavioural | `executeSkill` — src/skill_subprocess.ts | delete `assertSandboxCapableRuntime()` from executeSkill | `the refusal does not name the network controls it exists for` (the message names Node 26 and `--permission`, never the network) |
| F3b | same, executeSkillAsync (the drain's skill chair) | behavioural | `executeSkillAsync` — src/skill_subprocess.ts | delete `assertSandboxCapableRuntime()` from executeSkillAsync | same message defect; under plant `the drain's skill spawn RAN below the floor` |
| F3c | same, skill_execute on the local surface | behavioural | `createToolSurface(...).skill_execute` — src/server.ts | in skill_execute's case, catch executeSkill's throw and return `ok:true` with it as data | observed: `expected 'NOT REFUSED (the call answered ok, or…' to match /Node 26/`. This plant first stayed GREEN: the law's helper quoted the ok:true result, which carried "Node 26 … network" through. Fixed in round 2 so that a non-refusal returns a bare marker |
| F4 | `coltrane work` under 24 exits 1 naming Node 26 and the network controls, before the verb runs | behavioural | `dist/src/cli_entry.js work` (src/runtime_floor.ts) | delete `import "./runtime_floor.js"` from src/cli_entry.ts | holds today; under plant: `coltrane work started under Node 24.21.0: work needs COLTRANE_STORE_URL…` |
| B1 | hosted bus_post refused (`hosted_unsupported`, names `bus_post`), nothing written | behavioural | `createToolSurface({hosted:true}).bus_post` — src/server.ts | after the fix: drop bus_post from HOSTED_BLOCKED | `hosted bus_post answered ok:true — the bus leaked onto the hosted route`; a refusal that still writes reds on `wrote under the server's home: ['.eir', '.eir/bus', …]` (planted, observed) |
| B2 | same, bus_read | behavioural | `…bus_read` — src/server.ts | drop bus_read from HOSTED_BLOCKED | `hosted bus_read answered ok:true` |
| B3 | same, bus_owed | behavioural | `…bus_owed` — src/server.ts | drop bus_owed from HOSTED_BLOCKED | `hosted bus_owed answered ok:true` |
| B4 | control: the local surface keeps bus_post/bus_owed/bus_read on the default bus file | behavioural | `createToolSurface({hosted:false}).bus_*` — src/server.ts | refuse the bus on every surface | holds today; under plant (`bus_post` always refuses): `planted: expected false to be true` |

F2b is structural because `engines` is read by package managers (yarn v1 and engine-strict npm/pnpm
hard-fail on it), never by code in this repo — there is no production symbol to call. `>=24` exactly:
24 is the hosted app's runtime, and the ruling keeps 22 out.

## Round 2: the skill runs on the Node that checked the floor

**The hole** (non-author grade, issuecomment-5847532054). `assertSandboxCapableRuntime()` and `tierFlags()`
read `process.versions.node`, which is the PARENT's version. But `executeSkill` and `executeSkillAsync`
spawned the bare string `"node"`, which is resolved from PATH. Reproduced there on the packed tarball: a
parent on 26.7.0 with node 24.21.0 first on PATH ran a tier-0 skill with **no** network grant, and its
`fetch` to a local listener got **200**. F3 could not see this: it fakes the parent's version, and the
parent's version is exactly what this defect leaves alone.

**How the laws see it.** A fake `node` goes first on PATH. It records that it was invoked, then runs the
real binary with `--permission` and every `--allow-*` removed. That is a Node with no permission model,
which is what 24 is for the network. So the laws need no real Node 24 installed:
`<scratchpad>/n24` held no binary, and `/opt/homebrew/opt/node@24` links to 26.7.0. The `beforeEach`
checks that a bare `node` really resolves to the shim, so "never invoked" cannot pass vacuously.

| id | law | kind | drives | plant | failing reason at ad9d5ec |
|---|---|---|---|---|---|
| P1a | executeSkill never invokes PATH `node`; the skill runs | behavioural | `executeSkill` — src/skill_subprocess.ts:224 | (red) · after: `spawnSync("node", …)` | `the skill was launched through \`node\` on PATH, not process.execPath` |
| P1b | same, executeSkillAsync | behavioural | `executeSkillAsync` — src/skill_subprocess.ts:296 | (red) · after: `spawn("node", …)` | same |
| P1c | same, local skill_execute | behavioural | `createToolSurface(...).skill_execute` — src/server.ts | (red) · after: have skill_execute's case launch the runner with `"node"` itself rather than via executeSkill | same |
| P2 | with the shim present, an UNGRANTED skill's fetch to a local listener is denied and the listener gets 0 hits | behavioural (security band: a real socket) | `executeSkillAsync` — src/skill_subprocess.ts | (red) · after: `spawn("node", …)` in executeSkillAsync | `an UNGRANTED skill fetched http://127.0.0.1:…/leak and got 200 … (PATH node used: true)` |
| P3a | bootstrap's fallback engine MCP server (no .mcp.json) is `command: process.execPath` | behavioural | `bootstrapServerDeps(root).mcpServerConfigs` — src/server.ts:4245 (`readMcpServerConfigs`) | (red) · after: `command: "node"` | `the engine MCP server is launched as a bare \`node\` from PATH: expected 'node' to be '/opt/homebrew/…/node'` |
| P3b | the MCP relay launches its server child without PATH `node` | behavioural | `dist/src/server_entry.js` → `runRelay` → `spawnChild` — src/server_relay.ts:65 | `spawn("node", [entryPath])` in spawnChild | holds; under the plant: `the relay launched its server child through \`node\` on PATH`, 10 runs out of 10. The first version passed `input: ""`, so the relay saw stdin close and killed its child before the shim logged; that plant went red only 1 run in 4. Stdin now stays open until a NODE_OPTIONS preload records that the child started, and the law also requires the child to have started at all (`the relay never started its server child`) and to run on the relay's own execPath |

Control: with only the two spawns in src/skill_subprocess.ts changed to `process.execPath`, P1a–c and P2
pass and P3a stays red. That was observed, then reverted.

### P3: the sweep of every bare `node`/`npx` launch in src/

This sweep covered `spawn`, `spawnSync`, `execFile(Sync)`, `exec(Sync)`, `fork`, `shell: true`, `sh -c`
strings, and MCP `command:` configs. It found no `fork`, no `execSync` and no shell-string launch in src/.

| site | launches | verdict |
|---|---|---|
| src/skill_subprocess.ts:224 `spawnSync("node", …)` (executeSkill) | skill code, sandboxed | **must be `process.execPath`**. P1a, P2 |
| src/skill_subprocess.ts:296 `spawn("node", …)` (executeSkillAsync) | skill code: the runtime's skill chair, which the drain runs | **must be `process.execPath`**. P1b, P2 |
| src/server.ts:4245 `{command: "node", args: ["dist/src/server_entry.js"]}` (readMcpServerConfigs fallback) | engine code: the chair's `coltrane` MCP server, launched by the claude CLI | **must be `process.execPath`**. P3a. It fails CLOSED today (server_entry refuses below 26, so the chair loses its engine tools), but on the wrong Node |
| src/server_relay.ts:65 `spawn(process.execPath, [entryPath])` | engine code: the relay's server child | already correct. P3b guards it |
| `.mcp.json` (repo config, not src/) `"command": "node"` | engine code, when bootstrap reads it | justified, no law. It is the user's MCP client config and the engine does not rewrite it. `server_entry` imports `runtime_floor` first (pinned by node_floor_refuses), so an old PATH node fails closed |
| src/code_tools.ts:109 `spawn("npx", ["vitest", "run", file])` | the TARGET repo's own test runner, in the gig's tree | justified, no law. It is neither skill nor engine code, and resolving the repo's toolchain from PATH is the intent |
| src/playwright_cage.ts:51 `{command: "npx", args: ["-y", "@playwright/mcp…"]}` | a third-party MCP server, launched by the claude CLI | justified, no law. Its cage is enforced by the server (`--allowed-origins`), not by Node's permission model |
| src/claude_invoker.ts:2458, src/document_factory.ts:102, src/judges/user_flow_judge.ts:170 | the `claude` CLI (`bin`) | not node |
| src/venue_realizer.ts:676/681/734/841 | `docker`, or a venue-declared `command` | not node. The venue declares the command explicitly |
| src/runtime.ts:1094, src/releases.ts:109/374, src/boundary_check.ts:25, src/workspace.ts:128 | `git` | not node |

Out of scope, noted: a tier-2 skill (`--allow-child-process`) that spawns `node` itself gets PATH's node
with no permission model. That is the capability tier 2 grants, not a spawn the engine makes.

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
