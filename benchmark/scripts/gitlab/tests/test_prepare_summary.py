"""Tests for checkpoint hydration before benchmark summarization."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import checkpoint as ckpt
import prepare_summary


def test_prepare_uses_runner_delivered_artifacts_when_checkpoints_disabled(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("BENCHMARK_NAME", "terminal-bench-2")
    monkeypatch.setenv(
        "BENCHMARK_RESULTS_DIR",
        "benchmark/terminal-bench-2/jobs",
    )
    monkeypatch.setenv("BENCH_CHUNK_COUNT", "2")
    monkeypatch.setenv("BENCH_TRIAL_CHECKPOINTS", "false")
    meta_dir = (
        tmp_path / "benchmark/terminal-bench-2/jobs/chunk-meta"
    )
    meta_dir.mkdir(parents=True)
    for chunk_index in range(2):
        (meta_dir / f"chunk-{chunk_index}.json").write_text(
            json.dumps({"chunk_index": chunk_index})
        )

    with patch(
        "urllib.request.urlopen",
        side_effect=AssertionError("disabled path must not call the GitLab API"),
    ):
        assert prepare_summary.main() == 0


def test_prepare_fails_when_runner_artifacts_are_incomplete_and_checkpoints_disabled(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("BENCHMARK_NAME", "terminal-bench-2")
    monkeypatch.setenv(
        "BENCHMARK_RESULTS_DIR",
        "benchmark/terminal-bench-2/jobs",
    )
    monkeypatch.setenv("BENCH_CHUNK_COUNT", "3")
    monkeypatch.setenv("BENCH_TRIAL_CHECKPOINTS", "false")
    meta_dir = (
        tmp_path / "benchmark/terminal-bench-2/jobs/chunk-meta"
    )
    meta_dir.mkdir(parents=True)
    (meta_dir / "chunk-0.json").write_text('{"chunk_index": 0}')

    with patch(
        "urllib.request.urlopen",
        side_effect=AssertionError("disabled path must not call the GitLab API"),
    ):
        assert prepare_summary.main() == 1


def test_prepare_recovers_metadata_then_hydrates_trials(
    tmp_path: Path, monkeypatch
) -> None:
    metadata_path = tmp_path / ".benchmark" / "run-metadata.json"
    results_dir = tmp_path / "jobs"
    metadata = {
        "results_dir": str(results_dir),
        "gcs": {
            "prefix": "runs/benchmark=tb2/run=gitlab-p100",
            "checkpoint_prefix": (
                "runs/benchmark=tb2/run=gitlab-p100/checkpoint-project=7"
            ),
        },
        "gitlab": {"project_id": "7", "pipeline_id": "100"},
    }
    monkeypatch.setenv("BENCH_TRIAL_CHECKPOINTS", "true")
    monkeypatch.setenv("BENCH_CHECKPOINT_BUCKET", "ckpt-bucket")
    monkeypatch.setenv("BENCHMARK_RUN_METADATA", str(metadata_path))
    monkeypatch.setenv("CI_PROJECT_ID", "7")
    monkeypatch.setenv("CI_PIPELINE_ID", "100")
    monkeypatch.setenv("BENCH_CHUNK_COUNT", "3")
    attempts_path = tmp_path / ".benchmark" / "chunk-attempts.json"
    monkeypatch.setenv("BENCHMARK_CHUNK_ATTEMPTS_PATH", str(attempts_path))

    with patch(
        "prepare_summary.ckpt.gcs_download_object",
        return_value=json.dumps(metadata).encode(),
    ) as download, patch(
        "prepare_summary.ckpt.restore_all_chunk_checkpoints"
    ) as restore, patch(
        "prepare_summary.ckpt.restore_chunk_statuses",
        return_value=3,
    ) as restore_statuses, patch(
        "prepare_summary.ckpt.read_chunk_attempt_ordinals",
        return_value={0: 4, 1: 3, 2: 2},
    ) as ordinals:
        restore.return_value = ckpt.RestoreResult([], 0, 0, 0)
        assert prepare_summary.main() == 0

    download.assert_called_once_with(
        "ckpt-bucket", ckpt.run_metadata_lookup_object_name("7", "100")
    )
    restore.assert_called_once_with(
        bucket="ckpt-bucket",
        run_prefix=metadata["gcs"]["checkpoint_prefix"],
        dest_dir=results_dir,
        chunk_count=3,
    )
    restore_statuses.assert_called_once_with(
        bucket="ckpt-bucket",
        run_prefix=metadata["gcs"]["checkpoint_prefix"],
        dest_dir=results_dir,
        chunk_count=3,
    )
    ordinals.assert_called_once_with(
        bucket="ckpt-bucket",
        run_prefix=metadata["gcs"]["checkpoint_prefix"],
        chunk_count=3,
    )
    # Attempt ordinals are restored separately; runner-authored chunk-meta
    # must never be fabricated from them.
    assert json.loads(attempts_path.read_text()) == {"0": 4, "1": 3, "2": 2}
    assert json.loads(metadata_path.read_text()) == metadata


def test_prepare_fails_when_durable_metadata_is_missing(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("BENCH_TRIAL_CHECKPOINTS", "true")
    monkeypatch.setenv("BENCH_CHECKPOINT_BUCKET", "ckpt-bucket")
    monkeypatch.setenv(
        "BENCHMARK_RUN_METADATA", str(tmp_path / ".benchmark" / "run-metadata.json")
    )
    monkeypatch.setenv("CI_PROJECT_ID", "7")
    monkeypatch.setenv("CI_PIPELINE_ID", "100")

    with patch("prepare_summary.ckpt.gcs_download_object", return_value=None):
        assert prepare_summary.main() == 1
