import asyncio
import base64
import json
import os
import secrets
import shlex
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

from pier.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist
from pydantic import ValidationError

from kimchi_agent.config import KimchiAgentConfig
from kimchi_agent.framework import HarborCompatMixin, agent_info_types
from kimchi_agent.git_install import (
    GIT_INSTALL_COMMAND,
    GIT_INSTALL_ENV,
    git_config_command,
    git_init_and_commit_baseline_command,
)
from kimchi_agent.messages import SessionEntry
from kimchi_agent.moonshot import (
    MOONSHOT_API_KEY_ENV,
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
    OpenRouterClient,
    is_openrouter_model,
)
from kimchi_agent.release import BINARY_RELPATH, SHARE_RELPATH, GitHubClient
from kimchi_agent.zai import (
    ZAI_API_KEY_ENV,
    ZAI_ENDPOINT_ENV,
    is_zai_model,
)
from kimchi_agent.zai import (
    build_models_config as build_zai_models_config,
)

if TYPE_CHECKING:
    from harbor.environments.base import BaseEnvironment
    from pier.models.agent.context import AgentContext


# The release tarball (and local `pnpm run build:binary` output) is laid out as
# `bin/kimchi` + `share/kimchi/{package.json, theme/, export-html/}`. We
# preserve that layout under /installed-agent so the binary can find its auxiliary
# files via PI_PACKAGE_DIR (see src/entry.ts → resolveAuxiliaryFilesDir).
INSTALL_DIR = "/installed-agent"
BINARY_PATH = f"{INSTALL_DIR}/{BINARY_RELPATH.as_posix()}"
PI_PACKAGE_DIR = f"{INSTALL_DIR}/{SHARE_RELPATH.as_posix()}"
UPLOAD_STAGE_DIR = "/tmp/kimchi-stage"

# In-container paths. /logs/agent is bind-mounted to self.logs_dir on the host.
CONTAINER_LOGS_DIR = "/logs/agent"
CONTAINER_SESSIONS_DIR = f"{CONTAINER_LOGS_DIR}/sessions"
CONTAINER_MAIN_SESSION = f"{CONTAINER_SESSIONS_DIR}/main.jsonl"
CONTAINER_AGENT_PGID_FILE = f"{CONTAINER_LOGS_DIR}/kimchi-agent.pgid"
CONTAINER_HARNESS_SETTINGS_DIR = "~/.config/kimchi/harness"
CONTAINER_HARNESS_SETTINGS = f"{CONTAINER_HARNESS_SETTINGS_DIR}/settings.json"
CONTAINER_HARNESS_SKILLS_DIR = f"{CONTAINER_HARNESS_SETTINGS_DIR}/skills"
KIMCHI_API_KEY_ENV = "KIMCHI_API_KEY"
ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY"
ANTHROPIC_PROVIDER = "anthropic"
MULTI_MODEL = "multi-model"
KIMCHI_INFRA_BREAKER_THRESHOLD_ENV = "KIMCHI_INFRA_BREAKER_THRESHOLD"
KIMCHI_BENCHMARK_INFRA_BREAKER_DEFAULT_ATTEMPTS = "3"
KIMCHI_EXIT_OUTPUT_TAIL_LINES = 20

# Benchmark-only extension for injecting LLM sampling parameters.
# It lives in the benchmarks branch and is installed into the container's
# ~/.config/kimchi/extensions/ auto-discovery directory at runtime.
HOST_EXTENSION_DIR = Path(__file__).parent / "extensions" / "llm-sampling-params"
CONTAINER_EXTENSION_STAGE_DIR = "/tmp/kimchi-llm-ext"
CONTAINER_EXTENSION_INSTALL_DIR = "$HOME/.config/kimchi/extensions/llm-sampling-params"

CONTAINER_HARNESS_MODELS_JSON = f"{CONTAINER_HARNESS_SETTINGS_DIR}/models.json"

