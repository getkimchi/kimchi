import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import ClassVar

from harbor.models.agent.context import AgentContext

from kimchi_agent.gateway import (
    KimchiModelMetadata,
    KimchiModelsMetadataResponse,
)
from kimchi_agent.pi_kimchi import (
    CONTAINER_AGENT_PGID_FILE,
    CONTAINER_BUNDLE_NODE_DIR,
    CONTAINER_BUNDLE_PI_DIR,
    CONTAINER_EXTENSION_INSTALL_DIR,
    CONTAINER_EXTENSION_STAGE_DIR,
    CONTAINER_MAIN_SESSION,
    CONTAINER_PI_AGENT_DIR,
    CONTAINER_SESSIONS_DIR,
    PI_BUNDLE_DIR_ENV,
    PiKimchi,
)


class RecordingPiKimchi(PiKimchi):
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


class FakeEnvironment:
    def __init__(self) -> None:
        self.uploaded_dirs: list[tuple[str, str]] = []

    async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
        self.uploaded_dirs.append((str(source_dir), target_dir))


class PiKimchiTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._old_api_key = os.environ.get("KIMCHI_API_KEY")
        os.environ["KIMCHI_API_KEY"] = "test-key"

    def tearDown(self) -> None:
        if self._old_api_key is None:
            os.environ.pop("KIMCHI_API_KEY", None)
        else:
            os.environ["KIMCHI_API_KEY"] = self._old_api_key

    async def test_install_installs_pi_via_npm_and_uploads_extension(self) -> None:
        with tempfile.TemporaryDirectory() as ext_dir, tempfile.TemporaryDirectory() as tmp:
            ext_path = Path(ext_dir)
            (ext_path / "package.json").write_text("{}")
            agent = RecordingPiKimchi(
                logs_dir=Path(tmp),
                model_name="kimchi-dev/kimi-k2.5",
                **{"extension-source-dir": ext_path},
            )
            environment = FakeEnvironment()

            await agent.install(environment)

        self.assertEqual(len(agent.root_commands), 1)
        self.assertIn("curl", agent.root_commands[0])
        self.assertIn("git", agent.root_commands[0])
        self.assertEqual(len(agent.agent_commands), 2)
        self.assertIn("git config", agent.agent_commands[0])
        self.assertIn("npm install -g @earendil-works/pi-coding-agent@latest", agent.agent_commands[1])
        self.assertIn("pi --version", agent.agent_commands[1])
        # Extension was uploaded from host to staging dir
        self.assertEqual(environment.uploaded_dirs, [(str(ext_path), CONTAINER_EXTENSION_STAGE_DIR)])

    async def test_install_accepts_version_override(self) -> None:
        with tempfile.TemporaryDirectory() as ext_dir, tempfile.TemporaryDirectory() as tmp:
            (Path(ext_dir) / "package.json").write_text("{}")
            agent = RecordingPiKimchi(
                logs_dir=Path(tmp),
                model_name="kimchi-dev/kimi-k2.5",
                version="0.79.10",
                **{"extension-source-dir": ext_dir},
            )

            await agent.install(FakeEnvironment())

        self.assertIn("npm install -g @earendil-works/pi-coding-agent@0.79.10", agent.agent_commands[1])

    async def test_install_fails_when_extension_dir_missing_and_no_token(self) -> None:
        old_token = os.environ.pop("GITHUB_TOKEN", None)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                agent = RecordingPiKimchi(
                    logs_dir=Path(tmp),
                    model_name="kimchi-dev/kimi-k2.5",
                    **{"extension-source-dir": "/nonexistent/path"},
                )

                with self.assertRaisesRegex(RuntimeError, "pi-kimchi-provider extension not found"):
                    await agent.install(FakeEnvironment())
        finally:
            if old_token is not None:
                os.environ["GITHUB_TOKEN"] = old_token

    async def test_install_clones_extension_when_dir_missing_and_token_set(self) -> None:
        with tempfile.TemporaryDirectory() as ext_dir, tempfile.TemporaryDirectory() as tmp:
            ext_path = Path(ext_dir)
            (ext_path / "package.json").write_text("{}")
            agent = RecordingPiKimchi(
                logs_dir=Path(tmp),
                model_name="kimchi-dev/kimi-k2.5",
            )
            environment = FakeEnvironment()
            # Override _ensure_extension_available to return a pre-populated dir
            # without actually cloning, so the test stays hermetic.
            agent._ensure_extension_available = lambda: ext_path  # type: ignore[method-assign]

            await agent.install(environment)

        self.assertEqual(environment.uploaded_dirs, [(str(ext_path), CONTAINER_EXTENSION_STAGE_DIR)])

    async def test_runs_pi_with_selected_model(self) -> None:
        with tempfile.TemporaryDirectory() as ext_dir, tempfile.TemporaryDirectory() as tmp:
            (Path(ext_dir) / "package.json").write_text("{}")
            agent = RecordingPiKimchi(
                logs_dir=Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent",
                model_name="kimchi-dev/minimax-m2.7",
                **{"extension-source-dir": ext_dir},
            )

            await agent.run("solve it", object(), AgentContext())

        # install: git_config + npm install pi
        # run: single launch command
        run_commands = [c for c in agent.agent_commands if "pi --print" in c or "set -m" in c]
        self.assertEqual(len(run_commands), 1)
        run_command = run_commands[0]

        self.assertIn("pi --print", run_command)
        self.assertIn(f"--session {CONTAINER_MAIN_SESSION}", run_command)
        self.assertIn("--model kimchi-dev/minimax-m2.7", run_command)
        self.assertIn("--approve", run_command)
        self.assertNotIn("--dangerously-skip-permissions", run_command)
        self.assertNotIn("--yolo", run_command)
        # Prompt piped via stdin
        self.assertIn("printf '%s' 'solve it'", run_command)
        # Session dir created
        self.assertIn(f"mkdir -p {CONTAINER_SESSIONS_DIR}", run_command)
        # Extension installed via npm install --production
        self.assertIn(f"cp -a {CONTAINER_EXTENSION_STAGE_DIR}/.", run_command)
        self.assertIn(CONTAINER_EXTENSION_INSTALL_DIR, run_command)
        self.assertIn("npm install --production", run_command)
        # Process group tracking
        self.assertIn(CONTAINER_AGENT_PGID_FILE, run_command)
        self.assertIn('wait "$agent_pid"', run_command)
        # nvm sourced at the start of the launch command so npm/pi are on PATH
        self.assertIn('NVM_DIR', run_command)
        self.assertIn('nvm.sh', run_command)
        # Git baseline
        self.assertIn("cd /app", run_command)

    async def test_run_env_sets_api_key_and_pi_agent_dir(self) -> None:
        with tempfile.TemporaryDirectory() as ext_dir, tempfile.TemporaryDirectory() as tmp:
            (Path(ext_dir) / "package.json").write_text("{}")
            agent = RecordingPiKimchi(
                logs_dir=Path(tmp),
                model_name="kimchi-dev/kimi-k2.5",
                **{"extension-source-dir": ext_dir},
            )

            await agent.run("solve it", object(), AgentContext())

        run_envs = [e for e in agent.agent_envs if e is not None]
        self.assertTrue(len(run_envs) > 0)
        run_env = run_envs[-1]
        self.assertEqual(run_env["KIMCHI_API_KEY"], "test-key")
        self.assertEqual(run_env["PI_CODING_AGENT_DIR"], CONTAINER_PI_AGENT_DIR)

    async def test_rejects_non_kimchi_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingPiKimchi(
                logs_dir=Path(tmp),
                model_name="openai/gpt-4.1",
            )

            with self.assertRaisesRegex(ValueError, "only supports kimchi-dev"):
                await agent.run("solve it", object(), AgentContext())

    async def test_missing_kimchi_api_key_fails_before_commands(self) -> None:
        os.environ.pop("KIMCHI_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingPiKimchi(
                logs_dir=Path(tmp),
                model_name="kimchi-dev/kimi-k2.5",
            )

            with self.assertRaisesRegex(ValueError, "KIMCHI_API_KEY is required"):
                await agent.run("solve it", object(), AgentContext())

        self.assertEqual(agent.agent_commands, [])

    def test_populate_context_aggregates_pi_session_tokens(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "jobs" / "run-1" / "task__trial" / "agent"
            session_dir = logs_dir / "sessions"
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
            agent = RecordingPiKimchi(logs_dir=logs_dir, model_name="kimchi-dev/kimi-k2.5")
            context = AgentContext()

            agent.populate_context_post_run(context)

            self.assertEqual(context.n_input_tokens, 20)
            self.assertEqual(context.n_output_tokens, 5)
            self.assertEqual(context.n_cache_tokens, 3)
            self.assertEqual(context.cost_usd, 0.12)

    def test_populate_context_handles_missing_sessions_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingPiKimchi(logs_dir=Path(tmp), model_name="kimchi-dev/kimi-k2.5")
            context = AgentContext()

            agent.populate_context_post_run(context)

            self.assertIsNone(context.n_input_tokens)
            self.assertIsNone(context.n_output_tokens)

    def test_version_command_loads_nvm(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingPiKimchi(logs_dir=Path(tmp), model_name="kimchi-dev/kimi-k2.5")

            command = agent.get_version_command()

        self.assertIn('NVM_DIR', command)
        self.assertIn("pi --version", command)

    def test_version_command_also_finds_a_bundled_pi(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = RecordingPiKimchi(logs_dir=Path(tmp), model_name="kimchi-dev/kimi-k2.5")

            command = agent.get_version_command()

        # Both install modes on one PATH: the bundle is uploaded here, and nvm
        # supplies the fallback. A version probe that only knew about one would
        # report "unknown" for half the runs.
        self.assertIn(f"{CONTAINER_BUNDLE_PI_DIR}/bin", command)
        self.assertIn(f"{CONTAINER_BUNDLE_NODE_DIR}/bin", command)

    def test_populate_context_finds_workflow_step_sessions_one_level_down(self) -> None:
        # The kimchi-workflows extension parks a run's step sessions in a
        # `workflow/` SUBDIRECTORY of the session dir, deliberately, to keep
        # them out of pi's own session pickers. A flat glob would report a
        # workflow trial as having spent no tokens at all.
        with tempfile.TemporaryDirectory() as tmp:
            logs_dir = Path(tmp)
            nested = logs_dir / "sessions" / "workflow"
            nested.mkdir(parents=True)
            (nested / "step-1.jsonl").write_text(
                json.dumps(
                    {
                        "type": "message",
                        "message": {
                            "role": "assistant",
                            "usage": {
                                "input": 10,
                                "output": 5,
                                "cacheRead": 3,
                                "cacheWrite": 2,
                                "cost": {"total": 0.25},
                            },
                        },
                    }
                )
                + "\n"
            )

            agent = RecordingPiKimchi(logs_dir=logs_dir, model_name="kimchi-dev/kimi-k2.5")
            context = AgentContext()
            agent.populate_context_post_run(context)

        self.assertEqual(context.n_input_tokens, 15)
        self.assertEqual(context.n_output_tokens, 5)
        self.assertEqual(context.n_cache_tokens, 3)
        self.assertEqual(context.cost_usd, 0.25)

    def test_agent_name(self) -> None:
        self.assertEqual(PiKimchi.name(), "pi-kimchi")


class _ExecResult:
    def __init__(self, return_code: int) -> None:
        self.return_code = return_code
        self.stdout = ""
        self.stderr = "Error relocating /installed-agent/node/bin/node: __memcpy_chk"


class BundleEnvironment(FakeEnvironment):
    """A FakeEnvironment that can answer the bundle's runnability probe."""

    def __init__(self, probe_return_code: int = 0) -> None:
        super().__init__()
        self.probe_return_code = probe_return_code
        self.exec_commands: list[str] = []

    async def exec(self, command: str, **_kwargs):
        self.exec_commands.append(command)
        return _ExecResult(self.probe_return_code)


class PiKimchiBundleTest(unittest.IsolatedAsyncioTestCase):
    """The offline install bundle: node + pi + pi-kimchi-provider, prebuilt.

    Its whole purpose is that agent install touches the network zero times,
    which is what lets a task declaring `allow_internet = false` run this agent
    at all. So the tests that matter are about the fallbacks: a bundle that was
    never built, and one that cannot execute in this task image.
    """

    def setUp(self) -> None:
        self._old_api_key = os.environ.get("KIMCHI_API_KEY")
        os.environ["KIMCHI_API_KEY"] = "test-key"
        self._tmp = tempfile.TemporaryDirectory()
        self.bundle = Path(self._tmp.name) / "pi-bundle"
        os.environ[PI_BUNDLE_DIR_ENV] = str(self.bundle)

    def tearDown(self) -> None:
        os.environ.pop(PI_BUNDLE_DIR_ENV, None)
        if self._old_api_key is None:
            os.environ.pop("KIMCHI_API_KEY", None)
        else:
            os.environ["KIMCHI_API_KEY"] = self._old_api_key
        self._tmp.cleanup()

    def _stage_bundle(self) -> None:
        (self.bundle / "node" / "bin").mkdir(parents=True)
        (self.bundle / "node" / "bin" / "node").write_text("#!/bin/sh\n")
        (self.bundle / "pi" / "bin").mkdir(parents=True)
        (self.bundle / "pi" / "bin" / "pi").write_text("#!/bin/sh\n")
        provider = self.bundle / "extensions" / "pi-kimchi-provider"
        provider.mkdir(parents=True)
        (provider / "package.json").write_text("{}")

    def _agent(self) -> RecordingPiKimchi:
        ext_dir = Path(self._tmp.name) / "provider-source"
        ext_dir.mkdir(exist_ok=True)
        (ext_dir / "package.json").write_text("{}")
        return RecordingPiKimchi(
            logs_dir=Path(self._tmp.name) / "agent",
            model_name="kimchi-dev/kimi-k2.5",
            **{"extension-source-dir": str(ext_dir)},
        )

    async def test_bundle_install_skips_the_network_entirely(self) -> None:
        self._stage_bundle()
        agent = self._agent()
        environment = BundleEnvironment()

        await agent.install(environment)

        self.assertTrue(agent._bundled)
        targets = [target for _, target in environment.uploaded_dirs]
        self.assertIn(CONTAINER_BUNDLE_NODE_DIR, targets)
        self.assertIn(CONTAINER_BUNDLE_PI_DIR, targets)
        self.assertIn(CONTAINER_EXTENSION_STAGE_DIR, targets)
        # Nothing may reach out: no npm install of pi, and no nvm download.
        self.assertFalse(any("npm install -g" in c for c in agent.agent_commands))
        self.assertFalse(any("nvm" in c and "install.sh" in c for c in agent.agent_commands))

    async def test_bundled_run_does_not_npm_install_the_extension(self) -> None:
        # The bundle ships that tree with node_modules already in it; running
        # npm over it would need the network the bundle exists to avoid.
        self._stage_bundle()
        agent = self._agent()
        environment = BundleEnvironment()

        await agent.install(environment)
        await agent.run("solve it", environment, AgentContext())

        run_command = next(c for c in agent.agent_commands if "set -m" in c)
        self.assertIn(f"cp -a {CONTAINER_EXTENSION_STAGE_DIR}/.", run_command)
        self.assertNotIn("npm install --production", run_command)

    async def test_absent_bundle_falls_back_to_the_network_install(self) -> None:
        agent = self._agent()
        environment = BundleEnvironment()

        await agent.install(environment)

        self.assertFalse(agent._bundled)
        self.assertTrue(any("npm install -g" in c for c in agent.agent_commands))
        # ...and the probe never ran, since there was nothing to probe.
        self.assertEqual(environment.exec_commands, [])

    async def test_unrunnable_bundle_is_removed_and_the_network_install_takes_over(self) -> None:
        # The official node tarballs are glibc-linked, so on a musl image the
        # binary uploads fine and simply will not execute. Leaving it on PATH
        # would shadow the working nvm install with something that cannot run.
        self._stage_bundle()
        agent = self._agent()
        environment = BundleEnvironment(probe_return_code=1)

        await agent.install(environment)

        self.assertFalse(agent._bundled)
        self.assertTrue(any(f"rm -rf {CONTAINER_BUNDLE_NODE_DIR}" in c for c in agent.root_commands))
        self.assertTrue(any("npm install -g" in c for c in agent.agent_commands))

    async def test_partial_bundle_is_refused_rather_than_half_used(self) -> None:
        self._stage_bundle()
        (self.bundle / "extensions" / "pi-kimchi-provider" / "package.json").unlink()
        agent = self._agent()
        environment = BundleEnvironment()

        await agent.install(environment)

        self.assertFalse(agent._bundled)
        targets = [target for _, target in environment.uploaded_dirs]
        self.assertNotIn(CONTAINER_BUNDLE_NODE_DIR, targets)
        self.assertNotIn(CONTAINER_BUNDLE_PI_DIR, targets)
        # Refused before anything was uploaded, so there was nothing to probe.
        self.assertEqual(environment.exec_commands, [])
        self.assertTrue(any("npm install -g" in c for c in agent.agent_commands))

    async def test_package_install_failure_is_survivable_when_bundled(self) -> None:
        # An isolated task image has no package repository to reach. With a
        # bundle in hand the only thing left to want from apt is git, which is
        # not worth failing a trial over.
        self._stage_bundle()
        agent = self._agent()

        await agent.install(BundleEnvironment())

        package_command = next(c for c in agent.root_commands if "apt-get" in c)
        self.assertIn("|| echo", package_command)

    async def test_package_install_failure_is_fatal_without_a_bundle(self) -> None:
        # Here the network install still has to happen, so a package manager
        # that cannot run is a real failure and must surface as one.
        agent = self._agent()

        await agent.install(BundleEnvironment())

        package_command = next(c for c in agent.root_commands if "apt-get" in c)
        self.assertNotIn("|| echo", package_command)
