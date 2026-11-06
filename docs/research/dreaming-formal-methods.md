# Formal methods core: geometric gates for memory synthesis ("dreaming")

**Working draft v1 · 2026-11-06 · companion to `.kimchi/plans/memory-dreaming.md`**

This document is the math core of the whitepaper. Conventions: every
assumption is labeled and its empirical status stated; every empirical
number comes from runs on the reference store (bge-m3 embeddings, d=1024,
n=185 personal-store facts) reproduced in `.kimchi/plans/memory-dreaming.md` §Worked example.

---

## 1. Setup

- Store $M = \{t_1,\dots,t_n\}$: natural-language memory facts.
- Encoder $e : \mathcal{T} \to \mathbb{S}^{d-1}$ (here d=1024), outputs
  L2-normalized (verified empirically: mean raw norm 1.0000). Write
  $v_i = e(t_i)$, cosine $s(u,w) = \langle u, w\rangle$, angular distance
  $\angle(u,w) = \arccos s(u,w)$.
- Off-topic pair distribution: similarities of fact pairs drawn from
  distinct latent topics follow $F_0$, mean $\mu_0$, sd $\sigma_0$.
- Within-topic pair distribution: pairs sharing a latent topic $\theta$
  follow $F_1^{(\theta)}$ with mean $\mu_1^{(\theta)}$; we use a uniform
  lower bound $\mu_1 = \min_\theta \mu_1^{(\theta)}$ and uniform tail
  parameter $\sigma_1$.

**Empirical status (reference store):** $\mu_0 = 0.520$, $\sigma_0 = 0.104$
($n=184$, background = cross-cluster + singleton pairs, 16377 of them;
earlier snapshot $\mu_0=0.527$, $\sigma_0=0.111$ at $n=185$).
**Tail shape measured (claims battery):** empirical exceedance is uniformly
*below* the sub-Gaussian bound — $t=1$: 18.2% vs 60.7%; $t=2$: 1.73% vs
13.5%; $t=3$: 0.037% vs 1.11%; $t=4$: 0% vs 0.034% — the assumption's
constants are conservative on this store.
**Endpoint dependence measured:** Pearson $r = 0.296$ over 3000 random
endpoint-sharing triples — moderate positive dependence (union bounds
remain valid without independence; constants are conservative).
**Gap status:** all 17 measured clusters (size $\ge 3$) have within-pair
margins 2.0–3.4 $\sigma_0$ over background. The
concentration of $F_0$ at a positive mean is the anisotropy phenomenon of
contextual embeddings (Ethayarajh 2019, arXiv:1909.00512; "narrow cone" in
SimCSE, arXiv:2104.08821) and the distance-concentration phenomenon (Beyer
et al., ICDT 1999, TR1377: as $d$ grows, relative contrast between nearest
and farthest neighbor vanishes). Consequence adopted throughout:
**all thresholds are derived from the empirical moments of $F_0$, never
fixed constants** — i.e. thresholds are z-scored.

---

## 2. Assumptions

- **(A1) Latent topic mixture.** The store admits a latent partition
  $\mathcal{P}$ of $M$ into topics; pair similarities are distributed by
  $F_0$ / $F_1^{(\theta)}$ as above, with sub-Gaussian tails:
  $\Pr[|X - \mathbb{E}X| \ge t\sigma] \le \exp(-t^2/2)$ for pair
  similarities and for averages of $|\!A\!|\cdot|\!B\!|$ pair similarities
  with parameter $\sigma/\sqrt{|A||B|}$.
  *Status:* tail shape to be verified per store (Q–Q plot against Gaussian);
  the classic high-dimensional concentration results (Beyer et al.) make a
  sub-Gaussian model the default first-order choice; the theorems degrade
  gracefully if replaced by Chebyshev/Bernstein versions ($z$ grows, bounds
  weaken polynomially).
- **(A2) Encoder alignment.** $e$ trained with a contrastive objective
  exhibits *alignment* (positive pairs map close) and approximate
  *uniformity* on $\mathbb{S}^{d-1}$ (Wang–Isola, ICML 2020,
  arXiv:2005.10242, who prove the asymptotic that the contrastive loss
  optimizes exactly these two properties). We assume the finite-sample
  operational version: same-claim texts achieve similarity
  $\ge a_{dup} \approx 0.92$ and same-topic texts $\approx \mu_1$.
  *Status:* justified by the encoder's training class; validated
  empirically (near-twin pairs measured up to 0.988).