# Static metadata for native Anthropic models that bypass the Kimchi gateway.
# The Kimchi metadata API only describes gateway-served models, so native
# anthropic/* models are listed here (context window, output limits, reasoning
# capability). The provider block built from this table must be self-contained —
# see _build_anthropic_models_config.
ANTHROPIC_API_BASE_URL = "https://api.anthropic.com"
_ANTHROPIC_MODEL_METADATA: dict[str, dict[str, Any]] = {
    "claude-sonnet-5": {
        "reasoning": True,
        "context_window": 1_000_000,
        "max_output_tokens": 128_000,
    },
    "claude-opus-4-8": {
        "reasoning": True,
        "context_window": 1_000_000,
        "max_output_tokens": 128_000,
    },
}


def is_anthropic_model(model_name: str | None) -> bool:
    """Whether ``model_name`` is routed via native Anthropic API (``anthropic/<id>``)."""
    return bool(model_name) and model_name.startswith(f"{ANTHROPIC_PROVIDER}/")


def _decode_agent_kwarg(value: object) -> dict[str, Any]:
    """Decode a base64-encoded JSON agent kwarg value into a dict."""
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        raise ValueError(f"Expected string or dict for LLM params kwarg, got {type(value).__name__}")
    value = value.strip()
    if not value:
        return {}
    # Harbor may pass the value with base64 padding stripped.
    padded = value + "=" * (-len(value) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
    except Exception as exc:
        raise ValueError(f"Invalid base64 LLM params kwarg: {exc}") from exc
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"Invalid JSON in LLM params kwarg: {exc}") from exc
    if not isinstance(decoded, dict):
        raise ValueError("LLM params kwarg must decode to an object")
    return decoded


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
    raise ValueError(f"Invalid value for '{name}': expected true/false/1/0/yes/no, got {value!r}")


