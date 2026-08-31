import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import ClassVar

from harbor.models.agent.context import AgentContext

from kimchi_agent.deepseek_agent import (
    CONTAINER_DSH_HOME,
    DSH_EXIT_CODE_FILENAME,
    DSH_INSTRUCTION_PATH,
    DSH_LLM_PLUGIN_ID,
    DSH_OUTPUT_FILENAME,
    DSH_PATCH_PATH,
    DeepSeekAgent,
    DeepSeekCreatorAgent,
    DeepSeekMinimalAgent,
    DeepSeekPtcAgent,
    DeepSeekStandardAgent,
)
from kimchi_agent.gateway import (
    KIMCHI_API_KEY_ENV,
    KIMCHI_OPENAI_BASE_URL,
    KimchiModelMetadata,
    KimchiModelsMetadataResponse,
)


class RecordingDeepSeekAgent(DeepSeekAgent):
    metadata: ClassVar[list[dict[str, object]]] = [
        {
            "slug": "deepseek-chat",
            "display_name": "DeepSeek Chat",
            "reasoning": False,
            "input_modalities": ["text"],
            "limits": {"context_window": 128000, "max_output_tokens": 8192},
        },
        {
            "slug": "deepseek-reasoner",
            "display_name": "DeepSeek Reasoner",
            "reasoning": True,
            "input_modalities": ["text", "image"],
            "limits": {"context_window": 64000, "max_output_tokens": 64000},
        },
    ]

    def __init__(self, *args, **kwargs):
        preset = kwargs.pop("preset", None)
        super().__init__(*args, **kwargs)
        if preset is not None:
            self.PRESET = preset
        self.root_commands: list[str] = []
        self.agent_commands: list[str] = []
        self.agent_envs: list[dict[str, str] | None] = []
        self.metadata_fetch_count = 0

    async def exec_as_root(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.root_commands.append(command)

    async def exec_as_agent(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.agent_commands.append(command)
        self.agent_envs.append(env)

    def _fetch_model_metadata(self, api_key: str) -> list[KimchiModelMetadata]:
        self.metadata_fetch_count += 1
        self.fetched_with_api_key = api_key
        return KimchiModelsMetadataResponse.model_validate({"models": self.metadata}).models


class DeepSeekAgentTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._old_api_key = os.environ.get("KIMCHI_API_KEY")
        os.environ["KIMCHI_API_KEY"] = "test-key"

    def tearDown(self) -> None:
        if self._old_api_key is None:
            os.environ.pop("KIMCHI_API_KEY", None)
        else:
            os.environ["KIMCHI_API_KEY"] = self._old_api_key

    def test_name(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(logs_dir=Path(tmp), model_name="kimchi-dev/deepseek-chat")
            self.assertEqual(agent.name(), "deepseek")

    def test_version_command_tolerates_system_node_install(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(logs_dir=Path(tmp), model_name="kimchi-dev/deepseek-chat")
            command = agent.get_version_command()
        self.assertIn('[ ! -s "$NVM_DIR/nvm.sh" ] || . "$NVM_DIR/nvm.sh"', command)
        self.assertIn("dsh --version", command)

    def test_install_spec_declares_git_config_step(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(logs_dir=Path(tmp), model_name="kimchi-dev/deepseek-chat")
            spec = agent.install_spec()
        self.assertEqual(spec.agent_name, "deepseek")
        self.assertEqual(len(spec.steps), 1)
        self.assertEqual(spec.steps[0].user, "root")
        self.assertIn("git config", spec.steps[0].run)
        self.assertIn("dsh --version", spec.verification_command)

    async def test_install_defaults_to_latest_dsh_package(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(logs_dir=Path(tmp), model_name="kimchi-dev/deepseek-chat")
            await agent.install(object())
        self.assertEqual(len(agent.root_commands), 2)
        self.assertIn("git", agent.root_commands[0])
        self.assertIn("curl", agent.root_commands[1])
        self.assertEqual(len(agent.agent_commands), 2)
        self.assertIn("git config", agent.agent_commands[0])
        self.assertIn("npm install -g @deepseek-ai/dsh@latest", agent.agent_commands[1])
        self.assertIn("dsh --version", agent.agent_commands[1])

    async def test_install_accepts_version_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(
                logs_dir=Path(tmp),
                model_name="kimchi-dev/deepseek-chat",
                version="0.1.0",
            )
            await agent.install(object())
        self.assertIn("npm install -g @deepseek-ai/dsh@0.1.0", agent.agent_commands[1])

    async def test_run_writes_patch_then_baseline_then_dsh(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/deepseek-chat",
            )
            await agent.run("solve it", object(), AgentContext())

        self.assertEqual(len(agent.agent_commands), 3)
        patch_command, git_command, run_command = agent.agent_commands

        self.assertIn(DSH_PATCH_PATH, patch_command)
        self.assertIn("agent-default-model", patch_command)
        self.assertIn(DSH_LLM_PLUGIN_ID, patch_command)
        self.assertIn(KIMCHI_API_KEY_ENV, patch_command)
        self.assertIn(KIMCHI_OPENAI_BASE_URL, patch_command)

        self.assertIn("git init", git_command)

        self.assertIn("dsh --profile headless", run_command)
        self.assertIn(f"--patch {DSH_PATCH_PATH}", run_command)
        self.assertIn(f'"$(cat {DSH_INSTRUCTION_PATH})"', run_command)
        self.assertIn(DSH_INSTRUCTION_PATH, run_command)
        self.assertIn(DSH_OUTPUT_FILENAME, run_command)
        self.assertIn(DSH_EXIT_CODE_FILENAME, run_command)
        self.assertIn("dsh-status.json", run_command)
        self.assertIn(f"rm -rf {CONTAINER_DSH_HOME}", run_command)
        self.assertIn('exit "$status"', run_command)

        self.assertEqual(agent.metadata_fetch_count, 1)
        self.assertEqual(agent.fetched_with_api_key, "test-key")
        self.assertEqual(
            agent.agent_envs[0],
            {
                KIMCHI_API_KEY_ENV: "test-key",
                "DEEPSEEK_API_KEY": "test-key",
                "DEEPSEEK_BASE_URL": KIMCHI_OPENAI_BASE_URL,
                "DSH_HOME": CONTAINER_DSH_HOME,
                "DSH_TOOLS_MODE": "native",
                "DSH_PERMISSION_MODE": "danger-full-access",
            },
        )
        self.assertEqual(agent.agent_envs[1], agent.agent_envs[0])
        self.assertEqual(agent.agent_envs[2], agent.agent_envs[0])

    def test_dsh_provider_config_targets_kimchi_gateway(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(logs_dir=Path(tmp), model_name="kimchi-dev/deepseek-chat")
            model = agent._model_metadata_for("test-key", "kimchi-dev/deepseek-chat")

            config = agent._dsh_provider_config(model)

        self.assertEqual(config["baseURL"], KIMCHI_OPENAI_BASE_URL)
        self.assertEqual(config["apiKeyEnv"], KIMCHI_API_KEY_ENV)
        self.assertNotIn("thinking", config)
        models = config["models"]
        self.assertEqual(len(models), 1)
        self.assertEqual(models[0]["id"], "deepseek-chat")
        self.assertEqual(models[0]["name"], "DeepSeek Chat")
        self.assertEqual(models[0]["contextWindow"], 128000)
        self.assertEqual(models[0]["maxTokens"], 8192)
        self.assertEqual(models[0]["inputModalities"], ["text"])
        self.assertNotIn("reasoningEffort", models[0])

    def test_dsh_provider_config_enables_thinking_for_reasoning_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(logs_dir=Path(tmp), model_name="kimchi-dev/deepseek-reasoner")
            model = agent._model_metadata_for("test-key", "kimchi-dev/deepseek-reasoner")

            config = agent._dsh_provider_config(model)
            model_entry = config["models"][0]

        self.assertEqual(config["thinking"], "enabled")
        self.assertEqual(model_entry["reasoningEffort"], "high")
        self.assertEqual(model_entry["inputModalities"], ["text", "image"])

    def test_patch_yaml_round_trips_through_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(logs_dir=Path(tmp), model_name="kimchi-dev/deepseek-chat")
            model = agent._model_metadata_for("test-key", "kimchi-dev/deepseek-chat")

            patch = json.loads(agent._build_patch_json(model))

        self.assertEqual(
            patch[0],
            {
                "id": "agent-default-model",
                "config": {"provider": "deepseek-official", "model": "deepseek-chat"},
            },
        )
        self.assertEqual(patch[1]["id"], DSH_LLM_PLUGIN_ID)
        self.assertEqual(patch[1]["config"]["baseURL"], KIMCHI_OPENAI_BASE_URL)
        self.assertEqual(patch[1]["config"]["apiKeyEnv"], KIMCHI_API_KEY_ENV)
        self.assertEqual(len(patch[1]["config"]["models"]), 1)
        # Tools mode explicitly set to native so the model can call tools.
        self.assertEqual(patch[2], {"id": "tools", "config": {"mode": "native"}})
        # Approval auto-set to "never" for headless mode.
        self.assertEqual(patch[3], {"id": "approval", "config": {"policy": "never"}})

    def test_dsh_input_modalities_filters_to_text_or_image(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(logs_dir=Path(tmp), model_name="kimchi-dev/deepseek-chat")
            model = KimchiModelMetadata.model_validate(
                {
                    "slug": "m",
                    "display_name": "M",
                    "input_modalities": ["text", "audio"],
                    "limits": {"context_window": 1000, "max_output_tokens": 100},
                }
            )
            self.assertEqual(agent._dsh_input_modalities(model), ["text"])

    async def test_rejects_non_kimchi_provider(self) -> None:
        for model_name in ("openai/gpt-4.1", "openrouter/z-ai/glm-5.2"):
            with self.subTest(model_name=model_name), tempfile.TemporaryDirectory() as tmp:
                agent = RecordingDeepSeekAgent(logs_dir=Path(tmp), model_name=model_name)
                with self.assertRaisesRegex(ValueError, "only supports kimchi-dev"):
                    await agent.run("solve it", object(), AgentContext())

    async def test_missing_kimchi_api_key_fails_before_commands(self) -> None:
        os.environ.pop("KIMCHI_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(logs_dir=Path(tmp), model_name="kimchi-dev/deepseek-chat")
            with self.assertRaisesRegex(ValueError, "KIMCHI_API_KEY is required"):
                await agent.run("solve it", object(), AgentContext())
        self.assertEqual(agent.agent_commands, [])

    async def test_rejects_model_missing_from_metadata_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(logs_dir=Path(tmp), model_name="kimchi-dev/not-returned")
            with self.assertRaisesRegex(ValueError, "was not returned"):
                await agent.run("solve it", object(), AgentContext())

    def test_populate_context_records_exit_status_without_parsing_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent"
            logs_dir.mkdir(parents=True)
            (logs_dir / DSH_OUTPUT_FILENAME).write_text("large human-readable transcript\n")
            (logs_dir / DSH_EXIT_CODE_FILENAME).write_text("0\n")
            agent = RecordingDeepSeekAgent(logs_dir=logs_dir, model_name="kimchi-dev/deepseek-chat")
            context = AgentContext()
            agent.populate_context_post_run(context)
            self.assertEqual(
                context.metadata,
                {"dsh_exit_code": 0, "dsh_status": "success"},
            )
            self.assertIsNone(context.n_input_tokens)
            self.assertIsNone(context.n_output_tokens)
            self.assertIsNone(context.n_cache_tokens)
            self.assertIsNone(context.cost_usd)

    def test_populate_context_records_error_exit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent"
            logs_dir.mkdir(parents=True)
            (logs_dir / DSH_EXIT_CODE_FILENAME).write_text("1\n")
            agent = RecordingDeepSeekAgent(logs_dir=logs_dir, model_name="kimchi-dev/deepseek-chat")
            context = AgentContext()
            agent.populate_context_post_run(context)
            self.assertEqual(
                context.metadata,
                {"dsh_exit_code": 1, "dsh_status": "error"},
            )

    def test_populate_context_aggregates_session_tokens(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent"
            session_dir = logs_dir / "dsh-sessions" / "main"
            session_dir.mkdir(parents=True)
            entries = [
                {"type": "session", "id": "session-1"},
                {"type": "message", "message": {"role": "user", "usage": {"input": 99, "output": 99}}},
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "usage": {
                            "input": 10,
                            "output": 4,
                            "cacheRead": 3,
                            "cacheWrite": 2,
                            "cost": {"total": 0.05},
                        },
                    },
                },
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "usage": {"input": 5, "output": 1},
                    },
                },
            ]
            (session_dir / "main.jsonl").write_text(
                "\n".join(["not json", *(json.dumps(entry) for entry in entries), ""])
            )
            (logs_dir / DSH_EXIT_CODE_FILENAME).write_text("0\n")
            agent = RecordingDeepSeekAgent(logs_dir=logs_dir, model_name="kimchi-dev/deepseek-chat")
            context = AgentContext()
            agent.populate_context_post_run(context)
            self.assertEqual(context.n_input_tokens, 20)
            self.assertEqual(context.n_output_tokens, 5)
            self.assertEqual(context.n_cache_tokens, 3)
            self.assertEqual(context.cost_usd, 0.05)

    def test_populate_context_tolerates_missing_session_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent"
            logs_dir.mkdir(parents=True)
            agent = RecordingDeepSeekAgent(logs_dir=logs_dir, model_name="kimchi-dev/deepseek-chat")
            context = AgentContext()
            # When no exit-code file exists, metadata is not populated and
            # tokens remain unset.
            agent.populate_context_post_run(context)
            self.assertIsNone(context.n_input_tokens)
            self.assertIsNone(context.metadata)


class DeepSeekVariantsTest(unittest.IsolatedAsyncioTestCase):
    """Tests for the 4 preset variants."""

    def setUp(self) -> None:
        self._old_api_key = os.environ.get("KIMCHI_API_KEY")
        os.environ["KIMCHI_API_KEY"] = "test-key"

    def tearDown(self) -> None:
        if self._old_api_key is None:
            os.environ.pop("KIMCHI_API_KEY", None)
        else:
            os.environ["KIMCHI_API_KEY"] = self._old_api_key

    def test_variant_names(self) -> None:
        self.assertEqual(DeepSeekStandardAgent.name(), "deepseek-standard")
        self.assertEqual(DeepSeekPtcAgent.name(), "deepseek-ptc")
        self.assertEqual(DeepSeekMinimalAgent.name(), "deepseek-minimal")
        self.assertEqual(DeepSeekCreatorAgent.name(), "deepseek-creator")
        # Base class keeps backward-compatible name.
        self.assertEqual(DeepSeekAgent.name(), "deepseek")

    def test_variant_presets(self) -> None:
        self.assertEqual(DeepSeekStandardAgent.PRESET, "standard")
        self.assertEqual(DeepSeekPtcAgent.PRESET, "ptc")
        self.assertEqual(DeepSeekMinimalAgent.PRESET, "minimal")
        self.assertEqual(DeepSeekCreatorAgent.PRESET, "cordis")

    def test_standard_uses_native_tools_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(
                logs_dir=Path(tmp), model_name="kimchi-dev/deepseek-chat",
                preset="standard",
            )
            env = agent._build_env()
        self.assertEqual(env["DSH_TOOLS_MODE"], "native")

    def test_ptc_uses_ptc_tools_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(
                logs_dir=Path(tmp), model_name="kimchi-dev/deepseek-chat",
                preset="ptc",
            )
            env = agent._build_env()
            patch = json.loads(agent._build_patch_json(
                agent._model_metadata_for("test-key", "kimchi-dev/deepseek-chat"),
            ))
        self.assertEqual(env["DSH_TOOLS_MODE"], "ptc")
        # The tools config in the patch should also be ptc.
        tools_config = next(p for p in patch if p["id"] == "tools")
        # The first tools entry is the main mode setter.
        self.assertEqual(tools_config["config"]["mode"], "ptc")

    def test_minimal_overrides_system_prompt_and_restricts_tools(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(
                logs_dir=Path(tmp), model_name="kimchi-dev/deepseek-chat",
                preset="minimal",
            )
            patch = json.loads(agent._build_patch_json(
                agent._model_metadata_for("test-key", "kimchi-dev/deepseek-chat"),
            ))
        # Should have a system-prompt override.
        prompt_entries = [p for p in patch if p["id"] == "system-prompt"]
        self.assertEqual(len(prompt_entries), 1)
        self.assertIn("helpful software engineer", prompt_entries[0]["config"]["persona"])
        # Should have a tools restrict entry.
        tools_entries = [p for p in patch if p["id"] == "tools"]
        self.assertGreaterEqual(len(tools_entries), 2)
        restrict_entry = tools_entries[-1]
        self.assertIn("restrict", restrict_entry["config"])
        self.assertIn("bash", restrict_entry["config"]["restrict"]["allow"])

    def test_creator_overrides_system_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingDeepSeekAgent(
                logs_dir=Path(tmp), model_name="kimchi-dev/deepseek-chat",
                preset="cordis",
            )
            patch = json.loads(agent._build_patch_json(
                agent._model_metadata_for("test-key", "kimchi-dev/deepseek-chat"),
            ))
        prompt_entries = [p for p in patch if p["id"] == "system-prompt"]
        self.assertEqual(len(prompt_entries), 1)
        self.assertIn("Cordis runtime introspection", prompt_entries[0]["config"]["persona"])

    def test_run_command_includes_preset_marker(self) -> None:
        for preset_name, cls in [
            ("standard", DeepSeekStandardAgent),
            ("ptc", DeepSeekPtcAgent),
            ("minimal", DeepSeekMinimalAgent),
            ("cordis", DeepSeekCreatorAgent),
        ]:
            with tempfile.TemporaryDirectory() as tmp:
                agent = RecordingDeepSeekAgent(
                    logs_dir=Path(tmp) / "agent",
                    model_name="kimchi-dev/deepseek-chat",
                    preset=preset_name,
                )
                model = agent._model_metadata_for("test-key", "kimchi-dev/deepseek-chat")
                cmd = agent._build_run_command("test instruction", model)
            self.assertIn(
                f"=== dsh preset: {preset_name} ===",
                cmd,
                f"Run command for {cls.__name__} should include preset marker",
            )


if __name__ == "__main__":
    unittest.main()
