import json
import os
import shlex
import tempfile
import unittest
from pathlib import Path
from typing import ClassVar
from unittest.mock import patch

from harbor.models.agent.context import AgentContext
from harbor.models.task.config import MCPServerConfig

from kimchi_agent.gateway import (
    FETCH_TIMEOUT_SEC,
    KIMCHI_MODELS_METADATA_URL,
    KIMCHI_OPENAI_BASE_URL,
    KimchiModelMetadata,
    KimchiModelsMetadataResponse,
)
from kimchi_agent.opencode_kimchi import (
    KIMCHI_PROVIDER,
    OPENROUTER_BASE_URL,
    OPENROUTER_PROVIDER_NAME,
    ZAI_BASE_URL,
    ZAI_PROVIDER_NAME,
    OpenCodeKimchi,
)


class FakeMetadataResponse:
    def __init__(self, body: dict[str, object]) -> None:
        self._body = body

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, object]:
        return self._body


class RecordingOpenCodeKimchi(OpenCodeKimchi):
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
        {
            "slug": "new-model",
            "display_name": "New Model",
            "reasoning": False,
            "limits": {"context_window": 12345, "max_output_tokens": 6789},
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


def extract_echo_json(command: str) -> dict:
    tokens = shlex.split(command)
    echo_index = tokens.index("echo")
    return json.loads(tokens[echo_index + 1])


class OpenCodeKimchiTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._old_api_key = os.environ.get("KIMCHI_API_KEY")
        os.environ["KIMCHI_API_KEY"] = "test-key"
        self._old_openrouter_key = os.environ.get("OPENROUTER_API_KEY")
        os.environ.pop("OPENROUTER_API_KEY", None)

    def tearDown(self) -> None:
        if self._old_api_key is None:
            os.environ.pop("KIMCHI_API_KEY", None)
        else:
            os.environ["KIMCHI_API_KEY"] = self._old_api_key
        if self._old_openrouter_key is not None:
            os.environ["OPENROUTER_API_KEY"] = self._old_openrouter_key

    async def test_registers_and_runs_selected_kimchi_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/minimax-m2.7",
            )

            await agent.run("solve it", object(), AgentContext())

        self.assertEqual(len(agent.agent_commands), 3)
        config = extract_echo_json(agent.agent_commands[1])
        self.assertEqual(config["model"], "kimchi-dev/minimax-m2.7")
        self.assertEqual(config["small_model"], "kimchi-dev/minimax-m2.7")
        self.assertIn("minimax-m2.7", config["provider"][KIMCHI_PROVIDER]["models"])
        self.assertNotIn("kimi-k2.5", config["provider"][KIMCHI_PROVIDER]["models"])
        self.assertEqual(config["provider"][KIMCHI_PROVIDER]["options"]["baseURL"], KIMCHI_OPENAI_BASE_URL)
        self.assertEqual(config["provider"][KIMCHI_PROVIDER]["options"]["apiKey"], "{env:KIMCHI_API_KEY}")

        run_command = agent.agent_commands[2]
        self.assertIn("opencode --model=kimchi-dev/minimax-m2.7", run_command)
        self.assertIn("run --format=json --thinking --dangerously-skip-permissions --", run_command)
        self.assertEqual(agent.agent_envs[0]["KIMCHI_API_KEY"], "test-key")
        self.assertEqual(agent.agent_envs[0]["OPENCODE_FAKE_VCS"], "git")
        self.assertEqual(agent.metadata_fetch_count, 1)
        self.assertEqual(agent.fetched_with_api_key, "test-key")

    async def test_registers_and_runs_moonshot_model(self) -> None:
        with (
            patch.dict(os.environ, {"MOONSHOT_API_KEY": "sk-msh-test"}),
            tempfile.TemporaryDirectory() as tmp,
        ):
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="moonshotai/kimi-k3",
            )

            await agent.run("solve it", object(), AgentContext())

        config = extract_echo_json(agent.agent_commands[1])
        self.assertEqual(config["model"], "moonshotai/kimi-k3")
        provider = config["provider"]["moonshotai"]
        self.assertEqual(provider["options"]["baseURL"], "https://api.moonshot.ai/v1")
        self.assertEqual(provider["options"]["apiKey"], "{env:MOONSHOT_API_KEY}")
        self.assertIn("kimi-k3", provider["models"])
        self.assertEqual(provider["models"]["kimi-k3"]["limit"]["context"], 1_048_576)

        run_command = agent.agent_commands[2]
        self.assertIn("opencode --model=moonshotai/kimi-k3", run_command)
        self.assertIn("run --format=json --thinking --dangerously-skip-permissions --", run_command)
        self.assertEqual(agent.agent_envs[0]["MOONSHOT_API_KEY"], "sk-msh-test")
        self.assertNotIn("KIMCHI_API_KEY", agent.agent_envs[0])
        # The Kimchi gateway is never consulted for moonshotai/* models.
        self.assertEqual(agent.metadata_fetch_count, 0)

    async def test_moonshot_model_requires_moonshot_api_key(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=False),
            tempfile.TemporaryDirectory() as tmp,
        ):
            os.environ.pop("MOONSHOT_API_KEY", None)
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="moonshotai/kimi-k3",
            )

            with self.assertRaisesRegex(ValueError, "MOONSHOT_API_KEY is required"):
                await agent.run("solve it", object(), AgentContext())

        self.assertEqual(agent.agent_commands, [])

    async def test_unknown_moonshot_model_fails_before_commands(self) -> None:
        with (
            patch.dict(os.environ, {"MOONSHOT_API_KEY": "sk-msh-test"}),
            tempfile.TemporaryDirectory() as tmp,
        ):
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="moonshotai/kimi-k9",
            )

            with self.assertRaisesRegex(ValueError, "not in the static metadata table"):
                await agent.run("solve it", object(), AgentContext())

    async def test_rejects_non_kimchi_provider(self) -> None:
        for model_name in ("openai/gpt-4.1", "anthropic/claude-sonnet-5"):
            with self.subTest(model_name=model_name), tempfile.TemporaryDirectory() as tmp:
                agent = RecordingOpenCodeKimchi(
                    logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                    model_name=model_name,
                )

                with self.assertRaisesRegex(ValueError, "only supports kimchi-dev"):
                    await agent.run("solve it", object(), AgentContext())

    async def test_zai_model_registers_provider_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="zai/glm-5.2",
            )
            agent._extra_env["ZAI_API_KEY"] = "zai-test-key"

            await agent.run("solve it", object(), AgentContext())

        self.assertEqual(len(agent.agent_commands), 3)
        config = extract_echo_json(agent.agent_commands[1])
        # Provider should be zai, not kimchi-dev
        self.assertNotIn(KIMCHI_PROVIDER, config["provider"])
        self.assertIn(ZAI_PROVIDER_NAME, config["provider"])
        zai_config = config["provider"][ZAI_PROVIDER_NAME]
        self.assertEqual(zai_config["options"]["baseURL"], ZAI_BASE_URL)
        self.assertEqual(zai_config["options"]["apiKey"], "{env:ZAI_API_KEY}")
        self.assertNotIn("litellmProxy", zai_config["options"])
        # Model metadata from the static table (docs.z.ai: 1M/128K, thinking)
        model_cfg = zai_config["models"]["glm-5.2"]
        self.assertTrue(model_cfg["tool_call"])
        self.assertTrue(model_cfg["reasoning"])
        self.assertEqual(model_cfg["limit"]["context"], 1_000_000)
        self.assertEqual(model_cfg["limit"]["output"], 131_072)
        # opencode --model should use the full zai/ prefix
        run_command = agent.agent_commands[2]
        self.assertIn("opencode --model=zai/glm-5.2", run_command)
        self.assertIn("--thinking", run_command)
        # Environment should have ZAI_API_KEY, not KIMCHI_API_KEY
        self.assertNotIn("KIMCHI_API_KEY", agent.agent_envs[0])
        self.assertEqual(agent.agent_envs[0]["ZAI_API_KEY"], "zai-test-key")
        # Should not fetch Kimchi metadata
        self.assertEqual(agent.metadata_fetch_count, 0)

    async def test_zai_unknown_model_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="zai/glm-5.1",
            )
            agent._extra_env["ZAI_API_KEY"] = "zai-test-key"

            with self.assertRaisesRegex(ValueError, "not in the static metadata table"):
                await agent.run("solve it", object(), AgentContext())

    async def test_zai_missing_api_key_fails(self) -> None:
        # CI injects ZAI_API_KEY as a project variable for zai benchmark runs;
        # the missing-key assertion must not see it.
        os.environ.pop("ZAI_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="zai/glm-5.2",
            )

            with self.assertRaisesRegex(ValueError, "ZAI_API_KEY is required"):
                await agent.run("solve it", object(), AgentContext())

        self.assertEqual(agent.agent_commands, [])

    async def test_openrouter_model_registers_provider_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="openrouter/@preset/glm-5-2-zai",
            )
            agent._extra_env["OPENROUTER_API_KEY"] = "or-test-key"

            await agent.run("solve it", object(), AgentContext())

        self.assertEqual(len(agent.agent_commands), 3)
        config = extract_echo_json(agent.agent_commands[1])
        # Provider should be openrouter, not kimchi-dev
        self.assertNotIn(KIMCHI_PROVIDER, config["provider"])
        self.assertIn(OPENROUTER_PROVIDER_NAME, config["provider"])
        or_config = config["provider"][OPENROUTER_PROVIDER_NAME]
        self.assertEqual(or_config["options"]["baseURL"], OPENROUTER_BASE_URL)
        self.assertEqual(or_config["options"]["apiKey"], "{env:OPENROUTER_API_KEY}")
        self.assertNotIn("litellmProxy", or_config["options"])
        # Model metadata from static table
        model_cfg = or_config["models"]["@preset/glm-5-2-zai"]
        self.assertTrue(model_cfg["tool_call"])
        self.assertFalse(model_cfg["reasoning"])
        self.assertEqual(model_cfg["limit"]["context"], 128_000)
        self.assertEqual(model_cfg["limit"]["output"], 16_384)
        # opencode --model should use the full openrouter/ prefix
        run_command = agent.agent_commands[2]
        self.assertIn("opencode --model=openrouter/@preset/glm-5-2-zai", run_command)
        self.assertNotIn("--thinking", run_command)
        # Environment should have OPENROUTER_API_KEY, not KIMCHI_API_KEY
        self.assertNotIn("KIMCHI_API_KEY", agent.agent_envs[0])
        self.assertEqual(agent.agent_envs[0]["OPENROUTER_API_KEY"], "or-test-key")
        # Should not fetch Kimchi metadata
        self.assertEqual(agent.metadata_fetch_count, 0)

    async def test_openrouter_reasoning_model_adds_thinking_flag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="openrouter/@preset/kimi-k2-7-moonshot",
            )
            agent._extra_env["OPENROUTER_API_KEY"] = "or-test-key"

            await agent.run("solve it", object(), AgentContext())

        run_command = agent.agent_commands[2]
        self.assertIn("--thinking", run_command)
        config = extract_echo_json(agent.agent_commands[1])
        model_cfg = config["provider"][OPENROUTER_PROVIDER_NAME]["models"]["@preset/kimi-k2-7-moonshot"]
        self.assertTrue(model_cfg["reasoning"])

    async def test_openrouter_unknown_model_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="openrouter/unknown-model",
            )
            agent._extra_env["OPENROUTER_API_KEY"] = "or-test-key"

            with self.assertRaisesRegex(ValueError, "not in the static metadata table"):
                await agent.run("solve it", object(), AgentContext())

    async def test_openrouter_missing_api_key_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="openrouter/@preset/glm-5-2-zai",
            )

            with self.assertRaisesRegex(ValueError, "OPENROUTER_API_KEY is required"):
                await agent.run("solve it", object(), AgentContext())

        self.assertEqual(agent.agent_commands, [])

    async def test_allows_unknown_kimchi_model_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/new-model",
            )

            await agent.run("solve it", object(), AgentContext())

        config = extract_echo_json(agent.agent_commands[1])
        model_config = config["provider"][KIMCHI_PROVIDER]["models"]["new-model"]
        self.assertFalse(model_config["reasoning"])
        self.assertTrue(model_config["tool_call"])
        self.assertEqual(model_config["limit"], {"context": 12345, "output": 6789})
        self.assertIn("opencode --model=kimchi-dev/new-model", agent.agent_commands[2])
        self.assertNotIn("--thinking", agent.agent_commands[2])

    async def test_rejects_model_missing_from_metadata_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/not-returned",
            )

            with self.assertRaisesRegex(ValueError, "was not returned"):
                await agent.run("solve it", object(), AgentContext())

    async def test_missing_kimchi_api_key_fails_before_commands(self) -> None:
        os.environ.pop("KIMCHI_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
            )

            with self.assertRaisesRegex(ValueError, "KIMCHI_API_KEY is required"):
                await agent.run("solve it", object(), AgentContext())

        self.assertEqual(agent.agent_commands, [])

    async def test_rejects_empty_model_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/",
            )

            with self.assertRaisesRegex(ValueError, "include a model id"):
                await agent.run("solve it", object(), AgentContext())

    async def test_preserves_mcp_servers_in_opencode_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                mcp_servers=[
                    MCPServerConfig(name="local-tools", transport="stdio", command="tool-server", args=["--fast"]),
                    MCPServerConfig(name="remote-tools", transport="sse", url="https://example.test/mcp"),
                ],
            )

            await agent.run("solve it", object(), AgentContext())

        config = extract_echo_json(agent.agent_commands[1])
        self.assertEqual(config["mcp"]["local-tools"], {"type": "local", "command": ["tool-server", "--fast"]})
        self.assertEqual(config["mcp"]["remote-tools"], {"type": "remote", "url": "https://example.test/mcp"})

    async def test_opencode_config_deep_merge_allows_job_overrides(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                opencode_config={
                    "share": "disabled",
                    "provider": {
                        KIMCHI_PROVIDER: {
                            "options": {"timeout": 600000},
                            "models": {"kimi-k2.5": {"reasoning": False}},
                        }
                    },
                },
            )

            await agent.run("solve it", object(), AgentContext())

        config = extract_echo_json(agent.agent_commands[1])
        provider = config["provider"][KIMCHI_PROVIDER]
        self.assertEqual(config["share"], "disabled")
        self.assertEqual(provider["options"]["baseURL"], KIMCHI_OPENAI_BASE_URL)
        self.assertEqual(provider["options"]["timeout"], 600000)
        self.assertFalse(provider["models"]["kimi-k2.5"]["reasoning"])

    async def test_registers_skills_before_config_and_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                skills_dir="/skills",
            )

            await agent.run("solve it", object(), AgentContext())

        self.assertEqual(len(agent.agent_commands), 4)
        self.assertIn("~/.config/opencode/skills", agent.agent_commands[1])
        self.assertIn("opencode.json", agent.agent_commands[2])
        self.assertIn("opencode --model=kimchi-dev/kimi-k2.5", agent.agent_commands[3])

    async def test_opencode_extra_env_overrides_default_fake_vcs(self) -> None:
        opencode_env = {
            "OPENCODE_API_KEY": "wrong-key",
            "OPENCODE_CLIENT": "host-client",
            "OPENCODE_CONFIG": "/tmp/evil-config.json",
        }
        with patch.dict(os.environ, opencode_env), tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                extra_env={
                    "OPENCODE_API_KEY": "wrong-extra-key",
                    "OPENCODE_CLIENT": "terminal-bench",
                    "OPENCODE_CONFIG": "/tmp/evil-extra-config.json",
                    "OPENCODE_FAKE_VCS": "none",
                },
            )

            await agent.run("solve it", object(), AgentContext())

        self.assertEqual(agent.agent_envs[0]["OPENCODE_FAKE_VCS"], "none")
        self.assertEqual(agent.agent_envs[0]["OPENCODE_CLIENT"], "terminal-bench")
        effective_env = agent.effective_agent_envs[0]
        self.assertNotIn("OPENCODE_API_KEY", effective_env)
        self.assertNotIn("OPENCODE_CONFIG", effective_env)

    async def test_registers_distinct_small_model_from_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                extra_env={"OPENCODE_SMALL_MODEL": "kimchi-dev/minimax-m2.7"},
            )

            await agent.run("solve it", object(), AgentContext())

        config = extract_echo_json(agent.agent_commands[1])
        models = config["provider"][KIMCHI_PROVIDER]["models"]
        self.assertEqual(config["small_model"], "kimchi-dev/minimax-m2.7")
        self.assertIn("kimi-k2.5", models)
        self.assertIn("minimax-m2.7", models)
        self.assertNotIn("OPENCODE_SMALL_MODEL", agent.effective_agent_envs[0])

    async def test_rejects_small_model_from_another_provider_before_key_lookup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="moonshotai/kimi-k3",
                extra_env={"OPENCODE_SMALL_MODEL": "kimchi-dev/minimax-m2.7"},
            )

            with self.assertRaisesRegex(ValueError, "must use the same provider"):
                await agent.run("solve it", object(), AgentContext())

        self.assertEqual(agent.agent_commands, [])
        self.assertEqual(agent.metadata_fetch_count, 0)

    def test_rejects_non_moonshot_cross_provider_small_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingOpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                extra_env={"OPENCODE_SMALL_MODEL": "openrouter/@preset/kimi-k2-7-moonshot"},
            )

            with self.assertRaisesRegex(ValueError, "must use the same provider"):
                agent._small_model_name()

    async def test_rejects_invalid_metadata_response(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = OpenCodeKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
            )
            response = FakeMetadataResponse(
                {
                    "models": [
                        {
                            "slug": "kimi-k2.5",
                            "reasoning": "true",
                            "limits": {"context_window": "262144", "max_output_tokens": 262144},
                        }
                    ]
                }
            )

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
