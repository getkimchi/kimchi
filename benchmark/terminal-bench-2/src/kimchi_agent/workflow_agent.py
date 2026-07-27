"""Harbor agent that runs the pi-workflows terminal-bench solver.

Extends the stock :class:`Kimchi` agent by loading a pre-built workflow
extension bundle via ``-e``, turning the single-session agent into a
multi-step workflow engine (survey → implement → verify → audit → report).

The workflow itself lives in the ``pi-workflows`` repository
(``benchmarks/terminal-bench/``).  The extension hook (``extension.ts``)
intercepts PI's ``input`` event, swallows the piped instruction, and hands
it to the workflow engine.  Every step spawns a fresh kimchi subprocess
(``background: true``), so subagents inherit the parent's provider, auth,
and model registry.

Two agents live here, differing only in where the extension comes from:

``WorkflowKimchi``
    Uploads a pre-built bundle (``bun build extension.ts``).  One file, fixed
    at build time.  Use it for runs you want to be reproducible.

``LocalWorkflowKimchi``
    Uploads the pi-workflows checkout itself and points ``-e`` at
    ``extension.ts``.  PI's extension loader runs modules through jiti, which
    transpiles TypeScript at runtime; inside the compiled binary it is
    configured with ``virtualModules``, so bare imports (``typebox``,
    ``@earendil-works/pi-coding-agent``) resolve to the copies compiled into
    kimchi and no ``node_modules`` is needed in the container.  Edit a
    workflow file, re-run, done — and stack traces point at real sources.

Usage::

    ./scripts/run-workflow.sh -i terminal-bench/fix-git        # bundle
    ./scripts/run-workflow-local.sh -i terminal-bench/fix-git  # local sources
"""

import os
import shlex
import shutil
import tempfile
from pathlib import Path

from harbor.agents.installed.base import with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from kimchi_agent.agent import (
    BINARY_PATH,
    CONTAINER_MAIN_SESSION,
    INSTALL_DIR,
    Kimchi,
)

WORKFLOW_BUNDLE_HOST_PATH_ENV = "TB_WORKFLOW_BUNDLE"
WORKFLOW_BUNDLE_CONTAINER_PATH = f"{INSTALL_DIR}/tb-workflow.js"

#: Host path to a pi-workflows checkout, read by :class:`LocalWorkflowKimchi`.
WORKFLOW_SRC_HOST_PATH_ENV = "TB_WORKFLOW_DIR"
WORKFLOW_SRC_CONTAINER_DIR = f"{INSTALL_DIR}/pi-workflows"
WORKFLOW_ENTRY_RELPATH = "benchmarks/terminal-bench/extension.ts"
#: What the extension's import graph actually reaches. `test/` and `node_modules/`
#: are not in it, and node_modules would be 289MB per trial.
WORKFLOW_SRC_SUBTREES = ("src", "benchmarks")
WORKFLOW_SRC_FILES = ("package.json",)
WORKFLOW_SRC_IGNORE = shutil.ignore_patterns("node_modules", ".git", "dist", "__pycache__")

#: Env var the extension reads to pin every subagent's model.
TB_MODEL_ENV = "TB_MODEL"
#: Env var the extension reads for its wall-clock budget (defaults to 900s).
TB_AGENT_TIMEOUT_SEC_ENV = "TB_AGENT_TIMEOUT_SEC"


