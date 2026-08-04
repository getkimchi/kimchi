"""Attempt-aware task reconciliation for benchmark chunk scheduling.

Replaces the old boolean "does this task need retry?" decision with explicit
per-task progress, so a retry schedules exactly the missing trial attempts
(Phase 5 of the checkpointing design).

## Progress model

Each task has ``target_trials`` (= ``BENCH_ATTEMPTS``, the pass@k ``k``) slots
to fill with *durable final* trials:

- A ``SCORED_PASS`` or ``SCORED_FAIL`` trial is **final** → fills a slot.
- A retryable infrastructure trial is **not final** → does not fill a slot,
  *unless* its retry budget is exhausted (we are on the final chunk attempt
  and cannot retry the chunk again), in which case it fills a slot and we
  stop spending tokens on it.
- Duplicate trial objects (same trial id from overlapping GCS + GitLab
  restoration) never increase the count.

``missing_trials`` is the number of additional final trials to schedule. It is
never negative and never exceeds ``target_trials``.

## Scheduling: k=1 rounds

Because Harbor's ``-k`` is global (every task gets the same attempt count),
missing work runs in ``k=1`` rounds: each round gives every task with
``missing_trials > 0`` exactly one attempt. This keeps attempt accounting
exact when different tasks have different numbers of durable trials.
"""

from __future__ import annotations

from dataclasses import dataclass

from bench_config import is_retryable
from classify import Verdict, classify
from outcome import Outcome


@dataclass(frozen=True)
class TaskProgress:
    """Durable progress for one task toward its pass@k target."""

    task: str
    target_trials: int
    durable_final_trials: int
    retryable_trials: int
    exhausted_retryable_trials: int

    @property
    def missing_trials(self) -> int:
        """Additional final trials to schedule (never negative)."""
        filled = self.durable_final_trials + self.exhausted_retryable_trials
        return max(0, self.target_trials - filled)

    @property
    def complete(self) -> bool:
        """True when no more trials are needed for this task."""
        return self.missing_trials == 0


def _is_final(verdict: Verdict) -> bool:
    """A final trial fills a pass@k slot (scored pass or scored fail)."""
    return verdict.outcome in (Outcome.SCORED_PASS, Outcome.SCORED_FAIL)


def compute_task_progress(
    *,
    task: str,
    trial_dirs: list,
    target_trials: int,
    retry_budget_exhausted: bool,
) -> TaskProgress:
    """Compute durable progress for one task from its local trial directories.

    Args:
        task: bare task name.
        trial_dirs: all trial directories for this task (already deduplicated
            by the caller via trial-id — see ``_all_trial_dirs_for_task``).
        target_trials: the configured ``k`` (``BENCH_ATTEMPTS``).
        retry_budget_exhausted: True when this is the final chunk attempt and
            GitLab will not retry the chunk again. When True, retryable
            infrastructure trials are treated as exhausted (they fill slots
            so the task can be considered complete with fewer than k final
            trials).

    Classifies each trial via ``classify.classify``. Trial directories without
    a readable ``result.json`` are treated as infra/missing (retryable).
    """
    durable_final = 0
    retryable = 0

    for trial_dir in trial_dirs:
        verdict = classify(trial_dir)
        if _is_final(verdict):
            durable_final += 1
        elif is_retryable(
            verdict.outcome,
            verdict.error_category,
            verdict.error_subcategory,
        ):
            retryable += 1
        # Non-retryable errors (agent/quality) are terminal and fill a slot:
        # they represent real benchmark evidence, not missing data.
        else:
            durable_final += 1

    exhausted = retryable if retry_budget_exhausted else 0
    # Clamp: exhausted can never push the filled count above target.
    filled_without_exhausted = durable_final
    if filled_without_exhausted >= target_trials:
        exhausted = 0
        durable_final = target_trials

    return TaskProgress(
        task=task,
        target_trials=target_trials,
        durable_final_trials=durable_final,
        retryable_trials=retryable,
        exhausted_retryable_trials=exhausted,
    )


def compute_chunk_progress(
    *,
    task_to_trial_dirs: dict,
    target_trials: int,
    retry_budget_exhausted: bool,
) -> list[TaskProgress]:
    """Compute progress for every task in a chunk.

    Args:
        task_to_trial_dirs: ``{bare_task_name: [trial_dir, ...]}``.
        target_trials: the configured ``k``.
        retry_budget_exhausted: whether the chunk retry budget is exhausted.
    """
    return [
        compute_task_progress(
            task=task,
            trial_dirs=trial_dirs,
            target_trials=target_trials,
            retry_budget_exhausted=retry_budget_exhausted,
        )
        for task, trial_dirs in sorted(task_to_trial_dirs.items())
    ]


def missing_tasks(progress: list[TaskProgress]) -> list[str]:
    """Bare task names that still need at least one more trial."""
    return [p.task for p in progress if not p.complete]


def is_chunk_complete(progress: list[TaskProgress]) -> bool:
    """True when every task has zero missing trials."""
    return all(p.complete for p in progress)


__all__ = [
    "TaskProgress",
    "compute_chunk_progress",
    "compute_task_progress",
    "is_chunk_complete",
    "missing_tasks",
]
