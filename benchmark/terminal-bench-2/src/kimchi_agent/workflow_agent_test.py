import asyncio
from pathlib import Path

import pytest

from kimchi_agent.agent import KIMCHI_INFRA_BREAKER_THRESHOLD_ENV
from kimchi_agent.workflow_agent import (
    WORKFLOW_BUNDLE_CONTAINER_PATH,
    WORKFLOW_BUNDLE_HOST_PATH_ENV,
    WORKFLOW_ENTRY_RELPATH,
    WORKFLOW_SRC_CONTAINER_DIR,
    WORKFLOW_SRC_HOST_PATH_ENV,
    LocalWorkflowKimchi,
    WorkflowKimchi,
)


class FakeEnvironment:
    def __init__(self) -> None:
        self.uploaded_dirs: list[tuple[Path, str]] = []
        self.uploaded_files: list[tuple[Path, str]] = []
        #: Contents of each uploaded dir, captured before the staging dir is deleted.
        self.uploaded_trees: list[list[str]] = []

    async def upload_dir(self, source_dir, target_dir: str) -> None:
        source = Path(source_dir)
        self.uploaded_dirs.append((source, target_dir))
        self.uploaded_trees.append(sorted(str(p.relative_to(source)) for p in source.rglob("*")))

    async def upload_file(self, source_path, target_path: str) -> None:
        self.uploaded_files.append((Path(source_path), target_path))


class RecordingLocalWorkflowKimchi(LocalWorkflowKimchi):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.root_commands: list[str] = []

    async def exec_as_root(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.root_commands.append(command)


@pytest.fixture(autouse=True)
def kimchi_test_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIMCHI_API_KEY", "test-key")
    monkeypatch.delenv("KIMCHI_CODE_BINARY", raising=False)
    monkeypatch.delenv("KIMCHI_TAGS", raising=False)
    monkeypatch.delenv(KIMCHI_INFRA_BREAKER_THRESHOLD_ENV, raising=False)
    monkeypatch.delenv(WORKFLOW_BUNDLE_HOST_PATH_ENV, raising=False)
    monkeypatch.delenv(WORKFLOW_SRC_HOST_PATH_ENV, raising=False)


def make_checkout(root: Path) -> Path:
    """A pi-workflows checkout, complete with a node_modules that must not travel."""
    checkout = root / "pi-workflows"
    (checkout / "benchmarks" / "terminal-bench").mkdir(parents=True)
    (checkout / WORKFLOW_ENTRY_RELPATH).write_text("export default function ext() {}\n")
    (checkout / "src" / "engine").mkdir(parents=True)
    (checkout / "src" / "engine" / "run-workflow.ts").write_text("export const run = 1\n")
    (checkout / "package.json").write_text('{"name": "pi-workflows"}\n')
    (checkout / "node_modules" / "typebox").mkdir(parents=True)
    (checkout / "node_modules" / "typebox" / "index.js").write_text("// 289MB of this\n")
    (checkout / "test").mkdir()
    (checkout / "test" / "engine.test.ts").write_text("// not imported\n")
    return checkout


def make_agent(tmp_path: Path) -> RecordingLocalWorkflowKimchi:
    return RecordingLocalWorkflowKimchi(
        logs_dir=tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        model_name="kimchi-dev/kimi-k2.7",
    )


def test_local_agent_points_extension_flag_at_the_checkout_entrypoint(tmp_path: Path) -> None:
    agent = make_agent(tmp_path)

    command = agent._kimchi_command("--yolo")

    assert f"-e {WORKFLOW_SRC_CONTAINER_DIR}/{WORKFLOW_ENTRY_RELPATH}" in command
    assert WORKFLOW_BUNDLE_CONTAINER_PATH not in command


def test_bundle_agent_keeps_pointing_at_the_bundle(tmp_path: Path) -> None:
    agent = WorkflowKimchi(
        logs_dir=tmp_path / "agent",
        model_name="kimchi-dev/kimi-k2.7",
    )

    assert f"-e {WORKFLOW_BUNDLE_CONTAINER_PATH}" in agent._kimchi_command("")


def test_local_install_uploads_sources_without_node_modules(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    checkout = make_checkout(tmp_path)
    monkeypatch.setenv(WORKFLOW_SRC_HOST_PATH_ENV, str(checkout))
    agent = make_agent(tmp_path)
    environment = FakeEnvironment()

    asyncio.run(agent._install_extension(environment))

    assert len(environment.uploaded_dirs) == 1
    _, target_dir = environment.uploaded_dirs[0]
    assert target_dir == WORKFLOW_SRC_CONTAINER_DIR

    uploaded = environment.uploaded_trees[0]
    assert WORKFLOW_ENTRY_RELPATH in uploaded
    assert "src/engine/run-workflow.ts" in uploaded
    assert "package.json" in uploaded
    assert not any(entry.startswith("node_modules") for entry in uploaded)
    assert not any(entry.startswith("test") for entry in uploaded)

    # The staging copy is temporary; nothing may outlive the upload.
    source_dir, _ = environment.uploaded_dirs[0]
    assert not source_dir.exists()

    assert f"mkdir -p {WORKFLOW_SRC_CONTAINER_DIR}" in agent.root_commands[0]
    assert f"chmod -R a+rX {WORKFLOW_SRC_CONTAINER_DIR}" in agent.root_commands[-1]


def test_local_install_requires_the_env_var(tmp_path: Path) -> None:
    agent = make_agent(tmp_path)

    with pytest.raises(RuntimeError, match=WORKFLOW_SRC_HOST_PATH_ENV):
        asyncio.run(agent._install_extension(FakeEnvironment()))


def test_local_install_rejects_a_directory_without_the_extension(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(WORKFLOW_SRC_HOST_PATH_ENV, str(tmp_path))
    agent = make_agent(tmp_path)

    with pytest.raises(RuntimeError, match="No workflow extension at"):
        asyncio.run(agent._install_extension(FakeEnvironment()))
