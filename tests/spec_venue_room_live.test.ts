/** THE ROOM ACTUALLY STANDS UP.
 *
 *  Every other venue law in this suite asserts on a RENDERED DOCUMENT or an EMITTED CONFIG. That is
 *  how eighty-eight green laws coexisted with a realizer that stood nothing up: `realize()` rendered
 *  a compose document for its refusal side-effects, THREW IT AWAY, returned PLAYING, and handed back
 *  an MCP config naming `coltrane-gig-<id8>-room-1` — a container nothing ever created. Every
 *  assertion about that config passed. `docker exec` into it fails with "No such file or directory",
 *  because the transport names a container that does not exist.
 *
 *  Verifying the artifact is not verifying the behaviour — the same lesson the credential-secret note
 *  in src/venue_realizer.ts records one layer down, relearned at the layer above it.
 *
 *  So this law does the only thing that can distinguish the two: it takes the config the ENGINE
 *  emitted, runs it VERBATIM as a subprocess, and requires coltrane's own MCP server to answer over
 *  it. Nothing here is hand-typed; a hand-built compose file and a hand-typed `docker exec` is what
 *  made the earlier claim look true.
 *
 *  Gated on a live daemon, and the gate is visible: without docker these SKIP, they do not pass. A
 *  law that silently succeeds where it cannot run is the hollow-green this repo refuses. */
import { describe, expect, it, vi, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => vi.unstubAllGlobals());

/** A LOCAL bare repository with one committed file — the same no-network pattern tests/workspace.test.ts
 *  clones from. A room's tree comes from THIS, so a live floor law can prove population without reaching
 *  GitHub. Returns the bare repo path (the room's `repo_url`) and the marker committed into it. */
function seedBareRepo(marker: string): { origin: string; marker: string } {
  const origin = mkdtempSync(join(tmpdir(), "room-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const seed = mkdtempSync(join(tmpdir(), "room-seed-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed]);
  writeFileSync(join(seed, "README.md"), marker);
  const g = (a: string[]): void => {
    execFileSync("git", ["-C", seed, ...a], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  };
  g(["add", "-A"]); g(["commit", "--quiet", "-m", "seed"]);
  g(["remote", "add", "origin", origin]); g(["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
  return { origin, marker };
}

/** The per-gig git-credential mint prepareWorkspace calls before cloning. A LOCAL bare-repo clone never
 *  offers the token (git challenges no local path), so any token satisfies the mint; stubbing it is what
 *  lets a live docker law populate a tree without a real credentials endpoint. Returns the sentinel token
 *  so a law can prove it never lands on the host filesystem. */
function stubGitCredential(token: string): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ token }), { status: 200 })));
}

/** A daemon is not enough: the room is realized ON `coltrane/room:ephemeral`, which is BUILT from
 *  Dockerfile.room and published nowhere. A host with docker but without that image sends compose to
 *  a registry, where the pull is denied — which is what a first CI run reported, correctly. So the
 *  gate is daemon AND image, and `.ci/room-image` builds it for the job that runs these. */
