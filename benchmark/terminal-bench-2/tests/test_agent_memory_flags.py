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
    _kimchi_command touches _memory_enabled, _multi_model_enabled,
    model_name, and _extension_paths() (which needs no state).
    """
    agent = object.__new__(Kimchi)
    agent._memory_enabled = memory
    agent._multi_model_enabled = False
    agent.model_name = "test-model"
    return agent


def test_memory_env_prefix_when_enabled() -> None:
    command = _agent(memory=True)._kimchi_command("")
    assert command.startswith("KIMCHI_ENABLE_RESOURCES=extensions.memory ")


def test_no_memory_env_when_disabled() -> None:
    command = _agent(memory=False)._kimchi_command("")
    assert "KIMCHI_ENABLE_RESOURCES" not in command
