"""Pier subprocess management — builds and invokes `pier run` commands.

Pier is a Harbor fork used for DeepSWE tasks that require pre_artifacts.sh
(patch extraction for separate verifier) and per-agent network allowlists
for air-gapped tasks. Produces the same result.json schema as Harbor, so
classify.py and summarize_results.py work unchanged.

Shared by chunk_runner.py so it can be unit-tested independently of Pier.
Pure-function command construction plus a thin subprocess wrapper.
"""

from __future__ import annotations

import base64
import json
import shlex
import subprocess
from pathlib import Path
from typing import Any


def build_pier_command(
    *,
    tasks: list[str],
    agent_import_path: str,
    model: str,
    task_path: str,
    parallelism: int,
    attempts: int,
    timeout_multiplier: float,
    jobs_dir: str | Path | None = None,
    job_name: str | None = None,
    kimchi_ferment_oneshot: bool = False,
    coding_agent: str = "kimchi",
    llm_params: dict[str, Any] | None = None,
    llm_per_model_params: dict[str, dict[str, Any]] | None = None,
) -> list[str]:
    """Build the `pier run` command as a list of args (suitable for subprocess).

    Mirrors harbor_runner.build_harbor_command() but uses `pier run` with `-p`
    (local path) instead of `harbor run` with `-d` (registry dataset).
    DeepSWE tasks are local directories cloned from GitHub, so no task prefix
    is needed — task names are passed as-is to `-i`.
    """
    cmd = [
        "uv", "run", "--project", "benchmark/terminal-bench-2",
        "--python", "3.14", "pier", "run",
        "--agent-import-path", agent_import_path,
        "--env", "docker",
        "--model", model,
        "-p", task_path,
        "-n", str(parallelism),
        "-k", str(attempts),
        "--timeout-multiplier", str(timeout_multiplier),
    ]
    if jobs_dir is not None:
        cmd.extend(["--jobs-dir", str(jobs_dir)])
    if job_name is not None:
        cmd.extend(["--job-name", job_name])

    if coding_agent == "kimchi" and kimchi_ferment_oneshot:
        cmd.extend(["--agent-kwarg", "ferment-oneshot=true"])

    if coding_agent == "kimchi":
        encoded_params = _encode_agent_kwargs(llm_params)
        if encoded_params:
            cmd.extend(["--agent-kwarg", f"llm-params={encoded_params}"])
        encoded_per_model = _encode_agent_kwargs(llm_per_model_params)
        if encoded_per_model:
            cmd.extend(["--agent-kwarg", f"llm-per-model-params={encoded_per_model}"])

    # DeepSWE tasks are local directories — no prefix needed (unlike
    # terminal-bench which gets "terminal-bench/" prepended).
    for task in tasks:
        cmd.extend(["-i", task])

    return cmd


def run_pier(
    *,
    cmd: list[str],
    cwd: Path,
    env: dict[str, str],
) -> subprocess.Popen:
    """Start Pier as a subprocess and return the handle."""
    return subprocess.Popen(cmd, cwd=str(cwd), env=env)


def format_command_for_log(cmd: list[str]) -> str:
    """Format a command for human-readable log output."""
    return shlex.join(cmd)


def _encode_agent_kwargs(value: dict[str, Any] | None) -> str | None:
    """Base64-encode a dict for passing as a Pier --agent-kwarg value."""
    if not value:
        return None
    return base64.urlsafe_b64encode(json.dumps(value).encode("utf-8")).decode("ascii").rstrip("=")


__all__ = ["build_pier_command", "format_command_for_log", "run_pier"]
