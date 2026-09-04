"""kimchi + the kimchi-workflows pi extension, running one named workflow.

Uses only the hooks ``Kimchi`` exposes and never overrides ``run()`` (see
``Kimchi._extension_paths``). ``conformance_test.py`` enforces that this
produces the same ``result.json`` shape as stock ``Kimchi``.
"""

import json
import shlex
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING

from harbor.models.trial.result import AgentInfo

from kimchi_agent import workflow_staging
from kimchi_agent.agent import CONTAINER_LOGS_DIR, Kimchi
from kimchi_agent.workflow_extension import (
    ExtensionSpec,
    ResolvedExtension,
    parse_extension_spec,
    resolve_extension_spec,
)

if TYPE_CHECKING:
    from harbor.environments.base import BaseEnvironment

CONTAINER_EXTENSION_DIR = "/installed-agent/kimchi-workflows"
CONTAINER_WORKFLOWS_STAGE_DIR = "/installed-agent/workflows"

# Relative on purpose: the pre-launch commands run in the same shell, and so
# the same cwd, as kimchi itself, which is the project root the extension
# resolves workflow names against. Python cannot learn that path up front.
PROJECT_WORKFLOWS_DIR = ".kimchi/workflows"

WORKFLOW_INPUT_PATH = f"{CONTAINER_LOGS_DIR}/workflow-input.json"
WORKFLOWS_HOST_DIR = Path(__file__).parent.parent.parent / "workflows"

# Re-exported rather than defined here: PiWorkflowAgent stages the same
# directory the same way, and the denylist is pinned by tests in this module's
# suite. See workflow_staging for why the host dir is NOT shared alongside it.
WORKFLOWS_UPLOAD_IGNORE = workflow_staging.WORKFLOWS_UPLOAD_IGNORE

ExtensionResolver = Callable[[ExtensionSpec], ResolvedExtension]


class WorkflowAgent(Kimchi):
    """Runs a named kimchi-workflows workflow instead of kimchi's default chat loop.

    Two required kwargs: ``extension`` (``npm:`` or ``dir:``, resolved on the
    host and uploaded) and ``workflow`` (a declared workflow name, resolved by
    the extension against ``.kimchi/workflows/`` inside the container). See
    ``workflow_extension.parse_extension_spec`` for spec details.
    """

    @staticmethod
    def name() -> str:
        return "kimchi-workflow"

    def __init__(
        self,
        *args,
        extension_resolver: ExtensionResolver | None = None,
        **kwargs,
    ) -> None:
        extension_raw = kwargs.pop("extension", None)
        workflow = kwargs.pop("workflow", None)
        if not extension_raw or not str(extension_raw).strip():
            raise ValueError(
                "WorkflowAgent requires an 'extension' agent kwarg, e.g. "
                "--agent-kwarg extension=npm:@kimchi-dev/kimchi-workflows@0.1.0, or "
                "--agent-kwarg extension=dir:/path/to/kimchi-workflows"
            )
        if not workflow or not str(workflow).strip():
            raise ValueError(
                "WorkflowAgent requires a 'workflow' agent kwarg naming a declared "
                "workflow, e.g. --agent-kwarg workflow=tb-solver"
            )

        self._extension_spec: ExtensionSpec = parse_extension_spec(str(extension_raw))
        self._extension_raw = str(extension_raw)
        self._workflow = str(workflow)
        self._extension_short_identity: str | None = None
        self._resolve_extension: ExtensionResolver = extension_resolver or resolve_extension_spec

        super().__init__(*args, **kwargs)

    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)

        resolved = self._resolve_extension(self._extension_spec)
        self._extension_short_identity = resolved.short_identity
        # Unfiltered upload: the extension needs its node_modules (jiti lives
        # there). A dir: checkout uploads devDependencies too (~342 MB vs
        # single-digit MB for npm:).
        await environment.upload_dir(source_dir=resolved.host_dir, target_dir=CONTAINER_EXTENSION_DIR)

        # Staged before the guard so it inspects what will actually be uploaded.
        with tempfile.TemporaryDirectory(prefix="kimchi-workflows-stage-") as stage:
            stage_dir = Path(stage) / "workflows"
            shutil.copytree(WORKFLOWS_HOST_DIR, stage_dir, ignore=WORKFLOWS_UPLOAD_IGNORE)
            self._assert_a_workflow_can_resolve(stage_dir)
            await environment.upload_dir(source_dir=stage_dir, target_dir=CONTAINER_WORKFLOWS_STAGE_DIR)

    def _assert_a_workflow_can_resolve(self, staged_workflows: Path) -> None:
        workflow_staging.assert_a_workflow_can_resolve(
            staged_workflows=staged_workflows,
            workflow=self._workflow,
            workflows_host_dir=WORKFLOWS_HOST_DIR,
            project_workflows_dir=PROJECT_WORKFLOWS_DIR,
        )

    def _extension_paths(self) -> list[str]:
        # Both spec forms are uploaded to the same container path now —
        # there is no longer a passthrough form that needs the raw spec
        # string handed to `-e` verbatim.
        return [CONTAINER_EXTENSION_DIR]

    def _stdin_payload(self, instruction: str) -> str:
        # Instruction travels in the envelope file, not on stdin — so it can
        # never be mistaken for a flag (pi's parseArgs treats any token
        # starting with "-" as one).
        del instruction
        return f"/workflow run {self._workflow} --input @{WORKFLOW_INPUT_PATH}"

    def _pre_launch_commands(self, instruction: str) -> list[str]:
        envelope = json.dumps({"instruction": instruction})
        write_envelope = f"printf '%s' {shlex.quote(envelope)} > {shlex.quote(WORKFLOW_INPUT_PATH)}"

        # Relative: runs in the same shell as kimchi, so $PWD is the project
        # root the extension resolves workflow names against. Hardcoding a
        # guess would silently break if harbor changed the task working dir.
        stage_workflows = (
            f"mkdir -p {shlex.quote(PROJECT_WORKFLOWS_DIR)} && "
            f"cp -a {shlex.quote(CONTAINER_WORKFLOWS_STAGE_DIR)}/. {shlex.quote(PROJECT_WORKFLOWS_DIR)}/"
        )

        return [write_envelope, stage_workflows]

    def to_agent_info(self) -> AgentInfo:
        base_info = super().to_agent_info()
        # Workflow file content is not captured: workflows live in this repo,
        # not the extension. Give an edited variant its own declared name
        # (e.g. tb-solver-v2) to distinguish it in results.
        extension_identity = self._extension_short_identity or "unresolved"
        version = f"{base_info.version}+{self._workflow}@{extension_identity}"
        return base_info.model_copy(update={"version": version})
