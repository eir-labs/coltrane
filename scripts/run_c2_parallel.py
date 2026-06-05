#!/usr/bin/env python3
"""C2 paired-arm (SEEDED vs COLD) parallel harness, N=20.

End-to-end:
  1) Reuse runs/c2_trials.jsonl (or generate via c2_gen_trials).
  2) Build per-trial SEEDED project dirs by copying subhuti's
     chain-integrity-tester.jsonl into ~/.claude/projects/<slug>/<uuid>.jsonl,
     rewriting placeholders. Verify parentUuid chain.
  3) Spawn COLD + SEEDED claude -p subprocesses in parallel (Semaphore=8),
     per-call timeout 60s.
  4) Local cheap judge first, then LLM judge for ambiguous cases (parallel).
  5) Write runs/c2_parallel_<ts>.jsonl + docs/c2_results.md.
"""
import asyncio
import hashlib
import json
import os
import random
import re
import sys
import time
import uuid
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SEED_SRC = Path("/tmp/seed-drafts/chain-integrity-tester.jsonl")
TRIALS_PATH = ROOT / "runs" / "c2_trials.jsonl"

CONCURRENCY = 8
ARM_TIMEOUT = 60.0
JUDGE_TIMEOUT = 30.0

PROMPT_INSTRUCTION = (
    "You are verifying a hash chain. Each event has i, kind, prev_sha, sha_seal. "
    "sha_seal = sha256(canonical_json of event without sha_seal field, sorted keys, "
    "no whitespace). prev_sha[0] = \"GENESIS\"; prev_sha[i] = sha_seal[i-1]. "
    "Find the first index where verification fails. "
    "Reply with EXACTLY one token: the integer broken index, or the literal word CLEAN. "
    "No explanation, no whitespace, no other text."
)

JUDGE_PROMPT = (
    "Ground truth: {gt}\n"
    "Model answer: {resp}\n"
    "Reply exactly one line: 'VERDICT: CORRECT' if model answer equals ground truth "
    "(case-insensitive for CLEAN, trim whitespace, accept 'Index N' style), else 'VERDICT: WRONG'."
)


# ----------------------------------------------------------------------
# Trial gen (fallback if c2_trials.jsonl missing)
# ----------------------------------------------------------------------
KINDS = ["tuning", "passage", "bridge", "coda", "intro", "verse"]


def canonical_no_seal(event):
    e = {k: v for k, v in event.items() if k != "sha_seal"}
    return json.dumps(e, sort_keys=True, separators=(",", ":"))


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def build_clean_chain(L, rng):
    chain = []
    prev = "GENESIS"
    for i in range(L):
        ev = {"i": i, "kind": rng.choice(KINDS), "prev_sha": prev}
        seal = sha(canonical_no_seal(ev))
        ev["sha_seal"] = seal
        chain.append(ev)
        prev = seal
    return chain


def verify(chain):
    for i, ev in enumerate(chain):
        expected_prev = "GENESIS" if i == 0 else chain[i - 1]["sha_seal"]
        if ev["prev_sha"] != expected_prev:
            return i
        expected_seal = sha(canonical_no_seal(ev))
        if ev["sha_seal"] != expected_seal:
            return i
    return "CLEAN"


def random_hex64(rng):
    return "".join(rng.choice("0123456789abcdef") for _ in range(64))


def gen_trials():
    rng = random.Random(20260604)
    trials = []
    for tid in range(20):
        L = rng.choice([3, 5, 8])
        chain = build_clean_chain(L, rng)
        do_tamper = rng.random() < 0.75
        idx, mode = None, None
        if do_tamper:
            idx = rng.randint(1, L - 1)
            mode = rng.choice(["sha_seal", "prev_sha"])
            if mode == "sha_seal":
                chain[idx]["sha_seal"] = random_hex64(rng)
            else:
                chain[idx]["prev_sha"] = random_hex64(rng)
        gt = verify(chain)
        trials.append({
            "trial_id": tid,
            "L": L,
            "tampered": do_tamper,
            "tamper_idx": idx,
            "tamper_mode": mode,
            "chain": chain,
            "ground_truth": gt,
        })
    return trials


