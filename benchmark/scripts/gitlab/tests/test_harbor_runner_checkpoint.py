"""Tests for harbor_runner.py — checkpoint plugin flag construction (Phase 3)."""

from __future__ import annotations

import json
from pathlib import Path

from harbor_runner import (
    CheckpointPluginArgs,
    _checkpoint_plugin_flags,
    build_harbor_command,
)


def _args(**overrides: object) -> CheckpointPluginArgs:
    defaults: dict[str, object] = {
        "bucket": "ckpt-bucket",
        "run_prefix": "runs/benchmark=tb2/run=gitlab-p1",
        "chunk_index": 2,
        "scripts_dir": Path("/repo/benchmark/scripts/gitlab"),
    }
    defaults.update(overrides)
    return CheckpointPluginArgs(**defaults)  # type: ignore[arg-type]


def test_checkpoint_plugin_flags_emit_import_path_and_kwargs() -> None:
    flags = _checkpoint_plugin_flags(_args())
    assert flags[0] == "--plugin"
    assert flags[1] == "kimchi_agent.plugins.gcs_checkpoint:GCSCheckpointPlugin"
    # Each kwarg is a --plugin-kwarg key=value(json) pair.
    pairs = [(flags[i], flags[i + 1]) for i in range(2, len(flags), 2)]
    keys = {value.split("=", 1)[0] for _, value in pairs}
    assert keys == {
        "bucket",
        "run_prefix",
        "chunk_index",
        "scripts_dir",
        "upload_retries",
        "base_retry_delay",
    }


def test_checkpoint_plugin_kwargs_are_json_typed() -> None:
    """Harbor parse_kwargs parses JSON values, so types round-trip natively."""
    flags = _checkpoint_plugin_flags(
        _args(chunk_index=2, upload_retries=7)
    )
    for i in range(2, len(flags), 2):
        key, value = flags[i + 1].split("=", 1)
        if key == "chunk_index":
            assert json.loads(value) == 2
            assert isinstance(json.loads(value), int)
        if key == "upload_retries":
            assert json.loads(value) == 7
def test_build_harbor_command_appends_plugin_when_enabled() -> None:
    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.7",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        jobs_dir="jobs",
        job_name="chunk-0-123",
        coding_agent="kimchi",
        checkpoint_plugin=_args(),
    )
    assert "--plugin" in cmd
    plugin_idx = cmd.index("--plugin")
    assert cmd[plugin_idx + 1] == "kimchi_agent.plugins.gcs_checkpoint:GCSCheckpointPlugin"
    # Tasks still come before the plugin flags.
    assert cmd.index("-i") < plugin_idx


def test_build_harbor_command_omits_plugin_when_none() -> None:
    """Local/dev and checkpoint-disabled runs must stay plugin-free."""
    cmd = build_harbor_command(
        tasks=["task-a"],
        agent_import_path="kimchi_agent:Kimchi",
        model="kimchi-dev/kimi-k2.7",
        dataset="terminal-bench/terminal-bench-2",
        parallelism=1,
        attempts=1,
        timeout_multiplier=1.0,
        jobs_dir="jobs",
        job_name="chunk-0-123",
        coding_agent="kimchi",
        checkpoint_plugin=None,
    )
    assert "--plugin" not in cmd
    assert "--plugin-kwarg" not in cmd


def test_checkpoint_plugin_flags_scripts_dir_is_absolute_string() -> None:
    flags = _checkpoint_plugin_flags(_args(scripts_dir=Path("relative/dir")))
    for i in range(2, len(flags), 2):
        key, value = flags[i + 1].split("=", 1)
        if key == "scripts_dir":
            assert json.loads(value) == str(Path("relative/dir"))
