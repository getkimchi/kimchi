"""Unit tests for validate_task_selection — the pipeline-start selection gate.

A typo'd or source-qualified task name used to cost a full chunk attempt budget
of paid agent runs before anything reported a problem. This gate turns that
into an immediate failure in the prepare stage.
"""

from __future__ import annotations

import json

import pytest

import validate_task_selection


@pytest.fixture(autouse=True)
def _clear_selection_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("SELECTED_TASKS_JSON", "BENCH_TASKS_ALL", "DATASET"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DATASET", "terminal-bench/terminal-bench-2-1")


def test_valid_bare_selection_passes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SELECTED_TASKS_JSON", json.dumps(["fix-git", "extract-elf"]))
    assert validate_task_selection.main() == 0


def test_source_qualified_selection_passes_after_normalization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Qualified names are legal input; they are normalised, not rejected."""
    monkeypatch.setenv("SELECTED_TASKS_JSON", json.dumps(["terminal-bench/fix-git"]))
    assert validate_task_selection.main() == 0


def test_unknown_task_name_fails_fast(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("SELECTED_TASKS_JSON", json.dumps(["fix-gti"]))
    assert validate_task_selection.main() == 1
    assert "do not exist in the dataset" in capsys.readouterr().err


def test_qualified_unknown_task_name_fails_fast(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Stripping the prefix must not mask a genuinely wrong task name."""
    monkeypatch.setenv(
        "SELECTED_TASKS_JSON", json.dumps(["terminal-bench/not-a-real-task"])
    )
    assert validate_task_selection.main() == 1
    assert "not-a-real-task" in capsys.readouterr().err


def test_tasks_all_skips_the_check(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BENCH_TASKS_ALL", "true")
    monkeypatch.setenv("SELECTED_TASKS_JSON", json.dumps(["ignored-nonsense"]))
    assert validate_task_selection.main() == 0


def test_empty_selection_is_allowed(monkeypatch: pytest.MonkeyPatch) -> None:
    """An empty selection means the full dataset will run."""
    monkeypatch.setenv("SELECTED_TASKS_JSON", "[]")
    assert validate_task_selection.main() == 0


def test_malformed_json_fails(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("SELECTED_TASKS_JSON", "[not json")
    assert validate_task_selection.main() == 1
    assert "not valid JSON" in capsys.readouterr().err


def test_non_string_entries_fail(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("SELECTED_TASKS_JSON", json.dumps(["fix-git", 7]))
    assert validate_task_selection.main() == 1
    assert "array of strings" in capsys.readouterr().err


def test_unresolvable_dataset_skips_check_without_failing(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Validation must never be the thing that breaks a run."""
    monkeypatch.setenv("DATASET", "no-such-dataset")
    monkeypatch.setenv("SELECTED_TASKS_JSON", json.dumps(["fix-git"]))
    assert validate_task_selection.main() == 0
    assert "skipping membership check" in capsys.readouterr().err


def test_duplicate_aliases_are_reported_as_collapsed(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv(
        "SELECTED_TASKS_JSON", json.dumps(["terminal-bench/fix-git", "fix-git"])
    )
    assert validate_task_selection.main() == 0
    assert "1 duplicate(s) collapsed" in capsys.readouterr().out


# --- every dataset the gate runs for ---------------------------------------
#
# The gate is wired into setup-image in terminal-bench-2.yml, swe-bench-pro.yml
# and deep-swe.yml, each pinning its own DATASET. These cover the two
# non-terminal-bench datasets so a broken dataset mapping cannot silently make
# the gate a no-op.


def test_swe_bench_pro_accepts_a_real_instance_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATASET", "swebenchpro")
    instance = (
        "instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8"
        "-v30a923fb5c164d6cd18280c02422f75e611e8fb2"
    )
    monkeypatch.setenv("SELECTED_TASKS_JSON", json.dumps([instance]))
    assert validate_task_selection.main() == 0


def test_swe_bench_pro_rejects_an_unknown_instance_id(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`__` must not be mistaken for a strippable separator."""
    monkeypatch.setenv("DATASET", "swebenchpro")
    monkeypatch.setenv(
        "SELECTED_TASKS_JSON", json.dumps(["instance_nope__nope-deadbeef-vdeadbeef"])
    )
    assert validate_task_selection.main() == 1
    assert "do not exist in the dataset" in capsys.readouterr().err


def test_deep_swe_accepts_a_real_task(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATASET", "deep-swe")
    monkeypatch.setenv("SELECTED_TASKS_JSON", json.dumps(["abs-module-cache-flags"]))
    assert validate_task_selection.main() == 0


def test_deep_swe_rejects_an_unknown_task(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("DATASET", "deep-swe")
    monkeypatch.setenv("SELECTED_TASKS_JSON", json.dumps(["abs-module-cache-flag"]))
    assert validate_task_selection.main() == 1
    assert "do not exist in the dataset" in capsys.readouterr().err
