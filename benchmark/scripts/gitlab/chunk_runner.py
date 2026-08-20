"""Chunk runner — orchestrates one chunk's slice of the benchmark.

Responsibilities:
  1. Compute this chunk's task slice (using chunk_slicing).
  2. On retry, restore the previous attempt's artifact from the GitLab API
     (GitLab's `retry:` starts each attempt with a fresh workspace; the prior
     artifact is downloadable but NOT auto-extracted).
  3. Inspect the local job workspace for previously-completed trials.
  4. For each task:
       - If infra_error=False locally → skip (already final).
       - If infra_error=True or missing → add to Harbor invocation list.
  5. Invoke Harbor on the missing tasks.
  6. Classify any newly written result.json files.
  7. Write enriched verdicts to local workspace (artifact preserved on retry).
  8. Exit non-zero if any tasks need retry; GitLab handles retry/resume.

Per-trial GCS uploads are NOT done here. The summary job tars the entire
`BENCHMARK_RESULTS_DIR` into `jobs.tar.gz` and uploads that as the single
source of truth. Resume state lives in the local artifact.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import checkpoint as ckpt
import redact_api_key
from bench_config import (
    DEFAULT_BENCHMARK_NAME,
    DEFAULT_BENCHMARK_RESULTS_DIR,
    DEFAULT_BENCHMARK_RUN_METADATA,
    DEFAULT_CODING_AGENT,
    DEFAULT_DEEP_SWE_TASKS_PATH,
    DEFAULT_KIMCHI_COMPACTION,
    DEFAULT_MODEL,
    DEFAULT_WORKFLOW,
    DEFAULT_WORKFLOW_EXTENSION,
    ENV_BENCH_RUN_DATE,
    ENV_BENCH_TASKS_ALL,
    ENV_BENCHMARK_NAME,
    ENV_BENCHMARK_RESULTS_DIR,
    ENV_BENCHMARK_RUN_METADATA,
    ENV_BENCHMARK_TARGET_REF,
    ENV_CODING_AGENT,
    ENV_DEEP_SWE_TASKS_PATH,
    ENV_KIMCHI_COMPACTION,
    ENV_KIMCHI_FERMENT_ONESHOT,
    ENV_MODEL,
    ENV_WORKFLOW,
    ENV_WORKFLOW_EXTENSION,
    MULTI_MODEL,
    checkpoint_bucket,
    checkpoint_soft_deadline_seconds,
    checkpoint_upload_retries,
    checkpoints_enabled,
    env_bool,
    is_multi_model,
    is_retryable,
    is_workflow_agent,
    load_docker_health_config,
    load_llm_params,
    normalize_selected_tasks,
    parse_model,
    resolve_chunk_attempt_budget,
    resolve_thinking_level,
    should_retry_agent_timeout,
    use_pier,
    validate_chunk_attempt_budget,
    validate_llm_params_for_model,
    validate_thinking_level_for_model,
)
from chunk_slicing import slice_tasks
from classify import classify
from docker_health import (
    DOCKER_DAEMON_UNREACHABLE_MARKER,
    DOCKER_DAEMON_UNREACHABLE_SUBCATEGORY,
)
from gitlab_api import list_pipeline_jobs
from harbor_runner import (
    CheckpointPluginArgs,
    build_harbor_command,
    format_command_for_log,
    run_harbor,
)
from pier_runner import build_pier_command, run_pier
from reconcile import compute_chunk_progress, is_chunk_complete, missing_tasks

# Directory containing static per-dataset task lists (JSON arrays of task name strings).
# These are committed to git to avoid flaky Harbor CLI calls at runtime.
_DATASETS_DIR = Path(__file__).parent / "datasets"

# Maps Harbor dataset slugs to static file basenames.
_DATASET_FILE_MAP: dict[str, str] = {
    "terminal-bench/terminal-bench-2": "terminal-bench-2.json",
    "terminal-bench/terminal-bench-2-1": "terminal-bench-2-1.json",
    "swebenchpro": "swebenchpro.json",
    "deep-swe": "deep-swe.json",
}


def _fetch_all_tasks(dataset: str, bench_dir: Path) -> list[str]:
    # Read from a static JSON file instead of querying Harbor at runtime: the
    # Harbor registry backend (Supabase/PostgREST) occasionally fails with
    # PGRST002 on cold start, which would abort the entire benchmark job.
    filename = _DATASET_FILE_MAP.get(dataset)
    if filename is None:
        raise RuntimeError(
            f"No task list file for dataset {dataset!r}. "
            f"Known datasets: {sorted(_DATASET_FILE_MAP)}"
        )
    task_file = _DATASETS_DIR / filename
    if not task_file.is_file():
        raise RuntimeError(
            f"Task list file not found: {task_file}"
        )
    tasks = json.loads(task_file.read_text(encoding="utf-8"))
    if not isinstance(tasks, list) or not all(isinstance(t, str) for t in tasks):
        raise RuntimeError(
            f"Task list file {task_file} must be a JSON array of strings"
        )
    return tasks


def run_id_from_chunk_attempt(*, chunk_index: int, chunk_attempt: int) -> str:
    """Build a deterministic per-attempt identifier used in summary.json."""
    return f"chunk-{chunk_index}-attempt-{chunk_attempt}"


def list_trial_dirs(results_dir: Path) -> list[Path]:
    """Enumerate trial directories under results_dir/run-*/trial__attempt."""
    if not results_dir.is_dir():
        return []
    out: list[Path] = []
    for run_dir in sorted(p for p in results_dir.iterdir() if p.is_dir()):
        out.extend(sorted(p for p in run_dir.iterdir() if p.is_dir() and "__" in p.name))
    return out


def _task_name_from_result(trial_dir: Path) -> str | None:
    """Read the exact, untruncated task name Harbor recorded for this trial.

    Returns None if result.json is missing, malformed, or lacks task_name.
    Strips any "source/" prefix Harbor adds (e.g. "terminal-bench/sample-task"),
    matching the convention `expected_tasks` (bare names) uses — see the
    identical stripping logic in summarize_results.py's summarize_trial().
    """
    result_path = trial_dir / "result.json"
    if not result_path.is_file():
        return None
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    task_name = result.get("task_name") if isinstance(result, dict) else None
    return task_name.rsplit("/", 1)[-1] if isinstance(task_name, str) else None


def _all_trial_dirs_for_task(results_dir: Path, task_name: str) -> list[Path]:
    """Find all trial directories for a bare task name (e.g. 'task-a').

    Searches all run subdirectories under results_dir and returns every
    matching trial dir, sorted by name (ascending) for deterministic ordering.
    Returns empty list if none found.

    Harbor truncates long task names when creating trial directories (e.g.
    instance IDs of 70+ chars are truncated to a fixed-length prefix, e.g.
    'instance_ansible__ansible-0ea40e__e4a9yJi'). Matching on that truncated
    directory-name prefix alone is unsafe: many SWE-bench Pro instance IDs
    for the same repo share their first 32 characters (differing only in the
    commit SHA that follows), so a naive prefix comparison can attribute one
    task's trial to a different task entirely.

    To avoid that collision, prefer the exact `task_name` Harbor recorded
    inside the trial's own result.json — it is never truncated. Only fall
    back to the truncated directory-name prefix heuristic when result.json
    is missing/unreadable (e.g. a trial that crashed before writing it).
    """
    if not results_dir.is_dir():
        return []
    matches: dict[str, Path] = {}
    run_dirs = sorted(
        (path for path in results_dir.iterdir() if path.is_dir()),
        key=lambda path: (path.name == ckpt.CHECKPOINT_RESTORE_DIR, path.name),
    )
    for run_dir in run_dirs:
        if not run_dir.is_dir():
            continue
        for trial_dir in run_dir.iterdir():
            if not (trial_dir.is_dir() and "__" in trial_dir.name):
                continue
            recorded_task_name = _task_name_from_result(trial_dir)
            if recorded_task_name is not None:
                # Authoritative path: exact match against Harbor's own record.
                if recorded_task_name == task_name:
                    matches.setdefault(trial_dir.name, trial_dir)
                continue
            # Fallback path: no readable task_name (e.g. trial crashed before
            # result.json was written). Directory name starts with
            # `{task_name}__` for short (untruncated) names.
            if trial_dir.name.startswith(f"{task_name}__"):
                matches.setdefault(trial_dir.name, trial_dir)
                continue
            # Last resort: Harbor truncated the task name. The trial dir name
            # is `{truncated_prefix}__{suffix}`. Check if the full task name
            # starts with the truncated prefix. This can still collide across
            # tasks sharing a prefix, but only applies when we have no
            # authoritative task_name to compare against.
            prefix = trial_dir.name.rsplit("__", 1)[0]
            if task_name.startswith(prefix):
                matches.setdefault(trial_dir.name, trial_dir)
    return sorted(matches.values(), key=lambda p: p.name)


def write_enriched_results(
    *,
    results_dir: Path,
    expected_tasks: list[str],
) -> None:
    """Classify each trial and write enriched results to the local workspace.

    `expected_tasks` is a list of BARE task names (e.g. ['task-a', 'task-b']).

    No GCS uploads happen in this function. In checkpoint-enabled runs, the
    Harbor checkpoint plugin makes completed trials durable individually; the
    summary job later merges those checkpoints with runner-delivered GitLab
    artifacts and publishes the canonical `jobs.tar.gz` archive.
    """
    for task_name in expected_tasks:
        trial_dirs = _all_trial_dirs_for_task(results_dir, task_name)

        if not trial_dirs:
            continue

        for trial_dir in trial_dirs:
            verdict = classify(trial_dir)

            # Always write enriched local artifact (so resume sees it).
            # New v2 schema: outcome + error_category + error_subcategory.
            enriched = {
                **verdict.raw,
                "outcome": verdict.outcome,
                "error_category": verdict.error_category,
                "error_subcategory": verdict.error_subcategory,
            }
            (trial_dir / "result.json").write_text(
                json.dumps(enriched, indent=2) + "\n"
            )


__all__ = [
    "_all_trial_dirs_for_task",
    "_build_gcs_key_prefix",
    "_detect_chunk_attempt",
    "_expected_tasks_for_chunk",
    "_run_pier_invocation",
    "_upload_trial_checkpoint",
    "_write_chunk_meta",
    "list_trial_dirs",
    "main",
    "run_id_from_chunk_attempt",
    "write_enriched_results",
]


def _expected_tasks_for_chunk(
    selected_tasks: list[str],
    chunk_index: int,
    chunk_count: int,
) -> list[str]:
    """Compute this chunk's bare task names (no __attempt suffix)."""
    return slice_tasks(selected_tasks, chunk_index=chunk_index, chunk_count=chunk_count)


def _derive_configuration() -> str:
    """Derive configuration label from agent/model flags.

    Returns one of: 'default', 'multi-mode', 'multi-mode-ferment',
    'single-model', 'single-model-ferment', 'workflow-<name>'.
    """
    coding_agent = os.environ.get(ENV_CODING_AGENT, DEFAULT_CODING_AGENT)
    if is_workflow_agent(coding_agent):
        # Names the workflow, so a workflow run and a stock run of the same
        # model land under different GCS prefixes and stay comparable.
        # _build_gcs_key_prefix sanitizes whatever this returns.
        return f"workflow-{_selected_workflow()}"
    if coding_agent != "kimchi":
        return "default"
    segments = [_configuration_segment()]
    if _env_bool(ENV_KIMCHI_FERMENT_ONESHOT, False):
        segments.append("ferment")
    return "-".join(segments)


