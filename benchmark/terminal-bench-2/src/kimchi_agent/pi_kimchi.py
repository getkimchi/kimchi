"""Harbor agent that runs the upstream ``pi`` CLI (bare ``@earendil-works/pi-coding-agent``)
inside the task container, routing model calls through the Kimchi LLM gateway.

This adapter isolates the base pi agent loop — no kimchi extensions (ferment,
model-guard, model catalog, etc.) — so benchmark runs can attribute
differences between kimchi and pi to the extension layer.

Binary source:
    ``npm install -g @earendil-works/pi-coding-agent`` (optionally pinned via
    the ``version`` agent kwarg / ``PI_VERSION`` env var).

Model routing is always via the Kimchi LLM gateway
(``https://llm.kimchi.dev``) using ``KIMCHI_API_KEY``; the
``pi-kimchi-provider`` extension registers the ``kimchi-dev`` provider at
startup.
"""

import asyncio
import json
import os
import shlex
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

from pier.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pydantic import ValidationError

from kimchi_agent.framework import HarborCompatMixin, agent_info_types
from kimchi_agent.gateway import (
    KIMCHI_API_KEY_ENV,
    KimchiGatewayMixin,
)
from kimchi_agent.git_install import (
    GIT_INSTALL_COMMAND,
    GIT_INSTALL_ENV,
    git_config_command,
    git_init_and_commit_baseline_command,
)
from kimchi_agent.messages import SessionEntry
from kimchi_agent.moonshot import (
    MOONSHOT_API_KEY_ENV,
    MOONSHOT_PROVIDER,
    is_moonshot_model,
    required_moonshot_api_key,
    split_moonshot_model,
)
from kimchi_agent.moonshot import (
    build_models_config as build_moonshot_models_config,
)
from kimchi_agent.openrouter import (
    OPENROUTER_API_KEY_ENV,
    OPENROUTER_ENDPOINT_ENV,
    OPENROUTER_PROVIDER,
    OpenRouterClient,
    is_openrouter_model,
    split_openrouter_model,
)
from kimchi_agent.zai import (
    ZAI_API_KEY_ENV,
    ZAI_ENDPOINT_ENV,
    ZAI_PROVIDER,
    is_zai_model,
    split_zai_model,
)
from kimchi_agent.zai import (
    build_models_config as build_zai_models_config,
)


def _model_provider_label(model_name: str | None) -> str:
    """Provider name recorded in run metadata."""
    if is_openrouter_model(model_name):
        return OPENROUTER_PROVIDER
    if is_moonshot_model(model_name):
        return MOONSHOT_PROVIDER
    if is_zai_model(model_name):
        return ZAI_PROVIDER
    return "kimchi"


if TYPE_CHECKING:
    from harbor.environments.base import BaseEnvironment
    from pier.models.agent.context import AgentContext

# In-container paths. /logs/agent is bind-mounted to self.logs_dir on the host.
CONTAINER_LOGS_DIR = "/logs/agent"
CONTAINER_SESSIONS_DIR = f"{CONTAINER_LOGS_DIR}/sessions"
CONTAINER_MAIN_SESSION = f"{CONTAINER_SESSIONS_DIR}/main.jsonl"
CONTAINER_AGENT_PGID_FILE = f"{CONTAINER_LOGS_DIR}/pi-agent.pgid"

# pi's agent dir — sessions, auth, and extensions live here.
# PI_CODING_AGENT_DIR is read by pi (ENV_AGENT_DIR in pi's config.ts).
CONTAINER_PI_AGENT_DIR = f"{CONTAINER_LOGS_DIR}/pi-agent"
CONTAINER_PI_EXTENSIONS_DIR = f"{CONTAINER_PI_AGENT_DIR}/extensions"
# pi reads custom providers/models from <agentDir>/models.json (config.ts
# getModelsPath). Entries merge over pi's bundled catalog rather than replacing
# it, so declaring one model leaves the built-ins intact.
CONTAINER_PI_MODELS_JSON = f"{CONTAINER_PI_AGENT_DIR}/models.json"

