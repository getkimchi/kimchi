import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import ClassVar
from unittest.mock import AsyncMock, patch

from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from kimchi_agent.claude_code_kimchi import (
    CLAUDE_CODE_CONTEXT_SAFETY_MARGIN_TOKENS,
    CLAUDE_CODE_INSTALL_RETRY_DELAYS_SEC,
    CLAUDE_CODE_OUTPUT_RESERVE_TOKENS,
    KIMCHI_ANTHROPIC_BASE_URL,
    ClaudeCodeKimchi,
    RetryableApiError,
)
from kimchi_agent.gateway import (
    FETCH_TIMEOUT_SEC,
    KIMCHI_MODELS_METADATA_URL,
    KimchiModelMetadata,
    KimchiModelsMetadataResponse,
)


class FakeMetadataResponse:
    def __init__(self, body: dict[str, object]) -> None:
        self._body = body

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, object]:
        return self._body


class RecordingClaudeCodeKimchi(ClaudeCodeKimchi):
    metadata: ClassVar[list[dict[str, object]]] = [
        {
            "slug": "kimi-k2.5",
            "display_name": "Kimi K2.5",
            "reasoning": True,
            "limits": {"context_window": 262144, "max_output_tokens": 262144},
        },
        {
            "slug": "minimax-m2.7",
            "display_name": "MiniMax M2.7",
            "reasoning": True,
            "limits": {"context_window": 196608, "max_output_tokens": 196608},
        },
    ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.agent_commands: list[str] = []
        self.agent_envs: list[dict[str, str] | None] = []
        self.effective_agent_envs: list[dict[str, str]] = []
        self.metadata_fetch_count = 0

    async def exec_as_agent(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.agent_commands.append(command)
        self.agent_envs.append(env)
        merged_env = dict(env) if env else {}
        merged_env.update(self._extra_env)
        self.effective_agent_envs.append(merged_env)

    def _fetch_model_metadata(self, api_key: str) -> list[KimchiModelMetadata]:
        self.metadata_fetch_count += 1
        self.fetched_with_api_key = api_key
        return KimchiModelsMetadataResponse.model_validate({"models": self.metadata}).models


class FailingClaudeCodeKimchi(RecordingClaudeCodeKimchi):
    def __init__(self, *args, failure: Exception, **kwargs):
        super().__init__(*args, **kwargs)
        self.failure = failure

    async def exec_as_agent(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        await super().exec_as_agent(_environment, command, env=env, cwd=cwd, timeout_sec=timeout_sec)
        if len(self.agent_commands) == 2:
            raise self.failure


class InstallRecordingClaudeCodeKimchi(ClaudeCodeKimchi):
    def __init__(self, *args, failures: list[Exception] | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.failures = list(failures or [])
        self.root_commands: list[str] = []
        self.agent_commands: list[str] = []

    async def exec_as_root(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.root_commands.append(command)

    async def exec_as_agent(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.agent_commands.append(command)
        if self.failures:
            raise self.failures.pop(0)


class FakeEnvironment:
    def __init__(self, stdout: str, return_code: int = 0) -> None:
        self.stdout = stdout
        self.return_code = return_code
        self.commands: list[str] = []

    async def exec(self, command: str, cwd=None, env=None, timeout_sec=None, user=None):
        self.commands.append(command)
        return ExecResult(stdout=self.stdout, stderr="", return_code=self.return_code)


class ClaudeCodeKimchiTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._old_api_key = os.environ.get("KIMCHI_API_KEY")
        os.environ["KIMCHI_API_KEY"] = "test-key"

    def tearDown(self) -> None:
        if self._old_api_key is None:
            os.environ.pop("KIMCHI_API_KEY", None)
        else:
            os.environ["KIMCHI_API_KEY"] = self._old_api_key

    @staticmethod
    def _killed_claude_install_error() -> NonZeroAgentExitCodeError:
        return NonZeroAgentExitCodeError(
            "Command failed (exit 137): set -euo pipefail; "
            "curl -fsSL https://downloads.claude.ai/claude-code-releases/bootstrap.sh | bash -s -- && "
            "export PATH=\"$HOME/.local/bin:$PATH\" && claude --version\n"
            "stdout: Installing Claude Code native build latest..."
            "bash: line 158: 235 Killed \"$binary_path\" install\n"
            "stderr: None"
        )

    async def test_retries_killed_claude_code_installer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = InstallRecordingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                failures=[self._killed_claude_install_error()],
            )

            with (
                patch("kimchi_agent.claude_code_kimchi.asyncio.sleep", new_callable=AsyncMock) as sleep,
                patch.object(agent.logger, "warning") as warning,
            ):
                await agent.install(object())

        self.assertEqual(len(agent.root_commands), 2)
        self.assertEqual(len(agent.agent_commands), 2)
        sleep.assert_awaited_once_with(CLAUDE_CODE_INSTALL_RETRY_DELAYS_SEC[0])
        warning.assert_called_once()

    async def test_non_installer_exit_137_is_not_retried(self) -> None:
        original_error = NonZeroAgentExitCodeError(
            "Command failed (exit 137): export PATH=\"$HOME/.local/bin:$PATH\"; "
            "claude --verbose --output-format=stream-json --print -- 'solve it'"
        )
        with tempfile.TemporaryDirectory() as tmp:
            agent = InstallRecordingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                failures=[original_error],
            )

            with (
                patch("kimchi_agent.claude_code_kimchi.asyncio.sleep", new_callable=AsyncMock) as sleep,
                self.assertRaises(NonZeroAgentExitCodeError) as raised,
            ):
                await agent.install(object())

        self.assertIs(raised.exception, original_error)
        self.assertEqual(len(agent.root_commands), 1)
        self.assertEqual(len(agent.agent_commands), 1)
        sleep.assert_not_awaited()

    async def test_runs_claude_code_against_selected_kimchi_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/minimax-m2.7",
            )

            await agent.run("solve it", object(), AgentContext())

        self.assertEqual(len(agent.agent_commands), 2)
        setup_command, run_command = agent.agent_commands
        env = agent.agent_envs[0]
        self.assertIsNotNone(env)

        self.assertIn("$CLAUDE_CONFIG_DIR/projects/-app", setup_command)
        self.assertIn("claude --verbose --output-format=stream-json", run_command)
        self.assertIn("set -o pipefail", run_command)
        self.assertIn("--permission-mode=bypassPermissions", run_command)
        self.assertIn("--print -- 'solve it'", run_command)
        self.assertIn("| tee /logs/agent/claude-code.txt", run_command)
        self.assertNotIn("attempt=", run_command)
        self.assertNotIn("retryable", run_command)

        self.assertEqual(env["ANTHROPIC_BASE_URL"], KIMCHI_ANTHROPIC_BASE_URL)
        self.assertEqual(env["ANTHROPIC_AUTH_TOKEN"], "test-key")
        self.assertEqual(env["ANTHROPIC_API_KEY"], "")
        self.assertEqual(env["ANTHROPIC_MODEL"], "minimax-m2.7")
        for key in (
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_SMALL_FAST_MODEL",
            "ANTHROPIC_CUSTOM_MODEL_OPTION",
            "CLAUDE_CODE_SUBAGENT_MODEL",
        ):
            self.assertEqual(env[key], "minimax-m2.7")
        self.assertEqual(env["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"], "1")
        self.assertEqual(env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1")
        self.assertLess(int(env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"]), 196608)
        self.assertEqual(
            int(env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"]),
            196608 - CLAUDE_CODE_OUTPUT_RESERVE_TOKENS - CLAUDE_CODE_CONTEXT_SAFETY_MARGIN_TOKENS,
        )
        self.assertNotIn("MAX_THINKING_TOKENS", env)
        self.assertEqual(env["IS_SANDBOX"], "1")
        self.assertEqual(agent.agent_envs[1], env)
        self.assertEqual(agent.metadata_fetch_count, 1)
        self.assertEqual(agent.fetched_with_api_key, "test-key")

    async def test_api_key_can_come_from_agent_extra_env(self) -> None:
        os.environ.pop("KIMCHI_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                extra_env={"KIMCHI_API_KEY": "extra-key"},
            )

            await agent.run("solve it", object(), AgentContext())

        self.assertEqual(agent.agent_envs[0]["ANTHROPIC_AUTH_TOKEN"], "extra-key")
        self.assertEqual(agent.fetched_with_api_key, "extra-key")

    async def test_rejects_non_kimchi_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="anthropic/claude-opus-4-6",
            )

            with self.assertRaisesRegex(ValueError, "only supports kimchi-dev"):
                await agent.run("solve it", object(), AgentContext())

        self.assertEqual(agent.agent_commands, [])

    async def test_rejects_model_missing_from_metadata_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/not-returned",
            )

            with self.assertRaisesRegex(ValueError, "was not returned"):
                await agent.run("solve it", object(), AgentContext())

        self.assertEqual(agent.agent_commands, [])

    async def test_missing_kimchi_api_key_fails_before_commands(self) -> None:
        os.environ.pop("KIMCHI_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
            )

            with self.assertRaisesRegex(ValueError, "KIMCHI_API_KEY is required"):
                await agent.run("solve it", object(), AgentContext())

        self.assertEqual(agent.agent_commands, [])

    async def test_retryable_api_status_is_reclassified_for_harbor_retry(self) -> None:
        stream = "\n".join([
            json.dumps({"type": "system", "subtype": "init"}),
            json.dumps({
                "type": "result",
                "is_error": True,
                "api_error_status": 524,
                "result": "API Error: 524 origin_response_timeout",
            }),
        ])
        with tempfile.TemporaryDirectory() as tmp:
            agent = FailingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                failure=NonZeroAgentExitCodeError("claude exited 1"),
            )
            environment = FakeEnvironment(stream)

            with self.assertRaises(RetryableApiError) as raised:
                await agent.run("solve it", environment, AgentContext())

        self.assertEqual(raised.exception.status, 524)
        self.assertIn("origin_response_timeout", str(raised.exception))
        self.assertIn("cat /logs/agent/claude-code.txt", environment.commands)

    async def test_nonretryable_api_status_remains_nonzero_exit(self) -> None:
        stream = json.dumps({
            "type": "result",
            "is_error": True,
            "api_error_status": 401,
            "result": "API Error: 401 unauthorized",
        })
        original_error = NonZeroAgentExitCodeError("claude exited 1")
        with tempfile.TemporaryDirectory() as tmp:
            agent = FailingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                failure=original_error,
            )

            with self.assertRaises(NonZeroAgentExitCodeError) as raised:
                await agent.run("solve it", FakeEnvironment(stream), AgentContext())

        self.assertIs(raised.exception, original_error)

    async def test_non_api_nonzero_exit_remains_nonzero_exit(self) -> None:
        original_error = NonZeroAgentExitCodeError("claude exited 1")
        with tempfile.TemporaryDirectory() as tmp:
            agent = FailingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                failure=original_error,
            )

            with self.assertRaises(NonZeroAgentExitCodeError) as raised:
                await agent.run("solve it", FakeEnvironment("not json"), AgentContext())

        self.assertIs(raised.exception, original_error)

    async def test_extra_env_cannot_override_forced_anthropic_routing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                extra_env={
                    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                    "ANTHROPIC_AUTH_TOKEN": "wrong-key",
                    "ANTHROPIC_API_KEY": "wrong-key",
                    "ANTHROPIC_MODEL": "claude-opus-4-6",
                    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "8192",
                },
            )

            await agent.run("solve it", object(), AgentContext())

        env = agent.agent_envs[0]
        self.assertEqual(env["ANTHROPIC_BASE_URL"], KIMCHI_ANTHROPIC_BASE_URL)
        self.assertEqual(env["ANTHROPIC_AUTH_TOKEN"], "test-key")
        self.assertEqual(env["ANTHROPIC_API_KEY"], "")
        self.assertEqual(env["ANTHROPIC_MODEL"], "kimi-k2.5")
        self.assertEqual(env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "8192")
        effective_env = agent.effective_agent_envs[0]
        self.assertEqual(effective_env["ANTHROPIC_BASE_URL"], KIMCHI_ANTHROPIC_BASE_URL)
        self.assertEqual(effective_env["ANTHROPIC_AUTH_TOKEN"], "test-key")
        self.assertEqual(effective_env["ANTHROPIC_API_KEY"], "")

    async def test_clears_off_gateway_claude_auth_envs(self) -> None:
        off_gateway_env = {
            "AWS_ACCESS_KEY_ID": "aws-id",
            "AWS_BEARER_TOKEN_BEDROCK": "bedrock-token",
            "AWS_REGION": "us-east-1",
            "AWS_SECRET_ACCESS_KEY": "aws-secret",
            "CLAUDE_CODE_OAUTH_TOKEN": "oauth-token",
            "CLAUDE_CODE_USE_BEDROCK": "1",
            "CLAUDE_CODE_USE_VERTEX": "1",
            "GOOGLE_APPLICATION_CREDENTIALS": "/tmp/google-creds.json",
        }
        with patch.dict(os.environ, off_gateway_env), tempfile.TemporaryDirectory() as tmp:
            agent = RecordingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                extra_env={
                    **off_gateway_env,
                    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "8192",
                },
            )

            await agent.run("solve it", object(), AgentContext())

        env = agent.agent_envs[0]
        effective_env = agent.effective_agent_envs[0]
        self.assertEqual(env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "8192")
        for key in off_gateway_env:
            self.assertEqual(effective_env.get(key), "")

    async def test_declared_env_vars_cannot_override_forced_anthropic_routing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
            )
            agent._resolved_env_vars.update({
                "ANTHROPIC_MODEL": "claude-opus-4-6",
                "CLAUDE_CODE_OAUTH_TOKEN": "oauth-token",
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "999999",
                "CLAUDE_CODE_USE_BEDROCK": "1",
                "MAX_THINKING_TOKENS": "2048",
            })

            await agent.run("solve it", object(), AgentContext())

        env = agent.agent_envs[0]
        self.assertEqual(env["ANTHROPIC_MODEL"], "kimi-k2.5")
        self.assertLess(int(env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"]), 262144)
        self.assertEqual(
            int(env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"]),
            262144 - CLAUDE_CODE_OUTPUT_RESERVE_TOKENS - CLAUDE_CODE_CONTEXT_SAFETY_MARGIN_TOKENS,
        )
        self.assertEqual(env["CLAUDE_CODE_OAUTH_TOKEN"], "")
        self.assertEqual(env["CLAUDE_CODE_USE_BEDROCK"], "")
        self.assertEqual(env["MAX_THINKING_TOKENS"], "2048")

    async def test_does_not_passthrough_bash_environment(self) -> None:
        bash_env = {
            "BASH_ENV": "/tmp/evil",
            "BASH_FUNC_bad%%": "() { echo shellshock; }",
            "BASH_VERSION": "5.2.0",
        }
        with patch.dict(os.environ, bash_env), tempfile.TemporaryDirectory() as tmp:
            agent = RecordingClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                extra_env=bash_env,
            )
            agent._resolved_env_vars.update(bash_env)

            await agent.run("solve it", object(), AgentContext())

        env = agent.agent_envs[0]
        self.assertNotIn("BASH_ENV", env)
        self.assertNotIn("BASH_FUNC_bad%%", env)
        self.assertNotIn("BASH_VERSION", env)
        effective_env = agent.effective_agent_envs[0]
        self.assertNotIn("BASH_ENV", effective_env)
        self.assertNotIn("BASH_FUNC_bad%%", effective_env)
        self.assertNotIn("BASH_VERSION", effective_env)

    async def test_rejects_invalid_metadata_response(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = ClaudeCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
            )
            response = FakeMetadataResponse({
                "models": [
                    {
                        "slug": "kimi-k2.5",
                        "reasoning": "true",
                        "limits": {"context_window": "262144", "max_output_tokens": 262144},
                    }
                ]
            })

            with (
                patch("kimchi_agent.gateway.httpx.get", return_value=response) as http_get,
                self.assertRaisesRegex(RuntimeError, "Failed to parse Kimchi model metadata"),
            ):
                await agent.run("solve it", object(), AgentContext())

        http_get.assert_called_once()
        self.assertEqual(http_get.call_args.kwargs["headers"], {"Authorization": "Bearer test-key"})
        self.assertEqual(http_get.call_args.kwargs["timeout"], FETCH_TIMEOUT_SEC)
        self.assertEqual(http_get.call_args.args, (KIMCHI_MODELS_METADATA_URL,))


if __name__ == "__main__":
    unittest.main()
