"""Unit tests for upload_gcs.py — the tar+uploader invoked by the summary job.

Behaviour under test:
  - It reads run metadata and uses its `gcs.prefix` field as the destination.
  - It creates a `jobs.tar.gz` archive rooted at the results directory.
  - It shells out to `gcloud storage cp` for both metadata.json and jobs.tar.gz.
  - It returns 0 on success and skips upload (exit 1 if GCS_UPLOAD_REQUIRED else
    0) when run metadata is missing.
"""

from __future__ import annotations

import json
import tarfile
from pathlib import Path
from unittest.mock import patch

import pytest

import upload_gcs


@pytest.fixture
def fake_run_metadata(tmp_path: Path) -> Path:
    """Write a minimal .benchmark/run-metadata.json and return its path."""
    metadata = {
        "benchmark": "terminal-bench-2",
        "coding_agent": "kimchi",
        "model": "multi-model",
        "model_provider": "kimchi",
        "model_name": "multi-model",
        "configuration": "multi-mode",
        "multi_mode": True,
        "ferment": False,
        "selected_tasks": ["task-a"],
        "parameters": {},
        "results_dir": str(tmp_path / "jobs"),
        "gcs": {"prefix": "runs/benchmark=terminal-bench-2/run=gitlab-p1"},
    }
    metadata_path = tmp_path / "run-metadata.json"
    metadata_path.write_text(json.dumps(metadata))
    return metadata_path


def test_create_archive_writes_jobs_tar_gz(tmp_path: Path) -> None:
    """create_archive tars the results dir with arcname=results_dir.name."""
    results_dir = tmp_path / "jobs"
    (results_dir / "task-a__1").mkdir(parents=True)
    (results_dir / "task-a__1" / "result.json").write_text('{"trial_name":"a"}')
    (results_dir / "chunk-meta").mkdir()
    (results_dir / "chunk-meta" / "chunk-0.json").write_text("{}")

    archive_file = tmp_path / "out" / "jobs.tar.gz"
    upload_gcs.create_archive(results_dir, archive_file)

    assert archive_file.is_file()
    with tarfile.open(archive_file, "r:gz") as tar:
        names = tar.getnames()
    # arcname=results_dir.name, so paths inside the archive are "jobs/..."
    assert any(name.startswith("jobs/") for name in names), names
    assert "jobs/task-a__1/result.json" in names, names
    assert "jobs/chunk-meta/chunk-0.json" in names, names


