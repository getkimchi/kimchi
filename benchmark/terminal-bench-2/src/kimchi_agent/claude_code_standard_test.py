import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from kimchi_agent.claude_code_standard import ClaudeCodeStandard


class FakeEnvironment:
    def __init__(self, stdout: str = "", return_code: int = 0) -> None:
        self.stdout = stdout
        self.return_code = return_code
        self.commands: list[str] = []

    async def exec(self, command: str, cwd=None, env=None, timeout_sec=None, user=None):
        self.commands.append(command)
        return ExecResult(stdout=self.stdout, stderr="", return_code=self.return_code)


class RecordingClaudeCodeStandard(ClaudeCodeStandard):
    """Records all exec_as_agent / exec_as_root calls without touching Docker."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.agent_commands: list[str] = []
        self.root_commands: list[str] = []
        self.agent_envs: list[dict[str, str] | None] = []

    async def exec_as_root(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.root_commands.append(command)

    async def exec_as_agent(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.agent_commands.append(command)
        self.agent_envs.append(env)

    async def populate_context_post_run(self, context: AgentContext) -> None:
        pass


class FailingClaudeCodeStandard(RecordingClaudeCodeStandard):
    """Fails the last exec_as_agent call (the claude run command) with a given exception."""

    def __init__(self, *args, failure: Exception, fail_on_command: int | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.failure = failure
        self._fail_on = fail_on_command

    async def exec_as_agent(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        await super().exec_as_agent(_environment, command, env=env, cwd=cwd, timeout_sec=timeout_sec)
        should_fail = (
            self._fail_on is not None and len(self.agent_commands) == self._fail_on
        ) or (
            self._fail_on is None
            and "claude --verbose" in command
        )
        if should_fail:
            raise self.failure


class InstallRecordingClaudeCodeStandard(ClaudeCodeStandard):
    """Records install-time commands; optionally injects failures."""

    def __init__(self, *args, failures: list[Exception] | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.failures = list(failures or [])
        self.root_commands: list[str] = []
        self.agent_commands: list[str] = []

    async def exec_as_root(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.root_commands.append(command)

    async def exec_as_agent(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.agent_commands.append(command)
        # Only raise failures for commands inside the Claude Code installer
        # retry loop, not for the git install/config steps we prepend.
        if self.failures and "git config" not in command:
            raise self.failures.pop(0)


class ClaudeCodeStandardTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._old_key = os.environ.get("ANTHROPIC_API_KEY")
        os.environ["ANTHROPIC_API_KEY"] = "test-anthropic-key"
        # Clear env vars that could trigger Bedrock / OAuth paths in the base,
        # or the custom-base-URL path (harbor keeps the provider prefix on the
        # model when ANTHROPIC_BASE_URL is set — it is a Kimchi dev-shell var).
        self._old_bedrock = os.environ.pop("CLAUDE_CODE_USE_BEDROCK", None)
        self._old_oauth = os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
        self._old_force_oauth = os.environ.pop("CLAUDE_FORCE_OAUTH", None)
        self._old_base_url = os.environ.pop("ANTHROPIC_BASE_URL", None)

    def tearDown(self) -> None:
        for key, old in [
            ("ANTHROPIC_API_KEY", self._old_key),
            ("CLAUDE_CODE_USE_BEDROCK", self._old_bedrock),
            ("CLAUDE_CODE_OAUTH_TOKEN", self._old_oauth),
            ("CLAUDE_FORCE_OAUTH", self._old_force_oauth),
            ("ANTHROPIC_BASE_URL", self._old_base_url),
        ]:
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old

    @staticmethod
    def _killed_claude_install_error() -> NonZeroAgentExitCodeError:
        return NonZeroAgentExitCodeError(
            "Command failed (exit 137): set -euo pipefail; "
            "curl -fsSL https://downloads.claude.ai/claude-code-releases/bootstrap.sh | bash -s -- && "
            'export PATH="$HOME/.local/bin:$PATH" && claude --version\n'
            "stdout: Installing Claude Code native build latest..."
            'bash: line 158: 235 Killed "$binary_path" install\n'
            "stderr: None"
        )

    # --- install tests ---

    async def test_install_runs_git_then_claude(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = InstallRecordingClaudeCodeStandard(
                logs_dir=Path(tmp) / "agent",
                model_name="anthropic/claude-sonnet-5",
            )
            await agent.install(FakeEnvironment(stdout="", return_code=1))

        # git install (root) + system packages (root from base class) + git config (agent) + claude install (agent)
        self.assertEqual(len(agent.root_commands), 2)
        self.assertIn("apk add", agent.root_commands[0])
        self.assertIn("apk add", agent.root_commands[1])
        self.assertEqual(len(agent.agent_commands), 2)
        self.assertIn("git config", agent.agent_commands[0])
        self.assertIn("claude", agent.agent_commands[1].lower())

    async def test_install_retries_killed_claude_installer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = InstallRecordingClaudeCodeStandard(
                logs_dir=Path(tmp) / "agent",
                model_name="anthropic/claude-sonnet-5",
                failures=[self._killed_claude_install_error()],
            )
            with (
                patch("kimchi_agent.claude_code_standard.asyncio.sleep", new_callable=AsyncMock) as sleep,
                patch.object(agent.logger, "warning") as warning,
            ):
                await agent.install(FakeEnvironment(stdout="", return_code=1))

        # git install (root) + system packages (root from base, called twice due to retry)
        # = 3 root commands total
        self.assertEqual(len(agent.root_commands), 3)
        self.assertGreaterEqual(len(agent.agent_commands), 3)
        sleep.assert_awaited_once()
        warning.assert_called_once()

    async def test_install_non_installer_exit_137_is_not_retried(self) -> None:
        original_error = NonZeroAgentExitCodeError(
            'Command failed (exit 137): some other command'
        )
        with tempfile.TemporaryDirectory() as tmp:
            agent = InstallRecordingClaudeCodeStandard(
                logs_dir=Path(tmp) / "agent",
                model_name="anthropic/claude-sonnet-5",
                failures=[original_error],
            )
            with (
                patch("kimchi_agent.claude_code_standard.asyncio.sleep", new_callable=AsyncMock) as sleep,
                self.assertRaises(NonZeroAgentExitCodeError) as raised,
            ):
                await agent.install(FakeEnvironment(stdout="", return_code=1))

        self.assertIs(raised.exception, original_error)
        sleep.assert_not_awaited()

    # --- run tests ---

    async def test_run_does_git_baseline_then_delegates_to_base(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingClaudeCodeStandard(
                logs_dir=Path(tmp) / "agent",
                model_name="anthropic/claude-sonnet-5",
            )
            await agent.run("solve it", object(), AgentContext())

        # First command is the git baseline; the rest are from the base class
        # (setup + claude run).
        self.assertGreaterEqual(len(agent.agent_commands), 2)
        first_command = agent.agent_commands[0]
        self.assertIn("git init", first_command)
        self.assertIn("baseline", first_command)

    async def test_run_env_has_anthropic_api_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingClaudeCodeStandard(
                logs_dir=Path(tmp) / "agent",
                model_name="anthropic/claude-sonnet-5",
            )
            await agent.run("solve it", object(), AgentContext())

        # Find the env from the setup or run command (not git baseline, which
        # has env=None from our override).
        envs_with_key = [
            env for env in agent.agent_envs
            if env and env.get("ANTHROPIC_API_KEY") == "test-anthropic-key"
        ]
        self.assertGreater(len(envs_with_key), 0, "ANTHROPIC_API_KEY should be in the agent env")

    async def test_run_strips_provider_prefix_for_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingClaudeCodeStandard(
                logs_dir=Path(tmp) / "agent",
                model_name="anthropic/claude-sonnet-5",
            )
            await agent.run("solve it", object(), AgentContext())

        envs = [env for env in agent.agent_envs if env]
        model_envs = [env["ANTHROPIC_MODEL"] for env in envs if "ANTHROPIC_MODEL" in env]
        self.assertIn("claude-sonnet-5", model_envs)
        # Must NOT contain the provider prefix
        for model in model_envs:
            self.assertFalse(model.startswith("anthropic/"))

    # --- retryable API error classification tests ---

    async def test_retryable_api_status_is_reclassified(self) -> None:
        stream = "\n".join([
            json.dumps({"type": "system", "subtype": "init"}),
            json.dumps({
                "type": "result",
                "is_error": True,
                "api_error_status": 524,
                "result": "API Error: 524 origin_response_timeout",
            }),
        ])
        original_error = NonZeroAgentExitCodeError("claude exited 1")
        with tempfile.TemporaryDirectory() as tmp:
            agent = FailingClaudeCodeStandard(
                logs_dir=Path(tmp) / "agent",
                model_name="anthropic/claude-sonnet-5",
                failure=original_error,
            )
            environment = FakeEnvironment(stdout=stream)

            from kimchi_agent.claude_code_kimchi import RetryableApiError
            with self.assertRaises(RetryableApiError) as raised:
                await agent.run("solve it", environment, AgentContext())

        self.assertEqual(raised.exception.status, 524)
        self.assertIn("origin_response_timeout", str(raised.exception))

    async def test_nonretryable_api_status_remains_nonzero_exit(self) -> None:
        # 401 is not in NON_RETRYABLE_API_STATUSES ({403, 404}), so it stays
        # as the original NonZeroAgentExitCodeError.
        stream = json.dumps({
            "type": "result",
            "is_error": True,
            "api_error_status": 401,
            "result": "API Error: 401 unauthorized",
        })
        original_error = NonZeroAgentExitCodeError("claude exited 1")
        with tempfile.TemporaryDirectory() as tmp:
            agent = FailingClaudeCodeStandard(
                logs_dir=Path(tmp) / "agent",
                model_name="anthropic/claude-sonnet-5",
                failure=original_error,
            )

            with self.assertRaises(NonZeroAgentExitCodeError) as raised:
                await agent.run("solve it", FakeEnvironment(stdout=stream), AgentContext())

        self.assertIs(raised.exception, original_error)

    async def test_403_api_error_is_reclassified_as_api_usage_limit(self) -> None:
        stream = json.dumps({
            "type": "result",
            "is_error": True,
            "api_error_status": 403,
            "result": "API Error: 403 Your API key does not have access to this model",
        })
        original_error = NonZeroAgentExitCodeError("claude exited 1")
        with tempfile.TemporaryDirectory() as tmp:
            agent = FailingClaudeCodeStandard(
                logs_dir=Path(tmp) / "agent",
                model_name="anthropic/claude-sonnet-5",
                failure=original_error,
            )

            with self.assertRaises(NonZeroAgentExitCodeError) as raised:
                await agent.run("solve it", FakeEnvironment(stdout=stream), AgentContext())

        # 403 maps to ApiUsageLimitError, which is a subclass of NonZeroAgentExitCodeError
        from harbor.agents.installed.base import ApiUsageLimitError
        self.assertIsInstance(raised.exception, ApiUsageLimitError)
        self.assertIn("API key does not have access", str(raised.exception))
        self.assertIsNot(raised.exception, original_error)

    async def test_404_api_error_is_reclassified_as_unknown_api_error(self) -> None:
        stream = json.dumps({
            "type": "result",
            "is_error": True,
            "api_error_status": 404,
            "result": "API Error: 404 model not found",
        })
        original_error = NonZeroAgentExitCodeError("claude exited 1")
        with tempfile.TemporaryDirectory() as tmp:
            agent = FailingClaudeCodeStandard(
                logs_dir=Path(tmp) / "agent",
                model_name="anthropic/claude-sonnet-5",
                failure=original_error,
            )

            with self.assertRaises(NonZeroAgentExitCodeError) as raised:
                await agent.run("solve it", FakeEnvironment(stdout=stream), AgentContext())

        from harbor.agents.installed.base import UnknownApiError
        self.assertIsInstance(raised.exception, UnknownApiError)
        self.assertIn("model not found", str(raised.exception))
        self.assertIsNot(raised.exception, original_error)

    async def test_non_api_nonzero_exit_remains_nonzero_exit(self) -> None:
        original_error = NonZeroAgentExitCodeError("claude exited 1")
        with tempfile.TemporaryDirectory() as tmp:
            agent = FailingClaudeCodeStandard(
                logs_dir=Path(tmp) / "agent",
                model_name="anthropic/claude-sonnet-5",
                failure=original_error,
            )

            with self.assertRaises(NonZeroAgentExitCodeError) as raised:
                await agent.run("solve it", FakeEnvironment(stdout="not json"), AgentContext())

        self.assertIs(raised.exception, original_error)


if __name__ == "__main__":
    unittest.main()