# The pi-kimchi-provider extension source is staged to /tmp and installed
# (npm install --production) + copied into the auto-discovery directory at
# launch time. This mirrors how the kimchi adapter stages llm-sampling-params.
CONTAINER_EXTENSION_STAGE_DIR = "/tmp/pi-kimchi-provider"
CONTAINER_EXTENSION_INSTALL_DIR = f"{CONTAINER_PI_EXTENSIONS_DIR}/pi-kimchi-provider"

# Host path to the pi-kimchi-provider repo, checked out alongside this repo.
# The benchmark runner is expected to make it available at this path (or
# override via PI_KIMCHI_PROVIDER_DIR env var).
HOST_EXTENSION_DIR = Path(__file__).parent / "extensions" / "pi-kimchi-provider"
EXTENSION_REPO = "getkimchi/pi-kimchi-provider"
EXTENSION_CLONE_DIR = Path(__file__).parent / "extensions" / "pi-kimchi-provider"

# Offline install bundle (node + pi + pi-kimchi-provider with real node_modules),
# staged on the host by scripts/build-pi-bundle.sh. When present and runnable
# in the task image, install touches the network zero times — required for
# tasks with allow_internet=false. Absent or unrunnable, every run falls back
# to the network install below.
PI_BUNDLE_DIR_ENV = "PI_BUNDLE_DIR"
HOST_BUNDLE_DIR = Path(__file__).parent.parent.parent / ".cache" / "pi-bundle"

CONTAINER_INSTALL_DIR = "/installed-agent"
CONTAINER_BUNDLE_NODE_DIR = f"{CONTAINER_INSTALL_DIR}/node"
CONTAINER_BUNDLE_PI_DIR = f"{CONTAINER_INSTALL_DIR}/pi"

PI_EXIT_OUTPUT_TAIL_LINES = 20


class PiExitError(NonZeroAgentExitCodeError):
    """Raised when the pi process exits non-zero."""

    def __init__(self, *, command: str, exit_code: int, stdout: str | None, stderr: str | None) -> None:
        self.command = command
        self.exit_code = exit_code
        self.stdout = _tail_output(stdout)
        self.stderr = _tail_output(stderr)
        super().__init__(
            f"pi exited with code {self.exit_code}: {self.command}\nstdout:\n{self.stdout}\nstderr:\n{self.stderr}"
        )


def _tail_output(text: str | None, max_lines: int = PI_EXIT_OUTPUT_TAIL_LINES) -> str:
    if not text:
        return "None"
    lines = text.splitlines()
    if len(lines) <= max_lines:
        return text
    return "\n".join([f"... [showing last {max_lines} lines]", *lines[-max_lines:]])


