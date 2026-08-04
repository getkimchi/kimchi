#!/usr/bin/env python3
"""Validate runner-delivered artifacts or hydrate durable GCS checkpoint state."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import checkpoint as ckpt


def _enabled() -> bool:
    return os.environ.get("BENCH_TRIAL_CHECKPOINTS", "").strip().lower() in {
        "true",
        "1",
        "yes",
    }


def _load_object(data: bytes, source: str) -> dict[str, Any]:
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ckpt.CheckpointCorruptError(
            f"invalid checkpoint run metadata from {source}: {exc}"
        ) from exc
    if not isinstance(value, dict):
        raise ckpt.CheckpointCorruptError(
            f"invalid checkpoint run metadata from {source}: expected an object"
        )
    return value


def _load_or_recover_metadata(metadata_path: Path, bucket: str) -> dict[str, Any]:
    if metadata_path.is_file():
        return _load_object(metadata_path.read_bytes(), str(metadata_path))

    project_id = os.environ.get("CI_PROJECT_ID", "")
    pipeline_id = os.environ.get("CI_PIPELINE_ID", "")
    if not project_id or not pipeline_id:
        raise ckpt.CheckpointRestoreError(
            "CI_PROJECT_ID and CI_PIPELINE_ID are required to recover run metadata"
        )
    object_name = ckpt.run_metadata_lookup_object_name(project_id, pipeline_id)
    data = ckpt.gcs_download_object(bucket, object_name)
    if data is None:
        raise ckpt.CheckpointRestoreError(
            f"durable run metadata not found at gs://{bucket}/{object_name}"
        )
    metadata = _load_object(data, object_name)
    gitlab = metadata.get("gitlab")
    if not isinstance(gitlab, dict) or (
        str(gitlab.get("project_id", "")) != project_id
        or str(gitlab.get("pipeline_id", "")) != pipeline_id
    ):
        raise ckpt.CheckpointCorruptError(
            f"durable run metadata identity does not match project={project_id} "
            f"pipeline={pipeline_id}"
        )
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"[summary] recovered run metadata from gs://{bucket}/{object_name}", flush=True)
    return metadata


def count_runner_delivered_chunks(results_dir: Path, chunk_count: int) -> int:
    """Count valid per-chunk metadata delivered by GitLab's artifact runner."""
    found: set[int] = set()
    meta_dir = results_dir / "chunk-meta"
    for meta_path in meta_dir.glob("chunk-*.json"):
        try:
            value = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        chunk_index = value.get("chunk_index") if isinstance(value, dict) else None
        if isinstance(chunk_index, int) and 0 <= chunk_index < chunk_count:
            found.add(chunk_index)
    return len(found)


def main() -> int:
    if not _enabled():
        chunk_count_raw = os.environ.get("BENCH_CHUNK_COUNT", "")
        try:
            chunk_count = int(chunk_count_raw)
        except ValueError:
            chunk_count = 0
        if chunk_count < 1:
            print(
                "BENCH_CHUNK_COUNT must be a positive integer when checkpointing "
                "is disabled",
                file=sys.stderr,
            )
            return 1
        results_dir = Path(
            os.environ.get(
                "BENCHMARK_RESULTS_DIR",
                "benchmark/terminal-bench-2/jobs",
            )
        )
        restored_chunks = count_runner_delivered_chunks(results_dir, chunk_count)
        if restored_chunks != chunk_count:
            print(
                f"[summary] checkpointing is disabled, but runner-delivered "
                f"artifacts contain only {restored_chunks}/{chunk_count} chunk "
                "metadata files; refusing to summarize incomplete results",
                file=sys.stderr,
            )
            return 1
        print(
            f"[summary] runner-artifact-hydrate chunks={restored_chunks}",
            flush=True,
        )
        return 0

    bucket = os.environ.get("BENCH_CHECKPOINT_BUCKET", "")
    if not bucket:
        print(
            "BENCH_TRIAL_CHECKPOINTS=true requires BENCH_CHECKPOINT_BUCKET",
            file=sys.stderr,
        )
        return 1
    metadata_path = Path(
        os.environ.get("BENCHMARK_RUN_METADATA", ".benchmark/run-metadata.json")
    )
    try:
        metadata = _load_or_recover_metadata(metadata_path, bucket)
        gcs = metadata.get("gcs")
        run_prefix = (
            gcs.get("checkpoint_prefix") or gcs.get("prefix")
            if isinstance(gcs, dict)
            else None
        )
        if not isinstance(run_prefix, str) or not run_prefix:
            raise ckpt.CheckpointCorruptError(
                "checkpoint run metadata has no gcs.prefix"
            )
        results_dir = Path(
            os.environ.get(
                "BENCHMARK_RESULTS_DIR",
                str(metadata.get("results_dir", "benchmark/terminal-bench-2/jobs")),
            )
        )
        chunk_count_raw = os.environ.get("BENCH_CHUNK_COUNT", "")
        chunk_count = int(chunk_count_raw) if chunk_count_raw.isdigit() else None
        if chunk_count is None or chunk_count < 1:
            raise ValueError(
                "BENCH_CHUNK_COUNT must be a positive integer when checkpointing "
                "is enabled"
            )
        restored_statuses = ckpt.restore_chunk_statuses(
            bucket=bucket,
            run_prefix=run_prefix,
            dest_dir=results_dir,
            chunk_count=chunk_count,
        )
        result = ckpt.restore_all_chunk_checkpoints(
            bucket=bucket,
            run_prefix=run_prefix,
            dest_dir=results_dir,
            chunk_count=chunk_count,
        )
    except (ckpt.CheckpointError, OSError, ValueError) as exc:
        print(f"[summary] checkpoint preparation failed: {exc}", file=sys.stderr)
        return 1

    print(
        f"[summary] gcs-checkpoint-hydrate "
        f"restored={len(result.restored)} duplicates={result.duplicates} "
        f"corrupt={result.corrupt} chunk_statuses={restored_statuses}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
