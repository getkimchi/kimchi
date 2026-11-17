# Pokémon memory bench report — Part I: P1 vs P2 (kimi-k3, original) · Part II: P3 vs P4 (deepseek)

**Data of record (box `particular-raw-reindeer-c711c6-e181`, extracted 2026-11-15):**

| Arm | Dir on box | Model | Memory | Outcome |
|---|---|---|---|---|
| P1 | `/home/sandbox/poke-arms/runs/poke-arm-p1-130921` | kimi-k3, thinking=max | **OFF** | 10,000/10,000 (done) |
| P2 (original) | `/home/sandbox/poke-arms/archive/p2-final-110518` | kimi-k3, thinking=max | **ON** | 10,000/10,000 (done) |

Extraction: `/tmp/extract_compare.py` over each arm's `session.jsonl` (~113 MB each), `rounds.log`, and memory store. Raw dataset: `.kimchi/docs/p1-vs-p2-raw.json`.

---

## 1. Headline

**The memory-on arm reached the objective; the memory-off arm did not.** Both were given the same goal ("earn the first badge from Brock in Pewter City"), the same 10,000-press budget, the same model/thinking, the same prompt family, and the same tools except the memory extension.

- **P2 reached Pewter City at press 8,935** and finished its budget standing in the goal city (last ledger: `Pewter City (1,2) money=251 badges=0 party=2`). It never defeated Brock, but it arrived at the venue with a 2-Pokémon party.
- **P1 never left the Viridian Forest corridor.** It finished back in Viridian City (`Viridian City (1,13) money=1717 badges=0 party=1`).

Neither arm earned the badge — the honest label for both is "0/1 badges at 10k", but the trajectories are opposite in shape: P2 maps forward ground, P1 circles.

## 2. Progress milestones (from the MCP ledger embedded in each press response)

First press at which each location was reached:

| Step | P1 (memory off) | P2 (memory on) |
|---|---|---|
| 1 | Pallet Town | Pallet Town |
| ~80 | interior maps (38/37) | interior maps (38/37) |
| ~121 | map40 | map40 |
| ~250–380 | Route 1 (246), Viridian City (370) | Route 1 (279), Viridian City (378) |
| ~0.4–1k | interiors (43/42) | interiors (42/43/41/44) |
| ~1.1k | — | **Route 2 (1067), forest maze (map50/51)** |
| ~2.4k | Route 2 (2410), forest maze (2502/2525) | — |
| 5,626 | — | **Route 22** |
| 8,935 | — | **Pewter City (+ interiors 58/56/57)** |
| — | *(never reaches Pewter)* | ✓ venue reached |

Press consumption per location (share of the 10k budget):

| Location | P1 | P2 |
|---|---|---|
| Viridian Forest maze (`map51`) | **4,453 (44.5%)** | 4,050 (40.5%) |
| Viridian City | 3,128 | 1,549 |
| Route 1 | 1,056 | 1,915 |
| Route 2 | 380 | 718 |
| Pallet Town | 264 | 201 |
| Pewter City | 0 | 869 |

Both arms burned ≈40 % of their budget in the Viridian Forest maze — that map is the principal attrition point of the whole bench. The difference: **P2 walked out of the maze, P1 stayed in it and was back in Viridian City when the budget ran out.**

Peaks: money max ¥3,175 (both), party max 1 (P1) vs 2 (P2), badges max 0 (both).

## 3. Execution cadence

| Metric | P1 | P2 |
|---|---|---|
| Rounds (supervisor sessions) | 53 | 100 |
| Avg presses / round | ~189 | ~100 |
| Rounds ending ~900 s wall limit | 38 | 80 |
| Round stop reasons | error 34, no-session 10, length 7, stop 1, unknown 1 | length 40, stop 33, error 16, no-session 10, unknown 1 |
| Flat rounds (no press progress) | 11 | 10 |
| Budget-refusal events (10k in-band stop) | 1 | 1 |
| LLM turns | 10,480 | 10,140 |
| press_buttons calls logged | 10,126 (served 10,000 presses + errors) | 10,023 |
| **Tool errors** | **145** | **6** |

P1's rounds mostly died on `error` (34/53) with 145 tool errors across the run — its loops were crash-flavored. P2's were mostly the intended ends (`length`/`stop`), with error a minority — and only 6 tool errors in 10k presses.

## 4. Token economics

| Counter | P1 (no memory) | P2 (memory on) |
|---|---|---|
| Input tokens | 15,610,588 | 16,856,919 |
| Output tokens | **3,226,204** | **2,565,613** |
| Reasoning tokens | **2,177,234** | **1,651,100** |
| Cache read | 1,394,052,224 | 1,347,874,368 |

