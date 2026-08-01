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
import os
import shlex
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.models.trial.result import AgentInfo, ModelInfo
from pydantic import ValidationError

from kimchi_agent.gateway import (
    KIMCHI_API_KEY_ENV,
    KimchiGatewayMixin,
)
from kimchi_agent.git_install import (
    GIT_INSTALL_ENV,
    git_config_command,
    git_init_and_commit_baseline_command,
)
from kimchi_agent.messages import SessionEntry

if TYPE_CHECKING:
    from harbor.environments.base import BaseEnvironment
    from harbor.models.agent.context import AgentContext

# In-container paths. /logs/agent is bind-mounted to self.logs_dir on the host.
CONTAINER_LOGS_DIR = "/logs/agent"
CONTAINER_SESSIONS_DIR = f"{CONTAINER_LOGS_DIR}/sessions"
CONTAINER_MAIN_SESSION = f"{CONTAINER_SESSIONS_DIR}/main.jsonl"
CONTAINER_AGENT_PGID_FILE = f"{CONTAINER_LOGS_DIR}/pi-agent.pgid"

# pi's agent dir — sessions, auth, and extensions live here.
# PI_CODING_AGENT_DIR is read by pi (ENV_AGENT_DIR in pi's config.ts).
CONTAINER_PI_AGENT_DIR = f"{CONTAINER_LOGS_DIR}/pi-agent"
CONTAINER_PI_EXTENSIONS_DIR = f"{CONTAINER_PI_AGENT_DIR}/extensions"

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

PI_EXIT_OUTPUT_TAIL_LINES = 20


class PiExitError(NonZeroAgentExitCodeError):
    """Raised when the pi process exits non-zero."""

    def __init__(self, *, command: str, exit_code: int, stdout: str | None, stderr: str | None) -> None:
        self.command = command
        self.exit_code = exit_code
        self.stdout = _tail_output(stdout)
        self.stderr = _tail_output(stderr)
        super().__init__(
            f"pi exited with code {self.exit_code}: {self.command}\n"
            f"stdout:\n{self.stdout}\n"
            f"stderr:\n{self.stderr}"
        )


def _tail_output(text: str | None, max_lines: int = PI_EXIT_OUTPUT_TAIL_LINES) -> str:
    if not text:
        return "None"
    lines = text.splitlines()
    if len(lines) <= max_lines:
        return text
    return "\n".join([f"... [showing last {max_lines} lines]", *lines[-max_lines:]])


