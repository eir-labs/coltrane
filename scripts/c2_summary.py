#!/usr/bin/env python3
"""Generate docs/c2_results.md from judged JSONL.

- Hit rate per arm + Wilson 95% CI
- Paired McNemar p (two-sided exact binomial)
- One-sentence verdict for C2 support
"""
import json
import math
import sys
from pathlib import Path


def wilson_ci(k: int, n: int, z: float = 1.96):
    if n == 0:
        return (0.0, 0.0)
    phat = k / n
    denom = 1 + z**2 / n
    center = (phat + z**2 / (2 * n)) / denom
    half = (z * math.sqrt((phat * (1 - phat) + z**2 / (4 * n)) / n)) / denom
    return (max(0.0, center - half), min(1.0, center + half))


def binom_cdf(k: int, n: int, p: float) -> float:
    """P(X <= k) for Binomial(n, p)."""
    s = 0.0
    log_p = math.log(p) if p > 0 else float("-inf")
    log_q = math.log(1 - p) if p < 1 else float("-inf")
    for i in range(k + 1):
        log_coef = math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1)
        s += math.exp(log_coef + i * log_p + (n - i) * log_q)
    return min(1.0, s)


def mcnemar_exact(b: int, c: int):
    """Two-sided exact McNemar.
    b = seeded_wrong_cold_right discordant
    c = seeded_right_cold_wrong discordant
    Under H0, each discordant pair is 50/50 → Binom(b+c, 0.5)
    Two-sided p = 2 * min(P(X<=min(b,c)), 0.5)
    """
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    one_sided = binom_cdf(k, n, 0.5)
    p_two = min(1.0, 2 * one_sided)
    return p_two


def one_sided_p_diff(seeded_hits, cold_hits, b, c):
    """One-sided p that SEEDED > COLD.
    Under H0 of equal marginals → discordant pairs split 50/50;
    one-sided p that c (seeded-right, cold-wrong) > b is binom upper tail.
    """
    n = b + c
    if n == 0:
        return 0.5
    # P(X >= c | n, p=0.5)
    p = 1 - binom_cdf(c - 1, n, 0.5) if c > 0 else 1.0
    return p


def main():
    in_path = Path(sys.argv[1])
    out_md = Path(sys.argv[2])
    rows = [json.loads(l) for l in in_path.open()]
    n = len(rows)
    c_hits = sum(1 for r in rows if r["cold_verdict"] == "CORRECT")
    s_hits = sum(1 for r in rows if r["seeded_verdict"] == "CORRECT")

    # Discordant pairs
    # b = cold CORRECT, seeded WRONG
    # c = seeded CORRECT, cold WRONG
    b = sum(1 for r in rows if r["cold_verdict"] == "CORRECT" and r["seeded_verdict"] == "WRONG")
    c = sum(1 for r in rows if r["seeded_verdict"] == "CORRECT" and r["cold_verdict"] == "WRONG")
    both_right = sum(1 for r in rows if r["cold_verdict"] == "CORRECT" and r["seeded_verdict"] == "CORRECT")
    both_wrong = sum(1 for r in rows if r["cold_verdict"] == "WRONG" and r["seeded_verdict"] == "WRONG")

    cold_lo, cold_hi = wilson_ci(c_hits, n)
    s_lo, s_hi = wilson_ci(s_hits, n)
    delta_pp = (s_hits - c_hits) / n * 100

    p_two = mcnemar_exact(b, c)
    p_one = one_sided_p_diff(s_hits, c_hits, b, c)

    # C2 support: SEEDED − COLD ≥ 20 pts at one-sided α=0.05
    c2_support = delta_pp >= 20.0 and p_one <= 0.05
    if c2_support:
        verdict = (
            f"C2 SUPPORTED: SEEDED − COLD = {delta_pp:+.0f} pts "
            f"(McNemar one-sided p={p_one:.3f}) clears the ≥+20 pt threshold at α=0.05."
        )
    elif delta_pp >= 20.0:
        verdict = (
            f"C2 INCONCLUSIVE: SEEDED − COLD = {delta_pp:+.0f} pts meets the ≥+20 pt threshold but "
            f"McNemar one-sided p={p_one:.3f} does not clear α=0.05."
        )
    elif p_one <= 0.05:
        verdict = (
            f"C2 INCONCLUSIVE: McNemar one-sided p={p_one:.3f} but delta {delta_pp:+.0f} pts "
            f"is below the +20 pt threshold."
        )
    else:
        verdict = (
            f"C2 NOT SUPPORTED at this family: SEEDED − COLD = {delta_pp:+.0f} pts, "
            f"McNemar one-sided p={p_one:.3f}; fails both threshold and significance."
        )

    lines = []
    lines.append("# C2 paired-arm chain-integrity: seeded-vs-cold (N=20)")
    lines.append("")
    lines.append(f"Generated: {Path(__file__).name}  ·  Input: `{in_path.name}`")
    lines.append("")
    lines.append("## Hit rates")
    lines.append("")
    lines.append("| Arm | Correct | N | Hit-rate | 95% Wilson CI |")
    lines.append("|---|---|---|---|---|")
    lines.append(f"| COLD | {c_hits} | {n} | {c_hits/n:.1%} | [{cold_lo:.1%}, {cold_hi:.1%}] |")
    lines.append(f"| SEEDED | {s_hits} | {n} | {s_hits/n:.1%} | [{s_lo:.1%}, {s_hi:.1%}] |")
    lines.append("")
    lines.append(f"**Paired delta**: SEEDED − COLD = {delta_pp:+.0f} percentage points")
    lines.append("")
    lines.append("## McNemar (paired design)")
    lines.append("")
    lines.append("| Cell | Count |")
    lines.append("|---|---|")
    lines.append(f"| both correct | {both_right} |")
    lines.append(f"| seeded right, cold wrong (c) | {c} |")
    lines.append(f"| cold right, seeded wrong (b) | {b} |")
    lines.append(f"| both wrong | {both_wrong} |")
    lines.append("")
    lines.append(f"- Two-sided exact McNemar p = **{p_two:.3f}**")
    lines.append(f"- One-sided (seeded > cold) exact p = **{p_one:.3f}**")
    lines.append("")
    lines.append("## C2 verdict")
    lines.append("")
    lines.append(verdict)
    lines.append("")
    lines.append("## Per-trial table")
    lines.append("")
    lines.append("| trial | L | GT | cold | seeded | cold V | seeded V |")
    lines.append("|---|---|---|---|---|---|---|")
    for r in rows:
        cold_disp = (r["cold_response"] or "")[:30].replace("|", "\\|").replace("\n", " ")
        seed_disp = (r["seeded_response"] or "")[:30].replace("|", "\\|").replace("\n", " ")
        lines.append(
            f"| {r['trial_id']} | {r['L']} | {r['ground_truth']} | "
            f"`{cold_disp}` | `{seed_disp}` | "
            f"{r['cold_verdict']} | {r['seeded_verdict']} |"
        )
    lines.append("")

    out_md.write_text("\n".join(lines))
    print(verdict, file=sys.stderr)
    print(f"COLD {c_hits}/{n}  SEEDED {s_hits}/{n}  delta {delta_pp:+.0f}pp  McNemar 1-sided p={p_one:.3f}", file=sys.stderr)


if __name__ == "__main__":
    main()
