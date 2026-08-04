"""Unit tests for harbor_runner — Harbor subprocess command construction."""

from __future__ import annotations

import itertools

import pytest

from harbor_runner import build_harbor_command

# --- Task argument resolution ---


def test_task_arg_not_prefixed_for_non_terminal_bench_dataset() -> None:
    """Non-terminal-bench task names are passed as-is (no 'terminal-bench/' prefix)."""
    cmd = build_harbor_command(
        tasks=["some-task"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/minimax-m3",
        dataset="other-dataset",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
    )

    pairs = list(itertools.pairwise(cmd))
    assert ("-i", "some-task") in pairs
    assert not any(v.startswith("terminal-bench/") for _, v in pairs if _ == "-i")


def test_task_arg_prefixed_for_terminal_bench_dataset() -> None:
    """Terminal-bench bare task names get 'terminal-bench/' prefix."""
    cmd = build_harbor_command(
        tasks=["fix-git"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/minimax-m3",
        dataset="terminal-bench/terminal-bench-2-1",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
    )

    pairs = list(itertools.pairwise(cmd))
    assert ("-i", "terminal-bench/fix-git") in pairs


def test_task_arg_with_slash_not_double_prefixed() -> None:
    """Task names that already contain '/' are not double-prefixed."""
    cmd = build_harbor_command(
        tasks=["terminal-bench/fix-git"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/minimax-m3",
        dataset="terminal-bench/terminal-bench-2-1",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
    )

    pairs = list(itertools.pairwise(cmd))
    assert ("-i", "terminal-bench/fix-git") in pairs


# --- Basic command construction ---


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


def test_command_passes_multi_model_as_virtual_model_without_agent_kwarg() -> None:
    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="multi-model",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
    )

    pairs = list(itertools.pairwise(cmd))
    assert ("--model", "multi-model") in pairs
    assert ("--agent-kwarg", "multi-model=true") not in pairs


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


def test_command_includes_kimchi_disable_compaction_kwarg() -> None:
    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.6",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        kimchi_disable_compaction=True,
    )

    pairs = list(itertools.pairwise(cmd))
    assert ("--agent-kwarg", "disable-compaction=true") in pairs


def test_command_omits_disable_compaction_kwarg_by_default() -> None:
    """Compaction enabled (the default) must not add the kwarg, keeping the
    command compatible with checkouts that predate it."""
    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.6",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
    )

    assert "disable-compaction=true" not in cmd


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


# --- Terminal Bench 2.1 dataset support ---


def test_command_includes_2_1_dataset() -> None:
    """The 2.1 dataset slug is forwarded verbatim as the `-d` argument."""
    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.6",
        dataset="terminal-bench/terminal-bench-2-1",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
    )

    assert "terminal-bench/terminal-bench-2-1" in cmd
    assert "-d" in cmd


def test_command_includes_jobs_dir_when_provided() -> None:
    """--jobs-dir is forwarded as an adjacent flag+value pair when provided.

    Mirrors test_command_omits_job_name_flag_by_default: the flag is present
    only when the caller passes it (chunk_runner forwards the results dir as
    --jobs-dir so Harbor writes into BENCHMARK_RESULTS_DIR).
    """
    cmd_with = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.6",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        jobs_dir="benchmark/terminal-bench-2-1/jobs",
    )
    pairs = list(itertools.pairwise(cmd_with))
    assert ("--jobs-dir", "benchmark/terminal-bench-2-1/jobs") in pairs

    # When omitted, the flag is absent (Harbor uses its default jobs dir).
    cmd_without = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.6",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
    )
    assert "--jobs-dir" not in cmd_without


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


# --- Workflow agent ---

_WORKFLOW_BASE = {
    "tasks": ["fix-git"],
    "agent_import_path": "kimchi_agent:WorkflowAgent",
    "model": "kimchi-dev/kimi-k2.7",
    "dataset": "terminal-bench/terminal-bench-2-1",
    "parallelism": 1,
    "attempts": 1,
    "timeout_multiplier": 1.0,
    "coding_agent": "kimchi-workflow",
}


def test_workflow_agent_command_carries_both_required_kwargs() -> None:
    cmd = build_harbor_command(
        **_WORKFLOW_BASE,
        workflow="ferment-oneshot",
        workflow_extension="npm:@kimchi-dev/kimchi-workflows@latest",
    )

    pairs = list(itertools.pairwise(cmd))
    assert ("--agent-kwarg", "extension=npm:@kimchi-dev/kimchi-workflows@latest") in pairs
    assert ("--agent-kwarg", "workflow=ferment-oneshot") in pairs


