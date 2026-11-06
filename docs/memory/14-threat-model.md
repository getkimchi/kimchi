# Platform · Threat & privacy model

> **Status: PROPOSED design — defenses cite *measured* evidence; anything
> without a tested defense is labeled *open*.**

**Concepts you need:** [`11-shared-distillation.md`](11-shared-distillation.md)
rules, [tiers](reading-guide.md#glossary) · **Last verified:** 2026-11

---

## Goal

Name the ways a shared-memory platform can hurt people, pair each with the
defense we actually have (and its evidence), and admit the residual risk.

## Threat ↔ defense matrix

| # | Threat | Defense | Evidence | Status |
|---|---|---|---|---|
| T1 | **Private-trait juxtaposition** — two separately-harmless facts combine into a sensitive composite ("manager + schedule data → team member's slip pattern") | Privacy screen **before** synthesis + **per-atomic-claim** k-anonymity contain | Screen caught 1 toxic group; the near-miss slipped the screen and was **contained to PERSONAL by claim-level support** (§5.12) | **layered, measured** |
| T2 | **Cross-user misattribution** — a SHARED claim that only one person actually holds | Per-claim support ≥2 users at τ_sup | Claim battery: the 1 unsupported claim across 46 was a decomposition artifact and DROP'd (§5.12) | **measured** |
| T3 | **Synthesis hallucination at scale** | Geometric gates + independent judge + tiers | 840 candidates, 0 unsupported; judge FAR 0/24 (§5.9–§5.13) | **measured** |
| T4 | **Per-item PII at retain** — a single fact that is itself sensitive (token, address) | *none yet*: pattern-scan at retain (Hindsight-style regex layer) is named, not designed | — | **open** |
| T5 | **Org-boundary breach** — any query escaping its org scope | Hard org attribution on every call + policy modules (existing) | Existing gateway enforcement; platform adds no new primitive (§3.1) | **existing + proposed tests** |
| T6 | **Plausible-tier over-trust** — plausible inferences silently treated as verified | Tiers + entailed-only crossing default; labeled display | Cost of *admitting* plausibles to retrieval: +1.7 pts adversarial false-answer (§5.13) | **measured tradeoff, policy-set** |
| T7 | **Abstention decay** — users stop questioning memory output over time | No-injection-normal design + provenance display + weekly-review digest for the plausible tier | no-injection behavior measured (E3/E8 null case) | **process-level** |

## The honest residuals

- The privacy screen **has a measured miss rate ≠ 0** (one near-miss slip on
  record). The claim-level audit caught *that* instance; this is a
  two-layer design by necessity, not elegance. A third layer (retention
  window for PERSONAL metadata) is *open*.
- **T4 is real and unsolved** at platform scope: pattern-scan helps regex-
  shaped secrets, not conceptual sensitivity. Until designed, the platform
  default is developer-tooling memories only — no free-form personal notes
  cross scopes ever (and `personal`-scope locals never migrate raw;
  [`13-migration.md`](13-migration.md) maps them to individual scope).
- Counts-not-names provenance blocks *incidental* re-identification but not
  a determined org-admin adversary; the audit log is the check there
  (*proposed*), not crypto.

## Incident hooks (proposed)

Org audit log per memory (retain/recall/distill events); tier rollback
(demote verified → quarantined on challenge); user-visible "why does the
system think this" panel — every SHARED memory renders as "N users",
clickable to its claims.

## Code pointers

Defense machinery that exists: gates/judge (`decision-gate.ts`), supersede
conservatism (`supersede.ts`), org attribution (`gateway-credentials.ts`,
`org-policy.ts`). Everything else here is proposed.

## Open items

- T4 per-item PII design.
- Retention/compliance for PERSONAL metadata (GDPR-shaped questions).
- Screen-miss monitoring: lo-co offline replay on the calibration suite in CI.
