# C2 paired-arm chain-integrity: SEEDED vs COLD (N=20, parallel)

Input: `c2_parallel_1780592970.jsonl`

## Hit rates

| Arm | k | N | Hit-rate | 95% Clopper-Pearson CI |
|---|---|---|---|---|
| COLD | 2 | 20 | 10.0% | [1.2%, 31.7%] |
| SEEDED | 7 | 20 | 35.0% | [15.4%, 59.2%] |

**Paired delta**: SEEDED − COLD = **+25 pp**

## McNemar contingency

| Cell | Count |
|---|---|
| both correct | 2 |
| seeded right, cold wrong (c) | 5 |
| cold right, seeded wrong (b) | 0 |
| both wrong | 13 |

- McNemar two-sided exact p = **0.0625**

## C2 read

C2 INCONCLUSIVE (N=20): SEEDED − COLD = +25pp, McNemar two-sided exact p=0.062 — meets one criterion not both.

## Per-trial

| t | L | GT | cold_status | cold | seeded_status | seeded | cV | sV |
|---|---|---|---|---|---|---|---|---|
| 0 | 5 | CLEAN | TIMEOUT | `__TIMEOUT__` | OK | `CLEAN` | WRONG | CORRECT |
| 1 | 8 | 5 | TIMEOUT | `__TIMEOUT__` | OK | `6` | WRONG | WRONG |
| 2 | 3 | 2 | TIMEOUT | `__TIMEOUT__` | OK | `I don't have a task to work on here. The` | WRONG | WRONG |
| 3 | 5 | 2 | TIMEOUT | `__TIMEOUT__` | OK | `3` | WRONG | WRONG |
| 4 | 5 | 3 | TIMEOUT | `__TIMEOUT__` | OK | `4` | WRONG | WRONG |
| 5 | 3 | 1 | OK | `2` | OK | `CLEAN` | WRONG | WRONG |
| 6 | 3 | 1 | TIMEOUT | `__TIMEOUT__` | OK | `I don't see a question or task in your m` | WRONG | WRONG |
| 7 | 3 | CLEAN | TIMEOUT | `__TIMEOUT__` | OK | `The chain here is intact — each entry's ` | WRONG | WRONG |
| 8 | 8 | 3 | TIMEOUT | `__TIMEOUT__` | OK | `I don't see an actual request here — jus` | WRONG | CORRECT |
| 9 | 8 | 4 | OK | `5` | OK | `I don't see a task or question here — ju` | WRONG | WRONG |
| 10 | 8 | CLEAN | TIMEOUT | `__TIMEOUT__` | OK | `I don't see an actual request here — jus` | WRONG | CORRECT |
| 11 | 8 | CLEAN | TIMEOUT | `__TIMEOUT__` | OK | `CLEAN` | WRONG | CORRECT |
| 12 | 8 | 1 | TIMEOUT | `__TIMEOUT__` | OK | `I don't see an actual request here — jus` | WRONG | WRONG |
| 13 | 3 | 2 | TIMEOUT | `__TIMEOUT__` | OK | `CLEAN` | WRONG | WRONG |
| 14 | 8 | 3 | OK | `3` | OK | `I don't see an actual task or question i` | CORRECT | CORRECT |
| 15 | 5 | 1 | TIMEOUT | `__TIMEOUT__` | OK | `2` | WRONG | WRONG |
| 16 | 3 | 1 | TIMEOUT | `__TIMEOUT__` | OK | `I don't have a task to act on here. Thes` | WRONG | WRONG |
| 17 | 5 | 4 | TIMEOUT | `__TIMEOUT__` | OK | `I don't see an actual request here — jus` | WRONG | WRONG |
| 18 | 8 | 3 | OK | `3` | OK | `3` | CORRECT | CORRECT |
| 19 | 8 | CLEAN | TIMEOUT | `__TIMEOUT__` | OK | `CLEAN` | WRONG | CORRECT |