class WorkflowKimchi(Kimchi):
    """Kimchi agent with the pi-workflows terminal-bench solver loaded.

    Binary upload, process-group management, session parsing, and token
    counting are all inherited unchanged from :class:`Kimchi`.  This class
    adds exactly two things:

    1.  **Bundle upload** — the pre-built workflow extension is uploaded
        alongside the binary during :meth:`install`.
    2.  **``-e`` flag** — the kimchi launch command gets
        ``-e /installed-agent/tb-workflow.js`` so PI loads the extension.
    3.  **TB\\_ env vars** — ``TB_MODEL`` (from the selected ``--model``)
        and ``TB_AGENT_TIMEOUT_SEC`` (forwarded from the host if set) are
        injected so the workflow engine knows its model and deadline.
    """

    @staticmethod
    def name() -> str:
        return "kimchi-workflow"

    # -- Install -----------------------------------------------------------

    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        await self._install_extension(environment)

    def _extension_container_path(self) -> str:
        """In-container path handed to ``-e``."""
        return WORKFLOW_BUNDLE_CONTAINER_PATH

    async def _install_extension(self, environment: BaseEnvironment) -> None:
        bundle_path = self._resolve_bundle_path()
        await environment.upload_file(
            source_path=bundle_path,
            target_path=WORKFLOW_BUNDLE_CONTAINER_PATH,
        )
        await self.exec_as_root(
            environment,
            command=f"chmod 0644 {shlex.quote(WORKFLOW_BUNDLE_CONTAINER_PATH)}",
        )

    def _resolve_bundle_path(self) -> Path:
        raw = os.environ.get(WORKFLOW_BUNDLE_HOST_PATH_ENV)
        if not raw:
            raise RuntimeError(
                f"{WORKFLOW_BUNDLE_HOST_PATH_ENV} is not set. "
                "Run scripts/run-workflow.sh to build the bundle, or set it "
                "to the path of a pre-built tb-workflow.js."
            )
        path = Path(raw).expanduser().resolve()
        if not path.is_file():
            raise RuntimeError(f"Workflow bundle not found at {path}. Run scripts/run-workflow.sh to build it.")
        return path

    # -- Launch command ----------------------------------------------------

    def _kimchi_command(self, cli_flags: str) -> str:
        model_flag = ""
        if not self._multi_model_enabled:
            model_flag = f"--model {shlex.quote(self.model_name or '')} "

        return (
            f"{shlex.quote(BINARY_PATH)} "
            f"-e {shlex.quote(self._extension_container_path())} "
            f"--print --session {shlex.quote(CONTAINER_MAIN_SESSION)} "
            f"{model_flag}"
            f"{cli_flags}"
        )

    # -- Run ---------------------------------------------------------------

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Pin every subagent to the same model the parent uses.
        self._extra_env[TB_MODEL_ENV] = self.model_name or ""

        # Forward the per-task timeout if the host set it.  The extension
        # defaults to 900s when this is unset, which is correct for most
        # terminal-bench tasks.  Do NOT set this globally for full-dataset
        # runs — tasks have wildly different timeouts (900s to 12000s).
        tb_timeout = self._get_env(TB_AGENT_TIMEOUT_SEC_ENV)
        if tb_timeout:
            self._extra_env[TB_AGENT_TIMEOUT_SEC_ENV] = tb_timeout

        await super().run(instruction, environment, context)


class LocalWorkflowKimchi(WorkflowKimchi):
    """Workflow agent that loads the extension from a pi-workflows checkout.

    No build step: the checkout's ``src/`` and ``benchmarks/`` are uploaded as
    they are on disk and ``-e`` points at ``extension.ts``.  jiti transpiles
    the TypeScript inside the container and resolves the relative imports;
    the only bare specifiers in that import graph are ``typebox`` (runtime)
    and ``@earendil-works/pi-coding-agent`` (type-only, erased), both served
    from the binary's own bundled copies.

    Pair it with a locally built binary (``KIMCHI_CODE_BINARY``) and both
    halves of the run are yours: ``./scripts/run-workflow-local.sh``.
    """

    @staticmethod
    def name() -> str:
        return "kimchi-workflow-local"

    def _extension_container_path(self) -> str:
        return f"{WORKFLOW_SRC_CONTAINER_DIR}/{WORKFLOW_ENTRY_RELPATH}"

    async def _install_extension(self, environment: BaseEnvironment) -> None:
        checkout = self._resolve_checkout_path()
        quoted_dir = shlex.quote(WORKFLOW_SRC_CONTAINER_DIR)
        # docker cp needs the destination directory to exist.
        await self.exec_as_root(environment, command=f"mkdir -p {quoted_dir}")

        # Stage the subset the extension actually imports, so a 289MB
        # node_modules next door never reaches the wire.
        with tempfile.TemporaryDirectory(prefix="tb-workflow-src-") as stage:
            stage_dir = Path(stage)
            for name in WORKFLOW_SRC_SUBTREES:
                shutil.copytree(
                    checkout / name,
                    stage_dir / name,
                    ignore=WORKFLOW_SRC_IGNORE,
                )
            for name in WORKFLOW_SRC_FILES:
                source = checkout / name
                if source.is_file():
                    shutil.copy2(source, stage_dir / name)
            await environment.upload_dir(
                source_dir=stage_dir,
                target_dir=WORKFLOW_SRC_CONTAINER_DIR,
            )

        # The agent user only ever reads these.
        await self.exec_as_root(environment, command=f"chmod -R a+rX {quoted_dir}")

    def _resolve_checkout_path(self) -> Path:
        raw = os.environ.get(WORKFLOW_SRC_HOST_PATH_ENV)
        if not raw:
            raise RuntimeError(
                f"{WORKFLOW_SRC_HOST_PATH_ENV} is not set. "
                "Run scripts/run-workflow-local.sh, or set it to a pi-workflows checkout."
            )
        path = Path(raw).expanduser().resolve()
        entry = path / WORKFLOW_ENTRY_RELPATH
        if not entry.is_file():
            raise RuntimeError(
                f"No workflow extension at {entry}. {WORKFLOW_SRC_HOST_PATH_ENV} must point at a pi-workflows checkout."
            )
        for name in WORKFLOW_SRC_SUBTREES:
            if not (path / name).is_dir():
                raise RuntimeError(f"Expected {path / name} in the pi-workflows checkout.")
        return path
