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
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

from bench_config import (
    DEFAULT_BENCHMARK_NAME,
    DEFAULT_BENCHMARK_RESULTS_DIR,
    DEFAULT_BENCHMARK_RUN_METADATA,
    DEFAULT_CODING_AGENT,
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
    ENV_KIMCHI_COMPACTION,
    ENV_KIMCHI_FERMENT_ONESHOT,
    ENV_MODEL,
    ENV_WORKFLOW,
    ENV_WORKFLOW_EXTENSION,
    MULTI_MODEL,
    is_multi_model,
    is_retryable,
    is_workflow_agent,
    load_llm_params,
    parse_model,
    should_retry_agent_timeout,
)
from chunk_slicing import slice_tasks
from classify import classify
from harbor_runner import build_harbor_command, format_command_for_log, run_harbor
from outcome import Outcome

# Directory containing static per-dataset task lists (JSON arrays of task name strings).
# These are committed to git to avoid flaky Harbor CLI calls at runtime.
_DATASETS_DIR = Path(__file__).parent / "datasets"

# Maps Harbor dataset slugs to static file basenames.
_DATASET_FILE_MAP: dict[str, str] = {
    "terminal-bench/terminal-bench-2": "terminal-bench-2.json",
    "terminal-bench/terminal-bench-2-1": "terminal-bench-2-1.json",
    "swebenchpro": "swebenchpro.json",
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
    matches: list[Path] = []
    for run_dir in results_dir.iterdir():
        if not run_dir.is_dir():
            continue
        for trial_dir in run_dir.iterdir():
            if not (trial_dir.is_dir() and "__" in trial_dir.name):
                continue
            recorded_task_name = _task_name_from_result(trial_dir)
            if recorded_task_name is not None:
                # Authoritative path: exact match against Harbor's own record.
                if recorded_task_name == task_name:
                    matches.append(trial_dir)
                continue
            # Fallback path: no readable task_name (e.g. trial crashed before
            # result.json was written). Directory name starts with
            # `{task_name}__` for short (untruncated) names.
            if trial_dir.name.startswith(f"{task_name}__"):
                matches.append(trial_dir)
                continue
            # Last resort: Harbor truncated the task name. The trial dir name
            # is `{truncated_prefix}__{suffix}`. Check if the full task name
            # starts with the truncated prefix. This can still collide across
            # tasks sharing a prefix, but only applies when we have no
            # authoritative task_name to compare against.
            prefix = trial_dir.name.rsplit("__", 1)[0]
            if task_name.startswith(prefix):
                matches.append(trial_dir)
    return sorted(matches, key=lambda p: p.name)


def process_trial_results(
    *,
    results_dir: Path,
    expected_tasks: list[str],
) -> tuple[list[str], dict[str, int]]:
    """Classify each trial and write enriched results to the local workspace.

    `expected_tasks` is a list of BARE task names (e.g. ['task-a', 'task-b']).

    Returns:
        needs_retry: bare task names that need retry (have retryable trials
            and no passing trial).
        retry_counts: {task_name: count} — number of retryable trials per
            task. Only includes tasks in needs_retry. Tasks with no trials
            at all get retry_counts[task] = 1.

    No GCS uploads happen here. The summary job tars the entire
    `BENCHMARK_RESULTS_DIR` (including this chunk's slice under
    `jobs/run-N/task__attempt/`) into `jobs.tar.gz` after all chunks finish
    and uploads that as the single source of truth. Per-trial uploads would
    be redundant and a transient GCS failure previously triggered unnecessary
    Harbor re-runs via this function's needs_retry signal.
    """
    needs_retry: list[str] = []
    retry_counts: dict[str, int] = {}

    for task_name in expected_tasks:
        trial_dirs = _all_trial_dirs_for_task(results_dir, task_name)

        if not trial_dirs:
            needs_retry.append(task_name)
            retry_counts[task_name] = 1
            continue

        retryable_count = 0
        has_pass = False
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

            if verdict.outcome == Outcome.SCORED_PASS:
                has_pass = True
            elif is_retryable(
                verdict.outcome,
                verdict.error_category,
                verdict.error_subcategory,
            ):
                retryable_count += 1

        if has_pass:
            continue
        if retryable_count > 0:
            needs_retry.append(task_name)
            retry_counts[task_name] = retryable_count

    return needs_retry, retry_counts


__all__ = [
    "_all_trial_dirs_for_task",
    "_build_gcs_key_prefix",
    "_detect_chunk_attempt",
    "_expected_tasks_for_chunk",
    "_write_chunk_meta",
    "list_trial_dirs",
    "main",
    "process_trial_results",
    "run_id_from_chunk_attempt",
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


def _write_run_metadata(
    results_dir: Path,
    selected_tasks: list[str],
    *,
    llm_params: dict[str, float | int] | None = None,
    llm_per_model_params: dict[str, dict[str, float | int]] | None = None,
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
            "llm_params": llm_params or {},
            "llm_per_model_params": llm_per_model_params or {},
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


PASS_REWARD = 1.0
_HEARTBEAT_INTERVAL = int(os.environ.get("BENCH_HEARTBEAT_INTERVAL_SECONDS", "60"))


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
    raw = os.environ.get(name, str(default)).strip().lower()
    if raw in ("true", "1", "yes"):
        return True
    if raw in ("false", "0", "no"):
        return False
    return default


def _agent_import_path(coding_agent: str) -> str:
    match coding_agent:
        case "kimchi":
            return "kimchi_agent:Kimchi"
        case "opencode":
            return "kimchi_agent:OpenCodeKimchi"
        case "claude-code":
            return "kimchi_agent:ClaudeCodeKimchi"
        case "pi":
            return "kimchi_agent:PiKimchi"
        case "kimchi-workflow":
            return "kimchi_agent:WorkflowAgent"
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
    list_url = f"{api_url}/projects/{project_id}/pipelines/{pipeline_id}/jobs?include_retried=true"
    print(f"[chunk-restart] querying prior attempts: {list_url}", file=sys.stderr, flush=True)
    try:
        req = urllib.request.Request(list_url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp:
            jobs = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"[chunk-restart] could not list pipeline jobs: {exc}", file=sys.stderr, flush=True)
        return False
    if not isinstance(jobs, list):
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
    prior_job_id = prior[0]["id"]
    print(
        f"[chunk-restart] found {len(prior)} prior attempt(s); restoring artifacts from job {prior_job_id}",
        file=sys.stderr,
        flush=True,
    )

    artifact_url = f"{api_url}/projects/{project_id}/jobs/{prior_job_id}/artifacts"
    try:
        req = urllib.request.Request(artifact_url, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as resp:
            archive_bytes = resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
        print(f"[chunk-restart] could not download artifact: {exc}", file=sys.stderr, flush=True)
        return False

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


def _write_chunk_meta(
    *,
    results_dir: Path,
    chunk_index: int,
    chunk_attempt: int,
    exit_code: int,
    needs_retry: list[str],
) -> None:
    """Write this chunk's attempt summary. Used by summary job to detect exhausted chunks."""
    meta_path = _chunk_meta_path(results_dir, chunk_index)
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "chunk_index": chunk_index,
        "chunk_attempt": chunk_attempt,
        "exit_code": exit_code,
        "needs_retry": sorted(needs_retry),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    meta_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    """Entry point for the chunk runner. Returns exit code for GitLab retry."""
    chunk_index = _env_int("BENCH_CHUNK_INDEX", 0)
    chunk_count = _env_int("BENCH_CHUNK_COUNT", 8)
    parallelism = _env_int("BENCH_PARALLELISM", 1)
    attempts = _env_int("BENCH_ATTEMPTS", 1)
    timeout_multiplier = _env_float("BENCH_TIMEOUT_MULTIPLIER", 1.0)
    coding_agent = os.environ.get(ENV_CODING_AGENT, DEFAULT_CODING_AGENT)
    model = os.environ.get(ENV_MODEL, DEFAULT_MODEL)
    kimchi_ferment_oneshot = _env_bool(ENV_KIMCHI_FERMENT_ONESHOT, False)
    try:
        kimchi_disable_compaction = _compaction_disabled()
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    dataset = os.environ.get("DATASET", "terminal-bench/terminal-bench-2")
    api_key = os.environ.get("KIMCHI_API_KEY")
    if model == MULTI_MODEL and coding_agent != "kimchi":
        print("MODEL=multi-model is only supported when CODING_AGENT=kimchi", file=sys.stderr)
        return 1
    if not api_key:
        print("KIMCHI_API_KEY is required", file=sys.stderr)
        return 1

    results_dir = Path(os.environ.get(ENV_BENCHMARK_RESULTS_DIR, DEFAULT_BENCHMARK_RESULTS_DIR))
    if not results_dir.is_absolute():
        results_dir = Path.cwd() / results_dir
    results_dir.mkdir(parents=True, exist_ok=True)

    # GitLab's `retry:` starts each attempt with a fresh workspace. Restore the
    # previous attempt's artifact (results, chunk-meta) so we don't re-run tasks
    # that already completed on a prior attempt. See _restore_prior_artifact().
    _restore_prior_artifact(results_dir, workspace=Path.cwd())

    tasks_all = _env_bool(ENV_BENCH_TASKS_ALL, False)
    raw_selected = os.environ.get("SELECTED_TASKS_JSON", "[]")
    if tasks_all:
        selected_tasks = _fetch_all_tasks(dataset, bench_dir=Path.cwd())
    else:
        selected_tasks = json.loads(raw_selected)
        if not selected_tasks:
            selected_tasks = _fetch_all_tasks(dataset, bench_dir=Path.cwd())

    llm_params, llm_per_model_params = load_llm_params()
    _write_run_metadata(
        results_dir,
        selected_tasks,
        llm_params=llm_params,
        llm_per_model_params=llm_per_model_params,
    )

    expected = _expected_tasks_for_chunk(selected_tasks, chunk_index, chunk_count)

    # Determine this chunk's chunk-attempt number (1-based) by inspecting the
    # chunk-meta directory written by previous attempts. On the first attempt
    # the directory is empty / missing, so this is 1.
    chunk_attempt = _detect_chunk_attempt(results_dir, chunk_index) or 1

    if not expected:
        print(f"[chunk-{chunk_index}] empty slice, nothing to do", flush=True)
        _write_chunk_meta(
            results_dir=results_dir,
            chunk_index=chunk_index,
            chunk_attempt=chunk_attempt,
            exit_code=0,
            needs_retry=[],
        )
        return 0


    needs_retry, retry_counts = process_trial_results(
        results_dir=results_dir,
        expected_tasks=expected,
    )

    if not needs_retry:
        print(f"[chunk-{chunk_index}] all {len(expected)} trials already final", flush=True)
        _write_chunk_meta(
            results_dir=results_dir,
            chunk_index=chunk_index,
            chunk_attempt=chunk_attempt,
            exit_code=0,
            needs_retry=[],
        )
        return 0

    # Invoke Harbor on the missing/infra tasks
    print(
        f"[chunk-{chunk_index}/attempt-{chunk_attempt}] running Harbor on {len(needs_retry)} tasks: {needs_retry}",
        flush=True,
    )
    # Per-chunk job name to avoid timestamp collisions when parallel chunks
    # start within the same second. Harbor defaults the job directory name to
    # `YYYY-MM-DD__HH-MM-SS`; with 3 chunks dispatched at the same instant
    # they can collapse onto the same name and clobber each other's
    # `config.json`, `result.json`, `job.log`, `lock.json` (last writer wins).
    # Embedding the chunk index + CI_JOB_ID guarantees a unique name per chunk.
    job_name = f"chunk-{chunk_index}-{os.environ.get('CI_JOB_ID', 'local')}"
    # On the first attempt (chunk_attempt == 1), use the full BENCH_ATTEMPTS
    # since all tasks are running fresh. On retries, use the max retryable
    # count across all retry tasks — Harbor's -k is global (not per-task), so
    # tasks with fewer infra errors get extra trial dirs. This is harmless:
    # compute_leaderboard_score.py filters infra-error trials and caps at
    # expected_attempts.
    harbor_attempts = attempts if chunk_attempt == 1 else (max(retry_counts.values()) if retry_counts else attempts)
    cmd = build_harbor_command(
        tasks=needs_retry,
        agent_import_path=_agent_import_path(coding_agent),
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
        workflow=_selected_workflow(),
        workflow_extension=_selected_workflow_extension(),
    )
    print(f"[chunk-{chunk_index}] command: {format_command_for_log(cmd)}", flush=True)

    bench_dir = Path.cwd()
    env = os.environ.copy()
    proc = run_harbor(cmd=cmd, cwd=bench_dir, env=env)

    reported_trials: set[str] = set()
    _print_heartbeat(results_dir, 0, len(needs_retry), reported_trials, chunk_index)

    received_signal: int | None = None

    def _terminate(signum: int, _frame: object) -> None:
        nonlocal received_signal
        received_signal = signum
        if proc.poll() is None:
            proc.terminate()

    prev_sigint = signal.signal(signal.SIGINT, _terminate)
    prev_sigterm = signal.signal(signal.SIGTERM, _terminate)
    started = time.monotonic()
    next_heartbeat = started + _HEARTBEAT_INTERVAL
    poll_interval = min(5, _HEARTBEAT_INTERVAL)

    try:
        while proc.poll() is None:
            time.sleep(poll_interval)
            now = time.monotonic()
            if proc.poll() is None and now >= next_heartbeat:
                _print_heartbeat(
                    results_dir, int(now - started), len(needs_retry), reported_trials, chunk_index
                )
                next_heartbeat = now + _HEARTBEAT_INTERVAL
    finally:
        signal.signal(signal.SIGINT, prev_sigint)
        signal.signal(signal.SIGTERM, prev_sigterm)

    harbor_status = proc.wait()
    _print_heartbeat(
        results_dir, int(time.monotonic() - started), len(needs_retry), reported_trials, chunk_index
    )
    print(f"[chunk-{chunk_index}] Harbor exited with status {harbor_status}", flush=True)

    # Second pass: classify what Harbor produced
    final_needs_retry, _ = process_trial_results(
        results_dir=results_dir,
        expected_tasks=expected,
    )

    exit_code = 0 if not final_needs_retry else 1
    _write_chunk_meta(
        results_dir=results_dir,
        chunk_index=chunk_index,
        chunk_attempt=chunk_attempt,
        exit_code=exit_code,
        needs_retry=final_needs_retry,
    )

    if final_needs_retry:
        print(
            f"[chunk-{chunk_index}] {len(final_needs_retry)} tasks still need retry: {final_needs_retry}",
            flush=True,
        )
        return 1

    print(f"[chunk-{chunk_index}] all {len(expected)} trials complete", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
