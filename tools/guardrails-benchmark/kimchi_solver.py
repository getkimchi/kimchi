"""Run each Inspect sample in the branch-built Kimchi binary via Agent Bridge."""

from __future__ import annotations

import json
import os
import socket
import tempfile
import uuid
from contextlib import suppress
from pathlib import Path
from typing import Any

from inspect_ai.agent import AgentState, BridgedToolsSpec, sandbox_agent_bridge
from inspect_ai.solver import Generate, TaskState, solver
from inspect_ai.util import sandbox

_SECRET_ENV_NAMES = (
    "KIMCHI_API_KEY",
    "OPENAI_API_KEY",
    "BASELINE_API_KEY",
    "GUARDED_API_KEY",
    "GUARDRAILS_BENCHMARK_BASELINE_API_KEY",
    "GUARDRAILS_BENCHMARK_GUARDED_API_KEY",
)


def build_models_config(*, port: int) -> dict[str, Any]:
    """Point the harness at Inspect's loopback bridge, never at a real provider."""
    return {
        "providers": {
            "inspect": {
                "api": "openai-completions",
                "baseUrl": f"http://localhost:{port}/v1",
                # A loopback-only placeholder, not an API credential. Inspect
                # discards authorization headers before the real provider call.
                "apiKey": "inspect",
                "models": [
                    {
                        "id": "inspect",
                        "name": "Inspect benchmark model",
                        "provider": "inspect",
                        "reasoning": False,
                        "input": ["text"],
                        "contextWindow": 262_144,
                        "maxTokens": 4_096,
                        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                    }
                ],
            }
        }
    }


def build_mcp_config(*, port: int) -> dict[str, Any]:
    """Expose bridged tools under their original names for the stock scorers."""
    return {
        "mcpServers": {
            "benchmark": {
                "url": f"http://localhost:{port}/mcp/benchmark",
                "directTools": True,
                "toolPrefix": "none",
            }
        },
        "settings": {"autoAuth": False},
    }


def build_kimchi_command(*, binary: str, mcp_config: str, system_prompt: str) -> list[str]:
    command = [
        binary,
        "--print",
        "--no-session",
        "--no-auto-update",
        "--no-builtin-tools",
        "--dangerously-skip-permissions",
        "--model",
        "inspect/inspect",
        "--mcp-config",
        mcp_config,
    ]
    if system_prompt:
        # These are the public benchmark's static instructions, not sample
        # prompts. Sample input is always sent over stdin, never via argv.
        command.extend(["--append-system-prompt", system_prompt])
    return command


def scrubbed_environment(*, home: str, package_dir: str) -> dict[str, str]:
    """Prevent Inspect's real provider credentials reaching the agent process."""
    env = {name: "" for name in _SECRET_ENV_NAMES}
    env.update({"HOME": home, "PI_PACKAGE_DIR": package_dir, "NO_COLOR": "1"})
    return env


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _system_prompt(state: TaskState) -> str:
    return "\n\n".join(message.text for message in state.messages if message.role == "system")


async def _write_sandbox_json(path: Path, value: dict[str, Any]) -> None:
    await sandbox().write_file(str(path), json.dumps(value, indent=2) + "\n")


@solver
def kimchi() -> Any:
    """Replace only stock generation; dataset, setup, limits and scorers stay intact."""
    binary = os.environ.get("KIMCHI_BENCH_BINARY", "").strip()
    if not binary:
        raise ValueError("KIMCHI_BENCH_BINARY must name the branch-built Kimchi binary")
    binary_path = Path(binary)
    if not binary_path.is_absolute():
        raise ValueError("KIMCHI_BENCH_BINARY must be an absolute path inside the sandbox")
    package_dir = binary_path.parent.parent / "share" / "kimchi"

    async def solve(state: TaskState, generate: Generate) -> TaskState:
        del generate  # Kimchi owns the agent loop; Inspect owns model routing and scoring.
        port = _free_port()
        agent_state = AgentState(messages=state.messages)
        workspace = Path(tempfile.gettempdir()) / f"kimchi-guardrails-sample-{uuid.uuid4()}"
        home = workspace / "home"
        harness_dir = home / ".config" / "kimchi" / "harness"
        mcp_config = workspace / "mcp.json"
        try:
            # These paths live in the sandbox. Host-side writes would not exist
            # in Docker, and host-side existence checks reject container paths.
            await _write_sandbox_json(harness_dir / "models.json", build_models_config(port=port))
            await _write_sandbox_json(
                harness_dir / "settings.json",
                {"defaultProvider": "inspect", "defaultModel": "inspect", "defaultProjectTrust": "always"},
            )
            await _write_sandbox_json(mcp_config, build_mcp_config(port=port))

            try:
                async with sandbox_agent_bridge(
                    agent_state,
                    port=port,
                    bridged_tools=[BridgedToolsSpec(name="benchmark", tools=state.tools)],
                ) as bridge:
                    result = await sandbox().exec(
                        cmd=build_kimchi_command(
                            binary=str(binary_path),
                            mcp_config=str(mcp_config),
                            system_prompt=_system_prompt(state),
                        ),
                        input=state.user_prompt.text,
                        cwd=str(workspace),
                        env=scrubbed_environment(home=str(home), package_dir=str(package_dir)),
                    )
                    if not result.success:
                        # Do not copy output into CI logs: it can contain harmful
                        # benchmark text or provider diagnostics with credentials.
                        raise RuntimeError(f"the branch-built Kimchi process exited with code {result.returncode}")
                    agent_state = bridge.state
            finally:
                state.messages = agent_state.messages
                state.output = agent_state.output
        finally:
            with suppress(Exception):
                await sandbox().exec(["rm", "-rf", str(workspace)])
        return state

    return solve
