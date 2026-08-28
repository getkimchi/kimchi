"""Retry wrapper for harbor's ``DockerEnvironment.start()``.

When several trials launch simultaneously at the start of a benchmark chunk,
the Docker-in-Docker daemon may not be ready for concurrent
``docker compose up`` commands even though ``docker info`` already succeeds.
The daemon returns errors such as::

    Cannot connect to the Docker daemon at tcp://docker:2375

(often nested under ``unable to get image '<image>': ...``). These failures
are transient -- the daemon recovers within seconds -- but harbor's
``DockerEnvironment.start()`` raises ``RuntimeError`` on the first failure,
killing the trial. ``patch_docker_environment_retry()`` wraps ``start()``
with a bounded retry using exponential backoff with jitter.

Scope: this only takes effect for trials whose agent is imported through
``kimchi_agent`` (i.e. run via ``--agent kimchi_agent:...``),
because importing any ``kimchi_agent`` submodule is what triggers
``kimchi_agent/__init__.py`` to apply this patch. Stock harbor agents
invoked without going through this package are unaffected. If harbor ever
ships native retry support, or this needs to cover non-kimchi_agent agents,
prefer removing/relocating this patch over maintaining a second copy.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from pathlib import Path
from typing import Any

# Attribute set on the patched start() so re-applying the patch (e.g. because
# more than one kimchi_agent submodule triggers package import) is a no-op.
_PATCHED_ATTR = "_kimchi_docker_retry_patched"

# Job-level health counters: trials that hit a transient daemon failure, that
# recovered after retry, and that exhausted the retry budget. chunk_runner folds
# these into chunk-meta ("docker_health"). Recoveries are otherwise invisible in
# verdicts/classification — and they are the leading indicator of DinD health
# degradation (recoveries climb while errors stay at zero).
# Written to <BENCHMARK_RESULTS_DIR>/docker-retry-health-chunk-<INDEX>.json —
# inside the job artifacts, namespaced by BENCH_CHUNK_INDEX because every chunk
# job in a pipeline writes to the same artifact root (an un-namespaced file is
# last-writer-wins when artifacts are merged or listed).
# Accumulation across GitLab retries: chunk_runner._restore_prior_artifact()
# re-extracts the previous attempt's artifacts into the workspace before
# trials start, so counters continue from the most recent attempt that
# managed to upload artifacts. A pod-killed attempt produces no artifact, so
# its engagements/recoveries are only visible via that attempt's job-log
# DOCKER_RETRY_RECOVERED lines, and downstream jobs see only the latest
# successful attempt's artifacts.
# Missing env (local dev, unit tests) disables recording; write failures are
# swallowed so metrics can never break a trial.
# Concurrency: harbor runs trials in one event loop, so read-modify-write below
# is race-free within a process; successive harbor rounds run sequentially.
_ENV_RESULTS_DIR = "BENCHMARK_RESULTS_DIR"
_ENV_CHUNK_INDEX = "BENCH_CHUNK_INDEX"


def _health_file_name() -> str:
    """Chunk-namespaced health filename (chunk jobs share the artifact root)."""
    return f"docker-retry-health-chunk-{os.environ.get(_ENV_CHUNK_INDEX, '0')}.json"
_COUNTERS = ("retry_engagements", "retry_recoveries", "retry_exhausted")

# 6 attempts with base delays 4/8/16/32/64s: nominal budget 124s, guaranteed
# (worst-jitter) budget 62s. Sized so even the guaranteed budget comfortably
# clears the observed ~25s daemon-warmup window in retried CI jobs (fresh DinD
# sidecar answering `docker info` before it can pull), while staying well
# inside harbor's per-task environment build timeout (600s default) that wraps
# start(). NOTE: this only helps while the job process survives -- a
# pod eviction kills the wrapper with it; that mode needs checkpoint restore
# and retryable-infra attempt reconciliation, not more backoff.
_MAX_ATTEMPTS = 6
_BACKOFF_BASE = 4.0  # seconds: base delays before attempts 2-5 are 4, 8, 16, 32
_JITTER_RANGE = (0.5, 1.0)  # scales the base delay to decorrelate parallel trials

# Require the daemon-connectivity marker. Real failures often also say
# "unable to get image", but that substring alone can be a permanent
# missing-image error that should not be retried.
# Keep in sync with the docker_daemon_unreachable rule in
# benchmark/scripts/gitlab/classify.py and _DAEMON_UNREACHABLE_MARKER in
# benchmark/scripts/gitlab/preload_task_images.py — all three sites use a
# lowercase marker matched against casefolded text, so in-process retry,
# pre-warm, and post-hoc classification agree on which failures are transient
# regardless of docker's message casing.
_RETRY_MARKER = "cannot connect to the docker daemon"

_logger = logging.getLogger("kimchi_agent.docker_retry")


def _record_health(counter: str) -> None:
    """Increment one health counter in <BENCHMARK_RESULTS_DIR>/<health file>.

    No-op when the results dir env is unset (local runs, unit tests calling the
    wrapper directly). Atomic via write-temp-then-replace. Any failure is
    swallowed at debug level: metrics must never affect a trial.
    """
    raw = os.environ.get(_ENV_RESULTS_DIR)
    if not raw:
        return
    try:
        path = Path(raw) / _health_file_name()
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {name: 0 for name in _COUNTERS}
        if path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                for name in _COUNTERS:
                    data[name] = int(loaded.get(name, 0))
            except (ValueError, OSError):
                _logger.warning(
                    "docker_retry: %s is unreadable/corrupt; resetting health counters", path
                )
        data[counter] += 1
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        _logger.debug("docker_retry: failed to record health counter", exc_info=True)


def _is_transient_docker_error(message: str) -> bool:
    """Return True if a ``RuntimeError`` message should be retried.

    Exposed at module level (rather than as a closure inside the patch) so
    tests can drive real production trace strings through the actual
    classifier instead of duplicating the marker string.
    """
    return _RETRY_MARKER in message.casefold()


def _backoff_delay(attempt: int) -> float:
    """Jittered exponential backoff delay before retrying `attempt` (1-based).

    Randomizing within ``_JITTER_RANGE`` of the base delay decorrelates
    trials that fail at the same moment (many trials starting -- and
    failing -- simultaneously against a cold daemon was the original
    failure mode), so they don't all retry on the same schedule.
    """
    base = _BACKOFF_BASE * (2 ** (attempt - 1))
    return base * random.uniform(*_JITTER_RANGE)


def patch_docker_environment_retry() -> None:
    """Wrap ``DockerEnvironment.start()`` with retry-on-transient-failure.

    Idempotent: calling this more than once is a no-op after the first
    successful patch.
    """
    try:
        from harbor.environments.docker.docker import DockerEnvironment
    except ImportError:
        # Harbor not installed (e.g. running unit tests outside the benchmark
        # venv, or a future harbor release moving this module). Log so the
        # loss of retry protection is visible instead of silently disappearing.
        _logger.warning(
            "harbor.environments.docker.docker.DockerEnvironment not importable; "
            "Docker daemon retry patch was not applied."
        )
        return

    if getattr(DockerEnvironment.start, _PATCHED_ATTR, False):
        return

    _original_start = DockerEnvironment.start

    # *args/**kwargs keep the wrapper forward-compatible: if a harbor upgrade
    # adds parameters to start(), the patch keeps forwarding instead of
    # breaking with a TypeError.
    async def _start_with_retry(self, force_build: bool, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        last_exc: RuntimeError | None = None
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                result = await _original_start(self, *args, force_build=force_build, **kwargs)
                if attempt > 1:
                    # Structured single-line marker: recoveries are otherwise
                    # invisible outside per-trial logs (see module docstring).
                    _logger.warning("DOCKER_RETRY_RECOVERED attempts=%d", attempt)
                    _record_health("retry_recoveries")
                return result
            except RuntimeError as exc:
                if not _is_transient_docker_error(str(exc)):
                    raise
                _record_health("retry_engagements")
                last_exc = exc
                if attempt < _MAX_ATTEMPTS:
                    delay = _backoff_delay(attempt)
                    # Info, not warning: up to MAX-1 lines per failing trial
                    # would spam job logs when the daemon is degraded. The
                    # warning-level signals are DOCKER_RETRY_RECOVERED (one per
                    # recovery) and the final raised error on exhaustion.
                    _logger.info(
                        "DockerEnvironment.start() failed (attempt %d/%d): %s; "
                        "retrying in %.1fs",
                        attempt,
                        _MAX_ATTEMPTS,
                        str(exc)[:200],
                        delay,
                    )
                    await asyncio.sleep(delay)
        assert last_exc is not None
        _record_health("retry_exhausted")
        raise last_exc

    setattr(_start_with_retry, _PATCHED_ATTR, True)
    DockerEnvironment.start = _start_with_retry  # type: ignore[assignment]


__all__ = ["patch_docker_environment_retry"]
