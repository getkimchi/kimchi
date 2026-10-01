"""PiWorkflowAgent: stock pi hosting a kimchi-workflows workflow."""

import asyncio
import json
import shlex
from datetime import UTC
from pathlib import Path

import pytest
from harbor.models.agent.context import AgentContext

import kimchi_agent.pi_workflow as pi_workflow_module
from kimchi_agent.pi_workflow import (
    CONTAINER_EXTENSION_DIR,
    CONTAINER_WORKFLOWS_STAGE_DIR,
    DEADLINE_MARGIN_SEC,
    DEFAULT_TIMEOUT_SEC,
    PROJECT_DIR,
    PROJECT_WORKFLOWS_DIR,
    WORKFLOW_INPUT_PATH,
    PiWorkflowAgent,
)
from kimchi_agent.workflow_extension import ResolvedExtension


class RecordingPiWorkflowAgent(PiWorkflowAgent):
    """Records what would have been run, and stops at the launch command."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.agent_commands: list[str] = []
        self.agent_envs: list[dict[str, str] | None] = []
        self.root_commands: list[str] = []
        self.setup_commands: list[str] = []

    async def exec_as_agent(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        if "pi --print" not in command and "--extension" not in command:
            self.setup_commands.append(command)
            return
        self.agent_commands.append(command)
        self.agent_envs.append(env)
        raise asyncio.CancelledError

    async def exec_as_root(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.root_commands.append(command)


class FakeEnvironment:
    def __init__(self) -> None:
        self.uploaded_dirs: list[tuple[str, str]] = []

    async def upload_dir(self, source_dir, target_dir: str) -> None:
        self.uploaded_dirs.append((str(source_dir), target_dir))

    async def exec(self, command: str, **_kwargs):  # pragma: no cover - unused here
        raise AssertionError("no bundle is staged in these tests")


@pytest.fixture(autouse=True)
def kimchi_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIMCHI_API_KEY", "test-key")
    monkeypatch.delenv("TB_AGENT_TIMEOUT_SEC", raising=False)


@pytest.fixture
def workflows_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fixture workflows/ tree, standing in for the repo's own."""
    source = tmp_path / "workflows"
    source.mkdir()
    (source / "deep-solve.workflow.ts").write_text("// deep-solve")
    monkeypatch.setattr(pi_workflow_module, "WORKFLOWS_HOST_DIR", source)
    return source


def _resolver(host_dir: Path, short_identity: str = "npm:@kimchi-dev/kimchi-workflows@1.2.3+abc"):
    def resolve(_spec) -> ResolvedExtension:
        return ResolvedExtension(
            host_dir=host_dir,
            identity=f"long-{short_identity}",
            short_identity=short_identity,
        )

    return resolve


def _agent(tmp_path: Path, extension_host_dir: Path, **kwargs) -> RecordingPiWorkflowAgent:
    logs_dir = kwargs.pop("logs_dir", tmp_path / "jobs" / "run-1" / "task__trial" / "agent")
    logs_dir.mkdir(parents=True, exist_ok=True)
    ext_source = tmp_path / "pi-kimchi-provider"
    ext_source.mkdir(exist_ok=True)
    (ext_source / "package.json").write_text("{}")
    return RecordingPiWorkflowAgent(
        logs_dir=logs_dir,
        model_name=kwargs.pop("model_name", "kimchi-dev/kimi-k2.7"),
        extension=kwargs.pop("extension", "npm:@kimchi-dev/kimchi-workflows@latest"),
        workflow=kwargs.pop("workflow", "deep-solve"),
        extension_resolver=_resolver(extension_host_dir),
        **{"extension-source-dir": str(ext_source)},
        **kwargs,
    )


async def _launch_command(agent: RecordingPiWorkflowAgent, instruction: str = "solve it") -> str:
    environment = FakeEnvironment()
    await agent.install(environment)
    with pytest.raises(asyncio.CancelledError):
        await agent.run(instruction, environment, AgentContext())
    return agent.agent_commands[0]


# -- required kwargs ------------------------------------------------------