function roomRealizable(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", "coltrane/room:ephemeral"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const HAVE_DOCKER = roomRealizable();

/** The SEAT-BEARING floor laws gate on a SECOND image: `coltrane/floor:seat`, built from
 *  Dockerfile.floor. It is the toolchain-carrying opposite of the room image and, like the room
 *  image, is published nowhere — so the gate is daemon AND floor image, built by the `room` CI job
 *  alongside the room image. Without it these SKIP; they do not hollow-pass. The isolation and
 *  reclamation proofs below drive REAL containers (docker exec / docker inspect) and never invoke
 *  the agent binary, so they need no API key — the floor image only has to STAND UP with a per-gig
 *  workspace, which is exactly the property under test. */
function floorRealizable(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", "coltrane/floor:seat"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const HAVE_FLOOR = floorRealizable();

const NOTES_ROOM = {
  slug: "notes-room-v1",
  institution_slug: "quartet",
  equipment: { tools: ["mcp__notes__search"] },
  credential_surface: [],
  // The room service HOLDS with its own `sleep infinity` (renderComposeConfig, the `room` service),
  // a concern distinct from this server command. This command is what the chair docker-execs INTO the
  // held room — the emitted argv now derives from it — so it must name a process that actually serves
  // MCP: the compiled engine at the room image's WORKDIR. A `sleep infinity` here would make the chair
  // exec a non-server and the initialize/type_browse laws below would get no serverInfo.
  mcp_servers: [
    { slug: "notes", transport: "stdio" as const, command: ["node", "/app/dist/src/server_entry.js"], credential_names: [] },
  ],
  lifecycle: { policy: "ephemeral" as const },
};

const noCredentials = async () => ({});

/** A room that DECLARES a credential class, so delivery can be proven end to end. `notes-token` is a
 *  placeholder class (this repo is public); the resolver binds a KNOWN SENTINEL to it. */
const CREDENTIALED_ROOM = {
  slug: "credentialed-room-v1",
  institution_slug: "quartet",
  equipment: { tools: ["mcp__notes__search"] },
  credential_surface: ["notes-token"],
  mcp_servers: [
    { slug: "notes", transport: "stdio" as const, command: ["node", "/app/dist/src/server_entry.js"], credential_names: ["notes-token"] },
  ],
  lifecycle: { policy: "ephemeral" as const },
};

async function realizer() {
  return await import("../src/venue_realizer.js");
}

describe.skipIf(!HAVE_DOCKER)("a realized room is a place that exists", () => {
  it("the container the emitted config names is RUNNING, and answers MCP over that exact command", async () => {
    const { dockerComposeRealizer } = await realizer();
    // EACH live room law needs a DISTINCT compose project, or one leak poisons the next. The project
    // name derives from the gig id's FIRST 8 chars (gig-<id8>, venue_realizer.ts:910). "livelaw" is 7
    // chars, so every "livelaw0N-…" id collapses to the SAME slice "livelaw0" — all six rooms would
    // then share the project name coltrane-gig-livelaw0, and a container one test leaves standing
    // makes the next test's `compose create` fail with "name already in use". So the discriminating
    // digit sits AT index 7: "livelawN-…" → slice "livelawN", unique per test. Keep it that way.
    const gigId = "livelaw1-0000-0000-0000-000000000001";
    const handle = await dockerComposeRealizer().realize(NOTES_ROOM, noCredentials, { gigId });
    try {
      const cfg = handle.mcpServerConfigs["notes"] as { command: string; args: string[] };
      expect(cfg?.command, "the engine emits a transport for the declared server").toBe("docker");

      // The container named by the EMITTED config — not one this test chose — must be up. `docker
      // inspect` on a name nothing created exits non-zero, which is precisely the old behaviour.
      const named = cfg.args.find((a) => a.includes("room"));
      expect(named, "the emitted transport names a room container").toBeTruthy();
      const state = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", named!], { encoding: "utf8" });
      expect(state.status, `docker inspect ${named} — the room the config names must exist`).toBe(0);
      expect(state.stdout.trim(), "a room that has exited is one nothing can be exec'd into").toBe("running");

      // Run the engine's own emitted command VERBATIM and require coltrane to answer over it.
      const init = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "law", version: "1" } },
      });
      const spoke = spawnSync(cfg.command, cfg.args, { input: init + "\n", encoding: "utf8", timeout: 90_000 });
      expect(spoke.stdout, "the emitted transport carries a live MCP server").toContain("serverInfo");
    } finally {
      await handle.teardown();
    }
  }, 240_000);

  it("a chair in the room reaches a real genome — type_browse over the emitted transport answers >0 types", async () => {
    const { dockerComposeRealizer } = await realizer();
    const gigId = "livelaw3-0000-0000-0000-000000000003"; // distinct 8-char slice → own compose project
    const handle = await dockerComposeRealizer().realize(NOTES_ROOM, noCredentials, { gigId });
    try {
      const cfg = handle.mcpServerConfigs["notes"] as { command: string; args: string[] };
      expect(cfg?.command, "the engine emits a transport for the declared server").toBe("docker");

      // The room the emitted config names must be RUNNING first. A zero count below can only mean
      // "loaded an empty genome" — never "never reached the engine" — if the engine was demonstrably
      // reachable, so this and the serverInfo check below are the non-vacuity guard.
      const named = cfg.args.find((a) => a.includes("room"))!;
      const state = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", named], { encoding: "utf8" });
      expect(state.stdout.trim(), "the room must be running to be exec'd into").toBe("running");

      // Drive the EMITTED transport verbatim: initialize, the initialized notification, then a real
      // tools/call of type_browse. THE DURABLE DISCRIMINATOR IS THE PATH, NOT THE NUMBER. Before the
      // fix the room answered count:0 and the host answered 64; after it, both answer the same roster,
      // so a host-vs-room count gap evaporates with the defect it caught. What durably proves in-room
      // execution is that this call travels the `docker exec` invocation INTO the room — and count>0
      // proves the in-room engine loaded a real genome rather than the empty workspace.
      const send = (m: unknown): string => JSON.stringify(m);
      const input =
        [
          send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "law", version: "1" } } }),
          send({ jsonrpc: "2.0", method: "notifications/initialized" }),
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "type_browse", arguments: {} } }),
        ].join("\n") + "\n";
      const spoke = spawnSync(cfg.command, cfg.args, { input, encoding: "utf8", timeout: 90_000 });

      // NON-VACUITY: the engine answered initialize, so it was reached. A zero count therefore means
      // the in-room genome was empty — exactly the defect this law exists to catch — not a dead pipe.
      expect(spoke.stdout, "the emitted transport carries a live MCP server").toContain("serverInfo");

      // The tool result is wrapped as result.content[0].text holding {ok,...,data:{types,stats:{count}}}
      // (src/server.ts CallToolRequest handler); newline-delimited JSON-RPC, one message per line.
      type RpcReply = { id?: number; result?: { content?: Array<{ text?: string }> } };
      const messages = spoke.stdout
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l): RpcReply | undefined => { try { return JSON.parse(l) as RpcReply; } catch { return undefined; } })
        .filter((m): m is RpcReply => m !== undefined);
      const reply = messages.find((m) => m.id === 2 && m.result !== undefined);
      expect(reply, "the room answered the type_browse tools/call over the emitted transport").toBeTruthy();

      const text = reply!.result!.content?.[0]?.text ?? "";
      const payload = JSON.parse(text) as { data?: { stats?: { count?: number } } };
      const count = payload.data?.stats?.count;
      expect(
        typeof count === "number" ? count : -1,
        "an in-room engine on a real genome answers >0 types; the empty workspace answers 0 — this is the criterion that fails against the pre-fix code",
      ).toBeGreaterThan(0);
    } finally {
      await handle.teardown();
    }
  }, 240_000);

  // ★ THE DELIVERY GUARD. The host-filesystem laws (tests/spec_venue_realization.test.ts) prove the
  // credential is NOT readable from the host; this proves the fix did not close that exposure by
  // BREAKING delivery. Stand a room up with a declared credential class, confirm the room is running
  // (non-vacuity — a read from a dead container proves nothing), then read the material from INSIDE
  // the container. Delivery is now `docker cp` into the created-but-not-started room, not a compose
  // file-secret; this law fails if that copy stops landing a readable /run/secrets/<class>.
  //
  // Read via `docker exec cat /run/secrets/<class>` rather than an MCP tool: the motivating venue
  // ci-deploy-room-v1 carries no mcp_servers a tool-read could ride, so the file path is the general
  // channel. /run/secrets/<class> is where a compose file-secret landed and where the fix preserves
  // the copy, so a reader in the room is unchanged by the delivery move.
  it("a declared credential is delivered into the room and readable there — delivery survives the fix", async () => {
    const { dockerComposeRealizer } = await realizer();
    const gigId = "livelaw4-0000-0000-0000-000000000004"; // distinct 8-char slice → own compose project
    const SENTINEL = "live-credential-sentinel-9f3a7c";
    const resolve = async () => ({ "notes-token": SENTINEL });
    const handle = await dockerComposeRealizer().realize(CREDENTIALED_ROOM, resolve, { gigId });
    try {
      const cfg = handle.mcpServerConfigs["notes"] as { command: string; args: string[] };
      expect(cfg?.command, "the engine emits a transport for the declared server").toBe("docker");

      // NON-VACUITY: the room the emitted config names must be RUNNING first, or a failed read below
      // would pass for the wrong reason (a dead container reads nothing either).
      const room = cfg.args.find((a) => a.includes("room"))!;
      const state = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", room], { encoding: "utf8" });
      expect(state.stdout.trim(), "the room must be running to prove its credential is readable inside").toBe(
        "running",
      );

      // The material must be present and readable from INSIDE the container — the room reading its own
      // credential. Closing the host exposure by breaking delivery would fail exactly here.
      const read = spawnSync("docker", ["exec", room, "cat", "/run/secrets/notes-token"], { encoding: "utf8" });
      expect(read.status, "docker exec cat /run/secrets/notes-token — the credential must exist inside the room").toBe(
        0,
      );
      expect(read.stdout, "the room still reads its declared credential after the exposure is closed").toContain(
        SENTINEL,
      );
    } finally {
      await handle.teardown();
    }
  }, 240_000);

  it("teardown leaves nothing of the room behind", async () => {
    const { dockerComposeRealizer } = await realizer();
    const gigId = "livelaw2-0000-0000-0000-000000000002"; // distinct 8-char slice → own compose project
    const handle = await dockerComposeRealizer().realize(NOTES_ROOM, noCredentials, { gigId });
    const cfg = handle.mcpServerConfigs["notes"] as { command: string; args: string[] };
    const named = cfg.args.find((a) => a.includes("room"))!;
    // A room that never stood up would satisfy the assertion below for the wrong reason — "gone
    // after" is only meaningful against "there before". This guard is what stops that hollow pass.
    const before = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", named], { encoding: "utf8" });
    expect(before.stdout.trim(), "the room must be up BEFORE teardown for its absence after to mean anything").toBe("running");
    await handle.teardown();
    const after = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", named], { encoding: "utf8" });
    expect(after.status, `${named} must not survive teardown — an ephemeral room that outlives its gig is a leak`).not.toBe(0);
  }, 240_000);

  // ★ NOT ROOT. The workspace-ownership fix (src/venue_realizer.ts) pins the room's user to the
  // INVOKING uid:gid so the container owns its own bind-mounted workspace on Linux — direction (a).
  // Written FIRST so that override cannot silently select root: the running container's effective uid
  // must not be 0 whatever ownership approach ships. It is the invoking user's uid, which is the same
  // non-root user that owns the host workspace directory — that agreement is what lets the seat write.
  it("the room does NOT run as root — its effective uid is the non-root invoking user", async () => {
    const { dockerComposeRealizer } = await realizer();
    const gigId = "livelaw5-0000-0000-0000-000000000005"; // distinct 8-char slice → own compose project
    const handle = await dockerComposeRealizer().realize(NOTES_ROOM, noCredentials, { gigId });
    try {
      const cfg = handle.mcpServerConfigs["notes"] as { command: string; args: string[] };
      const room = cfg.args.find((a) => a.includes("room"))!;

      // NON-VACUITY: a dead container answers no uid, so its absence would prove nothing.
      const state = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", room], { encoding: "utf8" });
      expect(state.stdout.trim(), "the room must be running to read its effective uid").toBe("running");

      // `docker exec` with no -u runs as the container's CONFIGURED user, so `id -u` is exactly the uid
      // a seat exec'd into this room runs as. Root is never the answer here.
      const who = spawnSync("docker", ["exec", room, "id", "-u"], { encoding: "utf8" });
      expect(who.status, "docker exec id -u — the running room must answer its effective uid").toBe(0);
      const roomUid = who.stdout.trim();
      expect(roomUid, "the room must NOT run as root (uid 0) — whatever owns the workspace, root does not").not.toBe("0");

      // And it is the INVOKING user's uid: this proves direction (a) took effect (the container owns
      // its own bind mount), not merely that the image's default `node` uid happens to be non-zero.
      expect(roomUid, "the room runs as the invoking user, which owns its bind-mounted workspace").toBe(
        String(process.getuid?.()),
      );
    } finally {
      await handle.teardown();
    }
  }, 240_000);

  // ★ POSTURE UNCHANGED. The ownership fix moved the room's uid; it must not have widened anything
  // else. Asserted against the RUNNING container (docker inspect), because a rendered-document check
  // proves only what the document says — and a uid change is exactly the kind of edit that could
  // quietly regress posture where a document check would miss it. No runtime socket bound or mounted,
  // not privileged, no added capabilities, not on the host network.
  it("the room posture survives the ownership fix — no docker socket, not privileged, no cap_add, no host network", async () => {
    const { dockerComposeRealizer } = await realizer();
    const gigId = "livelaw6-0000-0000-0000-000000000006"; // distinct 8-char slice → own compose project
    const handle = await dockerComposeRealizer().realize(NOTES_ROOM, noCredentials, { gigId });
    try {
      const cfg = handle.mcpServerConfigs["notes"] as { command: string; args: string[] };
      const room = cfg.args.find((a) => a.includes("room"))!;

      const inspect = spawnSync("docker", ["inspect", room], { encoding: "utf8" });
      expect(inspect.status, "docker inspect — the room must exist to inspect its live posture").toBe(0);
      // docker inspect always emits a one-element array for a single ref; index-with-`!` rather than
      // destructure so the element narrows to defined (a bare `const [c]` is `T | undefined` under
      // noUncheckedIndexedAccess and every access below would be a compile error).
      const c = (JSON.parse(inspect.stdout) as Array<{
        HostConfig: { Binds?: string[] | null; Privileged?: boolean; CapAdd?: string[] | null; NetworkMode?: string };
        Mounts?: Array<{ Source?: string; Destination?: string }>;
      }>)[0]!;

      // No container-runtime socket anywhere it could be bound or mounted — the one-line escape.
      const socket = /docker\.sock|containerd\.sock|podman\.sock|\/var\/run\/docker/i;
      for (const b of c.HostConfig.Binds ?? []) {
        expect(socket.test(b), `no runtime socket may be bound into the room: ${b}`).toBe(false);
      }
      for (const m of c.Mounts ?? []) {
        expect(socket.test(`${m.Source ?? ""}:${m.Destination ?? ""}`), "no runtime socket may be mounted into the room").toBe(false);
      }

      // Not privileged, no added capabilities, not on the host network. `null` CapAdd is the default —
      // no capability was added — and normalizes to the empty set.
      expect(c.HostConfig.Privileged ?? false, "the room is not privileged").toBe(false);
      expect(c.HostConfig.CapAdd ?? [], "the room adds no capabilities").toEqual([]);
      expect(c.HostConfig.NetworkMode, "the room is not on the host network").not.toBe("host");
    } finally {
      await handle.teardown();
    }
  }, 240_000);
});