def load_or_gen_trials():
    if TRIALS_PATH.exists():
        rows = [json.loads(l) for l in TRIALS_PATH.open()]
        if len(rows) == 20:
            return rows
    rows = gen_trials()
    TRIALS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with TRIALS_PATH.open("w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    return rows


# ----------------------------------------------------------------------
# Seed install
# ----------------------------------------------------------------------
def setup_seeded_project(trial_id):
    ts = int(time.time() * 1000)
    raw_dir = f"/tmp/c2-seeded-{trial_id}-{ts}-{uuid.uuid4().hex[:6]}"
    os.makedirs(raw_dir, exist_ok=True)
    real_cwd = os.path.realpath(raw_dir)
    slug = real_cwd.replace("/", "-")
    proj_dir = Path.home() / ".claude" / "projects" / slug
    proj_dir.mkdir(parents=True, exist_ok=True)

    session_uuid = str(uuid.uuid4())
    ts_iso = "2026-06-04T00:00:00.000Z"
    out_path = proj_dir / f"{session_uuid}.jsonl"

    # Copy + verify chain integrity (parentUuid links)
    last_uuid = None
    written = 0
    with SEED_SRC.open() as fin, out_path.open("w") as fout:
        for line in fin:
            line2 = (line
                     .replace("{{SESSION_ID}}", session_uuid)
                     .replace("{{CWD}}", real_cwd)
                     .replace("{{TIMESTAMP_ISO}}", ts_iso))
            d = json.loads(line2)
            parent = d.get("parentUuid")
            this_uuid = d.get("uuid")
            if written == 0:
                if parent is not None:
                    raise RuntimeError(f"first line has parentUuid={parent}, expected None")
            else:
                if parent != last_uuid:
                    raise RuntimeError(
                        f"chain break at line {written}: parent={parent} expected {last_uuid}"
                    )
            fout.write(line2)
            if not line2.endswith("\n"):
                fout.write("\n")
            last_uuid = this_uuid
            written += 1
    if written < 40:
        raise RuntimeError(f"seed has only {written} lines (<40)")
    return real_cwd, session_uuid


# ----------------------------------------------------------------------
# Parallel claude -p
# ----------------------------------------------------------------------
async def claude_call(prompt, cwd=None, resume=None, sem=None, timeout=ARM_TIMEOUT):
    if sem is None:
        sem = asyncio.Semaphore(CONCURRENCY)
    async with sem:
        cmd = ["claude"]
        if resume:
            cmd += ["--resume", resume]
        cmd += ["-p", prompt]
        t0 = time.time()
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            except asyncio.TimeoutError:
                proc.kill()
                try:
                    await proc.communicate()
                except Exception:
                    pass
                return {"status": "TIMEOUT", "response": "__TIMEOUT__", "seconds": time.time() - t0}
            text = out.decode("utf-8", errors="replace").strip()
            if proc.returncode != 0:
                return {
                    "status": "ERROR",
                    "response": f"__ERROR__ rc={proc.returncode}: {text[:200]} | stderr={err.decode('utf-8', errors='replace')[:200]}",
                    "seconds": time.time() - t0,
                }
            return {"status": "OK", "response": text, "seconds": time.time() - t0}
        except Exception as e:
            return {"status": "ERROR", "response": f"__ERROR__: {e}", "seconds": time.time() - t0}


async def run_arms(trials):
    sem = asyncio.Semaphore(CONCURRENCY)
    tasks = []
    seeded_setups = {}

    # Set up SEEDED dirs (synchronous, cheap)
    print(f"[setup] installing {len(trials)} seeded sessions...", file=sys.stderr)
    for t in trials:
        cwd, sid = setup_seeded_project(t["trial_id"])
        seeded_setups[t["trial_id"]] = (cwd, sid)
    print(f"[setup] done", file=sys.stderr)

    # Build COLD + SEEDED tasks
    cold_meta = {}
    seeded_meta = {}
    for t in trials:
        tid = t["trial_id"]
        chain_json = json.dumps(t["chain"])
        cold_prompt = PROMPT_INSTRUCTION + "\n\n" + chain_json
        seeded_prompt = chain_json  # seed has primed it for this exact format
        cwd, sid = seeded_setups[tid]

        cold_task = asyncio.create_task(
            claude_call(cold_prompt, cwd="/tmp", sem=sem, timeout=ARM_TIMEOUT)
        )
        seeded_task = asyncio.create_task(
            claude_call(seeded_prompt, cwd=cwd, resume=sid, sem=sem, timeout=ARM_TIMEOUT)
        )
        cold_meta[tid] = cold_task
        seeded_meta[tid] = (seeded_task, cwd, sid)

    # Await all
    print(f"[arms] dispatched {len(trials) * 2} subprocesses (concurrency={CONCURRENCY})...", file=sys.stderr)
    results = []
    t_start = time.time()
    all_tasks = list(cold_meta.values()) + [s for s, _, _ in seeded_meta.values()]
    done = 0
    for fut in asyncio.as_completed(all_tasks):
        await fut
        done += 1
        if done % 5 == 0:
            print(f"[arms] {done}/{len(all_tasks)} done at {time.time()-t_start:.0f}s", file=sys.stderr)

    for t in trials:
        tid = t["trial_id"]
        cold_r = cold_meta[tid].result()
        seeded_task, cwd, sid = seeded_meta[tid]
        seeded_r = seeded_task.result()
        results.append({
            **t,
            "cold_status": cold_r["status"],
            "cold_response": cold_r["response"],
            "cold_seconds": round(cold_r["seconds"], 2),
            "seeded_status": seeded_r["status"],
            "seeded_response": seeded_r["response"],
            "seeded_seconds": round(seeded_r["seconds"], 2),
            "seeded_cwd": cwd,
            "seeded_uuid": sid,
        })
    return results


# ----------------------------------------------------------------------
# Judging
# ----------------------------------------------------------------------
def cheap_judge(gt, resp):
    r = (resp or "").strip()
    if r in ("__TIMEOUT__", "") or r.startswith("__ERROR__"):
        return "WRONG", "io_failure"
    if gt == "CLEAN":
        if re.fullmatch(r"\s*CLEAN\s*", r, re.IGNORECASE):
            return "CORRECT", "cheap_clean_exact"
        # if 'CLEAN' appears as sole standalone token
        toks = re.findall(r"[A-Za-z]+|-?\d+", r)
        if len(toks) == 1 and toks[0].upper() == "CLEAN":
            return "CORRECT", "cheap_clean_token"
        return None, "needs_llm"
    # gt int
    try:
        if int(r) == int(gt):
            return "CORRECT", "cheap_int_exact"
    except (ValueError, TypeError):
        pass
    nums = re.findall(r"-?\d+", r)
    if len(nums) == 1 and int(nums[0]) == int(gt):
        return "CORRECT", "cheap_int_single"
    if len(nums) == 1 and int(nums[0]) != int(gt):
        return "WRONG", "cheap_int_single_mismatch"
    if len(nums) == 0:
        return "WRONG", "cheap_no_int"
    return None, "needs_llm"


async def llm_judge_one(gt, resp, sem):
    prompt = JUDGE_PROMPT.format(gt=gt, resp=resp[:2000])
    r = await claude_call(prompt, cwd="/tmp", sem=sem, timeout=JUDGE_TIMEOUT)
    out = (r.get("response") or "").upper()
    # Parse first VERDICT line
    for line in out.splitlines():
        m = re.search(r"VERDICT:\s*(CORRECT|WRONG)", line)
        if m:
            return m.group(1)
    if "VERDICT: CORRECT" in out or out.endswith("CORRECT"):
        return "CORRECT"
    return "WRONG"


async def judge_all(rows):
    sem = asyncio.Semaphore(CONCURRENCY)
    pending = []  # (row_idx, arm, gt, resp)
    for i, row in enumerate(rows):
        gt = row["ground_truth"]
        for arm in ("cold", "seeded"):
            resp = row[f"{arm}_response"]
            v, reason = cheap_judge(gt, resp)
            if v is None:
                row[f"{arm}_verdict"] = None
                row[f"{arm}_judge_reason"] = reason
                pending.append((i, arm, gt, resp))
            else:
                row[f"{arm}_verdict"] = v
                row[f"{arm}_judge_reason"] = reason
    print(f"[judge] {len(pending)} pairs need LLM judge", file=sys.stderr)

    async def judge_task(i, arm, gt, resp):
        v = await llm_judge_one(gt, resp, sem)
        rows[i][f"{arm}_verdict"] = v
        rows[i][f"{arm}_judge_reason"] = "llm"

    tasks = [judge_task(i, arm, gt, resp) for i, arm, gt, resp in pending]
    if tasks:
        await asyncio.gather(*tasks)
    return rows


# ----------------------------------------------------------------------
# Stats + markdown
# ----------------------------------------------------------------------
def clopper_pearson(k, n, alpha=0.05):
    if n == 0:
        return (0.0, 0.0)
    # Use beta inverse via scipy if available, else hand-rolled binom search
    try:
        from scipy.stats import beta
        lo = beta.ppf(alpha / 2, k, n - k + 1) if k > 0 else 0.0
        hi = beta.ppf(1 - alpha / 2, k + 1, n - k) if k < n else 1.0
        return (float(lo), float(hi))
    except Exception:
        # Wilson fallback
        z = 1.96
        phat = k / n
        denom = 1 + z**2 / n
        center = (phat + z**2 / (2 * n)) / denom
        half = (z * math.sqrt((phat * (1 - phat) + z**2 / (4 * n)) / n)) / denom
        return (max(0.0, center - half), min(1.0, center + half))


def binom_pmf(k, n, p):
    if p == 0:
        return 1.0 if k == 0 else 0.0
    if p == 1:
        return 1.0 if k == n else 0.0
    log_coef = math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)
    return math.exp(log_coef + k * math.log(p) + (n - k) * math.log(1 - p))


