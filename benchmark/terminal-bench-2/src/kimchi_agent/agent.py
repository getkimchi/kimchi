import asyncio
import hashlib
import json
import re
import shlex
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

from kimchi_agent.config import KimchiAgentConfig
from kimchi_agent.messages import SessionEntry
from kimchi_agent.release import BINARY_RELPATH, SHARE_RELPATH, GitHubClient

if TYPE_CHECKING:
    from harbor.environments.base import BaseEnvironment
    from harbor.models.agent.context import AgentContext


# The release tarball (and local `pnpm run build:binary` output) is laid out as
# `bin/kimchi` + `share/kimchi/{package.json, theme/, export-html/}`. We
# preserve that layout under /installed-agent so the binary can find its auxiliary
# files via PI_PACKAGE_DIR (see src/entry.ts → resolveAuxiliaryFilesDir).
INSTALL_DIR = "/installed-agent"
BINARY_PATH = f"{INSTALL_DIR}/{BINARY_RELPATH.as_posix()}"
PI_PACKAGE_DIR = f"{INSTALL_DIR}/{SHARE_RELPATH.as_posix()}"
UPLOAD_STAGE_DIR = "/tmp/kimchi-stage"
OPENVIKING_UPLOAD_STAGE_DIR = "/tmp/openviking-stage"
OPENVIKING_INSTALL_DIR = f"{INSTALL_DIR}/openviking"
OPENVIKING_ENTRYPOINT = f"{OPENVIKING_INSTALL_DIR}/index.ts"
OPENVIKING_CLIENT_PATH = f"{OPENVIKING_INSTALL_DIR}/client.ts"
OPENVIKING_SYNC_PATH = f"{OPENVIKING_INSTALL_DIR}/sync.ts"
OPENVIKING_CREATE_SESSION_SOURCE = "JSON.stringify({ session_id: sessionId })"
OPENVIKING_CREATE_SESSION_REPLACEMENT = (
    "JSON.stringify({ session_id: sessionId, memory_policy: { memory_types: [], "
    "working_memory: { enabled: false } } })"
)
OPENVIKING_SESSION_ASSIGN_SOURCE = "this.ovSessionId = id;"
OPENVIKING_ENSURE_SESSION_REPLACEMENT = "return this.client.createSession(id);"

# In-container paths. /logs/agent is bind-mounted to self.logs_dir on the host.
CONTAINER_LOGS_DIR = "/logs/agent"
CONTAINER_SESSIONS_DIR = f"{CONTAINER_LOGS_DIR}/sessions"
CONTAINER_MAIN_SESSION = f"{CONTAINER_SESSIONS_DIR}/main.jsonl"
CONTAINER_AGENT_PGID_FILE = f"{CONTAINER_LOGS_DIR}/kimchi-agent.pgid"
CONTAINER_OPENVIKING_DEBUG_LOG = f"{CONTAINER_LOGS_DIR}/openviking-debug.log"
CONTAINER_OPENVIKING_STATUS = f"{CONTAINER_LOGS_DIR}/openviking-status.json"
CONTAINER_HARNESS_SETTINGS_DIR = "~/.config/kimchi/harness"
CONTAINER_HARNESS_SETTINGS = f"{CONTAINER_HARNESS_SETTINGS_DIR}/settings.json"
CONTAINER_HARNESS_SKILLS_DIR = f"{CONTAINER_HARNESS_SETTINGS_DIR}/skills"
KIMCHI_API_KEY_ENV = "KIMCHI_API_KEY"
MULTI_MODEL = "multi-model"
KIMCHI_INFRA_BREAKER_THRESHOLD_ENV = "KIMCHI_INFRA_BREAKER_THRESHOLD"
KIMCHI_BENCHMARK_INFRA_BREAKER_DEFAULT_ATTEMPTS = "3"
KIMCHI_EXIT_OUTPUT_TAIL_LINES = 20
OPENVIKING_DISCONNECTED_EXIT_CODE = 78
OPENVIKING_ENV_KEYS = (
    "OPENVIKING_URL",
    "OPENVIKING_BASE_URL",
    "OPENVIKING_API_KEY",
    "OPENVIKING_BEARER_TOKEN",
    "OPENVIKING_ACCOUNT",
    "OPENVIKING_USER",
    "OPENVIKING_PEER_ID",
    "OPENVIKING_WORKSPACE_PEER",
    "OPENVIKING_RECALL_PEER_SCOPE",
    "OPENVIKING_RECALL_LIMIT",
    "OPENVIKING_RECALL_QUERY_EXPANSION",
)
OPENVIKING_LEARNING_CONFIG = {
    "enabled": True,
    "syncTurns": True,
    "captureAssistantTurns": True,
    "captureToolResults": True,
    "captureToolMaxChars": 4000,
    "commitKeepRecentCount": 0,
    "takeover": {"enabled": False},
    "logLevel": "info",
}


