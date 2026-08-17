"""Integration tests for chunk_runner checkpoint behaviors (Phases 4, 6, 8).

Covers the acceptance criteria:
- Older GitLab artifacts are tried after a newer attempt returns 404 (Phase 8).
- GCS and GitLab restoration overlap without double-counting (Phase 4 merge).
- Soft-deadline behavior stops work and exits non-zero (Phase 6).
- Permanent checkpoint failure stops further scheduling (Phase 3 failure policy,
  exercised via the plugin path in a focused unit test).
"""

from __future__ import annotations

import io
import json
import shutil
import signal
import zipfile as zf
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import pytest

import checkpoint as ckpt
from bench_config import CHECKPOINT_UPLOAD_RETRIES
from chunk_runner import (
    _all_trial_dirs_for_task,
    _build_checkpoint_run_prefix,
    _checkpoint_plugin_args,
    _finalize_chunk,
    _gitlab_job_elapsed_seconds,
    _is_final_work_attempt,
    _may_launch_work,
    _persist_checkpoint_run_metadata,
    _persist_chunk_status,
    _register_durable_chunk_attempt,
    _restore_gcs_checkpoints,
    _restore_prior_artifact,
    main,
)

_RUN_PREFIX = "runs/benchmark=tb2/run=gitlab-p100"


class _FakeHarborProcess:
    """Configurable subprocess stand-in shared by runner lifecycle tests."""

    def __init__(
        self,
        *,
        poll: Callable[[], int | None],
        wait_status: int,
        on_signal: Callable[[int], None] | None = None,
        on_terminate: Callable[[], None] | None = None,
        on_kill: Callable[[], None] | None = None,
    ) -> None:
        self._poll = poll
        self._wait_status = wait_status
        self._on_signal = on_signal
        self._on_terminate = on_terminate
        self._on_kill = on_kill

    def poll(self) -> int | None:
        return self._poll()

    def send_signal(self, signum: int) -> None:
        if self._on_signal is None:
            pytest.fail(f"unexpected signal {signum}")
        self._on_signal(signum)

    def terminate(self) -> None:
        if self._on_terminate is None:
            pytest.fail("unexpected process termination")
        self._on_terminate()

    def kill(self) -> None:
        if self._on_kill is None:
            pytest.fail("unexpected process kill")
        self._on_kill()

    def wait(self) -> int:
        return self._wait_status


def _ci_env(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
    defaults = {
        "CI_JOB_TOKEN": "tok",
        "CI_PROJECT_ID": "1",
        "CI_PIPELINE_ID": "100",
        "CI_JOB_ID": "200",
        "CI_JOB_NAME": "terminal-bench-2-chunks: [0]",
        "BENCH_CHUNK_INDEX": "0",
    }
    for key, val in {**defaults, **overrides}.items():
        monkeypatch.setenv(key, val)


def _main_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
    # Do not let the surrounding GitLab test job consume synthetic deadline
    # budgets. Tests can still opt in by passing CI_JOB_STARTED_AT explicitly.
    monkeypatch.delenv("CI_JOB_STARTED_AT", raising=False)
    defaults = {
        "BENCH_CHUNK_INDEX": "0",
        "BENCH_CHUNK_COUNT": "1",
        "SELECTED_TASKS_JSON": '["task-a"]',
        "BENCHMARK_RESULTS_DIR": str(tmp_path / "jobs"),
        "BENCHMARK_RUN_METADATA": str(tmp_path / ".benchmark" / "run-metadata.json"),
        "BENCHMARK_GCS_BUCKET": "test-bucket",
        "BENCH_PARALLELISM": "1",
        "BENCH_ATTEMPTS": "1",
        "BENCH_TIMEOUT_MULTIPLIER": "1",
        "CODING_AGENT": "kimchi",
        "MODEL": "kimchi-dev/kimi-k2.6",
        "KIMCHI_API_KEY": "test-key",
        "DATASET": "terminal-bench/terminal-bench-2",
        "KIMCHI_FERMENT_ONESHOT": "false",
        "BENCH_RUN_DATE": "2026-06-22",
    }
    for key, val in {**defaults, **overrides}.items():
        monkeypatch.setenv(key, val)


def _checkpoint_main_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    **overrides: str,
) -> None:
    _main_env(
        tmp_path,
        monkeypatch,
        BENCH_TRIAL_CHECKPOINTS="true",
        BENCH_CHECKPOINT_BUCKET="ckpt-bucket",
        CI_PROJECT_ID="1",
        CI_JOB_ID="200",
        **overrides,
    )
    # Main-flow tests isolate scheduling/deadline behavior. Durable status
    # transport has a focused test below and must not invoke real gcloud here.
    monkeypatch.setattr("chunk_runner._persist_chunk_status", lambda **kwargs: None)
    monkeypatch.setattr(
        "chunk_runner.ckpt.gcs_download_object",
        lambda *args, **kwargs: None,
    )


# ---------------------------------------------------------------------------
# Phase 8: older GitLab artifact fallback after 404
# ---------------------------------------------------------------------------

class _FakeResp:
    def __init__(self, data: bytes, *, next_page: str = "") -> None:
        self._data = data
        self.headers = {"X-Next-Page": next_page}

    def read(self) -> bytes:
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _make_zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zf.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


