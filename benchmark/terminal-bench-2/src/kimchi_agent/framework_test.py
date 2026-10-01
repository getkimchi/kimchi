"""Regression tests for framework-matched AgentInfo construction.

The agent classes extend pier's BaseInstalledAgent (so pier's deep-swe runner
populates per-trial token context), but both Harbor (terminal-bench-2) and
Pier (deep-swe) load the same classes. Each framework's pydantic TrialResult
only accepts its OWN AgentInfo type, and TrialResult is constructed with
agent_info at trial INIT — returning the wrong type crashes every trial of
the other benchmark at startup.
"""

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from harbor.models.trial.result import AgentInfo as HarborAgentInfo
from pier.models.trial.result import AgentInfo as PierAgentInfo
from pydantic import BaseModel, ValidationError

from kimchi_agent.agent import Kimchi
from kimchi_agent.framework import agent_info_types, using_pier
from kimchi_agent.gsd_kimchi import GsdKimchi
from kimchi_agent.pi_kimchi import PiKimchi


@pytest.fixture(autouse=True)
def agent_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIMCHI_API_KEY", "test-key")
    monkeypatch.delenv("USE_PIER", raising=False)


def _agents(tmp_path: Path) -> list:
    logs = tmp_path / "agent"
    return [
        Kimchi(logs_dir=logs / "kimchi", model_name="kimchi-dev/kimi-k2.6"),
        PiKimchi(logs_dir=logs / "pi", model_name="kimchi-dev/kimi-k2.6"),
        GsdKimchi(logs_dir=logs / "gsd", model_name="kimchi-dev/kimi-k2.6"),
    ]


