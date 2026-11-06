# The Kimchi Memory Book

**Status:** shipped reference · **Last verified:** 2026-11

How memory works here — all of it, in one place: what ships today, the
research behind what's next, and the platform design ahead.

**Audience:** technical developers. No memory background required — start at
the [primer](primer.md).

---

## Why memory needs a book

Two measured failures made the case:

1. **The store rots from the inside.** In a real, 184-fact store, ~10% of the
   contents were explicit paraphrase pairs — the same fact captured twice in
   different words. Nothing in a flat vector store notices.
2. **Flat search can't reach implied knowledge.** On the external LoCoMo
   benchmark, answering multi-hop questions from raw stored facts scores
   26.6%; adding machine-*synthesized* memories raises it to 33.0%
   (+6.4 points, sign-test p ≈ 0.008) — knowledge that was never written
   down, recovered and verified.

This book explains the system that addresses both: the phases that capture,
gate, store, and retrieve facts; the dreaming pipeline that synthesizes
verified new facts; and the hosted platform that extends all of it across
individuals, teams, and orgs.

## Status labels

| Label | Meaning |
|---|---|
| **shipped** | In `src/extensions/memory/` today. |
| **researched** | Specified and measured end-to-end; not implemented. |
| **proposed** | Design only; builds on pinned existing mechanics where marked. |

## The book

**Part 0 — Front matter**
- [Reading guide & glossary](reading-guide.md) — conventions, status labels,
  the one definition of every term.
- [Primer](primer.md) — agent memory from zero in one chapter.

**Part I — Big picture**
- [The lifecycle spine](overview.md) — one diagram from session to platform,
  every element status-labeled.
- [Competitive landscape](landscape.md) — who else does memory, with mechanism
  citations and honest numbers.
- [Design-decision records](decisions.md) — why the system is built this way.

**Part II — Phases (how it works today)**
1. [Capture](01-capture.md) — sessions → candidate facts.
2. [Storage & embeddings](02-storage.md) — the store, scopes, the embedder.
3. [Quality gates & d3](03-gates.md) — the five gates and the judge contract.
4. [Supersede & staleness](04-supersede.md) — retiring outdated facts safely.
5. [Retrieval, injection & residency](05-retrieval.md) — what reaches the model.
6. [Dreaming](06-dreaming.md) *(researched)* — synthesizing verified new
   memories.
7. [Measurement & operations](07-measurement.md) — checking and certifying the
   system.

**Part III — The platform (proposed)**
- [Scopes](10-platform-scopes.md) · [Shared distillation](11-shared-distillation.md)
  · [REST API](12-platform-api.md) · [Migration](13-migration.md) ·
  [Threat & privacy model](14-threat-model.md)

**Part IV — Evidence & upkeep**
- [Evidence index](appendix.md) — every measured claim, pinned.
- [Formal appendix](appendix-formal.md) — the proofs, complete and
  self-contained.
- [Maintenance contract](maintenance.md) — how this book stays true.

## Verified

Every measured claim in this book pins to a source file and section; a
docs-check script verifies links, terms, and pins mechanically
(see [appendix.md](appendix.md)).