def test_restore_prior_artifact_falls_back_to_older_after_404(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing artifact on the newest attempt continues to older ones."""
    _ci_env(monkeypatch)
    # Newest prior attempt (id=199) 404s; older attempt (id=150) has the artifact.
    older_archive = _make_zip({
        "benchmark/terminal-bench-2/jobs/chunk-meta/chunk-0.json": json.dumps({"chunk_attempt": 1}),
        "benchmark/terminal-bench-2/jobs/run-1/task-a__1/result.json": json.dumps(
            {"verifier_result": {"rewards": {"reward": 1.0}}}
        ),
    })

    call = {"n": 0}

    def fake_urlopen(req, timeout=None):
        call["n"] += 1
        url = req.full_url
        if "jobs?include_retried" in url:
            return _FakeResp(json.dumps([
                {"id": 200, "name": "terminal-bench-2-chunks: [0]"},
                {"id": 199, "name": "terminal-bench-2-chunks: [0]"},  # newest prior
                {"id": 150, "name": "terminal-bench-2-chunks: [0]"},  # older prior
            ]).encode())
        # Artifact fetches: id 199 → 404, id 150 → archive.
        if "/jobs/199/artifacts" in url:
            import urllib.error
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))
        if "/jobs/150/artifacts" in url:
            return _FakeResp(older_archive)
        raise AssertionError(f"unexpected url: {url}")

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        restored = _restore_prior_artifact(tmp_path, workspace=tmp_path)

    assert restored is True
    assert (tmp_path / "benchmark" / "terminal-bench-2" / "jobs" / "chunk-meta" / "chunk-0.json").is_file()
    # The newer attempt's 404 was logged but did not abort restoration.


def test_restore_prior_artifact_finds_older_attempt_on_second_page(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An older artifact remains discoverable beyond GitLab's first page."""
    _ci_env(monkeypatch)
    older_archive = _make_zip({
        "benchmark/terminal-bench-2/jobs/chunk-meta/chunk-0.json": json.dumps(
            {"chunk_attempt": 1}
        ),
    })

    def fake_urlopen(req, timeout=None):
        del timeout
        url = req.full_url
        if "jobs?include_retried" in url and "&page=1" in url:
            return _FakeResp(
                json.dumps([
                    {"id": 200, "name": "terminal-bench-2-chunks: [0]"},
                    {"id": 199, "name": "unrelated-job"},
                ]).encode(),
                next_page="2",
            )
        if "jobs?include_retried" in url and "&page=2" in url:
            return _FakeResp(json.dumps([
                {"id": 150, "name": "terminal-bench-2-chunks: [0]"},
            ]).encode())
        if "/jobs/150/artifacts" in url:
            return _FakeResp(older_archive)
        raise AssertionError(f"unexpected url: {url}")

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        restored = _restore_prior_artifact(tmp_path, workspace=tmp_path)

    assert restored is True
    assert (
        tmp_path
        / "benchmark"
        / "terminal-bench-2"
        / "jobs"
        / "chunk-meta"
        / "chunk-0.json"
    ).is_file()


def test_restore_prior_artifact_404_on_all_returns_false(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When every prior attempt 404s, restoration is a no-op (not a crash)."""
    _ci_env(monkeypatch)
    import urllib.error

    def fake_urlopen(req, timeout=None):
        url = req.full_url
        if "jobs?include_retried" in url:
            return _FakeResp(json.dumps([
                {"id": 200, "name": "terminal-bench-2-chunks: [0]"},
                {"id": 199, "name": "terminal-bench-2-chunks: [0]"},
                {"id": 150, "name": "terminal-bench-2-chunks: [0]"},
            ]).encode())
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        assert _restore_prior_artifact(tmp_path, workspace=tmp_path) is False
    assert not any(tmp_path.iterdir())


# ---------------------------------------------------------------------------
# Phase 4: GCS restore + GitLab merge (no double-counting)
# ---------------------------------------------------------------------------

class _FakeGcsRunner:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self._objects = dict(objects)

    def __call__(self, cmd: list[str], *, timeout: float | None = None) -> tuple[int, str, str]:
        bucket = "ckpt-bucket"
        if "ls" in cmd:
            url = next(a for a in cmd if a.startswith("gs://"))
            prefix = url.removeprefix(f"gs://{bucket}/").removesuffix("/**")
            urls = [f"gs://{bucket}/{n}" for n in self._objects if n.startswith(prefix)]
            return 0, "\n".join(urls), ""
        if "cp" in cmd:
            src = cmd[cmd.index("cp") + 1]
            dst = cmd[cmd.index("cp") + 2]
            if src.startswith("gs://"):
                obj = src.removeprefix(f"gs://{bucket}/")
                if obj not in self._objects:
                    return 1, "", "not found"
                Path(dst).write_bytes(self._objects[obj])
                return 0, "", ""
            self._objects[dst.removeprefix(f"gs://{bucket}/")] = Path(src).read_bytes()
            return 0, "", ""
        return 1, "", f"unhandled: {cmd}"


def _make_trial(trial_dir: Path, *, task_name: str, reward: float = 1.0) -> None:
    trial_dir.mkdir(parents=True, exist_ok=True)
    (trial_dir / "result.json").write_text(json.dumps({
        "trial_name": trial_dir.name,
        "task_name": task_name,
        "verifier_result": {"rewards": {"reward": reward}},
    }))
    (trial_dir / "config.json").write_text("{}")
    (trial_dir / "lock.json").write_text("{}")


def test_gcs_restore_merges_with_gitlab_without_double_counting(tmp_path: Path) -> None:
    """A trial present in both GitLab artifacts and GCS counts once."""
    results_dir = tmp_path / "jobs"
    # GitLab already restored trial "task-a__1" (reward=0.0, different from GCS).
    gitlab_trial = results_dir / "run-1" / "task-a__1"
    _make_trial(gitlab_trial, task_name="task-a", reward=0.0)

    # GCS also has a checkpoint for the same trial id.
    src_trial = tmp_path / "src" / "task-a__1"
    _make_trial(src_trial, task_name="task-a", reward=1.0)
    archive, _ = ckpt.create_trial_archive(src_trial, task_name="task-a", chunk_index=0)
    objects = {ckpt.trial_object_name(_RUN_PREFIX, 0, "task-a__1"): archive}

    with patch("checkpoint.gcs_list_objects") as mock_list, \
         patch("checkpoint.gcs_download_object") as mock_dl:
        mock_list.return_value = list(objects.keys())
        mock_dl.return_value = archive
        _restore_gcs_checkpoints(
            results_dir=results_dir, run_prefix=_RUN_PREFIX, chunk_index=0,
        )

    # The GitLab trial is preserved (GCS restore must not clobber it).
    assert json.loads((gitlab_trial / "result.json").read_text())["verifier_result"]["rewards"]["reward"] == 0.0
    # Reconciliation sees exactly one trial for task-a.
    assert _all_trial_dirs_for_task(results_dir, "task-a") == [gitlab_trial]


def test_gcs_only_restore_is_visible_to_reconciliation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A restored checkpoint must fill a task slot on the next chunk attempt."""
    results_dir = tmp_path / "jobs"
    src_trial = tmp_path / "src" / "task-a__1"
    _make_trial(src_trial, task_name="task-a")
    archive, _ = ckpt.create_trial_archive(src_trial, task_name="task-a", chunk_index=0)
    monkeypatch.setenv("BENCH_TRIAL_CHECKPOINTS", "true")
    monkeypatch.setenv("BENCH_CHECKPOINT_BUCKET", "ckpt-bucket")

    with patch("checkpoint.gcs_list_objects") as mock_list, \
         patch("checkpoint.gcs_download_object", return_value=archive):
        mock_list.return_value = [ckpt.trial_object_name(_RUN_PREFIX, 0, "task-a__1")]
        _restore_gcs_checkpoints(
            results_dir=results_dir, run_prefix=_RUN_PREFIX, chunk_index=0,
        )

    restored = _all_trial_dirs_for_task(results_dir, "task-a")
    assert len(restored) == 1
    assert restored[0].name == "task-a__1"


def test_resume_schedules_cancelled_and_never_started_tasks_only(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A cancelled checkpoint is preserved but does not consume its slot."""
    monkeypatch.chdir(tmp_path)
    _main_env(
        tmp_path,
        monkeypatch,
        SELECTED_TASKS_JSON='["completed", "cancelled", "never-started"]',
        BENCH_CHUNK_ATTEMPT_BUDGET="2",
        BENCH_JOB_TIMEOUT_SECONDS="999999",
    )
    results_dir = tmp_path / "jobs"
    _make_trial(
        results_dir / "checkpoint-restore" / "completed__scored",
        task_name="completed",
    )
    cancelled = results_dir / "checkpoint-restore" / "cancelled__interrupted"
    cancelled.mkdir(parents=True)
    (cancelled / "result.json").write_text(
        json.dumps(
            {
                "task_name": "cancelled",
                "exception_info": {"exception_type": "CancelledError"},
            }
        )
    )
    (cancelled / "trial.log").write_text("")

    scheduled: list[list[str]] = []

    def complete_fresh_attempt(**kwargs):
        scheduled.append(kwargs["tasks"])
        for task in kwargs["tasks"]:
            _make_trial(
                results_dir / "run-fresh" / f"{task}__fresh",
                task_name=task,
            )
        return 0, None

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._run_harbor_invocation", side_effect=complete_fresh_attempt
    ):
        assert main() == 0

    assert scheduled == [["cancelled", "never-started"]]


# ---------------------------------------------------------------------------
# Phase 6: soft deadline behavior
# ---------------------------------------------------------------------------

def test_soft_deadline_interrupts_harbor_and_waits_for_checkpoint_drain(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """At the soft deadline, Harbor gets a cooperative interrupt before force."""
    # GitLab provides this variable to the pytest job. Main-flow tests must not
    # inherit the test job's elapsed time as part of their synthetic deadline.
    monkeypatch.setenv("CI_JOB_STARTED_AT", "2020-01-01T00:00:00Z")
    _checkpoint_main_env(
        tmp_path,
        monkeypatch,
        # soft deadline = int(2 * 0.96) = 1s — fires on the first poll so
        # Harbor gets SIGINT quickly, then drains via the fake proc.
        BENCH_JOB_TIMEOUT_SECONDS="2",
    )

    signals: list[int] = []

    state = {"interrupted": False, "drain_polls": 0}

    def poll_status() -> int | None:
        if not state["interrupted"]:
            return None
        state["drain_polls"] += 1
        return 130 if state["drain_polls"] >= 2 else None

    def record_signal(signum: int) -> None:
        state["interrupted"] = True
        signals.append(signum)

    def reject_termination() -> None:
        pytest.fail("Harbor exited during its checkpoint drain grace period")

    def fake_run_harbor(*, cmd, cwd, env):
        # Harbor stays alive until SIGINT initiates cooperative asyncio
        # cancellation, then exits after one drain poll.
        return _FakeHarborProcess(
            poll=poll_status,
            wait_status=130,
            on_signal=record_signal,
            on_terminate=reject_termination,
        )

    with patch("chunk_runner.run_harbor", side_effect=fake_run_harbor), \
         patch("chunk_runner._restore_prior_artifact", return_value=False), \
         patch("chunk_runner._restore_gcs_checkpoints"), \
         patch("chunk_runner._checkpoint_plugin_args", return_value=None), \
         patch("chunk_runner._persist_checkpoint_run_metadata"), \
         patch("chunk_runner._register_durable_chunk_attempt", return_value=1):
        # Seed no existing trials so Harbor is invoked.
        exit_code = main()
    assert exit_code == 1
    assert signals == [signal.SIGINT]


def test_soft_deadline_includes_startup_and_restore_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Recovery work must consume the same budget as Harbor execution."""
    _checkpoint_main_env(
        tmp_path,
        monkeypatch,
        # soft deadline = int(1000 * 0.96) = 960s
        BENCH_JOB_TIMEOUT_SECONDS="1000",
    )
    clock = [100.0]
    deadlines: list[float] = []

    def fake_restore(*args, **kwargs):
        assert monotonic.call_count == 1
        clock[0] = 500.0
        return False

    def fake_invocation(**kwargs):
        deadlines.append(kwargs["soft_deadline_monotonic"])
        results_dir = Path(kwargs["env"]["BENCHMARK_RESULTS_DIR"])
        trial = results_dir / "run-1" / "task-a__1"
        trial.mkdir(parents=True)
        (trial / "result.json").write_text(json.dumps({
            "task_name": "task-a",
            "verifier_result": {"rewards": {"reward": 1.0}},
        }))
        return 0, None

    with patch(
        "chunk_runner.time.monotonic", side_effect=lambda: clock[0]
    ) as monotonic, patch(
        "chunk_runner._gitlab_job_elapsed_seconds", return_value=50.0
    ), patch(
        "chunk_runner._restore_prior_artifact", side_effect=fake_restore
    ), patch(
        "chunk_runner._restore_gcs_checkpoints"
    ), patch(
        "chunk_runner._persist_checkpoint_run_metadata"
    ), patch(
        "chunk_runner._register_durable_chunk_attempt", return_value=1
    ), patch(
        "chunk_runner._run_harbor_invocation", side_effect=fake_invocation
    ):
        assert main() == 0

    assert deadlines == [1010.0]


def test_soft_deadline_accounts_for_time_before_runner_started(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CI_JOB_STARTED_AT", "2026-07-30T10:00:00Z")
    assert _gitlab_job_elapsed_seconds(
        now=datetime(2026, 7, 30, 10, 5, tzinfo=UTC)
    ) == 300.0


def test_soft_deadline_forces_harbor_after_checkpoint_drain_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _checkpoint_main_env(
        tmp_path,
        monkeypatch,
        BENCH_CHECKPOINT_SHUTDOWN_GRACE_SECONDS="0",
    )
    events: list[str] = []

    state = {"terminated": False}

    def poll_status() -> int | None:
        return -15 if state["terminated"] else None

    def record_signal(signum: int) -> None:
        assert signum == signal.SIGINT
        events.append("interrupt")

    def terminate() -> None:
        events.append("terminate")
        state["terminated"] = True

    proc = _FakeHarborProcess(
        poll=poll_status,
        wait_status=-15,
        on_signal=record_signal,
        on_terminate=terminate,
        on_kill=lambda: pytest.fail("SIGTERM should stop Harbor in this scenario"),
    )
    with patch("chunk_runner.run_harbor", return_value=proc), \
         patch("chunk_runner._restore_prior_artifact", return_value=False), \
         patch("chunk_runner._restore_gcs_checkpoints"), \
         patch("chunk_runner._checkpoint_plugin_args", return_value=None), \
         patch("chunk_runner._persist_checkpoint_run_metadata"), \
         patch("chunk_runner._register_durable_chunk_attempt", return_value=1), \
         patch("chunk_runner.checkpoint_soft_deadline_seconds", return_value=0.05), \
         patch("chunk_runner._HEARTBEAT_INTERVAL", 0.01):
        assert main() == 1

    assert events == ["interrupt", "terminate"]


def test_soft_deadline_is_not_evaluated_when_checkpointing_is_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Disabled checkpointing leaves Harbor governed by GitLab's job timeout."""
    _main_env(
        tmp_path,
        monkeypatch,
        BENCH_TRIAL_CHECKPOINTS="false",
        # When checkpointing is disabled the soft deadline is infinity and
        # checkpoint_soft_deadline_seconds() is never called, so an invalid
        # job timeout must not raise.
        BENCH_JOB_TIMEOUT_SECONDS="not-a-number",
    )

    def fake_run_harbor(*, cmd, cwd, env):
        # Write a passing result so the chunk completes.
        results_dir = Path(env["BENCHMARK_RESULTS_DIR"])
        run_dir = results_dir / "run-1"
        trial = run_dir / "task-a__1"
        trial.mkdir(parents=True, exist_ok=True)
        (trial / "result.json").write_text(json.dumps(
            {"verifier_result": {"rewards": {"reward": 1.0}}}
        ))
        return _FakeHarborProcess(poll=lambda: 0, wait_status=0)

    with patch("chunk_runner.run_harbor", side_effect=fake_run_harbor), \
         patch("chunk_runner._restore_prior_artifact", return_value=False), \
         patch("chunk_runner._restore_gcs_checkpoints"), \
         patch("chunk_runner._checkpoint_plugin_args", return_value=None):
        exit_code = main()
    assert exit_code == 0


def test_chunk_fails_on_frozen_budget_mismatch_before_harbor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A changed job-local budget against the frozen run metadata is
    identity corruption and fails the chunk before any Harbor launch."""
    monkeypatch.chdir(tmp_path)
    benchmark_meta = tmp_path / ".benchmark" / "run-metadata.json"
    benchmark_meta.parent.mkdir(parents=True)
    benchmark_meta.write_text(json.dumps({
        "parameters": {"chunk_attempt_budget": 8},
    }))
    _main_env(
        tmp_path,
        monkeypatch,
        BENCH_CHUNK_ATTEMPT_BUDGET="5",
    )

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._run_harbor_invocation",
        side_effect=AssertionError("budget mismatch must fail before Harbor"),
    ):
        assert main() == 1


def test_chunk_restores_durable_budget_when_local_metadata_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A pod can die before publishing its GitLab artifact. The next job must
    adopt the budget already frozen in GCS rather than reapplying the default.
    """
    monkeypatch.chdir(tmp_path)
    _checkpoint_main_env(tmp_path, monkeypatch, BENCH_JOB_TIMEOUT_SECONDS="999999")
    monkeypatch.delenv("BENCH_CHUNK_ATTEMPT_BUDGET", raising=False)
    durable_metadata = json.dumps(
        {"parameters": {"chunk_attempt_budget": 5}}
    ).encode()
    results_dir = tmp_path / "jobs"

    def complete_trial(**kwargs):
        del kwargs
        _make_trial(results_dir / "run-1" / "task-a__pass", task_name="task-a")
        return 0, None

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._restore_gcs_checkpoints"
    ), patch(
        "chunk_runner.ckpt.gcs_download_object", return_value=durable_metadata
    ), patch(
        "chunk_runner.ckpt.gcs_upload_bytes"
    ), patch(
        "chunk_runner._register_durable_chunk_attempt", return_value=1
    ), patch(
        "chunk_runner._checkpoint_plugin_args", return_value=None
    ), patch(
        "chunk_runner._run_harbor_invocation", side_effect=complete_trial
    ):
        assert main() == 0

    metadata = json.loads(
        (tmp_path / ".benchmark" / "run-metadata.json").read_text()
    )
    assert metadata["parameters"]["chunk_attempt_budget"] == 5
    status = json.loads(
        (results_dir / "chunk-meta" / "chunk-0.json").read_text()
    )
    assert status["chunk_attempt_budget"] == 5


def test_chunk_fails_before_attempt_registration_when_durable_metadata_read_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A storage outage cannot be treated as proof that no frozen identity exists."""
    monkeypatch.chdir(tmp_path)
    _checkpoint_main_env(tmp_path, monkeypatch)

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._restore_gcs_checkpoints"
    ), patch(
        "chunk_runner.ckpt.gcs_download_object",
        side_effect=ckpt.CheckpointRestoreError("temporary GCS failure"),
    ), patch(
        "chunk_runner._register_durable_chunk_attempt"
    ) as register_attempt, patch(
        "chunk_runner._run_harbor_invocation",
        side_effect=AssertionError("metadata failure must stop before Harbor"),
    ):
        assert main() == 1

    register_attempt.assert_not_called()


def test_confirmed_daemon_loss_interrupts_harbor_after_checkpoint_drain(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Persistent health loss stops the round and preserves completed work."""
    _checkpoint_main_env(
        tmp_path,
        monkeypatch,
        DOCKER_HOST="tcp://docker:2375",
        BENCH_DOCKER_HEALTH_CONFIRM_FAILURES="2",
        BENCH_DOCKER_HEALTH_POLL_SECONDS="0.01",
        BENCH_JOB_TIMEOUT_SECONDS="999999",
        BENCH_CHUNK_ATTEMPT_BUDGET="3",
        SELECTED_TASKS_JSON='["task-a", "task-b"]',
    )
    events: list[str] = []
    results_dir = tmp_path / "jobs"
    durable_objects: dict[str, bytes] = {}
    trial_prefix: str | None = None

    def list_checkpoint_objects(
        bucket: str,
        prefix: str,
        **kwargs,
    ) -> list[str]:
        nonlocal trial_prefix
        del bucket, kwargs
        if prefix.endswith("/trials/"):
            trial_prefix = prefix
        return sorted(name for name in durable_objects if name.startswith(prefix))

    def download_checkpoint_object(
        bucket: str,
        object_name: str,
        **kwargs,
    ) -> bytes | None:
        del bucket, kwargs
        return durable_objects.get(object_name)

    state = {"interrupted": False}

    def poll_status() -> int | None:
        return 130 if state["interrupted"] else None

    def interrupt_harbor(signum: int) -> None:
        assert signum == signal.SIGINT
        events.append("interrupt")
        completed = results_dir / "run-1" / "task-a__completed"
        _make_trial(completed, task_name="task-a")
        assert trial_prefix is not None
        archive, _ = ckpt.create_trial_archive(
            completed,
            task_name="task-a",
            chunk_index=0,
        )
        durable_objects[f"{trial_prefix}task-a__completed.tar.gz"] = archive
        state["interrupted"] = True

    def reject_forced_stop() -> None:
        pytest.fail("Harbor should finish inside the checkpoint drain grace period")

    proc = _FakeHarborProcess(
        poll=poll_status,
        wait_status=130,
        on_signal=interrupt_harbor,
        on_terminate=reject_forced_stop,
        on_kill=reject_forced_stop,
    )

    health = iter([(True, ""), (False, "daemon unavailable"), (False, "daemon unavailable")])
    with patch("chunk_runner.run_harbor", return_value=proc), patch(
        "chunk_runner._probe_docker_daemon", side_effect=health
    ), patch(
        "chunk_runner._restore_prior_artifact", return_value=False
    ), patch(
        "checkpoint.gcs_list_objects", side_effect=list_checkpoint_objects
    ), patch(
        "checkpoint.gcs_download_object", side_effect=download_checkpoint_object
    ), patch(
        "chunk_runner._checkpoint_plugin_args", return_value=None
    ), patch(
        "chunk_runner._persist_checkpoint_run_metadata"
    ), patch(
        "chunk_runner._register_durable_chunk_attempt", return_value=1
    ), patch(
        "chunk_runner._persist_chunk_status"
    ):
        assert main() == 1

    assert events == ["interrupt"]
    assert durable_objects
    assert not (results_dir / "run-1" / "task-a__queued").exists()
    meta = json.loads((results_dir / "chunk-meta" / "chunk-0.json").read_text())
    assert meta["stop_reason"] == "docker_daemon_unreachable"
    assert meta["needs_retry"] == ["task-b"]
    marker = json.loads(
        (results_dir / "docker-health" / "chunk-0-daemon-loss.json").read_text()
    )
    assert marker["reason"] == "daemon unavailable"

    shutil.rmtree(results_dir / "run-1")
    monkeypatch.delenv("DOCKER_HOST")
    scheduled: list[list[str]] = []

    def complete_missing_task(**kwargs):
        scheduled.append(kwargs["tasks"])
        completed = results_dir / "run-2" / "task-b__completed"
        completed.mkdir(parents=True)
        (completed / "result.json").write_text(json.dumps({
            "task_name": "task-b",
            "verifier_result": {"rewards": {"reward": 1.0}},
        }))
        return 0, None

    with patch("chunk_runner._run_harbor_invocation", side_effect=complete_missing_task), patch(
        "chunk_runner._restore_prior_artifact", return_value=False
    ), patch(
        "checkpoint.gcs_list_objects", side_effect=list_checkpoint_objects
    ), patch(
        "checkpoint.gcs_download_object", side_effect=download_checkpoint_object
    ), patch(
        "chunk_runner._checkpoint_plugin_args", return_value=None
    ), patch(
        "chunk_runner._persist_checkpoint_run_metadata"
    ), patch(
        "chunk_runner._register_durable_chunk_attempt", return_value=2
    ), patch(
        "chunk_runner._persist_chunk_status"
    ):
        assert main() == 0

    assert scheduled == [["task-b"]]
    assert (
        results_dir
        / ckpt.CHECKPOINT_RESTORE_DIR
        / "task-a__completed"
        / "result.json"
    ).is_file()
    final_meta = json.loads(
        (results_dir / "chunk-meta" / "chunk-0.json").read_text()
    )
    assert final_meta["stop_reason"] == "docker_daemon_unreachable"


def test_transient_daemon_probe_failure_does_not_interrupt_harbor(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One failed health check below the confirmation threshold is tolerated."""
    _main_env(
        tmp_path,
        monkeypatch,
        DOCKER_HOST="tcp://docker:2375",
        BENCH_DOCKER_HEALTH_CONFIRM_FAILURES="2",
        BENCH_DOCKER_HEALTH_POLL_SECONDS="0.01",
    )
    results_dir = tmp_path / "jobs"

    state = {"polls": 0}

    def poll_status() -> int | None:
        state["polls"] += 1
        return 0 if state["polls"] >= 4 else None

    def fake_harbor(**kwargs):
        trial = results_dir / "run-1" / "task-a__pass"
        trial.mkdir(parents=True)
        (trial / "result.json").write_text(json.dumps({
            "task_name": "task-a",
            "verifier_result": {"rewards": {"reward": 1.0}},
        }))
        return _FakeHarborProcess(poll=poll_status, wait_status=0)

    with patch("chunk_runner.run_harbor", side_effect=fake_harbor), patch(
        "chunk_runner._probe_docker_daemon",
        side_effect=[(False, "transient"), (True, "")],
    ), patch("chunk_runner._restore_prior_artifact", return_value=False):
        assert main() == 0

    assert not (results_dir / "docker-health" / "chunk-0-daemon-loss.json").exists()


def test_swe_bench_pro_rejects_checkpointing_before_starting_work(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _checkpoint_main_env(
        tmp_path,
        monkeypatch,
        BENCHMARK_NAME="swe-bench-pro",
        DATASET="swebenchpro",
    )

    with patch("chunk_runner._restore_prior_artifact") as restore, patch(
        "chunk_runner.run_harbor"
    ) as run_harbor:
        assert main() == 1

    assert "not supported" in capsys.readouterr().err
    restore.assert_not_called()
    run_harbor.assert_not_called()


# ---------------------------------------------------------------------------
# Phase 5: durable attempt-budget semantics
# ---------------------------------------------------------------------------

def test_attempt_budget_boundary() -> None:
    """Ordinals 1..budget are work-bearing; budget is the final launch; ordinals above it reconcile only."""
    assert _may_launch_work(1, 3) is True
    assert _may_launch_work(3, 3) is True
    assert _may_launch_work(4, 3) is False
    assert _is_final_work_attempt(2, 3) is False
    assert _is_final_work_attempt(3, 3) is True
    assert _is_final_work_attempt(4, 3) is False


def test_final_gitlab_attempt_still_runs_before_retryables_are_exhausted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The final work-bearing attempt (budget reached) still runs Harbor."""
    monkeypatch.chdir(tmp_path)
    _main_env(
        tmp_path,
        monkeypatch,
        BENCH_CHUNK_ATTEMPT_BUDGET="3",
        BENCH_JOB_TIMEOUT_SECONDS="999999",
    )
    results_dir = tmp_path / "jobs"
    retryable = results_dir / "run-previous" / "task-a__infra"
    retryable.mkdir(parents=True)
    (retryable / "result.json").write_text(json.dumps({
        "task_name": "task-a",
        "exception_info": {
            "exception_type": "ConnectionError",
            "exception_message": "connection reset by peer",
            "exception_traceback": "",
            "occurred_at": "2026-01-01T00:00:00Z",
        },
    }))
    chunk_meta = results_dir / "chunk-meta" / "chunk-0.json"
    chunk_meta.parent.mkdir(parents=True)
    chunk_meta.write_text(json.dumps({"chunk_attempt": 2}))

    invocations: list[list[str]] = []

    def fake_invocation(**kwargs):
        invocations.append(kwargs["tasks"])
        completed = results_dir / "run-final" / "task-a__pass"
        completed.mkdir(parents=True)
        (completed / "result.json").write_text(json.dumps({
            "task_name": "task-a",
            "verifier_result": {"rewards": {"reward": 1.0}},
        }))
        return 0, None

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._run_harbor_invocation",
        side_effect=fake_invocation,
    ):
        assert main() == 0

    assert invocations == [["task-a"]]


def test_final_attempt_records_tasks_completed_only_by_retry_exhaustion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    _main_env(
        tmp_path,
        monkeypatch,
        BENCH_CHUNK_ATTEMPT_BUDGET="3",
        BENCH_JOB_TIMEOUT_SECONDS="999999",
    )
    results_dir = tmp_path / "jobs"
    chunk_meta = results_dir / "chunk-meta" / "chunk-0.json"
    chunk_meta.parent.mkdir(parents=True)
    chunk_meta.write_text(json.dumps({"chunk_attempt": 2}))

    def retryable_invocation(**kwargs):
        del kwargs
        trial = results_dir / "run-final" / "task-a__infra"
        trial.mkdir(parents=True)
        (trial / "result.json").write_text(json.dumps({
            "task_name": "task-a",
            "verifier_result": None,
            "exception_info": {
                "exception_type": "ConnectionError",
                "exception_message": "connection reset by peer",
                "exception_traceback": "",
                "occurred_at": "2026-01-01T00:00:00Z",
            },
        }))
        return 0, None

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._run_harbor_invocation",
        side_effect=retryable_invocation,
    ):
        assert main() == 0

    status = json.loads(chunk_meta.read_text())
    assert status["needs_retry"] == ["task-a"]
    assert status["exhausted"] is True

    out = capsys.readouterr().out
    assert (
        "[chunk-0] all 1 trial slots filled on the final attempt; "
        "1 tasks completed only via retry-exhaustion: ['task-a']" in out
    )
    assert "trials complete" not in out


def test_final_attempt_records_confirmed_daemon_loss_as_exhausted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    _main_env(
        tmp_path,
        monkeypatch,
        BENCH_CHUNK_ATTEMPT_BUDGET="1",
        BENCH_JOB_TIMEOUT_SECONDS="999999",
    )
    results_dir = tmp_path / "jobs"

    def daemon_loss_invocation(**kwargs):
        del kwargs
        marker = results_dir / "docker-health" / "chunk-0-daemon-loss.json"
        marker.parent.mkdir(parents=True)
        marker.write_text(json.dumps({"reason": "daemon unavailable"}))
        return 130, signal.SIGINT

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._run_harbor_invocation",
        side_effect=daemon_loss_invocation,
    ):
        assert main() == 0

    status = json.loads(
        (results_dir / "chunk-meta" / "chunk-0.json").read_text()
    )
    assert status["needs_retry"] == ["task-a"]
    assert status["exhausted"] is True
    assert status["stop_reason"] == "docker_daemon_unreachable"


def test_final_attempt_harbor_failure_exhausts_incomplete_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """After the final work-bearing attempt, a Harbor failure also
    terminalizes remaining work: exhausted status, exit 0 so the summary
    publishes the bounded partial result."""
    monkeypatch.chdir(tmp_path)
    _main_env(
        tmp_path,
        monkeypatch,
        BENCH_CHUNK_ATTEMPT_BUDGET="1",
        BENCH_JOB_TIMEOUT_SECONDS="999999",
    )
    results_dir = tmp_path / "jobs"

    def failing_invocation(**kwargs):
        del kwargs
        return 1, None  # Harbor failed; no trials produced, no daemon loss

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._run_harbor_invocation",
        side_effect=failing_invocation,
    ):
        assert main() == 0

    status = json.loads(
        (results_dir / "chunk-meta" / "chunk-0.json").read_text()
    )
    assert status["needs_retry"] == ["task-a"]
    assert status["exhausted"] is True
    assert status["exit_code"] == 0