- **(A3) Separation gap.** $\mu_1 - \mu_0 \ge (z + z')\tilde\sigma$ for the
  z-parameters used in the gates, with $\tilde\sigma=\max(\sigma_0,\sigma_1)$.
  *Status:* checkable per store/cluster before dreaming; on the reference
  store the deep-dive cluster has gap $(0.899-0.527)/0.111 \approx 3.35\sigma_0$.

**Independence caveat (stated once, applies to all proofs):** pair
similarities sharing an endpoint are not independent. All bounds use union
bounds over pairs/averages, so they need no independence for *validity*,
only for the *tightness* of the constants. We flag where the iid
first-order approximation is used to *predict* (not bound) a quantity.

---

## 3. Lemma 1 — centroid concentration

Let $C = \{u_1,\dots,u_k\} \subset \mathbb{S}^{d-1}$ be one topic's members
with pairwise similarities $s(u_i,u_j) = \mu_1 + \eta_{ij}$, and let
$\hat c = \sum_i u_i \,/\, \lVert \sum_i u_i \rVert$.

**Claim.** For any member $u_j$,
$$s(u_j, \hat c) \;=\; \frac{1 + \sum_{i\ne j} s_{ji}}{\lVert \sum_i u_i \rVert},
\qquad
\lVert \sum_i u_i \rVert^2 = k + \sum_{i\ne l} s_{il} .$$
First-order (iid approximation): numerator concentrates at $1 + (k-1)\mu_1$
with sd $\sigma_1\sqrt{k-1}$; denominator concentrates at
$\sqrt{k + k(k-1)\mu_1}$ with relative deviation $O(\sigma_1/\sqrt{k})$, so

$$\mathbb{E}\, s(u_j,\hat c) \;\approx\; \frac{1 + (k-1)\mu_1}{\sqrt{k + k(k-1)\mu_1}},\qquad
\operatorname{sd}\big(s(u_j,\hat c)\big) \;=\; O\!\left(\frac{\sigma_1\sqrt{k-1}}{\lVert \sum_i u_i \rVert}\right)
\;=\; O\!\left(\frac{\sigma_1}{\sqrt{k}\,\sqrt{\mu_1}}\right).$$

The mean prediction is the ratio of the two displayed expectations; the sd
bound is the delta method on numerator and denominator under the iid
first-order model for the $\eta_{ij}$. Both mean and sd **shrink** relative
to the raw pair level as the cluster grows — the centroid is a noise-
reducing estimator of the topic direction.

*Proof.* The two displayed identities are algebraic; the estimates follow
from concentration of the numerator and denominator (§2 tail model) and the
delta method. ∎

**Validation (reference store, deep-dive cluster, k=17, measured pair mean
0.797):** Lemma 1 predicts member-to-centroid mean
$(1 + 16\cdot0.797)/\sqrt{17 + 17\cdot16\cdot0.797} = 13.752/15.29 \approx 0.899$ —
**measured 0.899**. The **sd is under-predicted by the iid model**
(first-order $O(\sigma_1/\sqrt{k\mu_1}) \approx 0.013$–$0.02$ vs measured
0.031): real topics have *sub-structure* (the port-config sub-cluster), so
member variation is not iid noise around one point-mass. This is exactly
why every gate below consumes the **per-cluster empirical** $(\mu_c,
\sigma_c)$ rather than the model's prediction — the gates inherit robustness
to topic sub-structure, at the cost of requiring $k \ge 3$–$5$ for the
empirical moments to exist.

**Design consequence.** Bands computed from the centroid get *narrower as
the cluster grows* — singletons and pairs have no reliable scatter, which
formalizes the data-density caveat: inference-worthy clusters need
$k \ge 3$–$5$ members.

---

## 4. Theorem 1 — exact topic recovery by gated average linkage

**Algorithm (HAC-AL(θ)).** Maintain clusters; repeatedly merge the pair of
clusters with maximal average pairwise similarity while that maximum
exceeds $\theta$; the surviving clusters are the output.

**Theorem.** Under (A1)–(A3), choose any threshold in the gap,
$\theta \in (\mu_0 + \beta_0,\ \mu_1 - \beta_1)$, $\beta_0,\beta_1 > 0$.
Then
$$\Pr\big[\text{HAC-AL}(\theta) \text{ returns exactly } \mathcal{P}\big]
\;\ge\; 1 - n^3 \exp\Big(-\tfrac{\min(\beta_0,\beta_1)^2}{2\tilde\sigma^2}\Big).$$

*Proof.* Consider every cluster-pair average $\bar s(A,B) =
\frac{1}{|A||B|}\sum_{a\in A}\sum_{b\in B} s_{ab}$ evaluated by the
algorithm (at most $n^3$, crudely). Call the event $\mathcal{E}$: every
same-topic average is $\ge \mu_1 - \beta_1$ and every cross-topic average
is $\le \mu_0 + \beta_0$. On $\mathcal{E}$:

1. *Only same-topic merges occur.* While an incomplete topic has two
   subclusters, their average exceeds $\theta$; any cross-topic comparison
   is below $\theta$, so the max-average selection never picks a
   cross-topic pair, and the loop only stops merging a topic when it is
   complete.
2. *Termination exactly at $\mathcal{P}$.* When every topic is complete,
   remaining cluster-pair averages are cross-topic, hence $\le \theta$, and
   the loop halts.

$\Pr[\mathcal{E}]$ follows from (A1)'s tail bound applied to each average
(with parameter $\tilde\sigma/\sqrt{|A||B|} \le \tilde\sigma$) and the
union bound over $\le n^3$ evaluations. ∎

*Small-$n$ honesty note (claims battery):* the union bound is loose at
reference-store scale ($n\!\sim\!10^2$, $n^3\!\sim\!6\!\times\!10^6$): its
meaningful content at this scale is not a literal probability number but
(i) the **rate** — failure decays exponentially in the squared gap margin
over tail width — and (ii) the **design rule** that the cut must sit
inside the gap. Measured tails are uniformly lighter than the sub-Gaussian
model (§1), so the bound is conservative; measured cluster margins are
2.0–3.4 $\sigma_0$ (§1), which is why the empirically chosen cut works.

*Remark (why the gap is empirically load-bearing).* The theorem is vacuous
without a real gap: on the reference store, raising the cut from $\tau
= 0.55$ to $0.70$ moved mean silhouette $0.112 \to 0.183$ (best) and the
grouped share from 93% → 75% — flat regions of the silhouette curve are
exactly where the gap is thin and the theorem's probability is weakest.
The theorem therefore licenses measuring the gap *first* and cutting inside
it, rather than fixing $\theta$ a priori.

---

## 5. Theorem 2 — three-zone classification with false-accept control

Let $C$ be a cluster of size $k$ with member-to-centroid moments
$(\mu_c, \sigma_c)$ supplied by Lemma 1, and define the acceptance band
$b_C = \mu_c - z\sigma_c$ and the background ceiling
$r_0 = \mu_0 + z_0\sigma_0$. The synthesized-fact classification map for a
candidate unit vector $x$:

$$\text{insider}: s(x,\hat c_C) \ge b_C; \qquad
\text{penumbra}: r_0 \le s(x,\hat c_C) < b_C; \qquad
\text{off-topic}: s(x,\hat c_C) < r_0 .$$

**Theorem (error control).** Under (A1)–(A3), for a candidate $x$
independent of the members of $C$:

- **(a) in-topic false rejection:** if $x$ is drawn from $C$'s topic law
  and the band uses the topic's **true** moments $(\mu_c, \sigma_c)$,
  $$\Pr[s(x,\hat c_C) < b_C] \;\le\; e^{-z^2/2}.$$
  **Small-$k$ caveat (measured, claims battery):** with the band *estimated*
  per-cluster from $k$ members, hold-one-out rejection rates diverge from
  the bound as $k$ shrinks and when a cluster is star-shaped (one hub,
  several wings): measured **12–36% at $k \ge 14$** (consistent), but
  **36–100% at $k \le 6$** — the $\sigma_c$ estimator is unstable there
  and star wings reject by construction (which is semantically correct
  odd-men-out behavior). Design rule: landing bands at $z{=}1.5$ are
  trustworthy from $k \ge 10$; below, they are advisory only — small
  clusters should rely on the kNN ego-group pass, and stars should expect
  wing rejections as signal, not noise.
- **(b) off-topic false acceptance:** if $x$ is drawn independently of
  $C$'s topic, its similarity to the centroid centers not at $\mu_0$ but
  (first-order, Lemma 1 algebra) at $m_{0c} \approx \mu_0/\sqrt{\mu_1}$ —
  $s(x,\hat c) = \frac{k}{\lVert\sum u_i\rVert}\cdot \overline{s(x,u_i)}
  \approx \mu_0/\sqrt{\mu_1}$. With $m_{0c}$ measured per store,
  $$\Pr[s(x,\hat c_C) \ge b_C] \;\le\;
  \exp\!\Big(-\frac{(\mu_c - m_{0c} - z\sigma_c)_+^2}{2\sigma_{0c}^2}\Big).$$
  *Measured (claims battery):* $\mu_0/\sqrt{\mu_1}$ predicts 0.56–0.61,
  store-measured foreign-to-centroid means 0.58–0.66 (the small excess is
  global topic correlation — this store is single-domain — so the bound
  uses the *measured* $m_{0c}$, never the bare $\mu_0$).

*Proof.* (a) is (A1)'s tail bound applied to $s(x,\hat c_C)$, which by
Lemma 1 shares the members' first-order law. (b) is the same bound on the
background side, centered at the measured $m_{0c}$. ∎

**Validation (reference store, deep-dive cluster).** $\mu_c = 0.899$,
$\sigma_c = 0.031$, $z = 1.5 \Rightarrow b_C = 0.853$.
- Hold-one-out empirical rejection: $2/17 = 11.8\%$; sub-Gaussian bound at
  $z=1.5$ is $\le 32.5\%$; Gaussian reference $\Phi(-1.5) = 6.7\%$.
  Empirical sits between — consistent with near-Gaussian member tails. The
  two rejected members are the cluster's genuine odd-men-out (a
  port-config fact; a symlink-management fact), i.e. the rejection is
  *semantically* correct, not noise.