def _selected_workflow() -> str:
    """Return the workflow name this run executes.

    Reads through "" so an unset variable and one GitLab exported empty (a
    cleared input field) both fall back to the default.
    """
    return os.environ.get(ENV_WORKFLOW, "").strip() or DEFAULT_WORKFLOW


def _selected_workflow_extension() -> str:
    """Return the kimchi-workflows extension spec this run resolves.

    Empty-tolerant for the same reason as _selected_workflow.
    """
    return os.environ.get(ENV_WORKFLOW_EXTENSION, "").strip() or DEFAULT_WORKFLOW_EXTENSION


def _configuration_segment() -> str:
    """Return the Kimchi mode selected through MODEL."""
    return "multi-mode" if is_multi_model() else "single-model"


def _compaction_disabled() -> bool:
    """Resolve the KIMCHI_COMPACTION tri-state to "is compaction disabled".

    'auto' (the default) disables compaction for the staged runs — ferment
    one-shot and workflow runs (per-stage compaction was measured eating 21-41%
    of trial wall time there); 'enabled'/'disabled' force it either way for A/B
    runs. Raises ValueError on any other value so a typo in the CI input fails
    the run loudly instead of silently benchmarking the wrong configuration.

    Workflow runs are included so the default A/B against a ferment one-shot
    baseline compares like with like: that baseline runs with compaction off.
    """
    raw = os.environ.get(ENV_KIMCHI_COMPACTION, DEFAULT_KIMCHI_COMPACTION)
    choice = raw.strip().lower() or DEFAULT_KIMCHI_COMPACTION
    if choice == "auto":
        return _env_bool(ENV_KIMCHI_FERMENT_ONESHOT, False) or is_workflow_agent()
    if choice not in ("enabled", "disabled"):
        raise ValueError(
            f"{ENV_KIMCHI_COMPACTION} must be 'enabled', 'disabled' or 'auto', got {raw!r}"
        )
    return choice == "disabled"


def _build_gcs_key_prefix() -> str:
    """Build the GCS key prefix for this run. Pipeline-level (not job-level).

    All chunks in the same pipeline MUST produce the same prefix so that:
      - per-trial result.json uploads from different chunks land under a
        single, predictable prefix consumers can iterate;
      - the summary job (the sole writer of jobs.tar.gz) can locate the
        prefix from run-metadata.json without knowing which chunk it ran for.
    """
    benchmark = os.environ.get(ENV_BENCHMARK_NAME, DEFAULT_BENCHMARK_NAME)
    coding_agent = os.environ.get(ENV_CODING_AGENT, DEFAULT_CODING_AGENT)
    model_provider, model_name = parse_model()

    configuration = _derive_configuration()
    date = os.environ.get(ENV_BENCH_RUN_DATE, "")
    if not date:
        raise SystemExit(
            f"{ENV_BENCH_RUN_DATE} is required — it should be set by setup-image and "
            "passed downstream via bench.env. Without it, retried chunks would "
            "produce inconsistent GCS prefixes."
        )
    pipeline_id = os.environ.get("CI_PIPELINE_ID", "unknown")
    # Pipeline-level identifier: identical for all chunks in the same pipeline.
    # Job ID intentionally excluded — see docstring.
    run_id = f"gitlab-p{pipeline_id}"

    def sanitize(value: str) -> str:
        out = re.sub(r"[^A-Za-z0-9._-]+", "-", value)
        return out.strip("-") or "unknown"

    return (
        f"runs/"
        f"benchmark={sanitize(benchmark)}/"
        f"coding_agent={sanitize(coding_agent)}/"
        f"model_provider={sanitize(model_provider)}/"
        f"model={sanitize(model_name)}/"
        f"configuration={sanitize(configuration)}/"
        f"date={sanitize(date)}/"
        f"run={sanitize(run_id)}"
    )


def _build_checkpoint_run_prefix(run_prefix: str) -> str:
    """Project-scope checkpoints without changing the public results prefix."""
    project_id = os.environ.get("CI_PROJECT_ID", "")
    if not project_id:
        raise ValueError("CI_PROJECT_ID is required when trial checkpoints are enabled")
    safe_project_id = re.sub(r"[^A-Za-z0-9._-]+", "-", project_id).strip("-")
    if not safe_project_id:
        raise ValueError("CI_PROJECT_ID has no usable characters")
    return f"{run_prefix}/checkpoint-project={safe_project_id}"


def _write_run_metadata(
    results_dir: Path,
    selected_tasks: list[str],
    *,
    chunk_attempt_budget: int,
    llm_params: dict[str, float | int] | None = None,
    llm_per_model_params: dict[str, dict[str, float | int]] | None = None,
    thinking_level: str | None = None,
) -> None:
    """Write .benchmark/run-metadata.json if it doesn't already exist.

    All chunks share the same pipeline-level values, so whichever chunk runs
    first wins; subsequent chunks (and retries) skip idempotently.
    """
    metadata_path = Path(os.environ.get(ENV_BENCHMARK_RUN_METADATA, DEFAULT_BENCHMARK_RUN_METADATA))
    if metadata_path.exists():
        return
    metadata_path.parent.mkdir(parents=True, exist_ok=True)

    model_provider, model_name = parse_model()
    model = os.environ.get(ENV_MODEL, DEFAULT_MODEL)

    pipeline_ref = os.environ.get("CI_COMMIT_REF_NAME", "")
    pipeline_sha = os.environ.get("CI_COMMIT_SHA", "")
    pipeline_id = os.environ.get("CI_PIPELINE_ID", "unknown")
    # job_id is recorded in the metadata's gitlab section for traceability;
    # it is NOT included in run_id because run_id is pipeline-level (matches
    # _build_gcs_key_prefix). See that function for rationale.
    job_id = os.environ.get("CI_JOB_ID", "unknown")
    run_id = f"gitlab-p{pipeline_id}"

    coding_agent = os.environ.get(ENV_CODING_AGENT, DEFAULT_CODING_AGENT)
    metadata = {
        "schema_version": 1,
        "benchmark_tag": os.environ.get("BENCHMARK_TAG", ""),
        "benchmark": os.environ.get(ENV_BENCHMARK_NAME, DEFAULT_BENCHMARK_NAME),
        "coding_agent": coding_agent,
        "model": model,
        "model_provider": model_provider,
        "model_name": model_name,
        "configuration": _derive_configuration(),
        "multi_mode": coding_agent == "kimchi" and is_multi_model(model),
        "ferment": _env_bool("KIMCHI_FERMENT_ONESHOT", False),
        "compaction_disabled": _compaction_disabled(),
        "tasks_all": _env_bool(ENV_BENCH_TASKS_ALL, False),
        "selected_tasks": selected_tasks,
        "parameters": {
            "attempts": os.environ.get("BENCH_ATTEMPTS", "1"),
            "parallelism": os.environ.get("BENCH_PARALLELISM", "1"),
            "timeout_multiplier": os.environ.get("BENCH_TIMEOUT_MULTIPLIER", "1.0"),
            "retry_agent_timeout": should_retry_agent_timeout(),
            # Frozen at run creation: every later job of this run resolves
            # against this value (resolve_chunk_attempt_budget); a changed
            # job-local value is identity corruption, not a new decision.
            "chunk_attempt_budget": chunk_attempt_budget,
            "llm_params": llm_params or {},
            "llm_per_model_params": llm_per_model_params or {},
            "thinking_level": thinking_level,
        },
        "results_dir": str(results_dir),
        "runner": {
            "dataset": os.environ.get("DATASET", "terminal-bench/terminal-bench-2"),
        },
        "gcs": {
            "date": os.environ.get(ENV_BENCH_RUN_DATE, ""),
            "run_id": run_id,
            "prefix": _build_gcs_key_prefix(),
        },
        "gitlab": {
            "project_path": os.environ.get("CI_PROJECT_PATH", ""),
            "project_id": os.environ.get("CI_PROJECT_ID", ""),
            "pipeline_id": pipeline_id,
            "pipeline_url": os.environ.get("CI_PIPELINE_URL", ""),
            "pipeline_source": os.environ.get("CI_PIPELINE_SOURCE", ""),
            "job_id": job_id,
            "job_url": os.environ.get("CI_JOB_URL", ""),
            "ref": pipeline_ref,
            "ref_slug": os.environ.get("CI_COMMIT_REF_SLUG", ""),
            "commit_sha": pipeline_sha,
            "commit_short_sha": os.environ.get("CI_COMMIT_SHORT_SHA", ""),
            "target_ref": os.environ.get(ENV_BENCHMARK_TARGET_REF, ""),
            "target_commit_sha": os.environ.get("BENCHMARK_TARGET_SHA", ""),
        },
    }
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote run metadata to {metadata_path}", flush=True)


def _persist_checkpoint_run_metadata(metadata_path: Path, run_prefix: str) -> None:
    """Persist deterministic run metadata for checkpoint-only recovery.

    The per-job identifiers differ across chunk jobs, so they are removed from
    the durable copy. All chunks can then race safely to create the same two
    immutable objects: the canonical run-prefix copy and a stable lookup copy
    the summary job can locate without GitLab artifacts.
    """
    if not checkpoints_enabled():
        return
    bucket = checkpoint_bucket()
    if not bucket:
        raise ValueError(
            "BENCH_TRIAL_CHECKPOINTS=true requires BENCH_CHECKPOINT_BUCKET"
        )
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    gcs = metadata.get("gcs")
    if isinstance(gcs, dict):
        gcs["checkpoint_prefix"] = run_prefix
    # Keep the GitLab-artifact copy self-sufficient too. The summary may recover
    # this file through its best-effort artifact hydration and must then know the
    # project-scoped checkpoint namespace without downloading the lookup copy.
    metadata_path.write_text(
        json.dumps(metadata, indent=2) + "\n",
        encoding="utf-8",
    )
    gitlab = metadata.get("gitlab")
    if isinstance(gitlab, dict):
        gitlab["job_id"] = ""
        gitlab["job_url"] = ""
    data = (json.dumps(metadata, indent=2, sort_keys=True) + "\n").encode("utf-8")
    retries = checkpoint_upload_retries()
    # Compare-or-create: concurrent first-starting chunks race to create the
    # durable identity. An identical serialized run is harmless; an existing
    # copy with a different frozen chunk attempt budget is identity
    # corruption (a later job must not reinterpret a changed job-local value).
    existing = ckpt.gcs_download_object(
        bucket,
        ckpt.run_metadata_object_name(run_prefix),
    )
    if existing is not None:
        existing_metadata = json.loads(existing.decode("utf-8"))
        parameters = metadata.get("parameters")
        existing_parameters = (
            existing_metadata.get("parameters")
            if isinstance(existing_metadata, dict)
            else None
        )
        budget = parameters.get("chunk_attempt_budget") if isinstance(parameters, dict) else None
        existing_budget = (
            existing_parameters.get("chunk_attempt_budget")
            if isinstance(existing_parameters, dict)
            else None
        )
        if budget != existing_budget:
            raise ValueError(
                "durable run metadata chunk attempt budget "
                f"{existing_budget!r} does not match this job's frozen budget "
                f"{budget!r}; run identity mismatch"
            )
    ckpt.gcs_upload_bytes(
        bucket,
        ckpt.run_metadata_object_name(run_prefix),
        data,
        content_type="application/json",
        retries=retries,
    )
    ckpt.gcs_upload_bytes(
        bucket,
        ckpt.run_metadata_lookup_object_name(
            str(metadata.get("gitlab", {}).get("project_id", "")),
            str(metadata.get("gitlab", {}).get("pipeline_id", "")),
        ),
        data,
        content_type="application/json",
        retries=retries,
    )


