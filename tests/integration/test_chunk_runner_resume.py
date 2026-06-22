"""Integration test: chunk_runner skips tasks already classified as final in local artifact."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add the chunk_runner package to path so we can import it
CHUNK_RUNNER_DIR = (
    Path(__file__).resolve().parents[2] / "benchmark" / "terminal-bench-2" / "scripts"
)
sys.path.insert(0, str(CHUNK_RUNNER_DIR))

from chunk_runner import main  # noqa: E402


def _make_pass_result(trial: Path) -> None:
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(
        json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
    )


def test_resume_skips_done_tasks(tmp_path: Path, monkeypatch) -> None:
    """Local artifact has 2/3 tasks done → Harbor is invoked for task-c only."""
    results_dir = tmp_path / "jobs"
    for task in ["task-a__1", "task-b__1"]:
        _make_pass_result(results_dir / "run-1" / task)

    monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")
    monkeypatch.setenv("BENCH_CHUNK_COUNT", "1")
    monkeypatch.setenv("SELECTED_TASKS_JSON", '["task-a","task-b","task-c"]')
    monkeypatch.setenv("BENCHMARK_RESULTS_DIR", str(results_dir))
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

    def fake_harbor(*, cmd, cwd, env):
        results_dir_path = Path(env["BENCHMARK_RESULTS_DIR"])
        if not results_dir_path.is_absolute():
            results_dir_path = Path(env.get("CI_PROJECT_DIR", cwd)) / results_dir_path
        trial_dir = results_dir_path / "run-2" / "task-c__1"
        trial_dir.mkdir(parents=True, exist_ok=True)
        import json as _json
        (trial_dir / "result.json").write_text(
            _json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
        )
        proc = MagicMock()
        proc.wait.return_value = 0
        return proc

    with patch("chunk_runner.run_harbor", side_effect=fake_harbor) as mock_harbor, \
         patch("chunk_runner._make_gcs_uploader", return_value=MagicMock()):
        exit_code = main()

    assert exit_code == 0
    assert mock_harbor.call_count == 1
    cmd = mock_harbor.call_args.kwargs["cmd"]
    task_args = [cmd[i + 1] for i, arg in enumerate(cmd) if arg == "-i"]
    assert all("task-c" in t for t in task_args)
    assert all("task-a" not in t and "task-b" not in t for t in task_args)
