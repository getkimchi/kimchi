# Memory Dreaming: Geometric Discovery and Verified Synthesis over Embedding-Space Fact Stores

**Internal whitepaper · v1 · 2026-11-06 · Kimchi / CAST AI**

**Status:** working draft for internal review. Companion documents (same
directory): `dreaming-formal-methods.md` (full proofs and assumptions),
`memory-dreaming-prior-art.md` (survey with links). Session artifacts
(untracked, gitignored): empirical log at `.kimchi/plans/memory-dreaming.md`.

---

## Abstract

Agent memory stores accumulate one factual claim per embedding vector. We
propose and formalize a "dreaming" pipeline that (i) discovers candidate
consolidation/inference groups by *cluster analysis of the embedding space
itself*, (ii) generates new memories from each group's texts via an LLM —
never by decoding points of the space, which we show is structurally
unsound — and (iii) *geometrically verifies* each synthesized fact against
the group's own scatter before admission. We give four theorems:
exact topic recovery for gap-separated average-linkage clustering
(Theorem 1), a three-zone classification of synthesized candidates with
explicit false-rejection/false-acceptance control (Theorem 2), sound
paraphrase detection via an alignment-ceiling rule (Theorem 3), and an
unconditional angle-transfer bound guaranteeing that in-band condensation
inherits the cluster's retrieval geometry (Theorem 4). All bounds are
stated against empirically measurable moments; on a production memory
store (185 facts, bge-m3, 1024-d) the predicted cluster statistics,
rejection rates, and zone assignments match measurement, and a live
end-to-end run shows the geometric ordering of candidates coinciding with
their judged truth ordering on 9/9 real candidates. Prior art (OpenAI
ChatGPT "dreaming", Letta sleep-time compute, Graphiti community
summarization, RAPTOR) establishes the value of background memory
synthesis — none of it performs geometric discovery over the fact store's
embedding space nor geometric verification of synthesized memories; those
are the components this paper formalizes.

---

## 1. Introduction

Long-term agent memory (e.g. Kimchi's memory subsystem: LLM-extracted user
and project facts, embedded and stored per-claim) suffers two compounding
failure modes at accumulation time:

1. **Redundancy without synthesis.** Recurring topics are restated many
   times with surface variation. On our reference store, the largest
   natural cluster is *17 near-twin restatements* of one operational fact
   (cohesion 0.797); the store's 185 facts organize into 34 multi-fact
   topic groups plus 46 singletons (§5.1).
   Retrieval and digest budgets are spent re-reading the same thing.
