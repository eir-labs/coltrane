# C2 paired-arm chain-integrity: seeded-vs-cold (N=20)

Generated: c2_summary.py  ·  Input: `c2_judged_1780592018.jsonl`

## Hit rates

| Arm | Correct | N | Hit-rate | 95% Wilson CI |
|---|---|---|---|---|
| COLD | 5 | 20 | 25.0% | [11.2%, 46.9%] |
| SEEDED | 1 | 20 | 5.0% | [0.9%, 23.6%] |

**Paired delta**: SEEDED − COLD = -20 percentage points

## McNemar (paired design)

| Cell | Count |
|---|---|
| both correct | 0 |
| seeded right, cold wrong (c) | 1 |
| cold right, seeded wrong (b) | 5 |
| both wrong | 14 |

- Two-sided exact McNemar p = **0.219**
- One-sided (seeded > cold) exact p = **0.984**

## C2 verdict

C2 NOT SUPPORTED at this family: SEEDED − COLD = -20 pts, McNemar one-sided p=0.984; fails both threshold and significance.

## Per-trial table

| trial | L | GT | cold | seeded | cold V | seeded V |
|---|---|---|---|---|---|---|
| 0 | 5 | CLEAN | `All my attempts to execute the` | `CLEAN` | WRONG | CORRECT |
| 1 | 8 | 5 | `6` | `I don't see an actual request ` | WRONG | WRONG |
| 2 | 3 | 2 | `All my attempts to execute a h` | `I don't see a task or question` | WRONG | WRONG |
| 3 | 5 | 2 | `3` | `I don't see an actual request ` | WRONG | WRONG |
| 4 | 5 | 3 | `__TIMEOUT__` | `I don't see an actual request ` | WRONG | WRONG |
| 5 | 3 | 1 | `2` | `CLEAN` | WRONG | WRONG |
| 6 | 3 | 1 | `2` | `2` | WRONG | WRONG |
| 7 | 3 | CLEAN | `I'm blocked from executing — e` | `I don't see an actual task or ` | WRONG | WRONG |
| 8 | 8 | 3 | `3` | `I don't see an actual question` | CORRECT | WRONG |
| 9 | 8 | 4 | `5` | `I don't see an actual request ` | WRONG | WRONG |
| 10 | 8 | CLEAN | `__TIMEOUT__` | `I don't have a task to work on` | WRONG | WRONG |
| 11 | 8 | CLEAN | `__TIMEOUT__` | `I don't have a task to work on` | WRONG | WRONG |
| 12 | 8 | 1 | `2` | `I don't see an actual task or ` | WRONG | WRONG |
| 13 | 3 | 2 | `2` | `I don't see an actual request ` | CORRECT | WRONG |
| 14 | 8 | 3 | `3` | `I don't see an actual request ` | CORRECT | WRONG |
| 15 | 5 | 1 | `2` | `I don't have a genuine task to` | WRONG | WRONG |
| 16 | 3 | 1 | `1` | `I don't see an actual task or ` | CORRECT | WRONG |
| 17 | 5 | 4 | `The execution environment is d` | `I want to be straight with you` | WRONG | WRONG |
| 18 | 8 | 3 | `3` | `I don't see an actual request ` | CORRECT | WRONG |
| 19 | 8 | CLEAN | `__TIMEOUT__` | `Linkage and sequence both veri` | WRONG | WRONG |
