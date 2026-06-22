"""Integration test: chunk with empty slice exits 0 immediately."""

from __future__ import annotations

import sys
from pathlib import Path

CHUNK_RUNNER_DIR = (
    Path(__file__).resolve().parents[2] / "benchmark" / "terminal-bench-2" / "scripts"
)
sys.path.insert(0, str(CHUNK_RUNNER_DIR))

from chunk_runner import main  # noqa: E402


def test_empty_slice_exits_zero(tmp_path: Path, monkeypatch) -> None:
    """When chunk has no tasks (e.g. only 3 tasks selected, this is chunk 7 of 8), exit 0."""
    monkeypatch.setenv("BENCH_CHUNK_INDEX", "7")
    monkeypatch.setenv("BENCH_CHUNK_COUNT", "8")
    monkeypatch.setenv("SELECTED_TASKS_JSON", '["task-a","task-b","task-c"]')
    monkeypatch.setenv("BENCHMARK_RESULTS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("BENCH_PARALLELISM", "1")
    monkeypatch.setenv("BENCH_ATTEMPTS", "1")
    monkeypatch.setenv("BENCH_TIMEOUT_MULTIPLIER", "1")
    monkeypatch.setenv("CODING_AGENT", "kimchi")
    monkeypatch.setenv("MODEL", "kimchi-dev/kimi-k2.6")
    monkeypatch.setenv("KIMCHI_API_KEY", "test-key")
    monkeypatch.setenv("DATASET", "terminal-bench/terminal-bench-2")
    monkeypatch.setenv("KIMCHI_MULTI_MODEL", "false")
    monkeypatch.setenv("KIMCHI_FERMENT_ONESHOT", "false")
    monkeypatch.setenv("BENCHMARK_GCS_BUCKET", "test-bucket")

    exit_code = main()

    assert exit_code == 0
