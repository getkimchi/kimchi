"""Tests for the GCS checkpoint Harbor plugin (Phase 3).

Covers the checkpoint failure policy (permanent failure stops scheduling) and
the "never upload the original unredacted" contract through the plugin's own
archive-build path.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Make the stdlib-only checkpoint.py importable from the GitLab-scripts dir so
# the plugin under test can resolve it without the full Harbor runtime.
_BENCH_SCRIPTS = Path(__file__).resolve().parents[4] / "scripts" / "gitlab"
if str(_BENCH_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_BENCH_SCRIPTS))

import checkpoint as ckpt  # noqa: E402

from kimchi_agent.plugins.gcs_checkpoint import (  # noqa: E402
    CheckpointProtectionUnhealthy,
    GCSCheckpointPlugin,
)


def _make_trial(trial_dir: Path, *, task_name: str, reward: float = 1.0) -> None:
    trial_dir.mkdir(parents=True, exist_ok=True)
    (trial_dir / "result.json").write_text(json.dumps({
        "trial_name": trial_dir.name,
        "task_name": task_name,
        "verifier_result": {"rewards": {"reward": reward}},
    }))
    (trial_dir / "config.json").write_text("{}")
    (trial_dir / "lock.json").write_text("{}")


def _event(trial_dir: Path, *, task_name: str = "fix-git"):
    """Build a minimal TrialHookEvent-like object for _on_trial_ended."""
    event = MagicMock()
    config = MagicMock()
    config.trials_dir = trial_dir.parent
    config.trial_name = trial_dir.name
    result = MagicMock()
    result.task_name = task_name
    event.config = config
    event.result = result
    return event


class _FailingUploader:
    """Stands in for gcs_upload_object: always raises CheckpointUploadError."""

    def __call__(
        self, bucket: str, object_name: str, data: bytes, *,
        content_type: str = "application/octet-stream",
        retries: int = 5, base_delay: float = 1.0,
    ) -> None:
        raise ckpt.CheckpointUploadError("permanent failure")


def _new_plugin(*, monkeypatch: pytest.MonkeyPatch, scripts_dir: Path) -> GCSCheckpointPlugin:
    monkeypatch.setenv("KIMCHI_API_KEY", "sk-test-secret")
    plugin = GCSCheckpointPlugin(
        bucket="ckpt-bucket",
        run_prefix="runs/benchmark=tb2/run=gitlab-p1",
        chunk_index=0,
        scripts_dir=str(scripts_dir),
        upload_retries=2,
        base_retry_delay=0.0,
    )
    return plugin


class TestPluginFailurePolicy:
    """A checkpoint that cannot be made durable stops further scheduling."""

    def test_unhealthy_plugin_refuses_subsequent_trials(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = _new_plugin(monkeypatch=monkeypatch, scripts_dir=_BENCH_SCRIPTS)
        # Force the shared transport to fail permanently.
        monkeypatch.setattr(ckpt, "gcs_upload_object", _FailingUploader())

        trial = tmp_path / "trials" / "fix-git__abc"
        _make_trial(trial, task_name="fix-git")

        # First trial: upload fails → plugin raises + marks unhealthy.
        with pytest.raises(CheckpointProtectionUnhealthy):
            asyncio.run(plugin._on_trial_ended(_event(trial)))
        assert plugin.healthy is False

        # Subsequent trial must be refused without re-attempting an upload.
        trial2 = tmp_path / "trials" / "fix-git__def"
        _make_trial(trial2, task_name="fix-git")
        with pytest.raises(CheckpointProtectionUnhealthy, match="unhealthy"):
            asyncio.run(plugin._on_trial_ended(_event(trial2)))

    def test_successful_upload_keeps_plugin_healthy(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = _new_plugin(monkeypatch=monkeypatch, scripts_dir=_BENCH_SCRIPTS)
        store: dict[str, bytes] = {}

        def ok_uploader(
            bucket: str, object_name: str, data: bytes, *,
            content_type: str = "application/octet-stream",
            retries: int = 5, base_delay: float = 1.0,
        ) -> None:
            store[object_name] = data

        monkeypatch.setattr(ckpt, "gcs_upload_object", ok_uploader)

        trial = tmp_path / "trials" / "fix-git__abc"
        _make_trial(trial, task_name="fix-git")
        asyncio.run(plugin._on_trial_ended(_event(trial)))
        assert plugin.healthy is True
        assert store  # something was uploaded

    def test_cancellation_waits_for_in_flight_upload(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A soft-deadline cancellation must not abandon an active upload."""
        plugin = _new_plugin(monkeypatch=monkeypatch, scripts_dir=_BENCH_SCRIPTS)
        upload_finished = False

        def slow_uploader(*args, **kwargs) -> None:
            nonlocal upload_finished
            del args, kwargs
            time.sleep(0.05)
            upload_finished = True

        monkeypatch.setattr(ckpt, "gcs_upload_object", slow_uploader)
        trial = tmp_path / "trials" / "fix-git__abc"
        _make_trial(trial, task_name="fix-git")

        async def cancel_during_upload() -> None:
            task = asyncio.create_task(plugin._on_trial_ended(_event(trial)))
            await asyncio.sleep(0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        asyncio.run(cancel_during_upload())

        assert upload_finished is True
        assert plugin.healthy is True

    def test_job_start_fails_closed_when_bucket_is_unreachable(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        plugin = _new_plugin(monkeypatch=monkeypatch, scripts_dir=_BENCH_SCRIPTS)
        monkeypatch.setattr(
            ckpt,
            "gcs_list_objects",
            MagicMock(side_effect=ckpt.CheckpointRestoreError("permission denied")),
        )
        job = MagicMock()

        with pytest.raises(CheckpointProtectionUnhealthy, match="unavailable"):
            asyncio.run(plugin.on_job_start(job))

        assert plugin.healthy is False
        job.on_trial_ended.assert_not_called()

    def test_job_start_checks_object_access_before_registering_hook(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        plugin = _new_plugin(monkeypatch=monkeypatch, scripts_dir=_BENCH_SCRIPTS)
        list_objects = MagicMock(return_value=[])
        monkeypatch.setattr(ckpt, "gcs_list_objects", list_objects)
        job = MagicMock()

        asyncio.run(plugin.on_job_start(job))

        list_objects.assert_called_once_with(
            "ckpt-bucket",
            ckpt.checkpoint_prefix("runs/benchmark=tb2/run=gitlab-p1"),
        )
        job.on_trial_ended.assert_called_once_with(plugin._on_trial_ended)


class TestPluginRedaction:
    """No secret reaches GCS via the plugin's archive-build path."""

    def test_uploaded_archive_has_no_api_key(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        secret = "sk-top-secret-xyz"
        monkeypatch.setenv("KIMCHI_API_KEY", secret)
        plugin = GCSCheckpointPlugin(
            bucket="ckpt-bucket",
            run_prefix="runs/benchmark=tb2/run=gitlab-p1",
            chunk_index=0,
            scripts_dir=str(_BENCH_SCRIPTS),
            upload_retries=1,
            base_retry_delay=0.0,
        )
        captured: list[bytes] = []

        def capture_uploader(
            bucket: str, object_name: str, data: bytes, *,
            content_type: str = "application/octet-stream",
            retries: int = 5, base_delay: float = 1.0,
        ) -> None:
            captured.append(data)

        monkeypatch.setattr(ckpt, "gcs_upload_object", capture_uploader)

        trial = tmp_path / "trials" / "fix-git__abc"
        _make_trial(trial, task_name="fix-git")
        (trial / "agent").mkdir(exist_ok=True)
        (trial / "agent" / "kimchi.txt").write_text(f"key={secret}\n")

        asyncio.run(plugin._on_trial_ended(_event(trial)))
        assert captured, "an archive must have been uploaded"
        for archive in captured:
            assert secret.encode() not in archive


class TestPluginConstruction:
    def test_rejects_empty_bucket(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("KIMCHI_API_KEY", raising=False)
        with pytest.raises(ValueError, match="bucket"):
            GCSCheckpointPlugin(
                bucket="",
                run_prefix="runs/x",
                chunk_index=0,
                scripts_dir=str(_BENCH_SCRIPTS),
            )

    def test_rejects_empty_run_prefix(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("KIMCHI_API_KEY", raising=False)
        with pytest.raises(ValueError, match="run_prefix"):
            GCSCheckpointPlugin(
                bucket="b",
                run_prefix="",
                chunk_index=0,
                scripts_dir=str(_BENCH_SCRIPTS),
            )
