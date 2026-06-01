import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import ClassVar

from harbor.models.agent.context import AgentContext

from kimchi_agent.gateway import (
    KIMCHI_OPENAI_BASE_URL,
    KIMCHI_PROVIDER,
    KimchiModelMetadata,
    KimchiModelsMetadataResponse,
)
from kimchi_agent.gsd_kimchi import (
    CONTAINER_CAPTURED_SESSION_DIR,
    CONTAINER_GSD_AGENT_DIR,
    CONTAINER_GSD_HOME,
    CONTAINER_GSD_SESSION_DIR,
    GSD_BLOCKED_EXIT_CODE,
    GSD_EXIT_CODE_FILENAME,
    GSD_OUTPUT_FILENAME,
    GsdKimchi,
)


class RecordingGsdKimchi(GsdKimchi):
    metadata: ClassVar[list[dict[str, object]]] = [
        {
            "slug": "kimi-k2.5",
            "display_name": "Kimi K2.5",
            "reasoning": True,
            "input_modalities": ["text", "image"],
            "limits": {"context_window": 262144, "max_output_tokens": 262144},
        },
        {
            "slug": "minimax-m2.7",
            "display_name": "MiniMax M2.7",
            "reasoning": False,
            "limits": {"context_window": 196608, "max_output_tokens": 65536},
        },
    ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
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


class GsdKimchiTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._old_api_key = os.environ.get("KIMCHI_API_KEY")
        os.environ["KIMCHI_API_KEY"] = "test-key"

    def tearDown(self) -> None:
        if self._old_api_key is None:
            os.environ.pop("KIMCHI_API_KEY", None)
        else:
            os.environ["KIMCHI_API_KEY"] = self._old_api_key

    async def test_install_defaults_to_latest_gsd_package(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingGsdKimchi(logs_dir=Path(tmp), model_name="kimchi-dev/kimi-k2.5")

            await agent.install(object())

        self.assertEqual(len(agent.root_commands), 1)
        self.assertEqual(len(agent.agent_commands), 1)
        self.assertIn("git", agent.root_commands[0])
        self.assertIn("npm install -g gsd-pi@latest", agent.agent_commands[0])
        self.assertIn("gsd --version", agent.agent_commands[0])

    def test_version_command_tolerates_system_node_install(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingGsdKimchi(logs_dir=Path(tmp), model_name="kimchi-dev/kimi-k2.5")

            command = agent.get_version_command()

        self.assertIn('[ ! -s "$NVM_DIR/nvm.sh" ] || . "$NVM_DIR/nvm.sh"', command)
        self.assertIn("gsd --version", command)

    async def test_install_accepts_version_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingGsdKimchi(
                logs_dir=Path(tmp),
                model_name="kimchi-dev/kimi-k2.5",
                version="3.0.0",
            )

            await agent.install(object())

        self.assertIn("npm install -g gsd-pi@3.0.0", agent.agent_commands[0])

    async def test_registers_and_runs_selected_kimchi_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingGsdKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/minimax-m2.7",
            )

            await agent.run("solve it", object(), AgentContext())

        self.assertEqual(len(agent.agent_commands), 2)
        config_command, run_command = agent.agent_commands
        self.assertIn("/tmp/terminal-bench-gsd-home/agent/models.json", config_command)
        self.assertIn("/tmp/terminal-bench-gsd-home/agent/settings.json", config_command)
        self.assertIn("/tmp/terminal-bench-gsd-home/preferences.md", config_command)
        self.assertIn("gsd --mode text --print --model kimchi-dev/minimax-m2.7", run_command)
        self.assertIn("Terminal Bench task. Work fully non-interactively.", run_command)
        self.assertIn("mkdir -p /logs/agent /tmp/terminal-bench-gsd-home/agent/sessions", run_command)
        self.assertIn("/logs/agent/gsd-sessions", run_command)
        self.assertIn("> /logs/agent/gsd.txt 2>&1 </dev/null || status=$?", run_command)
        self.assertNotIn("--no-session", run_command)
        self.assertNotIn("tee", run_command)
        self.assertNotIn("gsd.jsonl", run_command)
        self.assertIn(f"[ \"$status\" -eq {GSD_BLOCKED_EXIT_CODE} ]; then exit 0", run_command)
        self.assertIn("project_dir=$(pwd -P)", run_command)
        self.assertIn('"$project_dir/.gsd"', run_command)
        self.assertIn("/logs/agent/gsd-version.txt", run_command)
        self.assertIn("/logs/agent/gsd-exit-code.txt", run_command)
        self.assertIn("/logs/agent/gsd-status.json", run_command)
        self.assertIn("gsd_status=blocked", run_command)
        self.assertIn("/logs/agent/gsd", run_command)
        self.assertIn(f"rm -rf {CONTAINER_CAPTURED_SESSION_DIR}", run_command)
        self.assertIn(f"cp -a {CONTAINER_GSD_SESSION_DIR}/.", run_command)
        self.assertIn(f"rm -rf {CONTAINER_GSD_HOME}", run_command)
        self.assertNotIn("/logs/agent/gsd-home", run_command)
        self.assertEqual(
            agent.agent_envs[0],
            {
                "KIMCHI_API_KEY": "test-key",
                "GSD_HOME": CONTAINER_GSD_HOME,
                "GSD_CODING_AGENT_DIR": CONTAINER_GSD_AGENT_DIR,
                "PI_CODING_AGENT_DIR": CONTAINER_GSD_AGENT_DIR,
            },
        )
        self.assertEqual(agent.agent_envs[1], agent.agent_envs[0])
        self.assertEqual(agent.metadata_fetch_count, 1)
        self.assertEqual(agent.fetched_with_api_key, "test-key")

    async def test_forces_pi_session_env_even_when_extra_env_overrides_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingGsdKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.5",
                extra_env={
                    "GSD_HOME": "/tmp/wrong",
                    "GSD_CODING_AGENT_DIR": "/tmp/wrong",
                    "PI_CODING_AGENT_DIR": "/tmp/wrong",
                },
            )

            await agent.run("solve it", object(), AgentContext())

        self.assertEqual(agent._extra_env["GSD_HOME"], CONTAINER_GSD_HOME)
        self.assertEqual(agent._extra_env["GSD_CODING_AGENT_DIR"], CONTAINER_GSD_AGENT_DIR)
        self.assertEqual(agent._extra_env["PI_CODING_AGENT_DIR"], CONTAINER_GSD_AGENT_DIR)
        self.assertEqual(agent.agent_envs[0]["GSD_HOME"], CONTAINER_GSD_HOME)
        self.assertEqual(agent.agent_envs[0]["GSD_CODING_AGENT_DIR"], CONTAINER_GSD_AGENT_DIR)
        self.assertEqual(agent.agent_envs[0]["PI_CODING_AGENT_DIR"], CONTAINER_GSD_AGENT_DIR)

    async def test_models_config_contains_only_selected_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingGsdKimchi(logs_dir=Path(tmp), model_name="kimchi-dev/kimi-k2.5")
            model = agent._model_metadata_for("test-key", "kimchi-dev/kimi-k2.5")

            config = agent._models_config(model)

        provider = config["providers"][KIMCHI_PROVIDER]
        self.assertEqual(provider["name"], "Kimchi Dev")
        self.assertEqual(provider["baseUrl"], KIMCHI_OPENAI_BASE_URL)
        self.assertEqual(provider["apiKey"], "KIMCHI_API_KEY")
        self.assertEqual(provider["api"], "openai-completions")
        self.assertEqual(len(provider["models"]), 1)
        self.assertEqual(provider["models"][0]["id"], "kimi-k2.5")
        self.assertEqual(provider["models"][0]["name"], "Kimi K2.5")
        self.assertEqual(provider["models"][0]["contextWindow"], 262144)
        self.assertEqual(provider["models"][0]["maxTokens"], 262144)
        self.assertTrue(provider["models"][0]["reasoning"])
        self.assertEqual(provider["models"][0]["input"], ["text", "image"])
        self.assertEqual(provider["models"][0]["cost"], {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0})

    async def test_settings_and_preferences_pin_every_role_to_selected_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingGsdKimchi(logs_dir=Path(tmp), model_name="kimchi-dev/minimax-m2.7")
            model = agent._model_metadata_for("test-key", "kimchi-dev/minimax-m2.7")

            settings = agent._settings_config(model)
            prefs = agent._preferences(model)

        self.assertEqual(settings["defaultProvider"], "kimchi-dev")
        self.assertEqual(settings["defaultModel"], "minimax-m2.7")
        self.assertIn("execution: kimchi-dev/minimax-m2.7", prefs)
        self.assertIn("validation: kimchi-dev/minimax-m2.7", prefs)
        self.assertIn("auto_supervisor:\n  model: kimchi-dev/minimax-m2.7", prefs)
        self.assertIn("dynamic_routing:\n  enabled: false", prefs)
        self.assertIn("light: kimchi-dev/minimax-m2.7", prefs)
        self.assertIn("standard: kimchi-dev/minimax-m2.7", prefs)
        self.assertIn("- kimchi-dev/minimax-m2.7", prefs)

    async def test_rejects_non_kimchi_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingGsdKimchi(logs_dir=Path(tmp), model_name="openai/gpt-4.1")

            with self.assertRaisesRegex(ValueError, "only supports kimchi-dev"):
                await agent.run("solve it", object(), AgentContext())

    async def test_missing_kimchi_api_key_fails_before_commands(self) -> None:
        os.environ.pop("KIMCHI_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingGsdKimchi(logs_dir=Path(tmp), model_name="kimchi-dev/kimi-k2.5")

            with self.assertRaisesRegex(ValueError, "KIMCHI_API_KEY is required"):
                await agent.run("solve it", object(), AgentContext())

        self.assertEqual(agent.agent_commands, [])

    async def test_rejects_model_missing_from_metadata_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingGsdKimchi(logs_dir=Path(tmp), model_name="kimchi-dev/not-returned")

            with self.assertRaisesRegex(ValueError, "was not returned"):
                await agent.run("solve it", object(), AgentContext())

    def test_populate_context_records_exit_status_without_parsing_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent"
            logs_dir.mkdir(parents=True)
            (logs_dir / GSD_OUTPUT_FILENAME).write_text("large human-readable transcript\n")
            (logs_dir / GSD_EXIT_CODE_FILENAME).write_text(f"{GSD_BLOCKED_EXIT_CODE}\n")
            agent = RecordingGsdKimchi(logs_dir=logs_dir, model_name="kimchi-dev/kimi-k2.5")
            context = AgentContext()

            agent.populate_context_post_run(context)

            self.assertIsNone(context.n_input_tokens)
            self.assertIsNone(context.n_output_tokens)
            self.assertIsNone(context.n_cache_tokens)
            self.assertIsNone(context.cost_usd)
            self.assertEqual(
                context.metadata,
                {"gsd_exit_code": GSD_BLOCKED_EXIT_CODE, "gsd_status": "blocked"},
            )
            self.assertFalse((logs_dir / "trajectory.json").exists())

    def test_populate_context_aggregates_pi_session_tokens(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent"
            session_dir = logs_dir / "gsd-sessions" / "--work--"
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
                            "cost": {"total": 0.12},
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
            (logs_dir / GSD_EXIT_CODE_FILENAME).write_text("0\n")
            agent = RecordingGsdKimchi(logs_dir=logs_dir, model_name="kimchi-dev/kimi-k2.5")
            context = AgentContext()

            agent.populate_context_post_run(context)

            self.assertEqual(context.n_input_tokens, 20)
            self.assertEqual(context.n_output_tokens, 5)
            self.assertEqual(context.n_cache_tokens, 3)
            self.assertEqual(context.cost_usd, 0.12)
            self.assertEqual(context.metadata, {"gsd_exit_code": 0, "gsd_status": "success"})
            self.assertFalse((logs_dir / "trajectory.json").exists())
