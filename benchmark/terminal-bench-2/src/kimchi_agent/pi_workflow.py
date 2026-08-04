"""Stock ``pi`` plus the kimchi-workflows extension, running one named workflow.

The pi-side counterpart of ``WorkflowAgent``: same extension, same
``workflows/`` sources, same ``extension=``/``workflow=`` kwargs — with the
kimchi binary taken out of the picture entirely. What runs is upstream
``@earendil-works/pi-coding-agent`` with two extensions loaded
(``pi-kimchi-provider`` for model routing, ``kimchi-workflows`` for the engine),
so a benchmark result attributes to the *workflow*, not to kimchi's extension
layer sitting underneath it.

It subclasses ``PiKimchi`` and overrides only that class's hooks — never
``run()``, which is decorated with ``@with_prompt_template`` and would render
the template twice if a subclass called it.

## The deadline, which is why this adapter exists at all

``deep-solve`` sizes every one of its stages from the wall clock: how long
``execute`` gets this round, whether a second opinion is still affordable,
whether another round fits before the harness kills the container. Harbor hands
``agent_timeout_sec`` to the oracle agent and to nobody else, which is why the
ancestor of that workflow could never be ported here (``workflows/README.md``,
"tb-solver ... is not here").

So this adapter reconstructs it, by computing exactly what
``Trial._compute_agent_timeout_sec`` computes:

    base    = agent.override_timeout_sec or <task.toml>[agent].timeout_sec
    timeout = min(base, agent.max_timeout_sec) * (agent_timeout_multiplier ?? timeout_multiplier)

Every input but one is in the trial's own ``config.json``, written before the
agent phase starts. The exception is the task's declared ``timeout_sec``, which
lives in the ``task.toml`` of harbor's task cache — keyed by the same content
ref ``config.json`` records. A run that cannot work it out falls back to
``DEFAULT_TIMEOUT_SEC`` rather than failing: a workflow on a wrong-but-sane
clock still solves tasks, and ``TB_AGENT_TIMEOUT_SEC`` overrides the lot.
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

from harbor.models.trial.result import AgentInfo, ModelInfo

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

# Relative on purpose: the pre-launch commands run in the same shell, and so the
# same cwd, as pi itself, which is the project root the extension resolves
# workflow names against. Python cannot learn that path up front.
#
# `.pi`, not `.kimchi`: the extension derives the segment from the running
# harness's own name rather than hardcoding one (kimchi-workflows'
# `src/host/project-dir.ts`), and the harness here is stock pi.
PROJECT_DIR = ".pi"
PROJECT_WORKFLOWS_DIR = f"{PROJECT_DIR}/workflows"

WORKFLOW_INPUT_PATH = f"{CONTAINER_LOGS_DIR}/workflow-input.json"
WORKFLOWS_HOST_DIR = Path(__file__).parent.parent.parent / "workflows"

# Kept for debugging after the run, since the live copy is deleted — see
# _post_launch_commands.
CONTAINER_PROJECT_DIR_COPY = f"{CONTAINER_LOGS_DIR}/pi-project-dir"

AGENT_TIMEOUT_ENV = "TB_AGENT_TIMEOUT_SEC"
DEFAULT_TIMEOUT_SEC = 900
# Stop the workflow before harbor's hard kill, so the last step lands instead of
# dying mid-write.
DEADLINE_MARGIN_SEC = 45
# Below this there is no workflow to run, only an expensive way to time out.
MIN_TIMEOUT_SEC = 60

ExtensionResolver = Callable[[ExtensionSpec], ResolvedExtension]


class PiWorkflowAgent(PiKimchi):
    """Runs a named kimchi-workflows workflow on stock pi.

    Two required agent kwargs select what runs, with exactly the meanings
    ``WorkflowAgent`` gives them:

    - ``extension``: ``npm:<pkg>[@<version-or-dist-tag>]`` or ``dir:<host
      path>``, resolved **on the host** (never installed in the container — task
      images ship no node toolchain) and uploaded. Both forms go through
      ``workflow_extension.resolve_extension_spec``, so both are cached per job
      and both record what actually resolved in ``AgentInfo.version``.
    - ``workflow``: a workflow's own declared name (e.g. ``deep-solve``), which
      the extension resolves against ``.pi/workflows/`` inside the container.
      This adapter names it and nothing more.
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

        # Parsed eagerly so a bad spec fails at `harbor run`, not ten minutes in.
        self._extension_spec: ExtensionSpec = parse_extension_spec(str(extension_raw))
        self._extension_raw = str(extension_raw)
        self._workflow = str(workflow)
        self._extension_short_identity: str | None = None
        self._resolve_extension: ExtensionResolver = extension_resolver or resolve_extension_spec

        super().__init__(*args, **kwargs)

    # -- install ---------------------------------------------------------

    async def install(self, environment: BaseEnvironment) -> None:
        # pi and pi-kimchi-provider first, so a broken runtime surfaces before
        # we spend time resolving an npm package on the host.
        await super().install(environment)

        resolved = self._resolve_extension(self._extension_spec)
        self._extension_short_identity = resolved.short_identity
        # Unfiltered, unlike the workflow sources below: an extension needs its
        # node_modules (jiti lives there). A `dir:` checkout therefore uploads
        # its devDependencies too — 342 MB against single-digit MB for `npm:`.
        #
        # It goes to /installed-agent rather than into pi's auto-discovery
        # directory, which lives under /logs and is collected as a CI artifact:
        # an extension with node_modules does not belong in a trial's artifacts.
        # Loaded by an explicit --extension flag instead (see _extension_paths).
        await environment.upload_dir(source_dir=resolved.host_dir, target_dir=CONTAINER_EXTENSION_DIR)

        # Filtered copy — see workflow_staging.WORKFLOWS_UPLOAD_IGNORE. Staged
        # BEFORE the guard below so the guard inspects what will actually be
        # uploaded.
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
        """The trial's own config.json, written by harbor before the agent phase."""
        try:
            return json.loads((self.logs_dir.parent / "config.json").read_text())
        except (OSError, ValueError):
            return {}

    def _task_timeout_sec(self, trial_config: dict) -> int | None:
        """The task's declared ``[agent] timeout_sec``, from harbor's task cache.

        The trial config names the task and the content ref it was resolved at;
        harbor's package cache is keyed by that same ref. Falls back to scanning
        the task's cache directory when the ref is missing or oddly shaped,
        which is only wrong if two revisions of one task are cached at once.
        """
        task = trial_config.get("task") or {}
        name = task.get("name")
        if not name:
            return None
        # Task names are "terminal-bench/fix-git"; the cache lays them out as
        # nested directories under packages/.
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
        """How long harbor will let the agent phase run, in seconds.

        Mirrors ``Trial._compute_agent_timeout_sec`` — see this module's
        docstring for why that is reconstructed here rather than asked for.
        """
        # An explicit operator override wins over everything, and is the escape
        # hatch when the reconstruction below is wrong for some task.
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
        """When the workflow must have finished, as an ISO-8601 Z timestamp."""
        deadline = datetime.now(UTC) + timedelta(
            seconds=max(MIN_TIMEOUT_SEC, timeout_sec - DEADLINE_MARGIN_SEC)
        )
        return deadline.replace(microsecond=0).isoformat().replace("+00:00", "Z")

    # -- PiKimchi hooks --------------------------------------------------

    def _extension_paths(self) -> list[str]:
        return [CONTAINER_EXTENSION_DIR]

    def _stdin_payload(self, instruction: str) -> str:
        # `instruction` is intentionally unused: it reaches pi through the input
        # envelope file written by _pre_launch_commands, never on the command
        # line or on stdin — so it can never be mistaken for a flag (pi's
        # parseArgs treats any token starting with "-" as one) and never appears
        # in `ps` or shell history.
        del instruction
        return f"/workflow run {self._workflow} --input @{WORKFLOW_INPUT_PATH}"

    def _run_env(self) -> dict[str, str]:
        # Read by a workflow to size its own step budgets — deep-solve's
        # BUDGET_SEC and defaultModel. The deadline itself travels in the
        # envelope, not here: it is per-run data, not configuration.
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

        # PROJECT_WORKFLOWS_DIR is relative, deliberately: this command and the
        # pi process it precedes run in the SAME shell invocation, so $PWD here
        # is by construction the project directory the extension's
        # resolveWorkflow() looks under. There is no reliable way to learn that
        # directory from Python ahead of time, and hardcoding a guess would
        # silently stop matching the day harbor changes the task working
        # directory — so this discovers it the same way the pi process about to
        # read it does: by not asking, and just running there.
        stage_workflows = (
            f"mkdir -p {shlex.quote(PROJECT_WORKFLOWS_DIR)} && "
            f"cp -a {shlex.quote(CONTAINER_WORKFLOWS_STAGE_DIR)}/. {shlex.quote(PROJECT_WORKFLOWS_DIR)}/"
        )

        return [write_envelope, stage_workflows]

    def _post_launch_commands(self) -> list[str]:
        # The workflow sources are OURS, not the task's, and the machine is
        # graded on its final state after the agent leaves. Keep a copy for
        # debugging, then take the live one back out. Both tolerate failure: a
        # tidy-up must never change the trial's recorded outcome.
        return [
            f"cp -a {shlex.quote(PROJECT_DIR)} {shlex.quote(CONTAINER_PROJECT_DIR_COPY)} 2>/dev/null || true",
            f"rm -rf {shlex.quote(PROJECT_DIR)} || true",
        ]

    # -- identity --------------------------------------------------------

    def to_agent_info(self) -> AgentInfo:
        # Accepted limitation, shared with WorkflowAgent: workflow file CONTENT
        # is not captured here. Workflows are files in THIS repo, not in the
        # extension, so neither the pi version nor the extension identity covers
        # an edit to one. Give an edited variant its own declared name
        # (`deep-solve-v2`) if the two must be distinguishable in results.
        extension_identity = self._extension_short_identity or "unresolved"
        return AgentInfo(
            name=self.name(),
            version=f"{self.version() or 'unknown'}+{self._workflow}@{extension_identity}",
            model_info=ModelInfo(name=self.model_name or "unknown", provider="kimchi"),
        )
