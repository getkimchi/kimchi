# Maintenance contract

**Status:** process · **Last verified:** 2026-11

How this book stays true. Pages carry a "last verified" stamp in their
header; this contract defines when stamps reset.

---

## Re-verify triggers

| Trigger | Pages to re-verify | Why |
|---|---|---|
| Gate criteria constants edited (`gates.ts`) | [`03-gates.md`](03-gates.md), [`07-measurement.md`](07-measurement.md) | Pinned criteria are behavioral constants (ADR 003) |
| Store schema changes (`backend.ts`) | [`02-storage.md`](02-storage.md), [`13-migration.md`](13-migration.md) | Schema statements are inspection-verified |
| Embedding model/config changes (`embedder.ts`, gateway config) | [`reading-guide.md`](reading-guide.md) (μ₀/σ₀/qP, bands), [`02-storage.md`](02-storage.md), [`06-dreaming.md`](06-dreaming.md) | All thresholds are measured moments of the current encoder (ADR 005) |
| **Whitepaper or any `docs/research/*` changes** | **every page citing a pinned claim** (see [`appendix.md`](appendix.md) ledger) | Pins are by file+§heading; edits silently shift content |
| Judge model changes | [`03-gates.md`](03-gates.md), [`06-dreaming.md`](06-dreaming.md), [`appendix-formal.md`](appendix-formal.md) (Theorem 3 calibration) | Judge resolution is calibrated per model |
| New dreaming study / implementation lands | [`06-dreaming.md`](06-dreaming.md) status label, [`overview.md`](overview.md) spine, [`decisions.md`](decisions.md) ADR 007/008 status | Status discipline |
| Platform ships any element of Part III | the corresponding page's status label + spine | Status discipline |

## The mechanical checks

`pnpm run docs:check` (script: `scripts/docs-check.js`) verifies, parser-level:

1. **Mermaid syntax** of every fenced diagram (no browser; full visual
   rendering is an on-demand manual review).
2. **Links**: every relative link between book pages resolves to an existing
   file.
3. **Glossary coverage**: memory terms used on pages exist in
   [`reading-guide.md`](reading-guide.md) (term list is curated in the
   script; new terms are added there when added to the glossary).
4. **Repo paths**: every code-spanned path beginning with src or docs in the book
   resolves to an existing file or directory.
5. **Measured-claim pins**: every ledger row in [`appendix.md`](appendix.md)
   resolves to a §heading containing the quoted value.
6. **Status markers**: no page may describe researched/proposed behavior
   without a ◆/▸ or explicit status block.

A change that fails any check lands with the fix or an explicit
`docs/memory/` note amending the ledger.

## Verification stamp

The [README](README.md) carries the book-level stamp:

> **Book verified:** · date · docs-check green · human cover-to-cover read
> logged.

A page-level **Last verified** stamp lives in each page header. A page whose
stamp is older than any matching trigger above is stale by definition.

## What is NOT checked (manual)

- Mermaid *visual* coherence (render on demand).
- Readability acceptance (zero-background dev summarizes each page) — done at
  authoring and after major edits.
- Honesty of Part III boundaries (design remains design) — reviewed at any
  Part III edit.