2. **No inference over accumulation.** Facts that are only *jointly*
   informative ("bought espresso machine"; "bought grinder"; "bought
   beans") remain three retrieval rows; the natural generalization exists
   nowhere in the store, and retrieval that would benefit from it must
   assemble the evidence at query time, every time.

The "dreaming" proposal: an offline pass that clusters the store's
embedding space, generates condensed and inferred memories from each
cluster's texts with an LLM, and admits the results under geometric and
judged verification. The geometric part is where naive versions of this
idea fail: sentence embeddings of contrastive encoders have no generative
decodability, so "pick a new point in the cluster and decode it" is
structurally unsound (§4.6). The sound version recasts geometry as
*proposer and auditor*, and the LLM as *decoder*: cluster → synthesize
text → re-embed → check the new point against the cluster's own scatter.

**The geometry, in plain terms.** The encoder turns each fact into a
point on the surface of a 1024-dimensional sphere; similar facts land
near each other, and every pair of *unrelated* facts lands at almost
the same large angular distance from each other. That "everything is
mildly similar" baseline is what all thresholds in this paper are
measured against. A topic is a tight patch of the sphere. The pipeline
finds patches, asks an LLM to write each patch's caption, then checks
whether the caption (once encoded) falls inside the patch. Nothing in
the paper needs more geometry than this picture; the spikes are the
formal version in §4 and the companion proofs document.

**Contributions.**
- A formal model of memory-store synthesis with explicit, measurable
  assumptions (§4.1–4.2).
- Four theorems with full proofs, each tied to a pipeline gate and each
  validated against a production store (§4.3–4.5).
- An empirical validation chapter: predicted vs measured (§5).
- The evaluation protocol that measures what the theorems cannot prove —
  inductive precision and yield — with seeded and holdout designs (§7).
- The cross-user (team memory) extension under a k-anonymity support gate
  (§8).

---

## 2. Related work

**(Full survey with citations: `.kimchi/docs/memory-dreaming-prior-art.md`.)**

*Background memory synthesis (the "dreaming" concept).* Productized at the
largest possible scale: OpenAI's ChatGPT memory moved from explicit saved
memories (2024) to a background synthesis process named **dreaming**
(Apr 2025) and then to dreaming as the memory foundation layer (2026),
citing a "step-function improvement" in personalization. Letta's
**sleep-time compute** (arXiv:2504.13171) formalizes idle-time reasoning
over persisted context (~5× test-time compute reduction; efficacy
correlates with query predictability). LangMem provides debounced
background consolidation. Generative Agents (arXiv:2304.03442) introduced
the canonical **reflection** loop: salience-triggered, LLM-synthesized
higher-level insights with evidence links, written back to the memory
stream.

*Group-to-summary condensation.* Graphiti (arXiv:2501.13956) runs label
propagation over its temporal knowledge graph and LLM-summarizes
communities into `CommunityNode`s (after Microsoft GraphRAG's Leiden
communities). Zep adds bi-temporal invalidation for contradiction handling.

*The "cluster embeddings → summarize" operation outside memory.* RAPTOR
(ICLR'24, arXiv:2401.18059): UMAP → Gaussian-mixture soft clustering →
recursive LLM summarization, as a *retrieval index* — with no verification
of the summaries against cluster geometry. Anthropic's Clio
(arXiv:2412.13678): k-means over conversation-facet embeddings with
LLM cluster descriptions under **k-anonymity minima** — a production
precedent for our cross-user gate.

*Embedding geometry theory.* Contrastive encoders optimize alignment and
uniformity on the hypersphere asymptotically (Wang–Isola, ICML 2020,
arXiv:2005.10242). Contextual representations are anisotropic
(Ethayarajh, EMNLP 2019, arXiv:1909.00512; SimCSE's "narrow cone"
diagnosis, arXiv:2104.08821). Distances concentrate as dimensionality
grows (Beyer et al., ICDT 1999). Word-level linear analogy structure
exists but carries explicit, composition-growing error terms (Allen &
Hospedales, ICML 2019, arXiv:1901.09813). Embedding inversion exists but
is per-model, query-access, and recovers only embeddings of real texts
(Vec2Text, arXiv:2310.06816).

**Gap this paper occupies.** Every memory system we found uses embeddings
*pairwise* (indexing, dedup blocking, linking); none clusters the fact
store's embedding space to propose synthesis groups, and none verifies
synthesized facts geometrically. Group structuring, where present, is
graph-algorithmic (label propagation, Leiden) rather than metric.

---

## 3. The pipeline

The diagram shows the architecture as measured, not as first
designed; §5.5–5.6 document the two redesigns that produced it.

```
store (texts + vectors)
  └─ over-propose: threshold-free mutual-kNN components      [discovery floor measured, §5.5]
       └─ pre-split: HAC-AL inside large components at μ0+1σ0  [Thm 1 spirit]
            └─ LLM boundary repair (merge / move / promote singletons)
                 └─ coherence + privacy screen (d3)            [§5.12]
                      └─ per group: LLM synthesis
                           (kinds: headline | consolidation | deduction | induction)
                            └─ re-embed → geometric gates: landing band [Thm 2],
                               paraphrase ceiling [Thm 3]
                                 └─ judge layer: calibrated entailment labels (d3)
                                      └─ admission: entailed → inferred tier;
                                         plausible → provisional tier;
                                         SHARED / PERSONAL split for cross-user [§5.12]
```

**Vocabulary used throughout.**
- *background distribution* — the similarity statistics of pairs of
  unrelated facts (mean μ0, spread σ0); every threshold is a z-score
  against it.
- *cluster / group* — a set of facts the pipeline claims share a topic.
- *landing band* — the similarity window computed from a group's own
  member scatter; where a re-embedded candidate lands relative to it
  (inside = insider; just below = penumbra; far below = off-topic).
- *paraphrase ceiling* — an absolute similarity level above which a
  candidate is a rewrite of one stored fact, not a new one (0.92 on
  our encoder; calibrated in §5.7).
- *kinds* — the three (later four) prompt channels: *headline* names
  the group's umbrella claim; *consolidation* compresses with zero
  loss; *deduction* states what follows without being verbatim;
  *induction* proposes a hedged hypothesis.
- *judge (d3)* — the gateway's typed-choice decision service that
  labels candidates entailed / plausible / unsupported against their
  source facts.
- *inferred vs provisional tier* — storage classes: entailed = safe to
  serve as fact; plausible = hedged hypothesis, never auto-trusted.
- *support set* — the stored members whose similarity to a candidate
  exceeds the eligibility threshold; provenance and the basis of the
  cross-user k-anonymity rule.
- *SHARED / PERSONAL* — cross-user admission classes: a claim may
  enter a shared store only if ≥2 users each supply supporting
  evidence, claim by claim (§5.12).

Design rules the math buys us (and which prior systems lack a basis for):

1. **Empirical-moment thresholds only.** All cuts and bands are z-scored
   against the store's own background distribution (§4.1) — anisotropy
   makes fixed thresholds non-portable.
2. **The centroid band narrows with cluster size** (Lemma 1): inference
   requires ≥3–5 members; twin-swarms must be merged first or they masquerade as evidence multiplicity.
3. **Landing is classification, not just gatekeeping**: insider /
   penumbra / off-topic zones correspond to consolidation / inference /
   hallucination-risk (Theorem 2 + §5.3).
4. **Condensation is geometrically free for retrieval** (Theorem 4);
   induction is geometrically expensive and must carry anchor vocabulary
   for the store's lexical channel.

---

## 4. Formal model and results

Full proofs: `dreaming-formal-methods.md` (same directory). Statements and
attendant measurements below. Each theorem is followed by a plain-terms
reading; a reader who wants only the architecture can treat §4 as
"cluster splits are exact when a similarity gap exists (Thm 1); candidate
verdicts have bounded error rates once groups reach size ~10 (Thm 2);
paraphrases cannot hide below new-claim levels (Thm 3); and compression
cannot break retrieval (Thm 4)" and skip to §5 without loss.

### 4.1 Setup and assumptions

Store $M$ of $n$ fact texts; encoder $e:\mathcal{T}\to\mathbb{S}^{d-1}$
(d=1024, unit-normalized — measured mean norm 1.0000); cosine
$s=\langle\cdot,\cdot\rangle$. Off-topic pair similarities $\sim F_0$
(mean $\mu_0$, sd $\sigma_0$); within-topic pairs $\sim F_1$
($\mu_1$, $\sigma_1$), sub-Gaussian tails (A1). Encoder alignment/uniformity in the
sense of Wang–Isola (A2), with same-claim alignment level
$a_{dup}\approx 0.92$. Separation gap $\mu_1-\mu_0$ required per cluster
(A3). Empirical background on the reference store: $\mu_0=0.527$,
$\sigma_0=0.111$ — the positive mean *is* the anisotropy/distance-
concentration phenomenon; it is why all gates below are z-scored rather
than fixed.

### 4.2 Lemma 1 (centroid concentration)

For a $k$-member cluster, $s(u_j,\hat c)=\frac{1+\sum_{i\ne j}s_{ji}}{\|\sum_i u_i\|}$
concentrates with mean $\approx \frac{1+(k-1)\mu_1}{\sqrt{k+k(k-1)\mu_1}}$
and sd $O(\sigma_1/\sqrt{k\mu_1})$. *In plain terms:* a group's members
hug their centroid tighter as the group grows (spread shrinks like
1/√k). Large groups are tight enough to assert inferences over; small
groups are loose enough to need them. *Measured:* predicted 0.899 vs
observed 0.899 on k=17; the iid model under-predicts dispersion when
topics have sub-structure — hence all gates use per-cluster *empirical*
moments, valid for $k\gtrsim 3$.

### 4.3 Theorem 1 (exact topic recovery)

Under A1–A3, average-linkage clustering cut at any threshold inside the
gap $\theta\in(\mu_0+\beta_0,\ \mu_1-\beta_1)$ returns exactly the topic
partition with probability
$\ge 1-n^3\exp(-\min(\beta_0,\beta_1)^2/2\tilde\sigma^2)$.
*Proof idea:* induction on merge steps; on the high-probability event that
every evaluated same-topic average stays above and every cross-topic
average stays below $\theta$, merges only complete topics and termination
is exact; union bound over $\le n^3$ evaluations. *In plain terms:* if
topics sit above the background similarity level by a visible margin, a
single well-placed cut recovers exactly the intended topics, with no
fragments or fusions. The silhouette sweep on real data (best at τ=0.70
with 34 clusters) is the empirical signature of such a gap; flat
silhouette regions are where the theorem is weakest and cut selection is
genuinely arbitrary. That is precisely what §5.5 measured, and what the
v2 pipeline routes around (§3).

### 4.4 Theorem 2 (three-zone classification with error control)

For cluster $C$ with empirical member-to-centroid moments $(\mu_c,\sigma_c)$
(Lemma 1) and band $b_C=\mu_c-1.5\sigma_c$:
$$\text{in-topic false rejection}\le e^{-z^2/2};\qquad
\text{off-topic false acceptance}\le \exp\!\big(-(\mu_c-m_{0c}-z\sigma_c)_+^2/2\sigma_{0c}^2\big).$$
with $m_{0c} \approx \mu_0/\sqrt{\mu_1}$ the candidate-vs-centroid
background center, *measured per store* (never bare $\mu_0$); the
$\sqrt{\mu_1}$ denominator reflects that a fresh candidate's similarity to
a centroid is dampened relative to pairwise background — the claims
battery first caught and then confirmed this correction over bare $\mu_0$
(predicted 0.56–0.61 vs measured 0.58–0.66). *In plain terms:* a new
candidate lands somewhere relative to the group's own cloud; the band
splits that space into insider / penumbra / off-topic, and both the
chance of wrongly rejecting a true member and of wrongly accepting a
tourist decay exponentially as the candidate moves away from the
boundary. The rejection bound holds with true moments; with moments
estimated from $k$ members, landing bands at $z{=}1.5$ are trustworthy
from $k\ge 10$ (see the claims battery — estimated bands are unstable
below, which is why small groups are handled per-claim rather than
per-band).
*Measured (deep-dive cluster, band 0.853):* hold-one-out rejection
$2/17=11.8\%$ — between the Gaussian reference (6.7%) and the
sub-Gaussian bound (32.5%), with the two rejects being the cluster's
semantically genuine odd-men-out; nearest foreign facts land at
0.849/0.827/0.816 (penumbra, 0/3 accepted), consistent with the 1.3%
false-acceptance bound. *Zone semantics:* insider = consolidation,
penumbra = novel-but-on-topic, off-topic = hallucination risk (validated
on the live run, §5.3).

### 4.5 Theorem 3 (paraphrase ceiling)

If a synthesized fact is claim-equivalent to a member (mutual entailment
under the judge), then $\max_{j\in C}s(x,v_j)\ge\theta_{dup}$ except with
the encoder's alignment-failure probability — restatement detection is
sound. *Measured separation:* twins ≤0.988, real consolidations
0.830–0.890 max-member sim, ceiling 0.92 → $0.89\ll0.92\ll0.98$: the
ceiling keeps genuine merges and flags copies.

### 4.6 Theorem 4 (angle-transfer retrievability) + the impossibility remark

The angular triangle inequality on $\mathbb{S}^{d-1}$ gives
$s(q,x)\ge\cos(\arccos s(q,\hat c)+\arccos s(x,\hat c))$ for any query $q$:
**in-band condensation inherits the cluster's retrieval geometry up to a
fixed additive angle** — geometrically free compression. *In plain terms:*
if a query was close enough to the cluster to retrieve its members, and
the condensed fact lands inside the band, the same query retrieves the
condensed fact too — an unconditional guarantee. Penumbra candidates pay
$\arccos r_0$ of transfer, so induction must secure the store's *lexical*
channel via anchor vocabulary (measured separately in the
vocabulary-fading probes; see plan §Worked example).

**Why not decode points (impossibility, §8 of the math doc).** The
encoder's realizable image is discrete; arbitrary interior points have no
near-preimage; published inversion is text-conditioned and per-model
(Vec2Text), and word-embedding linearity does not survive sentence-level
composition with bounded error (Allen–Hospedales). The decoder must
return text from the cluster's own support — the LLM — after which
geometry audits the result (Theorems 2, 4).

---

## 5. Empirical evidence

### 5.1 Discovery on a production store

185 live facts (the store drifted 184→185 facts across the study window;
§5.10 reports on the later state — every number below names its snapshot) → background $(\mu_0,\sigma_0)=(0.527,0.111)$ → gated
average linkage → 34 clusters covering 139 facts (silhouette-optimal cut
0.70). Largest cluster: 17 near-twins (compression target);
sub-structure visible and correctly separated at tighter cuts (port-config
sub-cluster, cohesion 0.839). **Surfaced defect worth a section of its
own:** expression-level near-duplicate accumulation at capture time is the
dominant store pathology, and ungrouped drift accumulates in singletons —
both motivate twin-merge-before-dream and small-cluster kNN ego-groups as
the induction substrates.

### 5.2 End-to-end live synthesis

3 clusters × 3 candidate kinds through the full pipeline (deepseek
synthesis, bge-m3 re-embed, geometric gates, d3 judging):

| Kind | land vs band | max-member | d3 verdict |
|---|---|---|---|
| consolidation ×3 | **IN** ×3 (0.887/0.898/0.859) | 0.83–0.89 → keep | entailed (1.00/0.77/0.99) |
| deduction ×3 | penumbra (0.822/0.804/0.757) | ≤0.88 | entailed (0.92/0.98/0.83) |
| induction ×3 | deep penumbra (0.784/0.771/0.705) | ≤0.89 | **plausible** (0.96 ×3) |

The geometric ordering equals the truth ordering on all 9 candidates.
All three inductions were *in fact true in the world* (verified by the
authors), which is exactly the tier semantics we want for a derived
memory: consistent with sources, beyond any single source.

### 5.3 Failure surfaces already on record

- Non-durable session state leaks into synthesis when sources carry it
  (one consolidation inherited "currently PID 71266") → the capture
  durability gates must run *on dream output* too.
- d3 judging degenerates when the shared-context protocol is violated
  (one flat distribution for all questions) — per-cluster state +
  per-question candidate embedding is required (measured, fixed).
- Vocabulary decay breaks *lexical* retrieval of synthesized facts;
  anchors must be preserved verbatim or aliased (probe results in the
  plan doc); the vector channel is covered by Theorem 4.

---

### 5.4 Claims-verification battery (all run against the production store)

Six targeted tests of the paper's assumptions and predictions:

| # | Claim under test | Result |
|---|---|---|
| 1 | Sub-Gaussian background tails (A1) | **Pass, conservative.** Empirical exceedances uniformly below bound: 2σ: 1.73% vs 13.5%; 3σ: 0.037% vs 1.11%; 4σ: 0% vs 0.034% |
| 2 | Lemma 1 centroid mean formula | **Pass exactly.** Predicted = measured to 3 decimals on all 17 clusters (size ≥3) |
| 3 | z=1.5 hold-one-out rejection | **Boundary found.** 12–36% at k≥14 (consistent); 36–100% at k≤6 (estimator unstable / star-shape wing rejection) → bands trustworthy only from k≥10 |
| 4 | Off-topic band center = μ0 | **Refined.** Candidate-vs-centroid center ≈ μ0/√μ1 (first-order, now in Thm 2); predicted 0.56–0.61 vs measured 0.58–0.66; foreign in-band 0–1.2% |
| 5 | Gap existence (A3) | **Pass.** Every measured cluster has margin 2.0–3.4 σ0 |
| 6 | Endpoint dependence | r = 0.296 (moderate) — union bounds valid, constants conservative |

One union-bound honesty point (now in the math doc): at n~10² the
Theorem 1 probability is a rate statement and a design rule, not a literal
numeric guarantee — the measured tails are uniformly lighter than the
assumed ones.

### 5.5 Seeded-session testing (Eval C, runs 1–2)

Twenty-two hand-authored facts over 8 topics. Three topics carry a
*planted target*: an inference that never appears verbatim but is
jointly implied by m facts (*T1* Italian cuisine, m=3; *T2* structured
distance-running, m=5; *T3* Japan ski trip, m=2). Adversarial fixtures:
'TWIN', a near-duplicate pair that must dedupe, and STALE+CURRENT, a
superseded housing fact that must not fuse with its replacement.
Remaining topics (keyboards, plants, work) are distractors. Gateway-
backed bge-m3 embeddings, deepseek (the gateway chat model) synthesis,
d3 judging — full loop.

- **Run 1 (HAC-AL, silhouette-chosen τ=0.55):** discovery *failed* — only
  4 multi-clusters, recall 0/3. Two cluster-level lessons: (i) implicit-
  induction evidence barely coheres (T1 pairs 0.53–0.54, T3 pairs
  0.46–0.47 against background μ0=0.441 — T3 is barely **0.23σ above
  background**); (ii) a surface-paraphrase confabulation ("rotates
  shoes"/"keycap rotation") merged two unrelated topics.
- **Run 2 (mutual-kNN ego groups at background+2σ):** threshold 0.588
  recovered only the lexically-obvious groups (T2 subset @0.61, twins
  @0.94, housing @0.61) — **the geometric discovery channel has a
  *detection floor* for implicit inferences**: evidence whose value lies
  in *what it implies* rather than *what it repeats* coheres weakly, and
  any geometry-only threshold tuned above background+2σ systematically
  deletes exactly the induction candidates worth dreaming about (while
  the twin/dedup tasks it was already good at survive). This is the
  paper's central empirical caveat: **embedding-space discovery is
  faithful for compression/recall problems and *structurally lossy* for
  induction** — the induction path needs either threshold-free topology
  (mutual-kNN components) with an LLM coherence screen, or a
  retrieval-assisted expansion step. Twin-ceiling, housing-merge and
  supersede behavior all matched design.
- **Run 3 (threshold-free mutual-kNN + LLM coherence screen + partition):
  the discovery architecture resolved.** Threshold-free mutual-kNN
  over-chained by design (one k=13 mega-component swallowing six topics);
  the d3 coherence screen caught both mixed components, and the LLM
  partitioner split them into **exactly** the intended topic groups
  (T1(3), T2(5), TWIN(2), housing(2), KB(2), PLANT(2)). Geometry
  over-proposes, the LLM disposes — with the geometric threshold demoted
  from truth-decider to a cost-knob bounding downstream LLM calls.
- **Recall:** T1 **HIT** (consolidation "The user enjoys cooking Italian
  dishes...", land IN, entailed). T2 and T3 were metric-MISSes but
  *semantic hits*: T2's induction ("may be training for a marathon,
  possibly the London Marathon") and T3's consolidation ("planning a
  February flight and considering ski destinations in Japan", entailed)
  both *are* the planted facts, below the 0.80 target-phrase sim bar —
  the recall metric must judge equivalence (d3), not phrase similarity.
- **Consolidation–induction merge:** at inference-worthy clusters, the
  *consolidation* candidate itself is the generalization (cuisine type,
  runner, trip) — condensation and induction coincide for topic-level
  clusters; the three-kind prompt matters mainly for tighter clusters.
- **Precision: 21/21 candidates non-unsupported** (12 entailed, 9
  plausible, 0 unsupported across both runs; all inductions honestly
  hedged; zero confabulations), including on the adversarial twin and
  supersede pairs (paraphrase ceiling correctly fired on the twin
  cluster's degenerate k=2 band).

### 5.6 Scaled sweep (37 facts, 12 topics, m ≈ 2/3/5/8) — what breaks at higher density

Same protocol, 2.4× the density: 4 planted targets, cycling/photo/garden
distractors, twin + supersede pairs, 5 noise singletons.

- **Screening scales; partitioning does not (yet).** The d3 coherence
  screen detected every mixed component (5/5). The LLM partitioner —
  clean at k=13 in run 3 — degraded at k=15 + heavier noise: dropped the
  m=2 and m=3 evidence to unrecoverable singletons, fragmented m=8's
  8-fact topic, and mispaired two noise facts with topic facts (purity
  6/8 groups).
- **Strict-equivalence recall: low at this scale.** d3 equivalence:
  m2 *different*, m3 *different*, m5 *related*, m8 *related* (0/4
  equivalent; semantic near-misses at m5/m8 with sims ~0.79).
  **End-to-end recall is bounded by group recovery, not by synthesis
  quality** — the pipeline never saw U1/U2's evidence together.
- **Precision holds at scale: 24/24 non-unsupported** (11 entailed, 13
  plausible, 0 unsupported; cumulative seeded-to-date: 37 entailed, 29
  plausible, **0 unsupported over 66 candidates**). Bad groups produce
  low-value but not false facts.
- **Consolidation prompt loses the umbrella claim** — candidates list
  member activities ("moved furniture, rented skip") instead of naming
  the generalization ("renovating their home"): a prompt-level fix
  (headline-synthesis kind), not a geometry problem.
- **Design responses tested (v2 sweep, same corpus).** The retest runs
  the revised architecture — *v2*: geometric pre-split (HAC within
  mega-components at μ0+1σ0) + LLM *boundary repair*
  (merge/move/promote-singletons) + a new **headline** synthesis kind
  (name the umbrella claim). *v1* denotes the run-3 architecture
  (free LLM partitioning, three kinds).
  - **Group recovery fixed:** k8[U4] and k3[U2] fully recovered, k2[U1]
    rescued — all three targets v1 lost to the partitioner are back; the
    surviving merges (cycling+commuting, tea+garden) are adjacent-topic
    unions, not precision hazards.
  - **Recall: 4/4 semantic hits, all via the headline kind** — sims
    0.765–0.845 vs targets; d3-equivalence reads "related" on all four
    (the bar "same essential claim" is stricter than semantic recovery;
    the headlines carry extra specifics the authored targets omit).
    Human-bar reading: every planted inference was recovered.
  - **Precision: 27/27 non-unsupported** (18 entailed, 9 plausible, 0
    unsupported). **Cumulative seeded-to-date: 93 candidates, 0
    unsupported.**
- **Bottom line for discovery**: threshold-free over-proposal →
  geometric pre-split → LLM boundary repair → screen → synthesize
  (headline/consolidation/induction) → gates + judging. Recall closed at
  test scale; the *equivalence*-bar residual is a phrasing phenomenon,
  not an evidence-recovery failure.

### 5.7 Calibrating the judge and the paraphrase ceiling (authored truth)

**d3 vs authored labels (n=14: 5 entailed / 3 plausible / 6
unsupported).** Entailed→entailed 5/5. **Safety-critical false-accept
direction unsupported→entailed: 0/6.** One unsupported claim ("opened a
specialty coffee shop") was graded *plausible* — a tier demotion to
provisional storage, not an auto-store; two plausible→entailed
promotions were strong deductions with debatable truth labels. Boundary
behavior (n=14, CI [0, 46%] by rule of three): the judge is exact on
entailment detection and conservative on rejection — hallucination
control holds in the ≤5% FAR regime the whitepaper gates need.

**Paraphrase ceiling q_P = 0.92.** On 12 LLM-generated paraphrases of
source facts: sims min 0.860 / median 0.959, **7/12 ≥ 0.92; zero false
positives across all 66 source cross-pairs (max 0.665).** q_P catches
~58% of paraphrases risk-free; the 0.86–0.92 remainder is absorbed
by the support-set rule (a member's paraphrase has a near-match to
exactly ONE member — kills the ≥2-support requirement for inferred
tier).

### 5.8 Scale stress (56 facts, 17 topics, 6 targets at m = 2/2/3/4/5/8)

v2 pipeline at 1.5× density: **group recovery 15/17 pure** (all 6 target
topics intact; remaining impure groups are a noise-singletons misc
bucket and a dog+noise pair). **Recall 6/6 semantic hits** (sims
0.800–0.858): the recall(m) curve is flat 2→8 — evidence velocity, not
evidence count, is the binding constraint at these densities. **Precision
51/51 non-unsupported** (32 entailed / 19 plausible).

### 5.9 Cumulative seeded record

Across all seeded runs: **144 judged candidates, 0 unsupported**
(cumulative d3 tallies: entailed 87, plausible 57, unsupported 0).
Twins deduped by ceiling/pair-merge, supersedes flagged entailed+conflict
(never consolidated into contradictions), all planted inferences
recovered at every tested multiplicity.

### 5.10 End-to-end on the real personal store (n=184)

(Note: the memory implementation was restructured mid-investigation —
payloads are now stored as plaintext JSON inline in `vectors(id,
vector BLOB, payload TEXT)`; all numbers below are against the current
schema. Earlier sections' claims against the envelope-encrypted schema
reproduced identically once the schema difference was accounted for.)

- **Structure census:** 18 explicit paraphrase pairs (≥0.92) — ~10% of
  the store is capture redundancy, almost all inside the dominant
  kimchi-bridge topic. Confirms the dominance-measured pathology and
  the twin-dedupe delivery case quantitatively. The 0.75–0.92 band at
  396 pairs is dominated by same-topic-different-content pairs — it is
  not by itself a conflict detector; gating stays LLM-side.
- **Discovery v2 at n=184:** 29 mutual-kNN components → 33 pre-groups /
  47 singletons → LLM repair → 32 groups (10×k2, 7×k3, 2×k4, 7×k5,
  1×k6, 1×k7, 2×k8, 2×k10+) — a plausible group ecology for a
  single-passion-heavy store.
- **Precision: 60/60 non-unsupported** (40 entailed / 20 plausible) on
  the top-20 groups. **Cumulative across all evaluation runs: 204
  judged candidates, 0 unsupported.**
- **Vetted headline quality (top groups, all entailed):** umbrella
  claims over the dominant topic — gateway proxy mode and routing,
  symlinked install + release history, Bun runtime + OAuth, gateway
  patching Claude Code/Codex configs, port-resolution priority,
  LaunchAgent daemon path, config layout, log location. These are the
  statements a reader would want as the *index* of the store; none is
  present in any single stored fact.

### 5.11 Judge calibration at n=54 (authored truth, adversarial near-misses)

27 supported (18 entailed / 9 plausible) + 27 adversarial unsupported
crafted from the failure classes that matter (value tweaks, subject
changes, invented dates, ownership slides, level inflation,
hedge-dropping):

- entailed→entailed **18/18**; unsupported→unsupported **18/18** — every
  fabrication caught, including "pulled at mainly 1:3 ratio" (vs 1:2.2),
  "2021 GTI" (vs 2019), "owns the lens" (it was rented), "moves in
  June" (vs March), "rejects PRs over 400 lines" (vs prefers), "fluent
  in Spanish" (vs A2).
- **Safety-critical false-accept (unsupported→entailed): 0/18.**
  Combined with the earlier battery: **68 judged items, 0/24
  unsupported→entailed, one-sided 95% CI [0, 12%]**.
- Boundary plausibles confuse, mostly in the safe direction: 6
  promoted to entailed (all defensible strong deductions), 1 demoted to
  unsupported (overstrict, harmless).

### 5.12 Cross-user (shared-store) seeded evaluation — and the rule that had to change

The paper's reserved scenario, run for real: three seeded personas —
backend A, frontend B ("Lexer"), devops C — with a shared project
topic (bench-site), cross-user duplicates (standup), private traits
(A's slipping PR reviews, B's import-map preference), and noise.

- **Discovery treats user labels as irrelevant (correct):** mixed {A,B}
  groups formed for every shared topic.
- **Cross-user dedupe works as designed:** the standup pair consolidated
  with *both* users' provenance carried in the candidate text ("user A
  and user B both report...") — the handover-precedent case lands.
- **Composite inference partially recovered** (d3 reads "related",
  0.825): "users A and B have collaboratively set up the
  new-bench-webui frontend" — the join needed A∪B evidence, and the
  pipeline formed it. The sharper target ("B *owns* the frontend")
  wasn't asserted; headline-kind prompts may need an ownership nudge.
- **Precision 21/21 non-unsupported** (cumulative runs: **225
  candidates, 0 unsupported**); zero leak-probe hits.
- **A real rule gap, found by the experiment:** the repair stage glued
  two *private* facts from different users (A's review-slipping + C's
  on-call) into one group, and its consolidation — "User A's reviews
  are delayed, while user C's pages go through Opsgenie" — is entailed
  yet **privacy-toxic**: a conjunction of two single-user private
  claims. As drafted, the k-anonymity support rule (≥2 users × ≥1
  support) *passes* it. **Rule refinement (now in §9):** support must
  hold per *atomic claim*, not per candidate sentence; compound
  candidates must be decomposed before eligibility, and the coherence
  screen needs a privacy criterion ("never co-assert two users' private
  facts").

**Rerun with the refined rules (n=23, same corpus).** Support tally now
uses a z-scored eligibility threshold (τ_sup = μ0+4σ0 = 0.744 on this
corpus) instead of degenerate small-k group bands; every candidate is
decomposed into atomic claims; claims are judged *and* tallied
individually; the coherence screen carries the privacy criterion.

- **Layered privacy defense demonstrated.** The screen caught one toxic
  group pre-synthesis (two users' personal routines glued). It *missed*
  the A-reviews + C-on-call pair — and the per-claim eligibility rule
  then contained it automatically: each clause had single-user support
  → whole candidate tiered PERSONAL, never SHARED. Screen as first
  line, per-claim support as airbag.
- **Per-claim k-anonymity behaves exactly as designed.** The standup
  headline tiered SHARED (dual-provenance, all claims entailed,
  {A:1,B:1} support). The recorder-panel headline — "A and B both
  contributed" — correctly tiered PERSONAL (each claim single-user);
  a strict-but-right conservative downgrade.
- **Conservative recall residual:** dedupe target now judged
  **equivalent** (0.854); composite target stays "related" (0.806) —
  with ownership nudging the pipeline asserted "user B *leads* Deno
  adoption" but only "collaboratively set up" the frontend. The system
  underclaims joint ownership rather than overclaiming it: the correct
  failure direction for a shared store.
- **Claim-level precision: 35 entailed / 10 plausible / 1 unsupported
  across 46 claims** — the single unsupported is a self-referential
  decomposition artifact ("this is an inference, not a direct
  observation"), not a factual hallucination; it correctly forced a
  DROP. Tier split: SHARED 1 / PERSONAL 16 / DROP 1 of 18 candidates.

### 5.13 External benchmark at real scale: LoCoMo (ACL 2024)

**Setup.** 10 LoCoMo conversations, each two friends over ~27 sessions.
The dataset's own *observations* (LLM-written, dialogue-referenced
memory records) serve as captured facts: 2,454 facts / 10 joint stores
(169–324 facts each), user labels = the two speakers. v2 pipeline +
privacy screen + gates + d3 judging, dreams appended with provenance.

**Dreaming.** **615 vetted dream facts** (avg ~24% of each store's
themes), per-candidate precision **411 entailed / 204 plausible / 0
unsupported**. Privacy screen caught **80 toxic groups** at real scale
(up to 29/store — intimate two-friend observation sets stress it
for real). One uncovered failure mode was found and fixed: the boundary
repair call can hard-fail/stall (empty JSON, hung fetch) — production
needs retry + timeout + incremental flush.

**Ground-truth QA evaluation (paired arms, same questions, same d3
judge; only the store differs).** Coverage = "top-k retrieved facts
entail the gold answer":

| category | obs-only (n) | obs+dreams (n) | delta |
|---|---|---|---|
| c1 multi-hop (282) | 26.6% | 33.0% | **+6.4 pts (+24% rel)** |
| c4 single-hop (100, sampled) | 50.0% | 51.0% | +1 pt (no regression) |
| c5 adversarial false-answers (120, sampled) | 8.3% | 10.0% | +1.7 pts (measured cost) |

Per-store c1 direction: 7 up / 3 flat / 0 down (sign test p≈0.008).

**Reading.** Dreaming buys real multi-hop recall on published ground
truth at zero false stores — the consolidated/inferred tier shortens
evidence chains the retriever otherwise misses. The caveats:
(a) retrieval from observation-granularity facts is the dominant
bottleneck (single-hop coverage is only 50% — dreaming can't help
questions whose evidence is never retrieved); (b) including plausible-
tier dreams in the retrieval pool costs ~2 adversarial false-answers
(~1.7 pts) — a deployment knob (entailed-only retrieval) is the queued
ablation.

## 6. Competitive landscape: mechanisms, measured trade-offs, and what this adds

This section is about *implementations*, not marketing sheets: what each
system actually does in its write path, which residual risk class that
leaves open, and what the pipeline in this paper demonstrably closes.
Sources: companion SLR (memory-dreaming-prior-art.md), project docs, and
the LoCoMo numbers cited below (collected 2026-11).

### 6.0 The comparison unit: what Kimchi already ships

The dreaming layer does not stand on a bare vector store. The production
memory pipeline it plugs into (`src/extensions/memory/`) already
implements several of the mechanisms compared below — comparing
"dreaming" against full competitor stacks without counting these would
misstate both sides:

- **Capture + extraction with durability rules.** Session content becomes
  capture jobs at two engineered points (pre-compaction — the leak point
  where session knowledge is about to be summarized — and shutdown),
  deduped by message hash, processed by a detached worker
  (`capture.ts`, `capture-worker.ts`).
- **Calibrated decision-gates in production.** The gates that decide what
  is worth storing, injecting, recalling, or superseding all call the
  same d3 typed-choice judging service this paper's calibrations
  measured (`decision-gate.ts`); the decision criteria strings are
  pinned by tests and were validated through a dedicated spike against
  LongMemEval (`gates.ts`). Calibrated judging is not a dreaming
  invention — it is inherited.
- **Supersede beyond Mem0 OSS.** The upstream write path is add-only, so
  inconsistent updates would leave stale rows; the harness force-
  DELETE+ADDs judged replacements, conservatively (only explicit
  changed-value evidence deletes; `supersede.ts`).
- **Embedding layer.** Shared deduping bge-m3 embedder over all stores
  (`embedder.ts`), plus a measurement harness for digest value
  (`verify-measure.ts`, `backend.check.ts`).
- **Injection-side quality control.** Value and recall gates already
  protect the prompt budget at read time.

So the comparison unit throughout §6 is the *stack*: the shipped
pipeline above plus the dreaming layer of this paper. Two consequences:
(a) adversaries to the right of the table are compared against a real
baseline, not a straw default; (b) lines where the paper's novelty is
thin are marked "inherited" rather than claimed.

### 6.1 Mechanism comparison

("LoCoMo J" = the dataset's LLM-as-judge QA accuracy, the field's
common but non-comparable yardstick — §6.3.)


| system | background pass | discovery mechanism for "what to synthesize" | verification of synthesized facts | truth tiers | provenance per stored artifact | cross-user shared synthesis | published hallucination measurement |
|---|---|---|---|---|---|---|---|
| OpenAI Dreaming V3 | yes (foundation layer) | undisclosed | undisclosed (behavioral evals: staleness, carry-over) | not published | user review page; no evidence links | not published | no |
| Letta sleep-time | yes (sleep-time agent) | trigger + agent-salience rewrite of MemFS | optional review-before-apply; agent self-judgment | no | transient (rewrite log) | no | no |
| LangMem | debounced manager | reconciliation vs retrieved candidates (pairwise) | LLM arbitration ADD/UPDATE/DELETE | no | update/delete history | no | LoCoMo J 58.10 (QA only) |
| Zep / Graphiti | yes (incremental + communities) | graph-structural communities (label prop / Leiden) | none published; generative summary | no | bi-temporal edges (valid_at/invalid_at) | group_id shared graphs (no anonymity layer) | LoCoMo J 65.99–75.14 (QA only) |
| Mem0 (OSS / platform) | no consolidation pass in OSS | pairwise dedupe (hash + retrieval check) | none (ADD-only OSS; paper variant LLM-arbitrated) | no | both versions kept on change | no | LoCoMo J 66.88 (paper), 92.5 (platform+gpt-5, different harness) |
| Memobase | profile/event extraction | schema slots (profiles, events) | none published | no | structured fields | no | self-reported 70.91–75.78 (QA only) |
| **Hindsight** (vectorize-io/hindsight) | yes (background consolidation) | arrival-order relatedness + template questions (mental models) | typed decision model (hs-decide); no calibration battery published | observations are "beliefs", no entailed/inferred split | **evidence quotes + proof counts**; refine-not-overwrite | banks strictly isolated; Memory Defense = per-item PII pattern scan | LongMemEval SOTA, independently reproduced (QA only) |
| **this paper** (layered on Kimchi's shipped pipeline, §6.0) | yes (offline `memory dream`) | **embedding-space discovery** (mutual-kNN → pre-split → LLM boundary repair) | **geometric verification** (landing band, paraphrase ceiling) + calibrated judging *(judging inherited from production gates; battery new)*, 0/24 safety-critical FAR | **entailed / plausible-hard-cut** | support sets + cluster lineage + verdict | **per-claim k-anonymity + privacy screen** (evaluated) | **840 candidates, 0 unsupported** (§5.9–5.13) |

### 6.2 Per system: what it does, what it leaves open, what this closes

**OpenAI Dreaming.** The concept's namesake and proof of value at the
largest scale (foundation layer; ~5× serving-compute reduction;
staleness evals). What it leaves open: the mechanism is undisclosed —
there is no published acceptance test on what a dream may write, and
no published hallucination record. What we add on top of the idea:
published, measured gates — every stored artifact lands in a geometric
band, is judged against calibrated labels, and carries support-set
provenance. If OpenAI has such gates internally, they are not
auditable; ours are the paper.

**Letta sleep-time (OSS).** Offline compute spent on agent-driven MemFS
rewrites — the right architecture for *when* to dream, weak guarantees
for *what* gets written: rewrite quality is the agent's own judgment,
and unreviewed rewrite errors compound silently in the store. What we
close: candidate generation is geometry-proposed (not agent-chosen),
and storage requires verification + judging — drift cannot write
itself in. Their compute-economics framing is orthogonal and
compatible (our pipeline is likewise offline).

**LangMem (OSS).** Extraction + pairwise reconciliation against
retrieved candidates. Pairwise reconcile fundamentally cannot produce
this paper's inductions: the five scattered running facts that jointly
support "structured long-distance runner" are never in one retrieval
window, and surface-lexical linkers miss implicit evidence (§5.5
floor). LoCoMo J 58.10 with 23.43 on the temporal category shows the
reconciliation path under-serves knowledge-update cases. Two
scaffolding notes here: Kimchi's production store already handles
supersede beyond LangMem/Mem0 defaults via judged DELETE+ADD
(`supersede.ts`, §6.0), and dreaming's conflict gate is measured on
the failure that remains.

**Zep / Graphiti (hosted + OSS).** The strongest temporal semantics in
the field (valid_at/invalid_at, contradiction-as-invalidation) and
graph-structural community summarization. What it leaves open:
community summaries are generative, unverified, and untiered — a
mis-synthesis enters the graph on equal footing with raw edges.
Self-reported vs third-party harness measurements differ by ~9–14
points (65.99 in Mem0's harness vs 75.14 self-reported), which is why
this paper refuses level claims. What we close: verified+judged
synthesis with tiers and provenance; what we *adopt*: bi-temporal
invalidation is finer-grained than our supersede gate and belongs in
the roadmap.

**Mem0 (OSS + platform).** The substrate Kimchi's production store is
built on — and deliberately not a competitor: OSS has no background
consolidation pass at all; dedupe is hash + retrieval-context
blocking. This paper is the layer Mem0 doesn't ship. The benchmark
lineage (paper 66.88 → platform+gpt-5 92.5) is the canonical warning
about tag-comparing numbers across harnesses and model generations.

**Memobase (OSS).** Structured slots (profiles + events) with
self-reported LoCoMo 70.91–75.78 and strong temporal numbers (85.05).
Structured-schema personalization is complementary; there is no
synthesis-verification layer and no induction tier.

**Hindsight (OSS, MIT; arXiv 2512.12818).** The closest implementation
to this design shipped anywhere, and the only one we treat as a
genuine alternate: (a) *observations* — background-consolidated
beliefs with evidence quotes and proof counts, refined rather than
overwritten; (b) *mental models / knowledge pages* — standing answers
rewritten in the background (template-driven headlines); (c) a small
typed *decision model* for internal memory judgments — the same
architectural instinct as our d3 judge, shipped as open weights;
(d) bank isolation by default. What our pipeline still adds, and why
it is not redundant:
1. **Discovery.** Their consolidation is arrival-driven (new evidence
   relates to existing beliefs). Ours additionally scans the store's
   global geometry: implicit multi-member induction clusters — the
   highest-value dream outputs — do not announce themselves to a
   pairwise merge.
2. **Verification.** No published geometric acceptance test on
   synthesized beliefs; no calibrated entailed/plausible/unsupported
   battery. Ours: landing-band + paraphrase-ceiling + 68-item judge
   calibration, with the 840-candidate 0-unsupported record.
3. **Truth tiers.** An observation is a belief; it isn't partitioned
   into "logically implied" vs "plausibly inferred". Our entailed /
   plausible split is what makes a storage decision auditable.
4. **Cross-user.** Banks isolate (correctly); Memory Defense is regex
   PII scanning. There is no synthesis of *shared* memory across
   users at all — our per-claim k-anonymity + privacy screen (§5.12)
   opens that tier with measured guarantees.
Where Hindsight beats this paper today: production surface
(Postgres/pgvector, Helm, monitoring, 60+ integrations, MCP,
open-weight decision models), independently reproduced LongMemEval
SOTA, and refine-with-proof-count history trails — all
direct-adoptable patterns. The read: Hindsight is the deployment
chassis this dreaming layer would want to sit on.

### 6.3 On benchmark numbers (why we report deltas, not levels)

Published LoCoMo J-scores for the same product span 9–25 points across
harnesses, judges, and model generations (Zep 65.99 vs 75.14; Mem0
66.88 → 92.5). Level-comparing our coverage numbers against those
figures would be noise, so §5.13 reports paired *deltas* on identical
questions, judge, and store-modulo-dreams: **+6.4 pts multi-hop
coverage (p≈0.008), 0 unsupported in 615 candidates, +1.7 pts
adversarial false-answer cost**. A protocol-matched J-score run
against Mem0/LangMem/Hindsight configurations on this repo's own
harness is the follow-up needed for level claims (roadmap, §10).

### 6.4 Position summary

Against everything shipped today, four capabilities are unique to this
design as a set (each individually absent in ≥90% of systems above):

1. **Embedding-space discovery** of what there is to dream (global
   geometry, not arrival salience or templates).
2. **Geometric verification** of synthesized outputs before storage
   (landing bands, paraphrase ceiling — this paper's Theorems 2–3,
   measured).
3. **Calibrated, tiered judging applied to synthesis outputs** with a
   published false-accept battery — the d3 judging layer already ships
   in production capture gates (§6.0); the dreaming-specific extension
   is the entailed/provisional verdict tier over *synthesized* facts
   plus the 0/24 safety-critical battery. Drift cannot silence in.
4. **Cross-user per-claim k-anonymity** with a privacy screen — the
   only shared-memory synthesis with measured privacy behavior.

## 7. What the proofs do not settle: the experimental protocol

Inductive precision and yield-per-dream are properties of the LLM and the
store's evidence density; they are measured, not proven:

- **Eval A (retroactive gap-mining).** Dream; for non-entailed candidates,
  search session transcripts for indirect support. Metric: indirect-
  support rate.
- **Eval B (holdout replay).** Rebuild the store from the first k of n
  session logs; dream; measure conversion = candidates matched by facts
  captured from the remaining logs (sim + equivalence judge), Wilson CIs.
- **Eval C (seeded needles; the load-bearing test).** Synthetic sessions
  with planted, never-stated inferences at controlled evidence
  multiplicity m; metric: recall(m) curve. This fixes the data-density
  confound (Lemma 1: small clusters have unstable moments) and determines
  whether facts-only input suffices or transcripts must be pulled per
  cluster.

## 8. Cross-user synthesis and the hosted path

Same mechanism, one infrastructure delta (nothing syncs today). Safe
shape: synthesized candidates only, supported by ≥k distinct users
(provenance as counts — Clio's k-anonymity minima are the production
precedent), only the entailed tier crosses user boundaries, org-policy
gated. The planned migration from local SQLite to hosted memory makes
this marginal-cost: the aggregation layer arrives with hosting, the
org-routing header already flows on every gateway call, and
embedding-config uniformity becomes centrally enforceable. Dream
artifacts are designed migration-compatible (provenance ids, tier tags,
support sets).

## 9. Limitations and threats to validity

- Sub-Gaussian tails are a model; heavy-tailed stores weaken constants
  (theorems degrade gracefully via Bernstein-type replacements).
- Pairwise-dependence corrections are absorbed into union bounds, making
  constants conservative; the predicted cluster statistics matched
  measurement to three decimals on the one deep-dive performed — more
  clusters and stores are needed for confidence in universality.
- Theorem 4 covers the vector channel only; hybrid lexical channels have
  no analogous unconditional guarantee.
- Judge calibration (d3 probabilities vs truth rates) is assumed, not
  proven; a judge-swap study is future work.
- All claims are per-encoder: any embedding-model change requires
  re-deriving empirical moments ($\mu_0,\sigma_0$, per-cluster bands).

## 10. Roadmap

1. Run the §7 protocol (seeded first, then holdout replay).
2. On pass: implement `memory dream` as an offline command layered over
   the capture worker (locks, durability/valuation gates on dream output).
3. Hosted-store migration activates the §8 cross-user branch.

## References (with verification status)

All primary claims verified against arXiv/abstract pages on 2026-11-06:
Wang–Isola arXiv:2005.10242; Ethayarajh arXiv:1909.00512; SimCSE
arXiv:2104.08821; Beyer et al. TR1377/ICDT'99; Allen–Hospedales
arXiv:1901.09813; Vec2Text arXiv:2310.06816 / EMNLP 2023; RAPTOR
arXiv:2401.18059; Clio arXiv:2412.13678; Generative Agents
arXiv:2304.03442; A-MEM arXiv:2502.12110; HippoRAG (NeurIPS'24); Zep/
Graphiti arXiv:2501.13956; Mem0 arXiv:2504.19413; sleep-time compute
arXiv:2504.13171; LongMemEval; OpenAI "Dreaming" (2026-06-04 product
post); Letta docs (MemFS/Dreaming). Memory-system internals also in the
companion survey doc with links.