def _validate_model_name(model_name: str | None) -> None:
    if not model_name or "/" not in model_name:
        raise ValueError(
            "--model is required and must be qualified with a provider "
            "(e.g. kimchi-dev/kimi-k2.7, kimchi-dev/glm-5.2-fp8, kimchi-dev/minimax-m3, "
            "openrouter/z-ai/glm-5.2)"
        )
    provider, model_id = model_name.split("/", 1)
    if not provider or not model_id:
        raise ValueError(
            f"--model must be qualified as <provider>/<id> (got {model_name!r}); use e.g. kimchi-dev/kimi-k2.7"
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


class KimchiExitError(NonZeroAgentExitCodeError):
    """Raised when the kimchi process exits non-zero."""

    def __init__(self, *, command: str, exit_code: int, stdout: str | None, stderr: str | None) -> None:
        self.command = command
        self.exit_code = exit_code
        self.stdout = _tail_output(stdout)
        self.stderr = _tail_output(stderr)
        super().__init__(
            f"Kimchi exited with code {self.exit_code}: {self.command}\nstdout:\n{self.stdout}\nstderr:\n{self.stderr}"
        )


class Kimchi(HarborCompatMixin, BaseInstalledAgent):
    """Harbor agent that runs the kimchi binary inside the task container.

    Binary source:
        1. If ``KIMCHI_CODE_BINARY`` is set on the host, that file is uploaded.
        2. Otherwise, the latest GitHub release from ``getkimchi/kimchi`` is
           downloaded, sha256-verified, and extracted on the host, then uploaded.

    ``kimchi-dev/*`` models route through the Kimchi LLM gateway using
    ``KIMCHI_API_KEY``. ``openrouter/*`` models route directly through OpenRouter
    using ``OPENROUTER_API_KEY``, ``anthropic/*`` through the native Anthropic API
    using ``ANTHROPIC_API_KEY``, ``zai/*`` through Z.AI's API using
    ``ZAI_API_KEY``, and ``moonshotai/*`` through the native Moonshot API using
    ``MOONSHOT_API_KEY``.
    """

    CLI_FLAGS: ClassVar[list[CliFlag]] = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            # Mirrors `kimchi --thinking` (off..max; max added in kimchi #963).
            # 'max' was missing here, so a max run failed enum coercion before
            # kimchi was ever launched — despite the CI input offering it.
            choices=["off", "minimal", "low", "medium", "high", "xhigh", "max"],
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
        multi_model_kwarg = kwargs.pop("multi-model", None)
        disable_multi_model = _coerce_bool_kwarg(kwargs.pop("disable-multi-model", False), "disable-multi-model")
        # Compaction follows kimchi's default (on) unless explicitly disabled.
        disable_compaction = _coerce_bool_kwarg(kwargs.pop("disable-compaction", False), "disable-compaction")

        llm_params = _decode_agent_kwarg(kwargs.pop("llm-params", None))
        llm_per_model_params = _decode_agent_kwarg(kwargs.pop("llm-per-model-params", None))

        super().__init__(*args, **kwargs)
        selected_multi_model = self.model_name == MULTI_MODEL
        legacy_multi_model = (
            _coerce_bool_kwarg(multi_model_kwarg, "multi-model") if multi_model_kwarg is not None else False
        )
        if multi_model_kwarg is not None and legacy_multi_model != selected_multi_model:
            raise ValueError("the 'multi-model' agent kwarg must match model_name='multi-model'")
        if selected_multi_model and disable_multi_model:
            raise ValueError("multi-model selection conflicts with legacy 'disable-multi-model=true'")
        self._multi_model_enabled = selected_multi_model
        self._disable_compaction = disable_compaction
        self._llm_params = llm_params
        self._llm_per_model_params = llm_per_model_params
        self._config = KimchiAgentConfig()

    @staticmethod
    def name() -> str:
        return "kimchi"

    def to_agent_info(self):
        """Return the AgentInfo type of the framework driving this process.

        Both Harbor (terminal-bench-2) and Pier (deep-swe) load this class,
        and each framework's pydantic TrialResult only accepts its own
        AgentInfo type. ``agent_info_types()`` picks the matching classes.
        """
        AgentInfo, ModelInfo = agent_info_types()
        if self._multi_model_enabled:
            return AgentInfo(
                name=self.name(),
                version=self.version() or "unknown",
                model_info=ModelInfo(name="multi-model", provider="kimchi"),
            )
        return AgentInfo(
            name=self.name(),
            version=self.version() or "unknown",
            model_info=(
                ModelInfo(
                    name=self._parsed_model_name,
                    provider=self._parsed_model_provider,
                )
                if self._parsed_model_name
                else None
            ),
        )

    def network_allowlist(self) -> NetworkAllowlist:
        """Domains the in-container kimchi binary may need at runtime.

        pier 0.3.0 calls this at environment creation to configure the egress
        proxy. The set is model-dependent: kimchi-dev/* routes through the
        Kimchi gateway, openrouter/* through OpenRouter, anthropic/* through the
        native Anthropic API, zai/* through Z.AI's API, and moonshotai/*
        through the native Moonshot API. Multi-model can route to any of the
        gateway-served providers.
        """
        domains: set[str] = set()
        if self._multi_model_enabled:
            domains.update({"llm.kimchi.dev", "openrouter.ai", "api.anthropic.com"})
        elif is_openrouter_model(self.model_name):
            domains.add("openrouter.ai")
        elif is_anthropic_model(self.model_name):
            domains.add("api.anthropic.com")
        elif is_moonshot_model(self.model_name):
            domains.add("api.moonshot.ai")
        elif is_zai_model(self.model_name):
            # zai/* models route directly through Z.AI's OpenAI-compatible and
            # Anthropic-compatible APIs (both under api.z.ai).
            domains.add("api.z.ai")
        else:
            # kimchi-dev/* models route through the Kimchi LLM gateway.
            domains.add("llm.kimchi.dev")
        return NetworkAllowlist(domains=sorted(domains))

    def install_spec(self) -> AgentInstallSpec:
        """Declarative install steps for Docker image fingerprinting.

        pier 0.3.0 calls this before setup to compute a cache fingerprint and
        to optionally inline install steps into a Dockerfile build context.
        The actual binary upload and copy still happen in :meth:`install`
        (called by harbor's ``setup()``), because ``upload_dir`` cannot be
        expressed as a shell ``InstallStep``.

        Only the pure-shell, idempotent portions (git install + identity) are
        declared here so they can be cached in a Docker layer. The binary copy
        step references the host-uploaded stage dir and must run at setup time.
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

    def get_version_command(self) -> str | None:
        # PI_PACKAGE_DIR tells entry.ts where to find package.json + theme/; without it
        # the binary falls back to $XDG_DATA_HOME/$HOME and errors out before printing the version.
        return f"PI_PACKAGE_DIR={shlex.quote(PI_PACKAGE_DIR)} {shlex.quote(BINARY_PATH)} --version"

    async def setup(self, environment: BaseEnvironment) -> None:
        """Override pier's setup to always run install().

        Pier's BaseInstalledAgent.setup() skips install() when the environment
        was pre-built with install_spec() steps inlined into the Dockerfile
        (is_preinstalled=True). But Kimchi.install() does the binary upload
        (upload_dir + cp), which cannot be expressed as an InstallStep and
        must always run. The install_spec() steps (git install, git config)
        are idempotent, so re-running them is harmless.
        """
        await environment.exec(command=f"mkdir -p {INSTALL_DIR}", user="root")

        setup_dir = self.logs_dir / "setup"
        setup_dir.mkdir(parents=True, exist_ok=True)

        try:
            await self.install(environment)
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"Agent install failed: {exc}") from exc

        if self._version is None:
            version_cmd = self.get_version_command()
            if version_cmd:
                try:
                    version_result = await environment.exec(command=version_cmd)
                    if version_result.return_code == 0 and version_result.stdout:
                        self._version = self.parse_version(version_result.stdout)
                except Exception:
                    pass  # Version detection is best-effort

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

        # Upload the runtime LLM-sampling extension if params were requested.
        # It is staged to /tmp and copied into the binary's auto-discovery directory
        # ($HOME/.config/kimchi/extensions/) at launch time.
        if self._llm_params or self._llm_per_model_params:
            if not HOST_EXTENSION_DIR.is_dir():
                raise RuntimeError(
                    f"LLM sampling extension not found at {HOST_EXTENSION_DIR}. "
                    "Required because llm-params or llm-per-model-params were set."
                )
            await environment.upload_dir(
                source_dir=HOST_EXTENSION_DIR,
                target_dir=CONTAINER_EXTENSION_STAGE_DIR,
            )

        await self.exec_as_root(
            environment,
            command=GIT_INSTALL_COMMAND,
            env=GIT_INSTALL_ENV,
        )

        await self.exec_as_agent(
            environment,
            command=git_config_command(),
        )

        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p {INSTALL_DIR} && "
                f"cp -a {shlex.quote(UPLOAD_STAGE_DIR)}/. {shlex.quote(INSTALL_DIR)}/ && "
                f"chmod 0755 {shlex.quote(BINARY_PATH)} && "
                f"rm -rf {shlex.quote(UPLOAD_STAGE_DIR)}"
            ),
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
            # kimchi's built-in pi-ai catalog also registers models like kimi-k2.7 under
            # the opencode provider. Without a qualifier the resolver may pick opencode and
            # fail auth with the kimchi key, so we force the caller to be explicit.
            _validate_model_name(self.model_name)
            # OpenRouter models are validated against OpenRouter's /api/v1/models
            # endpoint at launch time, not against the Kimchi LLM gateway — so
            # skip the gateway metadata fetch here.
            self._is_openrouter = is_openrouter_model(self.model_name)
            # zai/* models route directly through Z.AI's OpenAI-compatible API —
            # no Kimchi gateway, and metadata is static so no catalogue fetch.
            self._is_zai = is_zai_model(self.model_name)
            # anthropic/* models use the native Anthropic API via pi-ai's built-in
            # provider — no Kimchi gateway involvement.
            self._is_anthropic = is_anthropic_model(self.model_name)
            # moonshotai/* models use the native Moonshot API via pi-ai's
            # built-in provider — no Kimchi gateway involvement.
            self._is_moonshot = is_moonshot_model(self.model_name)
        else:
            self._is_openrouter = False
            self._is_zai = False
            self._is_anthropic = False
            self._is_moonshot = False

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
            # Configure Kimchi's own harness-level breaker for benchmark runs.
            # Harbor trial retries and non-Kimchi agents use separate policies.
            KIMCHI_INFRA_BREAKER_THRESHOLD_ENV: _resolve_infra_breaker_threshold(
                self._get_env(KIMCHI_INFRA_BREAKER_THRESHOLD_ENV)
            ),
            "KIMCHI_TAGS": kimchi_tags,
            "PI_PACKAGE_DIR": PI_PACKAGE_DIR,
            **ferment_env,
        }
        # anthropic/* and moonshotai/* models use the native provider APIs;
        # forward the provider key and do NOT set KIMCHI_API_KEY (the gateway
        # is not involved).
        anthropic_models_config = None
        moonshot_models_config = None
        if self._is_anthropic:
            anthropic_key = self._get_env(ANTHROPIC_API_KEY_ENV)
            if not anthropic_key:
                raise RuntimeError(
                    f"{ANTHROPIC_API_KEY_ENV} is required to run anthropic/* models. "
                    f"Export it on the host and forward it with "
                    f"`--ae {ANTHROPIC_API_KEY_ENV}=${ANTHROPIC_API_KEY_ENV}`."
                )
            env[ANTHROPIC_API_KEY_ENV] = anthropic_key
            anthropic_models_config = self._build_anthropic_models_config()
        elif self._is_moonshot:
            moonshot_key = required_moonshot_api_key(self._get_env)
            env[MOONSHOT_API_KEY_ENV] = moonshot_key
            moonshot_models_config = build_moonshot_models_config(
                split_moonshot_model(self.model_name),
                thinking_level=self._resolved_flags.get("thinking"),
            )
        elif not self._is_openrouter:
            kimchi_key = self._get_env(KIMCHI_API_KEY_ENV)
            if not kimchi_key:
                raise RuntimeError(
                    f"{KIMCHI_API_KEY_ENV} is required to run {self.model_name}. "
                    f"Export it on the host and forward it with "
                    f"`--ae {KIMCHI_API_KEY_ENV}=${KIMCHI_API_KEY_ENV}`."
                )
            env[KIMCHI_API_KEY_ENV] = kimchi_key
        # Forward the OpenRouter API key into the container so kimchi's
        # openai-completions provider can resolve $OPENROUTER_API_KEY from the
        # environment at request time. The key is read from the host env (set
        # by the GitLab CI pipeline) and must be present for openrouter/* models.
        if self._is_openrouter:
            openrouter_key = self._get_env(OPENROUTER_API_KEY_ENV)
            if not openrouter_key:
                raise RuntimeError(
                    f"{OPENROUTER_API_KEY_ENV} is required to run openrouter/* models. "
                    f"Export it on the host and forward it with "
                    f"`--ae {OPENROUTER_API_KEY_ENV}=${OPENROUTER_API_KEY_ENV}`."
                )
            env[OPENROUTER_API_KEY_ENV] = openrouter_key
            _, openrouter_model_id = self.model_name.split("/", 1)
            openrouter_client = OpenRouterClient(
                api_key=openrouter_key, endpoint=self._get_env(OPENROUTER_ENDPOINT_ENV)
            )
            openrouter_models_config = await openrouter_client.build_models_config(
                openrouter_model_id,
                thinking_level=self._resolved_flags.get("thinking"),
            )
        else:
            openrouter_models_config = None
        # Same forwarding contract as the OpenRouter key: kimchi's
        # openai-completions provider resolves $ZAI_API_KEY from the container
        # environment at request time.
        if self._is_zai:
            zai_key = self._get_env(ZAI_API_KEY_ENV)
            if not zai_key:
                raise RuntimeError(
                    f"{ZAI_API_KEY_ENV} is required to run zai/* models. "
                    f"Export it on the host and forward it with "
                    f"`--ae {ZAI_API_KEY_ENV}=${ZAI_API_KEY_ENV}`."
                )
            env[ZAI_API_KEY_ENV] = zai_key
            _, zai_model_id = self.model_name.split("/", 1)
            zai_models_config = build_zai_models_config(
                zai_model_id,
                thinking_level=self._resolved_flags.get("thinking"),
                endpoint=self._get_env(ZAI_ENDPOINT_ENV),
            )
        else:
            zai_models_config = None
        if self._llm_params:
            env["KIMCHI_LLM_PARAMS_JSON"] = json.dumps(self._llm_params)
        if self._llm_per_model_params:
            env["KIMCHI_LLM_PER_MODEL_PARAMS_JSON"] = json.dumps(self._llm_per_model_params)

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
                command=self._kimchi_launch_command(
                    instruction,
                    cli_flags,
                    openrouter_models_config=openrouter_models_config,
                    zai_models_config=zai_models_config,
                    anthropic_models_config=anthropic_models_config,
                    moonshot_models_config=moonshot_models_config,
                ),
                env=env,
            )
        except asyncio.CancelledError:
            await self._terminate_kimchi_process_group(environment)
            raise

    def _extension_paths(self) -> list[str]:
        """Paths/specs to load with ``-e``. Empty means no ``-e`` flag at all.

        This and the two hooks below exist so a subclass never has to override
        ``run()``, which owns model validation, tag merging, the env dict,
        process-group launch and cancellation cleanup — and carries
        ``@with_prompt_template``, whose ``render_instruction`` is not
        idempotent, so a subclass calling a decorated ``super().run()`` would
        render the template twice.
        """
        return []

    def _stdin_payload(self, instruction: str) -> str:
        """What to pipe to kimchi, when it is not the instruction verbatim."""
        return instruction

    def _pre_launch_commands(self, instruction: str) -> list[str]:
        """Shell commands to run in the launch pipeline, before kimchi starts."""
        return []

    def _kimchi_launch_command(
        self,
        instruction: str,
        cli_flags: str,
        *,
        openrouter_models_config: dict[str, Any] | None = None,
        zai_models_config: dict[str, Any] | None = None,
        anthropic_models_config: dict[str, Any] | None = None,
        moonshot_models_config: dict[str, Any] | None = None,
    ) -> str:
        runner = self._kimchi_command(cli_flags)
        parts = [
            # Ensure kimchi has a stable location for the main session and any
            # subagent session files before the process starts.
            f"mkdir -p {shlex.quote(CONTAINER_SESSIONS_DIR)}",
            # Drop stale state from a previous interrupted attempt in the same
            # mounted logs directory.
            f"rm -f {shlex.quote(CONTAINER_AGENT_PGID_FILE)}",
        ]
        # Copy the staged LLM-sampling extension into the binary's auto-discovery
        # directory so the extension is loaded at startup without a --extension flag.
        if self._llm_params or self._llm_per_model_params:
            parts.append(
                'ext_dir="$HOME/.config/kimchi/extensions/llm-sampling-params"; '
                'mkdir -p "$ext_dir" && '
                f'cp -a {shlex.quote(CONTAINER_EXTENSION_STAGE_DIR)}/. "$ext_dir/"'
            )
        # Ensure a git repo exists in the task working directory with a
        # committed baseline, but never clobber one that the task image ships
        # with (e.g. fix-git).  Harbor sets the working directory via
        # ``docker exec -w``, so ``$PWD`` is the task workdir at shell start.
        # Capture it before any prior ``cd`` in the parts chain so the git
        # baseline always lands in the task workdir, not in an extension or
        # staging directory a previous step may have cd'd into.
        parts.append(f"TASK_WORKDIR=$PWD && {git_init_and_commit_baseline_command('$TASK_WORKDIR')}")
        harness_settings = self._harness_settings_command()
        if harness_settings:
            parts.append(harness_settings)
        if openrouter_models_config is not None:
            parts.append(self._openrouter_models_command(openrouter_models_config))
        if zai_models_config is not None:
            # _openrouter_models_command writes an arbitrary pi models.json
            # provider block; the file contents, not the method name, are
            # provider-specific.
            parts.append(self._openrouter_models_command(zai_models_config))
        if anthropic_models_config is not None:
            parts.append(self._native_models_command(anthropic_models_config))
        if moonshot_models_config is not None:
            parts.append(self._native_models_command(moonshot_models_config))
        skills_registration = self._skills_registration_command()
        if skills_registration:
            parts.append(skills_registration)
        parts.extend(self._pre_launch_commands(instruction))

        parts.append(
            # Enable job control so the backgrounded kimchi pipeline gets a
            # process group that can be terminated as a unit on timeout.
            "set -m && { "
            # Feed the task prompt (or a subclass-supplied payload) through
            # stdin and background the pipeline so this wrapper shell can
            # record the process-group id before waiting.
            f"(printf '%s' {shlex.quote(self._stdin_payload(instruction))} | {runner}) & "
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
        # Absent, kimchi defaults to multi-model ON — and a workflow step is a spawned
        # process whose argv has no --model, so it reads this file, not the launch flag.
        settings["multiModel"] = self._multi_model_enabled
        provider, _, model_id = (self.model_name or "").partition("/")
        if not self._multi_model_enabled and provider and model_id:
            # Those same subprocesses would otherwise start on kimchi's built-in default
            # rather than the model this run is labelled with.
            settings["defaultProvider"] = provider
            settings["defaultModel"] = model_id
        if self._disable_compaction:
            # Read by kimchi through pi's SettingsManager: disables upstream
            # threshold auto-compaction and both ferment compaction paths.
            settings["compaction"] = {"enabled": False}

        settings_json = json.dumps(settings, separators=(",", ":"))
        return (
            f"mkdir -p {CONTAINER_HARNESS_SETTINGS_DIR} && "
            f"printf '%s\\n' {shlex.quote(settings_json)} > {CONTAINER_HARNESS_SETTINGS}"
        )

    def _openrouter_models_command(self, models_config: dict[str, Any]) -> str:
        """Write host-resolved OpenRouter metadata without container runtime dependencies."""
        models_json = json.dumps(models_config, separators=(",", ":"))
        return (
            f"mkdir -p {CONTAINER_HARNESS_SETTINGS_DIR} && "
            f"printf '%s\\n' {shlex.quote(models_json)} > {CONTAINER_HARNESS_MODELS_JSON}"
        )

    def _build_anthropic_models_config(self) -> dict[str, Any]:
        """Build a pi models.json provider block for a native anthropic/* model.

        pi-ai parses a models.json provider entry as a self-contained custom
        provider — it does not merge the entry with the built-in anthropic
        provider. A block without ``api`` is dropped at parse time (``no "api"
        specified``) and a block without ``apiKey`` never resolves auth from
        the environment; either way the registry ends up empty and pi exits
        with ``No models available ... add models to models.json``, classified
        downstream as ``agent_model_catalog_unavailable``. So the block must
        carry api/baseUrl/apiKey alongside the model metadata.
        """
        _, _, model_id = (self.model_name or "").partition("/")
        meta = _ANTHROPIC_MODEL_METADATA.get(model_id)
        if meta is None:
            raise ValueError(
                f"Anthropic model {model_id!r} is not in the static metadata table. "
                f"Known models: {', '.join(sorted(_ANTHROPIC_MODEL_METADATA))}"
            )
        return {
            "providers": {
                ANTHROPIC_PROVIDER: {
                    "api": "anthropic-messages",
                    "baseUrl": ANTHROPIC_API_BASE_URL,
                    # "$ANTHROPIC_API_KEY" is an env reference resolved by pi
                    # at request time, not the key itself, so the bind-mounted
                    # file stays artifact-safe — same contract as zai/*.
                    "apiKey": f"${ANTHROPIC_API_KEY_ENV}",
                    "models": [
                        {
                            "id": model_id,
                            "name": model_id,
                            "reasoning": meta["reasoning"],
                            "input": ["text", "image"],
                            "contextWindow": meta["context_window"],
                            "maxTokens": meta["max_output_tokens"],
                            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                            "provider": ANTHROPIC_PROVIDER,
                            # Claude Sonnet 5 / Opus 4.8 use adaptive thinking
                            # (thinking.type.adaptive + effort), not the legacy
                            # thinking.type.enabled format. Without this flag pi-ai
                            # sends the old format and gets a 400.
                            "compat": {"forceAdaptiveThinking": True},
                        }
                    ],
                }
            }
        }

    def _native_models_command(self, models_config: dict[str, Any]) -> str:
        """Write a native-provider (anthropic/moonshotai) provider block to models.json."""
        models_json = json.dumps(models_config, separators=(",", ":"))
        return (
            f"mkdir -p {CONTAINER_HARNESS_SETTINGS_DIR} && "
            f"printf '%s\\n' {shlex.quote(models_json)} > {CONTAINER_HARNESS_MODELS_JSON}"
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

        # Extension flags, if any, come right after the binary path — before
        # --print/--session/--model — matching the ordering used elsewhere
        # (e.g. the workflow-agent launch command in the design doc).
        extension_flags = "".join(f"-e {shlex.quote(path)} " for path in self._extension_paths())

        return (
            f"{shlex.quote(BINARY_PATH)} "
            f"{extension_flags}"
            # Experimental features (e.g. the daemon tools for services that
            # must outlive the agent session, which graders then connect to)
            # are always enabled on benchmark runs.
            f"--enable-experimental-features "
            f"--print --session {shlex.quote(CONTAINER_MAIN_SESSION)} "
            f"{model_flag}"
            f"{cli_flags}"
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
        auto: dict[str, str] = {}
        # RUN_ID identifies the benchmark run across LLM request tags. In CI,
        # set RUN_ID=gitlab-p$CI_PIPELINE_ID so it matches kimchi_benchmark_runs.run_id.
        # Local runs without RUN_ID get a random hex so each local run is still
        # uniquely traceable.
        run_id = os.environ.get("RUN_ID", "").strip()
        if not run_id:
            run_id = f"local-{secrets.token_hex(6)}"
        auto["run_id"] = run_id
        auto["task"] = trial_id.split("__", 1)[0]
        auto["trial"] = trial_id
        return auto

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
        if not sessions_dir.is_dir():
            return

        total_input_tokens = 0
        total_output_tokens = 0
        total_cache_read_tokens = 0
        total_cache_write_tokens = 0
        total_cost = 0.0

        # rglob, not glob: an extension may nest per-step sessions under
        # sessions/<subdir>/, and a flat glob silently under-reports those
        # as zero tokens for work that really happened.
        for session_file in sorted(sessions_dir.rglob("*.jsonl")):
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
