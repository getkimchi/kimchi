import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harbor.models.agent.context import AgentContext

from kimchi_agent.agent import CONTAINER_AGENT_PGID_FILE, Kimchi


class RecordingKimchi(Kimchi):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.agent_commands: list[str] = []
        self.agent_envs: list[dict[str, str] | None] = []
        self.root_commands: list[str] = []

    async def exec_as_agent(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.agent_commands.append(command)
        self.agent_envs.append(env)
        raise asyncio.CancelledError

    async def exec_as_root(self, _environment, command: str, env=None, cwd=None, timeout_sec=None):
        self.root_commands.append(command)


class KimchiHarnessTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._old_api_key = os.environ.get("KIMCHI_API_KEY")
        os.environ["KIMCHI_API_KEY"] = "test-key"

    def tearDown(self) -> None:
        if self._old_api_key is None:
            os.environ.pop("KIMCHI_API_KEY", None)
        else:
            os.environ["KIMCHI_API_KEY"] = self._old_api_key

    async def test_run_uses_shell_process_group_cleanup_on_cancellation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.6",
                **{"ferment-oneshot": True},
            )

            with self.assertRaises(asyncio.CancelledError):
                await agent.run("hello - world", object(), AgentContext())

            self.assertEqual(len(agent.agent_commands), 1)
            self.assertIn("set -m", agent.agent_commands[0])
            self.assertIn('ps -o pgid= -p "$agent_pid"', agent.agent_commands[0])
            self.assertNotIn("/proc/$agent_pid/stat", agent.agent_commands[0])
            self.assertNotIn("${agent_pgid//", agent.agent_commands[0])
            self.assertIn(CONTAINER_AGENT_PGID_FILE, agent.agent_commands[0])
            self.assertIn(f"rm -f {CONTAINER_AGENT_PGID_FILE}", agent.agent_commands[0])
            self.assertIn("--session /logs/agent/sessions/main.jsonl", agent.agent_commands[0])
            self.assertIn("KIMCHI_FERMENTS_DIR", agent.agent_envs[0])

            self.assertEqual(len(agent.root_commands), 1)
            self.assertIn(f"cat {CONTAINER_AGENT_PGID_FILE}", agent.root_commands[0])
            self.assertIn('kill -TERM "-$pgid"', agent.root_commands[0])
            self.assertIn('kill -KILL "-$pgid"', agent.root_commands[0])
            self.assertNotIn("kill -TERM -- ", agent.root_commands[0])
            self.assertIn(f"rm -f {CONTAINER_AGENT_PGID_FILE}", agent.root_commands[0])
            self.assertNotIn("pkill", agent.root_commands[0])

    async def test_single_model_run_passes_model_without_multi_model_cli_flag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.6",
            )

            with self.assertRaises(asyncio.CancelledError):
                await agent.run("hello", object(), AgentContext())

            command = agent.agent_commands[0]
            self.assertIn("--model kimchi-dev/kimi-k2.6", command)
            self.assertNotIn("--multi-model", command)
            self.assertNotIn(".config/kimchi/harness/settings.json", command)

    async def test_multi_model_run_omits_model_and_enables_harness_setting(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.6",
                **{"multi-model": True},
            )

            with self.assertRaises(asyncio.CancelledError):
                await agent.run("hello", object(), AgentContext())

            command = agent.agent_commands[0]
            self.assertNotIn("--model", command)
            self.assertNotIn("--multi-model", command)
            self.assertIn("~/.config/kimchi/harness/settings.json", command)
            self.assertIn('{"multiModel":true}', command)
            self.assertFalse(agent._multi_model_settings_command().endswith("&& "))
            self.assertIn(f"{agent._multi_model_settings_command()} && set -m", command)
            self.assertEqual(agent.to_agent_info().model_info.provider, "kimchi")
            self.assertEqual(agent.to_agent_info().model_info.name, "multi-model")

    async def test_multi_model_run_does_not_require_model_name(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                **{"multi-model": "true"},
            )

            with self.assertRaises(asyncio.CancelledError):
                await agent.run("hello", object(), AgentContext())

            self.assertNotIn("--model", agent.agent_commands[0])

    async def test_api_key_can_come_from_agent_extra_env(self) -> None:
        os.environ.pop("KIMCHI_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.6",
                extra_env={"KIMCHI_API_KEY": "extra-key"},
            )

            with self.assertRaises(asyncio.CancelledError):
                await agent.run("hello", object(), AgentContext())

            self.assertEqual(agent.agent_envs[0]["KIMCHI_API_KEY"], "extra-key")

    async def test_legacy_disable_multi_model_kwarg_does_not_emit_removed_cli_flag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.6",
                **{"disable-multi-model": True},
            )

            with self.assertRaises(asyncio.CancelledError):
                await agent.run("hello", object(), AgentContext())

            command = agent.agent_commands[0]
            self.assertIn("--model kimchi-dev/kimi-k2.6", command)
            self.assertNotIn("--multi-model", command)

    def test_multi_model_and_legacy_disable_multi_model_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(ValueError):
            RecordingKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/kimi-k2.6",
                **{"multi-model": True, "disable-multi-model": True},
            )

    async def test_single_model_rejects_empty_model_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/",
            )

            with self.assertRaisesRegex(ValueError, "<provider>/<id>"):
                await agent.run("hello", object(), AgentContext())

            self.assertEqual(agent.agent_commands, [])

    async def test_populate_context_skips_unreadable_session_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent"
            sessions_dir = logs_dir / "sessions"
            sessions_dir.mkdir(parents=True)
            readable = sessions_dir / "main.jsonl"
            unreadable = sessions_dir / "unreadable.jsonl"
            readable.write_text(
                '{"type":"message","message":{"role":"assistant","usage":{"input":10,"output":3,"cacheRead":2,"cacheWrite":1,"cost":{"total":0.5}}}}\n'
            )
            unreadable.write_text(
                '{"type":"message","message":{"role":"assistant","usage":{"input":999,"output":999}}}\n'
            )

            original_read_text = Path.read_text

            def fake_read_text(path: Path, *args, **kwargs):
                if path == unreadable:
                    raise PermissionError("test permission error")
                return original_read_text(path, *args, **kwargs)

            with patch.object(Path, "read_text", fake_read_text):
                agent = Kimchi(logs_dir=logs_dir, model_name="kimchi-dev/kimi-k2.6")
                context = AgentContext()
                with patch.object(agent.logger, "warning") as warning:
                    agent.populate_context_post_run(context)

            self.assertEqual(context.n_input_tokens, 13)
            self.assertEqual(context.n_output_tokens, 3)
            self.assertEqual(context.n_cache_tokens, 2)
            self.assertEqual(context.cost_usd, 0.5)
            warning.assert_called_once()


if __name__ == "__main__":
    unittest.main()
