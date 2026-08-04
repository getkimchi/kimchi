"""Harbor job plugin: durable per-trial GCS checkpointing.

Registered via ``--plugin kimchi_agent.plugins.gcs_checkpoint:GCSCheckpointPlugin``.
For every trial that ends, this plugin:

1. Resolves the completed trial directory from the ``TrialHookEvent``.
2. Sanitizes and archives a *staged, redacted* copy (never the original).
3. Uploads it to GCS with bounded retries and exponential backoff.
4. Returns only after the result is durable.

If a checkpoint cannot be made durable after the configured retries, that is an
infrastructure failure, not an agent/benchmark failure: the plugin marks
checkpoint protection unhealthy, stops scheduling additional trials, and raises
so Harbor terminates the chunk cleanly and exits non-zero for a GitLab retry.

The shared archive/transport semantics live in ``benchmark/scripts/gitlab/checkpoint.py``
(stdlib-only, importable from both this Harbor venv and the system ``python3``
that runs ``chunk_runner.py``). The GitLab-scripts directory is added to
``sys.path`` from the ``scripts_dir`` plugin kwarg (absolute path passed by
``build_harbor_command``).

Design note — why not patch Harbor: Harbor 0.18 already exposes
``Job.on_trial_ended`` and the ``JobPlugin`` protocol, so an extension-hook
adapter (this plugin) is the correct layer. No upstream changes are required.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from typing import TYPE_CHECKING, Any

from harbor.models.job.plugin import BaseJobPlugin

if TYPE_CHECKING:  # pragma: no cover - typing only
    from harbor.job import Job
    from harbor.models.job.result import JobResult
    from harbor.trial.hooks import TrialHookEvent

logger = logging.getLogger(__name__)


class CheckpointProtectionUnhealthy(Exception):
    """Raised when a checkpoint cannot be made durable after all retries.

    Propagated out of ``on_trial_ended`` so Harbor aborts the remaining
    trials instead of continuing to spend model tokens without durable
    protection.
    """


class GCSCheckpointPlugin(BaseJobPlugin):
    """Upload one redacted, checksummed archive per completed trial to GCS."""

    def __init__(
        self,
        *,
        bucket: str,
        run_prefix: str,
        chunk_index: int,
        scripts_dir: str,
        upload_retries: int = 5,
        base_retry_delay: float = 1.0,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        if not bucket:
            raise ValueError("GCSCheckpointPlugin requires a non-empty 'bucket'")
        if not run_prefix:
            raise ValueError("GCSCheckpointPlugin requires a non-empty 'run_prefix'")
        if scripts_dir not in sys.path:
            sys.path.insert(0, str(scripts_dir))

        self._bucket = bucket
        self._run_prefix = run_prefix
        self._chunk_index = int(chunk_index)
        self._upload_retries = max(1, int(upload_retries))
        self._base_retry_delay = float(base_retry_delay)
        # Imported after sys.path is wired so the stdlib-only shared module
        # resolves from the GitLab-scripts directory.
        import checkpoint as ckpt
        import redact_api_key

        self._ckpt = ckpt
        self._redact_module = redact_api_key
        self._unhealthy = False
        self._uploaded = 0
        self._failed = 0
        self._bytes_uploaded = 0

    @property
    def healthy(self) -> bool:
        return not self._unhealthy

    async def on_job_start(self, job: Job) -> None:
        """Validate GCS configuration and register the trial-ended hook.

        Configuration is validated at construction (bucket/run_prefix). Here we
        confirm the bucket is reachable with a cheap no-op listing so a bad
        bucket name fails fast at job start rather than after the first trial.
        """
        try:
            self._ckpt.gcs_list_objects(self._bucket, self._ckpt.checkpoint_prefix(self._run_prefix))
        except Exception as exc:
            self._failed += 1
            self._mark_unhealthy(
                f"checkpoint bucket validation failed at job start: {exc}"
            )
            raise CheckpointProtectionUnhealthy(
                "checkpoint storage is unavailable; refusing to start trials"
            ) from exc
        job.on_trial_ended(self._on_trial_ended)

    async def _on_trial_ended(self, event: TrialHookEvent) -> None:
        """Archive + upload one completed trial. Raises if durability fails."""
        if self._unhealthy:
            # Once unhealthy, refuse to process further trials so Harbor stops
            # spending. The job will exit non-zero via the raised exception.
            raise CheckpointProtectionUnhealthy(
                "checkpoint protection is unhealthy; refusing to schedule more trials"
            )

        trials_dir = event.config.trials_dir
        trial_dir = trials_dir / event.config.trial_name
        trial_id = self._ckpt.trial_id_from_dir(trial_dir)
        # Bare task name: Harbor records the full task_name (may carry a
        # "source/" prefix). Mirror chunk_runner._task_name_from_result.
        task_name = str(event.result.task_name or self._ckpt.task_from_trial_id(trial_id))
        if "/" in task_name:
            task_name = task_name.rsplit("/", 1)[-1]

        object_name = self._ckpt.trial_object_name(
            self._run_prefix, self._chunk_index, trial_id
        )
        started = time.monotonic()

        # Redaction secrets: KIMCHI_API_KEY only (the single secret this
        # benchmark injects). Read at upload time so a key rotation mid-run
        # still redacts the current value.
        secrets = [os.environ.get("KIMCHI_API_KEY", "").encode("utf-8")] if os.environ.get("KIMCHI_API_KEY") else []

        try:
            archive_bytes, payload_sha256 = self._ckpt.create_trial_archive(
                trial_dir,
                task_name=task_name,
                chunk_index=self._chunk_index,
                redact_secrets=secrets,
            )
        except Exception as exc:
            self._failed += 1
            self._mark_unhealthy(f"archive build failed for {trial_id}: {exc}")
            raise CheckpointProtectionUnhealthy(str(exc)) from exc

        # Run blocking gcloud transport outside Harbor's event loop. If Harbor
        # is cancelled at the soft deadline, shield the already-started upload
        # and wait for it to become durable before propagating cancellation.
        cancelled: asyncio.CancelledError | None = None
        try:
            upload_task = asyncio.create_task(
                asyncio.to_thread(
                    self._ckpt.gcs_upload_object,
                    self._bucket,
                    object_name,
                    archive_bytes,
                    content_type="application/gzip",
                    retries=self._upload_retries,
                    base_delay=self._base_retry_delay,
                )
            )
            try:
                await asyncio.shield(upload_task)
            except asyncio.CancelledError as exc:
                cancelled = exc
                logger.info(
                    "checkpoint_drain_started trial=%s object=%s",
                    trial_id,
                    object_name,
                )
                await upload_task
        except self._ckpt.CheckpointUploadError as exc:
            self._failed += 1
            self._mark_unhealthy(f"upload failed for {trial_id}: {exc}")
            raise CheckpointProtectionUnhealthy(str(exc)) from exc
        except Exception as exc:
            self._failed += 1
            self._mark_unhealthy(f"unexpected upload error for {trial_id}: {exc}")
            raise CheckpointProtectionUnhealthy(str(exc)) from exc

        elapsed = time.monotonic() - started
        self._uploaded += 1
        self._bytes_uploaded += len(archive_bytes)
        logger.info(
            "checkpoint_durable trial=%s task=%s object=%s sha256=%s bytes=%d duration_s=%.2f",
            trial_id, task_name, object_name, payload_sha256[:12], len(archive_bytes), elapsed,
        )
        if cancelled is not None:
            raise cancelled

    def _mark_unhealthy(self, reason: str) -> None:
        self._unhealthy = True
        logger.error("checkpoint_protection_unhealthy reason=%s", reason)

    async def on_job_end(self, job_result: JobResult) -> None:
        del job_result
        logger.info(
            "checkpoint_summary uploaded=%d failed=%d bytes=%d healthy=%s",
            self._uploaded, self._failed, self._bytes_uploaded, self.healthy,
        )
        if self._unhealthy:
            # Surface non-zero via exception so Harbor's finalize path records it.
            raise CheckpointProtectionUnhealthy(
                "chunk exited with unhealthy checkpoint protection"
            )


__all__ = ["CheckpointProtectionUnhealthy", "GCSCheckpointPlugin"]