def test_requires_extension_kwarg(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="requires an 'extension' agent kwarg"):
        PiWorkflowAgent(logs_dir=tmp_path, model_name="kimchi-dev/kimi-k2.7", workflow="deep-solve")


def test_requires_workflow_kwarg(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="requires a 'workflow' agent kwarg"):
        PiWorkflowAgent(
            logs_dir=tmp_path,
            model_name="kimchi-dev/kimi-k2.7",
            extension="npm:@kimchi-dev/kimchi-workflows@latest",
        )


def test_rejects_a_bad_extension_spec_at_construction(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        PiWorkflowAgent(
            logs_dir=tmp_path,
            model_name="kimchi-dev/kimi-k2.7",
            extension="git+https://example.invalid/kimchi-workflows.git",
            workflow="deep-solve",
        )


# -- install --------------------------------------------------------------


@pytest.mark.asyncio
async def test_install_uploads_extension_and_workflows(tmp_path: Path, workflows_dir: Path) -> None:
    extension_host = tmp_path / "resolved-extension"
    extension_host.mkdir()
    agent = _agent(tmp_path, extension_host)
    environment = FakeEnvironment()

    await agent.install(environment)

    targets = [target for _, target in environment.uploaded_dirs]
    assert CONTAINER_EXTENSION_DIR in targets
    assert CONTAINER_WORKFLOWS_STAGE_DIR in targets


@pytest.mark.asyncio
async def test_install_strips_dev_only_scaffolding_from_the_workflows_upload(
    tmp_path: Path, workflows_dir: Path
) -> None:
    (workflows_dir / "node_modules").mkdir()
    (workflows_dir / "node_modules" / "marker").write_text("x")
    (workflows_dir / "test").mkdir()
    (workflows_dir / "test" / "deep-solve.test.ts").write_text("// test")
    (workflows_dir / "package.json").write_text("{}")
    (workflows_dir / "ferment").mkdir()
    (workflows_dir / "ferment" / "contract.ts").write_text("// helper")

    uploaded: dict[str, list[str]] = {}

    class CapturingEnvironment(FakeEnvironment):
        async def upload_dir(self, source_dir, target_dir: str) -> None:
            await super().upload_dir(source_dir, target_dir)
            if target_dir == CONTAINER_WORKFLOWS_STAGE_DIR:
                uploaded[target_dir] = sorted(
                    str(path.relative_to(source_dir)) for path in Path(source_dir).rglob("*")
                )

    agent = _agent(tmp_path, tmp_path / "resolved-extension")
    (tmp_path / "resolved-extension").mkdir()
    await agent.install(CapturingEnvironment())

    staged = uploaded[CONTAINER_WORKFLOWS_STAGE_DIR]
    assert "deep-solve.workflow.ts" in staged
    # Helper modules a workflow imports by relative path must survive.
    assert "ferment/contract.ts" in staged
    assert not any(name.startswith("node_modules") for name in staged)
    assert not any(name.startswith("test") for name in staged)
    assert "package.json" not in staged


@pytest.mark.asyncio
async def test_install_fails_when_no_workflow_can_resolve_by_name(
    tmp_path: Path, workflows_dir: Path
) -> None:
    (workflows_dir / "deep-solve.workflow.ts").unlink()
    nested = workflows_dir / "nested"
    nested.mkdir()
    (nested / "deep-solve.workflow.ts").write_text("// deep-solve")

    agent = _agent(tmp_path, tmp_path / "resolved-extension")
    (tmp_path / "resolved-extension").mkdir()

    with pytest.raises(RuntimeError, match="non-recursive scan"):
        await agent.install(FakeEnvironment())


# -- launch ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_extension_is_loaded_by_flag_not_by_auto_discovery(
    tmp_path: Path, workflows_dir: Path
) -> None:
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension")

    command = await _launch_command(agent)

    assert f"--extension {CONTAINER_EXTENSION_DIR}" in command
    assert command.index("--extension") < command.index("--print")