class PiKimchi(KimchiGatewayMixin, BaseInstalledAgent):
    """Harbor agent that runs the bare ``pi`` CLI inside the task container.

    Unlike the ``Kimchi`` adapter (which runs the kimchi binary = pi +
    extensions), this runs the upstream ``pi`` CLI with only the
    ``pi-kimchi-provider`` extension — isolating the base agent loop.

    The ``pi-kimchi-provider`` extension registers the ``kimchi-dev`` provider
    with Pi's ``ModelRegistry``, fetches live model metadata from the Kimchi
    gateway, and routes chat completions through the OpenAI-compatible endpoint.
    No ``/login`` is needed in benchmark mode: ``KIMCHI_API_KEY`` is read from
    the environment at startup.
    """

    CLI_FLAGS: ClassVar[list[CliFlag]] = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            choices=["off", "minimal", "low", "medium", "high", "xhigh"],
        ),
        CliFlag("tools", cli="--tools", type="str"),
    ]

    def __init__(self, *args, **kwargs):
        # The pi-kimchi-provider extension source directory on the host.
        self._extension_source_dir = kwargs.pop("extension-source-dir", None)
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "pi-kimchi"

    def to_agent_info(self) -> AgentInfo:
        return AgentInfo(
            name=self.name(),
            version=self.version() or "unknown",
            model_info=ModelInfo(name=self.model_name or "unknown", provider="kimchi"),
        )

    def get_version_command(self) -> str | None:
        # pi is installed via npm (global). Ensure nvm is loaded so the binary
        # is on PATH, then print the version.
        return 'export NVM_DIR="$HOME/.nvm"; [ ! -s "$NVM_DIR/nvm.sh" ] || . "$NVM_DIR/nvm.sh"; pi --version'

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
            raise RuntimeError(
                f"Failed to clone pi-kimchi-provider from GitHub: {result.stderr.strip()}"
            )
        return ext_dir

    async def install(self, environment: BaseEnvironment) -> None:
        # Install git, curl, and (where available) nodejs/npm via the system
        # package manager. The nvm fallback below needs curl, and installing
        # nodejs/npm directly avoids the nvm path entirely on Alpine images.
        await self.exec_as_root(
            environment,
            command=(
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
            ),
            env=GIT_INSTALL_ENV,
        )
        await self.exec_as_agent(
            environment,
            command=git_config_command(),
        )

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

        # Upload and install the pi-kimchi-provider extension.
        ext_dir = self._ensure_extension_available()
        await environment.upload_dir(
            source_dir=ext_dir,
            target_dir=CONTAINER_EXTENSION_STAGE_DIR,
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Validate the model is kimchi-dev/<id> before doing any container work.
        self._split_model(self.model_name)

        api_key = self._required_kimchi_api_key()

        cli_flags = self.build_cli_flags()
        if cli_flags:
            cli_flags += " "

        env = {
            KIMCHI_API_KEY_ENV: api_key,
            # Point pi's agent dir at /logs/agent/pi-agent so session JSONL
            # files land where populate_context_post_run can read them.
            "PI_CODING_AGENT_DIR": CONTAINER_PI_AGENT_DIR,
        }

        try:
            await self.exec_as_agent(
                environment,
                command=self._pi_launch_command(instruction, cli_flags),
                env=env,
            )
        except asyncio.CancelledError:
            await self._terminate_pi_process_group(environment)
            raise

    def _pi_launch_command(self, instruction: str, cli_flags: str) -> str:
        runner = self._pi_command(cli_flags)
        parts = [
            # Source nvm first so npm/pi are on PATH for every subsequent step.
            # Each exec_as_agent call is a fresh shell; nvm was loaded during
            # install() but that session doesn't persist into run().
            'export NVM_DIR="$HOME/.nvm"; '
            '[ ! -s "$NVM_DIR/nvm.sh" ] || . "$NVM_DIR/nvm.sh"',
            # Ensure pi has a stable location for session files.
            f"mkdir -p {shlex.quote(CONTAINER_SESSIONS_DIR)}",
            # Drop stale pgid marker from a previous interrupted attempt.
            f"rm -f {shlex.quote(CONTAINER_AGENT_PGID_FILE)}",
            # Install the pi-kimchi-provider extension: run npm install --production
            # in the staged dir, then copy into pi's auto-discovery directory.
            # pi's discoverAndLoadExtensions scans <agentDir>/extensions/ for
            # subdirectories with a package.json containing a "pi" field.
            f"mkdir -p {shlex.quote(CONTAINER_PI_EXTENSIONS_DIR)} && "
            f"cp -a {shlex.quote(CONTAINER_EXTENSION_STAGE_DIR)}/. "
            f"{shlex.quote(CONTAINER_EXTENSION_INSTALL_DIR)}/ && "
            f"cd {shlex.quote(CONTAINER_EXTENSION_INSTALL_DIR)} && "
            "npm install --production",
            # Ensure a git repo exists in the task working directory with a
            # committed baseline, but never clobber one that the task image
            # ships with (e.g. fix-git).
            f"cd /app && {git_init_and_commit_baseline_command()}",
        ]

        parts.append(
            # Enable job control so the backgrounded pi pipeline gets a
            # process group that can be terminated as a unit on timeout.
            "set -m && { "
            # Feed the task prompt through stdin instead of as a positional arg:
            # pi's parseArgs treats tokens starting with "-" as flags (no "--"
            # end-of-options marker), which would crash on instructions like
            # "- You are given...".
            f"(printf '%s' {shlex.quote(instruction)} | {runner}) & "
            # Record the process-group id for cancellation cleanup.
            "agent_pid=$!; "
            'agent_pgid=$(ps -o pgid= -p "$agent_pid" 2>/dev/null | tr -d "[:space:]" || true); '
            f"printf '%s\\n' \"${{agent_pgid:-$agent_pid}}\" > {shlex.quote(CONTAINER_AGENT_PGID_FILE)}; "
            'wait "$agent_pid"; '
            "agent_status=$?; "
            f"rm -f {shlex.quote(CONTAINER_AGENT_PGID_FILE)}; "
            'exit "$agent_status"; '
            "}"
        )
        return " && ".join(parts)

    def _pi_command(self, cli_flags: str) -> str:
        # nvm is already sourced by _pi_launch_command before this runs.
        return (
            f"pi --print --session {shlex.quote(CONTAINER_MAIN_SESSION)} "
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

        # Aggregate main.jsonl + Agent child <timestamp>_<uuid>.jsonl siblings.
        # pi writes the same session format as kimchi (both use pi-coding-agent).
        for session_file in sorted(sessions_dir.glob("*.jsonl")):
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
