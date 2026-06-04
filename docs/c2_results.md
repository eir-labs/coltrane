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

---

# C2 paired-arm chain-integrity: SEEDED vs COLD (N=30, parallel, bash-parity)

Input: `c2_parallel_1780593497.jsonl`

COLD-arm fix: prepended explicit in-head reasoning instruction to remove bash-refusal confound.

## Hit rates

| Arm | k | N | Hit-rate | 95% Clopper-Pearson CI |
|---|---|---|---|---|
| COLD | 10 | 30 | 33.3% | [17.3%, 52.8%] |
| SEEDED | 11 | 30 | 36.7% | [19.9%, 56.1%] |

**Paired delta**: SEEDED − COLD = **+3 pp**

## Refusal counts (bash-parity check)

| Arm | refusals | rate |
|---|---|---|
| COLD | 0 | 0.0% |
| SEEDED | 2 | 6.7% |

### Hit rate among non-refusing COLD trials (30/30)

| Arm | k | N_nonref | Hit-rate |
|---|---|---|---|
| COLD | 10 | 30 | 33.3% |
| SEEDED | 11 | 30 | 36.7% |

## McNemar contingency

| Cell | Count |
|---|---|
| both correct | 8 |
| seeded right, cold wrong (c) | 3 |
| cold right, seeded wrong (b) | 2 |
| both wrong | 17 |

- McNemar two-sided exact p = **1.0000**

## C2 read

C2 REJECTED at this family (N=30, bash-parity): SEEDED − COLD = +3pp, McNemar two-sided exact p=1.0000.

## Per-trial

| t | L | GT | cold_status | cold | seeded_status | seeded | cV | sV | cRef |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 5 | CLEAN | OK | `CLEAN` | OK | `CLEAN` | CORRECT | CORRECT |  |
| 1 | 8 | 5 | OK | `CLEAN` | OK | `I don't have a task to work on here. The` | WRONG | WRONG |  |
| 2 | 3 | 2 | OK | `CLEAN` | OK | `CLEAN` | WRONG | WRONG |  |
| 3 | 5 | 2 | OK | `CLEAN` | OK | `3` | WRONG | WRONG |  |
| 4 | 5 | 3 | OK | `4` | OK | `4` | WRONG | WRONG |  |
| 5 | 3 | 1 | OK | `CLEAN` | OK | `CLEAN` | WRONG | WRONG |  |
| 6 | 3 | 1 | OK | `CLEAN` | OK | `2` | WRONG | WRONG |  |
| 7 | 3 | CLEAN | OK | `CLEAN` | OK | `CLEAN` | CORRECT | CORRECT |  |
| 8 | 8 | 3 | OK | `CLEAN` | OK | `I don't see a task or question in your m` | WRONG | WRONG |  |
| 9 | 8 | 4 | OK | `CLEAN` | OK | `I don't see an actual question or task i` | WRONG | WRONG |  |
| 10 | 8 | CLEAN | OK | `CLEAN` | OK | `I don't have an actual instruction to wo` | CORRECT | CORRECT |  |
| 11 | 8 | CLEAN | OK | `CLEAN` | OK | `CLEAN` | CORRECT | CORRECT |  |
| 12 | 8 | 1 | OK | `CLEAN` | OK | `I don't see a question or task in your m` | WRONG | WRONG |  |
| 13 | 3 | 2 | OK | `CLEAN` | OK | `I don't have a task to work on here. The` | WRONG | CORRECT |  |
| 14 | 8 | 3 | OK | `CLEAN` | OK | `I don't see an actual request here — jus` | WRONG | WRONG |  |
| 15 | 5 | 1 | OK | `2` | OK | `2` | WRONG | WRONG |  |
| 16 | 3 | 1 | OK | `CLEAN` | OK | `I don't have any context for what these ` | WRONG | WRONG |  |
| 17 | 5 | 4 | OK | `CLEAN` | OK | `4` | WRONG | CORRECT |  |
| 18 | 8 | 3 | OK | `3` | OK | `I don't see an actual request here — jus` | CORRECT | WRONG |  |
| 19 | 8 | CLEAN | OK | `CLEAN` | OK | `I don't see a task or question in these ` | CORRECT | CORRECT |  |
| 20 | 3 | 1 | OK | `CLEAN` | OK | `I don't see a task or question in your m` | WRONG | WRONG |  |
| 21 | 3 | CLEAN | OK | `CLEAN` | OK | `CLEAN` | CORRECT | CORRECT |  |
| 22 | 3 | 2 | OK | `CLEAN` | OK | `CLEAN` | WRONG | WRONG |  |
| 23 | 8 | 7 | OK | `CLEAN` | OK | `I don't see an actual question or task h` | WRONG | WRONG |  |
| 24 | 8 | 3 | OK | `CLEAN` | OK | `I don't see an actual request here — jus` | WRONG | WRONG |  |
| 25 | 5 | CLEAN | OK | `CLEAN` | OK | `CLEAN` | CORRECT | CORRECT |  |
| 26 | 3 | CLEAN | OK | `CLEAN` | OK | `CLEAN` | CORRECT | CORRECT |  |
| 27 | 3 | 2 | OK | `2` | OK | `I don't have an actual task or question ` | CORRECT | WRONG |  |
| 28 | 8 | 7 | OK | `CLEAN` | OK | `I don't see an actual request in your me` | WRONG | WRONG |  |
| 29 | 5 | 2 | OK | `CLEAN` | OK | `2` | WRONG | CORRECT |  |
