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


def test_command_includes_job_name_when_provided() -> None:
    """--job-name is forwarded when the caller passes it (chunk_runner does this)."""
    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.6",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        job_name="chunk-0-9001",
    )

    pairs = list(itertools.pairwise(cmd))
    assert ("--job-name", "chunk-0-9001") in pairs


def test_command_omits_job_name_flag_by_default() -> None:
    """When job_name is not provided, the flag is omitted so Harbor uses its default (timestamp)."""
    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.6",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
    )

    assert "--job-name" not in cmd


# --- LLM sampling parameter forwarding ---


def test_command_forwards_llm_params_as_base64_kwargs() -> None:
    """LLM params are base64-encoded as --agent-kwarg values."""
    import base64
    import json

    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.6",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        coding_agent="kimchi",
        llm_params={"temperature": 0.7, "top_p": 0.9, "top_k": 40, "max_tokens": 4096},
        llm_per_model_params={"kimchi-dev/kimi-k2.6": {"temperature": 0.2, "top_k": 20}},
    )

    def _find_kwarg(prefix: str) -> str:
        for i, arg in enumerate(cmd):
            if arg == "--agent-kwarg" and i + 1 < len(cmd) and cmd[i + 1].startswith(prefix):
                return cmd[i + 1]
        raise AssertionError(f"Missing kwarg {prefix!r} in {cmd}")

    params_arg = _find_kwarg("llm-params=")
    encoded = params_arg.split("=", 1)[1]
    padded = encoded + "=" * (-len(encoded) % 4)
    decoded = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    assert decoded == {"temperature": 0.7, "top_p": 0.9, "top_k": 40, "max_tokens": 4096}

    per_model_arg = _find_kwarg("llm-per-model-params=")
    encoded_per_model = per_model_arg.split("=", 1)[1]
    padded_per_model = encoded_per_model + "=" * (-len(encoded_per_model) % 4)
    decoded_per_model = json.loads(base64.urlsafe_b64decode(padded_per_model.encode("ascii")))
    assert decoded_per_model == {"kimchi-dev/kimi-k2.6": {"temperature": 0.2, "top_k": 20}}


def test_command_omits_llm_params_when_empty() -> None:
    """When llm_params are empty/None, no llm-params kwargs are added."""
    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.6",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        coding_agent="kimchi",
    )
    assert not any(arg.startswith("llm-params=") or arg.startswith("llm-per-model-params=") for arg in cmd)
