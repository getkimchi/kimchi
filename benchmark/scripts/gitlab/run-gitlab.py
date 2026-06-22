#!/usr/bin/env python3
"""Run terminal-bench in GitLab CI with the selected benchmark agent."""

from __future__ import annotations

import json
import os
import re
import shlex
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from bench_config import DEFAULT_MODEL, ENV_MODEL

PASS_REWARD = 1.0
VALID_CODING_AGENTS = ("kimchi", "opencode", "claude-code")
CLAUDE_CODE_ONLY_MODELS = frozenset({
    "kimchi-dev/claude-opus-4-6",
    "kimchi-dev/claude-sonnet-4-6",
})


def getenv(name: str, default: str) -> str:
    return os.environ.get(name, default)


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"set {name} in env")
    return value


def parse_bool(name: str, value: str) -> bool:
    match value.strip().lower():
        case "true" | "1" | "yes":
            return True
        case "false" | "0" | "no":
            return False
        case _:
            raise SystemExit(f"{name} must be true or false")


def parse_positive_seconds(name: str, value: str) -> int:
    try:
        seconds = float(value)
    except ValueError as exc:
        raise SystemExit(f"{name} must be a positive number") from exc
    if seconds <= 0:
        raise SystemExit(f"{name} must be a positive number")
    return max(1, int(seconds))


def parse_selected_tasks(value: str) -> list[str]:
    try:
        tasks = json.loads(value)
    except json.JSONDecodeError as exc:
        raise SystemExit("SELECTED_TASKS_JSON must be a JSON array of task names.") from exc
    if not isinstance(tasks, list) or not all(isinstance(task, str) for task in tasks):
        raise SystemExit("SELECTED_TASKS_JSON must be a JSON array of task names.")
    return tasks


def sanitize(value: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "-", value)
    sanitized = re.sub(r"^-+", "", sanitized)
    sanitized = re.sub(r"-+$", "", sanitized)
    return sanitized or "unknown"


def format_elapsed(seconds: int) -> str:
    minutes, remainder = divmod(seconds, 60)
    return f"{minutes}m{remainder:02d}s"


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def seconds_between(start: Any, end: Any) -> int | None:
    start_dt = parse_time(start)
    end_dt = parse_time(end)
    if start_dt is None or end_dt is None:
        return None
    seconds = int((end_dt - start_dt).total_seconds())
    return seconds if seconds >= 0 else None


def list_trial_dirs(results_dir: Path) -> list[Path]:
    if not results_dir.is_dir():
        return []

    trial_dirs: list[Path] = []
    for run_dir in sorted(path for path in results_dir.iterdir() if path.is_dir()):
        trial_dirs.extend(sorted(path for path in run_dir.iterdir() if path.is_dir() and "__" in path.name))
    return trial_dirs