def test_using_pier_defaults_to_false(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(sys.modules, "pier.trial.trial", raising=False)
    assert using_pier() is False


def test_using_pier_true_via_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USE_PIER", "true")
    assert using_pier() is True


def test_agent_info_uses_harbor_types_under_harbor_run(tmp_path: Path) -> None:
    AgentInfo, _ = agent_info_types()
    assert AgentInfo is HarborAgentInfo
    for agent in _agents(tmp_path):
        assert type(agent.to_agent_info()) is HarborAgentInfo


def test_agent_info_uses_pier_types_under_pier_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("USE_PIER", "true")
    AgentInfo, _ = agent_info_types()
    assert AgentInfo is PierAgentInfo
    for agent in _agents(tmp_path):
        assert type(agent.to_agent_info()) is PierAgentInfo


class _HarborInfoField(BaseModel):
    """Mirrors the agent_info field of harbor's TrialResult."""

    agent_info: HarborAgentInfo


class _PierInfoField(BaseModel):
    """Mirrors the agent_info field of pier's TrialResult."""

    agent_info: PierAgentInfo


def test_harbor_trial_result_accepts_harbor_run_agent_info(tmp_path: Path) -> None:
    """Harbor constructs TrialResult(agent_info=...) at trial init — it must not raise."""
    for agent in _agents(tmp_path):
        result = _HarborInfoField(agent_info=agent.to_agent_info())
        assert result.agent_info.name == agent.name()


def test_pier_trial_result_accepts_pier_run_agent_info(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("USE_PIER", "true")
    for agent in _agents(tmp_path):
        result = _PierInfoField(agent_info=agent.to_agent_info())
        assert result.agent_info.name == agent.name()


def test_pier_agent_info_is_rejected_by_harbor_trial_result() -> None:
    """Sanity check that the type-matching tests aren't vacuous."""
    with pytest.raises(ValidationError):
        _HarborInfoField(agent_info=PierAgentInfo(name="x", version="y"))


def test_harbor_compat_extra_env_session_and_context_ids(tmp_path: Path) -> None:
    """Harbor's trial runner reads extra_env and assigns session/context ids.

    Pier's BaseAgent predates those members upstream; the compat mixin must
    supply them or Harbor crashes in _prepare with AttributeError.
    """
    logs = tmp_path / "agent"
    agents = [
        Kimchi(logs_dir=logs / "kimchi", model_name="kimchi-dev/kimi-k2.6", extra_env={"K": "V"}),
        PiKimchi(logs_dir=logs / "pi", model_name="kimchi-dev/kimi-k2.6", extra_env={"K": "V"}),
        GsdKimchi(logs_dir=logs / "gsd", model_name="kimchi-dev/kimi-k2.6", extra_env={"K": "V"}),
    ]
    for agent in agents:
        assert agent.extra_env == {"K": "V"}
        assert agent.session_id is None
        assert agent.context_id is None
        # Returned mapping is a copy — mutating it does not leak back.
        agent.extra_env["OTHER"] = "X"
        assert agent.extra_env == {"K": "V"}
        # Harbor trial assigns these on the instance.
        agent.session_id = "trial__agent"
        assert agent.session_id == "trial__agent"


class _HarborLikeEnv:
    """Harbor DockerEnvironment surface: exec only, no agent_process_env."""

    def __init__(self):
        self.calls: list[dict] = []

    async def exec(self, command, user=None, env=None, cwd=None, timeout_sec=None):
        self.calls.append({"command": command, "user": user, "env": env})
        return SimpleNamespace(return_code=0, stdout="ok", stderr="")


class _PierLikeEnv(_HarborLikeEnv):
    """Pier DockerEnvironment surface: exec + agent_process_env (egress proxy)."""

    def agent_process_env(self, env):
        return {**{"HTTP_PROXY": "http://proxy:8080"}, **(env or {})}


async def test_exec_passes_env_through_on_harbor_environment(tmp_path: Path) -> None:
    """Harbor scopes extra_env on the environment; per-exec env passes through."""
    agent = Kimchi(
        logs_dir=tmp_path / "agent",
        model_name="kimchi-dev/kimi-k2.6",
        extra_env={"SCOPED": "1"},
    )
    env = _HarborLikeEnv()
    await agent.exec_as_root(env, command="echo hi", env={"PER_EXEC": "2"})

    # No AttributeError on agent_process_env; per-exec env unchanged;
    # extra_env NOT merged here (harbor's scoped_exec_env owns it).
    assert env.calls[0]["env"] == {"PER_EXEC": "2"}


async def test_exec_merges_extra_env_through_agent_process_env_on_pier(tmp_path: Path) -> None:
    """Pier environments get pier's semantics: extra_env + egress-proxy env."""
    agent = Kimchi(
        logs_dir=tmp_path / "agent",
        model_name="kimchi-dev/kimi-k2.6",
        extra_env={"KIMCHI_API_KEY": "k"},
    )
    env = _PierLikeEnv()
    await agent.exec_as_agent(env, command="echo hi")

    assert env.calls[0]["env"] == {"HTTP_PROXY": "http://proxy:8080", "KIMCHI_API_KEY": "k"}


class _FailingEnv(_HarborLikeEnv):
    def __init__(self, return_code=1, stdout="", stderr=""):
        super().__init__()
        self._result = SimpleNamespace(return_code=return_code, stdout=stdout, stderr=stderr)

    async def exec(self, command, user=None, env=None, cwd=None, timeout_sec=None):
        self.calls.append({"command": command, "user": user, "env": env})
        return self._result


class _FailingPierEnv(_FailingEnv):
    def agent_process_env(self, env):
        return env


async def test_exec_failure_uses_agent_classifier_on_both_runners(tmp_path: Path) -> None:
    """Harbor's _exec dispatched to _classify_exec_error — the shim must too,
    or KimchiExitError (which classify.py's infra breaker keys on) is lost."""
    from kimchi_agent.agent import KimchiExitError

    envs = [
        _FailingEnv(return_code=74, stdout="out", stderr="err"),
        _FailingPierEnv(return_code=74, stdout="out", stderr="err"),
    ]
    for env in envs:
        agent = Kimchi(logs_dir=tmp_path / "agent", model_name="kimchi-dev/kimi-k2.6")
        with pytest.raises(KimchiExitError) as raised:
            await agent.exec_as_agent(env, command="bad")
        assert raised.value.exit_code == 74
        assert raised.value.stdout == "out"


async def test_exec_failure_falls_back_to_harbor_error_patterns_on_harbor(tmp_path: Path) -> None:
    """Agents without a custom classifier (GsdKimchi) used Harbor's
    ERROR_PATTERNS subtypes on the benchmarks branch — classify.py matches
    NetworkConnectionError by exception type."""
    from harbor.agents.installed.base import NetworkConnectionError as HarborNetworkError

    agent = GsdKimchi(logs_dir=tmp_path / "gsd", model_name="kimchi-dev/kimi-k2.6")
    env = _FailingEnv(stderr="curl: (6) Could not resolve host: registry.example")

    with pytest.raises(HarborNetworkError):
        await agent.exec_as_agent(env, command="npm ci")


async def test_exec_failure_raises_plain_pier_error_on_pier_for_unclassified(tmp_path: Path) -> None:
    """On pier environments, pier's own semantics apply: plain pier
    NonZeroAgentExitCodeError when no agent classifier matches."""
    from pier.agents.installed.base import NonZeroAgentExitCodeError as PierNAECE

    agent = GsdKimchi(logs_dir=tmp_path / "gsd", model_name="kimchi-dev/kimi-k2.6")
    env = _FailingPierEnv(stderr="Could not resolve host: registry.example")

    with pytest.raises(PierNAECE):
        await agent.exec_as_agent(env, command="npm ci")
