#!/usr/bin/env python3
"""Validate the pipeline's task selection once, before any chunk job runs.

A task name that matches nothing in the dataset can never produce a trial, so
every reconciliation pass reports it missing and each chunk retries until its
durable attempt budget drains — many paid agent runs to discover a typo. This
script turns that into an immediate, cheap failure at pipeline start.

Runs in the `prepare` stage (setup-image), which already reads committed
dataset files. Deliberately NOT part of chunk_runner.main(): that function must
not read the dataset file when an explicit selection was provided, and running
the check once per chunk would repeat the same diagnostic N times.

Exit codes:
  0 — selection is valid (or no explicit selection was given)
  1 — selection contains unknown or structurally invalid task names
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from bench_config import (
    DEFAULT_SELECTED_TASKS_JSON,
    ENV_BENCH_TASKS_ALL,
    ENV_SELECTED_TASKS_JSON,
    env_bool,
    validate_selected_tasks,
)
from chunk_runner import _fetch_all_tasks


def _tasks_all() -> bool:
    return env_bool(ENV_BENCH_TASKS_ALL)


def main() -> int:
    if _tasks_all():
        print("[validate-tasks] tasks_all=true; selection check not applicable")
        return 0

    raw = os.environ.get(ENV_SELECTED_TASKS_JSON, DEFAULT_SELECTED_TASKS_JSON)
    try:
        selected = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(
            f"[validate-tasks] {ENV_SELECTED_TASKS_JSON} is not valid JSON: {exc}",
            file=sys.stderr,
        )
        return 1
    if not isinstance(selected, list) or not all(isinstance(t, str) for t in selected):
        print(
            f"[validate-tasks] {ENV_SELECTED_TASKS_JSON} must be a JSON array of strings",
            file=sys.stderr,
        )
        return 1
    if not selected:
        print("[validate-tasks] no explicit task selection; the full dataset will run")
        return 0

    dataset = os.environ.get("DATASET", "terminal-bench/terminal-bench-2")
    try:
        known = _fetch_all_tasks(dataset, bench_dir=Path("."))
    except (RuntimeError, OSError, json.JSONDecodeError) as exc:
        # Never let validation itself break a run: without a resolvable
        # dataset the membership check is skipped, and the pipeline continues
        # to fail (or succeed) on its own terms.
        print(
            f"[validate-tasks] cannot resolve dataset {dataset!r}, skipping "
            f"membership check: {exc}",
            file=sys.stderr,
        )
        return 0

    try:
        normalized = validate_selected_tasks(selected, known)
    except ValueError as exc:
        print(f"[validate-tasks] {exc}", file=sys.stderr)
        return 1

    dropped = len(selected) - len(normalized)
    detail = f" ({dropped} duplicate(s) collapsed)" if dropped else ""
    print(
        f"[validate-tasks] {len(normalized)} task(s) validated against "
        f"{dataset}{detail}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