def test_durable_attempt_four_still_launches_harbor_with_budget_eight(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression for the durable-attempt-4 coupling: with the decoupled
    budget, attempt 4 invokes Harbor because it is BELOW the new durable
    boundary, not because above-budget attempts may spend."""
    monkeypatch.chdir(tmp_path)
    _main_env(
        tmp_path,
        monkeypatch,
        BENCH_CHUNK_ATTEMPT_BUDGET="8",
        BENCH_JOB_TIMEOUT_SECONDS="999999",
    )
    results_dir = tmp_path / "jobs"
    chunk_meta = results_dir / "chunk-meta" / "chunk-0.json"
    chunk_meta.parent.mkdir(parents=True)
    chunk_meta.write_text(json.dumps({"chunk_attempt": 3}))

    invocations: list[list[str]] = []

    def fake_invocation(**kwargs):
        invocations.append(kwargs["tasks"])
        completed = results_dir / "run-final" / "task-a__pass"
        completed.mkdir(parents=True)
        (completed / "result.json").write_text(json.dumps({
            "task_name": "task-a",
            "verifier_result": {"rewards": {"reward": 1.0}},
        }))
        return 0, None

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._run_harbor_invocation",
        side_effect=fake_invocation,
    ):
        assert main() == 0

    assert invocations == [["task-a"]]
    status = json.loads(chunk_meta.read_text())
    assert status["chunk_attempt"] == 4
    assert status["exhausted"] is False


def test_above_budget_attempt_never_launches_harbor_and_exhausts_incomplete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An above-budget startup with incomplete restored work writes an
    exhausted status and exits 0 WITHOUT model spend (real token fuse)."""
    monkeypatch.chdir(tmp_path)
    _main_env(
        tmp_path,
        monkeypatch,
        BENCH_CHUNK_ATTEMPT_BUDGET="3",
        BENCH_JOB_TIMEOUT_SECONDS="999999",
    )
    results_dir = tmp_path / "jobs"
    chunk_meta = results_dir / "chunk-meta" / "chunk-0.json"
    chunk_meta.parent.mkdir(parents=True)
    chunk_meta.write_text(json.dumps({"chunk_attempt": 3}))
    # An incomplete (retryable) trial remains from a prior attempt.
    retryable = results_dir / "run-previous" / "task-a__infra"
    retryable.mkdir(parents=True)
    (retryable / "result.json").write_text(json.dumps({
        "task_name": "task-a",
        "exception_info": {
            "exception_type": "ConnectionError",
            "exception_message": "connection reset by peer",
            "exception_traceback": "",
            "occurred_at": "2026-01-01T00:00:00Z",
        },
    }))

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._run_harbor_invocation",
        side_effect=AssertionError("above-budget attempt must not launch Harbor"),
    ):
        assert main() == 0

    status = json.loads(chunk_meta.read_text())
    assert status["chunk_attempt"] == 4
    assert status["exhausted"] is True
    assert status["needs_retry"] == ["task-a"]


