"""Stock ``pi`` plus the kimchi-workflows extension, running one named workflow.

Unlike ``WorkflowAgent`` (which runs the same workflow under the kimchi binary),
this runs upstream ``@earendil-works/pi-coding-agent`` with no kimchi in the
picture, so a benchmark result attributes to the workflow, not to kimchi's
extension layer.

Subclasses ``PiKimchi`` and overrides only hooks — never ``run()`` (see
``PiKimchi._extension_paths`` for why).
"""

from __future__ import annotations

import json
import shlex
import tempfile
import tomllib
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from harbor.models.trial.result import AgentInfo

from kimchi_agent import workflow_staging
from kimchi_agent.pi_kimchi import CONTAINER_INSTALL_DIR, CONTAINER_LOGS_DIR, PiKimchi
from kimchi_agent.workflow_extension import (
    ExtensionSpec,
    ResolvedExtension,
    parse_extension_spec,
    resolve_extension_spec,
)

if TYPE_CHECKING:
    from harbor.environments.base import BaseEnvironment

CONTAINER_EXTENSION_DIR = f"{CONTAINER_INSTALL_DIR}/kimchi-workflows"
CONTAINER_WORKFLOWS_STAGE_DIR = f"{CONTAINER_INSTALL_DIR}/workflows"

# Relative: pre-launch commands run in the same shell as pi, so $PWD is the
# project root the extension resolves workflow names against.
# `.pi`, not `.kimchi`: the extension derives the segment from the running
# harness's own name (kimchi-workflows/src/host/project-dir.ts).
PROJECT_DIR = ".pi"
PROJECT_WORKFLOWS_DIR = f"{PROJECT_DIR}/workflows"

WORKFLOW_INPUT_PATH = f"{CONTAINER_LOGS_DIR}/workflow-input.json"
WORKFLOWS_HOST_DIR = Path(__file__).parent.parent.parent / "workflows"

# Debugging copy of .pi/, kept after _post_launch_commands deletes the live one.
CONTAINER_PROJECT_DIR_COPY = f"{CONTAINER_LOGS_DIR}/pi-project-dir"

AGENT_TIMEOUT_ENV = "TB_AGENT_TIMEOUT_SEC"
DEFAULT_TIMEOUT_SEC = 900
# Stop the workflow before harbor's hard kill so the last step lands.
DEADLINE_MARGIN_SEC = 45
# Below this there is no workflow to run, only an expensive way to time out.
MIN_TIMEOUT_SEC = 60

ExtensionResolver = Callable[[ExtensionSpec], ResolvedExtension]


