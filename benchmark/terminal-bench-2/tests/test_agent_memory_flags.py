"""build_cli_flags must carry --memory to the memory-on arm of A/B runs.

A silent regression here (flag dropped, base-class rename) would run the
memory-on arm with memory off and corrupt the benchmark comparison that
motivated the kimchi memory extension.
"""

from __future__ import annotations

from kimchi_agent.agent import Kimchi


def _agent(memory: bool) -> Kimchi:
    """A Kimchi instance with just the state build_cli_flags reads.

    object.__new__ skips __init__ (which needs a full harbor job config);
    the override only touches _memory_enabled, _resolved_flags, and the
    CLI_FLAGS class attribute.
    """
    agent = object.__new__(Kimchi)
    agent._memory_enabled = memory
    agent._resolved_flags = {"thinking": "high"}
    return agent


def test_memory_flag_appended_when_enabled() -> None:
    flags = _agent(memory=True).build_cli_flags()
    assert "--memory" in flags.split()
    # Base flags survive the override.
    assert flags.startswith("--thinking high")


def test_flags_unchanged_when_memory_disabled() -> None:
    assert _agent(memory=False).build_cli_flags() == "--thinking high"