def get_path(value: dict[str, Any], *keys: str) -> Any:
    current: Any = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def numeric_reward(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    try:
        return float(str(value))
    except ValueError:
        return None


def trial_result(trial_dir: Path) -> dict[str, Any]:
    try:
        result = json.loads((trial_dir / "result.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return result if isinstance(result, dict) else {}


def trial_reward(result: dict[str, Any]) -> float | None:
    return numeric_reward(get_path(result, "verifier_result", "rewards", "reward"))


def trial_time_seconds(result: dict[str, Any]) -> int | None:
    start = get_path(result, "agent_execution", "started_at")
    for end in (get_path(result, "verifier", "finished_at"), get_path(result, "agent_execution", "finished_at")):
        seconds = seconds_between(start, end)
        if seconds is not None:
            return seconds
    return None


def format_mean_reward(rewards: list[float]) -> str:
    if not rewards:
        return "n/a"
    return f"{sum(rewards) / len(rewards):.3f}"


def print_trial_completed(name: str, result: dict[str, Any]) -> None:
    reward = trial_reward(result)
    exception = get_path(result, "exception_info", "exception_type")
    if reward == PASS_REWARD:
        outcome = "passed"
    elif exception:
        outcome = f"ERROR exception={exception}"
    else:
        outcome = "FAILED"
    reward_text = "n/a" if reward is None else f"{reward:.3f}"
    duration = trial_time_seconds(result)
    time_text = format_elapsed(duration) if duration is not None else "n/a"
    print(f"[benchmark] trial={name} reward={reward_text} time={time_text} {outcome}", flush=True)


def completed_trials(results_dir: Path) -> list[tuple[Path, dict[str, Any]]]:
    return [
        (path, trial_result(path))
        for path in list_trial_dirs(results_dir)
        if (path / "result.json").is_file()
    ]


def print_benchmark_heartbeat(results_dir: Path, elapsed: int, total: str, reported: set[str]) -> None:
    trial_dirs = list_trial_dirs(results_dir)
    completed = [
        (path, trial_result(path))
        for path in trial_dirs
        if (path / "result.json").is_file()
    ]
    running = sum(1 for path in trial_dirs if not (path / "result.json").is_file())
    for path, result in completed:
        if path.name not in reported:
            reported.add(path.name)
            print_trial_completed(path.name, result)
    rewards = [reward for _, result in completed if (reward := trial_reward(result)) is not None]
    passed_trials = sum(1 for reward in rewards if reward == PASS_REWARD)

    print(
        "[benchmark] "
        f"elapsed={format_elapsed(elapsed)} "
        f"total={total} "
        f"running={running} "
        f"completed={len(completed)} "
        f"passed={passed_trials} "
        f"mean_reward={format_mean_reward(rewards)}",
        flush=True,
    )


def print_run_outcome(results_dir: Path) -> None:
    failed: list[str] = []
    errored: list[str] = []
    for path, result in completed_trials(results_dir):
        reward = trial_reward(result)
        if reward == PASS_REWARD:
            continue
        exception = get_path(result, "exception_info", "exception_type")
        if exception:
            errored.append(f"{path.name} ({exception})")
        else:
            failed.append(path.name)
    if not failed and not errored:
        print("[benchmark] all completed trials passed", flush=True)
        return
    if failed:
        print(f"[benchmark] failed trials ({len(failed)}): {', '.join(failed)}", flush=True)
    if errored:
        print(f"[benchmark] errored trials ({len(errored)}): {', '.join(errored)}", flush=True)


def format_tasks_for_log(selected_tasks: list[str]) -> str:
    if not selected_tasks:
        return "all"
    return json.dumps(selected_tasks)


def is_package_dataset(dataset: str) -> bool:
    name = dataset.split("@", 1)[0]
    return "/" in name


def resolve_package_dataset_metadata(
    *,
    dataset: str,
    bench_dir: Path,
    child_env: dict[str, str],
) -> dict[str, Any] | None:
    if not is_package_dataset(dataset):
        return None

    command = [
        "uv",
        "run",
        "--python",
        "3.14",
        "python",
        "-c",
        """
import asyncio
import json
import sys

from harbor.registry.client.package import PackageDatasetClient


async def main() -> None:
    dataset = sys.argv[1]
    if "@" not in dataset:
        dataset = f"{dataset}@latest"
    metadata = await PackageDatasetClient().get_dataset_metadata(dataset)
    print(json.dumps({"version": metadata.version, "task_count": len(metadata.task_ids)}))


asyncio.run(main())
""",
        dataset,
    ]
    print("[benchmark] resolving Harbor dataset metadata", flush=True)
    started = time.monotonic()
    result = subprocess.run(
        command,
        cwd=bench_dir,
        env=child_env,
        text=True,
        capture_output=True,
        check=False,
    )
    elapsed = format_elapsed(int(time.monotonic() - started))
    if result.returncode != 0:
        print(
            f"[benchmark] failed to resolve Harbor dataset metadata duration={elapsed}",
            flush=True,
        )
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr, flush=True)
        return None

    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        print(
            f"[benchmark] Harbor dataset metadata returned no output duration={elapsed}",
            flush=True,
        )
        return None
    try:
        metadata = json.loads(lines[-1])
    except json.JSONDecodeError:
        print(
            f"[benchmark] failed to parse Harbor dataset metadata duration={elapsed}",
            flush=True,
        )
        print(result.stdout.strip(), flush=True)
        return None

    print(
        "[benchmark] "
        f"resolved Harbor dataset metadata duration={elapsed} "
        f"version={metadata.get('version', 'unknown')} "
        f"tasks={metadata.get('task_count', 'unknown')}",
        flush=True,
    )
    return metadata


def expected_trials_for(
    *,
    selected_tasks: list[str],
    dataset_task_count: int | None,
    attempts: str,
) -> str:
    try:
        attempt_count = int(float(attempts))
    except ValueError:
        return "unknown"
    if selected_tasks:
        return str(len(selected_tasks) * attempt_count)
    if dataset_task_count is not None:
        return str(dataset_task_count * attempt_count)
    return "unknown"


def print_benchmark_configuration(
    metadata: dict[str, Any],
    *,
    heartbeat_interval: int,
    benchmark_cmd: list[str],
) -> None:
    parameters = metadata["parameters"]
    runner = metadata["runner"]
    gitlab = metadata["gitlab"]
    selected_tasks = metadata["selected_tasks"]
    coding_agent = metadata["coding_agent"]
    dataset_task_count = runner["dataset_task_count"]
    expected_trials = runner["expected_trials"]
    print(
        "[benchmark] "
        f"benchmark={metadata['benchmark']} "
        f"dataset={runner['dataset']} "
        f"agent={coding_agent} "
        f"model={metadata['model']} "
        f"configuration={metadata['configuration']}",
        flush=True,
    )
    print(
        "[benchmark] "
        f"dataset_version={runner['dataset_version'] or 'unknown'} "
        f"dataset_tasks={dataset_task_count if dataset_task_count is not None else 'unknown'} "
        f"selected_task_count={len(selected_tasks)} "
        f"expected_trials={expected_trials}",
        flush=True,
    )
    print(
        "[benchmark] "
        f"target_ref={gitlab['target_ref']} "
        f"target_sha={gitlab['target_commit_sha']} "
        f"tasks={format_tasks_for_log(selected_tasks)}",
        flush=True,
    )
    print(
        "[benchmark] "
        f"attempts={parameters['attempts']} "
        f"parallelism={parameters['parallelism']} "
        f"timeout_multiplier={parameters['timeout_multiplier']} "
        "dataset_precache=always "
        f"heartbeat_interval={heartbeat_interval}s",
        flush=True,
    )
    if coding_agent == "kimchi":
        print(
            "[benchmark] "
            f"kimchi_multi_model={str(metadata['multi_mode']).lower()} "
            f"kimchi_ferment_oneshot={str(metadata['ferment']).lower()}",
            flush=True,
        )
    if expected_trials == "unknown":
        print(
            "[benchmark] running full dataset; total is unknown until Harbor resolves it",
            flush=True,
        )
    print(f"[benchmark] command={shlex.join(benchmark_cmd)}", flush=True)


def precache_harbor_dataset(
    *,
    dataset: str,
    bench_dir: Path,
    child_env: dict[str, str],
) -> int:
    if not is_package_dataset(dataset):
        print(
            f"[benchmark] skipping Harbor dataset pre-cache: unsupported dataset={dataset}",
            flush=True,
        )
        return 0

    command = [
        "uv",
        "run",
        "--python",
        "3.14",
        "harbor",
        "dataset",
        "download",
        dataset,
        "--cache",
    ]
    print("[benchmark] pre-caching Harbor dataset before benchmark run", flush=True)
    print(f"[benchmark] pre-cache command={shlex.join(command)}", flush=True)
    started = time.monotonic()
    status = subprocess.run(command, cwd=bench_dir, env=child_env, check=False).returncode
    elapsed = format_elapsed(int(time.monotonic() - started))
    if status == 0:
        print(f"[benchmark] Harbor dataset pre-cache completed duration={elapsed}", flush=True)
    else:
        print(
            f"[benchmark] Harbor dataset pre-cache failed duration={elapsed} exit_code={status}",
            flush=True,
        )
    return status


def repo_root_for(bench_dir: Path) -> Path:
    output = subprocess.check_output(
        ["git", "-C", str(bench_dir), "rev-parse", "--show-toplevel"],
        text=True,
    )
    return Path(output.strip())


def resolve_repo_root(script_bench_dir: Path) -> Path:
    override = os.environ.get("BENCHMARK_REPO_ROOT")
    if override:
        return Path(override).resolve()
    return repo_root_for(script_bench_dir)


def validate_agent_model(coding_agent: str, model: str) -> bool:
    if coding_agent not in VALID_CODING_AGENTS:
        print(f"CODING_AGENT must be one of: {', '.join(VALID_CODING_AGENTS)}", file=sys.stderr)
        return False
    if model in CLAUDE_CODE_ONLY_MODELS and coding_agent != "claude-code":
        print(f"MODEL {model} can only be used with CODING_AGENT=claude-code", file=sys.stderr)
        return False
    return True


def build_metadata(
    *,
    benchmark: str,
    coding_agent: str,
    model: str,
    model_provider: str,
    model_name: str,
    configuration: str,
    attempts: str,
    parallelism: str,
    timeout_multiplier: str,
    results_dir: str,
    dataset: str,
    selected_tasks: list[str],
    multi_model: bool,
    ferment: bool,
) -> dict[str, Any]:
    run_date = time.strftime("%Y-%m-%d", time.gmtime())
    run_id = f"gitlab-p{getenv('CI_PIPELINE_ID', 'unknown')}-j{getenv('CI_JOB_ID', 'unknown')}"
    pipeline_ref = getenv("CI_COMMIT_REF_NAME", "")
    pipeline_sha = getenv("CI_COMMIT_SHA", "")
    target_ref = getenv("BENCHMARK_TARGET_REF", pipeline_ref)
    target_sha = getenv("BENCHMARK_TARGET_SHA", pipeline_sha)
    prefix = "/".join(
        [
            "runs",
            f"benchmark={sanitize(benchmark)}",
            f"coding_agent={sanitize(coding_agent)}",
            f"model_provider={sanitize(model_provider)}",
            f"model={sanitize(model_name)}",
            f"configuration={sanitize(configuration)}",
            f"date={sanitize(run_date)}",
            f"run={sanitize(run_id)}",
        ]
    )

    return {
        "schema_version": 1,
        "benchmark": benchmark,
        "coding_agent": coding_agent,
        "model": model,
        "model_provider": model_provider,
        "model_name": model_name,
        "configuration": configuration,
        "multi_mode": multi_model,
        "ferment": ferment,
        "selected_tasks": selected_tasks,
        "parameters": {
            "attempts": attempts,
            "parallelism": parallelism,
            "timeout_multiplier": timeout_multiplier,
        },
        "results_dir": results_dir,
        "runner": {
            "dataset": dataset,
        },
        "gcs": {
            "date": run_date,
            "run_id": run_id,
            "prefix": prefix,
        },
        "gitlab": {
            "project_path": getenv("CI_PROJECT_PATH", ""),
            "project_id": getenv("CI_PROJECT_ID", ""),
            "pipeline_id": getenv("CI_PIPELINE_ID", ""),
            "pipeline_url": getenv("CI_PIPELINE_URL", ""),
            "pipeline_source": getenv("CI_PIPELINE_SOURCE", ""),
            "job_id": getenv("CI_JOB_ID", ""),
            "job_url": getenv("CI_JOB_URL", ""),
            "ref": pipeline_ref,
            "ref_slug": getenv("CI_COMMIT_REF_SLUG", ""),
            "commit_sha": pipeline_sha,
            "commit_short_sha": getenv("CI_COMMIT_SHORT_SHA", ""),
            "target_ref": target_ref,
            "target_commit_sha": target_sha,
        },
    }


def main() -> int:
    dataset = getenv("DATASET", "terminal-bench/terminal-bench-2")
    model = getenv(ENV_MODEL, DEFAULT_MODEL)
    kimchi_multi_model = parse_bool("KIMCHI_MULTI_MODEL", getenv("KIMCHI_MULTI_MODEL", "true"))
    kimchi_ferment_oneshot = parse_bool("KIMCHI_FERMENT_ONESHOT", getenv("KIMCHI_FERMENT_ONESHOT", "false"))
    parallelism = getenv("BENCH_PARALLELISM", "1")
    attempts = getenv("BENCH_ATTEMPTS", "1")
    timeout_multiplier = getenv("BENCH_TIMEOUT_MULTIPLIER", "1")
    heartbeat_interval = parse_positive_seconds(
        "BENCH_HEARTBEAT_INTERVAL_SECONDS",
        getenv("BENCH_HEARTBEAT_INTERVAL_SECONDS", "60"),
    )
    benchmark_name = getenv("BENCHMARK_NAME", "terminal-bench-2")
    results_dir = getenv("BENCHMARK_RESULTS_DIR", "benchmark/terminal-bench-2/jobs")
    coding_agent = getenv("CODING_AGENT", "kimchi")
    selected_tasks = parse_selected_tasks(getenv("SELECTED_TASKS_JSON", "[]"))

    if not validate_agent_model(coding_agent, model):
        return 1

    require_env("KIMCHI_API_KEY")

    script_bench_dir = Path(__file__).resolve().parent.parent
    repo_root = resolve_repo_root(script_bench_dir)
    bench_dir = repo_root / "benchmark/terminal-bench-2"
    if not bench_dir.is_dir():
        print(f"Benchmark directory does not exist: {bench_dir}", file=sys.stderr)
        return 1
    child_env = os.environ.copy()

    agent_import_path: str
    effective_multi_model = False
    effective_ferment = False

    match coding_agent:
        case "kimchi":
            agent_import_path = "kimchi_agent:Kimchi"
            effective_multi_model = kimchi_multi_model
            effective_ferment = kimchi_ferment_oneshot
            kimchi_binary = child_env.get("KIMCHI_CODE_BINARY") or str(repo_root / "dist/bin/kimchi")
            child_env["KIMCHI_CODE_BINARY"] = kimchi_binary
            if not os.access(kimchi_binary, os.X_OK):
                print(f"KIMCHI_CODE_BINARY is not executable: {kimchi_binary}", file=sys.stderr)
                print("Build Kimchi before running this script.", file=sys.stderr)
                return 1
        case "opencode":
            agent_import_path = "kimchi_agent:OpenCodeKimchi"
        case "claude-code":
            agent_import_path = "kimchi_agent:ClaudeCodeKimchi"
        case _:
            print(f"CODING_AGENT must be one of: {', '.join(VALID_CODING_AGENTS)}", file=sys.stderr)
            return 1

    task_args: list[str] = []
    for task in selected_tasks:
        task_args.extend(["-i", task if "/" in task else f"terminal-bench/{task}"])

    agent_args: list[str] = []
    if coding_agent == "kimchi" and effective_multi_model:
        agent_args.extend(["--agent-kwarg", "multi-model=true"])
    if coding_agent == "kimchi" and effective_ferment:
        agent_args.extend(["--agent-kwarg", "ferment-oneshot=true"])
    if coding_agent == "opencode" and child_env.get("OPENCODE_VERSION"):
        agent_args.extend(["--agent-kwarg", f"version={child_env['OPENCODE_VERSION']}"])
    if coding_agent == "claude-code" and child_env.get("CLAUDE_CODE_VERSION"):
        agent_args.extend(["--agent-kwarg", f"version={child_env['CLAUDE_CODE_VERSION']}"])

    retry_args: list[str] = []
    if coding_agent == "claude-code":
        retry_args.extend([
            "--max-retries",
            child_env.get("CLAUDE_CODE_API_MAX_RETRIES", "2"),
            "--retry-include",
            "RetryableApiError",
        ])

    model_provider = "unknown"
    model_name = model
    if "/" in model:
        model_provider, model_name = model.split("/", 1)

    configuration = "default"
    if coding_agent == "kimchi":
        match (effective_multi_model, effective_ferment):
            case (True, True):
                configuration = "multi-mode-ferment"
            case (True, False):
                configuration = "multi-mode"
            case (False, True):
                configuration = "single-model-ferment"
            case (False, False):
                configuration = "single-model"

    results_dir_abs = Path(results_dir)
    if not results_dir_abs.is_absolute():
        results_dir_abs = repo_root / results_dir

    dataset_metadata = resolve_package_dataset_metadata(
        dataset=dataset,
        bench_dir=bench_dir,
        child_env=child_env,
    )
    dataset_version = str(dataset_metadata["version"]) if dataset_metadata and "version" in dataset_metadata else None
    dataset_task_count = None
    if dataset_metadata and isinstance(dataset_metadata.get("task_count"), int):
        dataset_task_count = dataset_metadata["task_count"]
    expected_trials = expected_trials_for(
        selected_tasks=selected_tasks,
        dataset_task_count=dataset_task_count,
        attempts=attempts,
    )

    metadata_path = Path(getenv("BENCHMARK_RUN_METADATA", str(repo_root / ".benchmark/run-metadata.json")))
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata = build_metadata(
        benchmark=benchmark_name,
        coding_agent=coding_agent,
        model=model,
        model_provider=model_provider,
        model_name=model_name,
        configuration=configuration,
        attempts=attempts,
        parallelism=parallelism,
        timeout_multiplier=timeout_multiplier,
        results_dir=results_dir,
        dataset=dataset,
        selected_tasks=selected_tasks,
        multi_model=effective_multi_model,
        ferment=effective_ferment,
    )
    metadata["runner"]["dataset_version"] = dataset_version
    metadata["runner"]["dataset_task_count"] = dataset_task_count
    metadata["runner"]["expected_trials"] = expected_trials
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Wrote benchmark run metadata to {metadata_path}", flush=True)

    benchmark_cmd = [
        "uv",
        "run",
        "--python",
        "3.14",
        "harbor",
        "run",
        "--agent-import-path",
        agent_import_path,
        "--env",
        "docker",
        "--model",
        model,
        *retry_args,
        "-d",
        dataset,
        "-n",
        parallelism,
        "-k",
        attempts,
        "--timeout-multiplier",
        timeout_multiplier,
        *agent_args,
        *task_args,
    ]

    print_benchmark_configuration(
        metadata,
        heartbeat_interval=heartbeat_interval,
        benchmark_cmd=benchmark_cmd,
    )
    precache_status = precache_harbor_dataset(
        dataset=dataset,
        bench_dir=bench_dir,
        child_env=child_env,
    )
    if precache_status != 0:
        return precache_status

    reported_trials: set[str] = set()
    print_benchmark_heartbeat(results_dir_abs, 0, expected_trials, reported_trials)
    print("[benchmark] launching Harbor", flush=True)

    process = subprocess.Popen(benchmark_cmd, cwd=bench_dir, env=child_env)
    received_signal: int | None = None

    def terminate(signum: int, _frame: object) -> None:
        nonlocal received_signal
        received_signal = signum
        if process.poll() is None:
            process.terminate()

    previous_sigint = signal.signal(signal.SIGINT, terminate)
    previous_sigterm = signal.signal(signal.SIGTERM, terminate)
    started = time.monotonic()
    next_heartbeat = started + heartbeat_interval
    poll_interval = min(5, heartbeat_interval)

    try:
        while process.poll() is None:
            time.sleep(poll_interval)
            now = time.monotonic()
            if process.poll() is None and now >= next_heartbeat:
                print_benchmark_heartbeat(results_dir_abs, int(now - started), expected_trials, reported_trials)
                next_heartbeat = now + heartbeat_interval
    finally:
        signal.signal(signal.SIGINT, previous_sigint)
        signal.signal(signal.SIGTERM, previous_sigterm)

    status = process.wait()
    print_benchmark_heartbeat(results_dir_abs, int(time.monotonic() - started), expected_trials, reported_trials)
    print_run_outcome(results_dir_abs)
    if received_signal is not None:
        return 128 + received_signal
    return status


if __name__ == "__main__":
    raise SystemExit(main())
