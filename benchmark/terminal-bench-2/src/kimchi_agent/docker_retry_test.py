"""Tests for the DockerEnvironment.start() retry wrapper in docker_retry.py.

The patch is applied at import time via ``kimchi_agent/__init__.py`` calling
``patch_docker_environment_retry()``. These tests verify that transient
Docker daemon failures are retried with jittered backoff, while non-transient
failures are re-raised immediately, and that the real classifier
(``_is_transient_docker_error``) -- not a duplicated literal -- accepts the
error strings actually observed in benchmark traces.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, call, patch

import kimchi_agent.docker_retry as docker_retry

_TRANSIENT_ERROR = (
    "Docker compose command failed. "
    "Cannot connect to the Docker daemon at tcp://docker:2375. "
    "Is the docker daemon running?"
)


def _read_health(results_dir: Path) -> dict:
    return json.loads((results_dir / "docker-retry-health-chunk-0.json").read_text(encoding="utf-8"))


class DockerRetryPatchTest(unittest.TestCase):
    """Verify the retry behaviour of the patched DockerEnvironment.start()."""

    def setUp(self) -> None:
        try:
            from harbor.environments.docker.docker import DockerEnvironment
        except ImportError:
            self.skipTest("harbor not installed in this environment")

        self.DockerEnvironment = DockerEnvironment
        # Save the currently-patched start so we can restore it after each test.
        self._saved_start = DockerEnvironment.start

    def tearDown(self) -> None:
        self.DockerEnvironment.start = self._saved_start

    def _repatch_with_mock(self, mock_start: AsyncMock) -> None:
        """Replace start with mock, clear the patched flag, then re-apply."""
        self.DockerEnvironment.start = mock_start
        # Allow re-patch after swapping in a fresh mock start().
        if hasattr(mock_start, docker_retry._PATCHED_ATTR):
            delattr(mock_start, docker_retry._PATCHED_ATTR)
        docker_retry.patch_docker_environment_retry()

    def test_patch_was_applied_at_import(self) -> None:
        """The patched start should be a coroutine function."""
        self.assertTrue(
            inspect.iscoroutinefunction(self._saved_start),
            "Patched start() should be a coroutine function",
        )
        self.assertTrue(
            getattr(self._saved_start, docker_retry._PATCHED_ATTR, False),
            "Import-time patch should set the idempotency marker",
        )

    def test_patch_is_idempotent(self) -> None:
        """Calling the patcher twice must not nest retry wrappers."""
        before = self.DockerEnvironment.start
        docker_retry.patch_docker_environment_retry()
        self.assertIs(self.DockerEnvironment.start, before)

    def test_unknown_kwargs_forwarded_to_original(self) -> None:
        """Extra args/kwargs must pass through so future harbor signature changes keep working."""
        mock = AsyncMock(return_value=None)
        self._repatch_with_mock(mock)

        env = MagicMock(spec=self.DockerEnvironment)
        asyncio.run(self.DockerEnvironment.start(env, force_build=True, some_future_kwarg=123))

        mock.assert_awaited_once_with(env, force_build=True, some_future_kwarg=123)

    def test_transient_daemon_error_retried_then_succeeds(self) -> None:
        """A 'Cannot connect to the Docker daemon' error should be retried."""
        transient_error = RuntimeError(
            "Docker compose command failed. "
            "Cannot connect to the Docker daemon at tcp://docker:2375. "
            "Is the docker daemon running?"
        )
        mock = AsyncMock(side_effect=[transient_error, None])
        sleep = AsyncMock()
        with (
            patch("kimchi_agent.docker_retry.asyncio.sleep", new=sleep),
            patch("kimchi_agent.docker_retry.random.uniform", return_value=1.0),
        ):
            self._repatch_with_mock(mock)

            env = MagicMock(spec=self.DockerEnvironment)
            asyncio.run(self.DockerEnvironment.start(env, force_build=False))

        self.assertEqual(mock.await_count, 2)
        sleep.assert_awaited_once_with(4.0)

    def test_transient_image_pull_error_with_daemon_marker_retried(self) -> None:
        """Image-pull errors that include the daemon marker should be retried."""
        transient_error = RuntimeError(
            "Docker compose command failed. "
            "unable to get image 'alexgshaw/qemu-startup:20251031': "
            "Cannot connect to the Docker daemon at tcp://docker:2375."
        )
        mock = AsyncMock(side_effect=[transient_error, transient_error, None])
        sleep = AsyncMock()
        with (
            patch("kimchi_agent.docker_retry.asyncio.sleep", new=sleep),
            patch("kimchi_agent.docker_retry.random.uniform", return_value=1.0),
        ):
            self._repatch_with_mock(mock)

            env = MagicMock(spec=self.DockerEnvironment)
            asyncio.run(self.DockerEnvironment.start(env, force_build=False))

        self.assertEqual(mock.await_count, 3)
        self.assertEqual(sleep.await_args_list, [call(4.0), call(8.0)])

    def test_health_counters_recorded_on_recovery(self) -> None:
        """Transient failure then success increments engagement + recovery counters."""
        with tempfile.TemporaryDirectory() as tmp:
            env = {"BENCHMARK_RESULTS_DIR": tmp}
            with patch.dict("os.environ", env, clear=False):
                mock = AsyncMock(side_effect=[RuntimeError(_TRANSIENT_ERROR), None])
                with (
                    patch("kimchi_agent.docker_retry.asyncio.sleep", new=AsyncMock()),
                    patch("kimchi_agent.docker_retry.random.uniform", return_value=1.0),
                ):
                    self._repatch_with_mock(mock)
                    env_obj = MagicMock(spec=self.DockerEnvironment)
                    asyncio.run(self.DockerEnvironment.start(env_obj, force_build=False))

            health = _read_health(Path(tmp))
        self.assertEqual(health["retry_engagements"], 1)
        self.assertEqual(health["retry_recoveries"], 1)
        self.assertEqual(health["retry_exhausted"], 0)

    def test_health_counters_recorded_on_exhaustion(self) -> None:
        """Budget exhaustion counts every engagement plus one exhaustion."""
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict("os.environ", {"BENCHMARK_RESULTS_DIR": tmp}, clear=False):
                mock = AsyncMock(side_effect=RuntimeError(_TRANSIENT_ERROR))
                with (
                    patch("kimchi_agent.docker_retry.asyncio.sleep", new=AsyncMock()),
                    patch("kimchi_agent.docker_retry.random.uniform", return_value=1.0),
                ):
                    self._repatch_with_mock(mock)
                    env_obj = MagicMock(spec=self.DockerEnvironment)
                    with self.assertRaises(RuntimeError):
                        asyncio.run(self.DockerEnvironment.start(env_obj, force_build=False))

            health = _read_health(Path(tmp))
        self.assertEqual(health["retry_engagements"], docker_retry._MAX_ATTEMPTS)
        self.assertEqual(health["retry_recoveries"], 0)
        self.assertEqual(health["retry_exhausted"], 1)

    def test_health_counters_accumulate_across_calls(self) -> None:
        """Counters accumulate in the file across multiple patched invocations
        (mirrors successive harbor trials/rounds in one job)."""
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.dict("os.environ", {"BENCHMARK_RESULTS_DIR": tmp}, clear=False),
            patch("kimchi_agent.docker_retry.asyncio.sleep", new=AsyncMock()),
            patch("kimchi_agent.docker_retry.random.uniform", return_value=1.0),
        ):
            for _ in range(2):
                mock = AsyncMock(side_effect=[RuntimeError(_TRANSIENT_ERROR), None])
                self._repatch_with_mock(mock)
                env_obj = MagicMock(spec=self.DockerEnvironment)
                asyncio.run(self.DockerEnvironment.start(env_obj, force_build=False))

            health = _read_health(Path(tmp))
        self.assertEqual(health["retry_engagements"], 2)
        self.assertEqual(health["retry_recoveries"], 2)

    def test_health_file_namespaced_by_chunk_index(self) -> None:
        """Chunk jobs share the artifact root; the health file must carry BENCH_CHUNK_INDEX."""
        with tempfile.TemporaryDirectory() as tmp:
            env = {"BENCHMARK_RESULTS_DIR": tmp, "BENCH_CHUNK_INDEX": "2"}
            with patch.dict("os.environ", env, clear=False):
                mock = AsyncMock(side_effect=[RuntimeError(_TRANSIENT_ERROR), None])
                with (
                    patch("kimchi_agent.docker_retry.asyncio.sleep", new=AsyncMock()),
                    patch("kimchi_agent.docker_retry.random.uniform", return_value=1.0),
                ):
                    self._repatch_with_mock(mock)
                    env_obj = MagicMock(spec=self.DockerEnvironment)
                    asyncio.run(self.DockerEnvironment.start(env_obj, force_build=False))

            health = json.loads(
                (Path(tmp) / "docker-retry-health-chunk-2.json").read_text(encoding="utf-8")
            )
        self.assertEqual(health["retry_recoveries"], 1)

    def test_health_recording_disabled_without_results_dir_env(self) -> None:
        """Without BENCHMARK_RESULTS_DIR, recording is a no-op (no crash, no file)."""
        mock = AsyncMock(side_effect=[RuntimeError(_TRANSIENT_ERROR), None])
        with (
            patch.dict("os.environ", {}, clear=True),
            patch("kimchi_agent.docker_retry.asyncio.sleep", new=AsyncMock()),
            patch("kimchi_agent.docker_retry.random.uniform", return_value=1.0),
        ):
            self._repatch_with_mock(mock)
            env_obj = MagicMock(spec=self.DockerEnvironment)
            asyncio.run(self.DockerEnvironment.start(env_obj, force_build=False))
        self.assertEqual(mock.await_count, 2)

    def test_guaranteed_retry_budget_covers_warmup_window(self) -> None:
        """Worst-jitter total backoff must cover the observed daemon warmup window.

        Sized against the ~25s observed DinD warmup in retried CI jobs with
        headroom (spec: ~60s total budget): even with jitter at the bottom of
        its range, the summed sleeps before the final attempt must be >= 60s.
        """
        bases = [
            docker_retry._BACKOFF_BASE * (2 ** (attempt - 1))
            for attempt in range(1, docker_retry._MAX_ATTEMPTS)
        ]
        guaranteed_budget = sum(bases) * docker_retry._JITTER_RANGE[0]
        self.assertGreaterEqual(guaranteed_budget, 60.0)

    def test_jitter_scales_backoff_within_expected_range(self) -> None:
        """Backoff delay is randomized within the documented jitter range."""
        for attempt, base in ((1, 4.0), (2, 8.0), (3, 16.0)):
            delays = {docker_retry._backoff_delay(attempt) for _ in range(200)}
            self.assertTrue(all(base * 0.5 <= d <= base for d in delays))
            # 200 samples of a continuous distribution should not collapse to
            # a single deterministic value.
            self.assertGreater(len(delays), 1)

    def test_unable_to_get_image_alone_not_retried(self) -> None:
        """A permanent missing-image error must not be retried."""
        permanent_error = RuntimeError(
            "Docker compose command failed. "
            "unable to get image 'alexgshaw/missing:tag': not found"
        )
        mock = AsyncMock(side_effect=permanent_error)
        sleep = AsyncMock()
        with patch("kimchi_agent.docker_retry.asyncio.sleep", new=sleep):
            self._repatch_with_mock(mock)

            env = MagicMock(spec=self.DockerEnvironment)
            with self.assertRaises(RuntimeError):
                asyncio.run(self.DockerEnvironment.start(env, force_build=False))

        self.assertEqual(mock.await_count, 1)
        sleep.assert_not_awaited()

    def test_non_transient_error_not_retried(self) -> None:
        """A compose-definition error should not be retried."""
        permanent_error = RuntimeError(
            "services.agent.image: image OS mismatch: expected linux, got windows"
        )
        mock = AsyncMock(side_effect=permanent_error)
        with patch("kimchi_agent.docker_retry.asyncio.sleep", new=AsyncMock()):
            self._repatch_with_mock(mock)

            env = MagicMock(spec=self.DockerEnvironment)
            with self.assertRaises(RuntimeError):
                asyncio.run(self.DockerEnvironment.start(env, force_build=False))

        self.assertEqual(mock.await_count, 1)

    def test_all_retries_exhausted_raises_last_error(self) -> None:
        """If all attempts fail with transient errors, the last exception is raised."""
        transient_error = RuntimeError(
            "Cannot connect to the Docker daemon at tcp://docker:2375."
        )
        mock = AsyncMock(side_effect=transient_error)
        with patch("kimchi_agent.docker_retry.asyncio.sleep", new=AsyncMock()):
            self._repatch_with_mock(mock)

            env = MagicMock(spec=self.DockerEnvironment)
            with self.assertRaises(RuntimeError):
                asyncio.run(self.DockerEnvironment.start(env, force_build=False))

        self.assertEqual(mock.await_count, docker_retry._MAX_ATTEMPTS)


class IsTransientDockerErrorTest(unittest.TestCase):
    """Drive the actual classifier used by the patch, not a duplicated literal."""

    def test_real_benchmark_errors_classified_transient(self) -> None:
        """Real error messages captured from FP8/ZAI traces must be retried."""
        real_errors = [
            "Docker compose command failed for environment qemu-startup. "
            "Return code: 1. "
            "Stdout: unable to get image 'alexgshaw/qemu-startup:20251031': "
            "Cannot connect to the Docker daemon at tcp://docker:2375. "
            "Is the docker daemon running?. Stderr: None.",
            "Docker compose command failed for environment raman-fitting. "
            "Return code: 1. "
            "Stdout: unable to get image 'alexgshaw/raman-fitting:20251031': "
            "Cannot connect to the Docker daemon at tcp://docker:2375. "
            "Is the docker daemon running?. Stderr: None.",
        ]
        for err in real_errors:
            self.assertTrue(
                docker_retry._is_transient_docker_error(err),
                f"Real benchmark error should be classified transient: {err[:100]}",
            )

    def test_daemon_marker_matched_case_insensitively(self) -> None:
        """Casing drift in docker's own message must not silently disable retry."""
        self.assertTrue(
            docker_retry._is_transient_docker_error(
                "Cannot Connect To The Docker Daemon At tcp://docker:2375"
            )
        )

    def test_permanent_missing_image_not_classified_transient(self) -> None:
        self.assertFalse(
            docker_retry._is_transient_docker_error(
                "unable to get image 'alexgshaw/missing:tag': not found"
            )
        )

    def test_compose_definition_error_not_classified_transient(self) -> None:
        self.assertFalse(
            docker_retry._is_transient_docker_error(
                "services.agent.image: image OS mismatch: expected linux, got windows"
            )
        )


if __name__ == "__main__":
    unittest.main()
