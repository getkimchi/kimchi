"""Regression tests for source-qualified task name handling.

A pipeline started with `tasks: ["terminal-bench/fix-git"]` instead of the bare
`fix-git` used to burn its entire chunk attempt budget re-running a task that
had already passed, then fail the summary job:

    [chunk-0] 1 tasks still need retry: ['terminal-bench/fix-git']
    ERROR: chunk-0 incomplete (attempt 3/8); pipeline retry will resume ...
    Trials:  recorded=  3 / expected=  1  (scored_pass=3 ...)

Harbor records `task_name` as "terminal-bench/fix-git" but names the trial
directory `fix-git__<suffix>`. Every trial-side reader stripped the `source/`
prefix; the selected/expected side did not, so a passing trial could not be
attributed to its own task.

These tests cover the normalisation helpers, the chunk-side attribution, and
the summary-side exit decision.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
from unittest import mock

import pytest

import summarize_results
from bench_config import (
    bare_task_name,
    normalize_selected_tasks,
    validate_selected_tasks,
)

# --- helpers ---------------------------------------------------------------


def test_bare_task_name_strips_harbor_source_prefix() -> None:
    assert bare_task_name("terminal-bench/fix-git") == "fix-git"


def test_bare_task_name_leaves_bare_names_untouched() -> None:
    assert bare_task_name("fix-git") == "fix-git"


def test_bare_task_name_leaves_swe_bench_pro_instance_ids_intact() -> None:
    """SWE-bench Pro separates components with `__`, never `/`."""
    instance = (
        "instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8"
        "-v30a923fb5c164d6cd18280c02422f75e611e8fb2"
    )
    assert bare_task_name(instance) == instance


def test_normalize_selected_tasks_preserves_order() -> None:
    assert normalize_selected_tasks(
        ["terminal-bench/extract-elf", "fix-git"]
    ) == ["extract-elf", "fix-git"]


def test_normalize_selected_tasks_collapses_names_that_alias_after_stripping() -> None:
    """Positional chunk slicing must never hand one task to two chunks."""
    assert normalize_selected_tasks(
        ["terminal-bench/fix-git", "fix-git"]
    ) == ["fix-git"]


def test_validate_selected_tasks_normalizes_qualified_names() -> None:
    assert validate_selected_tasks(
        ["terminal-bench/fix-git"], ["fix-git", "extract-elf"]
    ) == ["fix-git"]


def test_validate_selected_tasks_rejects_names_absent_from_dataset() -> None:
    """Fail at pipeline start, not after a full budget of paid retries."""
    with pytest.raises(ValueError, match="do not exist in the dataset"):
        validate_selected_tasks(["fix-gti"], ["fix-git", "extract-elf"])


def test_validate_selected_tasks_rejects_blank_names() -> None:
    with pytest.raises(ValueError, match="blank task name"):
        validate_selected_tasks(["fix-git", "  "], ["fix-git"])


def test_validate_selected_tasks_suggests_close_matches() -> None:
    """Make the common typo path self-healing at the pipeline-start gate."""
    with pytest.raises(ValueError, match="did you mean 'fix-git'"):
        validate_selected_tasks(["fix-gti"], ["fix-git", "extract-elf"])


def test_validate_selected_tasks_omits_suggestion_when_nothing_is_close() -> None:
    with pytest.raises(
        ValueError, match=r"do not exist in the dataset: \['zzz-unrelated'\]\.$"
    ):
        validate_selected_tasks(["zzz-unrelated"], ["fix-git", "extract-elf"])


def test_validate_selected_tasks_skips_membership_check_without_dataset() -> None:
    """An unresolvable dataset must not be the thing that breaks a run."""
    assert validate_selected_tasks(["terminal-bench/whatever"], []) == ["whatever"]


# --- chunk-side attribution ------------------------------------------------


def _write_passing_trial(results_dir: Path, *, trial_id: str, task_name: str) -> None:
    """Write a trial exactly as Harbor does: qualified task_name, bare dir."""
    trial_dir = results_dir / "chunk-0-159617586-r1" / trial_id
    trial_dir.mkdir(parents=True)
    (trial_dir / "result.json").write_text(
        json.dumps(
            {
                "trial_name": trial_id,
                "task_name": task_name,
                "outcome": "scored_pass",
                "verifier_result": {"rewards": {"reward": 1.0}},
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def test_passing_trial_is_attributed_after_normalizing_selection(
    tmp_results_dir: Path,
) -> None:
    """The chunk-side half of the bug: `1 tasks still need retry: [...]`.

    A trial Harbor recorded as "terminal-bench/fix-git" must be attributed to
    the task once the selection is normalised, so the chunk is complete and no
    retry is scheduled.
    """
    import chunk_runner
    from reconcile import compute_chunk_progress, missing_tasks

    _write_passing_trial(
        tmp_results_dir, trial_id="fix-git__xzqfTnf", task_name="terminal-bench/fix-git"
    )

    selected = validate_selected_tasks(["terminal-bench/fix-git"], ["fix-git"])
    (task,) = selected

    trial_dirs = chunk_runner._all_trial_dirs_for_task(tmp_results_dir, task)
    assert len(trial_dirs) == 1

    progress = compute_chunk_progress(
        task_to_trial_dirs={task: trial_dirs},
        target_trials=1,
        retry_budget_exhausted=False,
    )
    assert missing_tasks(progress) == []


def test_unnormalized_selection_would_lose_the_trial(tmp_results_dir: Path) -> None:
    """Pins the exact failure mode, so a regression is unambiguous."""
    import chunk_runner

    _write_passing_trial(
        tmp_results_dir, trial_id="fix-git__xzqfTnf", task_name="terminal-bench/fix-git"
    )
    assert (
        chunk_runner._all_trial_dirs_for_task(tmp_results_dir, "terminal-bench/fix-git")
        == []
    )


# --- summary-side exit decision --------------------------------------------


def _write_summary_fixture(tmp_path: Path, *, selected_task: str) -> tuple[Path, Path, Path]:
    """A run whose only task passed on all three chunk attempts.

    `selected_task` is written into run metadata verbatim: a run started with a
    source-qualified name keeps it for its whole lifetime (the metadata is
    frozen at run creation and restored from GCS by later jobs), which is why
    the summary must normalise on read.
    """
    results_dir = tmp_path / "jobs"
    for attempt in (1, 2, 3):
        trial_dir = results_dir / f"run-{attempt}" / f"fix-git__attempt{attempt}"
        (trial_dir / "agent" / "sessions").mkdir(parents=True)
        (trial_dir / "agent" / "sessions" / "s.jsonl").write_text("", encoding="utf-8")
        (trial_dir / "result.json").write_text(
            json.dumps(
                {
                    "trial_name": f"fix-git__attempt{attempt}",
                    "task_name": "terminal-bench/fix-git",
                    "outcome": "scored_pass",
                    "verifier_result": {"rewards": {"reward": 1.0}},
                    "agent_execution": {
                        "started_at": "2026-08-18T10:00:00Z",
                        "finished_at": "2026-08-18T10:20:00Z",
                    },
                    "verifier": {
                        "started_at": "2026-08-18T10:20:00Z",
                        "finished_at": "2026-08-18T10:21:00Z",
                    },
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    metadata_path = tmp_path / "run-metadata.json"
    metadata_path.write_text(
        json.dumps(
            {
                "benchmark": "terminal-bench-2-1",
                "coding_agent": "kimchi",
                "model": "kimchi-dev/kimi-k2.7",
                "selected_tasks": [selected_task],
                "results_dir": str(results_dir),
                "parameters": {"attempts": "1", "chunk_attempt_budget": 8},
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    attempts_path = tmp_path / "chunk-attempts.json"
    attempts_path.write_text(json.dumps({"0": 3}), encoding="utf-8")
    return metadata_path, results_dir, attempts_path


def _run_write_summary(tmp_path: Path, *, selected_task: str) -> tuple[int, str]:
    metadata_path, results_dir, attempts_path = _write_summary_fixture(
        tmp_path, selected_task=selected_task
    )
    env = {
        "BENCHMARK_CHUNK_ATTEMPTS_PATH": str(attempts_path),
        "BENCH_CHUNK_COUNT": "1",
    }
    err = io.StringIO()
    with (
        mock.patch.dict(os.environ, env),
        contextlib.redirect_stdout(io.StringIO()),
        contextlib.redirect_stderr(err),
    ):
        rc = summarize_results.write_summary(
            metadata_path,
            tmp_path / "summary.json",
            results_dir_override=results_dir,
        )
    return rc, err.getvalue()


def test_summary_succeeds_when_metadata_holds_qualified_task_names(
    tmp_path: Path,
) -> None:
    """The summary-side half of the bug.

    Before normalising on read, `final_trial_counts` was keyed by "fix-git"
    while expected ownership held "terminal-bench/fix-git", so the chunk was
    RECOVERABLE (ordinal 3 < budget 8) and the job exited 1 — feeding the
    retry loop even though every trial had passed.
    """
    rc, stderr = _run_write_summary(tmp_path, selected_task="terminal-bench/fix-git")
    assert rc == 0
    assert "incomplete" not in stderr


def test_summary_still_succeeds_for_bare_task_names(tmp_path: Path) -> None:
    """Normalisation must not change behaviour for already-bare selections."""
    rc, stderr = _run_write_summary(tmp_path, selected_task="fix-git")
    assert rc == 0
    assert "incomplete" not in stderr


def test_summary_counts_expected_tasks_once_for_qualified_names(
    tmp_path: Path,
) -> None:
    """tasks.expected is derived from the selection, so it must be normalised too."""
    metadata_path, results_dir, attempts_path = _write_summary_fixture(
        tmp_path, selected_task="terminal-bench/fix-git"
    )
    output_path = tmp_path / "summary.json"
    env = {
        "BENCHMARK_CHUNK_ATTEMPTS_PATH": str(attempts_path),
        "BENCH_CHUNK_COUNT": "1",
    }
    with (
        mock.patch.dict(os.environ, env),
        contextlib.redirect_stdout(io.StringIO()),
        contextlib.redirect_stderr(io.StringIO()),
    ):
        summarize_results.write_summary(
            metadata_path, output_path, results_dir_override=results_dir
        )

    summary = json.loads(output_path.read_text(encoding="utf-8"))
    assert summary["totals"]["tasks"]["expected"] == 1
    assert summary["totals"]["tasks"]["scored_pass"] == 1
    assert summary["totals"]["tasks"]["no_verdict"] == 0
    assert summary["chunk_recovery"]["chunk-0"]["disposition"] == "complete"
    assert summary["chunk_recovery"]["chunk-0"]["incomplete_tasks"] == []