- Off-topic: $(\mu_c - \mu_0 - z\sigma_c)/\sigma_0 =
  (0.899-0.527-0.0465)/0.111 = 2.94 \Rightarrow$ false-accept $\le 1.3\%$.
  Measured: 0/3 nearest foreign facts accept (they land 0.849/0.827/0.816,
  in the *penumbra*, as the zone map predicts for related-but-foreign
  facts).

**Zone semantics validated by the live synthesis run.** Real candidates
(cluster bands 0.853 / 0.826 / 0.840): consolidations 0.898 / 0.887 / 0.859
→ all three insider; deductions 0.822 / 0.804 / 0.757 → penumbra;
inductions 0.784 / 0.771 / 0.705 → deep penumbra, all far above the noise
floor 0.527.
The geometric ordering (`consolidation > deduction > induction ⋙
background`) matched the judge's truth ordering (entailed, entailed,
plausible) on all 9 real candidates.

---

## 6. Theorem 3 — soundness of the paraphrase ceiling

Call $t, t'$ **claim-equivalent** when they contain the same atomic claims
(operationalized: the judge rates them mutually entailing — this binds the
theorem to the d3 judge actually used in the pipeline).

**Theorem.** Let $x$ be a candidate for cluster $C$ and
$m(x) = \max_{j \in C} s(x, v_j)$. Under (A2) with same-claim alignment
level $a_{dup}$, any ceiling $\theta_{dup} \le a_{dup}$ satisfies: if $x$
is claim-equivalent to some member $t_j$, then
$$\Pr[m(x) < \theta_{dup}] \;\le\; \eta_{A2},$$
where $\eta_{A2}$ is the alignment failure probability; i.e. restatements
are flagged with error $\le \eta_{A2}$.