def _coerce_bool_kwarg(value: object, name: str) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        match value.strip().lower():
            case "true" | "1" | "yes":
                return True
            case "false" | "0" | "no":
                return False
    raise ValueError(
        f"Invalid value for '{name}': expected true/false/1/0/yes/no, got {value!r}"
    )


def _validate_model_name(model_name: str | None) -> None:
    if not model_name or "/" not in model_name:
        raise ValueError(
            "--model is required and must be qualified with a provider "
            "(e.g. kimchi-dev/kimi-k2.5, kimchi-dev/glm-5-fp8, kimchi-dev/minimax-m2.7)"
        )
    provider, model_id = model_name.split("/", 1)
    if not provider or not model_id:
        raise ValueError(
            f"--model must be qualified as <provider>/<id> (got {model_name!r}); use e.g. kimchi-dev/kimi-k2.5"
        )


def _resolve_infra_breaker_threshold(value: str | None) -> str:
    if value is None or not value.strip():
        return KIMCHI_BENCHMARK_INFRA_BREAKER_DEFAULT_ATTEMPTS
    threshold = value.strip()
    try:
        parsed = int(threshold)
    except ValueError as exc:
        raise ValueError(
            f"{KIMCHI_INFRA_BREAKER_THRESHOLD_ENV} must be a positive integer for benchmark runs, got {value!r}"
        ) from exc
    if parsed <= 0:
        raise ValueError(
            f"{KIMCHI_INFRA_BREAKER_THRESHOLD_ENV} must be a positive integer for benchmark runs, got {value!r}"
        )
    return str(parsed)


def _tail_output(text: str | None, max_lines: int = KIMCHI_EXIT_OUTPUT_TAIL_LINES) -> str:
    if not text:
        return "None"
    lines = text.splitlines()
    if len(lines) <= max_lines:
        return text
    return "\n".join([f"... [showing last {max_lines} lines]", *lines[-max_lines:]])


def _hash_directory(path: Path) -> str:
    digest = hashlib.sha256()
    for file_path in sorted(candidate for candidate in path.rglob("*") if candidate.is_file()):
        relative_path = file_path.relative_to(path).as_posix()
        digest.update(relative_path.encode())
        digest.update(b"\0")
        with file_path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def _safe_openviking_peer_id(value: str) -> str:
    peer_id = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return (peer_id or "terminal-bench")[:120]


class KimchiExitError(NonZeroAgentExitCodeError):
    """Raised when the kimchi process exits non-zero."""

    def __init__(self, *, command: str, exit_code: int, stdout: str | None, stderr: str | None) -> None:
        self.command = command
        self.exit_code = exit_code
        self.stdout = _tail_output(stdout)
        self.stderr = _tail_output(stderr)
        super().__init__(
            f"Kimchi exited with code {self.exit_code}: {self.command}\n"
            f"stdout:\n{self.stdout}\n"
            f"stderr:\n{self.stderr}"
        )


