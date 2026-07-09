#!/usr/bin/env python3
"""Upload benchmark result artifacts to GCS from GitLab CI.

The benchmark runner writes normalized run metadata. This script reads that
metadata, adds GitLab/GCS details, and uploads the benchmark artifacts.
"""

from __future__ import annotations

import json
import os
import subprocess
import tarfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def getenv(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def require_env(name: str) -> str:
    value = getenv(name)
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def load_run_metadata(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def metadata_bool(metadata: dict[str, Any], key: str) -> bool:
    value = metadata.get(key)
    if isinstance(value, bool):
        return value
    return str(value).lower() == "true"


def metadata_list(metadata: dict[str, Any], key: str) -> list[Any]:
    value = metadata.get(key)
    return value if isinstance(value, list) else []


def metadata_dict(metadata: dict[str, Any], key: str) -> dict[str, Any]:
    value = metadata.get(key)
    return value if isinstance(value, dict) else {}


def optional_metadata_string(metadata: dict[str, Any], key: str) -> str | None:
    value = metadata.get(key)
    if value is None:
        return None
    text = str(value)
    return text if text else None


def metadata_string(metadata: dict[str, Any], key: str, default: str = "unknown") -> str:
    value = metadata.get(key)
    if value is None:
        return default
    text = str(value)
    return text if text else default


def create_archive(results_dir: Path, archive_file: Path) -> None:
    """Tar `results_dir` into `archive_file` with `results_dir.name` as the archive root.

    The archive mirrors the live `BENCHMARK_RESULTS_DIR` layout, so it includes:
      - `jobs/run-N/task__attempt/result.json` — per-trial enriched verdicts.
      - `jobs/chunk-meta/chunk-N.json` — per-chunk attempt summaries written by
        `chunk_runner._write_chunk_meta` (one entry per chunk that ran, with
        `chunk_attempt`, `exit_code`, `needs_retry`, and `timestamp`). These
        exist because the summary job runs after all chunks and tars the entire
        results directory in one shot; downstream consumers that destructure the
        archive should skip the `chunk-meta/` directory.
    """
    archive_file.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_file, "w:gz") as tar:
        tar.add(results_dir, arcname=results_dir.name)


def resolve_gcs_prefix(run_metadata: dict[str, Any]) -> str | None:
    gcs_metadata = metadata_dict(run_metadata, "gcs")
    return optional_metadata_string(gcs_metadata, "prefix")


def upload_required() -> bool:
    return getenv("GCS_UPLOAD_REQUIRED").lower() == "true"


def skip_upload(message: str) -> int:
    print(message)
    return 1 if upload_required() else 0


def main() -> int:
    metadata_path = Path(getenv("BENCHMARK_RUN_METADATA", ".benchmark/run-metadata.json"))
    run_metadata = load_run_metadata(metadata_path)
    if run_metadata is None:
        return skip_upload(f"No benchmark run metadata found at {metadata_path}; skipping GCS upload.")

    benchmark = metadata_string(run_metadata, "benchmark")
    results_dir = Path(metadata_string(run_metadata, "results_dir", "benchmark/terminal-bench-2/jobs"))
    coding_agent = metadata_string(run_metadata, "coding_agent")
    model = metadata_string(run_metadata, "model")
    model_provider = metadata_string(run_metadata, "model_provider")
    model_name = metadata_string(run_metadata, "model_name")
    configuration = metadata_string(run_metadata, "configuration", "na")
    multi_mode = metadata_bool(run_metadata, "multi_mode")
    ferment = metadata_bool(run_metadata, "ferment")
    selected_tasks = metadata_list(run_metadata, "selected_tasks")
    parameters = metadata_dict(run_metadata, "parameters")

    bucket = require_env("BENCHMARK_GCS_BUCKET")

    if not results_dir.is_dir():
        return skip_upload(f"No benchmark results directory found at {results_dir}; skipping GCS upload.")

    gcs_prefix = resolve_gcs_prefix(run_metadata)
    if not gcs_prefix:
        return skip_upload("No GCS prefix found in benchmark run metadata; skipping GCS upload.")

    work_dir = Path(getenv("CI_PROJECT_DIR", os.getcwd())) / ".benchmark-upload"
    work_dir.mkdir(mode=0o700, exist_ok=True)
    metadata_file = work_dir / "metadata.json"
    archive_file = work_dir / "jobs.tar.gz"

    # The chunk job sets BENCHMARK_TARGET_REF and writes it into
    # run-metadata.json. The summary job does not have that env var, so fall
    # back to the value stored in run_metadata.gitlab.target_ref.
    # Never fall back to CI_COMMIT_REF_NAME — that is the branch the pipeline
    # ran on (e.g. "benchmarks"), not the target ref being benchmarked.
    chunk_gitlab = metadata_dict(run_metadata, "gitlab")
    target_ref = getenv("BENCHMARK_TARGET_REF") or optional_metadata_string(chunk_gitlab, "target_ref")
    if not target_ref:
        return skip_upload(
            "No target_ref found in BENCHMARK_TARGET_REF or run_metadata.gitlab.target_ref; skipping GCS upload."
        )
    target_commit_sha = getenv("BENCHMARK_TARGET_SHA") or optional_metadata_string(chunk_gitlab, "target_commit_sha")
    if not target_commit_sha:
        return skip_upload(
            "No target_commit_sha found in BENCHMARK_TARGET_SHA or run_metadata.gitlab.target_commit_sha; "
            "skipping GCS upload."
        )

    metadata = {
        "schema_version": 1,
        "created_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "benchmark": benchmark,
        "coding_agent": coding_agent,
        "model": model,
        "model_provider": model_provider,
        "model_name": model_name,
        "configuration": configuration,
        "multi_mode": multi_mode,
        "ferment": ferment,
        "selected_tasks": selected_tasks,
        "parameters": parameters,
        "run_metadata": run_metadata,
        "gcs": {
            "bucket": bucket,
            "prefix": gcs_prefix,
        },
        "gitlab": {
            "project_path": getenv("CI_PROJECT_PATH"),
            "project_id": getenv("CI_PROJECT_ID"),
            "pipeline_id": getenv("CI_PIPELINE_ID"),
            "pipeline_url": getenv("CI_PIPELINE_URL"),
            "pipeline_source": getenv("CI_PIPELINE_SOURCE"),
            "job_id": getenv("CI_JOB_ID"),
            "job_url": getenv("CI_JOB_URL"),
            "ref": getenv("CI_COMMIT_REF_NAME"),
            "ref_slug": getenv("CI_COMMIT_REF_SLUG"),
            "commit_sha": getenv("CI_COMMIT_SHA"),
            "commit_short_sha": getenv("CI_COMMIT_SHORT_SHA"),
            "target_ref": target_ref,
            "target_commit_sha": target_commit_sha,
        },
    }
    metadata_file.write_text(json.dumps(metadata, indent=2) + "\n")

    create_archive(results_dir, archive_file)

    destination = f"gs://{bucket}/{gcs_prefix}"
    print(f"Uploading benchmark results to {destination}")
    run(["gcloud", "storage", "cp", str(metadata_file), f"{destination}/metadata.json", "--quiet"])
    run(["gcloud", "storage", "cp", str(archive_file), f"{destination}/jobs.tar.gz", "--quiet"])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
