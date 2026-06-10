// Greedy all-pairs (pairwise, t=2) combination generator. Given named axes — each a list
// of values — it returns a small set of rows such that every pair of values across any two
// axes appears in at least one row. Full pairwise coverage without the full cross-product
// (e.g. 4×4×3×4×2×2×2×2 = 3072 combinations collapse to ~16 rows). Deterministic: no RNG,
// stable iteration order, so the generated suite is reproducible.
export function pairwise<T extends Record<string, readonly unknown[]>>(axes: T): { [K in keyof T]: T[K][number] }[] {
  const keys = Object.keys(axes) as (keyof T)[];
  const vals = keys.map((k) => axes[k] as readonly unknown[]);
  const n = keys.length;
  const pk = (a: number, va: number, b: number, vb: number): string => `${a},${va},${b},${vb}`;

  const need = new Set<string>();
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let va = 0; va < vals[a]!.length; va++)
        for (let vb = 0; vb < vals[b]!.length; vb++) need.add(pk(a, va, b, vb));

  const rows: number[][] = [];
  while (need.size > 0) {
    const seed = (need.values().next().value as string).split(",").map(Number);
    const [sa, sva, sb, svb] = seed as [number, number, number, number];
    const row = new Array<number>(n).fill(-1);
    row[sa] = sva;
    row[sb] = svb;
    for (let ax = 0; ax < n; ax++) {
      if (row[ax] !== -1) continue;
      let best = 0;
      let bestCov = -1;
      for (let v = 0; v < vals[ax]!.length; v++) {
        let cov = 0;
        for (let ox = 0; ox < n; ox++) {
          if (ox === ax || row[ox] === -1) continue;
          const key = ox < ax ? pk(ox, row[ox]!, ax, v) : pk(ax, v, ox, row[ox]!);
          if (need.has(key)) cov++;
        }
        if (cov > bestCov) {
          bestCov = cov;
          best = v;
        }
      }
      row[ax] = best;
    }
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) need.delete(pk(a, row[a]!, b, row[b]!));
    rows.push(row);
  }

  return rows.map((row) => {
    const obj = {} as { [K in keyof T]: T[K][number] };
    keys.forEach((k, i) => {
      (obj as Record<string, unknown>)[k as string] = vals[i]![row[i]!];
    });
    return obj;
  });
}
