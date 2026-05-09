# Ferment Storage Schema

**Date:** 2026-05-08  
**Status:** Proposed / In Implementation  
**Scope:** Replaces the overwrite-heavy `FermentStorage` concrete class with an append-only event log + derived snapshot model.

## Goals

1. **Full audit trail** — every mutation is an append, never an overwrite-in-place.
2. **Immutability for snapshots** — phase/step state at any point in time is computable from the log.
3. **First-class metrics** — stats are derived views over the event log, not ad-hoc string formatting.
4. **Backward compatibility** — legacy ferment JSON files migrate on read and fold into the event model.

## Event Log (Append-Only)

Each ferment maintains an ordered event log. File: `<id>.events.jsonl` parallel to the legacy `<id>.json`.

### Event Types

```typescript
type FermentEvent =
  | { type: "ferment_created"; payload: { id; name; description; createdAt } }
  | { type: "ferment_scoped"; payload: { goal; criteria; constraints; phases; scopedAt } }
  | { type: "ferment_mode_set"; payload: { mode; setAt } }
  | { type: "phase_activated"; payload: { phaseId; startedAt; groupIndex? } }
  | { type: "phase_completed"; payload: { phaseId; summary; grade?; completedAt } }
  | { type: "phase_skipped"; payload: { phaseId; reason?; completedAt } }
  | { type: "phase_failed"; payload: { phaseId; reason; completedAt } }
  | { type: "phase_refined"; payload: { phaseId; steps; refinedAt } }
  | { type: "step_started"; payload: { phaseId; stepId; workerModel; parallelSiblings; startedAt } }
  | { type: "step_completed"; payload: { phaseId; stepId; completedAt } }
  | { type: "step_skipped"; payload: { phaseId; stepId; reason?; completedAt } }
  | { type: "step_failed"; payload: { phaseId; stepId; error?; completedAt } }
  | { type: "step_verified"; payload: { phaseId; stepId; result; verifiedAt } }
  | { type: "step_graded"; payload: { phaseId; stepId; grade; gradedAt } }
  | { type: "phase_graded"; payload: { phaseId; grade; gradedAt } }
  | { type: "ferment_graded"; payload: { grade; gradedAt } }
  | { type: "decision_added"; payload: { title; description; phaseId?; stepId?; createdAt } }
  | { type: "memory_added"; payload: { category; content; phaseId?; stepId?; createdAt } }
  | { type: "worktree_updated"; payload: { branch; isDirty; relativePath; updatedAt } }
  | { type: "ferment_abandoned"; payload: { reason?; abandonedAt } }
```

### Persisted Event Fields

- `id` — unique event UUID
- `timestamp` — wall-clock time of emission
- `type` — event type discriminator
- `payload` — type-specific data
- `preStateHash` — hash of ferment state BEFORE this event (chaining)
- `postStateHash` — hash of ferment state AFTER applying this event (chaining)

The `preStateHash`/`postStateHash` pair makes tampering detectable and allows Merkle-tree-style verification.

## Snapshot (Derived)

The canonical `Ferment` object is a **fold** over the event log. Whenever a tool or UI asks for state, we fold latest log entries into the snapshot.

- **Cold read**: fold entire log from events.
- **Warm read**: read cached snapshot + apply only new events since snapshot write.
- **Write**: append event to log, update snapshot atomically (temp file + rename).

The legacy `<id>.json` file becomes the **snapshot cache**. The events file is the source of truth. On migration, a legacy `<id>.json` is read, converted to an equivalent event log, and both are written.

## Phase Snapshots (Immutable)

Every time a phase transitions to `completed`, `skipped`, or `failed`, the phase data is captured into a **phase snapshot** record in a companion file `<id>.phase-snapshots.json`.

```typescript
interface PhaseSnapshot {
  phaseId: string;
  version: number;         // monotonic per phase
  state: Phase;            // deep-frozen copy
  capturedAt: string;      // ISO timestamp
  eventId: string;         // reference to the terminal event
}
```

These snapshots are append-only and immutable. They serve:
- Historical trend analysis
- Grade-over-time comparison
- Replay of exact state for debugging

## Step Audit Trail

Every step lifecycle event is also captured as a `StepAuditRecord` in the event log's `step_audit` trail. See `FermentEvent["step_started"]` etc. above. A dedicated derived view aggregates all step events per phase into:

```typescript
interface StepAuditView {
  phaseId: string;
  stepId: string;
  events: Array<{
    type: "started" | "completed" | "skipped" | "failed" | "verified" | "graded";
    at: string;
    workerModel?: string;
    grade?: Grade;
    result?: Verification;
  }>;
}
```

## Computed Stats Views

Stats are **not stored as individual scalar fields**. They are computed from the snapshot + event log on demand and optionally cached.

### FermentStats

```typescript
interface FermentStats {
  fermentId: string;
  phases: {
    total: number;
    completed: number;
    skipped: number;
    failed: number;
    active: number;
    planned: number;
    averageGrade?: number;        // numeric conversion of letter grade
  };
  steps: {
    total: number;
    done: number;
    skipped: number;
    failed: number;
    running: number;
    planned: number;
    averageStepGrade?: number;
  };
  timing: {
    totalDurationMs: number;      // createdAt → now or completedAt
    phaseDurationsMs: Record<string, number>;
    stepDurationsMs: Record<string, number>;
    averageStepDurationMs?: number;
    p50StepDurationMs?: number;
    p90StepDurationMs?: number;
  };
  grading: {
    overallGrade?: Grade;
    phaseGrades: Array<{ phaseId: string; grade: Grade }>;
    stepGrades: Array<{ phaseId: string; stepId: string; grade: Grade }>;
  };
  workers: {
    modelsUsed: Array<{ model: string; count: number }>;
    totalParallelSteps: number;
  };
  decisions: { total: number; byPhase: Record<string, number> };
  memories: { total: number; byCategory: Record<string, number> };
}
```

### Stats Caching

- `statsCache` is stored in `<id>.stats.json` alongside the snapshot.
- Cache key = `hash(eventsCount, lastEventTimestamp)`.
- If the cache key matches current log length, serve cached stats.
- Otherwise recompute and write new cache.

## Transition Plan

### Phase A — Dual Write

1. All new events are written to the event log.
2. The legacy snapshot (`<id>.json`) is also written (dual-write) for backward compatibility.
3. The `FermentStorage` class gains no public API changes — events are emitted internally.

### Phase B — Read from Log

1. On `get(id)`, check for event log.
2. If events exist, fold them to reconstruct the snapshot. Write updated snapshot if stale.
3. If no events exist but legacy JSON exists, migrate: parse JSON, generate synthetic events, write both.

### Phase C — Remove Legacy-Only Paths

1. After N days (or after all active ferments have dual write), remove the migration path.
2. Keep the legacy JSON as snapshot cache (fast read), but event log is the source of truth.

## File Layout

```
~/.config/kimchi/ferments/
  <uuid>.json           ← snapshot cache (legacy format, still present)
  <uuid>.events.jsonl   ← append-only event log (NEW)
  <uuid>.phases.json    ← phase snapshots (NEW)
  <uuid>.stats.json     ← computed stats cache (NEW)
```

## Migration from Legacy Snapshot

A `migrateLegacy(legacySnapshot): FermentEvent[]` function generates the minimal event sequence that would recreate the legacy snapshot. It walks the phases and steps in order and emits the appropriate events. This ensures that every historical ferment has a complete event retroactively.