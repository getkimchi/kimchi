"""Standard Claude Code agent for terminal-bench.

Extends harbor's built-in :class:`~harbor.agents.installed.claude_code.ClaudeCode`
to add the terminal-bench-specific setup that every agent needs (git install,
git baseline commit) and the retryable-API-error classification that lets
harbor's retry loop handle transient Anthropic API failures.

Unlike :class:`~kimchi_agent.claude_code_kimchi.ClaudeCodeKimchi`, this agent
does **not** route through the Kimchi gateway.  It uses Claude Code's native
Anthropic API authentication (``ANTHROPIC_API_KEY``), so model names are
standard Anthropic model IDs (e.g. ``anthropic/claude-sonnet-4-20250514``).
The base class strips the ``anthropic/`` prefix automatically.
"""

import asyncio
import shlex

from harbor.agents.installed.base import NonZeroAgentExitCodeError, with_prompt_template
from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_chain, wait_fixed

from kimchi_agent.claude_code_kimchi import (
    CLAUDE_CODE_INSTALL_RETRY_DELAYS_SEC,
    CLAUDE_CODE_OUTPUT_PATH,
    ClaudeCodeKimchi,
    RetryableApiError,
)
from kimchi_agent.git_install import (
    GIT_INSTALL_COMMAND,
    GIT_INSTALL_ENV,
    git_config_command,
    git_init_and_commit_baseline_command,
)


class ClaudeCodeStandard(ClaudeCode):
    """Harbor Claude Code agent using the standard Anthropic API.

    Adds git install + baseline (needed by terminal-bench tasks) and
    retryable-API-error classification on top of the base ``ClaudeCode``
    agent.  Model selection, env building, and the Claude Code install are
    handled by the base class.
    """

    @staticmethod
    def name() -> str:
        return "claude-code-standard"

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

    def _log_install_retry(self, retry_state) -> None:  # type: ignore[no-untyped-def]
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

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Commit a baseline snapshot so ``git diff`` after the run shows only
        # the agent's changes.  No special env needed — git is already
        # installed by ``install()``.
        await self.exec_as_agent(
            environment,
            command=git_init_and_commit_baseline_command(workdir=""),
        )

        try:
            await super().run(instruction, environment, context)
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
        return ClaudeCodeKimchi._retryable_api_error_from_stream(result.stdout)

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
        return ClaudeCodeKimchi._non_retryable_api_error_from_stream(result.stdout)
