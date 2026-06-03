// scaffold contract tests — verify manifest YAML structure, env template
// slots, and per-steve dir materialization.

import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STEVE_COUNT,
  PRIMITIVES,
  makeSteveSeed,
  renderSlackManifest,
  renderEnvTemplate,
  materializeScaffold,
  renderSetupInstructions,
} from "../src/live/scaffold.js";

describe("renderSlackManifest", () => {
  const yaml = renderSlackManifest();

  it("declares socket mode enabled", () => {
    expect(yaml).toContain("socket_mode_enabled: true");
  });

  it("lists all 7 required bot scopes", () => {
    const required = [
      "app_mentions:read",
      "channels:history",
      "channels:read",
      "chat:write",
      "im:history",
      "reactions:read",
      "reactions:write",
    ];
    for (const scope of required) {
      expect(yaml).toContain(scope);
    }
  });

  it("subscribes to the 5 bot events we need", () => {
    const required = [
      "app_mention",
      "message.channels",
      "message.im",
      "reaction_added",
      "reaction_removed",
    ];
    for (const ev of required) {
      expect(yaml).toContain(ev);
    }
  });

  it("declares a single app (one bot_user block)", () => {
    const matches = yaml.match(/^\s*bot_user:/gm) ?? [];
    expect(matches).toHaveLength(1);
  });
});

describe("renderEnvTemplate", () => {
  const env = renderEnvTemplate();

  it("names ONE shared bot+app token pair (4 Steves share one slack app)", () => {
    expect(env).toContain("SLACK_BOT_TOKEN=");
    expect(env).toContain("SLACK_APP_TOKEN=");
    // Per-Steve identity comes from letterhead prefix, not separate tokens.
    expect(env).toContain("STEVE_A_PREFIX=");
    expect(env).toContain("STEVE_D_PREFIX=");
  });

  it("includes the COLTRANE_BOOK_PATH slot", () => {
    expect(env).toContain("COLTRANE_BOOK_PATH=");
  });

  it("does not embed real-looking tokens", () => {
    // every value should be REPLACE_ME or a path
    const tokenLines = env
      .split("\n")
      .filter((l) => l.startsWith("SLACK_"));
    for (const l of tokenLines) {
      expect(l).toMatch(/REPLACE_ME/);
    }
  });
});

describe("makeSteveSeed", () => {
  it("rotates dominant primitive by orientation", () => {
    for (let i = 0; i < STEVE_COUNT; i++) {
      const seed = makeSteveSeed(i, `00000000-0000-0000-0000-00000000000${i}`);
      const dominant = PRIMITIVES[i];
      expect(dominant).toBeDefined();
      if (!dominant) return;
      expect(seed.primitive_seed[dominant]).toBe(1.0);
      // every other primitive is the baseline 0.5
      for (const p of PRIMITIVES) {
        if (p === dominant) continue;
        expect(seed.primitive_seed[p]).toBe(0.5);
      }
    }
  });

  it("uses provided uuid when given", () => {
    const seed = makeSteveSeed(0, "fixed-uuid-abc");
    expect(seed.steve_uuid).toBe("fixed-uuid-abc");
  });

  it("rejects out-of-range orientation by clamping with modulo (does not crash)", () => {
    expect(() => makeSteveSeed(0)).not.toThrow();
    expect(() => makeSteveSeed(99)).not.toThrow();
  });
});

describe("materializeScaffold", () => {
  it(`writes manifest, env template, and ${STEVE_COUNT} steve dirs`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-scaffold-"));
    const fixedUuids = ["uu-0", "uu-1", "uu-2", "uu-3"];
    const result = await materializeScaffold({ root: dir, uuids: fixedUuids });

    expect(result.seeds).toHaveLength(STEVE_COUNT);
    expect(result.steve_dirs).toHaveLength(STEVE_COUNT);

    const manifest = await readFile(result.manifest_path, "utf8");
    expect(manifest).toContain("socket_mode_enabled: true");

    const envTemplate = await readFile(result.env_template_path, "utf8");
    expect(envTemplate).toContain("SLACK_BOT_TOKEN_4=");

    const coltraneRoot = join(dir, ".coltrane");
    const entries = await readdir(coltraneRoot);
    const steveEntries = entries.filter((e) => e.startsWith("steve_"));
    expect(steveEntries).toHaveLength(STEVE_COUNT);

    for (let i = 0; i < STEVE_COUNT; i++) {
      const seedPath = join(coltraneRoot, `steve_${fixedUuids[i]}`, "seed.json");
      const seed = JSON.parse(await readFile(seedPath, "utf8"));
      expect(seed.steve_uuid).toBe(fixedUuids[i]);
      const auditPath = join(coltraneRoot, `steve_${fixedUuids[i]}`, "audit.jsonl");
      const audit = await readFile(auditPath, "utf8");
      expect(audit).toBe("");
    }
  });
});

describe("renderSetupInstructions", () => {
  it("references the manifest + env template + the play subcommand", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-scaffold-"));
    const result = await materializeScaffold({
      root: dir,
      uuids: ["a", "b", "c", "d"],
    });
    const instructions = renderSetupInstructions(result);
    expect(instructions).toContain("slack-app-manifest.yaml");
    expect(instructions).toContain(".env");
    expect(instructions).toContain("coltrane play --live-slack");
  });
});
