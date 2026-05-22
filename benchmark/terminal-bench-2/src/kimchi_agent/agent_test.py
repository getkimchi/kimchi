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
