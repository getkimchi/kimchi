"""Contract tests for benchmark/terminal-bench-2/config/retry.yaml.

The runner script (`scripts/run-claude-code-kimchi.sh`) loads this file via
`harbor run --config`. If a field is renamed or a value drifts, we want to
catch it in unit tests rather than mid-benchmark. These tests assert the
YAML round-trips into harbor's `JobConfig` schema and encodes the retry
policy the shell script relies on.
"""

from __future__ import annotations

import unittest
from pathlib import Path

import yaml
from harbor.models.job.config import JobConfig

RETRY_YAML_PATH = Path(__file__).resolve().parents[2] / "config" / "retry.yaml"


class RetryConfigTest(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(
            RETRY_YAML_PATH.exists(),
            f"retry.yaml missing at expected path: {RETRY_YAML_PATH}",
        )
        raw = yaml.safe_load(RETRY_YAML_PATH.read_text())
        self.config = JobConfig.model_validate(raw)

    def test_retry_policy_matches_shell_script_expectations(self) -> None:
        retry = self.config.retry
        self.assertEqual(retry.max_retries, 5)
        self.assertEqual(retry.wait_multiplier, 2.0)
        self.assertEqual(retry.min_wait_sec, 10.0)
        self.assertEqual(retry.max_wait_sec, 120.0)
        self.assertEqual(retry.include_exceptions, {"RetryableApiError"})

    def test_backoff_curve_matches_documented_values(self) -> None:
        # This mirrors harbor/trial/queue.py:_calculate_backoff_delay_sec.
        retry = self.config.retry

        def delay(attempt: int) -> float:
            return min(
                retry.min_wait_sec * (retry.wait_multiplier**attempt),
                retry.max_wait_sec,
            )

        # 1 initial + 5 retries = 6 attempts, 5 sleeps between them.
        sleeps = [delay(i) for i in range(retry.max_retries)]
        self.assertEqual(sleeps, [10.0, 20.0, 40.0, 80.0, 120.0])
        self.assertEqual(sum(sleeps), 270.0)


if __name__ == "__main__":
    unittest.main()