*Proof.* Immediate from (A2): claim-equivalence makes $(x, v_j)$ an
aligned pair, so $s(x,v_j) \ge a_{dup} \ge \theta_{dup}$ except on the
alignment-failure event. ∎

*Remark (one-sidedness is intended).* The ceiling is a sound *detector* of
restatement, not a complete one: a low-novelty synthesis that is *about*
one member without being claim-equivalent may pass $m(x) < \theta_{dup}$
— that is judged by the zonal/LLM layer, not the ceiling. Calibration:
$\theta_{dup} = 0.92$ on the reference store; real near-twins measure up
to 0.988; real *consolidations* measure max-member 0.830–0.890 — a clean
$0.89 \ll 0.92 \ll 0.98$ separation between "merge" and "copy".

---

## 7. Theorem 4 — angle-transfer retrievability (unconditional)

The sphere gives one *assumption-free* fact that grounds the
"condensation stays retrievable" requirement.

**Theorem.** For any query vector $q$, cluster centroid $\hat c$, and
candidate $x$,
$$\angle(q, x) \;\le\; \angle(q, \hat c) + \angle(\hat c, x),$$
equivalently $s(q,x) \ge \cos\big(\arccos s(q,\hat c) + \arccos s(x,\hat c)\big)$.
In particular, an insider candidate ($s(x,\hat c) \ge b_C$) inherits the
centroid's query rank up to an additive angle $\le \arccos b_C$.

