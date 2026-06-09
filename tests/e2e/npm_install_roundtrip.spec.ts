// e2e: the install-and-boot roundtrip — proves @eir-dev/coltrane works when
// imported downstream the way a real consumer installs it (issue #144 / #147 axis).
//
// The unit gates (tests/pack_*_audit, tests/npm_publish_metadata) assert the
// tarball's SHAPE via `npm pack --dry-run`. This spec closes the loop they can't:
// it actually packs, `npm install`s the tarball into a fresh project, boots the
// installed `coltrane-server` bin, and speaks MCP to it. If server_entry.js or
// the bin wiring regresses, the dry-run gates stay green — only this catches it.
//
// GREEN-expected: it codifies behavior already proven by hand. It is a regression
// guard, not a discovery gate.
//
// Cost: this is a real `npm install` (resolves deps from the registry) + a build,
// so it lives in the e2e suite (`npm run e2e`), not the fast unit gate. Requires
// network + registry access.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// The bin target inside the installed package — what node_modules/.bin/coltrane-server
// resolves to, and what we boot.
const INSTALLED_PKG_REL = join("node_modules", "@eir-dev", "coltrane");
const BIN_TARGET_REL = join(INSTALLED_PKG_REL, "dist", "src", "server_entry.js");

let project = ""; // fresh downstream project dir
let packDir = ""; // where the .tgz is dropped

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: { serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> };
}

/**
 * Boot the installed bin in direct mode, write a JSON-RPC `initialize`, and
 * resolve with the first response message (id === 1). Kills the server once it
 * has answered (an MCP stdio server otherwise runs forever waiting on stdin).
 */
function bootAndInitialize(genomeRoot: string): Promise<{ response: JsonRpcResponse; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(project, BIN_TARGET_REL)], {
      cwd: project,
      env: { ...process.env, COLTRANE_SERVER_DIRECT: "1", COLTRANE_GENOME: genomeRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`boot timed out; stderr:\n${stderr}`));
    }, 20_000);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const msg = JSON.parse(t) as JsonRpcResponse;
          if (msg.id === 1) {
            clearTimeout(timer);
            child.kill("SIGKILL");
            resolve({ response: msg, stderr });
            return;
          }
        } catch {
          // partial line; keep accumulating
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    const req = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e-roundtrip", version: "0" },
      },
    };
    child.stdin.write(JSON.stringify(req) + "\n");
  });
}

/** Boot in direct mode with a bad genome and resolve with the exit code + stderr. */
function bootExpectingFailure(genomeRoot: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(project, BIN_TARGET_REL)], {
      cwd: project,
      env: { ...process.env, COLTRANE_SERVER_DIRECT: "1", COLTRANE_GENOME: genomeRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`expected fast fail-closed, but it hung; stderr:\n${stderr}`));
    }, 20_000);
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

describe("e2e: npm install roundtrip — engine imports + boots downstream", () => {
  beforeAll(() => {
    // Build first so the tarball reflects current src (the tarball ships dist/src).
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "ignore" });

    // Pack into a temp dir (never the working tree).
    packDir = mkdtempSync(join(tmpdir(), "coltrane-pack-"));
    const tgzName = execFileSync("npm", ["pack", "--pack-destination", packDir], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .pop()!;
    const tgz = join(packDir, tgzName);

    // Fresh downstream project; install the tarball as a real consumer would.
    project = mkdtempSync(join(tmpdir(), "coltrane-consumer-"));
    execFileSync("npm", ["init", "-y"], { cwd: project, stdio: "ignore" });
    execFileSync("npm", ["install", tgz, "--no-audit", "--no-fund", "--prefer-offline"], {
      cwd: project,
      stdio: "ignore",
    });
  }, 600_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
    if (packDir) rmSync(packDir, { recursive: true, force: true });
  });

  it("installs a coltrane-server bin symlink that resolves to the server entry", () => {
    const binLink = join(project, "node_modules", ".bin", "coltrane-server");
    expect(existsSync(binLink), "bin symlink not created by npm install").toBe(true);
    // The link points (relatively) at the package's dist/src/server_entry.js.
    expect(readlinkSync(binLink)).toMatch(/dist\/src\/server_entry\.js$/);
    expect(existsSync(join(project, BIN_TARGET_REL)), "bin target missing post-install").toBe(true);
  });

  it("ships a complete reference genome (6 core types) inside the package", () => {
    const coreDir = join(project, INSTALLED_PKG_REL, "core_types");
    for (const slug of ["signal", "interpretation", "judgment", "plan", "artifact", "verdict"]) {
      expect(existsSync(join(coreDir, `${slug}.json`)), `core_types/${slug}.json did not ship`).toBe(true);
    }
  });

  it("boots the installed server and answers an MCP initialize handshake", async () => {
    const bundledGenome = join(project, INSTALLED_PKG_REL);
    const { response, stderr } = await bootAndInitialize(bundledGenome);
    expect(stderr, `server logged to stderr during boot:\n${stderr}`).not.toMatch(/failed to start|Error/);
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result?.serverInfo?.name).toBe("coltrane");
    expect(response.result?.capabilities).toBeTypeOf("object");
  });

  it("fails closed when pointed at a genome with no core types", async () => {
    const emptyGenome = mkdtempSync(join(tmpdir(), "coltrane-empty-genome-"));
    try {
      const { code, stderr } = await bootExpectingFailure(emptyGenome);
      expect(code, "expected a non-zero exit when the genome is incomplete").not.toBe(0);
      expect(stderr).toMatch(/GenomeLoadError/);
      // names the missing required slugs so the operator knows what's wrong
      expect(stderr).toMatch(/Signal/);
      expect(stderr).toMatch(/Verdict/);
    } finally {
      rmSync(emptyGenome, { recursive: true, force: true });
    }
  });
});
