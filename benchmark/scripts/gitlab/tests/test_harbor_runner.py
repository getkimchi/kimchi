"""Unit tests for harbor_runner — Harbor subprocess command construction."""

from __future__ import annotations

import itertools

from harbor_runner import build_harbor_command


def test_command_includes_required_flags() -> None:
    cmd = build_harbor_command(
        tasks=["task-a", "task-b"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.6",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=4,
        attempts=1,
        timeout_multiplier=1.0,
    )

    assert cmd[0] == "uv"
    assert "harbor" in cmd
    assert "run" in cmd
    assert "--agent-import-path" in cmd
    assert "kimchi_agent:Kimchi" in cmd
    assert "--model" in cmd
    assert "kimchi-dev/kimi-k2.6" in cmd
    assert "-d" in cmd
    assert "terminal-bench/terminal-bench-2" in cmd
    assert "-n" in cmd
    assert "4" in cmd
    assert "-k" in cmd
    assert "1" in cmd


def test_command_includes_retry_flags_for_claude_code() -> None:
    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:ClaudeCodeKimchi",
        model="kimchi-dev/claude-sonnet-4-6",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        claude_code_api_max_retries=2,
        coding_agent="claude-code",
    )

    assert "--max-retries" in cmd
    assert "2" in cmd
    assert "--retry-include" in cmd
    assert "RetryableApiError" in cmd


def test_command_does_not_include_retry_flags_for_non_claude_code() -> None:
    """Sanity: retry flags must NOT appear when coding_agent != claude-code."""
    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.6",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        claude_code_api_max_retries=2,
        coding_agent="kimchi",
    )

    assert "--max-retries" not in cmd


def test_command_includes_agent_kwargs_for_kimchi_multi_model() -> None:
    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.6",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        kimchi_multi_model=True,
    )

    # Find the multi-model kwarg
    pairs = list(itertools.pairwise(cmd))
    assert ("--agent-kwarg", "multi-model=true") in pairs


def test_command_includes_kimchi_ferment_oneshot_kwarg() -> None:
    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.6",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        kimchi_ferment_oneshot=True,
    )

    pairs = list(itertools.pairwise(cmd))
    assert ("--agent-kwarg", "ferment-oneshot=true") in pairs
