#!/usr/bin/env python3
"""Pre-fetch DeepSWE task images from GCP Artifact Registry mirror.

Pulls this chunk's task images from the GCP AR mirror (authenticated, no rate
limits) and re-tags them to their original ECR names so Pier's
``docker compose build`` finds them in the local Docker cache.

Run in CI before ``chunk_runner.py`` starts Pier::

    python3 benchmark/scripts/gitlab/prefetch_deep_swe_images.py

Environment variables (set by deep-swe.yml):
  BENCH_CHUNK_INDEX       — 0-based chunk index
  BENCH_CHUNK_COUNT       — total number of chunks
  BENCH_TASKS_ALL          — "true" means use all tasks from the dataset file
  SELECTED_TASKS_JSON      — JSON array of task names (when tasks_all is false)
  DATASET                  — dataset key (default: "deep-swe")
  DEEP_SWE_TASKS_PATH      — path to cloned DeepSWE tasks (default: /tmp/deep-swe/tasks)

Best-effort: pull failures are logged but do not abort the job — the trial
itself will classify the failure. This mirrors the contract of
``preload_task_images.py`` used by terminal-bench-2 and swe-bench-pro.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tomllib
from pathlib import Path

from chunk_runner import _fetch_all_tasks
from chunk_slicing import slice_tasks

GCP_AR_HOST = "us-east4-docker.pkg.dev/cicd-master-oxk5"
GCP_AR_REPO = "kimchi-benchmarks"
GCP_AR_PREFIX = f"{GCP_AR_HOST}/{GCP_AR_REPO}/deep-swe"

_ENV_CHUNK_INDEX = "BENCH_CHUNK_INDEX"
_ENV_CHUNK_COUNT = "BENCH_CHUNK_COUNT"
_ENV_TASKS_ALL = "BENCH_TASKS_ALL"
_ENV_SELECTED_TASKS = "SELECTED_TASKS_JSON"
_ENV_DATASET = "DATASET"
_ENV_TASKS_PATH = "DEEP_SWE_TASKS_PATH"
_DEFAULT_TASKS_PATH = "/tmp/deep-swe/tasks"


def _log(msg: str) -> None:
    print(f"[prefetch] {msg}", flush=True)


def _resolve_chunk_tasks() -> list[str]:
    """Resolve and slice this chunk's task list, mirroring chunk_runner.main()."""
    dataset = os.environ.get(_ENV_DATASET, "deep-swe")
    tasks_all = os.environ.get(_ENV_TASKS_ALL, "false").strip().lower() in ("true", "1", "yes")

    selected: list[str] = json.loads(os.environ.get(_ENV_SELECTED_TASKS, "[]"))
    if tasks_all or not selected:
        selected = _fetch_all_tasks(dataset, bench_dir=Path("."))

    chunk_index = int(os.environ.get(_ENV_CHUNK_INDEX, "0"))
    chunk_count = int(os.environ.get(_ENV_CHUNK_COUNT, "1"))
    return slice_tasks(selected, chunk_index=chunk_index, chunk_count=chunk_count)


def _gcp_ar_name(ecr_image: str) -> str:
    """Map an ECR image ref to its GCP AR mirror name.

    e.g. public.ecr.aws/d3j8x8q7/swe-bench-202605:abc-v1.1
         → us-east4-docker.pkg.dev/cicd-master-oxk5/kimchi-benchmarks/deep-swe/swe-bench-202605:abc-v1.1
    """
    if ":" in ecr_image:
        name, tag = ecr_image.rsplit(":", 1)
    else:
        name, tag = ecr_image, "latest"
    image_name = name.rsplit("/", 1)[-1]
    return f"{GCP_AR_PREFIX}/{image_name}:{tag}"


def _read_task_images(tasks: list[str], tasks_dir: Path) -> list[str]:
    """Extract unique docker_image refs from each task's task.toml."""
    images: list[str] = []
    seen: set[str] = set()
    for task_name in tasks:
        toml_path = tasks_dir / task_name / "task.toml"
        if not toml_path.exists():
            _log(f"  SKIP {task_name}: task.toml not found")
            continue
        try:
            data = tomllib.loads(toml_path.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError) as exc:
            _log(f"  SKIP {task_name}: {exc}")
            continue
        img = data.get("environment", {}).get("docker_image")
        if img and img not in seen:
            seen.add(img)
            images.append(img)
    return images


def _docker_pull(image: str) -> bool:
    """Pull an image, streaming progress to stdout."""
    result = subprocess.run(["docker", "pull", image])
    return result.returncode == 0


def _docker_tag(src: str, dst: str) -> bool:
    """Tag an image."""
    result = subprocess.run(["docker", "tag", src, dst])
    return result.returncode == 0


def main() -> int:
    tasks_dir = Path(os.environ.get(_ENV_TASKS_PATH, _DEFAULT_TASKS_PATH))
    if not tasks_dir.is_dir():
        _log(f"ERROR: tasks directory not found: {tasks_dir}")
        return 1

    tasks = _resolve_chunk_tasks()
    if not tasks:
        _log("no tasks selected for this chunk; nothing to pre-fetch")
        return 0

    images = _read_task_images(tasks, tasks_dir)
    _log(f"chunk has {len(images)} unique task images to pre-fetch from GCP AR")

    pulled = 0
    failed = 0
    for i, ecr_image in enumerate(images, 1):
        ar_image = _gcp_ar_name(ecr_image)
        _log(f"[{i}/{len(images)}] {ar_image}")
        if not _docker_pull(ar_image):
            _log("  PULL FAILED, will try ECR fallback")
            # Fallback: try pulling directly from ECR (best-effort)
            if _docker_pull(ecr_image):
                pulled += 1
                _log("  pulled from ECR (fallback)")
            else:
                failed += 1
                _log("  FAILED from both GCP AR and ECR")
            continue
        # Re-tag to the original ECR name so Pier's docker compose build finds it locally
        if _docker_tag(ar_image, ecr_image):
            pulled += 1
            _log(f"  tagged as {ecr_image}")
        else:
            failed += 1
            _log("  TAG FAILED")

    _log(f"pre-fetch complete: {pulled} pulled, {failed} failed (best-effort)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