def test_main_uploads_consolidated_archive(
    tmp_path: Path, fake_run_metadata: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """upload_gcs.main() reads gcs.prefix from run-metadata and uploads one jobs.tar.gz."""
    metadata = json.loads(fake_run_metadata.read_text())
    results_dir = Path(metadata["results_dir"])
    results_dir.mkdir(parents=True)
    for chunk in (0, 1, 2):
        trial = results_dir / f"task-{chunk}__1"
        trial.mkdir()
        (trial / "result.json").write_text(json.dumps({"trial_name": f"task-{chunk}"}))
    (results_dir / "chunk-meta").mkdir()
    for chunk in (0, 1, 2):
        (results_dir / "chunk-meta" / f"chunk-{chunk}.json").write_text("{}")

    monkeypatch.setenv("BENCHMARK_GCS_BUCKET", "test-bucket")
    monkeypatch.setenv("BENCHMARK_RUN_METADATA", str(fake_run_metadata))
    monkeypatch.setenv("GCS_UPLOAD_REQUIRED", "true")
    # Keep work_dir inside tmp_path so the test doesn't leave a real
    # .benchmark-upload/ behind in the caller's working directory.
    monkeypatch.setenv("CI_PROJECT_DIR", str(tmp_path))

    cp_calls: list[list[str]] = []

    def fake_run(cmd: list[str]) -> None:
        cp_calls.append(cmd)

    with patch.object(upload_gcs, "run", side_effect=fake_run):
        rc = upload_gcs.main()

    assert rc == 0
    cp_strings = [" ".join(cmd) for cmd in cp_calls]
    assert any("metadata.json" in s and "test-bucket" in s for s in cp_strings), cp_strings
    archive_uploads = [s for s in cp_strings if "jobs.tar.gz" in s]
    assert len(archive_uploads) == 1, (
        f"Expected exactly one jobs.tar.gz upload, got {len(archive_uploads)}: {archive_uploads}"
    )
    assert "runs/benchmark=terminal-bench-2/run=gitlab-p1/jobs.tar.gz" in archive_uploads[0]


def test_main_skips_when_metadata_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If run-metadata.json is missing and uploads are not required, exit 0 with skip log."""
    monkeypatch.setenv("BENCHMARK_GCS_BUCKET", "test-bucket")
    monkeypatch.setenv("BENCHMARK_RUN_METADATA", str(tmp_path / "missing.json"))
    monkeypatch.setenv("GCS_UPLOAD_REQUIRED", "false")

    with patch.object(upload_gcs, "run") as fake_run:
        rc = upload_gcs.main()

    assert rc == 0
    fake_run.assert_not_called()


def test_main_fails_when_metadata_missing_and_upload_required(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If run-metadata.json is missing and uploads ARE required, exit non-zero."""
    monkeypatch.setenv("BENCHMARK_GCS_BUCKET", "test-bucket")
    monkeypatch.setenv("BENCHMARK_RUN_METADATA", str(tmp_path / "missing.json"))
    monkeypatch.setenv("GCS_UPLOAD_REQUIRED", "true")

    with patch.object(upload_gcs, "run") as fake_run:
        rc = upload_gcs.main()

    assert rc != 0
    fake_run.assert_not_called()


def test_main_uploads_to_2_1_prefix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 2.1 run's gcs.prefix routes jobs.tar.gz under runs/benchmark=terminal-bench-2-1/.

    Mirrors test_main_uploads_consolidated_archive but with the run metadata's
    `gcs.prefix` set to a 2.1 prefix, proving the upload lands in a namespace
    disjoint from the 2.0 default.
    """
    metadata = {
        "benchmark": "terminal-bench-2-1",
        "coding_agent": "kimchi",
        "model": "kimchi-dev/kimi-k2.6",
        "model_provider": "kimchi-dev",
        "model_name": "kimi-k2.6",
        "configuration": "single-model",
        "multi_mode": False,
        "ferment": False,
        "selected_tasks": ["task-a"],
        "parameters": {},
        "results_dir": str(tmp_path / "jobs"),
        "gcs": {"prefix": "runs/benchmark=terminal-bench-2-1/run=gitlab-p1"},
    }
    metadata_path = tmp_path / "run-metadata.json"
    metadata_path.write_text(json.dumps(metadata))

    results_dir = Path(metadata["results_dir"])
    results_dir.mkdir(parents=True)
    for chunk in (0, 1, 2):
        trial = results_dir / f"task-{chunk}__1"
        trial.mkdir()
        (trial / "result.json").write_text(json.dumps({"trial_name": f"task-{chunk}"}))
    (results_dir / "chunk-meta").mkdir()
    for chunk in (0, 1, 2):
        (results_dir / "chunk-meta" / f"chunk-{chunk}.json").write_text("{}")

    monkeypatch.setenv("BENCHMARK_GCS_BUCKET", "test-bucket")
    monkeypatch.setenv("BENCHMARK_RUN_METADATA", str(metadata_path))
    monkeypatch.setenv("GCS_UPLOAD_REQUIRED", "true")
    # Keep work_dir inside tmp_path so the test doesn't leave a real
    # .benchmark-upload/ behind in the caller's working directory.
    monkeypatch.setenv("CI_PROJECT_DIR", str(tmp_path))

    cp_calls: list[list[str]] = []

    def fake_run(cmd: list[str]) -> None:
        cp_calls.append(cmd)

    with patch.object(upload_gcs, "run", side_effect=fake_run):
        rc = upload_gcs.main()

    assert rc == 0
    cp_strings = [" ".join(cmd) for cmd in cp_calls]
    assert any("metadata.json" in s and "test-bucket" in s for s in cp_strings), cp_strings
    archive_uploads = [s for s in cp_strings if "jobs.tar.gz" in s]
    assert len(archive_uploads) == 1, (
        f"Expected exactly one jobs.tar.gz upload, got {len(archive_uploads)}: {archive_uploads}"
    )
    assert "runs/benchmark=terminal-bench-2-1/run=gitlab-p1/jobs.tar.gz" in archive_uploads[0]


def test_main_target_ref_from_run_metadata_when_env_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """target_ref falls back to run_metadata.gitlab.target_ref when BENCHMARK_TARGET_REF is unset.

    The summary job does not have BENCHMARK_TARGET_REF (only the chunk job does).
    upload_gcs.py must read it from the run-metadata.json written by chunk_runner.py
    rather than falling back to CI_COMMIT_REF_NAME (which would be 'benchmarks').
    """
    metadata = {
        "benchmark": "terminal-bench-2-1",
        "coding_agent": "kimchi",
        "model": "kimchi-dev/minimax-m3",
        "model_provider": "kimchi-dev",
        "model_name": "minimax-m3",
        "configuration": "single-model",
        "multi_mode": False,
        "ferment": False,
        "selected_tasks": ["task-a"],
        "parameters": {},
        "results_dir": str(tmp_path / "jobs"),
        "gcs": {"prefix": "runs/benchmark=terminal-bench-2-1/run=gitlab-p1"},
        "gitlab": {
            "target_ref": "master",
            "target_commit_sha": "abc123",
        },
    }
    metadata_path = tmp_path / "run-metadata.json"
    metadata_path.write_text(json.dumps(metadata))

    results_dir = Path(metadata["results_dir"])
    results_dir.mkdir(parents=True)
    (results_dir / "task-a__1").mkdir()
    (results_dir / "task-a__1" / "result.json").write_text('{}')

    monkeypatch.setenv("BENCHMARK_GCS_BUCKET", "test-bucket")
    monkeypatch.setenv("BENCHMARK_RUN_METADATA", str(metadata_path))
    monkeypatch.setenv("GCS_UPLOAD_REQUIRED", "true")
    monkeypatch.setenv("CI_PROJECT_DIR", str(tmp_path))
    # Simulate the summary job: BENCHMARK_TARGET_REF is NOT set
    monkeypatch.delenv("BENCHMARK_TARGET_REF", raising=False)
    monkeypatch.delenv("BENCHMARK_TARGET_SHA", raising=False)
    monkeypatch.setenv("CI_COMMIT_REF_NAME", "benchmarks")
    monkeypatch.setenv("CI_COMMIT_SHA", "deadbeef")

    uploaded_metadata = {}

    def fake_run(cmd: list[str]) -> None:
        if "metadata.json" in " ".join(cmd):
            # The metadata.json is written to a work_dir; find it
            for arg in cmd:
                if arg.endswith("metadata.json") and Path(arg).exists():
                    uploaded_metadata.update(json.loads(Path(arg).read_text()))

    with patch.object(upload_gcs, "run", side_effect=fake_run):
        rc = upload_gcs.main()

    assert rc == 0
    assert uploaded_metadata["gitlab"]["target_ref"] == "master"
    assert uploaded_metadata["gitlab"]["target_commit_sha"] == "abc123"