*Proof.* $\angle(\cdot,\cdot)$ is the geodesic metric on
$\mathbb{S}^{d-1}$ (cosine of angle = inner product; triangle inequality
holds on any geodesic metric space). ∎

*Corollary (design rule).* Consolidations (in-band, $\arccos b_C$ small)
lose at most a fixed angular offset of retrieval proximity relative to
serving the centroid — geometrically they are *free* compression. A
penumbra candidate ($s(x,\hat c) \approx r_0$) degrades retrieval transfer
by $\arccos r_0$: induction is geometrically *expensive* for retrieval, and
anchor-preserving wording is what keeps its lexical (BM25/entity) channels
alive — the geometric theorem bounds the vector channel; the hybrid
store's lexical channel is bounded only by vocabulary overlap, which is
precisely what the vocabulary-fading probes measure (Eval suite, plan § Experiment design).

---

## 8. Remark — why decoding points in the space is not a viable generator

The naive dream — pick an interior point and decode to text — is ruled out
by structure, not engineering:

1. **Discrete image.** The encoder's image $e(\mathcal{T})$ over
  realizable fact texts is a discrete (measure-zero) subset of
  $\mathbb{S}^{d-1}$. A generically chosen interior point has no
  near-preimage; "the midpoint of two facts" is generically not near any
  fact's embedding (and the linear analogy structure that sometimes
  rescues *word* embeddings is quantitatively fragile under semantic
  composition — Allen & Hospedales, ICML 2019, arXiv:1901.09813, give the
  parallelogram property with explicit error terms that grow with the
  compositional distance).
2. **Inversion is text-conditioned.** The strongest published decoders
  operate per-embedding-model, require query access to the encoder, and
  recover *embeddings of real texts* (Vec2Text, arXiv:2310.06816: 92%
  exact recovery of in-distribution 32-token inputs) — they do not
  manufacture meaning at unoccupied coordinates, and no inverter exists
  for the production encoder (bge-m3). Forcing an inverter onto an
  arbitrary interior point returns text whose *re*-embedding matches the
  point but whose content has no support relationship to the cluster —
  precisely the failure our gates exist to reject.
3. **The correct decoder** is the one that returns to the discrete domain
  the source texts live in: generate a *sentence* from the cluster's
  own texts (LLM), then re-embed — which lands in the cluster's region by
  construction (Theorems 2/4 measured on the live run: real consolidations
  0.859–0.898 → insider). "Geometry proposes, text round-trips, geometry
  audits."

---

## 9. What remains empirical (stated for honesty)

- LLM synthesis precision/recall (induction yield) — no theorem of the
  above form can settle it; measured by the spike's seeded/holdout evals.
- Tail shapes (sub-Gaussian vs heavier) per store — affects constants, not
  the form of the bounds.
- Judge calibration (d3 probabilities ≈ truth rates) — separate study;
  the theorems use the judge only through the claim-equivalence definition
  (§6), so a judge swap changes calibration, not the geometry.
- Theorem 4 bounds only vector-channel retrieval; hybrid lexical channels
  require the anchor-preservation conditions measured separately.
