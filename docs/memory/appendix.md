# Evidence index

**Status:** shipped reference · **Last verified:** 2026-11 ·
Terminology: [glossary](reading-guide.md#glossary)

Every measured claim used in this book, pinned to its permanent source
(file + section). Character-exact quotes; line numbers are intentionally
**not** pinned (they drift — see [`maintenance.md`](maintenance.md)).

---

## Ledger

| # | Claim (character-exact) | Where used | Source |
|---|---|---|---|
| E1 | "18 explicit paraphrase pairs (≥0.92) — ~10% of the store" | README, 2.6, 13-migration | whitepaper §5.10 (`docs/research/memory-dreaming-whitepaper.md`) |
| E2 | c1 (multi-hop): obs-only 75/282 = 26.6% → obs+dreams 93/282 = 33.0% (+6.4 pts, +24% relative; sign-test on 10 convs p ≈ 0.008) | README, overview, 06-dreaming | whitepaper §5.13 |
| E3 | "615 vetted dream facts" — 411 entailed / 204 plausible / 0 unsupported; 80 toxic groups screened | 06-dreaming, 14-threat-model | whitepaper §5.13 |
| E4 | "840 candidates, 0 unsupported" (cumulative across runs: 144 seeded + 60 real + 21 cross-user + 615 LoCoMo) | 06-dreaming, 14-threat-model | whitepaper §5.9–§5.13 totals |
| E5 | Judge-calibration battery: "68 judged items, 0/24" unsupported→entailed (one-sided 95% CI [0, 12%]); 18/18 supported certified — authored-truth battery, n=54 section | 03-gates, 14-threat-model | whitepaper §5.11 |
| E6 | Claim-level precision: "35 entailed / 10 plausible / 1 unsupported across 46 claims" | 06-dreaming, 11-shared-distillation | whitepaper §5.12 |
| E7 | Tiers in cross-user rerun: SHARED 1 / PERSONAL 16 / DROP 1 | 06-dreaming, 11-shared-distillation | whitepaper §5.12 |
| E8 | Privacy screen: caught 1 toxic group; second slipped screen, contained to PERSONAL by per-claim support | 11-shared-distillation, 14-threat-model | whitepaper §5.12 |
| E9 | Plausible-tier inclusion cost: adverse false-answer rate 8.3% → 10.0%, i.e. +1.7 pts (c5 ~77→93 of 930) | 06-dreaming, 14-threat-model | whitepaper §5.13 |
| E10 | Dual-provenance dedupe equivalent: sim 0.854 | 11-shared-distillation | whitepaper §5.12 |
| E11 | Discovery generations: flat-threshold discovery 0/3; LLM-partitioner 3/3 at small scale, 0/4 at scale; v2 split+repair 4/4 (sims 0.765–0.845) | 06-dreaming | whitepaper §5.5–§5.7 |
| E12 | Scale stress: 6/6 targets, sims 0.800–0.858, flat across m=2…8 | 06-dreaming | whitepaper §5.7 |
| S1 | Capture over-emission: ~66% transient junk by intended taxonomy (34% keep rate) | 01-capture, decisions ADR 002 | decision-model spike report E2 (`.kimchi/docs/decision-model-spike/report.md`) |
| S2 | Triage: 87% of real coding windows skipped; −93% extraction calls; recall 8/8 seeded at P(yes) 0.52–0.998, false-open 0/8 | 03-gates | spike E1/E1b |
| S3 | Criteria-pinning incident: assistant-engaged class 0/4 → 4/4 after verbatim criteria | 01-capture, 03-gates, decisions ADR 003 | spike E5→E5b |
| S4 | Supersede reversal miss: production judge deleted 0 on explicit reversal; d3 deleted at pDel=1.0 | 04-supersede, decisions ADR 004 | spike E7 Part A |
| S5 | Store overlap scan: 13/13 twin groups detected, 0 false positives; ~17/48 facts redundant | 04-supersede, 13-migration | spike E7 Part B |
| S6 | Threshold death: with bge-m3, top-8 scores floor ≈0.39 → the 0.2 floor passes 8/8 | 02-storage, 05-retrieval, decisions ADR 005 | spike E8 |
| S7 | Recall gating: searches 9→1 over 20 turns; p50 gate latency 316 ms | 03-gates, 05-retrieval | spike E4 |
| S8 | Null case: selector injects 0 facts where rank baseline would inject 5 misleading | 05-retrieval, 14-threat-model (T7) | spike E8 |
| S9 | October outage: 22 pending capture jobs; 7-day sweep risk | 01-capture, 07-measurement | spike TL;DR incidental finding |
| S10 | Judge contract: typed choice + probabilities; output tokens = 0; warm 300–450 ms; 64-question hard cap per call | 03-gates | spike API characterization; cap from E6 |

## Rules for adding entries

1. Exact quote of the number-bearing sentence, or a row declaring the
   measured form (e.g. E2/E4).
2. Location by file + §heading only.
3. A claim not in this ledger does not belong in the book.
