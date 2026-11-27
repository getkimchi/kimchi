"""The memory-on A/B arm enables the extension via KIMCHI_ENABLE_RESOURCES.

A silent regression here (env prefix dropped, command restructured) would
run the memory-on arm with memory off and corrupt the benchmark comparison
that motivated the kimchi memory extension. The mechanism is a per-resource
env enable on the invocation — not a CLI flag, and not the global
experimental switch.
"""

from __future__ import annotations

from kimchi_agent.agent import Kimchi


def _agent(memory: bool) -> Kimchi:
    """A Kimchi instance with just the state _kimchi_command reads.

    object.__new__ skips __init__ (which needs a full harbor job config);
    _kimchi_command touches _memory_enabled, model_name, and
    _extension_paths() (which needs no state).
    """
    agent = object.__new__(Kimchi)
    agent._memory_enabled = memory
    agent.model_name = "test-model"
    return agent


def test_memory_env_prefix_when_enabled() -> None:
    command = _agent(memory=True)._kimchi_command("")
    # The prefix appends any KIMCHI_ENABLE_RESOURCES already in the exec env
    # (e.g. extensions.ferment-legacy for the ferment-oneshot arm) instead of
    # replacing it.
    assert command.startswith(
        "KIMCHI_ENABLE_RESOURCES=extensions.memory${KIMCHI_ENABLE_RESOURCES:+,$KIMCHI_ENABLE_RESOURCES} "
    )


def test_memory_env_prefix_composes_with_exec_env_in_shell() -> None:
    import subprocess

    prefix = _agent(memory=True)._kimchi_command("").split(" ", 1)[0]
    script = f'{prefix} sh -c \'printf "%s" "$KIMCHI_ENABLE_RESOURCES"\''
    merged = subprocess.run(
        ["sh", "-c", script],
        env={"PATH": "/usr/bin:/bin", "KIMCHI_ENABLE_RESOURCES": "extensions.ferment-legacy"},
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert merged == "extensions.memory,extensions.ferment-legacy"
    alone = subprocess.run(
        ["sh", "-c", script], env={"PATH": "/usr/bin:/bin"}, capture_output=True, text=True, check=True
    ).stdout
    assert alone == "extensions.memory"


def test_no_memory_env_when_disabled() -> None:
    command = _agent(memory=False)._kimchi_command("")
    assert "KIMCHI_ENABLE_RESOURCES" not in command
