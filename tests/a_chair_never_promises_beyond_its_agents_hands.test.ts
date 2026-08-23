import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// A chair's output_contract is a promise the seated agent must be able to keep:
// every promised type must appear in that agent's declared output_types. A seat
// that promises what its agent cannot produce fails only at runtime, after the
// upstream chairs have already spent their work — residency-spec-v0's contract
// chair did exactly this on its first live gig (2026-08-23): the chair promised
// subsystem-contract while solution-developer declared only [Artifact], and the
// gig aborted two sealed phases deep. This sweep makes that mismatch a genome
// error instead of a runtime discovery.

const ROOT = join(__dirname, "..");

function loadDir(dir: string): Map<string, any> {
  const out = new Map<string, any>();
  for (const f of readdirSync(join(ROOT, dir))) {
    if (!f.endsWith(".json")) continue;
    const doc = JSON.parse(readFileSync(join(ROOT, dir, f), "utf8"));
    out.set(doc.slug ?? f.replace(/\.json$/, ""), doc);
  }
  return out;
}

describe("every chair promise is within its agent's hands", () => {
  const agents = loadDir("agents");
  const standards = loadDir("standards");

  it("finds no chair whose output_contract exceeds the seated agent's output_types", () => {
    const broken: string[] = [];
    for (const [slug, std] of standards) {
      for (const phase of std.phases ?? []) {
        for (const chair of phase.chairs ?? []) {
          if (chair.human || !chair.agent_slug) continue;
          const agent = agents.get(chair.agent_slug);
          if (!agent) continue; // seated from another genome — not this sweep's claim
          const hands: string[] = agent.output_types ?? [];
          for (const promised of chair.output_contract ?? []) {
            if (!hands.includes(promised)) {
              broken.push(
                `${slug} / phase ${phase.name} / chair ${chair.role}: promises "${promised}" ` +
                  `but ${chair.agent_slug} declares output_types [${hands.join(", ")}]`,
              );
            }
          }
        }
      }
    }
    expect(broken, broken.join("\n")).toEqual([]);
  });
});