def _metadata_chunk_attempt_budget(
    metadata: object,
    *,
    source: str,
) -> int | None:
    """Return a validated frozen budget from one run-metadata document."""
    if not isinstance(metadata, dict):
        raise ValueError(f"{source} must contain a JSON object")
    parameters = metadata.get("parameters")
    if parameters is None:
        return None
    if not isinstance(parameters, dict):
        raise ValueError(f"{source} parameters must be an object")
    budget = parameters.get("chunk_attempt_budget")
    if budget is None:
        return None
    return validate_chunk_attempt_budget(
        budget,
        source=f"{source} chunk attempt budget",
    )


def _resolve_run_chunk_attempt_budget(
    *,
    metadata_path: Path,
    run_prefix: str,
) -> int:
    """Resolve local, durable, and configured attempt-budget identity."""
    local_budget: int | None = None
    if metadata_path.is_file():
        local_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        local_budget = _metadata_chunk_attempt_budget(
            local_metadata,
            source=str(metadata_path),
        )

    durable_budget: int | None = None
    if checkpoints_enabled():
        bucket = checkpoint_bucket()
        if not bucket:
            raise ValueError(
                "BENCH_TRIAL_CHECKPOINTS=true requires BENCH_CHECKPOINT_BUCKET"
            )
        object_name = ckpt.run_metadata_object_name(run_prefix)
        durable_data = ckpt.gcs_download_object(bucket, object_name, strict=True)
        if durable_data is not None:
            try:
                durable_metadata = json.loads(durable_data.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError(
                    f"invalid durable run metadata at gs://{bucket}/{object_name}: {exc}"
                ) from exc
            durable_budget = _metadata_chunk_attempt_budget(
                durable_metadata,
                source=f"durable run metadata gs://{bucket}/{object_name}",
            )

    if (
        local_budget is not None
        and durable_budget is not None
        and local_budget != durable_budget
    ):
        raise ValueError(
            f"local chunk attempt budget {local_budget} does not match durable "
            f"run metadata budget {durable_budget}; run identity mismatch"
        )

    frozen_budget = durable_budget if durable_budget is not None else local_budget
    return resolve_chunk_attempt_budget(frozen_budget)


PASS_REWARD = 1.0
_HEARTBEAT_INTERVAL = int(os.environ.get("BENCH_HEARTBEAT_INTERVAL_SECONDS", "60"))


def _upload_trial_checkpoint(
    *,
    trial_dir: Path,
    bucket: str,
    run_prefix: str,
    chunk_index: int,
    upload_retries: int,
    base_retry_delay: float,
) -> None:
    """Archive + upload one completed trial to GCS. Raises on failure.

    Mirrors GCSCheckpointPlugin._on_trial_ended, but runs in this process
    (chunk_runner's system python) instead of inside the runner's venv, so
    redact_api_key and checkpoint are imported directly rather than through
    a scripts_dir sys.path shim. Raises on any failure so the caller can
    apply the checkpoint-failure policy.
    """
    trial_id = ckpt.trial_id_from_dir(trial_dir)
    # Prefer the exact task_name recorded by the runner; fall back to reading
    # it out of the trial id. Bare name only (strip any "source/" prefix).
    task_name = _task_name_from_result(trial_dir) or ckpt.task_from_trial_id(trial_id)
    if "/" in task_name:
        task_name = task_name.rsplit("/", 1)[-1]
    object_name = ckpt.trial_object_name(run_prefix, chunk_index, trial_id)

    secrets = [
        value.encode("utf-8")
        for value in (os.environ.get(name, "") for name in redact_api_key.REDACTED_ENV_KEYS)
        if value
    ]
    archive_bytes, payload_sha256 = ckpt.create_trial_archive(
        trial_dir,
        task_name=task_name,
        chunk_index=chunk_index,
        redact_secrets=secrets,
    )
    started = time.monotonic()
    ckpt.gcs_upload_object(
        bucket,
        object_name,
        archive_bytes,
        content_type="application/gzip",
        retries=upload_retries,
        base_delay=base_retry_delay,
    )
    print(
        f"[chunk-{chunk_index}] checkpoint_durable trial={trial_id} task={task_name} "
        f"object={object_name} sha256={payload_sha256[:12]} bytes={len(archive_bytes)} "
        f"duration_s={time.monotonic() - started:.2f}",
        flush=True,
    )


def _format_elapsed(seconds: int) -> str:
    minutes, remainder = divmod(seconds, 60)
    return f"{minutes}m{remainder:02d}s"


def _get_exception_type(result_path: Path) -> str | None:
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
        ei = result.get("exception_info") or {}
        return ei.get("exception_type") or None
    except (OSError, json.JSONDecodeError, AttributeError):
        return None


def _trial_reward(result_path: Path) -> float | None:
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
        vr = result.get("verifier_result") or {}
        rewards = vr.get("rewards") or {}
        value = rewards.get("reward")
        if value is None or isinstance(value, bool):
            return None
        return float(value)
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return None


def _print_heartbeat(
    results_dir: Path,
    elapsed: int,
    total: int,
    reported: set[str],
    chunk_index: int,
) -> None:
    trial_dirs = list_trial_dirs(results_dir)
    completed = [(p, p / "result.json") for p in trial_dirs if (p / "result.json").is_file()]
    running = sum(1 for p in trial_dirs if not (p / "result.json").is_file())
    for trial_dir, result_path in completed:
        if trial_dir.name not in reported:
            reported.add(trial_dir.name)
            reward = _trial_reward(result_path)
            reward_text = "n/a" if reward is None else f"{reward:.3f}"
            if reward == PASS_REWARD:
                print(f"[chunk-{chunk_index}] trial={trial_dir.name} reward={reward_text} passed", flush=True)
            else:
                verdict = classify(trial_dir)
                needs_retry_trial = is_retryable(
                    verdict.outcome,
                    verdict.error_category,
                    verdict.error_subcategory,
                )
                retry_label = f"will-retry({verdict.outcome})" if needs_retry_trial else "final"
                cause = verdict.error_subcategory or _get_exception_type(result_path) or verdict.outcome
                print(
                    f"[chunk-{chunk_index}] trial={trial_dir.name} reward={reward_text} FAILED"
                    f" cause={cause} {retry_label}",
                    flush=True,
                )
    rewards = [r for _, rp in completed if (r := _trial_reward(rp)) is not None]
    passed = sum(1 for r in rewards if r == PASS_REWARD)
    mean = f"{sum(rewards) / len(rewards):.3f}" if rewards else "n/a"
    print(
        f"[chunk-{chunk_index}] "
        f"elapsed={_format_elapsed(elapsed)} "
        f"total={total} "
        f"running={running} "
        f"completed={len(completed)} "
        f"passed={passed} "
        f"mean_reward={mean}",
        flush=True,
    )


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    return int(raw)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, str(default))
    return float(raw)


def _env_bool(name: str, default: bool) -> bool:
    # Delegates to the shared parser so every pipeline step agrees on what
    # counts as true/false; kept as a named alias for the many call sites here.
    return env_bool(name, default)


def _probe_docker_daemon(
    env: dict[str, str],
    *,
    timeout_seconds: float,
) -> tuple[bool, str]:
    """Run a bounded, cheap Docker daemon liveness probe."""
    try:
        completed = subprocess.run(
            ["docker", "info"],
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)
    if completed.returncode == 0:
        return True, ""
    reason = (completed.stderr or completed.stdout or "docker info failed").strip()
    return False, reason[-1000:]


def _daemon_loss_marker_path(results_dir: Path, chunk_index: int) -> Path:
    return results_dir / "docker-health" / f"chunk-{chunk_index}-daemon-loss.json"


