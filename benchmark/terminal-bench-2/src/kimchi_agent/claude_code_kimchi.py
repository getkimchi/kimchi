import asyncio
import json
import shlex
from typing import Any

from harbor.agents.installed.base import (
    ApiUsageLimitError,
    NonZeroAgentExitCodeError,
    UnknownApiError,
    with_prompt_template,
)
from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths
from tenacity import AsyncRetrying, RetryCallState, retry_if_exception, stop_after_attempt, wait_chain, wait_fixed

from kimchi_agent.gateway import (
    KIMCHI_ANTHROPIC_BASE_URL,
    KimchiGatewayMixin,
    KimchiModelLimits,
    KimchiModelMetadata,
)
from kimchi_agent.git_install import (
    GIT_INSTALL_COMMAND,
    GIT_INSTALL_ENV,
    git_config_command,
    git_init_and_commit_baseline_command,
)
from kimchi_agent.moonshot import (
    MOONSHOT_ANTHROPIC_BASE_URL,
    is_moonshot_model,
    moonshot_metadata,
    required_moonshot_api_key,
    split_moonshot_model,
)
from kimchi_agent.openrouter import (
    OPENROUTER_API_KEY_ENV,
    OPENROUTER_ENDPOINT_ENV,
    OPENROUTER_PROVIDER,
    OpenRouterClient,
    is_openrouter_model,
    resolve_openrouter_anthropic_base_url,
    split_openrouter_model,
)
from kimchi_agent.zai import (
    ZAI_ANTHROPIC_ENDPOINT_ENV,
    ZAI_API_KEY_ENV,
    ZAI_PROVIDER,
    is_zai_model,
    resolve_zai_anthropic_base_url,
    split_zai_model,
    zai_model,
)

CLAUDE_CODE_AUTO_COMPACT_PERCENT = 85
CLAUDE_CODE_OUTPUT_RESERVE_TOKENS = 32_768
CLAUDE_CODE_CONTEXT_SAFETY_MARGIN_TOKENS = 8_192
CLAUDE_CODE_OUTPUT_PATH = "/logs/agent/claude-code.txt"
CLAUDE_CODE_INSTALL_RETRY_DELAYS_SEC = (5, 15)
# Default API timeout for Claude Code when no API_TIMEOUT_MS is passed through
# the environment. Claude Code's built-in default is 600000ms (10 min); we
# raise it to 15 min so a legitimately long reasoning response from the Kimchi
# gateway doesn't hit a client-side abort before Cloudflare's ~100s origin
# timeout has a chance to surface as a retryable 524 (which the harbor retry
# loop can handle). Callers can override via the API_TIMEOUT_MS passthrough.
CLAUDE_CODE_DEFAULT_API_TIMEOUT_MS = "900000"
K2_7_CODE_THINKING_TOKENS = "32000"
RETRYABLE_API_STATUSES = frozenset({408, 409, 425, 429, 500, 502, 503, 504, 524, 529})
# Non-retryable API statuses that we still want to classify with full error
# text (re-raised as typed exceptions so classify.py can match on them).
NON_RETRYABLE_API_STATUSES = frozenset({403, 404})
RETRYABLE_API_ERROR_MESSAGE_LIMIT = 2_000
CLAUDE_PASSTHROUGH_ENV_PREFIXES = ("CLAUDE_CODE_", "OTEL_")
CLAUDE_PASSTHROUGH_ENV_KEYS = {
    "API_TIMEOUT_MS",
    "MAX_THINKING_TOKENS",
}
BLOCKED_ENV_PREFIXES = ("BASH",)
DENIED_ENV_KEYS = {
    "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "AWS_ACCESS_KEY_ID",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_DEFAULT_REGION",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLOUD_ML_REGION",
    "DISABLE_PROMPT_CACHING",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_PROJECT",
}

FORCED_ENV_KEYS = {
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "CLAUDE_CONFIG_DIR",
    "ENABLE_BACKGROUND_TASKS",
    "FORCE_AUTO_BACKGROUND_TASKS",
    "IS_SANDBOX",
}


class RetryableApiError(RuntimeError):
    """Raised when the agent failed because an upstream API returned a transient error."""

    def __init__(self, status: int, detail: str) -> None:
        self.status = status
        detail = detail.strip()
        suffix = f": {detail}" if detail else ""
        super().__init__(f"Retryable API error {status}{suffix}")


