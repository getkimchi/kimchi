"""Harbor subprocess management — builds and invokes `harbor run` commands.

Shared by chunk_runner.py so it can be unit-tested independently of Harbor.
Pure-function command construction plus a thin subprocess wrapper.
"""

from __future__ import annotations

import base64
import json
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from bench_config import (
    CLAUDE_CODE_CODING_AGENT,
    ENV_WORKFLOW,
    ENV_WORKFLOW_EXTENSION,
    is_kimchi_family,
    is_workflow_agent,
)


@dataclass(frozen=True)
class CheckpointPluginArgs:
    """Arguments for the GCS checkpoint Harbor plugin.

    Passed to ``build_harbor_command`` so the ``--plugin`` / ``--plugin-kwarg``
    flags are only emitted for checkpoint-enabled runs. All four values are
    required; callers (``chunk_runner.main``) resolve them from bench config.
    """

    bucket: str
    run_prefix: str
    chunk_index: int
    scripts_dir: Path
    upload_retries: int = 5
    base_retry_delay: float = 1.0


# Harbor import path for the GCS checkpoint plugin.
_CHECKPOINT_PLUGIN_IMPORT_PATH = "kimchi_agent.plugins.gcs_checkpoint:GCSCheckpointPlugin"


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
    kimchi_disable_compaction: bool = False,
    claude_code_api_max_retries: int = 0,
    coding_agent: str = "kimchi",
    opencode_version: str | None = None,
    claude_code_version: str | None = None,
    pi_version: str | None = None,
    llm_params: dict[str, Any] | None = None,
    llm_per_model_params: dict[str, dict[str, Any]] | None = None,
    thinking_level: str | None = None,
    workflow: str | None = None,
    workflow_extension: str | None = None,
    checkpoint_plugin: CheckpointPluginArgs | None = None,
) -> list[str]:
    """Build the `harbor run` command as a list of args (suitable for subprocess).

    Raises ValueError when CODING_AGENT selects the workflow agent without both
    of the kwargs WorkflowAgent requires, so a misconfigured pipeline fails
    here rather than inside every trial.

    ``checkpoint_plugin`` is non-None only for checkpoint-enabled CI runs; when
    set, the Harbor ``--plugin`` / ``--plugin-kwarg`` flags are appended so
    completed trials are uploaded to GCS as they finish. Local/dev runs pass
    ``None`` and stay plugin-free.
    """
    if is_workflow_agent(coding_agent):
        missing = [
            name
            for name, value in (("workflow", workflow), ("workflow_extension", workflow_extension))
            if not value or not str(value).strip()
        ]
        if missing:
            raise ValueError(
                f"coding_agent={coding_agent!r} requires {' and '.join(missing)}; "
                f"set ${ENV_WORKFLOW} and ${ENV_WORKFLOW_EXTENSION}"
            )
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

    # Omitted when compaction stays enabled, so the command remains compatible
    # with checkouts whose kimchi_agent predates the disable-compaction kwarg.
    if is_kimchi_family(coding_agent) and kimchi_disable_compaction:
        cmd.extend(["--agent-kwarg", "disable-compaction=true"])

    if is_kimchi_family(coding_agent):
        encoded_params = _encode_agent_kwargs(llm_params)
        if encoded_params:
            cmd.extend(["--agent-kwarg", f"llm-params={encoded_params}"])
        encoded_per_model = _encode_agent_kwargs(llm_per_model_params)
        if encoded_per_model:
            cmd.extend(["--agent-kwarg", f"llm-per-model-params={encoded_per_model}"])

    # A fixed thinking level (off/minimal/low/medium/high/xhigh) overrides the
    # harness's dynamic thinking for every call. None means "use the harness
    # default" — no kwarg is passed, preserving backward compatibility.
    # Passed as an --agent-kwarg so Harbor's CliFlag mechanism formats it as
    # `--thinking <level>` on the agent's command line.
    if is_kimchi_family(coding_agent) and thinking_level is not None:
        cmd.extend(["--agent-kwarg", f"thinking={thinking_level}"])

    # The pi agent (bare @earendil-works/pi-coding-agent) also accepts
    # --thinking via the same CliFlag mechanism.
    if coding_agent == "pi" and thinking_level is not None:
        cmd.extend(["--agent-kwarg", f"thinking={thinking_level}"])

    # Claude Code has no --thinking flag; the equivalent knob is reasoning
    # effort, which shares this level scale. Harbor's ClaudeCode CliFlag turns
    # reasoning_effort into `--effort <level>`. resolve_thinking_level has
    # already rejected off/minimal for this agent, so the value is always one
    # the CLI accepts.
    if coding_agent == CLAUDE_CODE_CODING_AGENT and thinking_level is not None:
        cmd.extend(["--agent-kwarg", f"reasoning_effort={thinking_level}"])

    if is_workflow_agent(coding_agent):
        cmd.extend(["--agent-kwarg", f"extension={workflow_extension}"])
        cmd.extend(["--agent-kwarg", f"workflow={workflow}"])

    if coding_agent == "opencode" and opencode_version:
        cmd.extend(["--agent-kwarg", f"version={opencode_version}"])
    if coding_agent == "claude-code" and claude_code_version:
        cmd.extend(["--agent-kwarg", f"version={claude_code_version}"])
    if coding_agent == "pi" and pi_version:
        cmd.extend(["--agent-kwarg", f"version={pi_version}"])

    for task in tasks:
        task_arg = _resolve_task_arg(task, dataset)
        cmd.extend(["-i", task_arg])

    if checkpoint_plugin is not None:
        cmd.extend(_checkpoint_plugin_flags(checkpoint_plugin))

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


def _checkpoint_plugin_flags(args: CheckpointPluginArgs) -> list[str]:
    """Emit Harbor ``--plugin`` + ``--plugin-kwarg`` flags for the checkpoint plugin.

    Harbor's ``parse_kwargs`` (cli/utils.py) parses ``key=value`` values as JSON
    when possible, else strings. We pass primitives as JSON literals so the
    plugin receives native ``str``/``int``/``float`` types rather than strings.
    The ``scripts_dir`` is passed as an absolute path string.
    """
    flags = ["--plugin", _CHECKPOINT_PLUGIN_IMPORT_PATH]
    kwargs = {
        "bucket": args.bucket,
        "run_prefix": args.run_prefix,
        "chunk_index": args.chunk_index,
        "scripts_dir": str(args.scripts_dir),
        "upload_retries": args.upload_retries,
        "base_retry_delay": args.base_retry_delay,
    }
    for key, value in kwargs.items():
        flags.extend(["--plugin-kwarg", f"{key}={json.dumps(value)}"])
    return flags


def _encode_agent_kwargs(value: dict[str, Any] | None) -> str | None:
    """Base64-encode a dict for passing as a Harbor --agent-kwarg value."""
    if not value:
        return None
    return base64.urlsafe_b64encode(json.dumps(value).encode("utf-8")).decode("ascii").rstrip("=")


__all__ = ["CheckpointPluginArgs", "build_harbor_command", "format_command_for_log", "run_harbor"]