def test_above_budget_attempt_succeeds_when_restored_work_is_complete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Completion is checked before the budget guard: a complete chunk exits
    0 even at an ordinal above the budget."""
    monkeypatch.chdir(tmp_path)
    _main_env(
        tmp_path,
        monkeypatch,
        BENCH_CHUNK_ATTEMPT_BUDGET="3",
        BENCH_JOB_TIMEOUT_SECONDS="999999",
    )
    results_dir = tmp_path / "jobs"
    chunk_meta = results_dir / "chunk-meta" / "chunk-0.json"
    chunk_meta.parent.mkdir(parents=True)
    chunk_meta.write_text(json.dumps({"chunk_attempt": 3}))
    _make_trial(results_dir / "run-previous" / "task-a__pass", task_name="task-a")

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._run_harbor_invocation",
        side_effect=AssertionError("above-budget attempt must not launch Harbor"),
    ):
        assert main() == 0

    status = json.loads(chunk_meta.read_text())
    assert status["exhausted"] is False
    assert status["needs_retry"] == []


def test_final_attempt_soft_deadline_still_exhausts_incomplete_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """After the final work-bearing attempt, a soft-deadline stop writes an
    exhausted status and exits 0 so the summary can publish partial results."""
    monkeypatch.chdir(tmp_path)
    _main_env(
        tmp_path,
        monkeypatch,
        BENCH_CHUNK_ATTEMPT_BUDGET="1",
        BENCH_ATTEMPTS="2",  # two k=1 rounds so the deadline branch fires
        # Soft deadline: int(2 * 0.96) = 1s window; restore is instant, the
        # Harbor invocation blocks past it, and round 2 observes the deadline.
        BENCH_JOB_TIMEOUT_SECONDS="2",
        CI_JOB_STARTED_AT="2020-01-01T00:00:00Z",
    )
    results_dir = tmp_path / "jobs"

    import time

    def blocked_invocation(**kwargs):
        time.sleep(2)  # past the 1s soft deadline
        return 0, None

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._run_harbor_invocation",
        side_effect=blocked_invocation,
    ):
        assert main() == 0

    status = json.loads(
        (results_dir / "chunk-meta" / "chunk-0.json").read_text()
    )
    assert status["exhausted"] is True
    assert status["needs_retry"] == ["task-a"]
    assert status["chunk_attempt_budget"] == 1


def test_run_metadata_freezes_chunk_attempt_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Run creation records the resolved budget in durable run metadata, and
    the chunk status carries the same frozen value."""
    monkeypatch.chdir(tmp_path)
    _main_env(
        tmp_path,
        monkeypatch,
        BENCH_CHUNK_ATTEMPT_BUDGET="8",
    )
    results_dir = tmp_path / "jobs"

    def fake_invocation(**kwargs):
        completed = results_dir / "run-1" / "task-a__pass"
        completed.mkdir(parents=True)
        (completed / "result.json").write_text(json.dumps({
            "task_name": "task-a",
            "verifier_result": {"rewards": {"reward": 1.0}},
        }))
        return 0, None

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._run_harbor_invocation",
        side_effect=fake_invocation,
    ):
        assert main() == 0

    metadata = json.loads(
        (tmp_path / ".benchmark" / "run-metadata.json").read_text()
    )
    assert metadata["parameters"]["chunk_attempt_budget"] == 8
    status = json.loads(
        (results_dir / "chunk-meta" / "chunk-0.json").read_text()
    )
    assert status["chunk_attempt_budget"] == 8


