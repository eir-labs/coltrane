#!/usr/bin/env python3
"""Generate 20 hash-chain trials for C2 paired-arm test.

Each trial:
- Length L ∈ {3, 5, 8} uniform
- prev_sha[0] = "GENESIS"
- sha_seal[i] = sha256(canonical_json(event_without_seal))
- prev_sha[i] = sha_seal[i-1] for i > 0
- With prob 0.75: introduce ONE tamper (50/50 sha_seal vs prev_sha mismatch)
- Ground truth: first index where verification fails, or "CLEAN"
"""
import json
import hashlib
import random
import sys
from pathlib import Path

random.seed(20260604)

KINDS = ["tuning", "passage", "bridge", "coda", "intro", "verse"]


def canonical_no_seal(event: dict) -> str:
    e = {k: v for k, v in event.items() if k != "sha_seal"}
    return json.dumps(e, sort_keys=True, separators=(",", ":"))


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def build_clean_chain(L: int) -> list:
    chain = []
    prev = "GENESIS"
    for i in range(L):
        ev = {"i": i, "kind": random.choice(KINDS), "prev_sha": prev}
        seal = sha(canonical_no_seal(ev))
        ev["sha_seal"] = seal
        chain.append(ev)
        prev = seal
    return chain


def verify(chain: list):
    """Return first broken index or 'CLEAN'."""
    for i, ev in enumerate(chain):
        expected_prev = "GENESIS" if i == 0 else chain[i - 1]["sha_seal"]
        if ev["prev_sha"] != expected_prev:
            return i
        expected_seal = sha(canonical_no_seal(ev))
        if ev["sha_seal"] != expected_seal:
            return i
    return "CLEAN"


def random_hex64() -> str:
    return "".join(random.choice("0123456789abcdef") for _ in range(64))


def tamper(chain: list):
    L = len(chain)
    idx = random.randint(1, L - 1)
    mode = random.choice(["sha_seal", "prev_sha"])
    if mode == "sha_seal":
        chain[idx]["sha_seal"] = random_hex64()
    else:
        chain[idx]["prev_sha"] = random_hex64()
    return idx, mode


def main():
    out_path = Path(sys.argv[1])
    trials = []
    for tid in range(20):
        L = random.choice([3, 5, 8])
        chain = build_clean_chain(L)
        do_tamper = random.random() < 0.75
        if do_tamper:
            idx, mode = tamper(chain)
        else:
            idx, mode = None, None
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
    with out_path.open("w") as f:
        for t in trials:
            f.write(json.dumps(t) + "\n")
    # also print summary
    n_clean = sum(1 for t in trials if t["ground_truth"] == "CLEAN")
    print(f"Wrote {len(trials)} trials to {out_path}", file=sys.stderr)
    print(f"  CLEAN: {n_clean}  TAMPERED: {len(trials) - n_clean}", file=sys.stderr)
    print(f"  Lengths: {[t['L'] for t in trials]}", file=sys.stderr)
    print(f"  GTs: {[t['ground_truth'] for t in trials]}", file=sys.stderr)


if __name__ == "__main__":
    main()
