"""Cursor Agent CLI adapter for terminal-bench.

Extends harbor's built-in :class:`~harbor.agents.installed.cursor_cli.CursorCli`
to add the terminal-bench-specific setup that every agent needs (git install,
git baseline commit) and install retry on exit-137 (OOM kill during
``cursor-agent`` installation).

Unlike the Kimchi-gateway agents, this adapter does **not** route through
``llm.kimchi.dev``.  The ``cursor-agent`` CLI validates ``CURSOR_API_KEY``
against Cursor's own cloud backend and does not support custom inference
endpoints.  All models in Cursor's hosted catalog are available, including
OSS models like GLM 5.2 and Kimi K2.7 Code.

Model names use the ``cursor/`` prefix (e.g. ``cursor/composer-2.5``,
``cursor/glm-5.2``, ``cursor/kimi-k2.7-code``).  The base class strips the
prefix automatically and passes the slug to ``--model=<slug>``.
"""

import asyncio

from harbor.agents.installed.base import NonZeroAgentExitCodeError, with_prompt_template
from harbor.agents.installed.cursor_cli import CursorCli
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from tenacity import (
    AsyncRetrying,
    RetryCallState,
    retry_if_exception,
    stop_after_attempt,
    wait_chain,
    wait_fixed,
)

from kimchi_agent.git_install import (
    GIT_INSTALL_COMMAND,
    GIT_INSTALL_ENV,
    git_config_command,
    git_init_and_commit_baseline_command,
)

CURSOR_INSTALL_RETRY_DELAYS_SEC = (5, 15)


class CursorAgent(CursorCli):
    """Harbor Cursor CLI agent for terminal-bench.

    Thin subclass of upstream :class:`~harbor.agents.installed.cursor_cli.CursorCli`.
    Adds git install + baseline commit (needed by terminal-bench tasks) and
    install retry on exit-137 (OOM kill).  Uses Cursor's own cloud backend
    with ``CURSOR_API_KEY`` — does NOT route through the Kimchi gateway.
    Supports all models in Cursor's hosted catalog, including OSS models
    like GLM 5.2 and Kimi K2.7 Code.
    """

    @staticmethod
    def name() -> str:
        return "cursor"

    @staticmethod
    def _is_retryable_cursor_install_error(exc: BaseException) -> bool:
        if not isinstance(exc, NonZeroAgentExitCodeError):
            return False
        message = str(exc)
        if "Command failed (exit 137):" not in message:
            return False
        # Discriminate install failures (command ends with `cursor-agent --version`)
        # from run failures (e.g. `cursor-agent --yolo --print ...`).  Both can
        # contain the substring "cursor-agent", but only install failures
        # include `--version`.
        if "cursor-agent --version" not in message:
            return False
        return any(
            marker in message
            for marker in ("cursor.com/install", "@cursor.com/install")
        )

    @classmethod
    def _is_retryable_install_exception(cls, exc: BaseException) -> bool:
        return isinstance(exc, NonZeroAgentExitCodeError) and cls._is_retryable_cursor_install_error(exc)

    def _log_install_retry(self, retry_state: RetryCallState) -> None:
        delay_sec = retry_state.next_action.sleep if retry_state.next_action else None
        self.logger.warning(
            "Cursor Agent installer was killed; retrying install",
            extra={
                "attempt": retry_state.attempt_number,
                "max_attempts": len(CURSOR_INSTALL_RETRY_DELAYS_SEC) + 1,
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
            wait=wait_chain(*(wait_fixed(delay) for delay in CURSOR_INSTALL_RETRY_DELAYS_SEC)),
            stop=stop_after_attempt(len(CURSOR_INSTALL_RETRY_DELAYS_SEC) + 1),
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

        await super().run(instruction, environment, context)


__all__ = ["CURSOR_INSTALL_RETRY_DELAYS_SEC", "CursorAgent"]