class PiWorkflowAgent(PiKimchi):
    """Runs a named kimchi-workflows workflow on stock pi.

    Two required kwargs: ``extension`` (resolved on the host, never installed
    in the container) and ``workflow`` (a declared workflow name resolved
    against ``.pi/workflows/`` inside the container). See ``WorkflowAgent`` for
    the same kwargs under kimchi.
    """

    @staticmethod
    def name() -> str:
        return "pi-kimchi-workflow"

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
                "PiWorkflowAgent requires an 'extension' agent kwarg, e.g. "
                "--agent-kwarg extension=npm:@kimchi-dev/kimchi-workflows@latest, or "
                "--agent-kwarg extension=dir:/path/to/kimchi-workflows"
            )
        if not workflow or not str(workflow).strip():
            raise ValueError(
                "PiWorkflowAgent requires a 'workflow' agent kwarg naming a declared "
                "workflow, e.g. --agent-kwarg workflow=deep-solve"
            )

        self._extension_spec: ExtensionSpec = parse_extension_spec(str(extension_raw))
        self._extension_raw = str(extension_raw)
        self._workflow = str(workflow)
        self._extension_short_identity: str | None = None
        self._resolve_extension: ExtensionResolver = extension_resolver or resolve_extension_spec

        super().__init__(*args, **kwargs)

    # -- install ---------------------------------------------------------

    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)

        resolved = self._resolve_extension(self._extension_spec)
        self._extension_short_identity = resolved.short_identity
        # Unfiltered upload: the extension needs its node_modules (jiti lives
        # there). Goes to /installed-agent, not pi's auto-discovery dir (under
        # /logs, collected as CI artifact). Loaded via --extension flag.
        # A dir: checkout uploads devDependencies too (~342 MB vs single-digit
        # MB for npm:).
        await environment.upload_dir(source_dir=resolved.host_dir, target_dir=CONTAINER_EXTENSION_DIR)

        # Staged before the guard so it inspects what will actually be uploaded.
        with tempfile.TemporaryDirectory(prefix="pi-workflows-stage-") as stage:
            stage_dir = Path(stage) / "workflows"
            workflow_staging.stage_workflows(WORKFLOWS_HOST_DIR, stage_dir)
            workflow_staging.assert_a_workflow_can_resolve(
                staged_workflows=stage_dir,
                workflow=self._workflow,
                workflows_host_dir=WORKFLOWS_HOST_DIR,
                project_workflows_dir=PROJECT_WORKFLOWS_DIR,
            )
            await environment.upload_dir(source_dir=stage_dir, target_dir=CONTAINER_WORKFLOWS_STAGE_DIR)

    # -- the run's clock -------------------------------------------------

    def _trial_config(self) -> dict:
        try:
            return json.loads((self.logs_dir.parent / "config.json").read_text())
        except (OSError, ValueError):
            return {}

    def _task_timeout_sec(self, trial_config: dict) -> int | None:
        """The task's declared ``[agent] timeout_sec``, from harbor's task cache."""
        # The trial config names the task and its content ref; harbor's package
        # cache is keyed by that ref. Falls back to scanning the cache dir when
        # the ref is missing, which is only wrong if two revisions are cached.
        task = trial_config.get("task") or {}
        name = task.get("name")
        if not name:
            return None
        task_dir = Path.home() / ".cache" / "harbor" / "tasks" / "packages" / name
        ref = task.get("ref") or ""
        digest = ref.split(":", 1)[1] if ":" in ref else None
        try:
            candidates = (
                [task_dir / digest]
                if digest
                else sorted(path for path in task_dir.iterdir() if path.is_dir())
            )
            for candidate in candidates:
                task_toml = candidate / "task.toml"
                if not task_toml.is_file():
                    continue
                timeout = (tomllib.loads(task_toml.read_text()).get("agent") or {}).get("timeout_sec")
                if timeout:
                    return int(timeout)
        except (OSError, ValueError, tomllib.TOMLDecodeError):
            return None
        return None

    def _timeout_sec(self) -> int:
        """Reconstructs harbor's ``Trial._compute_agent_timeout_sec`` from config.json."""
        # TB_AGENT_TIMEOUT_SEC overrides everything — escape hatch when the
        # reconstruction is wrong for some task.
        raw = self._get_env(AGENT_TIMEOUT_ENV)
        if raw:
            try:
                return max(MIN_TIMEOUT_SEC, int(float(raw)))
            except ValueError:
                self.logger.warning(
                    f"ignoring unparseable ${AGENT_TIMEOUT_ENV}",
                    extra={"value": raw},
                )

        trial_config = self._trial_config()
        agent_config = trial_config.get("agent") or {}

        base = agent_config.get("override_timeout_sec") or self._task_timeout_sec(trial_config)
        if not base:
            return DEFAULT_TIMEOUT_SEC

        max_sec = agent_config.get("max_timeout_sec")
        if max_sec:
            base = min(base, max_sec)

        multiplier = trial_config.get("agent_timeout_multiplier")
        if multiplier is None:
            multiplier = trial_config.get("timeout_multiplier")
        if multiplier is None:
            multiplier = 1.0

        return max(MIN_TIMEOUT_SEC, int(float(base) * float(multiplier)))

    def _deadline_iso(self, timeout_sec: int) -> str:
        deadline = datetime.now(UTC) + timedelta(
            seconds=max(MIN_TIMEOUT_SEC, timeout_sec - DEADLINE_MARGIN_SEC)
        )
        return deadline.replace(microsecond=0).isoformat().replace("+00:00", "Z")

    # -- PiKimchi hooks --------------------------------------------------

    def _extension_paths(self) -> list[str]:
        return [CONTAINER_EXTENSION_DIR]

    def _stdin_payload(self, instruction: str) -> str:
        # Instruction travels in the envelope file, not on stdin — so it can
        # never be mistaken for a flag (pi's parseArgs treats any token
        # starting with "-" as one).
        del instruction
        return f"/workflow run {self._workflow} --input @{WORKFLOW_INPUT_PATH}"

    def _run_env(self) -> dict[str, str]:
        # deep-solve sizes step budgets from TB_AGENT_TIMEOUT_SEC and reads
        # TB_MODEL for spawned steps that have no --model flag. The deadline
        # travels in the envelope (per-run data, not configuration).
        return {
            AGENT_TIMEOUT_ENV: str(self._timeout_sec()),
            "TB_MODEL": self.model_name or "",
        }

    def _pre_launch_commands(self, instruction: str) -> list[str]:
        envelope = json.dumps(
            {"instruction": instruction, "deadlineIso": self._deadline_iso(self._timeout_sec())},
            ensure_ascii=True,
        )
        write_envelope = f"printf '%s' {shlex.quote(envelope)} > {shlex.quote(WORKFLOW_INPUT_PATH)}"

        # Relative: runs in the same shell as pi, so $PWD is the project root
        # the extension resolves workflow names against. Hardcoding a guess
        # would silently break if harbor changed the task working directory.
        stage_workflows = (
            f"mkdir -p {shlex.quote(PROJECT_WORKFLOWS_DIR)} && "
            f"cp -a {shlex.quote(CONTAINER_WORKFLOWS_STAGE_DIR)}/. {shlex.quote(PROJECT_WORKFLOWS_DIR)}/"
        )

        return [write_envelope, stage_workflows]

    def _post_launch_commands(self) -> list[str]:
        # .pi/ is ours, not the task's. Copy for debugging, then remove before
        # grading. Both tolerate failure — must not change the exit status.
        return [
            f"cp -a {shlex.quote(PROJECT_DIR)} {shlex.quote(CONTAINER_PROJECT_DIR_COPY)} 2>/dev/null || true",
            f"rm -rf {shlex.quote(PROJECT_DIR)} || true",
        ]

    # -- identity --------------------------------------------------------

    def to_agent_info(self) -> AgentInfo:
        base_info = super().to_agent_info()
        # Workflow file content is not captured: workflows live in this repo,
        # not the extension. Give an edited variant its own declared name
        # (e.g. deep-solve-v2) to distinguish it in results.
        extension_identity = self._extension_short_identity or "unresolved"
        version = f"{base_info.version}+{self._workflow}@{extension_identity}"
        return base_info.model_copy(update={"version": version})
