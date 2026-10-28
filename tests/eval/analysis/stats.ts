/**
 * Small, deterministic statistics for `eval:analyze`. Pure: no I/O, no
 * clock, no `Math.random` — every random draw comes from a seeded PRNG
 * so the same records and seed always print the same numbers.
 */

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}

/** Sample standard deviation (n − 1). Null below two values. */
export function sampleSd(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2;
  return Math.sqrt(ss / (xs.length - 1));
}

export function minMax(xs: readonly number[]): { min: number; max: number } | null {
  if (xs.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const x of xs) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return { min, max };
}

/**
 * Nearest-rank percentile, the rule `scripts/latency/report.ts` uses:
 * the smallest value with at least `p` of the values at or below it.
 */
export function nearestRankPercentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1]!;
}

/** Linear-interpolation quantile (type 7) of an already sorted array. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) throw new Error("quantileSorted: empty input");
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** mulberry32: a tiny seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_SEED = 20261028;
export const DEFAULT_RESAMPLES = 10_000;

/** Values per cell, keyed by cell id. */
export type CellValues = ReadonlyMap<string, readonly number[]>;

/** Mean over cells of each cell's mean: every cell weighs the same. */
export function equalCellWeightMean(cells: CellValues): number | null {
  const means: number[] = [];
  for (const values of cells.values()) {
    const m = mean(values);
    if (m !== null) means.push(m);
  }
  return mean(means);
}

/** Cells holding at least one value in both arms, sorted. */
export function commonCells(a: CellValues, b: CellValues): string[] {
  return [...a.keys()]
    .filter((c) => (a.get(c)?.length ?? 0) > 0 && (b.get(c)?.length ?? 0) > 0)
    .sort();
}

/**
 * Equal-cell-weight difference of means over the cells both arms hold:
 * mean over cells of (candidate cell mean − incumbent cell mean).
 */
export function cellWeightedDiff(incumbent: CellValues, candidate: CellValues): number | null {
  const cells = commonCells(incumbent, candidate);
  if (cells.length === 0) return null;
  return mean(cells.map((c) => mean(candidate.get(c)!)! - mean(incumbent.get(c)!)!));
}

/**
 * 95% percentile CI for `cellWeightedDiff` by a stratified bootstrap:
 * each resample redraws every arm's values with replacement WITHIN each
 * cell, so the cell mix never changes. Deterministic for a given seed;
 * values are sorted per cell first so input order cannot move the result.
 *
 * Null when there is no common cell, or when any common cell has fewer
 * than two values in either arm: a single value is redrawn unchanged in
 * every resample, so that cell would contribute no spread and the
 * interval would be too narrow (incumbent [0.6] vs candidate [0.7] gave
 * [0.1, 0.1]). This is the condition under which `stratifiedWelchTTest`
 * returns null, so the CI and the p-value are blank together.
 */
export function stratifiedBootstrapCi(
  incumbent: CellValues,
  candidate: CellValues,
  options: { readonly resamples?: number; readonly seed?: number } = {},
): { lo: number; hi: number } | null {
  const cells = commonCells(incumbent, candidate);
  if (cells.length === 0) return null;
  if (cells.some((c) => incumbent.get(c)!.length < 2 || candidate.get(c)!.length < 2)) return null;
  const resamples = options.resamples ?? DEFAULT_RESAMPLES;
  const rng = mulberry32(options.seed ?? DEFAULT_SEED);
  const inc = cells.map((c) => [...incumbent.get(c)!].sort((x, y) => x - y));
  const cand = cells.map((c) => [...candidate.get(c)!].sort((x, y) => x - y));
  const draw = (values: readonly number[]): number => {
    let total = 0;
    for (let i = 0; i < values.length; i++) total += values[Math.floor(rng() * values.length)]!;
    return total / values.length;
  };
  const stats: number[] = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let total = 0;
    for (let c = 0; c < cells.length; c++) total += draw(cand[c]!) - draw(inc[c]!);
    stats[r] = total / cells.length;
  }
  stats.sort((x, y) => x - y);
  return { lo: quantileSorted(stats, 0.025), hi: quantileSorted(stats, 0.975) };
}

// -- Student t ---------------------------------------------------------------

/** ln Γ(x) for x > 0 (Lanczos, g = 7, n = 9). */
export function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const xx = x - 1;
  let a = c[0]!;
  const t = xx + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (modified Lentz). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const EPS = 1e-15;
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront = lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lnFront);
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Two-sided p-value of Student's t with `df` degrees of freedom. */
export function studentTTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  return regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/**
 * Welch's unequal-variance t-test, two-sided. Null when either arm has
 * fewer than two values or both variances are (numerically) zero, where
 * the statistic is undefined; identical constants report p = 1 instead.
 */