def test_checkpoint_failure_keeps_chunk_failed_when_local_trial_is_complete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed Harbor/plugin process must not be masked by its local result."""
    monkeypatch.chdir(tmp_path)
    _main_env(
        tmp_path,
        monkeypatch,
        BENCH_TRIAL_CHECKPOINTS="true",
        BENCH_CHECKPOINT_BUCKET="ckpt-bucket",
        BENCH_JOB_TIMEOUT_SECONDS="999999",
        CI_PROJECT_ID="1",
        CI_JOB_ID="200",
    )
    results_dir = tmp_path / "jobs"

    def failed_checkpoint_invocation(**kwargs):
        completed = results_dir / "run-failed-checkpoint" / "task-a__pass"
        completed.mkdir(parents=True)
        (completed / "result.json").write_text(json.dumps({
            "task_name": "task-a",
            "verifier_result": {"rewards": {"reward": 1.0}},
        }))
        return 1, None

    with patch("chunk_runner._restore_prior_artifact", return_value=False), patch(
        "chunk_runner._restore_gcs_checkpoints"
    ), patch(
        "chunk_runner._persist_checkpoint_run_metadata"
    ), patch(
        "chunk_runner._register_durable_chunk_attempt", return_value=1
    ), patch(
        "chunk_runner._persist_chunk_status"
    ), patch(
        "chunk_runner._run_harbor_invocation",
        side_effect=failed_checkpoint_invocation,
    ):
        assert main() == 1


def test_checkpoint_run_prefix_is_scoped_by_project_without_changing_public_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CI_PROJECT_ID", "42")
    assert _build_checkpoint_run_prefix(_RUN_PREFIX) == (
        f"{_RUN_PREFIX}/checkpoint-project=42"
    )


def test_durable_chunk_attempt_does_not_depend_on_gitlab_artifact(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BENCH_TRIAL_CHECKPOINTS", "true")
    monkeypatch.setenv("BENCH_CHECKPOINT_BUCKET", "ckpt-bucket")
    monkeypatch.setenv("CI_JOB_ID", "201")

    with patch("chunk_runner.ckpt.register_chunk_attempt", return_value=3) as register:
        assert _register_durable_chunk_attempt(
            run_prefix=_RUN_PREFIX,
            chunk_index=0,
        ) == 3

    register.assert_called_once_with(
        bucket="ckpt-bucket",
        run_prefix=_RUN_PREFIX,
        chunk_index=0,
        job_id="201",
        retries=CHECKPOINT_UPLOAD_RETRIES,
    )


def test_persist_chunk_status_uploads_job_scoped_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BENCH_TRIAL_CHECKPOINTS", "true")
    monkeypatch.setenv("BENCH_CHECKPOINT_BUCKET", "ckpt-bucket")
    monkeypatch.setenv("CI_JOB_ID", "321")
    meta_path = tmp_path / "chunk-0.json"
    meta_path.write_text(
        json.dumps(
            {
                "chunk_index": 0,
                "chunk_attempt": 2,
                "exit_code": 0,
                "needs_retry": [],
                "exhausted": False,
            }
        )
    )

    with patch("chunk_runner.ckpt.gcs_upload_bytes") as upload:
        _persist_chunk_status(
            meta_path=meta_path,
            run_prefix=_RUN_PREFIX,
            chunk_index=0,
        )

    upload.assert_called_once_with(
        "ckpt-bucket",
        ckpt.chunk_status_object_name(_RUN_PREFIX, 0, "321"),
        meta_path.read_bytes(),
        content_type="application/json",
        retries=CHECKPOINT_UPLOAD_RETRIES,
    )


def test_finalize_chunk_fails_when_status_cannot_be_persisted(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with patch(
        "chunk_runner._persist_chunk_status",
        side_effect=ckpt.CheckpointUploadError("storage unavailable"),
    ):
        exit_code = _finalize_chunk(
            results_dir=tmp_path,
            chunk_index=2,
            chunk_attempt=3,
            chunk_attempt_budget=8,
            exit_code=0,
            needs_retry=[],
            run_prefix=_RUN_PREFIX,
        )

    assert exit_code == 1
    assert (tmp_path / "chunk-meta" / "chunk-2.json").is_file()
    assert "failed to persist chunk status: storage unavailable" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Phase 3: checkpoint plugin args wiring
# ---------------------------------------------------------------------------

def test_checkpoint_plugin_args_built_when_enabled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BENCH_TRIAL_CHECKPOINTS", "true")
    monkeypatch.setenv("BENCH_CHECKPOINT_BUCKET", "ckpt-bucket")
    args = _checkpoint_plugin_args(chunk_index=3, run_prefix=_RUN_PREFIX, bench_dir=tmp_path)
    assert args is not None
    assert args.bucket == "ckpt-bucket"
    assert args.chunk_index == 3
    assert args.run_prefix == _RUN_PREFIX
    assert args.upload_retries == CHECKPOINT_UPLOAD_RETRIES


def test_checkpoint_plugin_args_none_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BENCH_TRIAL_CHECKPOINTS", "false")
    assert _checkpoint_plugin_args(chunk_index=0, run_prefix=_RUN_PREFIX, bench_dir=Path(".")) is None


def test_checkpoint_plugin_args_none_without_bucket(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BENCH_TRIAL_CHECKPOINTS", "true")
    monkeypatch.delenv("BENCH_CHECKPOINT_BUCKET", raising=False)
    assert _checkpoint_plugin_args(chunk_index=0, run_prefix=_RUN_PREFIX, bench_dir=Path(".")) is None


def test_persist_checkpoint_run_metadata_is_deterministic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    metadata_path = tmp_path / "run-metadata.json"
    metadata_path.write_text(json.dumps({
        "gcs": {"prefix": _RUN_PREFIX},
        "gitlab": {
            "project_id": "7",
            "pipeline_id": "100",
            "job_id": "200",
            "job_url": "https://gitlab.example/jobs/200",
        },
    }))
    monkeypatch.setenv("BENCH_TRIAL_CHECKPOINTS", "true")
    monkeypatch.setenv("BENCH_CHECKPOINT_BUCKET", "ckpt-bucket")

    with patch("chunk_runner.ckpt.gcs_upload_bytes") as upload, patch(
        "chunk_runner.ckpt.gcs_download_object", return_value=None
    ):
        _persist_checkpoint_run_metadata(metadata_path, _RUN_PREFIX)

    assert [call.args[1] for call in upload.call_args_list] == [
        ckpt.run_metadata_object_name(_RUN_PREFIX),
        ckpt.run_metadata_lookup_object_name("7", "100"),
    ]
    local_metadata = json.loads(metadata_path.read_text())
    assert local_metadata["gcs"]["checkpoint_prefix"] == _RUN_PREFIX
    assert local_metadata["gitlab"]["job_id"] == "200"
    for call in upload.call_args_list:
        durable = json.loads(call.args[2])
        assert durable["gcs"]["checkpoint_prefix"] == _RUN_PREFIX
        assert durable["gitlab"]["job_id"] == ""
        assert durable["gitlab"]["job_url"] == ""


def test_persist_checkpoint_run_metadata_rejects_budget_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An existing durable copy with a different frozen budget fails loudly."""
    metadata_path = tmp_path / "run-metadata.json"
    metadata = {
        "parameters": {"chunk_attempt_budget": 8},
        "gcs": {"prefix": _RUN_PREFIX},
        "gitlab": {
            "project_id": "7",
            "pipeline_id": "100",
            "job_id": "200",
            "job_url": "https://gitlab.example/jobs/200",
        },
    }
    metadata_path.write_text(json.dumps(metadata))
    monkeypatch.setenv("BENCH_TRIAL_CHECKPOINTS", "true")
    monkeypatch.setenv("BENCH_CHECKPOINT_BUCKET", "ckpt-bucket")

    existing = {**metadata, "parameters": {"chunk_attempt_budget": 3}}
    with patch("chunk_runner.ckpt.gcs_upload_bytes"), patch(
        "chunk_runner.ckpt.gcs_download_object",
        return_value=json.dumps(existing).encode(),
    ), pytest.raises(ValueError, match="chunk attempt budget"):
        _persist_checkpoint_run_metadata(metadata_path, _RUN_PREFIX)


