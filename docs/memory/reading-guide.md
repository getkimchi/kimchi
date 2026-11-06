# Reading guide & glossary

**Status:** shipped reference (book conventions) · **Last verified:** 2026-11

How to read this book, what every label means, and the one place where every
memory term is defined.

---

## How to read this book

The book assumes you are a competent developer who has never worked on, or
read about, agent memory systems. Nothing else. If a term feels unexplained,
it should be in the [glossary](#glossary) below; if it is not, that is a bug —
file it with the maintenance contract in [`maintenance.md`](maintenance.md).

**Recommended paths:**

1. **I just want to understand what memory does here** →
   [`primer.md`](primer.md) → [`overview.md`](overview.md) → stop.
2. **I am going to work on the harness memory code** →
   [`primer.md`](primer.md) → [`overview.md`](overview.md) →
   [`decisions.md`](decisions.md) → the phase pages
   [`01-capture.md`](01-capture.md) → [`07-measurement.md`](07-measurement.md)
   in order.
3. **I care about the research (dreaming, verification math)** →
   [`overview.md`](overview.md) → [`06-dreaming.md`](06-dreaming.md) →
   [`appendix-formal.md`](appendix-formal.md). Proofs are self-contained in the
   appendix; intuition lives in the pages.
4. **I care about the hosted platform direction** →
   [`overview.md`](overview.md) → [`10-platform-scopes.md`](10-platform-scopes.md)
   → the rest of Part III in order.

Every page follows the same anatomy:

> **Concepts you need → Goal → How it works (diagram) → Guarantees →
> Failure modes on record → Code pointers → Status → Open items**

Every page also carries exactly one **status label**:

| Label | Meaning |
|---|---|
| **shipped** | Implemented in `src/extensions/memory/` today. |
| **researched** | Measured and specified end-to-end, but not implemented. (Dreaming is this.) |
| **proposed** | A design for the hosted platform. Nothing exists yet beyond the pinned *existing* mechanics it builds on. |

Diagrams are [Mermaid](https://mermaid.js.org/) and required. Each diagram on a
phase page is a zoom of one stage of the lifecycle spine in
[`overview.md`](overview.md).

## Conventions

- **Terminology is centralized here.** Pages *link back* to glossary entries;
  they do not re-define them. The docs-check script verifies that every memory
  term used on a page is covered by an entry below.
- **Numbers pin to sources by file + section heading**, not line numbers
  (lines drift). Measured claims are restated character-exact from their
  source; see the evidence index in [`appendix.md`](appendix.md).
- **File paths, never line anchors**, when pointing at code.
- **Competitor numbers are tagged** self-reported or third-party; level
  numbers on benchmarks are never compared across harnesses, only deltas —
  see [`landscape.md`](landscape.md).
- **Proofs are two-layer.** Statements and intuition live in the page bodies;
  complete proofs are in [`appendix-formal.md`](appendix-formal.md).

---

## Glossary

Foundational terms first, then Kimchi-specific terms, then platform terms.

### The world

- **Agent memory.** The set of durable facts an agent keeps across sessions so
  it does not start every conversation blank. Distinct from the chat
  transcript, which is ephemeral context.
- **Fact (memory item).** One atomic, self-contained statement worth keeping
  ("Emma moved to Brooklyn in 2017"). The unit of capture, storage, retrieval,
  and verification.
- **Digest.** Kimchi's term for the rendered set of facts shown to the model
  at session start (see *injection*).
- **Capture.** Turning a session (or a turn) into candidate facts.
- **Extraction.** The LLM pass inside capture that picks out candidate facts.
- **Gate.** A check a candidate must pass before it is admitted: value,
  conflict, stale, off-topic, supersede. A passed gate means "admitted", not
  "true" — gates stop noise, they do not certify truth.
- **Judge (decision model).** The LLM evaluator (today: `d3`) that answers
  typed yes/no/multi-choice questions with probabilities. Powers both gates
  and dreaming verification.
- **Supersede.** The operation that retires an outdated fact (logical DELETE)
  and inserts the replacement (ADD). Conservative deletion: if the replacement
  might be wrong, keep both rather than destroy a good memory.
- **Embedding.** A numeric vector computed from text so that semantic
  similarity becomes arithmetic. Two vectors close together ⇒ similar meaning.
- **Embedding space.** The region where all embedded facts live. With the
  current encoder all vectors sit on the **unit sphere**; closeness is measured
  by **cosine similarity** in [-1, 1].
- **Anisotropy.** The property that embeddings of unrelated texts cluster
  around ~0.5–0.6 rather than 0. Baselines must be *measured*, never assumed
  (see *background distribution*).
- **Consolidation.** Combining several memory items into one broader, more
  durable summary. One of the standard memory operations
  (Hu et al., 2025 taxonomy).
- **Updating.** Changing stored information as the world changes; here:
  supersede.
- **Indexing.** Making memories findable: embeddings, graphs, timestamps.
- **Forgetting.** Removing low-value or outdated information.
- **Retrieval.** Fetching the memories relevant to the current moment.
- **Condensation.** Keeping a short, useful representation instead of the raw
  transcript; here: the digest.
- **Dreaming (synthesis).** The research pipeline that scans stored memories,
  proposes groups of related facts, and asks an LLM to write **new** facts the
  set implies — then verifies them before admitting any.
- **Truth tier.** The dream page's answer to the supersede debate: memories
  keep labels — **verified** (judge-entailed) and **plausible** — rather than
  being silently overwritten.
- **Support set.** The stored facts a vetted dream explicitly cites. Used for
  audit, k-anonymity counting, and support-degree ranking.
- **LoCoMo.** An external benchmark of long multi-session conversations with
  question-answer pairs; used to test that dreaming helps independent QA,
  not just self-agreement (see [`06-dreaming.md`](06-dreaming.md)).

### Terms shaped by the geometry

These exist because embeddings live on a sphere and near-duplicates cluster
high. Each has a measured calibration, defined in
[`06-dreaming.md`](06-dreaming.md) and proven in
[`appendix-formal.md`](appendix-formal.md).

- **Background distribution.** The null distribution of similarities between
  unrelated facts, with empirical mean μ₀ and spread σ₀. The ruler all
  "surprising" claims are measured against.
- **Landing band.** The acceptance interval (μ₀+2σ₀, qP)· used to classify a
  candidate dream's similarity to the store: **insider** (in band ⇒ resembles
  what is already known ⇒ likely consolidation), **penumbra** (past the band
  but near some source ⇒ needs human-style judgment ⇒ deduction/induction
  candidates), **off-topic** (magnetically far ⇒ rejected as hallucination).
  Advisory-only below store size 10.
- **Paraphrase ceiling (qP).** The 92nd percentile of paraphrase-pair
  similarities — the practical "says the same thing" bar (measured ≈0.92).
- **Cluster distance floor.** The strictest near-neighbor similarity inside a
  discovered group; used to gate eligibility checks.
- **Support eligibility threshold (τ_sup).** μ₀+4σ₀ — the bar a source must
  clear to count as supporting a candidate. Chosen geometrically, grounded in
  the judge's near-miss behavior.
- **Synthesis kinds.** What the dream wrote, classified by where it landed:
  **headline** (names one umbrella claim), **consolidation** (merges
  duplicates), **deduction** (new fact entailed from supports), **induction**
  (generalized category).
- **Screens.** Two gates run on proposed dream groups: **coherence** (is the
  group actually one topic?) and **privacy** (does combining these facts paint
  a trust-damaging picture of a person?).

### Platform terms (Part III)

- **Scope.** The audience a memory is visible to. Locally today: `personal`
  (only you, symmetric encryption) and `agent`. On the platform: org → team →
  individual tree with **project** as an orthogonal cross-cutting band.
- **k-anonymity (per claim).** Before a distilled memory crosses between
  users, every one of its atomic claims must be supportable by at least two
  users. "The group contains two users" is not enough — handover facts have
  dual provenance by design; flaky-reviewer facts often do not.
- **SHARED / PERSONAL / DROP.** The tiers from the distillation ladder:
  cross-user claims with full support (SHARED), single-user traits (PERSONAL,
  metadata-only at best), and provocateur-only glue (DROP).
- **Counts-not-names provenance.** The ledger field that remembers *how many*
  users supported a memory, not *who* — used when computing k-anonymity.
- **Organization attribution.** The `X-CastAi-Organization-Id` header carried
  on gateway calls today; the isolation boundary every platform query is
  scoped to.

### Conventions you will see in every table

| Symbol | Meaning |
|---|---|
| `sim` | Cosine similarity |
| `μ₀`, `σ₀` | Mean and spread of the background distribution |
| `qP` | Paraphrase ceiling (~0.92 measured) |
| `m` | Number of facts in a proposed dream group |
| **840/0** | Cumulative dreaming-candidate ledger: 840 judged, 0 unsupported |
| **0/24** | Judge-calibration: 0 of 24 adversarial unsupported items promoted to the safety-critical top tier |
| **+6.4pts** | LoCoMo multi-hop QA gain from adding vetted dreams to retrieval |

---

## What this book does not cover

- The pi-mono extension API in general (see the top-level `docs/`). This book
  is about memory, not the harness.
- Full research details: the whitepaper (`docs/research/memory-dreaming-whitepaper.md`)
  remains the formal record; this book is the readable map to it.
- Commitments about shipping dates. Nothing in Part III is scheduled.
