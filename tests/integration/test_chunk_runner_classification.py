"""Integration test: chunk_runner correctly classifies and writes verdicts."""

from __future__ import annotations

import json
import sys
from pathlib import Path

CHUNK_RUNNER_DIR = (
    Path(__file__).resolve().parents[2] / "benchmark" / "terminal-bench-2" / "scripts"
)
sys.path.insert(0, str(CHUNK_RUNNER_DIR))

from chunk_runner import process_trial_results  # noqa: E402


def test_mixed_verdicts(tmp_path: Path) -> None:
    """Mixed pass/quality/infra/missing → GCS gets final verdicts only, retry list has infra+missing."""
    results_dir = tmp_path / "jobs"

    # pass
    (results_dir / "run-1" / "pass__1").mkdir(parents=True)
    (results_dir / "run-1" / "pass__1" / "result.json").write_text(
        json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
    )
    # quality fail
    (results_dir / "run-1" / "quality__1").mkdir(parents=True)
    (results_dir / "run-1" / "quality__1" / "result.json").write_text(
        json.dumps({"verifier_result": {"rewards": {"reward": 0.0}}})
    )
    # infra (ConnectionError in allowlist)
    (results_dir / "run-1" / "infra__1").mkdir(parents=True)
    (results_dir / "run-1" / "infra__1" / "result.json").write_text(
        json.dumps({"exception_info": {"exception_type": "ConnectionError"}})
    )

    uploaded: list[Path] = []

    class FakeGcs:
        def upload(self, local_path: Path, gcs_key: str) -> bool:
            uploaded.append(local_path)
            return True

    # Note: expected_tasks now uses BARE task names (no __1 suffix).
    needs_retry = process_trial_results(
        results_dir=results_dir,
        expected_tasks=["pass", "quality", "infra", "missing"],
        chunk_attempt=1,
        run_id="chunk-0-attempt-1",
        gcs_uploader=FakeGcs(),
    )

    # Final verdicts uploaded: pass + quality (2)
    assert len(uploaded) == 2
    assert any("pass__1" in str(p) for p in uploaded)
    assert any("quality__1" in str(p) for p in uploaded)

    # Retry list: infra + missing (bare names)
    assert sorted(needs_retry) == ["infra", "missing"]
