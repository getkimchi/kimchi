"""Unit tests for the authoritative per-chunk recovery states (1c)."""

from __future__ import annotations

import pytest

from chunk_recovery import (
    ChunkRecoveryCorruptError,
    ChunkRecoveryDisposition,
    derive_chunk_recovery_states,
)

_OWNERSHIP = {0: ["task-a", "task-b"], 1: ["task-c"]}
_BUDGET = 8
_K = 1


def _derive(**overrides):
    args = {
        "expected_tasks_by_chunk": _OWNERSHIP,
        "final_trial_counts": {},
        "chunk_statuses": {},
        "durable_ordinals": {},
        "target_k": _K,
        "attempt_budget": _BUDGET,
    }
    args.update(overrides)
    return derive_chunk_recovery_states(**args)


def test_complete_chunk_ignores_stale_status() -> None:
    """Every assigned task at k final trials is complete regardless of records."""
    states = _derive(
        final_trial_counts={"task-a": 1, "task-b": 2, "task-c": 1},
        chunk_statuses={0: {"chunk_attempt": 9, "exhausted": False, "needs_retry": ["task-a"]}},
        durable_ordinals={0: 9, 1: 3},
    )
    assert states[0].disposition == ChunkRecoveryDisposition.COMPLETE
    assert states[1].disposition == ChunkRecoveryDisposition.COMPLETE


def test_status_newer_than_durable_ordinal_is_corrupt() -> None:
    with pytest.raises(ChunkRecoveryCorruptError, match="newer than"):
        _derive(
            chunk_statuses={0: {"chunk_attempt": 5, "exhausted": False, "needs_retry": []}},
            durable_ordinals={0: 4},
        )


def test_corruption_wins_over_completion() -> None:
    """Identity corruption is checked before the completion shortcut: even a
    chunk whose tasks all recovered still fails when its status attempt is
    newer than the durable ordinal (impossible durable state is never
    papered over)."""
    with pytest.raises(ChunkRecoveryCorruptError, match="newer than"):
        _derive(
            final_trial_counts={"task-a": 1, "task-b": 1},
            chunk_statuses={0: {"chunk_attempt": 5, "exhausted": False, "needs_retry": []}},
            durable_ordinals={0: 4},
        )


def test_at_budget_with_current_exhausted_status_is_reported() -> None:
    states = _derive(
        chunk_statuses={0: {"chunk_attempt": 8, "exhausted": True, "needs_retry": ["task-a"]}},
        durable_ordinals={0: 8},
    )
    assert states[0].disposition == ChunkRecoveryDisposition.EXHAUSTED_REPORTED
    assert states[0].incomplete_tasks == ("task-a", "task-b")


def test_above_budget_without_status_is_exhausted_inferred() -> None:
    """The final attempt died before publishing a terminal status: the durable
    ordinal alone makes incomplete work terminally exhausted."""
    states = _derive(durable_ordinals={0: 9})
    assert states[0].disposition == ChunkRecoveryDisposition.EXHAUSTED_INFERRED
    assert states[0].exhausted is True


def test_above_budget_with_stale_nonexhausted_status_is_inferred() -> None:
    states = _derive(
        chunk_statuses={0: {"chunk_attempt": 7, "exhausted": False, "needs_retry": ["task-a"]}},
        durable_ordinals={0: 8},
    )
    assert states[0].disposition == ChunkRecoveryDisposition.EXHAUSTED_INFERRED


def test_below_budget_missing_status_is_recoverable_and_diagnostic_is_annotated() -> None:
    states = _derive(durable_ordinals={1: 3}, final_trial_counts={"task-a": 1, "task-b": 1})
    state = states[1]
    assert state.disposition == ChunkRecoveryDisposition.RECOVERABLE
    assert state.incomplete_tasks == ("task-c",)
    assert state.diagnostic() == (
        "chunk-1 incomplete (attempt 3/8); "
        "pipeline retry will resume from durable checkpoints"
    )


def test_below_budget_current_exhausted_status_is_inconsistent_strict() -> None:
    """Under the frozen-budget schema, exhaustion below the budget fails loudly."""
    with pytest.raises(ChunkRecoveryCorruptError, match="below the budget"):
        _derive(
            chunk_statuses={0: {"chunk_attempt": 3, "exhausted": True, "needs_retry": ["task-a"]}},
            durable_ordinals={0: 3},
        )


def test_below_budget_exhausted_status_is_honored_in_legacy_mode() -> None:
    states = _derive(
        chunk_statuses={0: {"chunk_attempt": 3, "exhausted": True, "needs_retry": ["task-a"]}},
        durable_ordinals={0: 3},
        legacy=True,
    )
    assert states[0].disposition == ChunkRecoveryDisposition.EXHAUSTED_REPORTED


def test_no_ordinal_never_infers_exhaustion_but_honors_reported() -> None:
    """No durable ordinal: reported exhaustion stays authoritative (legacy/
    non-checkpointed); otherwise incomplete work is recoverable."""
    states = _derive()
    assert states[0].disposition == ChunkRecoveryDisposition.RECOVERABLE
    assert states[1].disposition == ChunkRecoveryDisposition.RECOVERABLE

    states = _derive(
        chunk_statuses={0: {"exhausted": True, "needs_retry": ["task-b"]}},
    )
    assert states[0].disposition == ChunkRecoveryDisposition.EXHAUSTED_REPORTED
    assert states[0].durable_ordinal is None


def test_status_tasks_outside_chunk_ownership_fail() -> None:
    with pytest.raises(ChunkRecoveryCorruptError, match="outside its expected ownership"):
        _derive(
            chunk_statuses={0: {"chunk_attempt": 8, "exhausted": True, "needs_retry": ["task-c"]}},
            durable_ordinals={0: 8},
        )


def test_exhaustion_exempts_only_the_owning_chunks_tasks() -> None:
    """An exhausted chunk's exemption set is exactly its own incomplete
    assignments — it can never globally exempt another chunk's missing tasks."""
    states = _derive(
        chunk_statuses={0: {"chunk_attempt": 8, "exhausted": True, "needs_retry": ["task-a"]}},
        durable_ordinals={0: 8, 1: 2},
    )
    assert states[0].exhausted is True
    assert set(states[0].incomplete_tasks) == {"task-a", "task-b"}
    assert states[1].disposition == ChunkRecoveryDisposition.RECOVERABLE
    assert states[1].incomplete_tasks == ("task-c",)


def test_incomplete_tasks_respect_target_k() -> None:
    states = _derive(
        final_trial_counts={"task-a": 2, "task-b": 1, "task-c": 0},
        target_k=2,
    )
    assert states[0].incomplete_tasks == ("task-b",)
    assert states[1].incomplete_tasks == ("task-c",)


def test_recoverable_without_ordinal_does_not_promise_durable_checkpoints() -> None:
    """Non-checkpointed (artifact-only) recovery must not claim a retry
    resumes from durable checkpoints that do not exist."""
    states = _derive()
    assert states[0].recoverable is True
    assert states[0].diagnostic() == (
        "chunk-0 incomplete (no durable attempt ordinal recorded); "
        "checkpointing is disabled for this run — a pipeline retry "
        "resumes only from restored run artifacts"
    )
