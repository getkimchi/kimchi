import asyncio
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from harbor.models.agent.context import AgentContext

from kimchi_agent.agent import (
    CONTAINER_AGENT_PGID_FILE,
    CONTAINER_HARNESS_SKILLS_DIR,
    KIMCHI_EXIT_OUTPUT_TAIL_LINES,
    KIMCHI_INFRA_BREAKER_THRESHOLD_ENV,
    Kimchi,
    KimchiExitError,
)


class RecordingKimchi(Kimchi):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.agent_commands: list[str] = []
        self.agent_envs: list[dict[str, str] | None] = []
        self.root_commands: list[str] = []

    async def exec_as_agent(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.agent_commands.append(command)
        self.agent_envs.append(env)
        raise asyncio.CancelledError

    async def exec_as_root(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.root_commands.append(command)


@pytest.fixture(autouse=True)
def kimchi_test_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIMCHI_API_KEY", "test-key")
    monkeypatch.delenv("KIMCHI_CODE_BINARY", raising=False)
    monkeypatch.delenv("KIMCHI_TAGS", raising=False)
    monkeypatch.delenv("RUN_ID", raising=False)
    monkeypatch.delenv(KIMCHI_INFRA_BREAKER_THRESHOLD_ENV, raising=False)


async def test_run_uses_shell_process_group_cleanup_on_cancellation(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
        **{"ferment-oneshot": True},
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello - world", object(), AgentContext())

    assert len(agent.agent_commands) == 1
    assert "set -m" in agent.agent_commands[0]
    assert 'ps -o pgid= -p "$agent_pid"' in agent.agent_commands[0]
    assert "/proc/$agent_pid/stat" not in agent.agent_commands[0]
    assert "${agent_pgid//" not in agent.agent_commands[0]
    assert CONTAINER_AGENT_PGID_FILE in agent.agent_commands[0]
    assert f"rm -f {CONTAINER_AGENT_PGID_FILE}" in agent.agent_commands[0]
    assert "--session /logs/agent/sessions/main.jsonl" in agent.agent_commands[0]
    assert "KIMCHI_FERMENTS_DIR" in agent.agent_envs[0]

    assert len(agent.root_commands) == 1
    assert f"cat {CONTAINER_AGENT_PGID_FILE}" in agent.root_commands[0]
    assert 'kill -TERM "-$pgid"' in agent.root_commands[0]
    assert 'kill -KILL "-$pgid"' in agent.root_commands[0]
    assert "kill -TERM -- " not in agent.root_commands[0]
    assert f"rm -f {CONTAINER_AGENT_PGID_FILE}" in agent.root_commands[0]
    assert "pkill" not in agent.root_commands[0]


async def test_single_model_run_passes_model_without_multi_model_cli_flag(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    command = agent.agent_commands[0]
    assert "--model kimchi-dev/kimi-k2.6" in command
    assert "--multi-model" not in command
    assert ".config/kimchi/harness/settings.json" not in command


async def test_multi_model_run_omits_model_and_enables_harness_setting(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="multi-model",
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    command = agent.agent_commands[0]
    assert "--model" not in command
    assert "--multi-model" not in command
    assert "~/.config/kimchi/harness/settings.json" in command
    assert '{"multiModel":true}' in command
    assert not agent._multi_model_settings_command().endswith("&& ")
    assert f"{agent._multi_model_settings_command()} && set -m" in command
    assert agent.to_agent_info().model_info.provider == "kimchi"
    assert agent.to_agent_info().model_info.name == "multi-model"


def test_legacy_multi_model_kwarg_cannot_enable_mode(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="must match model_name='multi-model'"):
        RecordingKimchi(
            logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
            model_name="kimchi-dev/kimi-k2.6",
            **{"multi-model": "true"},
        )


def test_multi_model_virtual_selection_rejects_explicit_false_kwarg(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="must match model_name='multi-model'"):
        RecordingKimchi(
            logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
            model_name="multi-model",
            **{"multi-model": False},
        )


async def test_run_copies_harbor_skills_dir_into_kimchi_harness_skills_dir(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
        skills_dir="/task skills",
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    command = agent.agent_commands[0]
    assert f"mkdir -p {CONTAINER_HARNESS_SKILLS_DIR}" in command
    assert f"cp -a '/task skills'/. {CONTAINER_HARNESS_SKILLS_DIR}/" in command
    assert "2>/dev/null" not in agent._skills_registration_command()
    assert f"{agent._skills_registration_command()} && set -m" in command
    assert "--model kimchi-dev/kimi-k2.6" in command


async def test_run_omits_skills_copy_when_no_harbor_skills_dir(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    command = agent.agent_commands[0]
    assert CONTAINER_HARNESS_SKILLS_DIR not in command
    assert agent._skills_registration_command() == ""


async def test_api_key_can_come_from_agent_extra_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KIMCHI_API_KEY", raising=False)
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
        extra_env={"KIMCHI_API_KEY": "extra-key"},
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    assert agent.agent_envs[0]["KIMCHI_API_KEY"] == "extra-key"


async def test_run_defaults_infra_breaker_threshold(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    assert agent.agent_envs[0][KIMCHI_INFRA_BREAKER_THRESHOLD_ENV] == "3"


async def test_run_preserves_existing_infra_breaker_threshold(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
        extra_env={KIMCHI_INFRA_BREAKER_THRESHOLD_ENV: "5"},
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    assert agent.agent_envs[0][KIMCHI_INFRA_BREAKER_THRESHOLD_ENV] == "5"


async def test_run_rejects_invalid_infra_breaker_threshold(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
        extra_env={KIMCHI_INFRA_BREAKER_THRESHOLD_ENV: "0"},
    )

    with pytest.raises(ValueError, match=KIMCHI_INFRA_BREAKER_THRESHOLD_ENV):
        await agent.run("hello", object(), AgentContext())

    assert agent.agent_commands == []


async def test_run_passes_merged_tags_in_exec_env(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    tags = dict(tag.split(":", 1) for tag in agent.agent_envs[0]["KIMCHI_TAGS"].split(","))
    assert tags["run"] == "run-1"
    assert tags["task"] == "task"
    assert tags["trial"] == "task__trial"


async def test_legacy_disable_multi_model_kwarg_does_not_emit_removed_cli_flag(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
        **{"disable-multi-model": True},
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    command = agent.agent_commands[0]
    assert "--model kimchi-dev/kimi-k2.6" in command
    assert "--multi-model" not in command


def test_multi_model_and_legacy_disable_multi_model_conflict(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        RecordingKimchi(
            logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
            model_name="multi-model",
            **{"disable-multi-model": True},
        )


async def test_single_model_rejects_empty_model_id(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/",
    )

    with pytest.raises(ValueError, match="<provider>/<id>"):
        await agent.run("hello", object(), AgentContext())

    assert agent.agent_commands == []


def test_kimchi_exit_error_has_structured_exit_code_and_output_tails(tmp_path: Path) -> None:
    agent = Kimchi(logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent", model_name="kimchi-dev/kimi-k2.6")
    stdout = "\n".join(f"stdout line {index}" for index in range(KIMCHI_EXIT_OUTPUT_TAIL_LINES + 5))
    stderr = "\n".join(f"stderr line {index}" for index in range(KIMCHI_EXIT_OUTPUT_TAIL_LINES + 5))
    result = SimpleNamespace(return_code=os.EX_IOERR, stdout=stdout, stderr=stderr)

    error = agent._classify_exec_error("/installed-agent/bin/kimchi --print", result)

    assert isinstance(error, KimchiExitError)
    assert error.exit_code == os.EX_IOERR
    assert error.command == "/installed-agent/bin/kimchi --print"
    assert error.stdout.startswith(f"... [showing last {KIMCHI_EXIT_OUTPUT_TAIL_LINES} lines]")
    assert "stdout line 0" not in error.stdout
    assert f"stdout line {KIMCHI_EXIT_OUTPUT_TAIL_LINES + 4}" in error.stdout
    assert error.stderr.startswith(f"... [showing last {KIMCHI_EXIT_OUTPUT_TAIL_LINES} lines]")
    assert "stderr line 0" not in error.stderr
    assert f"stderr line {KIMCHI_EXIT_OUTPUT_TAIL_LINES + 4}" in error.stderr
    assert f"Kimchi exited with code {os.EX_IOERR}" in str(error)


def test_populate_context_skips_unreadable_session_files(tmp_path: Path) -> None:
    logs_dir = tmp_path / "jobs" / "run-1" / "task__trial" / "agent"
    sessions_dir = logs_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    readable = sessions_dir / "main.jsonl"
    unreadable = sessions_dir / "unreadable.jsonl"
    readable.write_text(
        '{"type":"message","message":{"role":"assistant","usage":{"input":10,"output":3,"cacheRead":2,"cacheWrite":1,"cost":{"total":0.5}}}}\n'
    )
    unreadable.write_text(
        '{"type":"message","message":{"role":"assistant","usage":{"input":999,"output":999}}}\n'
    )

    original_read_text = Path.read_text

    def fake_read_text(path: Path, *args, **kwargs):
        if path == unreadable:
            raise PermissionError("test permission error")
        return original_read_text(path, *args, **kwargs)

    with patch.object(Path, "read_text", fake_read_text):
        agent = Kimchi(logs_dir=logs_dir, model_name="kimchi-dev/kimi-k2.6")
        context = AgentContext()
        with patch.object(agent.logger, "warning") as warning:
            agent.populate_context_post_run(context)

    assert context.n_input_tokens == 13
    assert context.n_output_tokens == 3
    assert context.n_cache_tokens == 2
    assert context.cost_usd == 0.5
    warning.assert_called_once()