// ── THE SEAT RUNS INSIDE THE ROOM — CONCURRENCY, ISOLATION, RECLAMATION ─────────────────────────
//
// A seat-bearing floor (`floor: "seat"` → coltrane/floor:seat, Dockerfile.floor) is where the CHAIR
// itself runs. These are the laws the change exists for, and they are LIVE because a rendered
// document cannot prove that two seats do not share a working tree — only two real, concurrently
// standing rooms can.
const FLOOR_ROOM = {
  slug: "seat-room-v1",
  institution_slug: "quartet",
  equipment: { tools: ["mcp__notes__search"] },
  credential_surface: [],
  floor: "seat", // selects coltrane/floor:seat — the toolchain-carrying, seat-bearing image
  mcp_servers: [
    { slug: "notes", transport: "stdio" as const, command: ["node", "/app/dist/src/server_entry.js"], credential_names: [] },
  ],
  lifecycle: { policy: "ephemeral" as const },
};

describe.skipIf(!HAVE_FLOOR)("two concurrent gigs get their own room — the seat's cwd is isolated by construction", () => {
  it("two gigs realized CONCURRENTLY do not share a working directory, and reclamation is the venue's job", async () => {
    // ★ WHY THIS FAILS AGAINST CURRENT (pre-change) CODE. Before this change no seat entered the
    // room: every chair spawned on the HOST with no cwd (src/claude_invoker.ts spawn had no `cwd`),
    // so both seats' working directory resolved to the host repository root — ONE shared tree, which
    // is exactly the corruption measured when two gigs dispatched at once. There was also no
    // `handle.seat` descriptor at all, so `handle.seat.workspace` below is `undefined` for both gigs
    // and the distinct-workspace assertion cannot hold. After the change each floored room carries
    // its own per-realization workspace as the seat's cwd, so the two are disjoint by construction.
    const { dockerComposeRealizer } = await realizer();
    // The realization directory is derived from the gig id's FIRST 8 chars (gig-<id8>), so the two
    // ids must differ there or both rooms would collide on one directory — which would defeat the
    // very isolation under test. These differ from the first character.
    const gigA = "aaaa1111-0000-0000-0000-00000000aaaa";
    const gigB = "bbbb2222-0000-0000-0000-00000000bbbb";
    const realizer0 = dockerComposeRealizer();

    // CONCURRENTLY — both rooms stand up at once, the very condition that corrupted one shared tree.
    const [handleA, handleB] = await Promise.all([
      realizer0.realize(FLOOR_ROOM, noCredentials, { gigId: gigA }),
      realizer0.realize(FLOOR_ROOM, noCredentials, { gigId: gigB }),
    ]);

    try {
      // The seat descriptor is present ONLY for a seat-bearing floor, and names each room's own
      // container + workspace. Absent (or equal) is the pre-change failure.
      expect(handleA.seat, "a floored room carries a seat descriptor — the seat runs IN the room").toBeTruthy();
      expect(handleB.seat, "a floored room carries a seat descriptor — the seat runs IN the room").toBeTruthy();
      expect(handleA.seat!.workspace, "each gig's seat cwd is its OWN workspace, never one shared tree").not.toBe(
        handleB.seat!.workspace,
      );
      expect(handleA.seat!.container, "each gig runs in its OWN room container").not.toBe(handleB.seat!.container);

      // Both rooms must be RUNNING for the cross-read proof to mean anything (a dead container reads
      // nothing, which would pass the isolation assertion for the wrong reason).
      for (const c of [handleA.seat!.container, handleB.seat!.container]) {
        const state = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", c], { encoding: "utf8" });
        expect(state.stdout.trim(), `${c} must be running`).toBe("running");
      }

      // NEITHER SEAT CAN OBSERVE OR OVERWRITE THE OTHER'S TREE. Write a marker into gig A's workspace
      // from INSIDE room A; it must be invisible in gig B's workspace from inside room B. Two distinct
      // host realization dirs bind-mounted into two distinct rooms make this true by construction —
      // which is the whole point of moving the seat into the room.
      const marker = `${handleA.seat!.workspace}/marker-A`;
      const wrote = spawnSync("docker", ["exec", handleA.seat!.container, "sh", "-c", `echo gigA > ${marker}`], { encoding: "utf8" });
      expect(wrote.status, "room A can write into its own workspace").toBe(0);

      const seenInA = spawnSync("docker", ["exec", handleA.seat!.container, "sh", "-c", `cat ${marker}`], { encoding: "utf8" });
      expect(seenInA.stdout.trim(), "room A observes its own write").toBe("gigA");

      // Room B, reading the SAME absolute path inside ITS OWN workspace mount, sees nothing.
      const markerInB = `${handleB.seat!.workspace}/marker-A`;
      const seenInB = spawnSync("docker", ["exec", handleB.seat!.container, "sh", "-c", `cat ${markerInB} 2>/dev/null || echo ABSENT`], { encoding: "utf8" });
      expect(seenInB.stdout.trim(), "room B cannot observe room A's write — the trees are disjoint").toBe("ABSENT");
    } finally {
      await handleA.teardown();
      await handleB.teardown();
    }

    // RECLAMATION IS THE VENUE'S JOB, NOT AN OPERATOR'S. After both gigs end, no container, no
    // network, and no realization directory the change created may survive — the ephemeral lifecycle
    // reaps what it stood up. This is the property the hand-rolled worktrees never had: nobody had to
    // remember to prune anything.
    for (const c of [handleA.seat!.container, handleB.seat!.container]) {
      const after = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", c], { encoding: "utf8" });
      expect(after.status, `${c} must not survive teardown — an ephemeral room that outlives its gig is a leak`).not.toBe(0);
    }
    // No realization directory left behind for either gig (they live under tmpdir/coltrane-realizations).
    for (const h of [handleA, handleB]) {
      expect(existsSync(h.seat!.workspace), `no realization workspace may survive teardown: ${h.seat!.workspace}`).toBe(false);
    }
  }, 300_000);
});