P1 spent **+26 % output and +32 % reasoning tokens** to travel less ground — roughly **325 output tokens and 218 reasoning tokens per accepted press** vs P2's **257/165**. The memory arm's injected context (~2,407 facts delivered over the run, plus 63 compact digests) replaced a large amount of in-conversation re-derivation.

## 5. Memory pipeline detail (P2; P1 carries none of this)

Store at end of life:

- **64,629 facts (vectors)** committed to `personal/memory.db`
- 747,136-item `captured-hashes.json` dedupe map
- 152 recall/extraction traces on disk
- Embedding calls: **135,973 × bge-m3**; fact extraction: **52,179 × deepseek-v4-flash-0731**; gate/triage family: **11,049 × d3** (triage 8,045, valuation 1,851, recall-gate 575, supersede 487, digest 91)

In-loop recall (main turn driving):

- **310 injections, 2,407 facts delivered**, from **16,613 candidates considered** (13,259 crowded out over capacity)
- 1,202 skips (decision gate / cooldown judged no value — the cheap path)
- 74 gating failures handled degraded, only **2 hard loop-recall failures**
- d3 circuit: 121 opens with 18 re-closures (healthy breaker behavior), never a permanent kill
- Model-side calls: `memory_search` used **21** times; `save_memory` **0** (authored lane is flag-gated off; capture remained fully worker-driven)

## 6. Behavioral signatures (qualitative)

- **P1 dithered in meta-work**: 172 `confirm_todos` + 91 `update_todos` + 11 `mark_todo` calls — hundreds of turns spent curating its own todo list instead of pressing buttons. P2's tool table shows almost no meta churn.
- **P1 looped without detecting it**: with no recall, each round re-negotiated the same exits; its ledger shows long revisit loops between Viridian City and Route 1.
- **P2 re-tested beliefs instead of re-deriving them**: `memory_search` hits plus injected recall show up precisely at map transitions (entry to Route 2, the forest maze, Pewter approach). 13,259 over-cap candidates demonstrate the store was noisier than the context window — the gate's *selection*, not recall volume, was the scarce resource.

## 7. Caveats on attribution

1. **n=1 per condition.** One 10k run each; no repeats. Location stochasticity (encounters, crits) is not washed out.
2. **Shared failure mode dominates**: both arms lost ≈40 % of budget to the same maze; the bench's atlas was not the only variable in play.
3. Bench policy evolved mid-run: round wall-clock management (fixed 900 s → activity-based liveness), screenshot settle gating, and prompt wording were refined while both runs were live; neither arm ran the *entire* experiment under today's exact bits.
4. P2's final 1,341 presses were completed after its arm's natural `stop` point expansion (budget edited 10,000 during run); cadence tables treat the whole run uniformly.
5. Costs are token proxies, not dollars; cache reads dominate headline numbers and discount the real input price for both arms similarly.

## 8. Bottom line

With identical model, budget, prompt, and tools, turning the memory extension on changed the run's character: **fewer tool errors (145 → 6), less meta dithering, −32 % reasoning tokens per press, and forward map progression that carried the arm to the Pewter City gym venue — while the memory-off arm finished back where town maps end.** The badge itself remains the bench's unsolved milestone for both conditions.

*…the badge remained unsolved for both — until Part II.*

---

# Part II — P3 vs P4 (deepseek-v4.1, second generation)

**Data of record (same box, extracted 2026-11-17):**

| Arm | Dir on box | Model | Memory | Outcome |
|---|---|---|---|---|
| **P3** | `/home/sandbox/poke-arms/runs/poke-arm-p3-083121` | deepseek-v4.1-flash-1017, thinking=max | **ON** | **Goal met — first badge at press 4,746; arm stopped by supervisor at 5,139/10,000** |
| **P4** | `/home/sandbox/poke-arms/runs/poke-arm-p4-083121` | deepseek-v4.1-flash-1017, thinking=max | **OFF** | 10,000/10,000 budget exhausted, **0 badges** |

Extraction: `/tmp/extract_p34_v2.py` (structured journal parse, memory root auto-detected). Raw dataset: `.kimchi/docs/p3-vs-p4-raw.json`.

## 1. Headline

**The bench has its first badge.** P3 — deepseek with the memory extension on — beat Brock 4,746 presses in, was walking Route 3 toward Mt. Moon when the new goal-gate (`badges ≥ 1 ⇒ stop`) parked the arm at 5,139, and passed the finish line in 73.2 h of wall time across five sandbox crashes.

P4 — the same model, same prompt family, memory off — burned the whole 10,000-press budget without reaching Pewter. Final ledger: `Route 2 (0,1) money=24 badges=0 party=3`. **It finished the bench with ¥24 and three Pokémon**, two full regions short of the goal, in 61.9 h wall.

Same model. Same tools. Same 5-reboot environment. The only flipped bit was the memory extension.

## 2. Outcome map