@pytest.mark.asyncio
async def test_instruction_travels_in_the_envelope_never_on_the_command_line(
    tmp_path: Path, workflows_dir: Path
) -> None:
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension")

    command = await _launch_command(agent, "- fix the repo")

    assert f"/workflow run deep-solve --input @{WORKFLOW_INPUT_PATH}" in command
    stdin_payload = shlex.quote(f"/workflow run deep-solve --input @{WORKFLOW_INPUT_PATH}")
    assert f"printf '%s' {stdin_payload}" in command


@pytest.mark.asyncio
async def test_envelope_carries_the_instruction_and_a_deadline(
    tmp_path: Path, workflows_dir: Path
) -> None:
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension")

    command = await _launch_command(agent, "solve it")

    # Recover the envelope the launch command writes.
    marker = f"> {shlex.quote(WORKFLOW_INPUT_PATH)}"
    write_command = next(part for part in command.split(" && ") if marker in part)
    quoted = write_command[len("printf '%s' ") : write_command.index(marker)].strip()
    envelope = json.loads(shlex.split(quoted)[0])

    assert envelope["instruction"] == "solve it"
    assert envelope["deadlineIso"].endswith("Z")


@pytest.mark.asyncio
async def test_workflows_are_staged_into_the_project_dir_by_relative_path(
    tmp_path: Path, workflows_dir: Path
) -> None:
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension")

    command = await _launch_command(agent)

    assert (
        f"mkdir -p {shlex.quote(PROJECT_WORKFLOWS_DIR)} && "
        f"cp -a {shlex.quote(CONTAINER_WORKFLOWS_STAGE_DIR)}/. {shlex.quote(PROJECT_WORKFLOWS_DIR)}/"
    ) in command
    assert not PROJECT_WORKFLOWS_DIR.startswith("/")
    assert PROJECT_WORKFLOWS_DIR == ".pi/workflows"


@pytest.mark.asyncio
async def test_project_dir_is_removed_after_the_run_without_changing_the_exit_status(
    tmp_path: Path, workflows_dir: Path
) -> None:
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension")

    command = await _launch_command(agent)

    assert f"rm -rf {shlex.quote(PROJECT_DIR)}" in command
    assert command.index("agent_status=$?") < command.index(f"rm -rf {shlex.quote(PROJECT_DIR)}")
    assert command.index(f"rm -rf {shlex.quote(PROJECT_DIR)}") < command.index('exit "$agent_status"')


@pytest.mark.asyncio
async def test_run_env_carries_the_budget_and_the_model(tmp_path: Path, workflows_dir: Path) -> None:
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension")

    await _launch_command(agent)

    env = agent.agent_envs[0]
    assert env["KIMCHI_API_KEY"] == "test-key"
    assert env["TB_AGENT_TIMEOUT_SEC"] == str(DEFAULT_TIMEOUT_SEC)
    assert env["TB_MODEL"] == "kimchi-dev/kimi-k2.7"


# -- the reconstructed clock ---------------------------------------------


def _trial_config(tmp_path: Path, config: dict) -> Path:
    trial_dir = tmp_path / "jobs" / "run-1" / "task__trial"
    logs_dir = trial_dir / "agent"
    logs_dir.mkdir(parents=True, exist_ok=True)
    (trial_dir / "config.json").write_text(json.dumps(config))
    return logs_dir


def test_timeout_falls_back_to_the_default_without_a_trial_config(tmp_path: Path) -> None:
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension")
    assert agent._timeout_sec() == DEFAULT_TIMEOUT_SEC


def test_timeout_uses_the_override_and_applies_the_multiplier(tmp_path: Path) -> None:
    logs_dir = _trial_config(
        tmp_path,
        {"agent": {"override_timeout_sec": 600}, "timeout_multiplier": 2},
    )
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension", logs_dir=logs_dir)

    assert agent._timeout_sec() == 1200


def test_agent_timeout_multiplier_wins_over_the_general_one(tmp_path: Path) -> None:
    logs_dir = _trial_config(
        tmp_path,
        {
            "agent": {"override_timeout_sec": 600},
            "timeout_multiplier": 5,
            "agent_timeout_multiplier": 2,
        },
    )
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension", logs_dir=logs_dir)

    assert agent._timeout_sec() == 1200


