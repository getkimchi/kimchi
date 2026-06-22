"""Harbor subprocess management — builds and invokes `harbor run` commands.

Extracted from run-gitlab.py so it can be unit-tested and reused by
chunk_runner.py. Pure-function command construction plus a thin subprocess
wrapper.
"""

from __future__ import annotations

import shlex
import subprocess
from pathlib import Path


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
    kimchi_multi_model: bool = False,
    kimchi_ferment_oneshot: bool = False,
    claude_code_api_max_retries: int = 0,
    coding_agent: str = "kimchi",
    opencode_version: str | None = None,
    claude_code_version: str | None = None,
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

    if coding_agent == "claude-code" and claude_code_api_max_retries > 0:
        cmd.extend([
            "--max-retries", str(claude_code_api_max_retries),
            "--retry-include", "RetryableApiError",
        ])

    if coding_agent == "kimchi" and kimchi_multi_model:
        cmd.extend(["--agent-kwarg", "multi-model=true"])
    if coding_agent == "kimchi" and kimchi_ferment_oneshot:
        cmd.extend(["--agent-kwarg", "ferment-oneshot=true"])
    if coding_agent == "opencode" and opencode_version:
        cmd.extend(["--agent-kwarg", f"version={opencode_version}"])
    if coding_agent == "claude-code" and claude_code_version:
        cmd.extend(["--agent-kwarg", f"version={claude_code_version}"])

    for task in tasks:
        task_arg = task if "/" in task else f"terminal-bench/{task}"
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


__all__ = ["build_harbor_command", "format_command_for_log", "run_harbor"]
