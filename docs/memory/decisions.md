# Design-decision records

**Status:** shipped decisions (+ two researched intents) ·
**Concepts you need:** [gate / judge](reading-guide.md#glossary),
[anisotropy](reading-guide.md#glossary) · **Last verified:** 2026-11

Why the memory system is built this way. Every record cites its evidence from
the development history (decision-model spike, eval-docs, whitepaper studies);
each names the alternatives rejected and what would reverse the decision.
Undocumented origin points are marked *not recorded* rather than invented.

**Format:** · **Context** · **Decision** · **Rejected** · **Evidence** ·
**Reversal triggers**

---

## ADR 001 — Mem0 as the storage substrate, with a supersede patch

**Context.** The system needs a fact store with semantic search and
update/delete. Building a custom store competes for time with the actual
product surface.
**Decision.** Use mem0ai/oss (SQLite + sqlite-vec via a local port) as the
substrate; fork the update path into a judged supersede (DELETE+ADD).
**Rejected.** Custom store from scratch (undifferentiated); Layered/graph
store (premature — see ADR 006).
**Evidence.** Development doc `docs/memory-extension.md`; the supersede
re-shape validated in spike E7.
**Reversal.** If scoped platform storage lands (Part III), mem0's local model
becomes a cache at best; revisit then.

## ADR 002 — d3 as the gate/judge model

**Context.** Extraction over-emits (66% of coding-window output is transient
junk by the intended taxonomy) and regex floors miss almost all of it
(6/85 facts).
**Decision.** Insert d3 (the `systemone` decision model) as typed,
batched gates around the LLM at triage, valuation, digest-selection, and
recall points.
**Rejected.** Thresholds on raw similarity (see ADR 005); production LLM at
every point (cost/latency: d3 is ~300–450 ms warm, input-token-only pricing).
**Evidence.** Spike E1 (87% windows skipped, −93% calls), E1b (recall 8/8
seeded at P(yes) 0.52–0.998; false-open 0/8), E2 (keeps 34%), E3/E4
(null-safe injection).
**Reversal.** Model retirement; latency budget violation on new surfaces;
calibration decay (monitored per ADR 003's regression protocol).

*Origin note: d3 was chosen during the October spike; alternatives considered
beyond "thresholds" and "production LLM everywhere" were not recorded.*

## ADR 003 — Gate criteria are pinned, verbatim derivation from the extraction prompts

**Context.** Small criterion wording shifts silently change what the gates
admit.
**Decision.** Production criteria strings in `gates.ts` are frozen constants
derived from the extraction criteria, not paraphrases of them; changing them
requires the regression protocol in
[`07-measurement.md`](07-measurement.md).
**Rejected.** Free-form/iterative criteria tuning (cheap, but measurably
blinds whole fact classes).
**Evidence.** Spike E5→E5b: paraphrased criteria blinded triage to the
assistant-engaged fact class entirely (0/4 needle windows → 4/4 after
verbatim criteria). Same failure shape as E2's personal-life discards.
**Reversal.** Extraction-prompt change (criteria re-derived together).

## ADR 004 — Supersede is a d3 judgment with conservative deletion

**Context.** "Add-only" stores quietly rot: outdated facts keep answering
queries after the world moves on.
**Decision.** Supersede is judged per-candidate by d3 (delete/keep +
relation class) with a conservative rule — if the replacement might be wrong,
keep both. Truth survives a false-positive update.
**Rejected.** Add-only (visible contradiction build-up); production-LLM
prompt judge — *missed an explicit preference reversal at pDel=1.0 confidence
for d3* (E7 Part A); vector-equality replacement (misses concept-level drift).
**Evidence.** Spike E7 Part A (reversal case), E7 Part B (scan relation
classes), whitepaper §5.11 near-miss battery (judged DELETEs worth keeping
at 0, near-miss detection).
**Reversal.** Consolidation sweep replacing per-case judgment at scale.

## ADR 005 — Every threshold is measured against the live distribution, never assumed

**Context.** Vector-similarity thresholds are distribution constants in
disguise; encoders differ wildly (unrelated texts sit at ~0.5–0.6, not 0).
**Decision.** All numeric bars (gates, bands, τ_sup) are computed from
empirical moments (μ₀, σ₀, qP) of the *current* store and encoder, and are
re-measured on encoder change.
**Rejected.** Fixed thresholds (e.g. relevance ≥ 0.2): with bge-m3 the
top-8 floor is ≈0.39, so a 0.2 gate filters nothing — dead on arrival.
**Evidence.** Spike E8; whitepaper §4–§5 empirical calibrations across five
studies.
**Reversal.** None — this is a process rule, re-armed by every encoder or
store-composition change (see [`maintenance.md`](maintenance.md)).

## ADR 006 — Flat store now; derived structure on top, not a graph rewrite

**Context.** Graph stores promise multi-hop structure; they cost temporal
modeling, dedupe complexity, and schema maintenance up front.
**Decision.** Keep the flat vector store; build derived structure (dream
groups, tiers, eventually scopes) as *layers on top*, never by rewriting the
store.
**Rejected.** Graph-first (Zep-style): heavier to build, harder to dedupe,
worse fit for solo/small-team early usage; Memobase-style profile slots:
overfits human-attribute recall, not engineering work.
**Evidence.** Landscape comparison (whitepaper §6); structure-on-top was
validated by dreaming's flat-store discovery runs (§5.6–§5.10).
**Reversal.** Platform scale with heavy cross-entity queries (Part III scope
model may introduce a relation layer).

## ADR 007 — Geometric verification + independent judge, not "more LLM in the loop"

*Researched decision (dreaming; not shipped).*
**Context.** Synthesis hallucinates; the cheap fix (let the synthesizer
self-check) inherits its own paraphrase drift.
**Decision.** Verify with geometry first (landing-band classification against
the background distribution; [proofs](appendix-formal.md)), judge with an
independent model (d3) per cluster second. The judge's own calibration is
measured adversarially (0/24 safety-critical FAR on 68 items).
**Rejected.** Author-judges-own-work (custom GPT memories admitted without
verification); human review (only in a weekly digest for *plausible* tier).
**Evidence.** Whitepaper §3–§5; 840/0 cumulative ledger.
**Reversal.** Judge-model change (calibration battery must re-pass); band
refinements (Theorem 2(b) revision already happened once).

## ADR 008 — Discovery is over-propose + divide labor, dreaming runs offline

*Researched decision (dreaming; not shipped).*
**Context.** Neither geometry nor LLM alone recovers cross-fact implications:
a single flat threshold either misses scattered evidence or fuses megatopics;
an LLM partitioner alone degrades past ~15 facts.
**Decision.** Geometry (mutual-kNN, conservatively over-proposing) →
geometric pre-split (HAC at μ₀+1σ₀) → LLM boundary repair → coherence/privacy
screen → synthesize with a force-the-headline kind. Computed **offline**
(weekly job), never inline with sessions.
**Rejected.** Flat threshold (0/3 → 0/4 recall across two documented
failures); LLM-alone partition (dropped evidence, fragmented targets at
k=15); inline dreaming (latency; dreaming must not delay sessions).
**Evidence.** Whitepaper §5.5–§5.6 (v1 failure → v2 success), §5.7 (6/6 at
scale).
**Reversal.** Session-scale growth reopens the online/offline boundary; the
64-question judge cap already shapes batching.

---

**Cross-cutting origin notes.** Capture-point reasoning (pre-compact +
shutdown): premise recorded in `docs/memory-extension.md`; no session
material in the pruned transcripts mirror (marked *no trace found* in the
source ledger rather than reconstructed). Operational debts (backlog-age
alerting, per-endpoint credential channels) trace to the October embedding
outage and live in [`07-measurement.md`](07-measurement.md).

**Next:** [`01-capture.md`](01-capture.md) — phase one.