def test_max_timeout_caps_the_base_before_the_multiplier(tmp_path: Path) -> None:
    logs_dir = _trial_config(
        tmp_path,
        {"agent": {"override_timeout_sec": 900, "max_timeout_sec": 300}, "timeout_multiplier": 2},
    )
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension", logs_dir=logs_dir)

    assert agent._timeout_sec() == 600


def test_explicit_env_override_wins_over_everything(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TB_AGENT_TIMEOUT_SEC", "300")
    logs_dir = _trial_config(
        tmp_path,
        {"agent": {"override_timeout_sec": 3600}, "timeout_multiplier": 4},
    )
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension", logs_dir=logs_dir)

    assert agent._timeout_sec() == 300


def test_deadline_is_pulled_back_from_the_hard_kill(tmp_path: Path) -> None:
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension")

    from datetime import datetime

    before = datetime.now(UTC)
    deadline = datetime.fromisoformat(agent._deadline_iso(600).replace("Z", "+00:00"))
    elapsed = (deadline - before).total_seconds()

    assert 600 - DEADLINE_MARGIN_SEC - 5 <= elapsed <= 600 - DEADLINE_MARGIN_SEC + 5


# -- identity -------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_info_records_the_workflow_and_the_resolved_extension(
    tmp_path: Path, workflows_dir: Path
) -> None:
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension")
    await agent.install(FakeEnvironment())

    info = agent.to_agent_info()

    assert info.name == "pi-kimchi-workflow"
    assert "deep-solve@npm:@kimchi-dev/kimchi-workflows@1.2.3+abc" in info.version
    assert info.model_info.name == "kimchi-dev/kimi-k2.7"


def test_agent_info_preserves_native_moonshot_provider(tmp_path: Path) -> None:
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(
        tmp_path,
        tmp_path / "resolved-extension",
        model_name="moonshotai/kimi-k3",
    )

    info = agent.to_agent_info()

    assert info.model_info.name == "moonshotai/kimi-k3"
    assert info.model_info.provider == "moonshotai"


def test_agent_info_before_install_says_the_extension_is_unresolved(tmp_path: Path) -> None:
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension")
    assert "unresolved" in agent.to_agent_info().version


def test_workflow_name_is_passed_through_untouched(tmp_path: Path) -> None:
    (tmp_path / "resolved-extension").mkdir()
    agent = _agent(tmp_path, tmp_path / "resolved-extension", workflow="ferment-oneshot")
    assert agent._stdin_payload("ignored").startswith("/workflow run ferment-oneshot ")


# These two contract tests read the in-repo workflows/deep-solve.workflow.ts as a
# fixture. The workflows/ package is not part of this repo's port (kimchi2): the
# adapter resolves the workflow at runtime from the published
# @kimchi-dev/kimchi-workflows npm package, so the runtime contract is still
# exercised. Skipped until the workflows source is ported alongside.


@pytest.mark.skip(
    reason="workflows/ excluded from kimchi2 port; runtime uses published @kimchi-dev/kimchi-workflows"
)
def test_deep_solve_workflow_is_present_and_resolvable_by_name() -> None:
    source = Path(__file__).parent.parent.parent / "workflows" / "deep-solve.workflow.ts"
    assert source.is_file(), "workflows/deep-solve.workflow.ts is what agent=pi-workflow runs"
    assert 'name: "deep-solve"' in source.read_text()


@pytest.mark.skip(
    reason="workflows/ excluded from kimchi2 port; runtime uses published @kimchi-dev/kimchi-workflows"
)
def test_deep_solve_requires_the_deadline_this_adapter_supplies() -> None:
    source = Path(__file__).parent.parent.parent / "workflows" / "deep-solve.workflow.ts"
    text = source.read_text()
    assert "deadlineIso: Type.String()" in text
    assert "TB_AGENT_TIMEOUT_SEC" in text
