"""Canonical outcome values for benchmark trial classification.

Used by classify.py (producer) and summarize_results.py (consumer).
A typo in either can no longer silently drop trials from totals.

`Outcome` is a `StrEnum`, so its values are plain strings — equal to and
interchangeable with the wire strings, and serialised to JSON without any
shim (`json.dumps(Outcome.AGENT_TIMEOUT) == '"agent_timeout"'`).
"""

from __future__ import annotations

from enum import StrEnum


class Outcome(StrEnum):
    SCORED_PASS   = "scored_pass"
    SCORED_FAIL   = "scored_fail"
    AGENT_TIMEOUT = "agent_timeout"
    ERROR         = "error"
