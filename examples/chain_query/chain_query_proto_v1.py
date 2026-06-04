#!/usr/bin/env python3
"""chain_query proto v1 — category-filtered variant.

Adds a text-proxy classifier mirroring chain_keeper.categorize_kind
(chime / ack / presence / settlement / other) and re-runs the four
primitives filtered to category=chime, excluding response-acks and
presence-ticks.

v0  : no category filter; counts everything
v1  : text-proxy chime-only filter; partial confound resolution
v2  : chain-truth via categorize_kind on typed events; clean
"""
import json, re, sys, time, argparse
from pathlib import Path

INBOX = Path.home() / ".eir" / "inbox_studio.jsonl"
USER_TO_ANT = {
    "U08B16PSMB2": "eugene",
    "U0AVC14NPQV": "miles",
    "U0AVC0GSQP7": "cajal",
    "U0B0VQ30RTJ": "subhuti",
    "U0AVDD12TCN": "groove",
    "U0B00U8EH0C": "lighthouse",
}

PATTERNS = {
    "prereg_seal": re.compile(r"\b(pre[-_ ]?reg|prereg|sealed.*claim|kill[_ -]?condition|apoha)\b", re.I),
    "empirical_run": re.compile(r"\b(ran|measured|N=\d+|eigenvals?|spearman|empirical|test ran|results)\b", re.I),
    "verdict": re.compile(r"\b(PASS|FAIL|RIPENED|KILL[- _]?FIRED|kill_fired|failed_at|incomplete_to|verdict)\b"),
    "amendment": re.compile(r"\b(amend|Amendment \d+|standard.*updated|demoted|revised)\b", re.I),
    "cycle_close": re.compile(r"\b(cycle.*closed|sealed for|methodology cadence.*sealed|ratchet[- ]?tooth)\b", re.I),
}

# Text-proxy mirror of chain_keeper.categorize_kind. The chain treats CATEGORIES
# as the partition; here we derive a category per inbox message by text shape.
PRESENCE_PAT = re.compile(r"^\s*(·|:saxophone:|:chains:|tick|miles-tick|heartbeat|miles_tick)+\s*$", re.I)
ACK_OPENERS = re.compile(r"^\s*(yes|noted|heard|caught|ack|copy|ok|got it|:white_check_mark:|:thumbsup:|:heavy_check_mark:)\b", re.I)
SETTLEMENT_PAT = re.compile(r"\b(external_verdict_source|mint fires|first mint|settlement event|PASS.*from rob|rob.*PASS)\b", re.I)

def categorize_text(txt: str) -> str:
    """Text-proxy classifier mirroring chain_keeper's category schema."""
    t = txt.strip()
    if not t: return "other"
    if PRESENCE_PAT.match(t) or len(t) <= 4: return "presence"
    if SETTLEMENT_PAT.search(t): return "settlement"
    if ACK_OPENERS.match(t) and len(t) < 60: return "ack"
    # short single-line replies that look reactive
    if len(t) <= 40 and "\n" not in t and not any(p.search(t) for p in PATTERNS.values()):
        return "ack"
    return "chime"

def text_of(ev):
    if isinstance(ev, dict):
        for k in ("text", "body", "message", "content"):
            if k in ev and isinstance(ev[k], str): return ev[k]
    return ""

def ts_of(ev):
    if isinstance(ev, dict):
        for k in ("ts", "timestamp", "time", "created_at"):
            if k in ev and ev[k]:
                try: return float(ev[k])
                except: pass
    return None

def load_events(window_sec, category_filter=None):
    now = time.time()
    out = []
    with INBOX.open() as f:
        for line in f:
            try: ev = json.loads(line)
            except: continue
            t = ts_of(ev); txt = text_of(ev)
            u = ev.get("user") if isinstance(ev, dict) else None
            if t is None or now - t > window_sec: continue
            ant = USER_TO_ANT.get(u)
            if not ant or not txt: continue
            cat = categorize_text(txt)
            if category_filter and cat not in category_filter: continue
            kinds = [k for k, rx in PATTERNS.items() if rx.search(txt)]
            out.append((t, ant, txt, kinds, cat))
    out.sort()
    return out

def preregs_by_voice(events, voice):
    return [(t, txt[:200]) for t, a, txt, kinds, c in events
            if a == voice and "prereg_seal" in kinds]

def completed_cycles(events, voice):
    cycles = []
    for i, (t, a, txt, kinds, c) in enumerate(events):
        if a != voice or "prereg_seal" not in kinds: continue
        empirical = None; verdict = None
        for tj, aj, txtj, kindsj, cj in events[i+1:]:
            if aj != voice: continue
            if empirical is None and "empirical_run" in kindsj: empirical = (tj, txtj[:100])
            if "verdict" in kindsj: verdict = (tj, txtj[:100]); break
            if tj - t > 3 * 3600: break
        if empirical and verdict:
            cycles.append({"prereg_ts": t, "prereg_summary": txt[:100],
                           "empirical_ts": empirical[0], "verdict_ts": verdict[0],
                           "verdict_summary": verdict[1],
                           "duration_min": (verdict[0] - t) / 60})
    return cycles

def falsification_rate(events, voice):
    verdicts = [(t, txt) for t, a, txt, kinds, c in events
                if a == voice and "verdict" in kinds]
    if not verdicts: return None
    kill_pat = re.compile(r"\b(FAIL|KILL[- _]?FIRED|kill_fired|failed_at|RIPENED_?DIFFERENTLY)\b")
    falsified = sum(1 for _, txt in verdicts if kill_pat.search(txt))
    return {"n_verdicts": len(verdicts), "n_falsified": falsified,
            "falsification_rate": round(falsified / len(verdicts), 3)}

def per_voice_table(events):
    voices = sorted({a for _, a, _, _, _ in events})
    return {v: {
        "n_events": sum(1 for _, a, *_ in events if a == v),
        "n_preregs": len(preregs_by_voice(events, v)),
        "n_completed_cycles": len(completed_cycles(events, v)),
        "falsification": falsification_rate(events, v),
    } for v in voices}

def category_distribution(events):
    out = {}
    for _, a, _, _, c in events:
        out.setdefault(a, {}).setdefault(c, 0)
        out[a][c] += 1
    return out

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--window-hours", type=float, default=24.0)
    args = p.parse_args()

    all_evs = load_events(args.window_hours * 3600)
    chime_evs = [e for e in all_evs if e[4] == "chime"]
    print(f"# v0 (no filter): n={len(all_evs)} | v1 (chime only): n={len(chime_evs)}",
          file=sys.stderr)

    out = {
        "schema": "miles.chain_query.proto.v1.stage1",
        "window_hours": args.window_hours,
        "v0_no_filter": {
            "n_total": len(all_evs),
            "category_distribution": category_distribution(all_evs),
            "per_voice": per_voice_table(all_evs),
        },
        "v1_chime_only": {
            "n_total": len(chime_evs),
            "per_voice": per_voice_table(chime_evs),
        },
    }
    print(json.dumps(out, indent=2, default=str))

if __name__ == "__main__":
    main()
