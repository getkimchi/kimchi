"""Harbor subprocess management — builds and invokes `harbor run` commands.

Shared by chunk_runner.py so it can be unit-tested independently of Harbor.
Pure-function command construction plus a thin subprocess wrapper.
"""

from __future__ import annotations

import base64
import json
import shlex
import subprocess
from pathlib import Path
from typing import Any


def _resolve_task_arg(task: str, dataset: str) -> str:
    """Resolve a bare task name to the Harbor -i argument.

    Terminal-bench tasks need the "terminal-bench/" prefix when bare.
    All other datasets pass task names as-is.
    """
    if "/" in task:
        return task
    if dataset.startswith("terminal-bench"):
        return f"terminal-bench/{task}"
    return task


def build_harbor_command(
    *,
    tasks: list[str],
    agent_import_path: str,
    model: str,
    dataset: str,
    parallelism: int,
    attempts: int,
    timeout_multiplier: float,
    jobs_dir: str | Path | None = None,
    job_name: str | None = None,
    kimchi_ferment_oneshot: bool = False,
    claude_code_api_max_retries: int = 0,
    coding_agent: str = "kimchi",
    opencode_version: str | None = None,
    claude_code_version: str | None = None,
    llm_params: dict[str, Any] | None = None,
    llm_per_model_params: dict[str, dict[str, Any]] | None = None,
) -> list[str]:
    """Build the `harbor run` command as a list of args (suitable for subprocess)."""
    cmd = [
        "uv", "run", "--project", "benchmark/terminal-bench-2",
        "--python", "3.14", "harbor", "run",
        "--agent-import-path", agent_import_path,
        "--env", "docker",
        "--model", model,
        "-d", dataset,
        "-n", str(parallelism),
        "-k", str(attempts),
        "--timeout-multiplier", str(timeout_multiplier),
    ]
    if jobs_dir is not None:
        cmd.extend(["--jobs-dir", str(jobs_dir)])
    if job_name is not None:
        cmd.extend(["--job-name", job_name])

    if coding_agent == "claude-code" and claude_code_api_max_retries > 0:
        cmd.extend([
            "--max-retries", str(claude_code_api_max_retries),
            "--retry-include", "RetryableApiError",
        ])

    if coding_agent == "kimchi" and kimchi_ferment_oneshot:
        cmd.extend(["--agent-kwarg", "ferment-oneshot=true"])

    if coding_agent == "kimchi":
        encoded_params = _encode_agent_kwargs(llm_params)
        if encoded_params:
            cmd.extend(["--agent-kwarg", f"llm-params={encoded_params}"])
        encoded_per_model = _encode_agent_kwargs(llm_per_model_params)
        if encoded_per_model:
            cmd.extend(["--agent-kwarg", f"llm-per-model-params={encoded_per_model}"])

    if coding_agent == "opencode" and opencode_version:
        cmd.extend(["--agent-kwarg", f"version={opencode_version}"])
    if coding_agent == "claude-code" and claude_code_version:
        cmd.extend(["--agent-kwarg", f"version={claude_code_version}"])

    for task in tasks:
        task_arg = _resolve_task_arg(task, dataset)
        cmd.extend(["-i", task_arg])

    return cmd


def run_harbor(
    *,
    cmd: list[str],
    cwd: Path,
    env: dict[str, str],
) -> subprocess.Popen:
    """Start Harbor as a subprocess and return the handle."""
    return subprocess.Popen(cmd, cwd=str(cwd), env=env)


def format_command_for_log(cmd: list[str]) -> str:
    """Format a command for human-readable log output."""
    return shlex.join(cmd)


def _encode_agent_kwargs(value: dict[str, Any] | None) -> str | None:
    """Base64-encode a dict for passing as a Harbor --agent-kwarg value."""
    if not value:
        return None
    return base64.urlsafe_b64encode(json.dumps(value).encode("utf-8")).decode("ascii").rstrip("=")


__all__ = ["build_harbor_command", "format_command_for_log", "run_harbor"]
