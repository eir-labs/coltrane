// THE ROOM IMAGES CARRY EVERY RUNTIME DEPENDENCY OF THE ENGINE THEY RUN.
//
// `ignore` became a PRODUCTION dependency in round 5 (src/grant_scope.ts uses the CLI's own matcher).
// The room images are built from this tree with `npm ci --omit=dev`, but an image built BEFORE that
// change still runs — it simply has no `ignore`, and every seat-bearing room built from it fails the
// first time the engine inside it resolves a grant. The room laws never noticed, because none of them
// import the grant path. Measured 27 Sep 2026 on the drafter's host: both `coltrane/room:ephemeral` and
// `coltrane/floor:seat` (built ~3h earlier) had no /app/node_modules/ignore.
//
// So, for each room image present on this host, this law runs the image's own node and checks:
//   · the image's /app/package.json declares exactly this tree's runtime `dependencies` (it was built
//     from this manifest, not an older one);
//   · every one of them is installed under /app/node_modules, at the pinned version where the pin is
//     exact;
//   · the engine's grant matcher — the module that needs `ignore` — actually LOADS in the image.
// It runs only where Docker is up and the image exists (the room band's CI job builds
// coltrane/room:ephemeral first); otherwise it is SKIPPED and printed as UNVERIFIED, never a pass.
//
// Delegated to the room band (tests/venue_live/vitest.config.ts), like spec_venue_room_live: it runs
// real containers.
//
//   law                                           kind         drives                                    plant
//   the image declares this tree's runtime deps   behavioural  the built image (Dockerfile.room / .floor)  build the image from a manifest that predates a
//                                                                                                          runtime dependency (the stale images on this host)
//   every runtime dep is installed (exact pins)   behavioural  same                                      `npm ci --omit=dev` with `ignore` left in devDependencies
//   the grant matcher loads inside the image      behavioural  same (dist/src/grant_scope.js)             drop node_modules/ignore from the image
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEPS = (JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")) as { dependencies: Record<string, string> }).dependencies;

function dockerUp(): boolean {
  try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }); return true; } catch { return false; }
}
function imagePresent(img: string): boolean {
  return spawnSync("docker", ["image", "inspect", img], { stdio: "ignore", timeout: 15_000 }).status === 0;
}
const DOCKER = dockerUp();
const IMAGES = ["coltrane/room:ephemeral", "coltrane/floor:seat"];

const PROBE = `
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("/app/package.json", "utf8"));
const installed = {};
for (const d of Object.keys(${JSON.stringify(DEPS)})) {
  try { installed[d] = JSON.parse(fs.readFileSync("/app/node_modules/" + d + "/package.json", "utf8")).version; } catch { installed[d] = null; }
}
import("/app/dist/src/grant_scope.js").then(
  (m) => console.log(JSON.stringify({ declared: p.dependencies, installed, matcherLoads: typeof m.grantCovers === "function" && m.grantCovers("**", ".git/config") === true })),
  (e) => console.log(JSON.stringify({ declared: p.dependencies, installed, matcherLoads: false, error: String(e && e.message || e).slice(0, 300) })),
);`;

describe("the room images carry every runtime dependency of the engine (skipped as UNVERIFIED without Docker or the image)", () => {
  for (const img of IMAGES) {
    const why = !DOCKER ? "Docker is not running" : !imagePresent(img) ? `the image ${img} is not built on this host` : "";
    if (why) console.warn(`[UNVERIFIED] spec_room_image_carries_runtime_deps (${img}): SKIPPED — ${why}.`);
    it.skipIf(Boolean(why))(`${img}: declares this tree's runtime dependencies, installs each (exact pins exact), and the grant matcher loads`, () => {
      const out = execFileSync("docker", ["run", "--rm", "--entrypoint", "node", img, "-e", PROBE], { encoding: "utf8", timeout: 120_000 });
      const r = JSON.parse(out.trim().split("\n").pop()!) as { declared: Record<string, string>; installed: Record<string, string | null>; matcherLoads: boolean; error?: string };
      expect(r.declared, `${img} was built from a manifest whose runtime dependencies differ from this tree's — rebuild it`).toEqual(DEPS);
      const missing = Object.keys(DEPS).filter((d) => r.installed[d] === null);
      expect(missing, `${img} is missing runtime dependencies [${missing.join(", ")}] — the engine inside it cannot run`).toEqual([]);
      for (const [d, want] of Object.entries(DEPS)) {
        if (/^\d+\.\d+\.\d+$/.test(want)) expect(r.installed[d], `${img} installs ${d}@${r.installed[d]}, but the engine pins ${want} exactly`).toBe(want);
      }
      expect(r.matcherLoads, `the engine's grant matcher does not load inside ${img}: ${r.error ?? "grantCovers misbehaved"}`).toBe(true);
    }, 180_000);
  }
});
