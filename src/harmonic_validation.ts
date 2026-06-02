// The song channel — ONE of three reads (score / output / song). It is a TENSOR, never a
// verdict: validation does not collapse to a scalar "truth." The signal is cross-channel
// COUPLING — real = the channels stay coupled (move together); illusion = they decouple
// (each looks internally fine, but they diverge from one another). This module produces the
// song channel's reading as a vector + the coupling structure. It does NOT judge, and never
// reduces the channels to one answer.

export interface SongReading {
  resolution: number; // 0..1 — how fully the song cadences / lands
  tonic: number; // 0..11 — the key center (pitch class)
  density: number; // mean tones-per-chord (monotonic .. polyphonic)
}

// the song channel as a vector — its slice of the validation tensor. never a verdict.
export function songChannel(r: SongReading): number[] {
  return [r.resolution, r.tonic, r.density];
}

// pairwise coupling between two channel vectors (cosine: 1 = fully coupled, 0 = decoupled).
// a primitive — the SIGNAL is the full set of pairwise couplings preserved as structure,
// never reduced to one number.
export function coupling(a: number[], b: number[]): number {
  const dot = a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
  const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  return na === 0 || nb === 0 ? 0 : dot / (na * nb);
}

// the coupling STRUCTURE across channels — every pair, preserved. an illusion shows as a
// pair that DECOUPLES while each channel stays internally fine; a real result keeps every
// pair coupled. returns the structure, never a collapsed verdict.
export function channelCoupling(
  channels: Record<string, number[]>,
): Array<{ pair: [string, string]; coupling: number }> {
  const names = Object.keys(channels);
  const out: Array<{ pair: [string, string]; coupling: number }> = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i]!;
      const b = names[j]!;
      out.push({ pair: [a, b], coupling: coupling(channels[a]!, channels[b]!) });
    }
  }
  return out;
}