| Milestone (first press at) | P3 (memory ON) | P4 (memory OFF) |
|---|---|---|
| Pallet (start) | 2 | 1 |
| Route 1 (map12) | 269 | 457 |
| Forest maze entry (map50/51) | **826** | **4,301** |
| Reasonable map crossings | ~12 maps by step 5.1k | ~12 maps by step 10k |
| Pewter-gym interior (map47) | **4,507** | *never* |
| **First badge** | **4,746** | **never** |
| Mt. Moon side (Route 3) | 5,0xx–5,139 | *never* |

Sampled game-time share by map (probe samples):

| Map area | P3 | P4 |
|---|---|---|
| Forest maze (map51) | 52.3 % | 9.5 % |
| Route 1 (map12) | 12.0 % | **31.5 %** |
| Viridian/Pallet routes (map1) | 13.1 % | **23.2 %** |
| Pewter-side (map13/14+) | 17.5 % | 7.9 % |

P4's time profile is the Part I P1 profile — indistinguishable character: most of the run spent cycling the Route 1 ↔ Viridian corridor. Both memory-off arms share the same home range.

## 3. Execution quality

| Metric | P3 (mem ON) | P4 (mem OFF) |
|---|---|---|
| Presses | 5,139 (stopped at goal) | 10,000 (budget) |
| Turns (toolResult round-trips) | 7,768 | 14,177 |
| **Tool errors** | **188 (2.4 % of turns)** | **2,069 (14.6 %)** |
| `memory_search` calls | 18 | 0 |
| Wall time | 73.2 h (5 box crashes) | 61.9 h |
| Terminal ledger | Route 3, money 3,186, **badge 1**, party 2 | Route 2, money **24**, badges **0**, party 3 |

(The p3 journal lineage in this generation no longer carries per-call main-model usage fields — no model-token economics here; memory-side consume counts below instead.)

## 4. What memory cost (P3 store ledger, authoritative)

| Kind | Calls | Tokens |
|---|---|---|
| Extraction (deepseek-v4-flash-0731) | 84,566 | **193,917,754** |
| Triage d3 | 3,346 | 25,656,871 |
| Valuation | 2,608 | 17,424,857 |
| Embedding (bge-m3) | 121,362 | 5,505,876 |
| Recall | 559 | 180,887 |
| Digest | 386 | 235,303 |
| Store at stop | 71,618 vectors | 1,480,240 captured-hashes |

Background memory consumption is therefore **~243 M tokens of small-model work for one badge-winning 5k-press playthrough** — mostly in extraction at ~2,293 tokens/call. Per press, the memory subsystem burned **~47,300 tokens** (extraction alone ~37,700/press) in the background while the main model pressed buttons. The store deduped 1.48 M raw hash candidates down to 71.6 k stored facts (~4.8 % acceptance).

## 5. Two clean contrasts

1. **Outcome parity**: across the four completed 10k+ runs, memory-on arms account for the only two goal-venue arrivals: P2 at Pewter City (8,935 presses, badge-less), P3 at badge 1 (4,746 presses, stopped at goal). Memory-off arms P1/P4 both ended penniless or pacing the Viridian corridor.
2. **Tool noise tracks memory**: P4's error share (14.6 %) mirrors P1's (13.7 %) — memory-off deepseek and kimi behave alike; P3's error share (2.4 %) mirrors P2's (0.4 %) even though the model changed. Suggests error-rate is driven by **context-management facilities, not model IQ**.

## 6. Caveats added by this generation

1. **n=1 per condition, again**; deepseek baseline (P4) reflects one very unlucky corridor capture (¥24 finish).
2. The **goal-gate changed effective arms**: P3 stopped at 5,139 by design (supervisor gate shipped today), so long-horizon characteristics past goal aren't measured for it.
3. p3/p4 journals lack per-call usage records (schema change in this generation's journal), so unlike Part I we can't price the main-model tokens per press.
4. Five workspace reboots split both runs; supervisor restarts carried press budgets but each restart re-launched a fresh model round with warm-up loss.
5. **Memory root discovery**: this generation's binary resolves the store at `$HOME/.config/kimchi/memory` (earlier-era arms used `.local/state/kimchi/memory`); extraction auto-detects both — noted for future cross-era analysis scripts.

## 7. Bottom line for Part II

With the deepseek model pinned and thinking=max for both arms, **the memory extension was the difference between "out of money on Route 2 after 10k presses" and "Boulder badge banked at 4,746"** — the bench's first goal-complete outcome. Cost: ~243 M small-model tokens of background extraction/triage/valuation (~47,300 per press, dominated by capture-extraction), stored durably in a 71.6k-fact personal store. That store now sits in the live seeded-memory experiment: p2's second-generation run inherited 64.6k p2-original facts at press 0 and has grown it to **96,380 vectors** by press 7,620.
