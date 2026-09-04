"""Shared fixtures for benchmark tests."""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def tmp_results_dir(tmp_path: Path) -> Path:
    """A fresh directory mimicking benchmark/terminal-bench-2/jobs."""
    results_dir = tmp_path / "jobs"
    results_dir.mkdir(parents=True)
    return results_dir
