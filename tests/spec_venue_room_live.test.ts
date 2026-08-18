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
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";

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
    const gigId = "livelaw01-0000-0000-0000-000000000001";
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
    const gigId = "livelaw03-0000-0000-0000-000000000003";
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
    const gigId = "livelaw04-0000-0000-0000-000000000004";
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
    const gigId = "livelaw02-0000-0000-0000-000000000002";
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
});
