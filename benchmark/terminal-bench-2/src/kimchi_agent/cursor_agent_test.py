import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from harbor.agents.installed.base import NonZeroAgentExitCodeError

from kimchi_agent.cursor_agent import (
    CURSOR_INSTALL_RETRY_DELAYS_SEC,
    CursorAgent,
)


class _FakeException(Exception):
    """Non-NonZeroAgentExitCodeError exception — should never be retried."""


# NonZeroAgentExitCodeError stores positional args and str() returns the tuple
# repr, so the _is_retryable_*_error methods match against str(exc). The real
# Harbor runtime constructs the error with a formatted message string as the
# single argument. Tests replicate that format.
_INSTALL_ERROR_MSG = (
    "Command failed (exit 137): set -euo pipefail; "
    "curl https://cursor.com/install -fsS | bash && "
    'export PATH="$HOME/.local/bin:$PATH" && cursor-agent --version'
)

_RUN_ERROR_MSG = (
    'Command failed (exit 137): cursor-agent --yolo --print '
    '--output-format=stream-json --model=composer-2.5 -- "task"'
)


def _make_install_error(exit_code: int = 137) -> NonZeroAgentExitCodeError:
    msg = _INSTALL_ERROR_MSG.replace("exit 137", f"exit {exit_code}")
    return NonZeroAgentExitCodeError(msg)


class CursorAgentTest(unittest.IsolatedAsyncioTestCase):
    def test_name(self) -> None:
        self.assertEqual(CursorAgent.name(), "cursor")

    def test_install_retry_delays(self) -> None:
        self.assertEqual(CURSOR_INSTALL_RETRY_DELAYS_SEC, (5, 15))

    def test_is_retryable_install_error_exit_137_with_install_markers(self) -> None:
        exc = _make_install_error(exit_code=137)
        self.assertTrue(CursorAgent._is_retryable_cursor_install_error(exc))

    def test_is_retryable_install_error_wrong_exit_code(self) -> None:
        exc = _make_install_error(exit_code=1)
        self.assertFalse(CursorAgent._is_retryable_cursor_install_error(exc))

    def test_is_retryable_install_error_run_command_not_install(self) -> None:
        """Run failures (not install) must not be retried even if exit 137."""
        exc = NonZeroAgentExitCodeError(_RUN_ERROR_MSG)
        self.assertFalse(CursorAgent._is_retryable_cursor_install_error(exc))

    def test_is_retryable_install_error_non_agent_exception(self) -> None:
        self.assertFalse(CursorAgent._is_retryable_cursor_install_error(_FakeException("boom")))

    async def test_install_calls_git_then_upstream_install(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = CursorAgent(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="cursor/composer-2.5",
            )
            root_calls: list[str] = []
            agent_calls: list[str] = []

            async def fake_exec_as_root(environment, command, **kwargs):
                root_calls.append(command)

            async def fake_exec_as_agent(environment, command, **kwargs):
                agent_calls.append(command)

            async def fake_super_install(environment):
                agent_calls.append("__super_install__")

            with (
                patch.object(agent, "exec_as_root", side_effect=fake_exec_as_root),
                patch.object(agent, "exec_as_agent", side_effect=fake_exec_as_agent),
                patch("harbor.agents.installed.cursor_cli.CursorCli.install", side_effect=fake_super_install),
            ):
                await agent.install(environment=None)

        # git install command first
        self.assertTrue(any("git" in cmd for cmd in root_calls))
        # git config second
        self.assertTrue(any("git config --global" in cmd for cmd in agent_calls))
        # upstream install last
        self.assertIn("__super_install__", agent_calls)

    async def test_install_retries_on_exit_137(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = CursorAgent(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="cursor/composer-2.5",
            )
            call_count = 0

            async def fake_exec_as_root(environment, command, **kwargs):
                pass

            async def fake_exec_as_agent(environment, command, **kwargs):
                pass

            async def flaky_super_install(environment):
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    raise _make_install_error(exit_code=137)

            with (
                patch.object(agent, "exec_as_root", side_effect=fake_exec_as_root),
                patch.object(agent, "exec_as_agent", side_effect=fake_exec_as_agent),
                patch("harbor.agents.installed.cursor_cli.CursorCli.install", side_effect=flaky_super_install),
                patch("asyncio.sleep", new_callable=AsyncMock),
            ):
                await agent.install(environment=None)

        self.assertEqual(call_count, 2)

    async def test_install_does_not_retry_non_137_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = CursorAgent(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="cursor/composer-2.5",
            )
            call_count = 0

            async def fake_exec_as_root(environment, command, **kwargs):
                pass

            async def fake_exec_as_agent(environment, command, **kwargs):
                pass

            async def failing_super_install(environment):
                nonlocal call_count
                call_count += 1
                raise NonZeroAgentExitCodeError("Command failed (exit 1): cursor-agent --version")

            with (
                patch.object(agent, "exec_as_root", side_effect=fake_exec_as_root),
                patch.object(agent, "exec_as_agent", side_effect=fake_exec_as_agent),
                patch("harbor.agents.installed.cursor_cli.CursorCli.install", side_effect=failing_super_install),
                patch("asyncio.sleep", new_callable=AsyncMock),
                self.assertRaises(NonZeroAgentExitCodeError),
            ):
                await agent.install(environment=None)

        self.assertEqual(call_count, 1)

    async def test_run_calls_git_baseline_before_super_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = CursorAgent(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="cursor/composer-2.5",
            )
            agent_calls: list[str] = []

            async def fake_exec_as_agent(environment, command, **kwargs):
                agent_calls.append(command)

            async def fake_super_run(instruction, environment, context):
                agent_calls.append("__super_run__")

            with (
                patch.object(agent, "exec_as_agent", side_effect=fake_exec_as_agent),
                patch("harbor.agents.installed.cursor_cli.CursorCli.run", side_effect=fake_super_run),
            ):
                await agent.run(instruction="do the task", environment=None, context=None)

        # git baseline first, then super().run()
        self.assertTrue(any("git init" in cmd or "git commit" in cmd for cmd in agent_calls))
        self.assertEqual(agent_calls[-1], "__super_run__")


if __name__ == "__main__":
    unittest.main()
