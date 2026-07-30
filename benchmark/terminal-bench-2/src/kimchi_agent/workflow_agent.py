"""kimchi + the kimchi-workflows pi extension, running one named workflow.

Produces the same shape of ``result.json`` as stock ``Kimchi`` so one
downstream pipeline reads both — ``conformance_test.py`` enforces that. Which
is why this class uses only the hooks ``Kimchi`` exposes and never overrides
``run()``; see ``Kimchi._extension_paths``.
"""

import json
import shlex
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING

from harbor.models.trial.result import AgentInfo

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

# workflows/ is also a dev directory; none of this belongs in a task container,
# and `npm install` there would otherwise ship ~72MB plus a symlink out of the
# repo. A denylist, since a workflow may legitimately need a data file beside it.
WORKFLOWS_UPLOAD_IGNORE = shutil.ignore_patterns(
    "node_modules",
    "test",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.ts",
    ".gitignore",
    "README.md",
)

ExtensionResolver = Callable[[ExtensionSpec], ResolvedExtension]


class WorkflowAgent(Kimchi):
    """Runs a named kimchi-workflows workflow instead of kimchi's default chat loop.

    Two required agent kwargs select what runs:

    - ``extension``: one of two forms, both resolved **on the host** and
      uploaded to the container — identical treatment, just a different
      source:

      - ``npm:<pkg>[@<version>]`` — the published package. Resolved by
        shelling out to ``npm`` on the host (``npm pack`` + extract +
        ``npm install --omit=dev --omit=peer``), cached by ``<pkg>@<version>``
        so a job of N trials resolves once.
      - ``dir:<host path>`` — a developer's working tree, fingerprinted and
        uploaded as-is (its own ``npm install`` is assumed already run). The
        local-development path.

      (``git:``-family specs and bare git URLs are rejected at construction —
      see ``workflow_extension.parse_extension_spec``'s docstring for why.)

    - ``workflow``: a workflow's own declared name (e.g. ``tb-solver``),
      resolved by the extension against ``.kimchi/workflows/`` inside the
      container — this adapter names it and nothing more; it does not resolve
      a path itself (that is the extension's job, not the adapter's).
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

        # Parsed eagerly so a bad spec fails at `harbor run`, not ten minutes in.
        self._extension_spec: ExtensionSpec = parse_extension_spec(str(extension_raw))
        self._extension_raw = str(extension_raw)
        self._workflow = str(workflow)
        self._extension_short_identity: str | None = None
        self._resolve_extension: ExtensionResolver = extension_resolver or resolve_extension_spec

        super().__init__(*args, **kwargs)

    async def install(self, environment: BaseEnvironment) -> None:
        # Binary first, so a bad KIMCHI_CODE_BINARY surfaces before we resolve.
        await super().install(environment)

        resolved = self._resolve_extension(self._extension_spec)
        self._extension_short_identity = resolved.short_identity
        # Unfiltered, unlike the workflow sources below: an extension needs its
        # node_modules (jiti lives there). A `dir:` checkout therefore uploads
        # its devDependencies too — 342 MB against single-digit MB for `npm:`.
        await environment.upload_dir(source_dir=resolved.host_dir, target_dir=CONTAINER_EXTENSION_DIR)

        # Filtered copy — see WORKFLOWS_UPLOAD_IGNORE. Staged BEFORE the guard
        # below so the guard can inspect what will actually be uploaded.
        with tempfile.TemporaryDirectory(prefix="kimchi-workflows-stage-") as stage:
            stage_dir = Path(stage) / "workflows"
            shutil.copytree(WORKFLOWS_HOST_DIR, stage_dir, ignore=WORKFLOWS_UPLOAD_IGNORE)
            self._assert_a_workflow_can_resolve(stage_dir)
            await environment.upload_dir(source_dir=stage_dir, target_dir=CONTAINER_WORKFLOWS_STAGE_DIR)

    def _assert_a_workflow_can_resolve(self, staged_workflows: Path) -> None:
        """Fail at install, not ten minutes into a trial, when nothing the
        container will receive can serve this run's ``workflow=``.

        Scans the staged tree, which is exactly what gets uploaded — the source
        tree also holds ``node_modules/@kimchi-dev/kimchi-workflows/``'s own
        ``create.workflow.ts``, which the upload filter strips.

        ``resolveWorkflow`` (``kimchi-workflows/src/host/workflow-catalog.ts``)
        takes a ``.ts`` argument as a path, which reaches a nested file, and
        anything else as a declared name, which only ``discoverWorkflows``'
        non-recursive ``readdir`` can serve. So the required check depends on
        which form was passed.
        """
        staged = sorted(staged_workflows.rglob("*.workflow.ts"))
        if not staged:
            raise RuntimeError(
                f"No *.workflow.ts files found anywhere under {WORKFLOWS_HOST_DIR} that would reach "
                "the container (the dev-only names in WORKFLOWS_UPLOAD_IGNORE are excluded from the "
                "upload, and so from this check). WorkflowAgent has nothing to run, by name or by "
                "path; see workflows/README.md for the expected layout."
            )

        if self._workflow.endswith(".ts") or any(path.parent == staged_workflows for path in staged):
            return

        nested = ", ".join(str(path.relative_to(staged_workflows)) for path in staged)
        raise RuntimeError(
            f"'workflow={self._workflow}' is a declared workflow name, which the extension resolves "
            f"through a non-recursive scan of the top level of {WORKFLOWS_HOST_DIR} — but every "
            f"*.workflow.ts that reaches the container is in a subdirectory ({nested}), where that "
            "scan cannot see it. Move one to the top level, or address a nested file by path instead "
            f"(workflow={PROJECT_WORKFLOWS_DIR}/<subdir>/<file>.workflow.ts). "
            "See workflows/README.md, 'What goes here'."
        )

    def _extension_paths(self) -> list[str]:
        # Both spec forms are uploaded to the same container path now —
        # there is no longer a passthrough form that needs the raw spec
        # string handed to `-e` verbatim.
        return [CONTAINER_EXTENSION_DIR]

    def _stdin_payload(self, instruction: str) -> str:
        # `instruction` is intentionally unused here: it reaches kimchi
        # through the input envelope file written by _pre_launch_commands
        # below, never on the command line or on stdin — so it can never be
        # mistaken for a flag (pi's parseArgs treats any token starting
        # with "-" as one) and never appears in `ps`/shell history.
        del instruction
        return f"/workflow run {self._workflow} --input @{WORKFLOW_INPUT_PATH}"

    def _pre_launch_commands(self, instruction: str) -> list[str]:
        envelope = json.dumps({"instruction": instruction})
        write_envelope = f"printf '%s' {shlex.quote(envelope)} > {shlex.quote(WORKFLOW_INPUT_PATH)}"

        # PROJECT_WORKFLOWS_DIR is relative, deliberately. This command and
        # the kimchi process it precedes run in the SAME shell invocation
        # (see Kimchi._kimchi_launch_command's `parts` list, which this
        # method's return value is appended to) — so $PWD here is, by
        # construction, whatever project directory the extension's
        # resolveWorkflow() looks under (<cwd>/.kimchi/workflows/*.workflow.ts).
        # There is no reliable way to learn that directory from Python ahead
        # of time, and hardcoding a guess would silently stop matching the
        # day harbor changes the task working directory — so this command
        # discovers it the same way the kimchi process about to read it does:
        # by not asking, and just running there.
        stage_workflows = (
            f"mkdir -p {shlex.quote(PROJECT_WORKFLOWS_DIR)} && "
            f"cp -a {shlex.quote(CONTAINER_WORKFLOWS_STAGE_DIR)}/. {shlex.quote(PROJECT_WORKFLOWS_DIR)}/"
        )

        return [write_envelope, stage_workflows]

    def to_agent_info(self) -> AgentInfo:
        base_info = super().to_agent_info()
        # Both forms are host-resolved now, so both go through the same
        # `resolved.short_identity` set in install() — no per-form branching
        # needed here any more:
        #   `dir:` -> `dir:<basename>@<sha-or-"dirty">`
        #   `npm:` -> `npm:<pkg>@<resolved version>+<short integrity/shasum>`,
        #             or just `npm:<pkg>@<resolved version>` if the registry
        #             gave us nothing to hash (workflow_extension._npm_identity)
        # An unpinned `npm:` spec (no `@<version>`) is still accepted, not
        # rejected — but unlike the old passthrough design, host resolution
        # DOES learn the actual resolved version each time, so two runs of an
        # unpinned spec now record different identities whenever the registry
        # actually resolved different code, instead of being indistinguishable
        # by construction.
        extension_identity = self._extension_short_identity or "unresolved"
        # Accepted limitation: workflow file CONTENT is not captured by
        # this version string. Workflows are files in THIS repo
        # (benchmark/terminal-bench-2/workflows/), not the extension, so
        # neither the kimchi version nor the extension identity covers an
        # edit to one. Two runs of an edited `tb-solver` therefore produce
        # identical version strings and are indistinguishable in result.json
        # — see workflow_agent_test.py's test asserting this deliberately, so
        # the limitation stays documented in code, not just in prose. The
        # zero-cost mitigation is a convention, not a mechanism: give an
        # edited variant its own workflow name (`tb-solver-v2`), which IS
        # distinguishable, because the name is already part of this string.
        version = f"{base_info.version}+{self._workflow}@{extension_identity}"
        return base_info.model_copy(update={"version": version})