export function welchTTest(
  a: readonly number[],
  b: readonly number[],
): { t: number; df: number; p: number } | null {
  if (a.length < 2 || b.length < 2) return null;
  const va = sampleSd(a)! ** 2;
  const vb = sampleSd(b)! ** 2;
  const diff = mean(b)! - mean(a)!;
  const se2 = va / a.length + vb / b.length;
  // Identical values can leave a variance of ~1e-34 from rounding in the
  // mean; treat that as zero rather than report a meaningless p < 0.001.
  if (se2 <= 1e-20) return Math.abs(diff) <= 1e-12 ? { t: 0, df: a.length + b.length - 2, p: 1 } : null;
  const t = diff / Math.sqrt(se2);
  const df = se2 ** 2 / ((va / a.length) ** 2 / (a.length - 1) + (vb / b.length) ** 2 / (b.length - 1));
  return { t, df, p: studentTTwoSidedP(t, df) };
}

/**
 * Stratified Welch test of `cellWeightedDiff`: the same estimand as the
 * printed difference and the bootstrap CI, so a p-value can never test a
 * different (pooled, cell-mix-dependent) gap than the one shown.
 *
 *   D   = (1/C)·Σ_c (m_cand,c − m_inc,c)       over the C common cells
 *   se² = (1/C²)·Σ_c (s²_cand,c/n_cand,c + s²_inc,c/n_inc,c)
 *   df  = se⁴ / Σ_k (v_k/n_k)²/(n_k − 1)        Welch–Satterthwaite over the
 *                                               2C components, v_k/n_k
 *                                               scaled by 1/C²
 *   t   = D/se, p two-sided from Student t(df).
 *
 * Null when there is no common cell, or when any common cell has fewer
 * than two values in either arm (its variance is undefined; dropping the
 * cell would test a different difference than the one printed). Zero
 * total variance reports p = 1 when D is zero and null otherwise, as
 * `welchTTest` does.
 */
export function stratifiedWelchTTest(
  incumbent: CellValues,
  candidate: CellValues,
): { t: number; df: number; p: number; diff: number } | null {
  const cells = commonCells(incumbent, candidate);
  if (cells.length === 0) return null;
  const k = 1 / cells.length;
  let diff = 0;
  let se2 = 0;
  let dfDen = 0;
  for (const c of cells) {
    for (const values of [incumbent.get(c)!, candidate.get(c)!]) {
      if (values.length < 2) return null;
      const component = (k * k * sampleSd(values)! ** 2) / values.length;
      se2 += component;
      dfDen += component ** 2 / (values.length - 1);
    }
    diff += k * (mean(candidate.get(c)!)! - mean(incumbent.get(c)!)!);
  }
  if (se2 <= 1e-20) {
    if (Math.abs(diff) > 1e-12) return null;
    let n = 0;
    for (const c of cells) n += incumbent.get(c)!.length + candidate.get(c)!.length;
    return { t: 0, df: n - 2 * cells.length, p: 1, diff };
  }
  const t = diff / Math.sqrt(se2);
  const df = se2 ** 2 / dfDen;
  return { t, df, p: studentTTwoSidedP(t, df), diff };
}

/**
 * Pooled within-cell SD: sqrt(Σ (n_c − 1) s_c² / Σ (n_c − 1)). Null when
 * no cell has two values.
 */
export function pooledWithinCellSd(cells: CellValues): number | null {
  let num = 0;
  let den = 0;
  for (const values of cells.values()) {
    if (values.length < 2) continue;
    num += (values.length - 1) * sampleSd(values)! ** 2;
    den += values.length - 1;
  }
  return den === 0 ? null : Math.sqrt(num / den);
}

export interface PowerCheck {
  /** Pooled within-cell SD of the incumbent. */
  readonly s: number;
  /** Cells the incumbent covers (C). */
  readonly cells: number;
  /** 1.96·s/√(2n) at n = 6, the stated formula. */
  readonly halfWidthAtN6: number;
  /** 1.96·s·√(2/(C·n)) at n = 6; equals the stated formula when C = 4. Null when C = 0. */
  readonly halfWidthAtN6ForCells: number | null;
  /** Smallest n per cell with 1.96·s/√(2n) ≤ target; null when not a share metric. */
  readonly nForTarget: number | null;
  /** Same, from the C-cell form. */
  readonly nForTargetForCells: number | null;
}

export const POWER_N = 6;
/** 2.5 points on a [0, 1] metric. */
export const POWER_TARGET_HALF_WIDTH = 0.025;

export function powerCheck(s: number, cells: number, shareMetric: boolean): PowerCheck {
  const z = 1.96;
  const needed = (k: number): number | null =>
    !shareMetric ? null : s === 0 ? 1 : Math.max(1, Math.ceil(k * (z * s / POWER_TARGET_HALF_WIDTH) ** 2));
  return {
    s,
    cells,
    halfWidthAtN6: (z * s) / Math.sqrt(2 * POWER_N),
    halfWidthAtN6ForCells: cells === 0 ? null : z * s * Math.sqrt(2 / (cells * POWER_N)),
    nForTarget: needed(1 / 2),
    nForTargetForCells: cells === 0 ? null : needed(2 / cells),
  };
}
