# Platform · Migration: local → hosted

> **Status: PROPOSED.** The migration *mechanism vocabulary* is existing;
> the sequence is design.

**Concepts you need:** [scopes](10-platform-scopes.md),
[truth tiers, support sets](reading-guide.md#glossary),
[`02-storage.md`](02-storage.md) schema · **Last verified:** 2026-11

---

## Goal

Move a user's (and later an org's) local memory into the hosted scoped store
without losing the properties the research established: provenance, tiers,
support sets, and a verifiable end state.

## What already exists (*existing* pins)

- `src/extensions/memory/migrate-agent-memory.ts` (+ tests) — the shipped
  in-repo migration tool precedent (moves memories between stores through
  the backend, audited). The hosted migration extends this pattern, not
  replaces it.
- The current store schema ([`02-storage.md`](02-storage.md)) is plain and
  inspectable — one table, plaintext payloads — so an export is a `SELECT`.

## Migration-compatible artifacts

The store's payloads must survive into the platform with these preserved:

| Artifact | Purpose on platform | Today |
|---|---|---|
| fact text + hash | dedupe identity | shipped |
| provenance id | traceability of origin | shipped (id) |
| tier tag | entailed vs plausible display policy | *to add* (research only) |
| support set | k-anonymity + audit | *to add* (research only) |
| scope anchor | where it lands on the tree/bands | *to add* at export time |

Items marked *to add* are exactly the fields whitepaper §8 demands the
dream implementation emit; they are backward-compatible payload keys.

## Sequence

```mermaid
flowchart LR
    LOC["local stores<br/>(personal · agent · project)"] --> EXP["1 · export<br/>(SELECT + annotate origin)"]
    EXP --> HYG["2 · hygiene sweep<br/>(twin-merge first — measured ~10% redundancy)"]
    HYG --> MAP["3 · map scopes<br/>personal→individual · agent→project band"]
    MAP --> IMP["4 · bulk import<br/>(retain API, org-attributed)"]
    IMP --> VER["5 · VERIFY PASS<br/>memory:measure-like composition<br/>+ spot judge battery"]
    VER --> CUT["6 · cutover (dual-read window, then local=read-only)"]
    CUT -.-> BACKOUT["backout: locals untouched until cutover"]
```

Why hygiene first: measured redundancy (~10% paraphrase pairs in the real
store; 17/48 in the spike era) means an unmerged import permanently
cements duplicates into the shared store. The dreaming pipeline's
twin-merge step already implements this merge offline.

## Guarantees

1. **Nothing destructive pre-cutover** (the backout story is that simple).
2. **Encoder uniformity enforced at import** — org-level embedding config
   ([`12-platform-api.md`](12-platform-api.md)) replaces per-user drift; a
   store embedded with a foreign encoder is re-embedded at import, with
   tier tags recomputed by re-judgment where support sets exist.
3. **Verification is measured, not assumed** — the composed digest on the
   hosted store is compared against the local baseline
   ([`07-measurement.md`](07-measurement.md) protocol), replaying a fixed
   prompt set.

## Failure modes (anticipated, from on-record incidents)

- Hash/dedupe desync across schema generations (the skimmed-fact incident,
  [`02-storage.md`](02-storage.md)) → verify pass must count and reconcile.
- Partial import without incremental flush (LoCoMo operational lesson,
  [`07-measurement.md`](07-measurement.md)) → chunked, resumable uploads.

## Code pointers (existing)

`src/extensions/memory/migrate-agent-memory.ts` (+ tests) ·
`backend.ts`/`embedder.ts` (export path) · proposed endpoint family in
[`12-platform-api.md`](12-platform-api.md).

## Open items

- Project-band mapping for multi-repo users (many project bands per user).
- Dead-store GC on the platform side after cutover.
