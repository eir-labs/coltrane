// Independent re-measurement layer. For a given contract, run the primary code
// path and a secondary code path that exercises the SAME contract via a different
// route, then compare. Agreement = the contract holds across both paths; a
// divergence is an honest finding — either the public API does work the raw path
// skips, or the underlying schema is under-specified.
//
// Used by tests under tests/honest_broker/. The comparator scrubs known volatile
// keys (uuids, timestamps, fingerprints derived from uuids) so two structurally
// equivalent runs match; surviving differences are real.

export interface DivergenceReport {
  // JSON-pointer-ish path into the structure where they first differ.
  path: string;
  // Stringified primary value at that path (truncated to 200 chars).
  primary: string;
  // Stringified secondary value at that path (truncated to 200 chars).
  secondary: string;
  // Human description of the kind of divergence.
  reason: string;
}

export interface HonestBrokerComparison<T> {
  primary: T;
  secondary: T;
  agreement: boolean;
  divergence: DivergenceReport | null;
}

export type Comparator<T> = (a: T, b: T) => boolean;

const MAX_VALUE_LEN = 200;

function truncate(v: unknown): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s.length > MAX_VALUE_LEN) s = s.slice(0, MAX_VALUE_LEN) + "…";
  return s;
}

/**
 * Walk two JSON-serialisable values in parallel. Returns null when structurally
 * equal, or a DivergenceReport pinpointing the first mismatch. Arrays are
 * length-checked then compared positionally; objects are key-set-checked then
 * compared by key. Primitives use strict equality (NaN is treated as unequal).
 */
export function findDivergence(
  a: unknown,
  b: unknown,
  path: string = "$",
): DivergenceReport | null {
  if (a === b) return null;
  // both null/undefined catch-all
  if (a === null || b === null || a === undefined || b === undefined) {
    return {
      path,
      primary: truncate(a),
      secondary: truncate(b),
      reason: `null/undefined on one side`,
    };
  }
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) {
    return {
      path,
      primary: truncate(a),
      secondary: truncate(b),
      reason: `type mismatch: ${ta} vs ${tb}`,
    };
  }
  if (ta !== "object") {
    return {
      path,
      primary: truncate(a),
      secondary: truncate(b),
      reason: `value mismatch (${ta})`,
    };
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) {
    return {
      path,
      primary: truncate(a),
      secondary: truncate(b),
      reason: `one side is array, other is object`,
    };
  }
  if (aArr && bArr) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) {
      return {
        path,
        primary: `length=${arrA.length}`,
        secondary: `length=${arrB.length}`,
        reason: `array length mismatch`,
      };
    }
    for (let i = 0; i < arrA.length; i++) {
      const d = findDivergence(arrA[i], arrB[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).sort();
  const keysB = Object.keys(objB).sort();
  if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) {
    const onlyA = keysA.filter((k) => !keysB.includes(k));
    const onlyB = keysB.filter((k) => !keysA.includes(k));
    return {
      path,
      primary: `keys: ${keysA.join(",")}`,
      secondary: `keys: ${keysB.join(",")}`,
      reason: `key-set mismatch (only-primary: [${onlyA.join(",")}], only-secondary: [${onlyB.join(",")}])`,
    };
  }
  for (const k of keysA) {
    const d = findDivergence(objA[k], objB[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

/**
 * Run two independent code paths that should produce the same result under the
 * same contract; compare structurally. The comparator defaults to deep
 * structural equality on JSON-serialisable objects. When a custom comparator is
 * supplied, the DivergenceReport will still be produced via findDivergence so
 * the failure is locatable.
 */
export async function compareHonestBroker<T>(
  primary: () => Promise<T> | T,
  secondary: () => Promise<T> | T,
  comparator?: Comparator<T>,
): Promise<HonestBrokerComparison<T>> {
  const primaryResult = await primary();
  const secondaryResult = await secondary();
  const cmp = comparator ?? defaultDeepEqual<T>;
  const agreement = cmp(primaryResult, secondaryResult);
  const divergence = agreement
    ? null
    : findDivergence(primaryResult, secondaryResult);
  return {
    primary: primaryResult,
    secondary: secondaryResult,
    agreement,
    divergence,
  };
}

function defaultDeepEqual<T>(a: T, b: T): boolean {
  return findDivergence(a, b) === null;
}

/**
 * Returns a new object with the named keys removed RECURSIVELY at any depth.
 * Used to scrub volatile fields (uuids, timestamps, derived fingerprints)
 * before comparison so two structurally-equivalent runs match.
 */
export function scrubKeys<T>(value: T, keys: readonly string[]): T {
  const skip = new Set(keys);
  function walk(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (skip.has(k)) continue;
      out[k] = walk(val);
    }
    return out;
  }
  return walk(value) as T;
}
