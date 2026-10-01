"""Contracts relied on when the benchmark runner interrupts Harbor."""

from __future__ import annotations

import asyncio
import json
import signal
import subprocess
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from harbor.cli.utils import run_async
from harbor.models.job.lock import TrialLock
from harbor.models.task.id import LocalTaskId
from harbor.models.trial.config import TaskConfig, TrialConfig
from harbor.models.trial.result import AgentInfo, TrialResult
from harbor.models.verifier.result import VerifierResult
from harbor.trial.hooks import TrialEvent, TrialHookEvent
from harbor.trial.queue import TrialQueue
from harbor.trial.trial import Trial


class _CancellationContractTrial:
    """Minimal workload that exercises Harbor's real ``Trial.run`` lifecycle."""

    run = Trial.run
    add_hook = Trial.add_hook
    _emit = Trial._emit
    _finalize = Trial._finalize
    _record_exception = Trial._record_exception

    def __init__(
        self,
        config: TrialConfig,
        *,
        active: asyncio.Event,
        release: asyncio.Event,
        lifecycle: list[str],
        score_before_cancel: bool,
    ) -> None:
        self.config = config
        self.task = SimpleNamespace(name=config.task.get_task_id().get_name())
        self.paths = SimpleNamespace(
            trial_dir=config.trials_dir / config.trial_name,
            config_path=config.trials_dir / config.trial_name / "config.json",
            exception_message_path=config.trials_dir
            / config.trial_name
            / "exception.txt",
            result_path=config.trials_dir / config.trial_name / "result.json",
        )
        self.paths.trial_dir.mkdir(parents=True)
        self._trial_lock = TrialLock.model_construct()
        self._hooks: dict[
            TrialEvent, list[Callable[[TrialHookEvent], Awaitable[None]]]
        ] = {event: [] for event in TrialEvent}
        self._active = active
        self._release = release
        self._lifecycle = lifecycle
        self._score_before_cancel = score_before_cancel
        self._result: TrialResult | None = None
        self.logger = SimpleNamespace(debug=lambda *args, **kwargs: None)

    @property
    def result(self) -> TrialResult:
        if self._result is None:
            raise RuntimeError("Trial result accessed before initialization")
        return self._result

    @staticmethod
    def _now() -> datetime:
        return datetime.now(UTC)

    def _init_result(self) -> None:
        self.paths.config_path.write_text("{}")
        self._result = TrialResult(
            task_name=self.task.name,
            trial_name=self.config.trial_name,
            trial_uri=self.paths.trial_dir.resolve().as_uri(),
            task_id=LocalTaskId(path=Path(self.task.name)),
            task_checksum="contract-test",
            config=self.config,
            agent_info=AgentInfo(name="contract-test", version="1"),
            started_at=self._now(),
        )

    async def _prepare(self) -> None:
        if self._score_before_cancel:
            return
        self._active.set()
        await self._release.wait()

    async def _run(self) -> None:
        if not self._score_before_cancel:
            raise AssertionError("the contract trial must be cancelled while active")
        self.result.verifier_result = VerifierResult(rewards={"reward": 1.0})
        self._active.set()
        await self._release.wait()

    async def _recover_outputs(self) -> None:
        await asyncio.sleep(0)
        self._lifecycle.append("checkpoint")

    async def _stop_agent_environment(self) -> None:
        await asyncio.sleep(0)
        self._lifecycle.append("finalize")

    def _close_logger_handler(self) -> None:
        pass


@dataclass
class _QueueContractHarness:
    active: asyncio.Event
    lifecycle: list[str]
    created: list[str]
    checkpoint_results: list[dict]
    run_batch: Callable[[], Awaitable[None]]


def _build_queue_contract_harness(
    probe_dir: Path,
    install_trial_factory: Callable[
        [Callable[[type[Trial], TrialConfig], Awaitable[_CancellationContractTrial]]],
        None,
    ],
    *,
    score_before_cancel: bool = False,
) -> _QueueContractHarness:
    active = asyncio.Event()
    release = asyncio.Event()
    lifecycle: list[str] = []
    created: list[str] = []
    checkpoint_results: list[dict] = []

    async def create_trial(
        _trial_type: type[Trial], config: TrialConfig
    ) -> _CancellationContractTrial:
        created.append(config.trial_name)
        return _CancellationContractTrial(
            config,
            active=active,
            release=release,
            lifecycle=lifecycle,
            score_before_cancel=score_before_cancel,
        )

    install_trial_factory(create_trial)

    async def record_start(event: TrialHookEvent) -> None:
        lifecycle.append(f"start:{event.trial_name}")

    async def record_cancel(event: TrialHookEvent) -> None:
        lifecycle.append(f"cancel:{event.trial_name}")

    async def checkpoint_on_end(event: TrialHookEvent) -> None:
        await asyncio.sleep(0)
        result = json.loads(
            (probe_dir / "trials" / event.trial_name / "result.json").read_text()
        )
        checkpoint_results.append(result)
        exception_type = result["exception_info"]["exception_type"]
        lifecycle.append(f"end:{event.trial_name}:{exception_type}")

    queue = TrialQueue(n_concurrent=1)
    queue.on_trial_started(record_start)
    queue.on_trial_cancelled(record_cancel)
    queue.on_trial_ended(checkpoint_on_end)
    configs = [
        TrialConfig(
            task=TaskConfig(path=probe_dir / "task"),
            trial_name=name,
            trials_dir=probe_dir / "trials",
        )
        for name in ("active", "waiting-one", "waiting-two")
    ]

    async def run_batch() -> None:
        async with asyncio.TaskGroup() as group:
            for trial in queue.submit_batch(configs):
                group.create_task(trial)

    return _QueueContractHarness(
        active=active,
        lifecycle=lifecycle,
        created=created,
        checkpoint_results=checkpoint_results,
        run_batch=run_batch,
    )