class PiKimchi(KimchiGatewayMixin, HarborCompatMixin, BaseInstalledAgent):
    """Harbor agent that runs the bare ``pi`` CLI inside the task container.

    Unlike the ``Kimchi`` adapter (which runs the kimchi binary = pi +
    extensions), this runs the upstream ``pi`` CLI with only the
    ``pi-kimchi-provider`` extension — isolating the base agent loop.

    The ``pi-kimchi-provider`` extension registers the ``kimchi-dev`` provider
    with Pi's ``ModelRegistry``, fetches live model metadata from the Kimchi
    gateway, and routes chat completions through the OpenAI-compatible endpoint.
    No ``/login`` is needed in benchmark mode: ``KIMCHI_API_KEY`` is read from
    the environment at startup.

    ``openrouter/*`` models skip that extension entirely: upstream pi ships an
    ``openrouter`` provider and resolves ``OPENROUTER_API_KEY`` from the
    environment. A generated ``models.json`` still declares the selected model
    so limits come from OpenRouter's live catalog — see
    :meth:`_models_json_command` for why that is not optional.
    """

    CLI_FLAGS: ClassVar[list[CliFlag]] = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            # Mirrors `pi --thinking` (off..max). 'max' was missing here, so a
            # max run failed enum coercion before pi was ever launched.
            choices=["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        ),
        CliFlag("tools", cli="--tools", type="str"),
    ]

    def __init__(self, *args, **kwargs):
        self._extension_source_dir = kwargs.pop("extension-source-dir", None)
        # Set by install(): whether the offline bundle was uploaded AND ran in
        # this task image. The launch command skips `npm install` when True.
        self._bundled = False
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "pi-kimchi"

    def to_agent_info(self):
        # Framework-matched types: each runner's TrialResult only accepts its
        # own AgentInfo (see kimchi_agent.framework).
        AgentInfo, ModelInfo = agent_info_types()
        return AgentInfo(
            name=self.name(),
            version=self.version() or "unknown",
            model_info=ModelInfo(
                name=self.model_name or "unknown",
                provider=_model_provider_label(self.model_name),
            ),
        )

    def _path_setup(self) -> str:
        """PATH prologue covering both install modes (bundled runtime + nvm)."""
        return (
            f'export PATH="{CONTAINER_BUNDLE_PI_DIR}/bin:{CONTAINER_BUNDLE_NODE_DIR}/bin:$PATH"; '
            'export NVM_DIR="$HOME/.nvm"; '
            '[ ! -s "$NVM_DIR/nvm.sh" ] || . "$NVM_DIR/nvm.sh"'
        )

    def get_version_command(self) -> str | None:
        # pi comes either from the offline bundle or from a global npm install;
        # put both on PATH, then print the version.
        return f"{self._path_setup()}; pi --version"

    def install_spec(self) -> AgentInstallSpec:
        """Declarative install steps for Docker image fingerprinting.

        PiKimchi's install is network-dependent (npm install, nvm) and
        cannot be fully expressed as cached Docker layers. The pure-shell
        git install step is declared for fingerprinting; the rest runs in
        :meth:`install` at setup time.
        """
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._version,
            steps=[
                InstallStep(
                    user="root",
                    env=dict(GIT_INSTALL_ENV),
                    run=GIT_INSTALL_COMMAND,
                ),
                InstallStep(user="agent", run=git_config_command()),
            ],
            verification_command=self.get_version_command(),
        )

    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    def _classify_exec_error(self, command: str, result: Any) -> NonZeroAgentExitCodeError:
        return_code = getattr(result, "return_code", 1)
        return PiExitError(
            command=command,
            exit_code=int(return_code if return_code is not None else 1),
            stdout=getattr(result, "stdout", None),
            stderr=getattr(result, "stderr", None),
        )

    @property
    def _host_extension_dir(self) -> Path:
        """Return the host path to the pi-kimchi-provider extension source."""
        if self._extension_source_dir is not None:
            return Path(self._extension_source_dir)
        return HOST_EXTENSION_DIR

    def _ensure_extension_available(self) -> Path:
        """Ensure the pi-kimchi-provider extension source exists on the host.

        If the local directory is missing (e.g. in CI where only this repo
        is checked out), clone it from GitHub using GITHUB_TOKEN for auth.
        """
        ext_dir = self._host_extension_dir
        if ext_dir.is_dir():
            return ext_dir

        token = os.environ.get("GITHUB_TOKEN", "")
        if not token:
            raise RuntimeError(
                f"pi-kimchi-provider extension not found at {ext_dir} and "
                "GITHUB_TOKEN is not set. Either check out the repo alongside "
                "the benchmark code, pass --agent-kwarg extension-source-dir=<path>, "
                "or set GITHUB_TOKEN to allow cloning from GitHub."
            )

        ext_dir.parent.mkdir(parents=True, exist_ok=True)
        clone_url = f"https://x-access-token:{token}@github.com/{EXTENSION_REPO}.git"
        self.logger.info(
            "Cloning pi-kimchi-provider extension",
            extra={"repo": EXTENSION_REPO, "dest": str(ext_dir)},
        )
        result = subprocess.run(
            ["git", "clone", "--depth", "1", clone_url, str(ext_dir)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Failed to clone pi-kimchi-provider from GitHub: {result.stderr.strip()}")
        return ext_dir

    async def install(self, environment: BaseEnvironment) -> None:
        # Bundle before the package manager: if it works, nothing left needs the
        # network, so a failing apt-get on an isolated image must not take the
        # install down with it.
        self._bundled = await self._install_from_bundle(environment)

        await self._install_system_packages(environment, tolerate_failure=self._bundled)
        await self.exec_as_agent(
            environment,
            command=git_config_command(),
        )

        if not self._bundled:
            await self._install_pi_from_network(environment)
            # The bundle path uploaded the same tree already installed.
            ext_dir = self._ensure_extension_available()
            await environment.upload_dir(
                source_dir=ext_dir,
                target_dir=CONTAINER_EXTENSION_STAGE_DIR,
            )

    def _bundle_dir(self) -> Path:
        override = self._get_env(PI_BUNDLE_DIR_ENV)
        return Path(override) if override else HOST_BUNDLE_DIR

    async def _install_from_bundle(self, environment: BaseEnvironment) -> bool:
        """Upload the prebuilt offline bundle. Returns False when absent or unrunnable."""
        # Official node tarballs are glibc-linked, so on musl (Alpine) the binary
        # uploads fine but will not execute. The probe below runs the binary
        # rather than trusting the upload — a bundle that cannot start must be
        # cleared away, not left shadowing the working nvm install on PATH.
        bundle = self._bundle_dir()
        required = {
            "node runtime": bundle / "node" / "bin" / "node",
            "pi CLI": bundle / "pi" / "bin" / "pi",
            "pi-kimchi-provider": bundle / "extensions" / "pi-kimchi-provider" / "package.json",
        }
        missing = [name for name, path in required.items() if not path.exists()]
        if missing:
            if bundle.exists():
                # A partial bundle is a build that went wrong, unlike no bundle
                # at all — say which piece so it is fixable.
                self.logger.warning(
                    "pi offline bundle is incomplete; using the network install",
                    extra={"bundle_dir": str(bundle), "missing": missing},
                )
            return False

        await self.exec_as_root(
            environment,
            command=f"mkdir -p {shlex.quote(CONTAINER_BUNDLE_NODE_DIR)} {shlex.quote(CONTAINER_BUNDLE_PI_DIR)}",
        )
        await environment.upload_dir(source_dir=bundle / "node", target_dir=CONTAINER_BUNDLE_NODE_DIR)
        await environment.upload_dir(source_dir=bundle / "pi", target_dir=CONTAINER_BUNDLE_PI_DIR)
        await environment.upload_dir(
            source_dir=bundle / "extensions" / "pi-kimchi-provider",
            target_dir=CONTAINER_EXTENSION_STAGE_DIR,
        )
        # docker cp preserves host ownership; make the trees usable by the agent user.
        await self.exec_as_root(
            environment,
            command=(
                f"chmod -R a+rwX {shlex.quote(CONTAINER_INSTALL_DIR)} {shlex.quote(CONTAINER_EXTENSION_STAGE_DIR)}"
            ),
        )

        probe = await environment.exec(command=f"{self._path_setup()}; node --version && pi --version")
        if probe.return_code != 0:
            self.logger.warning(
                "pi offline bundle does not run in this task image (musl libc?); falling back to the network install",
                extra={"error": _tail_output(probe.stderr or probe.stdout, max_lines=5)},
            )
            await self.exec_as_root(
                environment,
                command=(
                    f"rm -rf {shlex.quote(CONTAINER_BUNDLE_NODE_DIR)} "
                    f"{shlex.quote(CONTAINER_BUNDLE_PI_DIR)} {shlex.quote(CONTAINER_EXTENSION_STAGE_DIR)}"
                ),
            )
            return False
        return True

    async def _install_system_packages(self, environment: BaseEnvironment, *, tolerate_failure: bool) -> None:
        # The nvm fallback needs curl; installing nodejs/npm directly avoids
        # the nvm path entirely on Alpine images.
        command = (
            "if command -v apk &> /dev/null; then"
            "  apk add --no-cache curl bash git nodejs npm;"
            " elif command -v apt-get &> /dev/null; then"
            "  apt-get update && apt-get install -y curl git;"
            " elif command -v yum &> /dev/null; then"
            "  yum install -y curl git;"
            " elif command -v git &> /dev/null; then"
            "  echo 'git already installed:' $(git --version);"
            " else"
            '  echo "Warning: No known package manager found and git not present" >&2;'
            " fi"
        )
        if tolerate_failure:
            # The bundle already supplied everything the agent needs to run, so
            # the only thing left here is git for the baseline commit — worth
            # attempting, never worth failing the trial over on an image with
            # no package repository reachable.
            command = f"{{ {command} ; }} || echo 'Warning: package install failed; using bundled runtime' >&2"
        await self.exec_as_root(environment, command=command, env=GIT_INSTALL_ENV)

    async def _install_pi_from_network(self, environment: BaseEnvironment) -> None:
        # Install pi via npm. Pin to a specific version if provided.
        version_spec = f"@{self._version}" if self._version else "@latest"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "if command -v node &>/dev/null && command -v npm &>/dev/null; then"
                "  npm -v;"
                " else"
                "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash &&"
                '  export NVM_DIR="$HOME/.nvm" &&'
                '  \\. "$NVM_DIR/nvm.sh" || true &&'
                "  command -v nvm &>/dev/null || { echo 'Error: NVM failed to load' >&2; exit 1; } &&"
                "  nvm install 22 && nvm alias default 22 && npm -v;"
                " fi && "
                f"npm install -g @earendil-works/pi-coding-agent{version_spec} && "
                "pi --version"
            ),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Resolve routing before any container work so a bad model or missing
        # key fails in seconds rather than after the install.
        if is_openrouter_model(self.model_name):
            api_key = self._required_openrouter_api_key()
            key_env = {OPENROUTER_API_KEY_ENV: api_key}
            # Raises if the model (or the model a preset wraps) is not offered
            # by OpenRouter.
            openrouter_client = OpenRouterClient(api_key=api_key, endpoint=self._get_env(OPENROUTER_ENDPOINT_ENV))
            direct_models_config = await openrouter_client.build_models_config(
                split_openrouter_model(self.model_name),
                include_api_key=False,
                thinking_level=self._resolved_flags.get("thinking"),
            )
        elif is_moonshot_model(self.model_name):
            api_key = required_moonshot_api_key(self._get_env)
            key_env = {MOONSHOT_API_KEY_ENV: api_key}
            direct_models_config = build_moonshot_models_config(
                split_moonshot_model(self.model_name),
                include_api_key=False,
                thinking_level=self._resolved_flags.get("thinking"),
            )
        elif is_zai_model(self.model_name):
            api_key = self._required_zai_api_key()
            key_env = {ZAI_API_KEY_ENV: api_key}
            # Metadata is static — no network fetch, unknown ids raise locally.
            # Unlike the openrouter branch the apiKey placeholder is kept: pi
            # maps the openrouter provider to OPENROUTER_API_KEY itself, but
            # has no built-in zai provider, so the config must name the env
            # var. "$ZAI_API_KEY" is a reference, not the key, so the
            # bind-mounted file stays artifact-safe.
            direct_models_config = build_zai_models_config(
                split_zai_model(self.model_name),
                include_api_key=True,
                thinking_level=self._resolved_flags.get("thinking"),
                endpoint=self._get_env(ZAI_ENDPOINT_ENV),
            )
        else:
            self._split_model(self.model_name)
            key_env = {KIMCHI_API_KEY_ENV: self._required_kimchi_api_key()}
            direct_models_config = None

        cli_flags = self.build_cli_flags()
        if cli_flags:
            cli_flags += " "

        env = {
            **key_env,
            # Point pi's agent dir at /logs/agent/pi-agent so session JSONL
            # files land where populate_context_post_run can read them.
            "PI_CODING_AGENT_DIR": CONTAINER_PI_AGENT_DIR,
            **self._run_env(),
        }

        try:
            await self.exec_as_agent(
                environment,
                command=self._pi_launch_command(
                    instruction,
                    cli_flags,
                    direct_models_config=direct_models_config,
                ),
                env=env,
            )
        except asyncio.CancelledError:
            await self._terminate_pi_process_group(environment)
            raise

    def _extension_paths(self) -> list[str]:
        """Container paths passed to pi as ``--extension``. Empty here (auto-discovery)."""
        # These hooks exist so a subclass never overrides run() — it is
        # decorated with @with_prompt_template, which is not idempotent.
        return []

    def _stdin_payload(self, instruction: str) -> str:
        """What to pipe to pi via stdin."""
        return instruction

    def _pre_launch_commands(self, instruction: str) -> list[str]:
        del instruction
        return []

    def _post_launch_commands(self) -> list[str]:
        """Cleanup after pi exits. Must not change the recorded exit status."""
        return []

    def _run_env(self) -> dict[str, str]:
        """Extra env for the pi process."""
        return {}

    def _required_openrouter_api_key(self) -> str:
        api_key = self._get_env(OPENROUTER_API_KEY_ENV)
        if not api_key:
            raise ValueError(
                f"{OPENROUTER_API_KEY_ENV} is required for {OPENROUTER_PROVIDER}/* models. "
                f"Export it on the host and forward it with "
                f"`--ae {OPENROUTER_API_KEY_ENV}=${OPENROUTER_API_KEY_ENV}`."
            )
        return api_key

    def _required_zai_api_key(self) -> str:
        api_key = self._get_env(ZAI_API_KEY_ENV)
        if not api_key:
            raise ValueError(
                f"{ZAI_API_KEY_ENV} is required for {ZAI_PROVIDER}/* models. "
                f"Export it on the host and forward it with "
                f"`--ae {ZAI_API_KEY_ENV}=${ZAI_API_KEY_ENV}`."
            )
        return api_key

    @staticmethod
    def _models_json_command(models_config: dict[str, Any]) -> str:
        """Declare the selected third-party model to pi before it starts.

        Not optional, even for models in pi's bundled catalog. An id pi does not
        know falls back to default limits, and pi then requests more output
        tokens than the endpoint allows: the provider answers 400, pi records
        ``stopReason: error`` with empty content — and still exits 0. Harbor
        scores that as an ordinary zero, so the run looks like a model failure
        instead of a config one. Declaring the model keeps limits live from the
        provider and keeps the bundled entries from going stale.

        The config deliberately carries no key material: pi maps the openrouter
        and moonshotai providers to OPENROUTER_API_KEY / MOONSHOT_API_KEY itself,
        and the zai config names ``$ZAI_API_KEY`` as a reference, never the key
        value — this file is written inside the bind-mounted logs dir that
        becomes CI artifacts.
        """
        models_json = json.dumps(models_config, separators=(",", ":"))
        return (
            f"mkdir -p {shlex.quote(CONTAINER_PI_AGENT_DIR)} && "
            f"printf '%s\\n' {shlex.quote(models_json)} > {shlex.quote(CONTAINER_PI_MODELS_JSON)}"
        )

    def _pi_launch_command(
        self,
        instruction: str,
        cli_flags: str,
        *,
        direct_models_config: dict[str, Any] | None = None,
    ) -> str:
        runner = self._pi_command(cli_flags)
        parts = [
            # Put both install modes' binaries on PATH for every subsequent
            # step. Each exec_as_agent call is a fresh shell; whatever install()
            # loaded does not persist into run().
            self._path_setup(),
            # Ensure pi has a stable location for session files.
            f"mkdir -p {shlex.quote(CONTAINER_SESSIONS_DIR)}",
            # Drop stale pgid marker from a previous interrupted attempt.
            f"rm -f {shlex.quote(CONTAINER_AGENT_PGID_FILE)}",
            # Copy the staged extension into pi's auto-discovery directory
            # (scans <agentDir>/extensions/ for dirs with a package.json "pi" field).
            f"mkdir -p {shlex.quote(CONTAINER_PI_EXTENSIONS_DIR)} && "
            f"cp -a {shlex.quote(CONTAINER_EXTENSION_STAGE_DIR)}/. "
            f"{shlex.quote(CONTAINER_EXTENSION_INSTALL_DIR)}/",
        ]
        if not self._bundled:
            # Only the network path stages bare sources; the bundle ships this
            # tree with node_modules already in it, and running npm over it
            # would need the network the bundle exists to avoid.
            parts.append(f"cd {shlex.quote(CONTAINER_EXTENSION_INSTALL_DIR)} && npm install --production")
        if direct_models_config is not None:
            parts.append(self._models_json_command(direct_models_config))
        # Ensure a git repo exists with a committed baseline, but never clobber
        # one the task image ships with (e.g. fix-git).  Harbor sets the
        # working directory via ``docker exec -w``, so ``$PWD`` is the task
        # workdir at shell start.  Capture it early because a prior part may
        # have ``cd``'d into the extension install dir.
        parts.append(f"TASK_WORKDIR=$PWD && {git_init_and_commit_baseline_command('$TASK_WORKDIR')}")
        parts.extend(self._pre_launch_commands(instruction))

        post_launch = "".join(f"{command}; " for command in self._post_launch_commands())
        parts.append(
            # Enable job control so the backgrounded pi pipeline gets a
            # process group that can be terminated as a unit on timeout.
            "set -m && { "
            # Feed the prompt through stdin — pi's parseArgs treats tokens
            # starting with "-" as flags (no "--" terminator).
            f"(printf '%s' {shlex.quote(self._stdin_payload(instruction))} | {runner}) & "
            # Record the process-group id for cancellation cleanup.
            "agent_pid=$!; "
            'agent_pgid=$(ps -o pgid= -p "$agent_pid" 2>/dev/null | tr -d "[:space:]" || true); '
            f"printf '%s\\n' \"${{agent_pgid:-$agent_pid}}\" > {shlex.quote(CONTAINER_AGENT_PGID_FILE)}; "
            'wait "$agent_pid"; '
            # Captured before cleanup so Harbor sees pi's status, not a tidy-up's.
            "agent_status=$?; "
            f"{post_launch}"
            f"rm -f {shlex.quote(CONTAINER_AGENT_PGID_FILE)}; "
            'exit "$agent_status"; '
            "}"
        )
        return " && ".join(parts)

    def _pi_command(self, cli_flags: str) -> str:
        # PATH is already set by _pi_launch_command before this runs.
        extension_flags = "".join(f"--extension {shlex.quote(path)} " for path in self._extension_paths())
        return (
            f"pi {extension_flags}"
            f"--print --session {shlex.quote(CONTAINER_MAIN_SESSION)} "
            f"--model {shlex.quote(self.model_name or '')} "
            f"--approve "
            f"{cli_flags}"
        )

    async def _terminate_pi_process_group(self, environment: BaseEnvironment) -> None:
        command = (
            f"if [ -s {shlex.quote(CONTAINER_AGENT_PGID_FILE)} ]; then "
            f"pgid=$(cat {shlex.quote(CONTAINER_AGENT_PGID_FILE)} 2>/dev/null || true); "
            'case "$pgid" in '
            "*[!0-9]*|'') ;; "
            "*) "
            'kill -TERM "-$pgid" 2>/dev/null || true; '
            "sleep 2; "
            'kill -KILL "-$pgid" 2>/dev/null || true; '
            ";; "
            "esac; "
            "fi; "
            f"rm -f {shlex.quote(CONTAINER_AGENT_PGID_FILE)}"
        )
        await self._run_cleanup_command(environment, command)

    async def _run_cleanup_command(self, environment: BaseEnvironment, command: str) -> None:
        try:
            await asyncio.wait_for(self.exec_as_root(environment, command=command), timeout=10)
        except Exception as exc:
            self.logger.warning(
                "Failed to terminate pi process group after cancellation",
                extra={"error": str(exc)},
            )

    def populate_context_post_run(self, context: AgentContext) -> None:
        sessions_dir = self.logs_dir / "sessions"
        if not sessions_dir.is_dir():
            return

        total_input_tokens = 0
        total_output_tokens = 0
        total_cache_read_tokens = 0
        total_cache_write_tokens = 0
        total_cost = 0.0

        # Recursive: kimchi-workflows parks step sessions in a workflow/
        # subdirectory of the session dir. A flat glob would miss them.
        for session_file in sorted(sessions_dir.rglob("*.jsonl")):
            try:
                lines = session_file.read_text().splitlines()
            except OSError as exc:
                self.logger.warning(
                    "Skipping unreadable pi session file during token aggregation",
                    extra={"path": str(session_file), "error": str(exc)},
                )
                continue
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = SessionEntry.model_validate_json(line)
                except ValidationError:
                    continue
                if entry.type != "message" or entry.message.role != "assistant":
                    continue
                usage = entry.message.usage
                total_input_tokens += usage.input
                total_output_tokens += usage.output
                total_cache_read_tokens += usage.cache_read
                total_cache_write_tokens += usage.cache_write
                total_cost += usage.cost.total

        # pi-ai treats input, cacheRead, cacheWrite as disjoint summing to totalTokens.
        context.n_input_tokens = total_input_tokens + total_cache_read_tokens + total_cache_write_tokens
        context.n_output_tokens = total_output_tokens
        context.n_cache_tokens = total_cache_read_tokens
        context.cost_usd = total_cost if total_cost > 0 else None
