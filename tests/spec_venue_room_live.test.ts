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
  // The room holds; this server is exec'd into it. Its command never runs as the service's own
  // process under the docker-exec topology, so `sleep infinity` is the honest placeholder.
  mcp_servers: [
    { slug: "notes", transport: "stdio" as const, command: ["sleep", "infinity"], credential_names: [] },
  ],
  lifecycle: { policy: "ephemeral" as const },
};

const noCredentials = async () => ({});

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