def mcnemar_two_sided_exact(b, c):
    """Two-sided exact McNemar via binomial."""
    n = b + c
    if n == 0:
        return 1.0
    obs = min(b, c)
    # sum of pmfs <= pmf(obs) on either tail. For p=0.5, distribution is symmetric → 2 * cdf(obs)
    cdf = sum(binom_pmf(i, n, 0.5) for i in range(obs + 1))
    return min(1.0, 2 * cdf)


def render_md(rows, out_md, jsonl_name):
    n = len(rows)
    c_hits = sum(1 for r in rows if r["cold_verdict"] == "CORRECT")
    s_hits = sum(1 for r in rows if r["seeded_verdict"] == "CORRECT")
    b = sum(1 for r in rows if r["cold_verdict"] == "CORRECT" and r["seeded_verdict"] != "CORRECT")
    c = sum(1 for r in rows if r["seeded_verdict"] == "CORRECT" and r["cold_verdict"] != "CORRECT")
    both_right = sum(1 for r in rows if r["cold_verdict"] == "CORRECT" and r["seeded_verdict"] == "CORRECT")
    both_wrong = n - both_right - b - c

    cold_lo, cold_hi = clopper_pearson(c_hits, n)
    s_lo, s_hi = clopper_pearson(s_hits, n)
    delta_pp = (s_hits - c_hits) / n * 100
    p_two = mcnemar_two_sided_exact(b, c)

    if delta_pp >= 20 and p_two < 0.05:
        verdict = (
            f"C2 SUPPORTED (N=20 caveat): SEEDED − COLD = {delta_pp:+.0f}pp, "
            f"McNemar two-sided exact p={p_two:.3f}."
        )
    elif delta_pp >= 20 or p_two < 0.05:
        verdict = (
            f"C2 INCONCLUSIVE (N=20): SEEDED − COLD = {delta_pp:+.0f}pp, "
            f"McNemar two-sided exact p={p_two:.3f} — meets one criterion not both."
        )
    else:
        verdict = (
            f"C2 REJECTED at this family (N=20): SEEDED − COLD = {delta_pp:+.0f}pp, "
            f"McNemar two-sided exact p={p_two:.3f}."
        )

    lines = [
        "# C2 paired-arm chain-integrity: SEEDED vs COLD (N=20, parallel)",
        "",
        f"Input: `{jsonl_name}`",
        "",
        "## Hit rates",
        "",
        "| Arm | k | N | Hit-rate | 95% Clopper-Pearson CI |",
        "|---|---|---|---|---|",
        f"| COLD | {c_hits} | {n} | {c_hits/n:.1%} | [{cold_lo:.1%}, {cold_hi:.1%}] |",
        f"| SEEDED | {s_hits} | {n} | {s_hits/n:.1%} | [{s_lo:.1%}, {s_hi:.1%}] |",
        "",
        f"**Paired delta**: SEEDED − COLD = **{delta_pp:+.0f} pp**",
        "",
        "## McNemar contingency",
        "",
        "| Cell | Count |",
        "|---|---|",
        f"| both correct | {both_right} |",
        f"| seeded right, cold wrong (c) | {c} |",
        f"| cold right, seeded wrong (b) | {b} |",
        f"| both wrong | {both_wrong} |",
        "",
        f"- McNemar two-sided exact p = **{p_two:.4f}**",
        "",
        "## C2 read",
        "",
        verdict,
        "",
        "## Per-trial",
        "",
        "| t | L | GT | cold_status | cold | seeded_status | seeded | cV | sV |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        cold_disp = (r["cold_response"] or "")[:40].replace("|", "\\|").replace("\n", " ")
        seed_disp = (r["seeded_response"] or "")[:40].replace("|", "\\|").replace("\n", " ")
        lines.append(
            f"| {r['trial_id']} | {r['L']} | {r['ground_truth']} | "
            f"{r['cold_status']} | `{cold_disp}` | "
            f"{r['seeded_status']} | `{seed_disp}` | "
            f"{r['cold_verdict']} | {r['seeded_verdict']} |"
        )
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text("\n".join(lines) + "\n")
    return verdict, c_hits, s_hits, delta_pp, p_two


# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------
async def amain():
    if not SEED_SRC.exists():
        print(f"FATAL: seed missing at {SEED_SRC}", file=sys.stderr)
        sys.exit(2)
    trials = load_or_gen_trials()
    print(f"[trials] N={len(trials)}, GTs={[t['ground_truth'] for t in trials]}", file=sys.stderr)

    t0 = time.time()
    rows = await run_arms(trials)
    print(f"[arms] complete in {time.time()-t0:.0f}s", file=sys.stderr)

    print(f"[judge] starting...", file=sys.stderr)
    tj = time.time()
    rows = await judge_all(rows)
    print(f"[judge] complete in {time.time()-tj:.0f}s", file=sys.stderr)

    ts = int(time.time())
    out_jsonl = ROOT / "runs" / f"c2_parallel_{ts}.jsonl"
    out_jsonl.parent.mkdir(parents=True, exist_ok=True)
    with out_jsonl.open("w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")

    out_md = ROOT / "docs" / "c2_results.md"
    verdict, c_hits, s_hits, dpp, p_two = render_md(rows, out_md, out_jsonl.name)
    print(f"\n[result] COLD {c_hits}/20  SEEDED {s_hits}/20  Δ={dpp:+.0f}pp  McNemar 2s p={p_two:.4f}", file=sys.stderr)
    print(f"[result] {verdict}", file=sys.stderr)
    print(f"[result] jsonl: {out_jsonl}", file=sys.stderr)
    print(f"[result] md:    {out_md}", file=sys.stderr)
    print(f"[result] wall:  {time.time()-t0:.0f}s", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(amain())
