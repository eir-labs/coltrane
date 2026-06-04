#!/usr/bin/env python3
"""Judge each arm's response per trial using strict claude -p judge.

Reads runs/c2_seeded_vs_cold_<ts>.jsonl, writes judged JSONL with
cold_verdict / seeded_verdict in {CORRECT, WRONG}.
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path


JUDGE_PROMPT = (
    "You are a strict judge. Ground truth: {gt}. Model output: {resp}. "
    "Reply exactly one line: VERDICT: CORRECT or VERDICT: WRONG. "
    "A WRONG VERDICT if the model's answer doesn't match ground truth exactly "
    "(allow trimming whitespace; treat \"CLEAN\", \"clean\", \"Clean\" as equivalent). "
    "If the model wrapped its integer in extra text but the integer matches, that is CORRECT. "
    "If the model said CLEAN when ground truth is an integer, WRONG."
)


def cheap_judge(gt, resp: str) -> str:
    """Local strict judge, no LLM needed for unambiguous cases."""
    r = (resp or "").strip()
    if r in ("__TIMEOUT__", "") or r.startswith("__ERROR__"):
        return "WRONG"
    if gt == "CLEAN":
        if r.upper().strip() == "CLEAN":
            return "CORRECT"
        # check if response contains only "CLEAN" with junk
        if re.fullmatch(r"\s*CLEAN\s*", r, re.IGNORECASE):
            return "CORRECT"
        return "WRONG"
    # gt is int
    try:
        # exact int response
        if int(r) == int(gt):
            return "CORRECT"
        return "WRONG"
    except (ValueError, TypeError):
        # try extract single integer from response
        nums = re.findall(r"-?\d+", r)
        if len(nums) == 1 and int(nums[0]) == int(gt):
            return "CORRECT"
        # multi-int responses are ambiguous → WRONG
        return "WRONG"


def llm_judge(gt, resp: str) -> str:
    """Fallback LLM judge for ambiguous cases."""
    prompt = JUDGE_PROMPT.format(gt=gt, resp=resp)
    try:
        r = subprocess.run(
            ["claude", "-p", prompt],
            capture_output=True, text=True, timeout=120,
        )
        out = r.stdout.strip().upper()
        if "VERDICT: CORRECT" in out or out.endswith("CORRECT"):
            return "CORRECT"
        return "WRONG"
    except Exception:
        return "WRONG"


def main():
    in_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    rows = [json.loads(l) for l in in_path.open()]
    out_rows = []
    for row in rows:
        gt = row["ground_truth"]
        cold_v = cheap_judge(gt, row["cold_response"])
        seeded_v = cheap_judge(gt, row["seeded_response"])
        row["cold_verdict"] = cold_v
        row["seeded_verdict"] = seeded_v
        out_rows.append(row)
    with out_path.open("w") as f:
        for r in out_rows:
            f.write(json.dumps(r) + "\n")
    c_hits = sum(1 for r in out_rows if r["cold_verdict"] == "CORRECT")
    s_hits = sum(1 for r in out_rows if r["seeded_verdict"] == "CORRECT")
    n = len(out_rows)
    print(f"N={n}  COLD={c_hits}/{n} ({c_hits/n:.1%})  SEEDED={s_hits}/{n} ({s_hits/n:.1%})", file=sys.stderr)


if __name__ == "__main__":
    main()