class ClaudeCodeKimchi(KimchiGatewayMixin, ClaudeCode):
    """Harbor Claude Code agent wired to an Anthropic-compatible gateway.

    ``kimchi-dev/*`` models route through the Kimchi gateway using
    ``KIMCHI_API_KEY``. ``openrouter/*`` models route through OpenRouter's
    Anthropic-compatible surface (``https://openrouter.ai/api``) using
    ``OPENROUTER_API_KEY``, ``zai/*`` models route through Z.AI's
    Anthropic-compatible surface (``https://api.z.ai/api/anthropic``) using
    ``ZAI_API_KEY``, and ``moonshotai/*`` models route through Moonshot's
    Anthropic-compatible surface (``https://api.moonshot.ai/anthropic``)
    using ``MOONSHOT_API_KEY``; all four speak Claude Code's native protocol, so only
    the base URL, the auth token, and the model-metadata source differ.
    """

    @staticmethod
    def name() -> str:
        return "claude-code-kimchi"

    @staticmethod
    def _auto_compact_window(model: KimchiModelMetadata) -> str:
        context_window = model.limits.context_window
        output_reserve = min(CLAUDE_CODE_OUTPUT_RESERVE_TOKENS, max(1, context_window // 4))
        safety_margin = min(CLAUDE_CODE_CONTEXT_SAFETY_MARGIN_TOKENS, max(1, context_window // 16))
        percent_window = context_window * CLAUDE_CODE_AUTO_COMPACT_PERCENT // 100
        reserved_window = context_window - output_reserve - safety_margin
        return str(max(1, min(percent_window, reserved_window)))

    @staticmethod
    def _is_retryable_claude_install_error(exc: NonZeroAgentExitCodeError) -> bool:
        message = str(exc)
        if "Command failed (exit 137):" not in message or "claude --version" not in message:
            return False

        return any(
            marker in message
            for marker in (
                "@anthropic-ai/claude-code",
                "claude.ai/install.sh",
                "claude-code-releases/bootstrap.sh",
            )
        )

    @classmethod
    def _is_retryable_install_exception(cls, exc: BaseException) -> bool:
        return isinstance(exc, NonZeroAgentExitCodeError) and cls._is_retryable_claude_install_error(exc)

    def _log_install_retry(self, retry_state: RetryCallState) -> None:
        delay_sec = retry_state.next_action.sleep if retry_state.next_action else None
        self.logger.warning(
            "Claude Code installer was killed; retrying install",
            extra={
                "attempt": retry_state.attempt_number,
                "max_attempts": len(CLAUDE_CODE_INSTALL_RETRY_DELAYS_SEC) + 1,
                "delay_sec": delay_sec,
            },
        )

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=GIT_INSTALL_COMMAND,
            env=GIT_INSTALL_ENV,
        )
        await self.exec_as_agent(
            environment,
            command=git_config_command(),
        )

        retrying = AsyncRetrying(
            retry=retry_if_exception(self._is_retryable_install_exception),
            wait=wait_chain(*(wait_fixed(delay) for delay in CLAUDE_CODE_INSTALL_RETRY_DELAYS_SEC)),
            stop=stop_after_attempt(len(CLAUDE_CODE_INSTALL_RETRY_DELAYS_SEC) + 1),
            before_sleep=self._log_install_retry,
            sleep=asyncio.sleep,
            reraise=True,
        )

        async for attempt in retrying:
            with attempt:
                await super().install(environment)

    def _required_openrouter_api_key(self) -> str:
        api_key = self._get_env(OPENROUTER_API_KEY_ENV)
        if not api_key:
            raise ValueError(
                f"{OPENROUTER_API_KEY_ENV} is required for {OPENROUTER_PROVIDER}/* models. "
                f"Export it on the host and forward it with "
                f"`--ae {OPENROUTER_API_KEY_ENV}=${OPENROUTER_API_KEY_ENV}`."
            )
        return api_key

    def _moonshot_model_metadata(self) -> KimchiModelMetadata:
        """Model metadata for a ``moonshotai/*`` model, from the static table.

        The slug is the id Claude Code must send through Moonshot's
        Anthropic-compatible endpoint — for K3 that is ``kimi-k3[1m]``, which
        selects the 1M-window variant, matching
        https://platform.kimi.ai/docs/guide/claude-code-kimi.
        """
        model = moonshot_metadata(split_moonshot_model(self.model_name))
        model.require_thinking_level(
            self._resolved_flags.get("reasoning_effort"),
            model_name=self.model_name or "moonshotai/unknown",
        )
        return KimchiModelMetadata(
            slug=model.anthropic_model_id,
            limits=KimchiModelLimits(
                context_window=model.context_window,
                max_output_tokens=model.max_output_tokens,
            ),
        )

    def _required_zai_api_key(self) -> str:
        api_key = self._get_env(ZAI_API_KEY_ENV)
        if not api_key:
            raise ValueError(
                f"{ZAI_API_KEY_ENV} is required for {ZAI_PROVIDER}/* models. "
                f"Export it on the host and forward it with "
                f"`--ae {ZAI_API_KEY_ENV}=${ZAI_API_KEY_ENV}`."
            )
        return api_key

    def _zai_model_metadata(self) -> KimchiModelMetadata:
        """Model metadata for a ``zai/*`` model, from the static table.

        Z.AI exposes no OpenRouter-style catalogue, so no network fetch — an
        unknown id raises locally instead of after the container install.
        """
        model_id = split_zai_model(self.model_name)
        meta = zai_model(model_id)
        return KimchiModelMetadata(
            slug=model_id,
            limits=KimchiModelLimits(
                context_window=meta.context_window,
                max_output_tokens=meta.max_output_tokens,
            ),
        )

    async def _openrouter_model_metadata(self, api_key: str) -> KimchiModelMetadata:
        """Model metadata for an ``openrouter/*`` model, from OpenRouter's catalogue.

        Reuses :class:`KimchiModelMetadata` so the auto-compact window is sized
        the same way for both routes. Preset and variant ids are resolved to the
        catalogued model they wrap; Claude Code still receives the id as given.
        """
        model_id = split_openrouter_model(self.model_name)
        client = OpenRouterClient(api_key=api_key, endpoint=self._get_env(OPENROUTER_ENDPOINT_ENV))
        limits = await client.limits_for(await client.resolve(model_id))
        return KimchiModelMetadata(
            slug=model_id,
            limits=KimchiModelLimits(
                context_window=limits.context_window,
                max_output_tokens=limits.max_output_tokens,
            ),
        )

    async def _resolve_routing(self) -> tuple[KimchiModelMetadata, str, str]:
        """Return ``(model, auth token, Anthropic base URL)`` for the selected model."""
        if is_moonshot_model(self.model_name):
            # Key first: a missing key should fail before any container work.
            return (
                self._moonshot_model_metadata(),
                required_moonshot_api_key(self._get_env),
                MOONSHOT_ANTHROPIC_BASE_URL,
            )

        if is_openrouter_model(self.model_name):
            # Key first: a missing key should fail before we hit the network.
            api_key = self._required_openrouter_api_key()
            return (
                await self._openrouter_model_metadata(api_key),
                api_key,
                resolve_openrouter_anthropic_base_url(self._get_env(OPENROUTER_ENDPOINT_ENV)),
            )

        if is_zai_model(self.model_name):
            api_key = self._required_zai_api_key()
            return (
                self._zai_model_metadata(),
                api_key,
                resolve_zai_anthropic_base_url(self._get_env(ZAI_ANTHROPIC_ENDPOINT_ENV)),
            )

        api_key = self._required_kimchi_api_key()
        return self._selected_model_metadata(api_key), api_key, KIMCHI_ANTHROPIC_BASE_URL

    async def _build_env(self) -> dict[str, str]:
        model, api_key, anthropic_base_url = await self._resolve_routing()
        model_id = model.slug
        force_k2_thinking = (
            is_moonshot_model(self.model_name)
            and split_moonshot_model(self.model_name) == "kimi-k2.7-code"
        )
        route_forced_env_keys = {"MAX_THINKING_TOKENS"} if force_k2_thinking else set()
        blocked_env_keys = FORCED_ENV_KEYS | DENIED_ENV_KEYS | route_forced_env_keys
        env = self._passthrough_env(
            prefixes=CLAUDE_PASSTHROUGH_ENV_PREFIXES,
            keys=CLAUDE_PASSTHROUGH_ENV_KEYS,
            blocked_prefixes=BLOCKED_ENV_PREFIXES,
            blocked_keys=blocked_env_keys,
        )
        env.update(
            {
                key: value
                for key, value in self._resolved_env_vars.items()
                if key not in blocked_env_keys and not key.startswith(BLOCKED_ENV_PREFIXES)
            }
        )
        env.update(
            {
                "ANTHROPIC_API_KEY": "",
                "ANTHROPIC_AUTH_TOKEN": api_key,
                "ANTHROPIC_BASE_URL": anthropic_base_url,
                "ANTHROPIC_MODEL": model_id,
                "ANTHROPIC_DEFAULT_SONNET_MODEL": model_id,
                "ANTHROPIC_DEFAULT_OPUS_MODEL": model_id,
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": model_id,
                "ANTHROPIC_DEFAULT_FABLE_MODEL": model_id,
                "ANTHROPIC_SMALL_FAST_MODEL": model_id,
                "ANTHROPIC_CUSTOM_MODEL_OPTION": model_id,
                "CLAUDE_CODE_SUBAGENT_MODEL": model_id,
                "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW": self._auto_compact_window(model),
                "CLAUDE_CONFIG_DIR": (EnvironmentPaths.agent_dir / "sessions").as_posix(),
                "ENABLE_BACKGROUND_TASKS": "1",
                "FORCE_AUTO_BACKGROUND_TASKS": "1",
                "IS_SANDBOX": "1",
            }
        )
        # Default API_TIMEOUT_MS only if the caller did not pass one through
        # (via API_TIMEOUT_MS in the passthrough env). A long timeout prevents
        # Claude Code from aborting on slow first-token responses from the
        # gateway; retryable Cloudflare 524s still surface as
        # RetryableApiError via the stream-log classifier.
        env.setdefault("API_TIMEOUT_MS", CLAUDE_CODE_DEFAULT_API_TIMEOUT_MS)
        if force_k2_thinking:
            # K2.7 requires thinking on. Claude Code has no --thinking flag;
            # a positive fixed budget is its supported non-interactive control.
            env["MAX_THINKING_TOKENS"] = K2_7_CODE_THINKING_TOKENS
        env.update({key: "" for key in DENIED_ENV_KEYS})

        # Harbor merges _extra_env over env=. Remove keys from that channel so
        # per-call env= remains authoritative without copying secrets there.
        self._scrub_extra_env(
            keys=blocked_env_keys,
            prefixes=BLOCKED_ENV_PREFIXES,
        )

        return {key: value for key, value in env.items() if value is not None}

    def _build_setup_command(self) -> str:
        setup_command = (
            "mkdir -p $CLAUDE_CONFIG_DIR/debug $CLAUDE_CONFIG_DIR/projects/-app "
            "$CLAUDE_CONFIG_DIR/shell-snapshots $CLAUDE_CONFIG_DIR/statsig "
            "$CLAUDE_CONFIG_DIR/todos $CLAUDE_CONFIG_DIR/skills && "
            "if [ -d ~/.claude/skills ]; then "
            "cp -r ~/.claude/skills/. $CLAUDE_CONFIG_DIR/skills/ 2>/dev/null || true; "
            "fi"
        )

        skills_command = self._build_register_skills_command()
        if skills_command:
            setup_command += f" && {skills_command}"

        memory_command = self._build_register_memory_command()
        if memory_command:
            setup_command += f" && {memory_command}"

        mcp_command = self._build_register_mcp_servers_command()
        if mcp_command:
            setup_command += f" && {mcp_command}"

        return setup_command

    def _build_run_command(self, instruction: str) -> str:
        cli_flags = self.build_cli_flags()
        extra_flags = (cli_flags + " ") if cli_flags else ""
        return (
            'export PATH="$HOME/.local/bin:$PATH"; '
            "set -o pipefail; "
            f"claude --verbose --output-format=stream-json "
            f"--permission-mode=bypassPermissions "
            f"{extra_flags}"
            f"--print -- {shlex.quote(instruction)} 2>&1 </dev/null | tee "
            f"{shlex.quote(CLAUDE_CODE_OUTPUT_PATH)}"
        )

    @staticmethod
    def _coerce_status(value: Any) -> int | None:
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            try:
                return int(value)
            except ValueError:
                return None
        return None

    @staticmethod
    def _event_text(event: dict[str, Any]) -> str:
        result = event.get("result")
        if isinstance(result, str):
            return result

        message = event.get("message")
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                parts: list[str] = []
                for item in content:
                    if isinstance(item, dict):
                        text = item.get("text")
                        if isinstance(text, str):
                            parts.append(text)
                    elif isinstance(item, str):
                        parts.append(item)
                if parts:
                    return "\n".join(parts)

        error = event.get("error")
        return error if isinstance(error, str) else ""

    @classmethod
    def _retryable_api_error_from_event(cls, event: dict[str, Any]) -> RetryableApiError | None:
        status = cls._coerce_status(event.get("api_error_status"))
        if status not in RETRYABLE_API_STATUSES:
            return None

        is_result_error = event.get("type") == "result" and event.get("is_error") is True
        has_error_marker = event.get("error") is not None
        if not is_result_error and not has_error_marker:
            return None

        detail = cls._event_text(event)
        if len(detail) > RETRYABLE_API_ERROR_MESSAGE_LIMIT:
            detail = f"{detail[:RETRYABLE_API_ERROR_MESSAGE_LIMIT]}..."
        return RetryableApiError(status, detail)

    @classmethod
    def _retryable_api_error_from_stream(cls, stream: str) -> RetryableApiError | None:
        retryable_error: RetryableApiError | None = None
        for line in stream.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue

            event_error = cls._retryable_api_error_from_event(event)
            if event_error is not None:
                retryable_error = event_error
        return retryable_error

    async def _retryable_api_error_from_remote_log(
        self,
        environment: BaseEnvironment,
    ) -> RetryableApiError | None:
        try:
            result = await environment.exec(
                f"cat {shlex.quote(CLAUDE_CODE_OUTPUT_PATH)}",
                timeout_sec=10,
            )
        except Exception:
            self.logger.debug("Failed to read Claude Code output for API error classification", exc_info=True)
            return None

        if result.return_code != 0 or not result.stdout:
            return None
        return self._retryable_api_error_from_stream(result.stdout)

    @classmethod
    def _non_retryable_api_error_from_event(cls, event: dict[str, Any]) -> NonZeroAgentExitCodeError | None:
        """Extract a non-retryable API error with full text from a stream event.

        Harbor's _classify_exec_error truncates stdout to 1000 chars, which
        clips the actual error message at the end of claude-code's init JSON.
        This method re-reads the full stream and raises a typed exception so
        classify.py can match on the exception type and full error text.
        """
        status = cls._coerce_status(event.get("api_error_status"))
        if status not in NON_RETRYABLE_API_STATUSES:
            return None

        is_result_error = event.get("type") == "result" and event.get("is_error") is True
        has_error_marker = event.get("error") is not None
        if not is_result_error and not has_error_marker:
            return None

        detail = cls._event_text(event)
        if len(detail) > RETRYABLE_API_ERROR_MESSAGE_LIMIT:
            detail = f"{detail[:RETRYABLE_API_ERROR_MESSAGE_LIMIT]}..."

        if status == 403:
            return ApiUsageLimitError(detail)
        # 404 and any other non-retryable status
        return UnknownApiError(detail)

    @classmethod
    def _non_retryable_api_error_from_stream(cls, stream: str) -> NonZeroAgentExitCodeError | None:
        """Scan the full claude-code stream for a non-retryable API error."""
        for line in stream.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            error = cls._non_retryable_api_error_from_event(event)
            if error is not None:
                return error
        return None

    async def _non_retryable_api_error_from_remote_log(
        self,
        environment: BaseEnvironment,
    ) -> NonZeroAgentExitCodeError | None:
        """Re-read the full claude-code stream to extract a non-retryable API error.

        Works around Harbor's stdout truncation (1000 chars) by reading the
        full output file that was tee'd to CLAUDE_CODE_OUTPUT_PATH.
        """
        try:
            result = await environment.exec(
                f"cat {shlex.quote(CLAUDE_CODE_OUTPUT_PATH)}",
                timeout_sec=10,
            )
        except Exception:
            self.logger.debug(
                "Failed to read Claude Code output for non-retryable API error classification",
                exc_info=True,
            )
            return None

        if result.return_code != 0 or not result.stdout:
            return None
        return self._non_retryable_api_error_from_stream(result.stdout)

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = await self._build_env()

        await self.exec_as_agent(
            environment,
            command=git_init_and_commit_baseline_command(workdir=""),
            env=env,
        )
        await self.exec_as_agent(
            environment,
            command=self._build_setup_command(),
            env=env,
        )
        try:
            await self.exec_as_agent(
                environment,
                command=self._build_run_command(instruction),
                env=env,
            )
        except NonZeroAgentExitCodeError as exc:
            retryable_error = await self._retryable_api_error_from_remote_log(environment)
            if retryable_error is not None:
                raise retryable_error from exc
            # Re-raise with full error text for non-retryable API errors
            # (403 budget/limit, 404 model access).  Without this, the
            # original exception carries Harbor's truncated stdout (1000
            # chars) and classify.py never sees the actual error message.
            non_retryable_error = await self._non_retryable_api_error_from_remote_log(environment)
            if non_retryable_error is not None:
                raise non_retryable_error from exc
            raise