@pytest.mark.parametrize(
    "workflow,workflow_extension,missing",
    [
        (None, "npm:@kimchi-dev/kimchi-workflows@latest", "workflow"),
        ("ferment-oneshot", None, "workflow_extension"),
        ("   ", "npm:@kimchi-dev/kimchi-workflows@latest", "workflow"),
        (None, None, "workflow and workflow_extension"),
    ],
)
def test_workflow_agent_without_required_kwargs_fails_before_harbor_starts(
    workflow: str | None, workflow_extension: str | None, missing: str
) -> None:
    """WorkflowAgent raises on a missing kwarg per trial; catch it once, here."""
    with pytest.raises(ValueError, match=missing):
        build_harbor_command(**_WORKFLOW_BASE, workflow=workflow, workflow_extension=workflow_extension)


def test_workflow_kwargs_are_not_added_for_other_agents() -> None:
    for coding_agent, import_path in (
        ("kimchi", "kimchi_agent:Kimchi"),
        ("opencode", "kimchi_agent:OpenCodeKimchi"),
        ("claude-code", "kimchi_agent:ClaudeCodeKimchi"),
    ):
        cmd = build_harbor_command(
            tasks=["fix-git"],
            agent_import_path=import_path,
            model="kimchi-dev/kimi-k2.7",
            dataset="terminal-bench/terminal-bench-2-1",
            parallelism=1,
            attempts=1,
            timeout_multiplier=1.0,
            coding_agent=coding_agent,
            workflow="ferment-oneshot",
            workflow_extension="npm:@kimchi-dev/kimchi-workflows@latest",
        )
        assert not any(arg.startswith("extension=") or arg.startswith("workflow=") for arg in cmd)


def test_workflow_agent_inherits_kimchi_llm_params_and_compaction_kwargs() -> None:
    """WorkflowAgent subclasses Kimchi, so a workflow arm samples like its baseline."""
    cmd = build_harbor_command(
        **_WORKFLOW_BASE,
        workflow="ferment-oneshot",
        workflow_extension="npm:@kimchi-dev/kimchi-workflows@latest",
        kimchi_disable_compaction=True,
        llm_params={"temperature": 0.7},
    )

    assert ("--agent-kwarg", "disable-compaction=true") in list(itertools.pairwise(cmd))
    assert any(arg.startswith("llm-params=") for arg in cmd)


_PI_WORKFLOW_BASE = {
    "tasks": ["fix-git"],
    "agent_import_path": "kimchi_agent:PiWorkflowAgent",
    "model": "kimchi-dev/kimi-k2.7",
    "dataset": "terminal-bench/terminal-bench-2-1",
    "parallelism": 1,
    "attempts": 1,
    "timeout_multiplier": 1.0,
    "coding_agent": "pi-workflow",
}


def test_pi_workflow_agent_command_carries_both_required_kwargs() -> None:
    cmd = build_harbor_command(
        **_PI_WORKFLOW_BASE,
        workflow="deep-solve",
        workflow_extension="npm:@kimchi-dev/kimchi-workflows@latest",
    )

    pairs = list(itertools.pairwise(cmd))
    assert ("--agent-kwarg", "extension=npm:@kimchi-dev/kimchi-workflows@latest") in pairs
    assert ("--agent-kwarg", "workflow=deep-solve") in pairs


def test_pi_workflow_agent_without_required_kwargs_fails_before_harbor_starts() -> None:
    with pytest.raises(ValueError, match="workflow"):
        build_harbor_command(**_PI_WORKFLOW_BASE, workflow=None, workflow_extension=None)


def test_pi_workflow_agent_gets_no_kimchi_only_kwargs() -> None:
    cmd = build_harbor_command(
        **_PI_WORKFLOW_BASE,
        workflow="deep-solve",
        workflow_extension="npm:@kimchi-dev/kimchi-workflows@latest",
        kimchi_disable_compaction=True,
        kimchi_ferment_oneshot=True,
        llm_params={"temperature": 0.7},
    )

    assert "disable-compaction=true" not in cmd
    assert "ferment-oneshot=true" not in cmd
    assert not any(arg.startswith("llm-params=") for arg in cmd)
    assert not any(arg.startswith("llm-per-model-params=") for arg in cmd)


def test_workflow_agent_never_gets_ferment_oneshot() -> None:
    """The workflow replaces kimchi's chat loop; stacking ferment on top is meaningless."""
    cmd = build_harbor_command(
        **_WORKFLOW_BASE,
        workflow="ferment-oneshot",
        workflow_extension="npm:@kimchi-dev/kimchi-workflows@latest",
        kimchi_ferment_oneshot=True,
    )

    assert "ferment-oneshot=true" not in cmd