@pytest.mark.asyncio
async def test_cancelling_trial_queue_drains_active_trial_without_starting_waiters(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SIGINT cancellation may checkpoint active work but must not admit waiters."""
    harness = _build_queue_contract_harness(
        tmp_path,
        lambda factory: monkeypatch.setattr(Trial, "create", classmethod(factory)),
    )

    harbor_run = asyncio.create_task(harness.run_batch())
    await asyncio.wait_for(harness.active.wait(), timeout=1)
    harbor_run.cancel()

    with pytest.raises(asyncio.CancelledError):
        await harbor_run

    assert harness.created == ["active"]
    assert [path.name for path in (tmp_path / "trials").iterdir()] == ["active"]
    assert harness.lifecycle == [
        "start:active",
        "checkpoint",
        "cancel:active",
        "finalize",
        "end:active:CancelledError",
    ]
    assert (tmp_path / "trials" / "active" / "result.json").is_file()


async def _run_sigint_probe(probe_dir: Path) -> None:
    """Run Harbor's real queue until the parent process sends SIGINT."""
    def install_trial_factory(
        factory: Callable[
            [type[Trial], TrialConfig], Awaitable[_CancellationContractTrial]
        ],
    ) -> None:
        Trial.create = classmethod(factory)

    harness = _build_queue_contract_harness(
        probe_dir,
        install_trial_factory,
        score_before_cancel=True,
    )
    harbor_run = asyncio.create_task(harness.run_batch())
    await harness.active.wait()
    (probe_dir / "ready").write_text("ready\n", encoding="utf-8")
    try:
        await harbor_run
    finally:
        trials_dir = probe_dir / "trials"
        result = json.loads(
            (trials_dir / "active" / "result.json").read_text(encoding="utf-8")
        )
        checkpoint_result = harness.checkpoint_results[0]
        (probe_dir / "observed.json").write_text(
            json.dumps(
                {
                    "created": harness.created,
                    "trial_dirs": sorted(path.name for path in trials_dir.iterdir()),
                    "lifecycle": harness.lifecycle,
                    "result_written": (trials_dir / "active" / "result.json").is_file(),
                    "serialized_reward": result["verifier_result"]["rewards"]["reward"],
                    "checkpoint_reward": checkpoint_result["verifier_result"]
                    ["rewards"]["reward"],
                }
            ),
            encoding="utf-8",
        )


def test_sigint_quiesces_queue_and_checkpoints_scored_result(
    tmp_path: Path,
) -> None:
    """SIGINT serializes and checkpoints a score before quiescing the queue."""
    process = subprocess.Popen(
        [sys.executable, __file__, "--sigint-probe", str(tmp_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    ready_path = tmp_path / "ready"
    deadline = time.monotonic() + 5
    while not ready_path.is_file() and process.poll() is None:
        if time.monotonic() >= deadline:
            process.kill()
            stdout, stderr = process.communicate()
            pytest.fail(f"SIGINT probe did not become ready\nstdout={stdout}\nstderr={stderr}")
        time.sleep(0.01)

    assert process.poll() is None
    process.send_signal(signal.SIGINT)
    stdout, stderr = process.communicate(timeout=5)

    assert process.returncode != 0, (stdout, stderr)
    observed = json.loads((tmp_path / "observed.json").read_text(encoding="utf-8"))
    assert observed == {
        "created": ["active"],
        "trial_dirs": ["active"],
        "lifecycle": [
            "start:active",
            "checkpoint",
            "cancel:active",
            "finalize",
            "end:active:CancelledError",
        ],
        "result_written": True,
        "serialized_reward": 1.0,
        "checkpoint_reward": 1.0,
    }


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--sigint-probe":
    # CI runners may start pytest with SIGINT ignored. That disposition survives
    # exec, and asyncio.run() only installs its cancellation handler when SIGINT
    # is still at the default disposition. Give this signal probe the same
    # explicit precondition as a foreground Harbor CLI process.
    signal.signal(signal.SIGINT, signal.default_int_handler)
    try:
        # Harbor's CLI uses this exact asyncio bridge for ``harbor run``.
        run_async(_run_sigint_probe(Path(sys.argv[2])))
    except KeyboardInterrupt:
        raise SystemExit(130) from None
