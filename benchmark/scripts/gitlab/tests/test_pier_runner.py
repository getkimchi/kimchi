"""Unit tests for pier_runner.build_pier_command()."""

from __future__ import annotations

from pier_runner import build_pier_command, format_command_for_log


def test_build_pier_command_basic() -> None:
    """Basic pier run command with correct structure."""
    cmd = build_pier_command(
        tasks=["fastapi-deprecation-response-headers"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/minimax-m3",
        task_path="/tmp/deep-swe/tasks",
        parallelism=4,
        attempts=1,
        timeout_multiplier=1.0,
    )

    # Core pier invocation
    assert "pier" in cmd
    assert "run" in cmd

    # Uses -p (local path) not -d (registry dataset)
    assert "-p" in cmd
    assert "/tmp/deep-swe/tasks" in cmd
    assert "-d" not in cmd

    # Agent and model flags
    assert "--agent-import-path" in cmd
    assert "kimchi_agent:Kimchi" in cmd
    assert "--model" in cmd
    assert "kimchi-dev/minimax-m3" in cmd
    assert "--env" in cmd
    assert "docker" in cmd

    # Parallelism and attempts
    assert "-n" in cmd
    assert "4" in cmd
    assert "-k" in cmd
    assert "1" in cmd

    # Task passed via -i without prefix
    assert "-i" in cmd
    assert "fastapi-deprecation-response-headers" in cmd
    assert "terminal-bench/" not in " ".join(cmd)


def test_build_pier_command_no_task_prefix() -> None:
    """DeepSWE tasks should never get terminal-bench/ prefix."""
    cmd = build_pier_command(
        tasks=["abs-module-cache-flags", "boa-hierarchical-evaluation-cancellation"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.7",
        task_path="/tmp/deep-swe/tasks",
        parallelism=2,
        attempts=1,
        timeout_multiplier=1.0,
    )

    cmd_str = " ".join(cmd)
    assert "terminal-bench/" not in cmd_str
    assert "abs-module-cache-flags" in cmd_str
    assert "boa-hierarchical-evaluation-cancellation" in cmd_str


def test_build_pier_command_with_jobs_dir() -> None:
    """--jobs-dir is included when provided."""
    cmd = build_pier_command(
        tasks=["abs-module-cache-flags"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/minimax-m3",
        task_path="/tmp/deep-swe/tasks",
        parallelism=2,
        attempts=3,
        timeout_multiplier=1.5,
        jobs_dir="benchmark/deep-swe/jobs",
    )

    assert "--jobs-dir" in cmd
    assert "benchmark/deep-swe/jobs" in cmd


def test_build_pier_command_with_job_name() -> None:
    """--job-name is included when provided."""
    cmd = build_pier_command(
        tasks=["abs-module-cache-flags"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/minimax-m3",
        task_path="/tmp/deep-swe/tasks",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        job_name="chunk-0-12345",
    )

    assert "--job-name" in cmd
    assert "chunk-0-12345" in cmd


def test_build_pier_command_ferment_oneshot() -> None:
    """ferment-oneshot agent kwarg is included when enabled."""
    cmd = build_pier_command(
        tasks=["abs-module-cache-flags"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/minimax-m3",
        task_path="/tmp/deep-swe/tasks",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        kimchi_ferment_oneshot=True,
    )

    assert "--agent-kwarg" in cmd
    assert "ferment-oneshot=true" in cmd


def test_build_pier_command_llm_params() -> None:
    """LLM params are base64-encoded and passed as agent kwarg."""
    cmd = build_pier_command(
        tasks=["abs-module-cache-flags"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/minimax-m3",
        task_path="/tmp/deep-swe/tasks",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        llm_params={"temperature": 0.7},
    )

    assert "--agent-kwarg" in cmd
    # Find the llm-params kwarg
    kwarg_idx = [
        i for i, v in enumerate(cmd)
        if v == "--agent-kwarg" and i + 1 < len(cmd) and cmd[i + 1].startswith("llm-params=")
    ]
    assert len(kwarg_idx) == 1


def test_build_pier_command_thinking_level_kimchi() -> None:
    """thinking kwarg is included for kimchi agent when thinking_level is set."""
    cmd = build_pier_command(
        tasks=["abs-module-cache-flags"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/minimax-m3",
        task_path="/tmp/deep-swe/tasks",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        coding_agent="kimchi",
        thinking_level="max",
    )

    assert "--agent-kwarg" in cmd
    assert "thinking=max" in cmd


def test_build_pier_command_thinking_level_pi() -> None:
    """thinking kwarg is included for pi agent when thinking_level is set."""
    cmd = build_pier_command(
        tasks=["abs-module-cache-flags"],
        agent_import_path="kimchi_agent:PiKimchi",
        model="kimchi-dev/minimax-m3",
        task_path="/tmp/deep-swe/tasks",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        coding_agent="pi",
        thinking_level="high",
    )

    assert "--agent-kwarg" in cmd
    assert "thinking=high" in cmd


def test_build_pier_command_thinking_level_claude_code() -> None:
    """reasoning_effort kwarg is included for claude-code when thinking_level is set."""
    cmd = build_pier_command(
        tasks=["abs-module-cache-flags"],
        agent_import_path="kimchi_agent:ClaudeCodeKimchi",
        model="kimchi-dev/claude-sonnet-5",
        task_path="/tmp/deep-swe/tasks",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        coding_agent="claude-code",
        thinking_level="xhigh",
    )

    assert "--agent-kwarg" in cmd
    assert "reasoning_effort=xhigh" in cmd


def test_build_pier_command_thinking_level_none_omitted() -> None:
    """No thinking kwarg when thinking_level is None (harness default)."""
    cmd = build_pier_command(
        tasks=["abs-module-cache-flags"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/minimax-m3",
        task_path="/tmp/deep-swe/tasks",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        coding_agent="kimchi",
        thinking_level=None,
    )

    cmd_str = " ".join(cmd)
    assert "thinking=" not in cmd_str
    assert "reasoning_effort=" not in cmd_str


def test_build_pier_command_disable_compaction() -> None:
    """disable-compaction kwarg is included when kimchi_disable_compaction=True."""
    cmd = build_pier_command(
        tasks=["abs-module-cache-flags"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/minimax-m3",
        task_path="/tmp/deep-swe/tasks",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        coding_agent="kimchi",
        kimchi_disable_compaction=True,
    )

    assert "--agent-kwarg" in cmd
    assert "disable-compaction=true" in cmd


def test_build_pier_command_compaction_enabled_omitted() -> None:
    """No disable-compaction kwarg when kimchi_disable_compaction=False."""
    cmd = build_pier_command(
        tasks=["abs-module-cache-flags"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/minimax-m3",
        task_path="/tmp/deep-swe/tasks",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        coding_agent="kimchi",
        kimchi_disable_compaction=False,
    )

    assert "disable-compaction" not in " ".join(cmd)


def test_build_pier_command_uses_uv_run() -> None:
    """Command starts with uv run --project for correct environment."""
    cmd = build_pier_command(
        tasks=["abs-module-cache-flags"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/minimax-m3",
        task_path="/tmp/deep-swe/tasks",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
    )

    assert cmd[0] == "uv"
    assert cmd[1] == "run"
    assert "--project" in cmd
    assert "benchmark/terminal-bench-2" in cmd


def test_format_command_for_log() -> None:
    """format_command_for_log produces a shell-joinable string."""
    cmd = ["pier", "run", "-p", "/tmp/path with spaces"]
    result = format_command_for_log(cmd)
    assert "pier" in result
    assert "/tmp/path with spaces" in result
