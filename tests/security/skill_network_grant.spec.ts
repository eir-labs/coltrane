// The skill network grant — a capability band, not a unit band.
//
// These laws stand up a LOCAL HTTP server and have a sandboxed skill fetch it, which is the only
// honest way to prove a network gate: the flag is Node's, the allowlist is the runner's, and neither
// can be observed without a real request. That also puts them outside the root unit suite by
// construction — `suite_reaches_no_remote.test.ts` forbids a network module or a call site there,
// and rightly: a unit suite that reaches out is how a green run posts 428 requests to a real service.
// The security band has its own network posture, so they live here.
//
// Two mechanics worth keeping in mind before adding to this file:
//   - executeSkillAsync, never executeSkill. The sync path is spawnSync and blocks the parent's event
//     loop for the child's whole timeout, so a server in THIS process can never answer the child and
//     every law times out at 120s.
//   - The gate is Node 24+. On an older runtime there is no network permission at all, so an
//     ungranted skill reaches out and the law says so rather than asserting a denial the runtime
//     cannot make — the same fact the loader acts on when it declines to admit such a grant.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSkillAsync, tierFlags } from "../../src/skill_subprocess.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "net-grant-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function skill(body: string, tier = 0, network?: { allow: string[]; methods?: string[]; max_requests?: number; max_bytes?: number }): string {
  const dir = join(root, `s${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({
    slug: "probe", version: 1, skill_type: "deterministic",
    input_type: "note", output_type: "note",
    permission: network ? { tier, network } : { tier }, description: "probe", determinism_ratio: 1,
  }));
  writeFileSync(join(dir, "skill.mjs"), body);
  return dir;
}

function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0] ?? 0);
}

/** A local HTTP server, so these laws prove the GATE rather than the runner's internet access.
 *  These laws use executeSkillAsync, not executeSkill: the sync path is spawnSync, which blocks the
 *  parent's event loop for the child's whole timeout — so the server in THIS process could never
 *  answer the child's request and every such law timed out at 120s.
 *  `verify` runs offline; a law that reaches example.com fails there for a reason that has nothing
 *  to do with what it is testing. Loopback is also the honest shape: the grant's allowlist is about
 *  which host, not which network. */
async function localServer(bodyBytes = 4): Promise<{ url: string; host: string; close: () => void }> {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(bodyBytes));
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}/`, host: "127.0.0.1", close: () => srv.close() };
}

describe("the network is a declared capability", () => {
  // The previous release stated a gap honestly: Node's permission model had no network flag, so a
  // skill could reach out and the source said so rather than promising otherwise. Node 24 added
  // --allow-net, and the gap closed — measured, not assumed: every URL in a landscape run came
  // back ERR_ACCESS_DENIED until the flag was passed. So the grant that was already in the schema
  // and read by nothing (SkillPermissionSchema.network) is now what decides.
  const FETCH = `export default async function run(input) {
    try { const r = await fetch(input.url, input.init); return { status: r.status }; }
    catch (e) { return { error: String(e.message) }; }
  }`;

  it("lets a granted skill reach a host its allow list names, and refuses one it does not", async () => {
    const srv = await localServer();
    try {
      const dir = skill(FETCH, 0, { allow: [srv.host] });
      const allowed = (await executeSkillAsync(dir, { url: srv.url }, 30000, {})).output as { status?: number };
      expect(allowed.status).toBe(200);
      const refused = (await executeSkillAsync(dir, { url: "http://127.0.0.2:1/" }, 30000, {})).output as { error?: string };
      expect(String(refused.error)).toContain("network grant refuses");
    } finally {
      srv.close();
    }
  });

  it("refuses a method the grant does not name", async () => {
    const srv = await localServer();
    try {
      const dir = skill(FETCH, 0, { allow: [srv.host], methods: ["GET"] });
      const out = (await executeSkillAsync(dir, { url: srv.url, init: { method: "POST" } }, 30000, {})).output as { error?: string };
      expect(String(out.error)).toContain("refuses method POST");
    } finally {
      srv.close();
    }
  });

  it("refuses past max_requests", async () => {
    const srv = await localServer();
    try {
      const body = `export default async function run(input) {
        const seen = [];
        for (let i = 0; i < 3; i++) {
          try { const r = await fetch(input.url); seen.push(String(r.status)); }
          catch (e) { seen.push(String(e.message)); }
        }
        return { seen };
      }`;
      const dir = skill(body, 0, { allow: [srv.host], max_requests: 2 });
      const out = (await executeSkillAsync(dir, { url: srv.url }, 30000, {})).output as { seen?: string[] };
      expect(out.seen?.[0]).toBe("200");
      expect(String(out.seen?.[2])).toContain("max_requests=2");
    } finally {
      srv.close();
    }
  });

  // One law per reader: a law that only exercises text() passes while the bound leaks through
  // blob() or body, which is exactly how three of six readers went unwrapped.
  for (const reader of ["blob", "bytes", "arrayBuffer", "text"]) {
    it(`refuses a body larger than max_bytes via ${reader}()`, async () => {
      const srv = await localServer(64);
      try {
        const body = `export default async function run(input) {
          const r = await fetch(input.url);
          try { const v = await r.${reader}(); return { got: v?.size ?? v?.byteLength ?? v?.length ?? 0 }; }
          catch (e) { return { error: String(e.message) }; }
        }`;
        const out = (await executeSkillAsync(skill(body, 0, { allow: [srv.host], max_bytes: 10 }), { url: srv.url }, 30000, {}))
          .output as { error?: string; got?: number };
        expect(out.got).toBeUndefined();
        expect(String(out.error)).toContain("max_bytes=10");
      } finally {
        srv.close();
      }
    });
  }

  it("counts res.body as the stream flows and refuses past max_bytes", async () => {
    const srv = await localServer(64);
    try {
      const body = `export default async function run(input) {
        const r = await fetch(input.url);
        try {
          let n = 0;
          for await (const chunk of r.body) n += chunk.byteLength;
          return { got: n };
        } catch (e) { return { error: String(e.message) }; }
      }`;
      const out = (await executeSkillAsync(skill(body, 0, { allow: [srv.host], max_bytes: 10 }), { url: srv.url }, 30000, {}))
        .output as { error?: string; got?: number };
      expect(out.got).toBeUndefined();
      expect(String(out.error)).toContain("max_bytes=10");
    } finally {
      srv.close();
    }
  });

  it("denies fetch to a skill with no grant — on a runtime that has the gate", async () => {
    // The gate is Node's, not ours: --allow-net exists from Node 24. On an older runtime there is no
    // network permission at all, so an ungranted skill reaches the network and this law says so
    // rather than asserting a denial the runtime cannot make. That is the same fact the loader acts
    // on when it refuses to admit a skill whose grant such a runtime cannot back.
    const srv = await localServer();
    try {
      const out = (await executeSkillAsync(skill(FETCH, 0), { url: srv.url }, 30000, {})).output as { status?: number; error?: string };
      if (nodeMajor() >= 24) {
        expect(out.status).toBeUndefined();
        expect(String(out.error)).toMatch(/fetch failed|ERR_ACCESS_DENIED/);
      } else {
        expect(out.status).toBe(200); // documented: this runtime cannot deny it
      }
    } finally {
      srv.close();
    }
  });
});
