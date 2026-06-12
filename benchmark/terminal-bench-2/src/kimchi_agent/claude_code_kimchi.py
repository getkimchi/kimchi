import asyncio
import json
import shlex
from typing import Any

from harbor.agents.installed.base import NonZeroAgentExitCodeError, with_prompt_template
from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths
from tenacity import AsyncRetrying, RetryCallState, retry_if_exception, stop_after_attempt, wait_chain, wait_fixed

from kimchi_agent.gateway import (
    KIMCHI_ANTHROPIC_BASE_URL,
    KimchiGatewayMixin,
    KimchiModelMetadata,
)

CLAUDE_CODE_AUTO_COMPACT_PERCENT = 85
CLAUDE_CODE_OUTPUT_RESERVE_TOKENS = 32_768
CLAUDE_CODE_CONTEXT_SAFETY_MARGIN_TOKENS = 8_192
CLAUDE_CODE_OUTPUT_PATH = "/logs/agent/claude-code.txt"
CLAUDE_CODE_INSTALL_RETRY_DELAYS_SEC = (5, 15)
RETRYABLE_API_STATUSES = frozenset({408, 409, 425, 429, 500, 502, 503, 504, 524, 529})
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
    """Harbor Claude Code agent wired to the Kimchi Anthropic gateway."""

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

    def _build_env(self) -> dict[str, str]:
        api_key = self._required_kimchi_api_key()
        model = self._selected_model_metadata(api_key)
        model_id = model.slug
        blocked_env_keys = FORCED_ENV_KEYS | DENIED_ENV_KEYS
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
        env.update({
            "ANTHROPIC_API_KEY": "",
            "ANTHROPIC_AUTH_TOKEN": api_key,
            "ANTHROPIC_BASE_URL": KIMCHI_ANTHROPIC_BASE_URL,
            "ANTHROPIC_MODEL": model_id,
            "ANTHROPIC_DEFAULT_SONNET_MODEL": model_id,
            "ANTHROPIC_DEFAULT_OPUS_MODEL": model_id,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": model_id,
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
        })
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

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = self._build_env()

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
            raise