class Kimchi(BaseInstalledAgent):
    """Harbor agent that runs the kimchi binary inside the task container.

    Binary source:
        1. If ``KIMCHI_CODE_BINARY`` is set on the host, that file is uploaded.
        2. Otherwise, the latest GitHub release from ``castai/kimchi`` is
           downloaded, sha256-verified, and extracted on the host, then uploaded.

    Model routing is always via the Kimchi LLM gateway (``https://llm.kimchi.dev``) using ``KIMCHI_API_KEY``;
    no provider-specific keys are needed.
    """

    CLI_FLAGS: ClassVar[list[CliFlag]] = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            choices=["off", "minimal", "low", "medium", "high", "xhigh"],
        ),
        CliFlag("tools", cli="--tools", type="str"),
        CliFlag("yolo", cli="--yolo", type="bool"),
        CliFlag(
            "dangerously-skip-permissions",
            cli="--dangerously-skip-permissions",
            type="bool",
            default=True,
        ),
        CliFlag("ferment-oneshot", cli="--ferment-oneshot", type="bool"),
    ]

    def __init__(self, *args, **kwargs):
        self._openviking_enabled = _coerce_bool_kwarg(kwargs.pop("openviking", False), "openviking")
        multi_model_kwarg = kwargs.pop("multi-model", None)
        disable_multi_model = _coerce_bool_kwarg(
            kwargs.pop("disable-multi-model", False), "disable-multi-model"
        )
        # Compaction follows kimchi's default (on) unless explicitly disabled.
        disable_compaction = _coerce_bool_kwarg(
            kwargs.pop("disable-compaction", False), "disable-compaction"
        )

        super().__init__(*args, **kwargs)
        selected_multi_model = self.model_name == MULTI_MODEL
        legacy_multi_model = (
            _coerce_bool_kwarg(multi_model_kwarg, "multi-model")
            if multi_model_kwarg is not None
            else False
        )
        if multi_model_kwarg is not None and legacy_multi_model != selected_multi_model:
            raise ValueError("the 'multi-model' agent kwarg must match model_name='multi-model'")
        if selected_multi_model and disable_multi_model:
            raise ValueError(
                "multi-model selection conflicts with legacy 'disable-multi-model=true'"
            )
        self._multi_model_enabled = selected_multi_model
        self._disable_compaction = disable_compaction
        config_kwargs = {}
        api_key = self._get_env(KIMCHI_API_KEY_ENV)
        if api_key is not None:
            config_kwargs[KIMCHI_API_KEY_ENV] = api_key
        openviking_extension_dir = self._get_env("OPENVIKING_EXTENSION_DIR")
        if openviking_extension_dir is not None:
            config_kwargs["OPENVIKING_EXTENSION_DIR"] = openviking_extension_dir
        self._config = KimchiAgentConfig(**config_kwargs)
        if self._openviking_enabled and self._config.openviking_extension_dir is None:
            raise ValueError(
                "OPENVIKING_EXTENSION_DIR is required when openviking=true; "
                "point it at the official Pi extension directory containing index.ts"
            )
        self._openviking_extension_sha256 = (
            _hash_directory(self._config.openviking_extension_dir)
            if self._openviking_enabled and self._config.openviking_extension_dir is not None
            else None
        )

    @staticmethod
    def name() -> str:
        return "kimchi"

    def to_agent_info(self) -> AgentInfo:
        if self._multi_model_enabled:
            return AgentInfo(
                name=self.name(),
                version=self.version() or "unknown",
                model_info=ModelInfo(name="multi-model", provider="kimchi"),
            )
        return super().to_agent_info()

    def get_version_command(self) -> str | None:
        # PI_PACKAGE_DIR tells entry.ts where to find package.json + theme/; without it
        # the binary falls back to $XDG_DATA_HOME/$HOME and errors out before printing the version.
        return f"PI_PACKAGE_DIR={shlex.quote(PI_PACKAGE_DIR)} {shlex.quote(BINARY_PATH)} --version"

    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    def _classify_exec_error(self, command: str, result: Any) -> NonZeroAgentExitCodeError:
        return_code = getattr(result, "return_code", 1)
        return KimchiExitError(
            command=command,
            exit_code=int(return_code if return_code is not None else 1),
            stdout=getattr(result, "stdout", None),
            stderr=getattr(result, "stderr", None),
        )

    async def install(self, environment: BaseEnvironment) -> None:
        host_stage_dir = await self._resolve_host_stage_dir(environment)
        # Upload the stage dir verbatim. It contains bin/kimchi and
        # share/kimchi/{package.json, theme/, export-html/} — resolved at runtime via PI_PACKAGE_DIR.
        await environment.upload_dir(source_dir=host_stage_dir, target_dir=UPLOAD_STAGE_DIR)
        if self._openviking_enabled:
            assert self._config.openviking_extension_dir is not None
            await environment.upload_dir(
                source_dir=self._config.openviking_extension_dir,
                target_dir=OPENVIKING_UPLOAD_STAGE_DIR,
            )
        install_parts = [
            f"mkdir -p {INSTALL_DIR}",
            f"cp -a {shlex.quote(UPLOAD_STAGE_DIR)}/. {shlex.quote(INSTALL_DIR)}/",
            f"chmod 0755 {shlex.quote(BINARY_PATH)}",
            f"rm -rf {shlex.quote(UPLOAD_STAGE_DIR)}",
        ]
        if self._openviking_enabled:
            config_json = json.dumps(OPENVIKING_LEARNING_CONFIG, separators=(",", ":"))
            create_session_adapter = (
                f"s|{OPENVIKING_CREATE_SESSION_SOURCE}|{OPENVIKING_CREATE_SESSION_REPLACEMENT}|"
            )
            ensure_session_adapter = (
                f"/{re.escape(OPENVIKING_SESSION_ASSIGN_SOURCE)}/"
                f"{{n;s|return true;|{OPENVIKING_ENSURE_SESSION_REPLACEMENT}|;}}"
            )
            install_parts.extend(
                [
                    f"rm -rf {shlex.quote(OPENVIKING_INSTALL_DIR)}",
                    f"mkdir -p {shlex.quote(OPENVIKING_INSTALL_DIR)}",
                    (
                        f"cp -a {shlex.quote(OPENVIKING_UPLOAD_STAGE_DIR)}/. "
                        f"{shlex.quote(OPENVIKING_INSTALL_DIR)}/"
                    ),
                    (
                        f"printf '%s\\n' {shlex.quote(config_json)} > "
                        f"{shlex.quote(f'{OPENVIKING_INSTALL_DIR}/config.json')}"
                    ),
                    (
                        f"grep -Fq {shlex.quote(OPENVIKING_CREATE_SESSION_SOURCE)} "
                        f"{shlex.quote(OPENVIKING_CLIENT_PATH)} || "
                        "{ echo 'Unsupported OpenViking extension: createSession adapter point missing' >&2; "
                        "exit 2; }"
                    ),
                    (
                        f"sed -i {shlex.quote(create_session_adapter)} "
                        f"{shlex.quote(OPENVIKING_CLIENT_PATH)}"
                    ),
                    (
                        f"grep -Fq {shlex.quote(OPENVIKING_SESSION_ASSIGN_SOURCE)} "
                        f"{shlex.quote(OPENVIKING_SYNC_PATH)} || "
                        "{ echo 'Unsupported OpenViking extension: ensureSession adapter point missing' >&2; "
                        "exit 2; }"
                    ),
                    (
                        f"sed -i {shlex.quote(ensure_session_adapter)} "
                        f"{shlex.quote(OPENVIKING_SYNC_PATH)}"
                    ),
                    (
                        f"grep -Fq {shlex.quote(OPENVIKING_ENSURE_SESSION_REPLACEMENT)} "
                        f"{shlex.quote(OPENVIKING_SYNC_PATH)} || "
                        "{ echo 'Unsupported OpenViking extension: ensureSession adapter failed' >&2; "
                        "exit 2; }"
                    ),
                    f"chmod -R a+rX {shlex.quote(OPENVIKING_INSTALL_DIR)}",
                    f"rm -rf {shlex.quote(OPENVIKING_UPLOAD_STAGE_DIR)}",
                ]
            )
        await self.exec_as_root(
            environment,
            command=" && ".join(install_parts),
        )

    async def _resolve_host_stage_dir(self, environment: BaseEnvironment) -> Path:
        """Return the host directory to upload — a ``bin/`` + ``share/kimchi/`` tree."""
        if self._config.binary_path is not None:
            # KIMCHI_CODE_BINARY points at the binary (e.g. dist/bin/kimchi). The stage dir is
            # the tarball-layout root two levels up (e.g. dist/), which also holds share/kimchi/.
            stage_dir = self._config.binary_path.parent.parent
            share_marker = stage_dir / SHARE_RELPATH / "package.json"
            if not share_marker.is_file():
                raise RuntimeError(
                    f"Expected auxiliary files at {share_marker} alongside the binary at "
                    f"{self._config.binary_path}. Run `pnpm run build:binary` (or build:binary-linux-x64) "
                    "to produce the full bin/ + share/ layout."
                )
            return stage_dir
        arch = await self._detect_container_arch(environment)
        with GitHubClient(token=self._config.github_token) as gh:
            release = gh.resolve_latest(self._config.github_repo)
            self.logger.info(
                "Fetching kimchi release",
                extra={"tag": release.tag_name, "arch": arch, "repo": self._config.github_repo},
            )
            return gh.download_and_extract(release, arch)

    async def _detect_container_arch(self, environment: BaseEnvironment) -> str:
        # Read e_machine (1 byte at offset 18) from /bin/sh's ELF header. uname -m reports
        # the kernel arch, which under Docker Desktop Rosetta on Apple Silicon is arm64
        # even when the userland is amd64. The dynamic loader only honors the userland
        # arch, so we read it directly from a binary that's guaranteed to exist.
        result = await self.exec_as_agent(environment, command="od -An -t x1 -j 18 -N 1 /bin/sh")
        e_machine = (result.stdout or "").strip().lower()
        match e_machine:
            case "3e":
                return "amd64"
            case "b7":
                return "arm64"
            case _:
                raise RuntimeError(
                    f"Unsupported container arch (ELF e_machine=0x{e_machine or '??'}); "
                    "kimchi release assets only cover amd64/arm64"
                )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self._multi_model_enabled:
            # kimchi's built-in pi-ai catalog also registers models like kimi-k2.5 under
            # the opencode provider. Without a qualifier the resolver may pick opencode and
            # fail auth with the kimchi key, so we force the caller to be explicit.
            _validate_model_name(self.model_name)

        cli_flags = self.build_cli_flags()
        if cli_flags:
            cli_flags += " "

        # Harbor 0.18 no longer merges _extra_env into each exec call, so pass
        # merged tags explicitly. Cache the value so a second run on the same
        # instance keeps the generated local run id stable.
        user_tags = self._get_env("KIMCHI_TAGS") or ""
        kimchi_tags = self._merge_kimchi_tags(user_tags)
        self._extra_env["KIMCHI_TAGS"] = kimchi_tags

        # When the bench opts into a one-shot ferment per trial, pin the ferments
        # directory under /logs/agent — which is bind-mounted to
        # jobs/<run>/<task>__<trial>/agent/ on the host. The snapshot
        # (<uuid>.json) and append-only event log (<uuid>.events.jsonl) then end
        # up alongside kimchi.txt and sessions/ for post-run inspection.
        ferment_env: dict[str, str] = {}
        if self._resolved_flags.get("ferment-oneshot"):
            ferment_env["KIMCHI_FERMENTS_DIR"] = f"{CONTAINER_LOGS_DIR}/ferments"

        env = {
            "KIMCHI_API_KEY": self._config.api_key,
            # Configure Kimchi's own harness-level breaker for benchmark runs.
            # Harbor trial retries and non-Kimchi agents use separate policies.
            KIMCHI_INFRA_BREAKER_THRESHOLD_ENV: _resolve_infra_breaker_threshold(
                self._get_env(KIMCHI_INFRA_BREAKER_THRESHOLD_ENV)
            ),
            "KIMCHI_TAGS": kimchi_tags,
            "PI_PACKAGE_DIR": PI_PACKAGE_DIR,
            **ferment_env,
        }
        if self._openviking_enabled:
            openviking_url = self._get_env("OPENVIKING_URL") or self._get_env("OPENVIKING_BASE_URL")
            if not openviking_url:
                raise ValueError(
                    "OPENVIKING_URL (or OPENVIKING_BASE_URL) is required for the OpenViking benchmark agent"
                )
            for key in OPENVIKING_ENV_KEYS:
                value = self._get_env(key)
                if value is not None:
                    env[key] = value
            env.setdefault("OPENVIKING_CREDENTIAL_SOURCE", "env")
            env.setdefault("OPENVIKING_WORKSPACE_PEER", "0")
            env.setdefault("OPENVIKING_RECALL_PEER_SCOPE", "actor")
            env.setdefault("OPENVIKING_PEER_ID", self._default_openviking_peer_id())
            env["OV_DEBUG_LOG"] = CONTAINER_OPENVIKING_DEBUG_LOG

        # Pipe the prompt via stdin instead of as a positional arg: pi-coding-agent's
        # parseArgs treats any token starting with `-` as a flag (no `--` end-of-options
        # marker), which deterministically crashes on instructions like "- You are given...".
        #
        # Run kimchi in its own process group and persist the pgid in /logs/agent.
        # Harbor enforces the agent timeout around this coroutine; when that outer
        # wait is cancelled, docker compose may leave the in-container process tree
        # alive. The pgid lets us terminate kimchi and its tool/subagent children
        # before verification starts.
        try:
            await self.exec_as_agent(
                environment,
                command=self._kimchi_launch_command(instruction, cli_flags),
                env=env,
            )
        except asyncio.CancelledError:
            await self._terminate_kimchi_process_group(environment)
            raise

    def _kimchi_launch_command(self, instruction: str, cli_flags: str) -> str:
        runner = self._kimchi_command(cli_flags)
        parts = [
            # Ensure kimchi has a stable location for the main session and any
            # subagent session files before the process starts.
            f"mkdir -p {shlex.quote(CONTAINER_SESSIONS_DIR)}",
            # Drop stale state from a previous interrupted attempt in the same
            # mounted logs directory.
            f"rm -f {shlex.quote(CONTAINER_AGENT_PGID_FILE)}",
        ]
        if self._openviking_enabled:
            parts.append(
                f"rm -f {shlex.quote(CONTAINER_OPENVIKING_DEBUG_LOG)} "
                f"{shlex.quote(CONTAINER_OPENVIKING_STATUS)}"
            )
        harness_settings = self._harness_settings_command()
        if harness_settings:
            parts.append(harness_settings)
        skills_registration = self._skills_registration_command()
        if skills_registration:
            parts.append(skills_registration)

        parts.append(
            # Enable job control so the backgrounded kimchi pipeline gets a
            # process group that can be terminated as a unit on timeout.
            "set -m && { "
            # Feed the task prompt through stdin and background the pipeline so
            # this wrapper shell can record the process-group id before waiting.
            f"(printf '%s' {shlex.quote(instruction)} | {runner}) & "
            # $! is the pid of the most recent background job, here the kimchi
            # pipeline leader as seen by the shell.
            "agent_pid=$!; "
            # ps -o pgid= prints just the process-group id with no header. Stay
            # POSIX so this also works under dash (Debian/Ubuntu /bin/sh) and
            # avoid parsing /proc/<pid>/stat, whose comm field can contain
            # whitespace and shift downstream field indices.
            'agent_pgid=$(ps -o pgid= -p "$agent_pid" 2>/dev/null | tr -d "[:space:]" || true); '
            # Persist the pgid in /logs/agent so cancellation cleanup, which
            # runs in a separate docker exec, can find the process group.
            f"printf '%s\\n' \"${{agent_pgid:-$agent_pid}}\" > {shlex.quote(CONTAINER_AGENT_PGID_FILE)}; "
            # Wait for kimchi and preserve its real exit status for Harbor.
            'wait "$agent_pid"; '
            "agent_status=$?; "
            f"{self._openviking_post_run_shell()}"
            # Normal completion should not leave stale cleanup state behind.
            f"rm -f {shlex.quote(CONTAINER_AGENT_PGID_FILE)}; "
            'exit "$agent_status"; '
            "}"
        )
        return " && ".join(parts)

    def _harness_settings_command(self) -> str:
        # Compose the global harness settings (~/.config/kimchi/harness/
        # settings.json) as one JSON object — the file is written wholesale, so
        # every key must land in a single write or the last writer clobbers the
        # rest.
        settings: dict[str, Any] = {}
        if self._multi_model_enabled:
            settings["multiModel"] = True
        if self._disable_compaction:
            # Read by kimchi through pi's SettingsManager: disables upstream
            # threshold auto-compaction and both ferment compaction paths.
            settings["compaction"] = {"enabled": False}
        if not settings:
            return ""

        settings_json = json.dumps(settings, separators=(",", ":"))
        return (
            f"mkdir -p {CONTAINER_HARNESS_SETTINGS_DIR} && "
            f"printf '%s\\n' {shlex.quote(settings_json)} > {CONTAINER_HARNESS_SETTINGS}"
        )

    def _skills_registration_command(self) -> str:
        if not self.skills_dir:
            return ""

        return (
            f"mkdir -p {CONTAINER_HARNESS_SKILLS_DIR} && "
            f"{{ cp -a {shlex.quote(self.skills_dir)}/. {CONTAINER_HARNESS_SKILLS_DIR}/ || true; }}"
        )

    def _kimchi_command(self, cli_flags: str) -> str:
        model_flag = ""
        if not self._multi_model_enabled:
            model_flag = f"--model {shlex.quote(self.model_name or '')} "

        extension_flag = ""
        if self._openviking_enabled:
            extension_flag = f"--extension {shlex.quote(OPENVIKING_ENTRYPOINT)} "

        return (
            f"{shlex.quote(BINARY_PATH)} "
            f"--print --session {shlex.quote(CONTAINER_MAIN_SESSION)} "
            f"{model_flag}"
            f"{extension_flag}"
            f"{cli_flags}"
        )

    def _default_openviking_peer_id(self) -> str:
        task = self._auto_tags().get("task", "terminal-bench")
        return _safe_openviking_peer_id(f"tb-{task}")

    def _openviking_post_run_shell(self) -> str:
        if not self._openviking_enabled:
            return ""
        extension_sha = self._openviking_extension_sha256 or "unknown"
        connected_status = json.dumps(
            {
                "connected": True,
                "extension_sha256": extension_sha,
                "config": OPENVIKING_LEARNING_CONFIG,
            },
            separators=(",", ":"),
        )
        disconnected_status = json.dumps(
            {
                "connected": False,
                "extension_sha256": extension_sha,
                "config": OPENVIKING_LEARNING_CONFIG,
                "error": "No OpenViking turn capture was recorded",
            },
            separators=(",", ":"),
        )
        return (
            f"if [ -s {shlex.quote(CONTAINER_OPENVIKING_DEBUG_LOG)} ]; then "
            f"printf '%s\\n' {shlex.quote(connected_status)} > {shlex.quote(CONTAINER_OPENVIKING_STATUS)}; "
            "else "
            f"printf '%s\\n' {shlex.quote(disconnected_status)} > {shlex.quote(CONTAINER_OPENVIKING_STATUS)}; "
            f"if [ \"$agent_status\" -eq 0 ]; then agent_status={OPENVIKING_DISCONNECTED_EXIT_CODE}; fi; "
            "fi; "
        )

    async def _terminate_kimchi_process_group(self, environment: BaseEnvironment) -> None:
        command = (
            # The pgid file is written by _kimchi_launch_command while kimchi is running.
            # Validate it before using it as a negative pid target for kill(1).
            f"if [ -s {shlex.quote(CONTAINER_AGENT_PGID_FILE)} ]; then "
            f"pgid=$(cat {shlex.quote(CONTAINER_AGENT_PGID_FILE)} 2>/dev/null || true); "
            'case "$pgid" in '
            "*[!0-9]*|'') ;; "
            "*) "
            # Terminate the whole process group: kimchi, tools, and subagents.
            # The -PGID target is already unambiguously numeric, so no `--`
            # end-of-options marker is needed (and dash's kill builtin doesn't
            # consistently honor one).
            'kill -TERM "-$pgid" 2>/dev/null || true; '
            "sleep 2; "
            # Escalate if anything ignored SIGTERM.
            'kill -KILL "-$pgid" 2>/dev/null || true; '
            ";; "
            "esac; "
            "fi; "
            # Always remove the marker; if cleanup ran, this trial is done.
            f"rm -f {shlex.quote(CONTAINER_AGENT_PGID_FILE)}"
        )
        await self._run_cleanup_command(environment, command)

    async def _run_cleanup_command(self, environment: BaseEnvironment, command: str) -> None:
        try:
            await asyncio.wait_for(self.exec_as_root(environment, command=command), timeout=10)
        except Exception as exc:
            self.logger.warning(
                "Failed to terminate kimchi process group after cancellation",
                extra={"error": str(exc)},
            )

    def _auto_tags(self) -> dict[str, str]:
        # logs_dir is expected to be jobs/<run>/<task>__<trial>/agent. Derive
        # run / task / trial from that ancestry so they're injected automatically
        # and survive glob / full-dataset runs where the user can't statically
        # know the task name.
        trial_dir = self.logs_dir.parent
        run_dir = trial_dir.parent
        if self.logs_dir.name != "agent" or run_dir.parent.name != "jobs":
            self.logger.debug(
                "Skipping auto KIMCHI_TAGS; logs_dir does not match jobs/<run>/<task>__<trial>/agent",
                extra={"logs_dir": str(self.logs_dir)},
            )
            return {}
        trial_id = trial_dir.name
        return {
            "run": run_dir.name,
            "task": trial_id.split("__", 1)[0],
            "trial": trial_id,
        }

    def _merge_kimchi_tags(self, user_raw: str) -> str:
        # User-supplied values via --ae KIMCHI_TAGS=... win on key collision.
        user_raw = user_raw.strip()
        user_keys: set[str] = set()
        for tag in user_raw.split(","):
            if ":" not in tag:
                continue
            key = tag.split(":", 1)[0].strip()
            if key:
                user_keys.add(key)

        merged = [f"{k}:{v}" for k, v in self._auto_tags().items() if k not in user_keys]
        if user_raw:
            merged.append(user_raw)
        return ",".join(merged)

    def populate_context_post_run(self, context: AgentContext) -> None:
        sessions_dir = self.logs_dir / "sessions"
        total_input_tokens = 0
        total_output_tokens = 0
        total_cache_read_tokens = 0
        total_cache_write_tokens = 0
        total_cost = 0.0

        # Aggregate main.jsonl + Agent child <timestamp>_<uuid>.jsonl siblings.
        # Agent runs are separate sessions, so their usage isn't reflected in main.jsonl.
        session_files = sorted(sessions_dir.glob("*.jsonl")) if sessions_dir.is_dir() else []
        for session_file in session_files:
            try:
                lines = session_file.read_text().splitlines()
            except OSError as exc:
                self.logger.warning(
                    "Skipping unreadable kimchi session file during token aggregation",
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

        # pi-ai treats input, cacheRead, cacheWrite as disjoint summing to totalTokens
        # (see node_modules/.../pi-ai/dist/providers/anthropic.js). Sum all three for
        # the wire-level prompt total.
        context.n_input_tokens = total_input_tokens + total_cache_read_tokens + total_cache_write_tokens
        context.n_output_tokens = total_output_tokens
        context.n_cache_tokens = total_cache_read_tokens
        context.cost_usd = total_cost if total_cost > 0 else None
        if self._openviking_enabled:
            metadata = dict(context.metadata or {})
            status_path = self.logs_dir / Path(CONTAINER_OPENVIKING_STATUS).name
            try:
                metadata["openviking"] = json.loads(status_path.read_text())
            except (OSError, json.JSONDecodeError):
                metadata["openviking"] = {
                    "connected": False,
                    "extension_sha256": self._openviking_extension_sha256,
                    "error": "OpenViking status artifact is missing or invalid",
                }
            context.metadata = metadata


class KimchiOpenViking(Kimchi):
    """Kimchi benchmark agent with the official OpenViking Pi extension enabled."""

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("openviking", True)
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "kimchi-openviking"
