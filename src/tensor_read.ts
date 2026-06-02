// Multi-channel tensor read. Each channel of a gig (score, output, song, etc)
// produces its own structured reading. The TensorRead holds them side-by-side
// WITHOUT collapsing to a scalar. Validation across channels reads pairwise
// diffs; the tensor itself is never reduced to "pass/fail."

export interface ChannelReading<T = unknown> {
  channel: string;
  produced_by: string;
  payload: T;
}

export interface TensorRead {
  gig_id: string;
  readings: readonly ChannelReading[];
}

export class TensorReadError extends Error {}

export function emptyTensorRead(gig_id: string): TensorRead {
  return { gig_id, readings: [] };
}

export function addChannel(
  tensor: TensorRead,
  reading: ChannelReading,
): TensorRead {
  if (tensor.readings.some((r) => r.channel === reading.channel)) {
    throw new TensorReadError(
      `tensor already has a reading for channel "${reading.channel}"`,
    );
  }
  return {
    gig_id: tensor.gig_id,
    readings: [...tensor.readings, reading],
  };
}

export function readChannel(
  tensor: TensorRead,
  channel: string,
): ChannelReading | undefined {
  return tensor.readings.find((r) => r.channel === channel);
}

export interface ChannelDiff {
  channel: string;
  present_in_both: boolean;
  a_only: boolean;
  b_only: boolean;
  // produced_by helpers for chain-of-record attribution
  a_produced_by?: string | undefined;
  b_produced_by?: string | undefined;
}

export interface TensorDiff {
  gig_a: string;
  gig_b: string;
  channels: readonly ChannelDiff[];
  // intentionally NO single scalar verdict — callers compose their own policy
  // by reading the per-channel diffs.
}

export function compareTensorReads(a: TensorRead, b: TensorRead): TensorDiff {
  const channels = new Set<string>();
  for (const r of a.readings) channels.add(r.channel);
  for (const r of b.readings) channels.add(r.channel);

  const diffs: ChannelDiff[] = [];
  for (const ch of channels) {
    const ra = readChannel(a, ch);
    const rb = readChannel(b, ch);
    const diff: ChannelDiff = {
      channel: ch,
      present_in_both: !!ra && !!rb,
      a_only: !!ra && !rb,
      b_only: !ra && !!rb,
    };
    if (ra?.produced_by) diff.a_produced_by = ra.produced_by;
    if (rb?.produced_by) diff.b_produced_by = rb.produced_by;
    diffs.push(diff);
  }

  return { gig_a: a.gig_id, gig_b: b.gig_id, channels: diffs };
}

/**
 * Pure cardinality helpers. Return NUMBERS so a downstream policy layer can
 * weight them inside the tensor — never as standalone verdicts.
 */
export function channelCount(tensor: TensorRead): number {
  return tensor.readings.length;
}

export function uniqueChannels(diff: TensorDiff): {
  in_both: number;
  a_only: number;
  b_only: number;
} {
  return {
    in_both: diff.channels.filter((c) => c.present_in_both).length,
    a_only: diff.channels.filter((c) => c.a_only).length,
    b_only: diff.channels.filter((c) => c.b_only).length,
  };
}
