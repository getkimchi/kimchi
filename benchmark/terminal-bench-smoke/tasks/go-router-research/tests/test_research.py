"""Trivial verifier — only asserts the agent produced a non-trivial answer file.

This task exists in the smoke set so research-style runs share the harness
plumbing (tagging, jobs/, session JSONL) with the coding tasks. Reward here
is not a quality signal; compare runs by tokens / subagent count / duration.
"""

from pathlib import Path

ANSWER = Path("/app/answer.md")
MIN_BYTES = 500


def test_answer_exists():
    assert ANSWER.is_file(), f"agent did not produce {ANSWER}"


def test_answer_non_trivial():
    size = ANSWER.stat().st_size
    assert size >= MIN_BYTES, f"answer too short ({size} bytes < {MIN_BYTES})"
