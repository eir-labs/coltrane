#!/usr/bin/env python3
"""Run COLD and SEEDED arms for C2 paired test.

For each trial:
  COLD: claude -p with chain JSON
  SEEDED: install subhuti's chain-integrity-tester.jsonl into a temp project
          and claude --resume <uuid> -p "<chain>"
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


SEED_SRC = Path("/tmp/seed-drafts/chain-integrity-tester.jsonl")
PROMPT_INSTRUCTION = (
    "You are verifying a hash chain. Each event has i, kind, prev_sha, sha_seal. "
    "sha_seal = sha256(canonical_json of event without sha_seal field, sorted keys, "
    "no whitespace). prev_sha[0] = \"GENESIS\"; prev_sha[i] = sha_seal[i-1]. "
    "Find the first index where verification fails. "
    "Reply with EXACTLY one token: the integer broken index, or the literal word CLEAN. "
    "No explanation, no whitespace, no other text.\n\n"
)


def claude_run(prompt: str, resume_uuid: str = None, cwd: str = None) -> str:
    cmd = ["claude", "-p"]
    if resume_uuid:
        cmd = ["claude", "--resume", resume_uuid, "-p"]
    cmd.append(prompt)
    try:
        r = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=180,
        )
        return r.stdout.strip()
    except subprocess.TimeoutExpired:
        return "__TIMEOUT__"
    except Exception as e:
        return f"__ERROR__: {e}"


def setup_seeded_project() -> tuple[str, str]:
    """Create a temp project dir, install seed JSONL with rewritten uuids.

    Returns (cwd_realpath, session_uuid).
    """
    ts = int(time.time() * 1000)
    raw_dir = f"/tmp/c2-seed-{ts}-{uuid.uuid4().hex[:8]}"
    os.makedirs(raw_dir, exist_ok=True)
    real_cwd = os.path.realpath(raw_dir)  # /private/tmp/...
    # slug: replace / with -
    slug = real_cwd.replace("/", "-")
    proj_dir = Path.home() / ".claude" / "projects" / slug
    proj_dir.mkdir(parents=True, exist_ok=True)

    session_uuid = str(uuid.uuid4())
    cwd_for_seed = real_cwd
    ts_iso = "2026-06-04T00:00:00.000Z"

    out_path = proj_dir / f"{session_uuid}.jsonl"
    with SEED_SRC.open() as fin, out_path.open("w") as fout:
        for line in fin:
            line = line.replace("{{SESSION_ID}}", session_uuid)
            line = line.replace("{{CWD}}", cwd_for_seed)
            line = line.replace("{{TIMESTAMP_ISO}}", ts_iso)
            fout.write(line)
    return real_cwd, session_uuid


def main():
    trials_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])

    trials = [json.loads(l) for l in trials_path.open()]
    print(f"Loaded {len(trials)} trials", file=sys.stderr)

    results = []
    for t in trials:
        tid = t["trial_id"]
        chain_json = json.dumps(t["chain"], separators=(",", ":"))
        gt = t["ground_truth"]
        print(f"[trial {tid}] L={t['L']} GT={gt}", file=sys.stderr)

        # COLD arm
        cold_prompt = PROMPT_INSTRUCTION + chain_json
        t0 = time.time()
        cold_resp = claude_run(cold_prompt)
        cold_dt = time.time() - t0
        print(f"  COLD ({cold_dt:.1f}s): {cold_resp!r}", file=sys.stderr)

        # SEEDED arm: fresh project per trial
        seeded_cwd, seeded_uuid = setup_seeded_project()
        # seeded just gets the bare chain JSON, like the seed turns did
        seeded_prompt = chain_json
        t0 = time.time()
        seeded_resp = claude_run(seeded_prompt, resume_uuid=seeded_uuid, cwd=seeded_cwd)
        seeded_dt = time.time() - t0
        print(f"  SEEDED ({seeded_dt:.1f}s): {seeded_resp!r}", file=sys.stderr)

        results.append({
            "trial_id": tid,
            "L": t["L"],
            "ground_truth": gt,
            "tamper_idx": t.get("tamper_idx"),
            "tamper_mode": t.get("tamper_mode"),
            "chain": t["chain"],
            "cold_response": cold_resp,
            "cold_seconds": round(cold_dt, 2),
            "seeded_response": seeded_resp,
            "seeded_seconds": round(seeded_dt, 2),
            "seeded_cwd": seeded_cwd,
            "seeded_uuid": seeded_uuid,
        })

        # append incrementally so we don't lose work
        with out_path.open("a") as f:
            f.write(json.dumps(results[-1]) + "\n")

    print(f"Done. Wrote {len(results)} rows to {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
