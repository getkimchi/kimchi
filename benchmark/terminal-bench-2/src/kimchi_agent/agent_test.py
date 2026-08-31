import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.models.agent.context import AgentContext

from kimchi_agent.agent import (
    CONTAINER_AGENT_PGID_FILE,
    CONTAINER_HARNESS_SKILLS_DIR,
    KIMCHI_EXIT_OUTPUT_TAIL_LINES,
    KIMCHI_INFRA_BREAKER_THRESHOLD_ENV,
    Kimchi,
    KimchiExitError,
    RetryableApiError,
    _parse_ferment_v2_evaluator_usage,
    _retryable_api_error_from_session_stream,
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


class FailingKimchi(Kimchi):
    def __init__(self, *args, failure: NonZeroAgentExitCodeError, **kwargs):
        super().__init__(*args, **kwargs)
        self.failure = failure

    async def exec_as_agent(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        raise self.failure


class FakeEnvironment:
    def __init__(self, stream: str, return_code: int = 0):
        self.stream = stream
        self.return_code = return_code
        self.commands: list[str] = []

    async def exec(self, command: str, timeout_sec=None):
        self.commands.append(command)
        return SimpleNamespace(return_code=self.return_code, stdout=self.stream)


def _classification_entry(
    raw_message: str = "Moonshot quota exceeded; please retry later.",
    *,
    entry_id: str = "classification-1",
    retryable: bool = True,
    is_infrastructure: bool = True,
    # Mirrors src/llm-gateway-error.ts::LLM_GATEWAY_INFRASTRUCTURE_EXIT_CODE.
    exit_code: int | None = 74,
    http_status_code: int | None = None,
) -> str:
    return json.dumps(
        {
            "type": "custom",
            "id": entry_id,
            # Mirrors src/infrastructure-error.ts::GATEWAY_CLASSIFICATION_AUDIT_TYPE.
            "customType": "kimchi_error_classification",
            "data": {
                "rawMessage": raw_message,
                "reason": "rate_limit",
                "retryable": retryable,
                "isInfrastructure": is_infrastructure,
                "exitCode": exit_code,
                "httpStatusCode": http_status_code,
            },
        }
    )


def _assistant_entry(*, parent_id: str = "classification-1", stop_reason: str = "error") -> str:
    return json.dumps(
        {
            "type": "message",
            "parentId": parent_id,
            "message": {
                "role": "assistant",
                "stopReason": stop_reason,
                "errorMessage": "Moonshot quota exceeded; please retry later.",
            },
        }
    )


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
    # Compaction defaults on (kimchi's default): no settings write at all.
    assert ".config/kimchi/harness/settings.json" not in command


async def test_disable_compaction_writes_harness_setting(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
        **{"disable-compaction": "true"},
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    command = agent.agent_commands[0]
    assert "~/.config/kimchi/harness/settings.json" in command
    assert '{"compaction":{"enabled":false}}' in command


async def test_ferment_v2_kwarg_enables_resource_and_prepends_command(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
        **{"ferment-v2": True},
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("implement the task", object(), AgentContext())

    command = agent.agent_commands[0]
    assert "printf '%s' '/ferment-v2 implement the task'" in command
    assert "--ferment-v2" not in command
    assert '{"resources":{"extensions.ferment-v2":true}}' in command


async def test_ferment_v2_kwarg_shares_harness_settings_write(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
        **{"disable-compaction": "true", "ferment-v2": "true"},
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("implement the task", object(), AgentContext())

    command = agent.agent_commands[0]
    assert '{"compaction":{"enabled":false},"resources":{"extensions.ferment-v2":true}}' in command


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
    assert "compaction" not in command
    assert not agent._harness_settings_command().endswith("&& ")
    assert f"{agent._harness_settings_command()} && set -m" in command
    assert agent.to_agent_info().model_info.provider == "kimchi"
    assert agent.to_agent_info().model_info.name == "multi-model"


async def test_multi_model_with_disable_compaction_writes_both_settings_in_one_json(tmp_path: Path) -> None:
    agent = RecordingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="multi-model",
        **{"disable-compaction": "true"},
    )

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    command = agent.agent_commands[0]
    # Both keys must land in one write — the file is written wholesale.
    assert '{"multiModel":true,"compaction":{"enabled":false}}' in command


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


async def test_retryable_provider_error_in_session_reclassifies_wrapped_kimchi_exit(tmp_path: Path) -> None:
    stream = "\n".join([_classification_entry(), _assistant_entry()])
    agent = FailingKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.6",
        failure=NonZeroAgentExitCodeError("kimchi exited 1"),
    )
    environment = FakeEnvironment(stream)

    with pytest.raises(RetryableApiError) as raised:
        await agent.run("solve it", environment, AgentContext())

    assert raised.value.status is None
    assert "quota exceeded" in str(raised.value)
    assert "cat /logs/agent/sessions/main.jsonl" in environment.commands


def test_retryable_provider_error_uses_parent_id_linkage() -> None:
    stream = "\n".join(
        [
            _classification_entry(),
            json.dumps({"type": "custom", "id": "intervening", "customType": "other", "data": {}}),
            _assistant_entry(),
        ]
    )

    linked_error = _retryable_api_error_from_session_stream(stream)
    assert linked_error is not None
    assert linked_error.status is None
    assert _retryable_api_error_from_session_stream(
        "\n".join([_classification_entry(), _assistant_entry(parent_id="other")])
    ) is None


def test_retryable_session_error_is_cleared_by_later_non_error_assistant() -> None:
    stream = "\n".join(
        [
            _classification_entry(),
            _assistant_entry(),
            _assistant_entry(parent_id="later", stop_reason="stop"),
        ]
    )

    assert _retryable_api_error_from_session_stream(stream) is None


@pytest.mark.parametrize(
    "entry",
    [
        "not json",
        json.dumps({"type": "custom", "customType": "kimchi_error_classification", "data": "bad"}),
        _classification_entry(retryable=False),
        _classification_entry(is_infrastructure=False),
        _classification_entry(exit_code=None, http_status_code=None),
        _classification_entry(exit_code=1),
    ],
)
def test_malformed_or_non_infra_classification_fails_closed(entry: str) -> None:
    stream = "\n".join([entry, _assistant_entry()])

    assert _retryable_api_error_from_session_stream(stream) is None


def test_ferment_v2_evaluator_usage_model_rejects_invalid_numbers() -> None:
    valid_usage = {
        "input": 1,
        "output": 2,
        "cacheRead": 3,
        "cacheWrite": 4,
        "totalTokens": 10,
        "costUsd": 0.25,
    }

    assert _parse_ferment_v2_evaluator_usage(valid_usage) is not None
    assert _parse_ferment_v2_evaluator_usage({**valid_usage, "input": -1}) is None
    assert _parse_ferment_v2_evaluator_usage({**valid_usage, "costUsd": float("inf")}) is None


def test_populate_context_bills_ferment_v2_evaluator_usage(tmp_path: Path) -> None:
    logs_dir = tmp_path / "jobs" / "run-1" / "task__trial" / "agent"
    sessions_dir = logs_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    (sessions_dir / "main.jsonl").write_text(
        '{"type":"message","message":{"role":"assistant","usage":'
        '{"input":10,"output":3,"cacheRead":2,"cacheWrite":1,"cost":{"total":0.5}}}}\n'
        + evaluator_usage_entry("g1", 8)
        + "\n"
    )

    agent = Kimchi(logs_dir=logs_dir, model_name="kimchi-dev/kimi-k2.6")
    context = AgentContext()
    agent.populate_context_post_run(context)

    assert context.n_input_tokens == 21  # 10 + 2 + 1 assistant, plus 8 evaluator
    assert context.n_output_tokens == 3
    assert context.n_cache_tokens == 2
    assert context.cost_usd == 1.3


def test_populate_context_sums_evaluator_calls_across_sessions_and_ferment_v2_runs(tmp_path: Path) -> None:
    logs_dir = tmp_path / "jobs" / "run-1" / "task__trial" / "agent"
    sessions_dir = logs_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    (sessions_dir / "main.jsonl").write_text(
        "\n".join(
            [
                evaluator_usage_entry("g1", 10),
                evaluator_usage_entry("g1", 10),
                evaluator_usage_entry("g1", 10),
                evaluator_usage_entry("g2", 5),
            ]
        )
        + "\n"
    )
    # A child session contributes its own evaluator calls.
    (sessions_dir / "child.jsonl").write_text(evaluator_usage_entry("g1", 7) + "\n")

    agent = Kimchi(logs_dir=logs_dir, model_name="kimchi-dev/kimi-k2.6")
    context = AgentContext()
    agent.populate_context_post_run(context)

    # Every call is billable, including a replaced Ferment V2 run and a child session.
    assert context.n_input_tokens == 42
    assert context.n_output_tokens == 0
    assert context.n_cache_tokens == 0
    assert context.cost_usd == 4.2


def test_populate_context_ignores_malformed_evaluator_entries(tmp_path: Path) -> None:
    logs_dir = tmp_path / "jobs" / "run-1" / "task__trial" / "agent"
    sessions_dir = logs_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    valid = json.loads(evaluator_usage_entry("g1", 4))
    usage = valid["data"]["usage"]
    malformed = [
        {"op": "evaluator_usage", "fermentV2Id": "f1", "revision": 1, "usage": usage},
        {"op": "evaluator_usage", "sessionId": "session-a", "fermentV2Id": "f1", "revision": 1, "usage": {"input": 99}},
        {"op": "evaluator_usage", "sessionId": "session-a", "fermentV2Id": "f1", "revision": True, "usage": usage},
    ]
    entries = [{"type": "custom", "customType": "kimchi_ferment_v2_state", "data": data} for data in malformed]
    entries.append(valid)
    (sessions_dir / "main.jsonl").write_text("".join(json.dumps(entry) + "\n" for entry in entries))

    agent = Kimchi(logs_dir=logs_dir, model_name="kimchi-dev/kimi-k2.6")
    context = AgentContext()
    agent.populate_context_post_run(context)

    assert context.n_input_tokens == 4
    assert context.cost_usd == 0.4


def evaluator_usage_entry(ferment_v2_id: str, input_tokens: int) -> str:
    usage = {
        "input": input_tokens,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": input_tokens,
        "costUsd": input_tokens / 10,
    }
    return json.dumps(
        {
            "type": "custom",
            "customType": "kimchi_ferment_v2_state",
            "data": {
                "op": "evaluator_usage",
                "sessionId": "session-a",
                "fermentV2Id": ferment_v2_id,
                "revision": 1,
                "usage": usage,
            },
        }
    )


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
