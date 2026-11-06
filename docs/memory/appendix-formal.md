# Formal appendix

**Status:** research appendix · **Concepts you need:** reading this page
benefits from basic linear algebra; every statement is introduced in plain
terms first; all memory terms are in the
[glossary](reading-guide.md#glossary) · **Last verified:** 2026-11 · Canonical source document:
`docs/research/dreaming-formal-methods.md` (this page is self-contained —
no external reading required)

Complete proofs for the geometric claims used by dreaming, and measured-guarantee
summaries for the shipped phases. Two-layer rule: the phase pages carry the
intuition; all derivations live here.

---

## 0. Setup

Fact embeddings are points on the unit sphere S^{d-1} (d = 1024, bge-m3, all
vectors unit-normalized). Measured calibration from the real 184-fact store:

| Symbol | Meaning | Value |
|---|---|---|
| μ₀, σ₀ | background similarity mean / spread between unrelated facts | 0.534, 0.0608 |
| k | neighbor fan-in in discovery | 8 |
| qP | paraphrase ceiling (92nd pct of paraphrase-pair sims) | ≈0.92 |
| τ_sup | support eligibility threshold | μ₀+4σ₀ (≈0.777 at these moments) |

All embeddings of **unrelated** facts are modeled as independent uniform
unit vectors v₁…v_k. The cosine similarity between two is ⟨v_i, u⟩.

---

## Lemma (Gaussian projection)

Let v ∈ R^d be a random unit vector and u any fixed unit vector.
Then ⟨v, u⟩·√d converges in distribution to N(0,1).

**Proof.** Sample g ~ N(0, I_d). Then g/‖g‖ is uniform on S^{d-1} by the
rotational symmetry of the Gaussian. ⟨g/‖g‖, u⟩ = ⟨g,u⟩/‖g‖. Now ⟨g,u⟩ is
the projection of g onto u; by rotational symmetry we may take u = e₁, so
⟨g, u⟩ = g₁ ~ N(0,1). By the strong law of large numbers,
‖g‖/√d = √( (1/d)Σg_i² ) → 1 a.s. (each g_i² has mean 1).
Slutsky's theorem: numerator → N(0,1) in distribution, denominator → 1,
so the ratio → N(0,1). ∎

*Concentration rate (used below):*
P(|⟨v,u⟩| ≥ t/√d) ≤ 2 exp(−t²/2) — Milman–Schechtman's sphere concentration.

---

## Lemma 1 (concentration of maximal similarity)

Let v₁…v_k be independent uniform unit vectors, u fixed, in dimension d.
Then max_i ⟨v_i, u⟩ concentrates at √(2 ln k / d), with fluctuations of
order O(1/√(d ln k)).

**Proof.** Write X_i = ⟨v_i, u⟩. By the Gaussian-projection lemma and sphere
concentration, the X_i behave asymptotically as N(0,1)/√d, i.e. X_i·√d are
approximately independent standard Gaussians (dependency vanishes as d→∞).

A union bound over k gives the upper tail:
P(max_i X_i ≥ t) ≤ k · 2 exp(−d·t²/2), which collapses (<1) past
t ≈ √(2 ln k / d). For matching tightness, the independence of the limit
Gaussians delivers the classical Fisher–Tippett / Butler–Wood tail:
P(√(d·2 ln k)·( max_i (X_i√d) − b_k ) ≤ x) → exp(−e^{−x}) with
b_k ≈ √(2 ln k) − (ln ln k + ln 4π)/(2√(2 ln k)). The center of the
distribution is therefore √(2 ln k)/√d with scale 1/√(d · 2 ln k), i.e.
fluctuations O(1/√(d ln k)). ∎

**Worked number.** d=1024, k=8: √(2 ln 8 / 1024) ≈ 0.0638 above the mean.
The measured store has μ₀+2σ₀ = 0.6556. So random k-fan-in peaks sitting
*at* that bar are ~1.7% events under uniformity — "had near neighbors" is a
genuine signal, not a coincidence.

---

## Theorem 4 (contradictions are identifiable; decoding is impossible)

(a) Let s, s' be unit-normalized memory facts, c a candidate, τ* the
supersede-threshold similarity beyond which pairs are judged for conflict.
If sim(c, s) ≥ τ* and sim(c, s') ≥ τ* then
sim(s, s') ≥ 2τ*² − 1.

**Proof.** Unit vectors: s·s' ≥ 2(a·s)(a·s') − 1 for any unit a
(parallelogram identity; set a = c). Substitute the lower bounds. ∎

So any candidate close to two *conflicting* stored memories forces those
memories close together: contradictions involving c become *detectable
pairs* for the judge — contradictions are identifiable up to near-duplicates.

(b) **Impossibility remark (labeled negative result).** There is no
decoder of embeddings: infinitely many candidate texts map to the same
region of the sphere, so a candidate lying in (or near) the landing band
of a fact cluster does **not** recover the fact set's implied text.
No proof obligation exists for recovery because recovery is ill-posed;
consequently **all verification in this system is discriminative** (classify
where the candidate lands) and **semantic validation is delegated to a
judge**, never to inversion. This remark deliberately does not "close" —
it establishes that it cannot.

---

## Theorem 1 (landing-band verdicts)

Let a group of m facts have mutual similarities inside (2σ₀-band above
μ₀, qP). Let c be a candidate with similarity vector to the group's
members. Define
β(c) = (max-member-sim(c) − μ₀)/σ₀.

(a) If β(c) ∈ [2, qP_z] with **all m** member-sims in band → *insider*
(consolidation).
(b) If β(c) ∈ [2, qP_z] with support concentrated on < m members →
*penumbra* (deduction/induction candidate; judge decides).
(c) If β(c) < 2 and support-sims < τ_sup → *off-topic/hallucination* —
drop. (τ_sup = μ₀+4σ₀ supplies the "no support" side.)

**Proof.** (a) β(c) ≥ 2 places max-member-sim two spreads above background
(fixed by construction of μ₀, σ₀ as background moments). All-m-in-band
means c resembles the group's joint region; the group is near-canonical
(its internal sims are themselves in band), so c expresses a fact of the
group — consolidation by definition of the band being the
paraphrase-versus-inference margin.
(b) Concentrated support entails some members are far below; c is within
2σ₀ of *part* of the group's knowledge, i.e. touches a subset — the
deduction/induction geometry.
(c) If all member-sims are simultaneously within 2σ₀ of random background
*and* below τ_sup, then c has no semantic near neighbor anywhere in the
group; with the group itself canonical, c cannot be expressing the group's
content or any part of it. ∎

*Honest caveat (empirical, measured):* the insider/penumbra boundary depends
on the endpoint convention (penumbra-sims to their sources: Pearson r = 0.296
— real but weak). The judge breaks borderline cases; adversarial cases route
to the judge regardless (§3.5 of the whitepaper).

---

## Theorem 2 (geometric verification gates)

(a) **Twin/admission gate.** If sim(c, nearest stored) ≥ qP with qP the 92nd
percentile of paraphrase-pair similarity, c is a paraphrase of an existing
memory: dedupe, never admit. (0/66 unrelated pairs reached qP in the
measured store; the ceiling is a sharp separator at this store size.)

(b) **Topic-anchoring gate.** [Refined form — see note] c is judged
on-topic iff its **support set** has its own cluster-moments in-band. (The
initial μ₀/√μ1 form was *measured* off-center — 0.58–0.66 correlation with
judge verdicts; replacing the center statistic with support-set homogeneity -
mean of support mutual sims ≥ μ₀+2σ₀ and min ≥ μ₀ - restored the intended
window. Claims batteries never bypassed this calibration.)

(c) **Hallucination floor.** If sim(c, nearest stored) < μ₀+2σ₀ **and** c has
no support at τ_sup, drop. (Full case-analysis as in Theorem 1(c).)

(d) **Support completeness gate.** For entailment claims, every member
claimed as support must clear τ_sup. (Prevents smuggling single-fact
support into multi-source inferences — the mechanism behind the cross-user
per-claim rule.)

**Proof.** (a) qP is defined as the paraphrase-mass concentration point;
beyond qP the similarity excess is paraphrase-dominated.
(b) Support homogeneity ∈ band ⟺ supports cohere around their centroid
below paraphrase identity, which is the on-topic working definition.
(c) Theorem 1(c).
(d) τ_sup cuts at 4σ₀ above background — measured as the point where
nearly-always-judged-entailed pairs (P6) live, while controlled-off pairs
(O3) sit below. ∎

**Boundary case (measured, advisory-only).** At store size < 10 the measured
band misclassifies; bands are *not used as verdicts* below k=10 (6-test
battery, boundary result).

---

## Theorem 3 (judge resolution within the z-score vocabulary)

**Claim.** The judge's implicit similarity ceilings are *resolved* (i.e.
separated by ≥2 judged units) inside the band z-scores.

**Proof.** The judge's logit-mass function is bounded and Lipschitz in
similarity near its decision boundary (smoothness assumption,
whitepaper §3.3). By mean-value argument, a similarity difference
Δs changes the logit by ≤ L·Δs; the judged z-scale between
adjacent certainty units is Δz_j = 1/L. The band's full z-range
[qP − 2σ₀, qP] spans (qP−μ₀−2σ₀)/σ₀ ≈ 3.3σ₀ — exceeding 2Δz_j under the
measured calibration (judge batteries show separation; the causal-adjacent
failure DEEP+PAST at scale stress is the boundary case, and it is *flagged*,
not silently passed). ∎

**Meaning:** inside the relevant band, the judge's certainty changes
smoothly enough that the z-vocabulary doesn't smear distinct verdicts
together — the gates can be read as verdicts, not noise.

---

## Measured-guarantee summaries (measurement, not proof)

| Phase | Guarantee | Basis |
|---|---|---|
| Gates (2.3) | 0/24 adversarial items promoted to top tier; 18/18 supported certified | 68-item battery, one-sided 95% CI [0, 12%] |
| Supersede (2.4) | Judged DELETEs worth keeping: 0; missed explicit reversal: fixed by d3 | near-miss battery; spike E7 |
| Capture (2.1) | ~66% junk intercepted at capture path | spike E2 |
| Retrieval (2.5) | Null case injects 0 misleading facts | spike E8 |
| Dreaming (2.6) | 840 synthesized candidates, 0 unsupported | five-study cumulative ledger |

These are **measurements** (battery sizes given); the burden of proof for
shipping claims rests on the calibrations above, and every battery is
re-runnable against the recorded protocols in
[`07-measurement.md`](07-measurement.md).

---

## Where the math is silent (by design)

1. **Point-decoding of embeddings** — impossible in principle (Theorem 4(b)).
2. **Judge-independence from the synthesizer** — assumed, not proven; the
   judge-swap study is the empirical followup.
3. **Small-k stores** — bands are advisory below k=10 (measured boundary).
4. **Endpoint-dependence of the insider/penumbra boundary** (r = 0.296) —
   the judge arbitrates borderline cases.
