"""The ferment-oneshot arm runs V1, so it must turn the new Ferment off.

`extensions.ferment` now names the new Ferment and is on by default. Without
the settings override, the V1 arm would run with both Ferments loaded.
"""

from __future__ import annotations

import json
import re

from kimchi_agent.agent import Kimchi


def _agent(oneshot: bool) -> Kimchi:
    """A Kimchi instance with just the state _harness_settings_command reads."""
    agent = object.__new__(Kimchi)
    agent._resolved_flags = {"ferment-oneshot": True} if oneshot else {}
    agent._disable_compaction = False
    agent.model_name = ""
    return agent


def _settings(agent: Kimchi) -> dict:
    command = agent._harness_settings_command()
    match = re.search(r"printf '%s\\n' '(.*)' > ", command)
    assert match, command
    return json.loads(match.group(1))


def test_oneshot_arm_turns_ferment_off() -> None:
    assert _settings(_agent(oneshot=True))["resources"] == {"extensions.ferment": False}


def test_default_arm_leaves_ferment_on() -> None:
    assert "resources" not in _settings(_agent(oneshot=False))