def test_persist_checkpoint_run_metadata_accepts_matching_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Concurrent compare-or-create: identical frozen budget races harmlessly."""
    metadata_path = tmp_path / "run-metadata.json"
    metadata = {
        "parameters": {"chunk_attempt_budget": 8},
        "gcs": {"prefix": _RUN_PREFIX},
        "gitlab": {
            "project_id": "7",
            "pipeline_id": "100",
            "job_id": "200",
            "job_url": "https://gitlab.example/jobs/200",
        },
    }
    metadata_path.write_text(json.dumps(metadata))
    monkeypatch.setenv("BENCH_TRIAL_CHECKPOINTS", "true")
    monkeypatch.setenv("BENCH_CHECKPOINT_BUCKET", "ckpt-bucket")

    with patch("chunk_runner.ckpt.gcs_upload_bytes"), patch(
        "chunk_runner.ckpt.gcs_download_object",
        return_value=json.dumps(metadata).encode(),
    ):
        _persist_checkpoint_run_metadata(metadata_path, _RUN_PREFIX)


# ---------------------------------------------------------------------------
# Phase 1 acceptance: no secret in checkpoint storage (end-to-end via main path)
# ---------------------------------------------------------------------------

def test_no_secret_in_uploaded_checkpoint_archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The checkpoint archive produced for upload must never contain KIMCHI_API_KEY."""
    secret = "sk-top-secret-xyz"
    monkeypatch.setenv("KIMCHI_API_KEY", secret)
    trial = tmp_path / "trial" / "task-a__1"
    _make_trial(trial, task_name="task-a")
    # Embed the secret in an agent log file.
    (trial / "agent").mkdir(exist_ok=True)
    (trial / "agent" / "kimchi.txt").write_text(f"key={secret}\n")
    archive, _ = ckpt.create_trial_archive(trial, task_name="task-a", chunk_index=0)
    assert secret.encode() not in archive
