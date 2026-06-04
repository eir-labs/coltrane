#!/usr/bin/env python3
"""chain_query proto v0 — backward-queryability primitives over an inbox chain.

Four read-side queries over ~/.eir/inbox_studio.jsonl. Methodology kinds are
derived by regex from message text; voice attribution comes from user_id.

- registrations_by_agent(voice, window)
- completed_cycles(voice, window)
- falsification_rate(voice, window)
- cycle_lineage(verdict_index)

When typed event_kinds reach the read source, swap text-proxy for chain-truth.
"""
import json, re, sys, time, argparse
from pathlib import Path
from statistics import median

INBOX = Path.home() / ".eir" / "inbox_studio.jsonl"
AGENT_LABELS = {
    # Slack user_id → logical agent label. Replace these with your own
    # agent identifiers; the proto reads `text` + `user` from each line of
    # inbox_studio.jsonl and resolves the user to a label for grouping.
    "U08B16PSMB2": "principal",
    "U0AVC14NPQV": "agent_a",
    "U0AVC0GSQP7": "agent_b",
    "U0B0VQ30RTJ": "agent_c",
    "U0AVDD12TCN": "agent_d",
    "U0B00U8EH0C": "agent_e",
}

# Text-proxy patterns for the 5 methodology event_kinds
PATTERNS = {
    "registration": re.compile(r"\b(pre[-_ ]?reg|registration|sealed.*claim|kill[_ -]?condition|)\b", re.I),
    "test_run": re.compile(r"\b(ran|measured|N=\d+|eigenvals?|spearman|empirical|test ran|results)\b", re.I),
    "verdict": re.compile(r"\b(PASS|FAIL|RIPENED|KILL[- _]?FIRED|kill_fired|failed_at|incomplete_to|verdict)\b"),
    "amendment": re.compile(r"\b(amend|Amendment \d+|standard.*updated|demoted|revised)\b", re.I),
    "cycle_close": re.compile(r"\b(cycle.*closed|sealed for|test cycle.*sealed|credit-step)\b", re.I),
}

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

def load_events(window_sec):
    now = time.time()
    out = []
    with INBOX.open() as f:
        for line in f:
            try: ev = json.loads(line)
            except: continue
            t = ts_of(ev); txt = text_of(ev)
            u = ev.get("user") if isinstance(ev, dict) else None
            if t is None or now - t > window_sec: continue
            ant = AGENT_LABELS.get(u)
            if not ant or not txt: continue
            kinds = [k for k, rx in PATTERNS.items() if rx.search(txt)]
            out.append((t, ant, txt, kinds))
    out.sort()
    return out

def registrations_by_agent(events, voice):
    """Q1: list of registration-like events by voice."""
    return [(t, txt[:200]) for t, a, txt, kinds in events
            if a == voice and "registration" in kinds]

def completed_cycles(events, voice):
    """Q2: chains of (registration → empirical → verdict) within the voice's stream."""
    cycles = []
    for i, (t, a, txt, kinds) in enumerate(events):
        if a != voice or "registration" not in kinds: continue
        # walk forward looking for test_run + verdict
        empirical = None; verdict = None
        for tj, aj, txtj, kindsj in events[i+1:]:
            if aj != voice: continue
            if empirical is None and "test_run" in kindsj: empirical = (tj, txtj[:100])
            if "verdict" in kindsj: verdict = (tj, txtj[:100]); break
            if tj - t > 3 * 3600: break  # 3hr cycle window
        if empirical and verdict:
            cycles.append({
                "registration_ts": t,
                "registration_summary": txt[:100],
                "empirical_ts": empirical[0],
                "verdict_ts": verdict[0],
                "verdict_summary": verdict[1],
                "duration_min": (verdict[0] - t) / 60,
            })
    return cycles

def falsification_rate(events, voice):
    """Q3: ratio of verdict-events that name a kill or failure."""
    verdicts = [(t, txt) for t, a, txt, kinds in events
                if a == voice and "verdict" in kinds]
    if not verdicts: return None
    kill_pat = re.compile(r"\b(FAIL|KILL[- _]?FIRED|kill_fired|failed_at|RIPENED_?DIFFERENTLY)\b")
    falsified = sum(1 for _, txt in verdicts if kill_pat.search(txt))
    return {"n_verdicts": len(verdicts), "n_falsified": falsified,
            "falsification_rate": round(falsified / len(verdicts), 3)}

def cycle_lineage(events, verdict_index, lookback_hours=2):
    """Q4: walk backward from a verdict-event finding likely-causing prior chimes."""
    if verdict_index >= len(events): return None
    t, a, txt, kinds = events[verdict_index]
    if "verdict" not in kinds: return None
    cutoff = t - lookback_hours * 3600
    lineage = []
    for tj, aj, txtj, kindsj in reversed(events[:verdict_index]):
        if tj < cutoff: break
        # surface events that share a methodology kind
        if any(k in kinds or k in ("registration", "test_run") for k in kindsj):
            lineage.append({
                "ts": tj, "ant": aj, "kinds": kindsj,
                "summary": txtj[:100], "delta_min": (t - tj) / 60,
            })
        if len(lineage) >= 10: break
    return {"verdict_ts": t, "verdict_summary": txt[:100],
            "n_lineage_events": len(lineage), "lineage": lineage}

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--window-hours", type=float, default=24.0)
    p.add_argument("--agent", default="agent_a")
    args = p.parse_args()

    events = load_events(args.window_hours * 3600)
    print(f"# loaded {len(events)} events in last {args.window_hours}h", file=sys.stderr)

    out = {
        "schema": "chain_query.proto.v0",
        "window_hours": args.window_hours,
        "agent": args.agent,
        "n_total_events": len(events),
        "q1_registrations": registrations_by_agent(events, args.agent),
        "q2_completed_cycles": completed_cycles(events, args.agent),
        "q3_falsification_rate": falsification_rate(events, args.agent),
    }
    # cycle_lineage: find latest verdict event by voice and walk back
    verdict_indices = [i for i, (t, a, txt, k) in enumerate(events)
                       if a == args.agent and "verdict" in k]
    if verdict_indices:
        out["q4_cycle_lineage_latest_verdict"] = cycle_lineage(events, verdict_indices[-1])
    print(json.dumps(out, indent=2, default=str))

if __name__ == "__main__":
    main()