// ── THE ROOM'S WORKSPACE IS POPULATED WITH A WORKING TREE ────────────────────────────────────────
//
// The concurrent law above proves TWO EMPTY workspaces are disjoint. These prove the join this change
// exists for: a realized room's workspace CONTAINS a working tree, cloned from the venue's declared
// `repo_url` through the SAME prepareWorkspace the drain uses — so a seat inside the room has a
// repository to edit, and two populated rooms are still disjoint. LIVE, because only a real container
// with a real bind-mounted clone can show a seat reading a repository file at its cwd.
//
// A floored venue that ALSO declares repo_url. The bare repo path is per-test (mkdtempSync), so the
// venue is built inside each law rather than shared here.
function flooredRepoRoom(slug: string, repoUrl: string): unknown {
  return {
    slug,
    institution_slug: "quartet",
    equipment: { tools: ["mcp__notes__search"] },
    credential_surface: [],
    floor: "seat",
    repo_url: repoUrl,
    mcp_servers: [
      { slug: "notes", transport: "stdio" as const, command: ["node", "/app/dist/src/server_entry.js"], credential_names: [] },
    ],
    lifecycle: { policy: "ephemeral" as const },
  };
}

describe.skipIf(!HAVE_FLOOR)("a realized room's workspace contains a working tree", () => {
  // ★ LAW (a): WORKING TREE IN THE ROOM. FAILS AGAINST CURRENT (pre-change) CODE. Before this join the
  // workspace was an empty `mkdirSync(join(realizationDir, "workspace"))` in venue_realizer.ts and
  // nothing else — no repository file existed at the seat's cwd, so the `cat README.md` below exits
  // non-zero and this law is RED. The populate branch (prepareWorkspace clones into that same
  // workspace) makes it GREEN. This is intentional per stop-condition (a): the law must fail against
  // the empty mkdir.
  it("a seat exec'd into the room reads a repository file at its cwd — the tree is populated", async () => {
    const { dockerComposeRealizer } = await realizer();
    const { origin, marker } = seedBareRepo("hello-from-the-cloned-tree-a1");
    stubGitCredential("ghs_room_token_a");
    const gigId = "treelawa-0000-0000-0000-00000000000a"; // distinct 8-char slice → own compose project
    const handle = await dockerComposeRealizer().realize(flooredRepoRoom("tree-room-a", origin), noCredentials, {
      gigId, repoUrl: origin, drainKey: "dk", instance: "box", gitCredentialsEndpoint: "https://x/api",
    });
    try {
      expect(handle.seat, "a floored room carries a seat descriptor — the seat runs IN the room").toBeTruthy();

      // NON-VACUITY: the room must be RUNNING, or a failed read below would pass for the wrong reason.
      const state = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", handle.seat!.container], { encoding: "utf8" });
      expect(state.stdout.trim(), "the room must be running to exec a seat into it").toBe("running");

      // The seat's cwd IS handle.seat.workspace, and the clone landed THERE — so the committed file is
      // present at the seat's working directory. Pre-change (empty mkdir) this file does not exist.
      const read = spawnSync(
        "docker",
        ["exec", "-w", handle.seat!.workspace, handle.seat!.container, "cat", "README.md"],
        { encoding: "utf8" },
      );
      expect(read.status, "docker exec cat README.md at the seat's cwd — the workspace must contain the tree").toBe(0);
      expect(read.stdout, "the seat reads the repository file from its own populated working tree").toContain(marker);
    } finally {
      await handle.teardown();
    }
  }, 300_000);

  // ★ LAW (d), POPULATED VARIANT: ISOLATION SURVIVES POPULATION. The empty-workspace isolation law
  // above (":two concurrent gigs…") stays as-is and GREEN; this extends it onto CLONED trees — two
  // rooms realized concurrently, each from its own repo_url, each get their OWN populated clone, and a
  // write in room A's tree is invisible in room B's. The disjointness marker is now a file FROM the
  // cloned tree (README.md), not a bare docker-exec touch. RED before the change: both workspaces were
  // empty, so there was no cloned tree to prove disjoint population.
  it("two rooms realized concurrently get DISJOINT populated trees — a write in one is invisible in the other", async () => {
    const { dockerComposeRealizer } = await realizer();
    const a = seedBareRepo("tree-A-original");
    const b = seedBareRepo("tree-B-original");
    stubGitCredential("ghs_room_token_d");
    const gigA = "treeda11-0000-0000-0000-0000000000da";
    const gigB = "treedb22-0000-0000-0000-0000000000db";
    const realizer0 = dockerComposeRealizer();

    // CONCURRENTLY — the condition that corrupted one shared tree when both seats resolved to the host.
    const [handleA, handleB] = await Promise.all([
      realizer0.realize(flooredRepoRoom("tree-room-da", a.origin), noCredentials, {
        gigId: gigA, repoUrl: a.origin, drainKey: "dk", instance: "box", gitCredentialsEndpoint: "https://x/api",
      }),
      realizer0.realize(flooredRepoRoom("tree-room-db", b.origin), noCredentials, {
        gigId: gigB, repoUrl: b.origin, drainKey: "dk", instance: "box", gitCredentialsEndpoint: "https://x/api",
      }),
    ]);
    try {
      expect(handleA.seat!.workspace, "each gig's seat cwd is its OWN workspace").not.toBe(handleB.seat!.workspace);

      for (const c of [handleA.seat!.container, handleB.seat!.container]) {
        const state = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", c], { encoding: "utf8" });
        expect(state.stdout.trim(), `${c} must be running`).toBe("running");
      }

      // Both trees are POPULATED: each carries the file cloned from its OWN source, not the other's.
      const readAOrig = spawnSync("docker", ["exec", handleA.seat!.container, "cat", `${handleA.seat!.workspace}/README.md`], { encoding: "utf8" });
      expect(readAOrig.stdout, "room A holds the tree cloned from A's source").toContain("tree-A-original");
      const readBOrig = spawnSync("docker", ["exec", handleB.seat!.container, "cat", `${handleB.seat!.workspace}/README.md`], { encoding: "utf8" });
      expect(readBOrig.stdout, "room B holds the tree cloned from B's source").toContain("tree-B-original");

      // A write into A's cloned tree, from inside room A, must be invisible in B's cloned tree.
      const wrote = spawnSync(
        "docker",
        ["exec", handleA.seat!.container, "sh", "-c", `echo tree-A-mutated > ${handleA.seat!.workspace}/README.md`],
        { encoding: "utf8" },
      );
      expect(wrote.status, "room A can write into its own populated tree").toBe(0);

      const seenInA = spawnSync("docker", ["exec", handleA.seat!.container, "cat", `${handleA.seat!.workspace}/README.md`], { encoding: "utf8" });
      expect(seenInA.stdout.trim(), "room A observes its own write").toBe("tree-A-mutated");

      const seenInB = spawnSync("docker", ["exec", handleB.seat!.container, "cat", `${handleB.seat!.workspace}/README.md`], { encoding: "utf8" });
      expect(seenInB.stdout.trim(), "room B cannot observe room A's write — the populated trees are disjoint").toBe(
        "tree-B-original",
      );
    } finally {
      await handleA.teardown();
      await handleB.teardown();
    }
  }, 300_000);

  // ★ LAW (e): ROOM POSTURE + NO HOST CREDENTIAL, ON A POPULATED ROOM. The posture must not have
  // widened because a tree was cloned in, AND the git credential minted for population must never land
  // on the host filesystem — the token rides cloneInto's GIT_CONFIG_* env, never .git/config and never
  // a host staging file. Inert before the change (no token was minted); it gains teeth once population
  // mints one via prepareWorkspace.
  it("a populated room keeps the closed posture, and the populate credential is nowhere on the host", async () => {
    const { dockerComposeRealizer } = await realizer();
    const { origin } = seedBareRepo("posture-tree");
    const SENTINEL = "ghs_populate_sentinel_e5f00d";
    stubGitCredential(SENTINEL);
    const gigId = "treelawe-0000-0000-0000-00000000000e";
    const handle = await dockerComposeRealizer().realize(flooredRepoRoom("tree-room-e", origin), noCredentials, {
      gigId, repoUrl: origin, drainKey: "dk", instance: "box", gitCredentialsEndpoint: "https://x/api",
    });
    try {
      const room = handle.seat!.container;

      // NON-VACUITY: the room must exist to inspect its live posture.
      const inspect = spawnSync("docker", ["inspect", room], { encoding: "utf8" });
      expect(inspect.status, "docker inspect — the populated room must exist to inspect its posture").toBe(0);
      const c = (JSON.parse(inspect.stdout) as Array<{
        HostConfig: { Binds?: string[] | null; Privileged?: boolean; CapAdd?: string[] | null; NetworkMode?: string };
        Mounts?: Array<{ Source?: string; Destination?: string }>;
      }>)[0]!;

      const socket = /docker\.sock|containerd\.sock|podman\.sock|\/var\/run\/docker/i;
      for (const bind of c.HostConfig.Binds ?? []) {
        expect(socket.test(bind), `no runtime socket may be bound into the populated room: ${bind}`).toBe(false);
      }
      for (const m of c.Mounts ?? []) {
        expect(socket.test(`${m.Source ?? ""}:${m.Destination ?? ""}`), "no runtime socket may be mounted into the populated room").toBe(false);
      }
      expect(c.HostConfig.Privileged ?? false, "the populated room is not privileged").toBe(false);
      expect(c.HostConfig.CapAdd ?? [], "the populated room adds no capabilities").toEqual([]);
      expect(c.HostConfig.NetworkMode, "the populated room is not on the host network").not.toBe("host");

      // Not root — the seat runs as the invoking user, which owns the cloned bind mount.
      const who = spawnSync("docker", ["exec", room, "id", "-u"], { encoding: "utf8" });
      expect(who.stdout.trim(), "the populated room must NOT run as root").not.toBe("0");

      // ★ THE CREDENTIAL IS NOWHERE ON THE HOST. cloneInto passes the token only through GIT_CONFIG_*,
      // so it is not written into the clone's .git/config, and no host staging file holds it.
      const gitConfig = readFileSync(join(handle.seat!.workspace, ".git", "config"), "utf8");
      expect(gitConfig, "the populate token must not be written into the clone's .git/config").not.toContain(SENTINEL);
      expect(gitConfig, "no credential helper naming the token survives into the tree").not.toContain("x-access-token");

      // And nothing under the whole realization directory holds it either — no host-side staging leak.
      const grep = spawnSync("grep", ["-rl", SENTINEL, join(handle.seat!.workspace, "..")], { encoding: "utf8" });
      expect(grep.stdout.trim(), "the populate token must not persist anywhere under the realization directory").toBe("");
    } finally {
      await handle.teardown();
    }
  }, 300_000);
});
