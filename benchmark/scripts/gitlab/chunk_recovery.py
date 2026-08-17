"""Derive one authoritative recovery state per chunk for summary generation.

Both summary JSON generation and final exit validation consume the returned
states; nothing downstream re-interprets ``chunk-meta`` independently.

State precedence per chunk (see plan 1c):

1. A chunk whose assigned tasks all have ``k`` final (non-retryable) trials is
   ``complete`` regardless of attempt/status records.
2. When a durable attempt ordinal exists, a status whose attempt is greater
   than the ordinal is corrupt/inconsistent — hard failure.
3. With incomplete tasks and a durable ordinal at or above the attempt budget,
   the chunk is exhausted: ``exhausted_reported`` when a current (ordinal-
   matching) status reports exhaustion, otherwise ``exhausted_inferred``
   (missing, stale, or current non-exhausted status — the final attempt died
   or failed before publishing a terminal status).
4. With an ordinal below the budget, a missing/stale/non-exhausted status
   means the chunk is ``recoverable``: its latest attempt died before
   publishing a terminal status and a pipeline retry resumes it. A current
   status already reporting exhaustion below budget is inconsistent under the
   new schema and fails; legacy artifacts still honor an exhausted status.
5. With no durable ordinal, exhaustion is never inferred: a current
   runner-reported exhausted status remains authoritative
   (non-checkpointed/legacy recovery); otherwise the chunk is recoverable.

Ownership is strict: task names carried by a runner status must belong to
that chunk's expected ownership (positional slicing in PR 1; the canonical
assignment in PR 3). A mismatch is identity corruption, not a soft warning.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class ChunkRecoveryDisposition(StrEnum):
    """Closed set of recovery outcomes written to summary JSON."""

    COMPLETE = "complete"
    RECOVERABLE = "recoverable"
    EXHAUSTED_REPORTED = "exhausted_reported"
    EXHAUSTED_INFERRED = "exhausted_inferred"


EXHAUSTED_DISPOSITIONS = frozenset(
    {
        ChunkRecoveryDisposition.EXHAUSTED_REPORTED,
        ChunkRecoveryDisposition.EXHAUSTED_INFERRED,
    }
)


class ChunkRecoveryCorruptError(RuntimeError):
    """Run-identity corruption or status/ordinal inconsistency in recovery data."""


@dataclass(frozen=True)
class ChunkRecoveryState:
    """Authoritative recovery state for one chunk."""

    chunk_index: int
    incomplete_tasks: tuple[str, ...]
    disposition: ChunkRecoveryDisposition
    attempt_budget: int
    durable_ordinal: int | None = None
    status_attempt: int | None = None

    @property
    def complete(self) -> bool:
        return self.disposition == ChunkRecoveryDisposition.COMPLETE

    @property
    def exhausted(self) -> bool:
        return self.disposition in EXHAUSTED_DISPOSITIONS

    @property
    def recoverable(self) -> bool:
        return self.disposition == ChunkRecoveryDisposition.RECOVERABLE

    @property
    def exhausted_reported(self) -> bool:
        return self.disposition == ChunkRecoveryDisposition.EXHAUSTED_REPORTED

    def diagnostic(self) -> str:
        """Human-readable one-liner for summary diagnostics/log errors."""
        name = f"chunk-{self.chunk_index}"
        ordinal = self.durable_ordinal if self.durable_ordinal else "none"
        if self.complete:
            return f"{name} complete"
        if self.recoverable:
            if self.durable_ordinal:
                return (
                    f"{name} incomplete (attempt {ordinal}/{self.attempt_budget}); "
                    "pipeline retry will resume from durable checkpoints"
                )
            # Non-checkpointed (or legacy artifact-only) recovery: there is
            # no durable state to resume from, so say what a retry actually
            # restores instead of promising checkpoints that do not exist.
            return (
                f"{name} incomplete (no durable attempt ordinal recorded); "
                "checkpointing is disabled for this run — a pipeline retry "
                "resumes only from restored run artifacts"
            )
        missing = ", ".join(self.incomplete_tasks)
        source = "reported" if self.exhausted_reported else "inferred"
        return (
            f"{name} exhausted ({source}, attempt {ordinal}/{self.attempt_budget}); "
            f"incomplete tasks exempted: [{missing}]"
        )


def _status_attempt(status: dict[str, Any]) -> int | None:
    attempt = status.get("chunk_attempt")
    return attempt if isinstance(attempt, int) and attempt >= 1 else None


def _status_needs_retry(status: dict[str, Any]) -> tuple[str, ...]:
    needs = status.get("needs_retry")
    if not isinstance(needs, list):
        return ()
    return tuple(task for task in needs if isinstance(task, str))


def _status_exhausted(status: dict[str, Any]) -> bool:
    return status.get("exhausted") is True


def derive_chunk_recovery_states(
    *,
    expected_tasks_by_chunk: dict[int, list[str]],
    final_trial_counts: dict[str, int],
    chunk_statuses: dict[int, dict[str, Any]],
    durable_ordinals: dict[int, int],
    target_k: int,
    attempt_budget: int,
    legacy: bool = False,
) -> dict[int, ChunkRecoveryState]:
    """Compute one recovery state per chunk.

    Args:
        expected_tasks_by_chunk: expected per-chunk task ownership (positional
            slicing in PR 1; canonical assignment in PR 3).
        final_trial_counts: ``{bare_task: number of non-retryable trials}``
            recovered for the whole run.
        chunk_statuses: durable/restored ``chunk-meta`` payloads keyed by chunk
            index (may be empty or partial).
        durable_ordinals: ``{chunk_index: durable attempt ordinal}`` from
            immutable attempt markers; 0/absent means no recorded ordinal.
        target_k: the pass@k target (``BENCH_ATTEMPTS``).
        attempt_budget: the frozen durable attempt budget.
        legacy: True for pipeline artifacts created before the frozen-budget
            schema. Legacy statuses honor an exhausted flag anywhere and skip
            the below-budget exhausted-status invariant.

    Raises:
        ChunkRecoveryCorruptError: on ownership mismatch, a status attempt
            newer than the durable ordinal, or (strict schema) an exhausted
            status below the budget.
    """
    if attempt_budget < 1:
        raise ValueError("attempt_budget must be a positive integer")
    if target_k < 1:
        raise ValueError("target_k must be a positive integer")

    states: dict[int, ChunkRecoveryState] = {}
    for chunk_index in sorted(expected_tasks_by_chunk):
        assigned = list(expected_tasks_by_chunk[chunk_index])
        assigned_set = set(assigned)
        status = chunk_statuses.get(chunk_index)
        status_attempt = _status_attempt(status) if status else None
        needs_retry = _status_needs_retry(status) if status else ()
        raw_ordinal = durable_ordinals.get(chunk_index, 0)
        ordinal = raw_ordinal if raw_ordinal >= 1 else None

        unknown_tasks = sorted(set(needs_retry) - assigned_set)
        if unknown_tasks:
            raise ChunkRecoveryCorruptError(
                f"chunk-{chunk_index} status carries tasks outside its expected "
                f"ownership: {unknown_tasks} (assigned: {sorted(assigned_set)})"
            )

        if (
            ordinal is not None
            and status_attempt is not None
            and status_attempt > ordinal
        ):
            raise ChunkRecoveryCorruptError(
                f"chunk-{chunk_index} status attempt {status_attempt} is newer "
                f"than its durable attempt ordinal {ordinal}"
            )

        incomplete = tuple(
            task
            for task in sorted(assigned_set)
            if final_trial_counts.get(task, 0) < target_k
        )

        # Precedence rule 1: completion wins over every record.
        if not incomplete:
            states[chunk_index] = ChunkRecoveryState(
                chunk_index=chunk_index,
                incomplete_tasks=(),
                disposition=ChunkRecoveryDisposition.COMPLETE,
                attempt_budget=attempt_budget,
                durable_ordinal=ordinal,
                status_attempt=status_attempt,
            )
            continue

        reported_exhausted = bool(status) and _status_exhausted(status)
        current_report = (
            reported_exhausted
            and status_attempt is not None
            and ordinal is not None
            and status_attempt == ordinal
        )

        if ordinal is not None and ordinal >= attempt_budget:
            # Rules 3: incomplete work at/above budget is terminal regardless
            # of whether the final attempt published its status.
            disposition = (
                ChunkRecoveryDisposition.EXHAUSTED_REPORTED
                if current_report or (reported_exhausted and legacy)
                else ChunkRecoveryDisposition.EXHAUSTED_INFERRED
            )
        elif reported_exhausted and (status_attempt == ordinal or ordinal is None):
            # Rule 4/5: an exhausted status is consistent only at/above the
            # budget under the new schema; without an ordinal it is the
            # runner's authoritative terminal report (legacy/non-checkpointed).
            if ordinal is not None and not legacy:
                raise ChunkRecoveryCorruptError(
                    f"chunk-{chunk_index} reports exhaustion at attempt "
                    f"{status_attempt} below the budget {attempt_budget}"
                )
            disposition = ChunkRecoveryDisposition.EXHAUSTED_REPORTED
        elif reported_exhausted and legacy:
            disposition = ChunkRecoveryDisposition.EXHAUSTED_REPORTED
        else:
            # Rule 4: ordinal below the budget (or none) with no consistent
            # exhaustion report → the last attempt died mid-flight.
            disposition = ChunkRecoveryDisposition.RECOVERABLE

        states[chunk_index] = ChunkRecoveryState(
            chunk_index=chunk_index,
            incomplete_tasks=incomplete,
            disposition=disposition,
            attempt_budget=attempt_budget,
            durable_ordinal=ordinal,
            status_attempt=status_attempt,
        )
    return states


__all__ = [
    "ChunkRecoveryCorruptError",
    "ChunkRecoveryDisposition",
    "ChunkRecoveryState",
    "derive_chunk_recovery_states",
]
