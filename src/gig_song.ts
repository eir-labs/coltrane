// gig_song — "the sim plays the gig." Encodes a gig's trajectory (its ordered
// agents, each composed of cognitive primitives) into a chord PROGRESSION, then
// renders that to a JSONG observation tick-log. This is the generative bridge:
// engine (gigs/agents/primitives/outputs) → song-substrate (tones/chords) → jsong.
//
// The primitive→tone map is a PARAMETER, not a baked-in truth — the song is one
// read of three, and which tone a primitive sounds as is a spec decision, passed
// in (DEFAULT_TONE_MAP is a sensible diatonic default, overridable). Output is
// STRUCTURE (progression + resolution + per-step chords), never a scalar verdict.

import { type Tone, type Chord, chordConsonance, chordArity, resolve, type Resolution, type Arity } from "./tones.js";
import { writeAll, emptyState, type FileHeader, type TickRecord, ROLE_OBSERVATION, FLAG_MUSICAL } from "./jsong.js";

// primitive → tone. Default maps the 6 cognitive primitives onto a C-major hexad
// (C D E F G A). Override to sound a gig in any voicing the spec declares.
export type ToneMap = Readonly<Record<string, Tone>>;
export const DEFAULT_TONE_MAP: ToneMap = {
  SENSE: 0, INTERPRET: 2, JUDGE: 4, PLAN: 5, CREATE: 7, VERIFY: 9,
};

// One step of the gig's song: an agent, the primitives it's composed of, its phase.
// An agent's chord = its primitives sounded together (arity = how many — the
// monotonic…polyphonic primitive). Order across steps = the progression.
export interface SongStep {
  agent_slug: string;
  primitives: readonly string[];
  phase?: string | undefined;
}

export interface AgentChord {
  agent_slug: string;
  chord: Chord;
  arity: Arity;
  consonance: number;
}

export interface GigSong {
  steps: AgentChord[]; // per-agent chord + arity + consonance (preserved, not collapsed)
  progression: Chord[]; // the chord sequence, in gig order
  resolution: Resolution; // tones.resolve over the progression (structured)
}

/** Sound one agent: its primitives → a chord (unknown primitives are dropped). */
export function stepToChord(step: SongStep, toneOf: ToneMap = DEFAULT_TONE_MAP): Chord {
  const tones: Tone[] = [];
  for (const p of step.primitives) {
    const t = toneOf[p];
    if (typeof t === "number") tones.push(t);
  }
  return tones;
}

/** Encode an ordered gig trajectory into a song (progression + resolution). */
export function gigToSong(steps: readonly SongStep[], toneOf: ToneMap = DEFAULT_TONE_MAP): GigSong {
  const stepsOut: AgentChord[] = steps.map((s) => {
    const chord = stepToChord(s, toneOf);
    return { agent_slug: s.agent_slug, chord, arity: chordArity(chord), consonance: chordConsonance(chord) };
  });
  const progression = stepsOut.map((s) => s.chord);
  return { steps: stepsOut, progression, resolution: resolve(progression) };
}

/** Render a gig-song to a JSONG observation tick-log — one tick per agent-chord.
 *  Minimal v0 state packing: index 4 (the C/coherence slot) carries the chord's
 *  consonance; score = consonance; slug = agent. The full 59-dim fingerprint
 *  packing is the research-lane concern, deferred — this stays honest about what
 *  it fills. */
export function songToJsong(song: GigSong, gigId: Uint8Array = new Uint8Array(16)): Uint8Array {
  const header: FileHeader = { version: 0, gig_id: gigId, agent_id: new Uint8Array(16), start_us: 0n };
  const ticks: TickRecord[] = song.steps.map((s, i) => {
    const state = emptyState();
    state[4] = s.consonance; // state_59[4] = C (coherence) per the JSONG canonical order
    return {
      tick_idx: i,
      delta_us: 0,
      role: ROLE_OBSERVATION,
      flags: FLAG_MUSICAL,
      state_59: state,
      score: s.consonance,
      slug: s.agent_slug,
    };
  });
  return writeAll(header, ticks);
}
