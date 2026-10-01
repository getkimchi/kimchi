"""Conformance contract for kimchi-family agents.

Every kimchi-family agent must produce the same ``result.json`` shape —
``agent_info.name``/``version``, token/cost accounting, the env dict shape,
prompt-template rendering. This file makes that contract real: a
conformance test parameterised over every kimchi-family agent. Adding an
agent means adding it to the parameter list; the test fails if its artifacts
diverge.

So this file, not the ``WorkflowAgent(Kimchi)`` class declaration, is the
actual deliverable: extend ``KIMCHI_FAMILY_AGENTS`` when a new kimchi-family
agent is added, and these tests hold it to the same contract as everything
before it with zero new code.
"""

import asyncio
import json
from pathlib import Path

import pytest
from harbor.models.agent.context import AgentContext

from kimchi_agent.agent import Kimchi
from kimchi_agent.pi_kimchi import PiKimchi
from kimchi_agent.pi_workflow import PiWorkflowAgent
from kimchi_agent.workflow_agent import WorkflowAgent


class _RecordingExecMixin:
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.agent_commands: list[str] = []
        self.agent_envs: list[dict[str, str] | None] = []

    async def exec_as_agent(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.agent_commands.append(command)
        self.agent_envs.append(env)
        raise asyncio.CancelledError

    async def exec_as_root(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        pass


class RecordingKimchi(_RecordingExecMixin, Kimchi):
    pass


class RecordingWorkflowAgent(_RecordingExecMixin, WorkflowAgent):
    pass


# The parameter list IS the conformance surface: every kimchi-family agent
# must appear here. `ids` keeps failures readable ("FAILED ...[WorkflowAgent]"
# rather than "...[RecordingWorkflowAgent]").
KIMCHI_FAMILY_AGENTS = [RecordingKimchi, RecordingWorkflowAgent]
KIMCHI_FAMILY_AGENT_IDS = ["Kimchi", "WorkflowAgent"]


@pytest.fixture(autouse=True)
def kimchi_test_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIMCHI_API_KEY", "test-key")
    monkeypatch.delenv("KIMCHI_CODE_BINARY", raising=False)
    monkeypatch.delenv("KIMCHI_TAGS", raising=False)
    monkeypatch.delenv("RUN_ID", raising=False)


def _construct(agent_cls: type, logs_dir: Path, **kwargs):
    # WorkflowAgent's two required kwargs; every other kimchi-family agent
    # needs nothing extra to satisfy this contract — capabilities are added
    # to the base, never to individual agents.
    extra: dict[str, str] = {}
    if issubclass(agent_cls, WorkflowAgent):
        extra = {"extension": "dir:/unused/kimchi-workflows", "workflow": "tb-solver"}
    return agent_cls(logs_dir=logs_dir, model_name="kimchi-dev/kimi-k2.6", **extra, **kwargs)


def _assistant_session_line(
    *, input_tokens: int, output_tokens: int, cache_read: int, cache_write: int, cost: float
) -> str:
    return json.dumps(
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "usage": {
                    "input": input_tokens,
                    "output": output_tokens,
                    "cacheRead": cache_read,
                    "cacheWrite": cache_write,
                    "cost": {"total": cost},
                },
            },
        }
    ) + "\n"


@pytest.mark.parametrize("agent_cls", KIMCHI_FAMILY_AGENTS, ids=KIMCHI_FAMILY_AGENT_IDS)
def test_agent_info_name_and_version_are_non_empty(agent_cls: type, tmp_path: Path) -> None:
    logs_dir = tmp_path / "jobs" / "run-1" / "task__trial" / "agent"
    agent = _construct(agent_cls, logs_dir)

    info = agent.to_agent_info()

    assert info.name
    assert info.version