def _record_confirmed_daemon_loss(
    *,
    results_dir: Path,
    chunk_index: int,
    failures: int,
    reason: str,
) -> Path:
    marker_path = _daemon_loss_marker_path(results_dir, chunk_index)
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    marker_path.write_text(
        json.dumps(
            {
                "event": "docker_daemon_loss_confirmed",
                "subcategory": DOCKER_DAEMON_UNREACHABLE_SUBCATEGORY,
                "marker": DOCKER_DAEMON_UNREACHABLE_MARKER,
                "consecutive_failures": failures,
                "reason": reason,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return marker_path


def _gitlab_job_elapsed_seconds(*, now: datetime | None = None) -> float:
    """Wall-clock time already consumed before this runner process started."""
    started_at = os.environ.get("CI_JOB_STARTED_AT", "")
    if not started_at:
        return 0.0
    try:
        started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        if started.tzinfo is None:
            started = started.replace(tzinfo=UTC)
    except ValueError:
        print(
            f"[chunk] ignoring invalid CI_JOB_STARTED_AT={started_at!r}",
            file=sys.stderr,
            flush=True,
        )
        return 0.0
    current = now or datetime.now(UTC)
    return max(0.0, (current - started.astimezone(UTC)).total_seconds())


OPENROUTER_PROVIDER = "openrouter"
# Agents that can route openrouter/* models: the kimchi family (via the
# openai-completions provider block), claude-code (via OpenRouter's
# Anthropic-compatible surface), and opencode (via an OpenRouter provider
# entry in the opencode config).
OPENROUTER_CAPABLE_AGENTS = frozenset({"kimchi", "kimchi-workflow", "pi", "pi-workflow", "claude-code", "opencode"})

ANTHROPIC_PROVIDER = "anthropic"
MOONSHOT_PROVIDER = "moonshotai"


@dataclass(frozen=True)
class ProviderGate:
    provider: str
    api_key_env: str
    capable_agents: frozenset[str] | None = None

    def matches(self, model: str) -> bool:
        return model.startswith(f"{self.provider}/")

    def config_error(self, model: str, coding_agent: str) -> str | None:
        if self.capable_agents is not None and coding_agent not in self.capable_agents:
            return (
                f"MODEL={model} is not supported when CODING_AGENT={coding_agent}; "
                f"supported agents: {', '.join(sorted(self.capable_agents))}"
            )
        if not os.environ.get(self.api_key_env):
            return f"{self.api_key_env} is required when MODEL={model}"
        return None


PROVIDER_GATES = (
    ProviderGate(OPENROUTER_PROVIDER, "OPENROUTER_API_KEY", OPENROUTER_CAPABLE_AGENTS),
    ProviderGate(ANTHROPIC_PROVIDER, "ANTHROPIC_API_KEY"),
    ProviderGate(MOONSHOT_PROVIDER, "MOONSHOT_API_KEY", OPENROUTER_CAPABLE_AGENTS),
)


def _provider_gate(model: str) -> ProviderGate | None:
    return next((route for route in PROVIDER_GATES if route.matches(model)), None)


def _agent_import_path(coding_agent: str) -> str:
    match coding_agent:
        case "kimchi":
            return "kimchi_agent:Kimchi"
        case "opencode":
            return "kimchi_agent:OpenCodeKimchi"
        case "claude-code":
            return "kimchi_agent:ClaudeCodeKimchi"
        case "claude-code-standard":
            return "kimchi_agent:ClaudeCodeStandard"
        case "pi":
            return "kimchi_agent:PiKimchi"
        case "kimchi-workflow":
            return "kimchi_agent:WorkflowAgent"
        case "pi-workflow":
            return "kimchi_agent:PiWorkflowAgent"
        case "cursor":
            return "kimchi_agent:CursorAgent"
        case _:
            raise SystemExit(f"Unknown CODING_AGENT: {coding_agent}")


def _chunk_meta_path(results_dir: Path, chunk_index: int) -> Path:
    """Path to the chunk-meta file for a given chunk index."""
    return results_dir / "chunk-meta" / f"chunk-{chunk_index}.json"


def _restore_prior_artifact(results_dir: Path, workspace: Path | None = None) -> bool:
    """Download and extract the previous attempt's artifact if this is a retry.

    GitLab's default `retry:` behavior starts each attempt with a fresh workspace;
    the previous attempt's artifacts are stored as a downloadable archive but
    are NOT auto-extracted into the new workspace. Without this restore, the
    new attempt sees an empty results_dir, _detect_chunk_attempt returns 1, and
    Harbor re-runs every task — including ones that already passed.

    Args:
        results_dir: The BENCHMARK_RESULTS_DIR path; used only as a sentinel
            (skip the restore if chunk-meta already exists inside it).
        workspace: Root of the extraction target. Defaults to Path.cwd(), which
            is $CI_PROJECT_DIR in production. Parameterized for testability.

    Returns True if a prior artifact was restored, False otherwise (first attempt,
    API failure, missing CI vars, or artifact already present in the workspace).
    """
    workspace = workspace or Path.cwd()
    token = os.environ.get("CI_JOB_TOKEN")
    api_url = os.environ.get("CI_API_V4_URL", "https://gitlab.com/api/v4")
    project_id = os.environ.get("CI_PROJECT_ID")
    pipeline_id = os.environ.get("CI_PIPELINE_ID")
    job_id_str = os.environ.get("CI_JOB_ID")
    job_name = os.environ.get("CI_JOB_NAME")

    if not all([token, project_id, pipeline_id, job_id_str, job_name]):
        # Not running in CI (local dev) — nothing to restore.
        return False
    try:
        current_job_id = int(job_id_str)
    except ValueError:
        return False

    # Already-restored sentinel: if chunk-meta for ANY chunk already exists,
    # the workspace is the prior attempt's artifact (or a fresh checkout that
    # somehow has it). Skip the API call.
    chunk_meta_dir = results_dir / "chunk-meta"
    if chunk_meta_dir.is_dir() and any(chunk_meta_dir.glob("chunk-*.json")):
        return False

    headers = {"JOB-TOKEN": token, "Accept": "application/json"}

    # Retry stays in the SAME pipeline. The default `GET /pipelines/:id/jobs`
    # hides prior attempts of retried jobs — only the latest attempt of each
    # name is returned. We must add `include_retried=true` to see the prior
    # (failed/succeeded) attempt alongside the currently-running retry. Job
    # IDs are monotonic, so the highest id < current_job_id is the most
    # recent prior attempt of THIS matrix child.
    print(
        f"[chunk-restart] querying all prior attempts in pipeline {pipeline_id}",
        file=sys.stderr,
        flush=True,
    )
    try:
        jobs = list_pipeline_jobs(
            api_url=api_url,
            project_id=project_id,
            pipeline_id=pipeline_id,
            headers=headers,
        )
    except (
        urllib.error.URLError,
        urllib.error.HTTPError,
        TimeoutError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValueError,
    ) as exc:
        print(f"[chunk-restart] could not list pipeline jobs: {exc}", file=sys.stderr, flush=True)
        return False

    # CI_JOB_NAME for parallel: matrix jobs includes the matrix suffix
    # (e.g. 'terminal-bench-2-chunks: [1]'), as does the API response.
    # Strip the suffix from both sides and compare bare base names, then
    # independently verify the chunk index from the API name's suffix.
    my_chunk = os.environ.get("BENCH_CHUNK_INDEX", "")
    my_base = job_name.split(":", 1)[0].strip()

    print(
        f"[chunk-restart] got {len(jobs)} job(s) in pipeline {pipeline_id}; "
        f"filtering for base_name={my_base!r} chunk={my_chunk!r} "
        f"id < {current_job_id}",
        file=sys.stderr,
        flush=True,
    )

    def _matches_prior(job: dict) -> bool:
        api_name = job.get("name", "")
        if not isinstance(api_name, str):
            return False
        api_base = api_name.split(":", 1)[0].strip()
        if api_base != my_base:
            return False
        m = re.match(r".*:\s*\[([^\]]+)\]\s*$", api_name)
        chunk_value = m.group(1).strip() if m else None
        if chunk_value != my_chunk:
            return False
        return job.get("id", 0) < current_job_id

    prior = [j for j in jobs if isinstance(j, dict) and _matches_prior(j)]
    if not prior:
        # Log the names we saw so we can debug if the filter is wrong.
        seen = sorted({j.get("name", "?") for j in jobs if isinstance(j, dict)})
        print(
            f"[chunk-restart] no prior attempts matched (current job id {current_job_id}, "
            f"base_name={my_base!r}, chunk={my_chunk!r}); "
            f"pipeline jobs by name: {seen}",
            file=sys.stderr,
            flush=True,
        )
        return False

    prior.sort(key=lambda j: j.get("id", 0), reverse=True)
    print(
        f"[chunk-restart] found {len(prior)} prior attempt(s); "
        f"trying artifacts newest-to-oldest",
        file=sys.stderr,
        flush=True,
    )

    # Phase 8: try previous attempts from newest to oldest, continuing after a
    # 404 (artifact never produced / expired / pruned). The first attempt whose
    # artifact downloads successfully is restored; older attempts are a fallback
    # for when the newest attempt timed out before uploading artifacts.
    archive_bytes: bytes | None = None
    restored_from_job_id: int | None = None
    for prior_job in prior:
        prior_job_id = prior_job["id"]
        artifact_url = f"{api_url}/projects/{project_id}/jobs/{prior_job_id}/artifacts"
        try:
            req = urllib.request.Request(artifact_url, headers=headers)
            with urllib.request.urlopen(req, timeout=120) as resp:
                candidate = resp.read()
        except urllib.error.HTTPError as exc:
            # 404 is expected for attempts that never uploaded artifacts
            # (timeout, node loss). Continue to the next older attempt rather
            # than aborting restoration.
            if exc.code == 404:
                print(
                    f"[chunk-restart] job {prior_job_id} has no artifact (404); "
                    f"trying older attempt",
                    file=sys.stderr,
                    flush=True,
                )
                continue
            print(
                f"[chunk-restart] could not download artifact from job {prior_job_id}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            continue
        except (urllib.error.URLError, TimeoutError) as exc:
            print(
                f"[chunk-restart] could not download artifact from job {prior_job_id}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            continue
        if candidate:
            archive_bytes = candidate
            restored_from_job_id = prior_job_id
            break

    if archive_bytes is None:
        print(
            f"[chunk-restart] no prior attempt had a restorable artifact "
            f"(tried {len(prior)} attempt(s))",
            file=sys.stderr,
            flush=True,
        )
        return False

    assert restored_from_job_id is not None  # narrowed: archive_bytes set only with it
    print(
        f"[chunk-restart] restored artifacts from job {restored_from_job_id}",
        file=sys.stderr,
        flush=True,
    )

    archive_path = Path("/tmp/prior_chunk_artifact.zip")
    archive_path.write_bytes(archive_bytes)
    # Extract to the workspace root. The artifact's internal layout mirrors the
    # job workspace, so 'benchmark/terminal-bench-2/jobs/...' lands where
    # chunk_runner expects to find it.
    workspace_abs = workspace.resolve()
    extracted: list[str] = []
    try:
        with zipfile.ZipFile(archive_path, "r") as zf:
            for member in zf.namelist():
                if member.endswith("/"):
                    continue
                # Pre-warm results are per-attempt (each attempt pre-warms a
                # fresh DinD daemon in before_script, before this restore)
                # and are intentionally NOT restored: keeping the prior
                # attempt's file would overwrite this attempt's fresh counts.
                # docker-retry health files ARE restored — retry counters
                # deliberately accumulate across attempts.
                if Path(member).name.startswith("pre-warm-result-chunk-"):
                    continue
                target = workspace / member
                # Block zip-slip: refuse to extract outside the workspace.
                try:
                    target.resolve().relative_to(workspace_abs)
                except ValueError:
                    print(f"[chunk-restart] skipping unsafe path in archive: {member}", file=sys.stderr, flush=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as src, target.open("wb") as dst:
                    dst.write(src.read())
                extracted.append(member)
    finally:
        archive_path.unlink(missing_ok=True)

    print(
        f"[chunk-restart] restored {len(extracted)} file(s) from prior attempt",
        file=sys.stderr,
        flush=True,
    )
    return True


def _detect_chunk_attempt(results_dir: Path, chunk_index: int) -> int | None:
    """Read the most recent chunk-meta file for this chunk and return the NEXT attempt number.

    On the first attempt, no chunk-meta exists and this returns None.
    On retries, _restore_prior_artifact() has already extracted the previous
    attempt's archive (containing chunk-meta/chunk-N.json) into the workspace,
    so this returns previous_attempt + 1.
    """
    meta_path = _chunk_meta_path(results_dir, chunk_index)
    if not meta_path.is_file():
        return None
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    attempt = data.get("chunk_attempt")
    return int(attempt) + 1 if isinstance(attempt, int) else None


def _collect_docker_health(results_dir: Path, chunk_index: int) -> dict:
    """Aggregate THIS chunk's DinD health metrics written by earlier job stages.

    Filenames are namespaced by chunk index because all chunk jobs share the
    results-dir artifact root (un-namespaced files were last-writer-wins when
    GitLab merged the parallel jobs' artifacts).

    Sources (all optional, all silently skipped when missing/corrupt):
      - docker-retry-health-chunk-<INDEX>.json — written by
        kimchi_agent.docker_retry inside harbor runs (transient daemon
        engagements, silent recoveries, exhausted budgets). Recoveries are
        the leading indicator of DinD degradation: they produce no verdicts,
        so without this they are invisible. Accumulates across retries via
        _restore_prior_artifact(); a pod-killed attempt leaves only its
        job-log DOCKER_RETRY_RECOVERED lines.
      - pre-warm-result-chunk-<INDEX>.json — written by preload_task_images.py
        in before_script (task image pre-warm pulled/failed counts),
        rewritten fresh each attempt.
    """
    health: dict = {}
    for key, filename in (
        ("retry", f"docker-retry-health-chunk-{chunk_index}.json"),
        ("prewarm", f"pre-warm-result-chunk-{chunk_index}.json"),
    ):
        path = results_dir / filename
        if not path.is_file():
            continue
        try:
            health[key] = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
    return health


def _write_chunk_meta(
    *,
    results_dir: Path,
    chunk_index: int,
    chunk_attempt: int,
    chunk_attempt_budget: int,
    exit_code: int,
    needs_retry: list[str],
    exhausted: bool = False,
    stop_reason: str | None = None,
) -> Path:
    """Write this chunk's attempt summary. Used by summary job to detect exhausted chunks."""
    meta_path = _chunk_meta_path(results_dir, chunk_index)
    if stop_reason is None and meta_path.is_file():
        try:
            previous_payload = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            previous_payload = None
        if isinstance(previous_payload, dict):
            previous_stop_reason = previous_payload.get("stop_reason")
            if isinstance(previous_stop_reason, str) and previous_stop_reason:
                stop_reason = previous_stop_reason
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "chunk_index": chunk_index,
        "chunk_attempt": chunk_attempt,
        # The frozen durable budget this run was created with. Recorded on
        # every status so summary recovery can cross-check run identity even
        # when the run metadata copy is unavailable.
        "chunk_attempt_budget": chunk_attempt_budget,
        "exit_code": exit_code,
        "needs_retry": sorted(needs_retry),
        "exhausted": exhausted,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    docker_health = _collect_docker_health(results_dir, chunk_index)
    if docker_health:
        payload["docker_health"] = docker_health
    if stop_reason is not None:
        payload["stop_reason"] = stop_reason
    meta_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return meta_path


def _persist_chunk_status(
    *,
    meta_path: Path,
    run_prefix: str,
    chunk_index: int,
) -> None:
    """Upload immutable chunk completion metadata for artifact-free summaries."""
    if not checkpoints_enabled():
        return
    bucket = checkpoint_bucket()
    if not bucket:
        raise ValueError(
            "BENCH_TRIAL_CHECKPOINTS=true requires BENCH_CHECKPOINT_BUCKET"
        )
    job_id = os.environ.get("CI_JOB_ID", "")
    if not job_id:
        raise ValueError("CI_JOB_ID is required to persist chunk status")
    ckpt.gcs_upload_bytes(
        bucket,
        ckpt.chunk_status_object_name(run_prefix, chunk_index, job_id),
        meta_path.read_bytes(),
        content_type="application/json",
        retries=checkpoint_upload_retries(),
    )


def _finalize_chunk(
    *,
    results_dir: Path,
    chunk_index: int,
    chunk_attempt: int,
    chunk_attempt_budget: int,
    exit_code: int,
    needs_retry: list[str],
    run_prefix: str,
    exhausted: bool = False,
    stop_reason: str | None = None,
) -> int:
    """Write and persist terminal chunk status, returning the effective exit code.

    Durable status publication is part of successful finalization: if it fails,
    the chunk must stay failed even when its intended result was successful.
    """
    meta_path = _write_chunk_meta(
        results_dir=results_dir,
        chunk_index=chunk_index,
        chunk_attempt=chunk_attempt,
        chunk_attempt_budget=chunk_attempt_budget,
        exit_code=exit_code,
        needs_retry=needs_retry,
        exhausted=exhausted,
        stop_reason=stop_reason,
    )
    try:
        _persist_chunk_status(
            meta_path=meta_path,
            run_prefix=run_prefix,
            chunk_index=chunk_index,
        )
    except (ckpt.CheckpointError, OSError, ValueError) as exc:
        print(
            f"[chunk-{chunk_index}] failed to persist chunk status: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return 1
    return exit_code


def _checkpoint_plugin_args(
    *,
    chunk_index: int,
    run_prefix: str,
    bench_dir: Path,
) -> CheckpointPluginArgs | None:
    """Build plugin args when checkpointing is enabled; None otherwise.

    The plugin is only attached to checkpoint-enabled CI runs so local/dev and
    shadow-off runs stay plugin-free. ``scripts_dir`` points the plugin (running
    in Harbor's venv) at the GitLab-scripts directory so it can import the
    stdlib-only ``checkpoint`` / ``redact_api_key`` modules.
    """
    if not checkpoints_enabled():
        return None
    bucket = checkpoint_bucket()
    if not bucket:
        print(
            "BENCH_TRIAL_CHECKPOINTS=true but BENCH_CHECKPOINT_BUCKET is unset; "
            "disabling checkpoint plugin",
            file=sys.stderr,
            flush=True,
        )
        return None
    return CheckpointPluginArgs(
        bucket=bucket,
        run_prefix=run_prefix,
        chunk_index=chunk_index,
        scripts_dir=bench_dir / "benchmark" / "scripts" / "gitlab",
        upload_retries=checkpoint_upload_retries(),
    )


def _restore_gcs_checkpoints(
    *,
    results_dir: Path,
    run_prefix: str,
    chunk_index: int,
) -> None:
    """Download + validate + extract per-trial GCS checkpoints for this chunk.

    Merges with whatever GitLab artifact restoration already placed on disk;
    trial-id deduplication in reconciliation resolves overlap. Logs structured
    restore counts for observability. Storage/listing failures and corrupt
    durable objects propagate so the chunk fails before spending model tokens.
    """
    if not checkpoints_enabled():
        return
    bucket = checkpoint_bucket()
    if not bucket:
        return
    result = ckpt.restore_chunk_checkpoints(
        bucket=bucket,
        run_prefix=run_prefix,
        chunk_index=chunk_index,
        dest_dir=results_dir,
    )
    print(
        f"[chunk-{chunk_index}] gcs-checkpoint-restore "
        f"restored={len(result.restored)} duplicates={result.duplicates} "
        f"corrupt={result.corrupt}",
        flush=True,
    )


def _may_launch_work(chunk_attempt: int, budget: int) -> bool:
    """True when this durable attempt ordinal may launch Harbor.

    Ordinals ``1..budget`` are work-bearing; ordinals above the budget are
    reconcile-only: they restore durable state and exit successfully when the
    restored work is complete, but never launch Harbor (the budget is a
    token fuse, not just a reconciliation flag).
    """
    return chunk_attempt <= budget


def _is_final_work_attempt(chunk_attempt: int, budget: int) -> bool:
    """True when this ordinal is the final Harbor-launching attempt.

    Attempts ``1..budget`` may launch Harbor; ``budget`` is the last one. On
    that attempt retryable infrastructure trials are treated as terminal
    (they fill pass@k slots so the task can complete with fewer than k final
    trials) and any work still incomplete afterwards is terminally exhausted
    regardless of how the attempt stopped (normal completion, soft deadline,
    Harbor failure, or confirmed daemon loss).
    """
    return chunk_attempt == budget


def _register_durable_chunk_attempt(
    *,
    run_prefix: str,
    chunk_index: int,
) -> int | None:
    """Return the GCS-backed attempt ordinal when checkpointing is enabled."""
    if not checkpoints_enabled():
        return None
    bucket = checkpoint_bucket()
    if not bucket:
        raise ValueError(
            "BENCH_TRIAL_CHECKPOINTS=true requires BENCH_CHECKPOINT_BUCKET"
        )
    return ckpt.register_chunk_attempt(
        bucket=bucket,
        run_prefix=run_prefix,
        chunk_index=chunk_index,
        job_id=os.environ.get("CI_JOB_ID", ""),
        retries=checkpoint_upload_retries(),
    )


def _run_harbor_invocation(
    *,
    tasks: list[str],
    agent_import_path: str,
    model: str,
    dataset: str,
    parallelism: int,
    attempts: int,
    timeout_multiplier: float,
    jobs_dir: Path,
    job_name: str,
    kimchi_ferment_oneshot: bool,
    kimchi_disable_compaction: bool,
    coding_agent: str,
    llm_params: dict[str, float | int],
    llm_per_model_params: dict[str, dict[str, float | int]],
    thinking_level: str | None,
    checkpoint_plugin: CheckpointPluginArgs | None,
    results_dir: Path,
    chunk_index: int,
    bench_dir: Path,
    env: dict[str, str],
    soft_deadline_monotonic: float,
) -> tuple[int, int | None]:
    """Run one Harbor invocation, honoring the soft chunk deadline.

    Returns ``(harbor_status, received_signal)``. When the soft deadline is
    reached, Harbor is terminated gracefully so in-flight checkpoint uploads
    (handled by the plugin inside the Harbor process) can finish, and the
    caller exits non-zero for a GitLab retry.
    """
    docker_health = load_docker_health_config(env)
    cmd = build_harbor_command(
        tasks=tasks,
        agent_import_path=agent_import_path,
        model=model,
        dataset=dataset,
        parallelism=parallelism,
        attempts=attempts,
        timeout_multiplier=timeout_multiplier,
        jobs_dir=jobs_dir,
        job_name=job_name,
        kimchi_ferment_oneshot=kimchi_ferment_oneshot,
        kimchi_disable_compaction=kimchi_disable_compaction,
        coding_agent=coding_agent,
        llm_params=llm_params,
        llm_per_model_params=llm_per_model_params,
        thinking_level=thinking_level,
        workflow=_selected_workflow(),
        workflow_extension=_selected_workflow_extension(),
        checkpoint_plugin=checkpoint_plugin,
    )
    print(f"[chunk-{chunk_index}] command: {format_command_for_log(cmd)}", flush=True)

    proc = run_harbor(cmd=cmd, cwd=bench_dir, env=env)
    reported_trials: set[str] = set()
    _print_heartbeat(results_dir, 0, len(tasks), reported_trials, chunk_index)

    received_signal: int | None = None
    graceful_stop_started: float | None = None
    force_stop_started: float | None = None
    drain_grace_seconds = float(
        os.environ.get("BENCH_CHECKPOINT_SHUTDOWN_GRACE_SECONDS", "300")
    )
    force_grace_seconds = 30.0

    def _request_graceful_stop(_signum: int) -> None:
        """Ask asyncio-based Harbor to cancel trials and finish END hooks."""
        nonlocal graceful_stop_started
        if graceful_stop_started is not None or proc.poll() is not None:
            return
        graceful_stop_started = time.monotonic()
        proc.send_signal(signal.SIGINT)

    def _handle_parent_signal(signum: int, _frame: object) -> None:
        nonlocal received_signal
        received_signal = signum
        _request_graceful_stop(signum)

    prev_sigint = signal.signal(signal.SIGINT, _handle_parent_signal)
    prev_sigterm = signal.signal(signal.SIGTERM, _handle_parent_signal)
    started = time.monotonic()
    next_heartbeat = started + _HEARTBEAT_INTERVAL
    poll_interval = min(5, _HEARTBEAT_INTERVAL)
    deadline_hit = False
    if docker_health.enabled:
        poll_interval = min(poll_interval, docker_health.poll_seconds)
    next_docker_health_probe = started
    consecutive_docker_failures = 0

    try:
        while proc.poll() is None:
            time.sleep(poll_interval)
            now = time.monotonic()
            if (
                docker_health.enabled
                and graceful_stop_started is None
                and proc.poll() is None
                and now >= next_docker_health_probe
            ):
                healthy, reason = _probe_docker_daemon(
                    env,
                    timeout_seconds=docker_health.probe_timeout_seconds,
                )
                if healthy:
                    consecutive_docker_failures = 0
                else:
                    consecutive_docker_failures += 1
                    print(
                        f"[chunk-{chunk_index}] Docker health probe failed "
                        f"({consecutive_docker_failures}/"
                        f"{docker_health.confirm_failures}): {reason}",
                        file=sys.stderr,
                        flush=True,
                    )
                    if consecutive_docker_failures >= docker_health.confirm_failures:
                        _record_confirmed_daemon_loss(
                            results_dir=results_dir,
                            chunk_index=chunk_index,
                            failures=consecutive_docker_failures,
                            reason=reason,
                        )
                        print(
                            f"docker_daemon_loss_confirmed chunk={chunk_index} "
                            f"failures={consecutive_docker_failures}; "
                            "interrupting Harbor for checkpoint drain",
                            file=sys.stderr,
                            flush=True,
                        )
                        _request_graceful_stop(signal.SIGINT)
                next_docker_health_probe = now + docker_health.poll_seconds
            # Phase 6 soft deadline: stop accepting new work and cooperatively
            # interrupt Harbor so trial finalizers and checkpoint END hooks can
            # drain before GitLab's hard 12h timeout kills the pod.
            if (
                now >= soft_deadline_monotonic
                and graceful_stop_started is None
                and proc.poll() is None
            ):
                print(
                    f"[chunk-{chunk_index}] soft deadline reached "
                    f"({int(now - started)}s elapsed); interrupting Harbor and "
                    f"allowing {drain_grace_seconds:.0f}s for checkpoint drain",
                    flush=True,
                )
                deadline_hit = True
                _request_graceful_stop(signal.SIGINT)
            if (
                graceful_stop_started is not None
                and force_stop_started is None
                and now - graceful_stop_started >= drain_grace_seconds
                and proc.poll() is None
            ):
                print(
                    f"[chunk-{chunk_index}] Harbor exceeded checkpoint drain "
                    "grace period; sending SIGTERM",
                    file=sys.stderr,
                    flush=True,
                )
                proc.terminate()
                force_stop_started = now
            if (
                force_stop_started is not None
                and now - force_stop_started >= force_grace_seconds
                and proc.poll() is None
            ):
                print(
                    f"[chunk-{chunk_index}] Harbor ignored SIGTERM; sending SIGKILL",
                    file=sys.stderr,
                    flush=True,
                )
                proc.kill()
            if proc.poll() is None and now >= next_heartbeat:
                _print_heartbeat(
                    results_dir, int(now - started), len(tasks), reported_trials, chunk_index
                )
                next_heartbeat = now + _HEARTBEAT_INTERVAL
    finally:
        signal.signal(signal.SIGINT, prev_sigint)
        signal.signal(signal.SIGTERM, prev_sigterm)

    harbor_status = proc.wait()
    _print_heartbeat(
        results_dir, int(time.monotonic() - started), len(tasks), reported_trials, chunk_index
    )
    tag = " (soft-deadline)" if deadline_hit else ""
    print(f"[chunk-{chunk_index}] Harbor exited with status {harbor_status}{tag}", flush=True)
    return harbor_status, received_signal


def _run_pier_invocation(
    *,
    cmd: list[str],
    bench_dir: Path,
    env: dict[str, str],
    results_dir: Path,
    chunk_index: int,
    n_tasks: int,
    checkpoint_plugin: CheckpointPluginArgs | None,
    soft_deadline_monotonic: float,
) -> tuple[int, int | None]:
    """Run one Pier invocation, honoring the soft chunk deadline.

    Pier's CLI has no ``--plugin`` support, so when checkpointing is enabled
    this parent process uploads completed trials to GCS as their result.json
    files appear. Uploads run on the heartbeat tick, same cadence as
    ``_print_heartbeat``.

    Checkpoint-failure policy matches the Harbor plugin's: a checkpoint-enabled
    run does not keep spending model tokens without durable protection. On the
    first upload failure Pier is gracefully interrupted (SIGINT), remaining
    uploads are skipped, and the returned status is forced non-zero so
    ``main()`` exits non-zero for a GitLab retry.

    Returns ``(pier_status, received_signal)``. When the soft deadline is
    reached, Pier is terminated gracefully via the same SIGINT/drain/SIGTERM/
    SIGKILL cascade as ``_run_harbor_invocation``.
    """
    docker_health = load_docker_health_config(env)
    print(f"[chunk-{chunk_index}] command: {format_command_for_log(cmd)}", flush=True)
    proc = run_pier(cmd=cmd, cwd=bench_dir, env=env)
    reported_trials: set[str] = set()
    uploaded_trial_ids: set[str] = set()
    checkpoint_unhealthy = False
    _print_heartbeat(results_dir, 0, n_tasks, reported_trials, chunk_index)

    received_signal: int | None = None
    graceful_stop_started: float | None = None
    force_stop_started: float | None = None
    drain_grace_seconds = float(
        os.environ.get("BENCH_CHECKPOINT_SHUTDOWN_GRACE_SECONDS", "300")
    )
    force_grace_seconds = 30.0

    def _request_graceful_stop() -> None:
        """Ask asyncio-based Pier to cancel trials and finish finalizers."""
        nonlocal graceful_stop_started
        if graceful_stop_started is not None or proc.poll() is not None:
            return
        graceful_stop_started = time.monotonic()
        proc.send_signal(signal.SIGINT)

    def _handle_parent_signal(signum: int, _frame: object) -> None:
        nonlocal received_signal
        received_signal = signum
        _request_graceful_stop()

    def _upload_completed_trials() -> None:
        """Upload trials whose result.json appeared since the last tick."""
        nonlocal checkpoint_unhealthy
        if checkpoint_plugin is None or checkpoint_unhealthy:
            return
        for trial_dir in list_trial_dirs(results_dir):
            if not (trial_dir / "result.json").is_file():
                continue
            trial_id = ckpt.trial_id_from_dir(trial_dir)
            if trial_id in uploaded_trial_ids:
                continue
            try:
                _upload_trial_checkpoint(
                    trial_dir=trial_dir,
                    bucket=checkpoint_plugin.bucket,
                    run_prefix=checkpoint_plugin.run_prefix,
                    chunk_index=chunk_index,
                    upload_retries=checkpoint_plugin.upload_retries,
                    base_retry_delay=checkpoint_plugin.base_retry_delay,
                )
                uploaded_trial_ids.add(trial_id)
            except ckpt.CheckpointUploadError as exc:
                # An immutability conflict (existing GCS object with a
                # different checksum) means a prior attempt already durably
                # checkpointed this trial. The existing checkpoint is still
                # valid — skip this upload and continue rather than killing
                # Pier. Only genuine upload failures (network, GCS down)
                # trigger the interrupt-Pier policy.
                if "refusing to overwrite immutable checkpoint" in str(exc):
                    uploaded_trial_ids.add(trial_id)
                    print(
                        f"[chunk-{chunk_index}] checkpoint already durable for "
                        f"{trial_dir.name} (immutability conflict); skipping upload",
                        flush=True,
                    )
                    continue
                checkpoint_unhealthy = True
                print(
                    f"[chunk-{chunk_index}] checkpoint upload failed for "
                    f"{trial_dir.name}: {exc}; interrupting Pier",
                    file=sys.stderr,
                    flush=True,
                )
                _request_graceful_stop()
                return
            except Exception as exc:
                checkpoint_unhealthy = True
                print(
                    f"[chunk-{chunk_index}] checkpoint upload failed for "
                    f"{trial_dir.name}: {exc}; interrupting Pier",
                    file=sys.stderr,
                    flush=True,
                )
                _request_graceful_stop()
                return

    prev_sigint = signal.signal(signal.SIGINT, _handle_parent_signal)
    prev_sigterm = signal.signal(signal.SIGTERM, _handle_parent_signal)
    started = time.monotonic()
    next_heartbeat = started + _HEARTBEAT_INTERVAL
    poll_interval = min(5, _HEARTBEAT_INTERVAL)
    deadline_hit = False
    if docker_health.enabled:
        poll_interval = min(poll_interval, docker_health.poll_seconds)
    next_docker_health_probe = started
    consecutive_docker_failures = 0

    try:
        while proc.poll() is None:
            time.sleep(poll_interval)
            now = time.monotonic()
            if (
                docker_health.enabled
                and graceful_stop_started is None
                and proc.poll() is None
                and now >= next_docker_health_probe
            ):
                healthy, reason = _probe_docker_daemon(
                    env,
                    timeout_seconds=docker_health.probe_timeout_seconds,
                )
                if healthy:
                    consecutive_docker_failures = 0
                else:
                    consecutive_docker_failures += 1
                    print(
                        f"[chunk-{chunk_index}] Docker health probe failed "
                        f"({consecutive_docker_failures}/"
                        f"{docker_health.confirm_failures}): {reason}",
                        file=sys.stderr,
                        flush=True,
                    )
                    if consecutive_docker_failures >= docker_health.confirm_failures:
                        _record_confirmed_daemon_loss(
                            results_dir=results_dir,
                            chunk_index=chunk_index,
                            failures=consecutive_docker_failures,
                            reason=reason,
                        )
                        print(
                            f"docker_daemon_loss_confirmed chunk={chunk_index} "
                            f"failures={consecutive_docker_failures}; "
                            "interrupting Pier for checkpoint drain",
                            file=sys.stderr,
                            flush=True,
                        )
                        _request_graceful_stop()
                next_docker_health_probe = now + docker_health.poll_seconds
            if (
                now >= soft_deadline_monotonic
                and graceful_stop_started is None
                and proc.poll() is None
            ):
                print(
                    f"[chunk-{chunk_index}] soft deadline reached "
                    f"({int(now - started)}s elapsed); interrupting Pier and "
                    f"allowing {drain_grace_seconds:.0f}s for checkpoint drain",
                    flush=True,
                )
                deadline_hit = True
                _request_graceful_stop()
            if (
                graceful_stop_started is not None
                and force_stop_started is None
                and now - graceful_stop_started >= drain_grace_seconds
                and proc.poll() is None
            ):
                print(
                    f"[chunk-{chunk_index}] Pier exceeded checkpoint drain "
                    "grace period; sending SIGTERM",
                    file=sys.stderr,
                    flush=True,
                )
                proc.terminate()
                force_stop_started = now
            if (
                force_stop_started is not None
                and now - force_stop_started >= force_grace_seconds
                and proc.poll() is None
            ):
                print(
                    f"[chunk-{chunk_index}] Pier ignored SIGTERM; sending SIGKILL",
                    file=sys.stderr,
                    flush=True,
                )
                proc.kill()
            if proc.poll() is None and now >= next_heartbeat:
                _print_heartbeat(
                    results_dir, int(now - started), n_tasks, reported_trials, chunk_index
                )
                _upload_completed_trials()
                next_heartbeat = now + _HEARTBEAT_INTERVAL
    finally:
        signal.signal(signal.SIGINT, prev_sigint)
        signal.signal(signal.SIGTERM, prev_sigterm)

    pier_status = proc.wait()
    # Final pass: upload trials that completed on exit (e.g. via the graceful
    # stop's finalizers writing result.json after the last loop tick).
    _upload_completed_trials()
    _print_heartbeat(
        results_dir, int(time.monotonic() - started), n_tasks, reported_trials, chunk_index
    )
    if checkpoint_unhealthy and pier_status == 0:
        # Trials completed but are not durable; force non-zero so the chunk
        # retries and the missing checkpoints are re-uploaded from the restored
        # GitLab artifact.
        pier_status = 1
    tag = " (soft-deadline)" if deadline_hit else ""
    print(f"[chunk-{chunk_index}] Pier exited with status {pier_status}{tag}", flush=True)
    return pier_status, received_signal


def main() -> int:
    """Entry point for the chunk runner. Returns exit code for GitLab retry."""
    process_started_monotonic = time.monotonic()
    prior_job_elapsed_seconds = _gitlab_job_elapsed_seconds()

    chunk_index = _env_int("BENCH_CHUNK_INDEX", 0)
    chunk_count = _env_int("BENCH_CHUNK_COUNT", 8)
    parallelism = _env_int("BENCH_PARALLELISM", 1)
    attempts = _env_int("BENCH_ATTEMPTS", 1)
    timeout_multiplier = _env_float("BENCH_TIMEOUT_MULTIPLIER", 1.0)
    benchmark_name = os.environ.get(
        ENV_BENCHMARK_NAME, DEFAULT_BENCHMARK_NAME
    )
    checkpointing = checkpoints_enabled()
    coding_agent = os.environ.get(ENV_CODING_AGENT, DEFAULT_CODING_AGENT)
    model = os.environ.get(ENV_MODEL, DEFAULT_MODEL)
    kimchi_ferment_oneshot = _env_bool(ENV_KIMCHI_FERMENT_ONESHOT, False)
    try:
        kimchi_disable_compaction = _compaction_disabled()
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    dataset = os.environ.get("DATASET", "terminal-bench/terminal-bench-2")
    provider_route = _provider_gate(model)
    provider_error = provider_route.config_error(model, coding_agent) if provider_route else None
    if provider_error:
        print(provider_error, file=sys.stderr)
        return 1

    # Native-provider models use their provider key instead of KIMCHI_API_KEY.
    # claude-code-standard always uses Anthropic regardless of model, while
    # cursor uses Cursor's own cloud backend.
    if coding_agent == "claude-code-standard":
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            print("ANTHROPIC_API_KEY is required for claude-code-standard", file=sys.stderr)
            return 1
    elif provider_route is not None:
        api_key = os.environ.get(provider_route.api_key_env)
    elif coding_agent == "cursor":
        api_key = os.environ.get("CURSOR_API_KEY")
        if not api_key:
            print("CURSOR_API_KEY is required for cursor", file=sys.stderr)
            return 1
    else:
        api_key = os.environ.get("KIMCHI_API_KEY")
    if checkpointing and benchmark_name == "swe-bench-pro":
        print(
            "BENCH_TRIAL_CHECKPOINTS=true is not supported for "
            "BENCHMARK_NAME=swe-bench-pro yet",
            file=sys.stderr,
        )
        return 1
    if model == MULTI_MODEL and coding_agent != "kimchi":
        print("MODEL=multi-model is only supported when CODING_AGENT=kimchi", file=sys.stderr)
        return 1
    if not api_key and provider_route is None and coding_agent not in ("claude-code-standard", "cursor"):
        print("KIMCHI_API_KEY is required", file=sys.stderr)
        return 1

    results_dir = Path(os.environ.get(ENV_BENCHMARK_RESULTS_DIR, DEFAULT_BENCHMARK_RESULTS_DIR))
    if not results_dir.is_absolute():
        results_dir = Path.cwd() / results_dir
    results_dir.mkdir(parents=True, exist_ok=True)

    bench_dir = Path.cwd()

    # GitLab's `retry:` starts each attempt with a fresh workspace. Restore the
    # previous attempt's artifact (results, chunk-meta) so we don't re-run tasks
    # that already completed on a prior attempt. See _restore_prior_artifact().
    _restore_prior_artifact(results_dir, workspace=bench_dir)

    # Phase 4: also restore durable GCS checkpoints for this chunk. Merges with
    # the GitLab artifact above; trial-id deduplication resolves overlap.
    public_run_prefix = _build_gcs_key_prefix()
    try:
        checkpoint_run_prefix = (
            _build_checkpoint_run_prefix(public_run_prefix)
            if checkpointing
            else public_run_prefix
        )
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    _restore_gcs_checkpoints(
        results_dir=results_dir,
        run_prefix=checkpoint_run_prefix,
        chunk_index=chunk_index,
    )

    tasks_all = _env_bool(ENV_BENCH_TASKS_ALL, False)
    raw_selected = os.environ.get("SELECTED_TASKS_JSON", "[]")
    if tasks_all:
        selected_tasks = _fetch_all_tasks(dataset, bench_dir=bench_dir)
    else:
        selected_tasks = json.loads(raw_selected)
        if not selected_tasks:
            selected_tasks = _fetch_all_tasks(dataset, bench_dir=bench_dir)

    # Normalise BEFORE the list is frozen into run metadata and sliced into
    # per-chunk ownership. A source-qualified name (e.g.
    # "terminal-bench/fix-git") can never be attributed to its own trial,
    # whose recorded task_name is always stripped to the bare name, so the
    # chunk would re-run an already-passing task until its attempt budget
    # drained. Membership against the dataset is validated once at pipeline
    # start by validate_task_selection.py, not here: this function must not
    # read the dataset file when an explicit selection was provided.
    selected_tasks = normalize_selected_tasks(selected_tasks)

    try:
        llm_params, llm_per_model_params = load_llm_params()
        validate_llm_params_for_model(model, llm_params)
        thinking_level = resolve_thinking_level(coding_agent)
        # thinking_level is already agent-adjusted here; claude-code effort
        # levels use the same low/high/max spelling Moonshot accepts.
        validate_thinking_level_for_model(model, thinking_level)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    metadata_path = Path(
        os.environ.get(ENV_BENCHMARK_RUN_METADATA, DEFAULT_BENCHMARK_RUN_METADATA)
    )
    # Resolve the durable chunk attempt budget BEFORE Harbor launches and
    # before the durable attempt ordinal is registered. Consult both restored
    # local metadata and its durable copy: a prior pod may have persisted the
    # latter but died before GitLab could publish the former as an artifact.
    try:
        chunk_attempt_budget = _resolve_run_chunk_attempt_budget(
            metadata_path=metadata_path,
            run_prefix=checkpoint_run_prefix,
        )
    except (ckpt.CheckpointError, ValueError, OSError, json.JSONDecodeError) as exc:
        print(
            f"[chunk-{chunk_index}] invalid chunk attempt budget: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return 1
    _write_run_metadata(
        results_dir,
        selected_tasks,
        chunk_attempt_budget=chunk_attempt_budget,
        llm_params=llm_params,
        llm_per_model_params=llm_per_model_params,
        thinking_level=thinking_level,
    )
    try:
        _persist_checkpoint_run_metadata(metadata_path, checkpoint_run_prefix)
    except (ckpt.CheckpointError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(
            f"[chunk-{chunk_index}] failed to persist checkpoint run metadata: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return 1

    expected = _expected_tasks_for_chunk(selected_tasks, chunk_index, chunk_count)

    # Determine this chunk's chunk-attempt number (1-based) by inspecting the
    # chunk-meta directory written by previous attempts. On the first attempt
    # the directory is empty / missing, so this is 1.
    try:
        durable_chunk_attempt = _register_durable_chunk_attempt(
            run_prefix=checkpoint_run_prefix,
            chunk_index=chunk_index,
        )
    except (ckpt.CheckpointError, OSError, ValueError) as exc:
        print(
            f"[chunk-{chunk_index}] failed to register durable chunk attempt: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return 1
    artifact_chunk_attempt = _detect_chunk_attempt(results_dir, chunk_index)
    chunk_attempt = durable_chunk_attempt or artifact_chunk_attempt or 1
    may_launch_work = _may_launch_work(chunk_attempt, chunk_attempt_budget)
    final_work_attempt = _is_final_work_attempt(chunk_attempt, chunk_attempt_budget)

    if not expected:
        print(f"[chunk-{chunk_index}] empty slice, nothing to do", flush=True)
        return _finalize_chunk(
            results_dir=results_dir,
            chunk_index=chunk_index,
            chunk_attempt=chunk_attempt,
            chunk_attempt_budget=chunk_attempt_budget,
            exit_code=0,
            needs_retry=[],
            run_prefix=checkpoint_run_prefix,
        )

    if not may_launch_work:
        # Above-budget startup: reconcile durable state only. Completion is
        # checked before the budget guard — a chunk that is already complete
        # exits successfully even at an ordinal above the budget. Incomplete
        # restored work is terminally exhausted WITHOUT model spend (the
        # budget is a real token fuse, not just a reconciliation flag).
        write_enriched_results(results_dir=results_dir, expected_tasks=expected)
        task_to_trials = {
            task: _all_trial_dirs_for_task(results_dir, task) for task in expected
        }
        progress = compute_chunk_progress(
            task_to_trial_dirs=task_to_trials,
            target_trials=attempts,
            retry_budget_exhausted=False,
        )
        incomplete = missing_tasks(progress)
        if incomplete:
            print(
                f"[chunk-{chunk_index}/attempt-{chunk_attempt}] above the "
                f"attempt budget {chunk_attempt_budget}; {len(incomplete)} "
                f"incomplete tasks are terminally exhausted: {incomplete}",
                flush=True,
            )
        else:
            print(
                f"[chunk-{chunk_index}/attempt-{chunk_attempt}] above the "
                f"attempt budget {chunk_attempt_budget}, but all work is "
                "already durable",
                flush=True,
            )
        return _finalize_chunk(
            results_dir=results_dir,
            chunk_index=chunk_index,
            chunk_attempt=chunk_attempt,
            chunk_attempt_budget=chunk_attempt_budget,
            exit_code=0,
            needs_retry=incomplete,
            run_prefix=checkpoint_run_prefix,
            exhausted=bool(incomplete),
        )

    # Phase 3: attach the GCS checkpoint plugin for checkpoint-enabled runs so
    # completed trials become durable as they finish.
    checkpoint_plugin = _checkpoint_plugin_args(
        chunk_index=chunk_index,
        run_prefix=checkpoint_run_prefix,
        bench_dir=bench_dir,
    )

    # Phase 6: the soft deadline is part of checkpoint protection. Without
    # durable checkpoints, preserve the benchmark's normal GitLab job timeout
    # instead of interrupting work early (notably SWE-bench Pro's 24h jobs).
    if checkpointing:
        remaining_deadline_budget = max(
            0.0,
            checkpoint_soft_deadline_seconds() - prior_job_elapsed_seconds,
        )
        soft_deadline_monotonic = (
            process_started_monotonic + remaining_deadline_budget
        )
    else:
        soft_deadline_monotonic = float("inf")

    agent_import_path = _agent_import_path(coding_agent)
    env = os.environ.copy()

    # Invoke Harbor or Pier on the missing/infra tasks
    engine_name = "Pier" if use_pier() else "Harbor"
    print(
        f"[chunk-{chunk_index}/attempt-{chunk_attempt}]"
        f" running {engine_name} on {len(expected)} tasks: {expected}",
        flush=True,
    )
    # Per-chunk job name to avoid timestamp collisions when parallel chunks
    # start within the same second. Harbor defaults the job directory name to
    # `YYYY-MM-DD__HH-MM-SS`; with 3 chunks dispatched at the same instant
    # they can collapse onto the same name and clobber each other's
    # `config.json`, `result.json`, `job.log`, `lock.json` (last writer wins).
    # Embedding the chunk index + CI_JOB_ID guarantees a unique name per chunk.
    job_name = f"chunk-{chunk_index}-{os.environ.get('CI_JOB_ID', 'local')}"

    # Phase 5: run missing work in k=1 rounds. Harbor's -k is global, so each
    # round gives every task still missing at least one trial exactly one
    # attempt. This keeps attempt accounting exact when tasks have different
    # numbers of durable trials. Rounds continue until no task is missing, the
    # soft deadline is hit, or the round cap is reached. The cap is ``attempts``
    # (one round per target slot): a task that still has missing trials after
    # that many rounds genuinely failed to produce durable final results, so
    # the chunk falls through to the failure/exhaustion path rather than
    # spinning forever on a stuck trial id.
    final_needs_retry: list[str] = []
    deadline_reached = False
    daemon_loss_confirmed = False
    harbor_failure_status: int | None = None

    if use_pier():
        # Filter to tasks still missing trials (same logic as the Harbor
        # k=1 round loop). Checkpoint restore may have already completed
        # some tasks; re-running them wastes model tokens and can trigger
        # checkpoint immutability conflicts.
        write_enriched_results(results_dir=results_dir, expected_tasks=expected)
        task_to_trials = {
            task: _all_trial_dirs_for_task(results_dir, task) for task in expected
        }
        progress = compute_chunk_progress(
            task_to_trial_dirs=task_to_trials,
            target_trials=attempts,
            retry_budget_exhausted=False,
        )
        missing = missing_tasks(progress)

        if not missing:
            print(
                f"[chunk-{chunk_index}/attempt-{chunk_attempt}] all {len(expected)} "
                "tasks already complete after checkpoint restore; skipping Pier",
                flush=True,
            )
            pier_status = 0
        else:
            print(
                f"[chunk-{chunk_index}/attempt-{chunk_attempt}]"
                f" running Pier on {len(missing)} tasks: {missing}",
                flush=True,
            )
            cmd = build_pier_command(
                tasks=missing,
                agent_import_path=agent_import_path,
                model=model,
                task_path=os.environ.get(
                    ENV_DEEP_SWE_TASKS_PATH,
                    DEFAULT_DEEP_SWE_TASKS_PATH,
                ),
                parallelism=parallelism,
                attempts=attempts,
                timeout_multiplier=timeout_multiplier,
                jobs_dir=results_dir,
                job_name=job_name,
                kimchi_ferment_oneshot=kimchi_ferment_oneshot,
                coding_agent=coding_agent,
                llm_params=llm_params,
                llm_per_model_params=llm_per_model_params,
                thinking_level=thinking_level,
                kimchi_disable_compaction=kimchi_disable_compaction,
            )
            pier_status, _received_signal = _run_pier_invocation(
                cmd=cmd,
                bench_dir=bench_dir,
                env=env,
                results_dir=results_dir,
                chunk_index=chunk_index,
                n_tasks=len(missing),
                checkpoint_plugin=checkpoint_plugin,
                soft_deadline_monotonic=soft_deadline_monotonic,
            )
        if pier_status != 0:
            harbor_failure_status = pier_status
        write_enriched_results(results_dir=results_dir, expected_tasks=expected)
        task_to_trials = {
            task: _all_trial_dirs_for_task(results_dir, task) for task in expected
        }
        progress = compute_chunk_progress(
            task_to_trial_dirs=task_to_trials,
            target_trials=attempts,
            retry_budget_exhausted=False,
        )
        final_needs_retry = missing_tasks(progress)
        if time.monotonic() >= soft_deadline_monotonic:
            deadline_reached = True
    else:
        round_num = 0
        round_cap = max(1, attempts)
        while round_num < round_cap:
            round_num += 1
            # Classify + write enriched local artifacts (preserves resume state)
            # and recompute durable progress each round so we schedule exactly the
            # missing trials.
            write_enriched_results(results_dir=results_dir, expected_tasks=expected)
            task_to_trials = {
                task: _all_trial_dirs_for_task(results_dir, task) for task in expected
            }
            progress = compute_chunk_progress(
                task_to_trial_dirs=task_to_trials,
                target_trials=attempts,
                # The current GitLab job is itself an available attempt, including
                # when it is the final allowed job. Only terminalize retryable
                # results after this job has finished scheduling its work.
                retry_budget_exhausted=False,
            )
            missing = missing_tasks(progress)
            if not missing:
                print(
                    f"[chunk-{chunk_index}/attempt-{chunk_attempt}] all {len(expected)} "
                    f"trials durable after round {round_num}",
                    flush=True,
                )
                break

            if time.monotonic() >= soft_deadline_monotonic:
                print(
                    f"[chunk-{chunk_index}] soft deadline reached before round "
                    f"{round_num}; stopping after {round_num - 1} round(s)",
                    flush=True,
                )
                deadline_reached = True
                final_needs_retry = missing
                break

            # k=1 each round so attempt accounting stays exact across tasks with
            # different durable-trial counts.
            harbor_attempts = 1
            print(
                f"[chunk-{chunk_index}/attempt-{chunk_attempt}/round-{round_num}] "
                f"running Harbor (k=1) on {len(missing)} tasks: {missing}",
                flush=True,
            )
            job_name = f"chunk-{chunk_index}-{os.environ.get('CI_JOB_ID', 'local')}-r{round_num}"
            _daemon_loss_marker_path(results_dir, chunk_index).unlink(missing_ok=True)
            harbor_status, _received_signal = _run_harbor_invocation(
                tasks=missing,
                agent_import_path=agent_import_path,
                model=model,
                dataset=dataset,
                parallelism=parallelism,
                attempts=harbor_attempts,
                timeout_multiplier=timeout_multiplier,
                jobs_dir=results_dir,
                job_name=job_name,
                kimchi_ferment_oneshot=kimchi_ferment_oneshot,
                kimchi_disable_compaction=kimchi_disable_compaction,
                coding_agent=coding_agent,
                llm_params=llm_params,
                llm_per_model_params=llm_per_model_params,
                thinking_level=thinking_level,
                checkpoint_plugin=checkpoint_plugin,
                results_dir=results_dir,
                chunk_index=chunk_index,
                bench_dir=bench_dir,
                env=env,
                soft_deadline_monotonic=soft_deadline_monotonic,
            )
            # Recompute progress after Harbor finishes this round so the loop
            # condition reflects the latest durable trials.
            write_enriched_results(results_dir=results_dir, expected_tasks=expected)
            daemon_loss_confirmed = _daemon_loss_marker_path(
                results_dir,
                chunk_index,
            ).is_file()
            if harbor_status != 0 or daemon_loss_confirmed:
                # Harbor failed (or was terminated by the soft deadline mid-round).
                # Preserve that infrastructure failure independently of local
                # reconciliation: a checkpoint hook runs after Harbor writes
                # result.json, so an upload failure can leave an apparently final
                # local trial that is not durable in GCS.
                harbor_failure_status = harbor_status or 1
                task_to_trials = {
                    task: _all_trial_dirs_for_task(results_dir, task) for task in expected
                }
                progress = compute_chunk_progress(
                    task_to_trial_dirs=task_to_trials,
                    target_trials=attempts,
                    retry_budget_exhausted=False,
                )
                final_needs_retry = missing_tasks(progress)
                if time.monotonic() >= soft_deadline_monotonic:
                    deadline_reached = True
                break

    # Final reconciliation pass over everything.
    write_enriched_results(results_dir=results_dir, expected_tasks=expected)
    task_to_trials = {
        task: _all_trial_dirs_for_task(results_dir, task) for task in expected
    }
    progress_before_exhaustion = compute_chunk_progress(
        task_to_trial_dirs=task_to_trials,
        target_trials=attempts,
        retry_budget_exhausted=False,
    )
    progress = compute_chunk_progress(
        task_to_trial_dirs=task_to_trials,
        target_trials=attempts,
        retry_budget_exhausted=final_work_attempt,
    )
    if final_work_attempt:
        # Preserve the tasks whose retryable trials fill slots only because
        # this was the final work-bearing attempt. Summary uses this durable
        # signal to distinguish legitimate exhaustion from an incomplete
        # sample.
        final_needs_retry = missing_tasks(progress_before_exhaustion)
    elif not final_needs_retry:
        final_needs_retry = missing_tasks(progress)
    chunk_complete = is_chunk_complete(progress)

    # Exit non-zero when Harbor failed, tasks are still missing with work
    # budget left, or the soft deadline fired. After the final work-bearing
    # attempt, ANY remaining incomplete work is terminally exhausted
    # regardless of the stop path (normal completion, soft deadline, Harbor
    # failure, or daemon loss): exit 0 so the summary job records that
    # terminal state and publishes the bounded partial result.
    exit_code: int
    if daemon_loss_confirmed:
        exit_code = 0 if final_work_attempt else 1
        print(
            f"[chunk-{chunk_index}] Docker daemon loss confirmed; "
            f"{len(final_needs_retry)} tasks still missing: {final_needs_retry}",
            file=sys.stderr,
            flush=True,
        )
    elif deadline_reached:
        exit_code = 0 if final_work_attempt else 1
        print(
            f"[chunk-{chunk_index}] soft deadline reached; "
            f"{len(final_needs_retry)} tasks still missing: {final_needs_retry}",
            flush=True,
        )
    elif harbor_failure_status is not None:
        harbor_suffix = (
            "; final work attempt, incomplete work is terminally exhausted"
            if final_work_attempt
            else "; refusing to treat local results as durable"
        )
        exit_code = 0 if final_work_attempt else 1
        print(
            f"[chunk-{chunk_index}] Harbor failed with status "
            f"{harbor_failure_status}{harbor_suffix}",
            file=sys.stderr,
            flush=True,
        )
    elif chunk_complete:
        exit_code = 0
        if final_work_attempt and final_needs_retry:
            # pass@k slots were filled by retryable trials on the final
            # work-bearing attempt: the tasks did not genuinely complete.
            print(
                f"[chunk-{chunk_index}] all {len(expected)} trial slots filled on the "
                f"final attempt; {len(final_needs_retry)} tasks completed only via "
                f"retry-exhaustion: {final_needs_retry}",
                flush=True,
            )
        else:
            print(
                f"[chunk-{chunk_index}] all {len(expected)} trials complete",
                flush=True,
            )
    elif final_work_attempt and final_needs_retry:
        exit_code = 0
        print(
            f"[chunk-{chunk_index}] attempt budget {chunk_attempt_budget} reached; "
            f"{len(final_needs_retry)} tasks remain incomplete: {final_needs_retry}",
            flush=True,
        )
    else:
        exit_code = 1
        print(
            f"[chunk-{chunk_index}] {len(final_needs_retry)} tasks still need retry: {final_needs_retry}",
            flush=True,
        )

    exhausted = bool(
        exit_code == 0
        and final_work_attempt
        and final_needs_retry
    )
    return _finalize_chunk(
        results_dir=results_dir,
        chunk_index=chunk_index,
        chunk_attempt=chunk_attempt,
        chunk_attempt_budget=chunk_attempt_budget,
        exit_code=exit_code,
        needs_retry=final_needs_retry,
        run_prefix=checkpoint_run_prefix,
        exhausted=exhausted,
        stop_reason=(
            DOCKER_DAEMON_UNREACHABLE_SUBCATEGORY
            if daemon_loss_confirmed
            else None
        ),
    )


if __name__ == "__main__":
    raise SystemExit(main())
