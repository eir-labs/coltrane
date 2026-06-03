// O18 — gig_song: the engine→song bridge. A gig's ordered agents (each composed of
// primitives) encode to a chord progression and render to a JSONG tick-log. The
// counter-claim: the primitive→tone map is a PARAMETER (overridable), and the
// output stays STRUCTURE (progression + resolution + per-step chords), never a
// scalar verdict.
import { describe, it, expect } from "vitest";
import { gigToSong, stepToChord, songToJsong, DEFAULT_TONE_MAP, type SongStep } from "../src/gig_song.js";
import { readAll } from "../src/jsong.js";

describe("gig_song: an agent sounds its primitives as a chord", () => {
  it("maps primitives → tones via the default map; arity = how many", () => {
    expect(stepToChord({ agent_slug: "a", primitives: ["SENSE", "INTERPRET"] })).toEqual([0, 2]);
    expect(DEFAULT_TONE_MAP["VERIFY"]).toBe(9);
  });
  it("drops primitives the tone-map doesn't know (no silent invention)", () => {
    expect(stepToChord({ agent_slug: "a", primitives: ["SENSE", "FOO"] })).toEqual([0]);
  });
  it("honors an overridden tone-map — the voicing is a parameter, not a truth", () => {
    expect(stepToChord({ agent_slug: "a", primitives: ["SENSE"] }, { SENSE: 7 })).toEqual([7]);
  });
});

describe("gig_song: a gig encodes to a progression + a structured resolution", () => {
  const steps: SongStep[] = [
    { agent_slug: "scout", primitives: ["SENSE"], phase: "sense" },
    { agent_slug: "analyst", primitives: ["INTERPRET"], phase: "interpret" },
  ];
  it("produces one chord per agent, in gig order, with arity preserved", () => {
    const song = gigToSong(steps);
    expect(song.progression).toEqual([[0], [2]]);
    expect(song.steps.map((s) => s.arity)).toEqual(["monotonic", "monotonic"]);
    expect(song.steps[0]!.agent_slug).toBe("scout");
  });
  it("the resolution carries the full tension profile, not a scalar", () => {
    const song = gigToSong(steps);
    expect(song.resolution.tensionProfile.length).toBe(2);
    expect(typeof song.resolution.resolves).toBe("boolean");
  });
  it("a tense chord resolving into a consonant tonic resolves (V→I shape)", () => {
    const song = gigToSong([
      { agent_slug: "tense", primitives: ["JUDGE", "PLAN"] }, // tones 4,5 — a dissonant second
      { agent_slug: "home", primitives: ["SENSE"] }, // tone 0 — at rest
    ]);
    expect(song.resolution.resolves).toBe(true);
    expect(song.resolution.tonic).toBe(0);
    expect(song.resolution.tensionDropped).toBe(true);
  });
});

describe("gig_song: renders to a valid JSONG tick-log", () => {
  it("one observation tick per agent; score = chord consonance; slug = agent", () => {
    const song = gigToSong([
      { agent_slug: "scout", primitives: ["SENSE"] },
      { agent_slug: "analyst", primitives: ["INTERPRET"] },
    ]);
    const { header, ticks } = readAll(songToJsong(song));
    expect(header.version).toBe(0);
    expect(ticks.length).toBe(2);
    expect(ticks[0]!.slug).toBe("scout");
    expect(ticks[0]!.score).toBeCloseTo(song.steps[0]!.consonance, 6);
    expect(ticks[0]!.state_59[4]).toBeCloseTo(song.steps[0]!.consonance, 6); // C/coherence slot
  });
});