@pytest.mark.parametrize("agent_cls", KIMCHI_FAMILY_AGENTS, ids=KIMCHI_FAMILY_AGENT_IDS)
def test_sessions_are_aggregated_including_nested_directories(agent_cls: type, tmp_path: Path) -> None:
    # Regression fixture for the base correctness fix in agent.py
    # (populate_context_post_run's rglob): a session file nested under
    # sessions/workflow/ — exactly where kimchi-workflows writes per-step
    # sessions — must be counted for every kimchi-family agent, not
    # only ones that happen to write flat session files.
    logs_dir = tmp_path / "jobs" / "run-1" / "task__trial" / "agent"
    sessions_dir = logs_dir / "sessions"
    nested_dir = sessions_dir / "workflow"
    nested_dir.mkdir(parents=True)
    (sessions_dir / "main.jsonl").write_text(
        _assistant_session_line(input_tokens=10, output_tokens=3, cache_read=2, cache_write=1, cost=0.5)
    )
    (nested_dir / "step-1.jsonl").write_text(
        _assistant_session_line(input_tokens=20, output_tokens=5, cache_read=4, cache_write=0, cost=0.25)
    )

    agent = _construct(agent_cls, logs_dir)
    context = AgentContext()
    agent.populate_context_post_run(context)

    assert context.n_input_tokens > 0
    assert context.n_output_tokens > 0
    assert context.n_cache_tokens > 0
    assert context.cost_usd is not None
    assert context.cost_usd > 0


@pytest.mark.parametrize("agent_cls", KIMCHI_FAMILY_AGENTS, ids=KIMCHI_FAMILY_AGENT_IDS)
async def test_env_dict_carries_the_same_keys_as_stock_kimchi(agent_cls: type, tmp_path: Path) -> None:
    logs_dir = tmp_path / "jobs" / "run-1" / "task__trial" / "agent"

    stock = _construct(RecordingKimchi, logs_dir)
    with pytest.raises(asyncio.CancelledError):
        await stock.run("hello", object(), AgentContext())

    candidate = _construct(agent_cls, logs_dir)
    with pytest.raises(asyncio.CancelledError):
        await candidate.run("hello", object(), AgentContext())

    assert set(candidate.agent_envs[0].keys()) == set(stock.agent_envs[0].keys())


@pytest.mark.parametrize("agent_cls", KIMCHI_FAMILY_AGENTS, ids=KIMCHI_FAMILY_AGENT_IDS)
async def test_prompt_template_is_applied_exactly_once(agent_cls: type, tmp_path: Path) -> None:
    logs_dir = tmp_path / "jobs" / "run-1" / "task__trial" / "agent"
    template_path = tmp_path / "template.j2"
    template_path.write_text("TASK: {{ instruction }}")

    agent = _construct(agent_cls, logs_dir, prompt_template_path=template_path)
    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    command = agent.agent_commands[0]
    assert "TASK: hello" in command
    assert "TASK: TASK: hello" not in command


# The levels the CI `thinking_level` input offers (bench_config.THINKING_LEVELS
# in benchmark/scripts/gitlab — a separate uv project, so it cannot be imported
# here). Every agent that advertises --thinking must accept all of them: harbor
# validates the kwarg against `choices` and raises before the agent launches, so
# a stale list turns a valid CI selection into a hard run failure.
CI_THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")

THINKING_AGENTS = [
    pytest.param(Kimchi, id="kimchi"),
    pytest.param(WorkflowAgent, id="kimchi-workflow"),
    pytest.param(PiKimchi, id="pi"),
    pytest.param(PiWorkflowAgent, id="pi-workflow"),
]


@pytest.mark.parametrize("agent_cls", THINKING_AGENTS)
def test_thinking_flag_accepts_every_ci_level(agent_cls) -> None:
    flag = next(f for f in agent_cls.CLI_FLAGS if f.kwarg == "thinking")
    missing = [level for level in CI_THINKING_LEVELS if level not in (flag.choices or [])]

    assert not missing, f"{agent_cls.__name__} rejects CI thinking level(s): {missing}"
