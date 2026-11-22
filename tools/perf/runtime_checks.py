"""Small process-tree cleanup checks; creates only its own throwaway children."""

import os
import signal
import subprocess
import sys
import io
import json
import shutil
import tempfile
import time
import unittest.mock
from types import SimpleNamespace

from sampler import reap_process_tree


def state(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True,
                            text=True, check=False, timeout=5)
    return result.stdout.strip()


def check_independent_grandchild_session():
    """A plain child must not hide its new-session descendant from cleanup."""
    child_code = (
        "import subprocess, sys, time; "
        "child = subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2]], "
        "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
        "print(child.pid, flush=True); "
        "time.sleep(60)"
    )
    grandchild_code = (
        "import os, subprocess, sys, time; "
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], "
        "start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
        "open(sys.argv[1], 'w').write(str(child.pid)); "
        "time.sleep(60)"
    )
    with tempfile.TemporaryDirectory(prefix="perf-runtime-check-") as directory:
        id_file = os.path.join(directory, "grandchild.pid")
        proc = subprocess.Popen([sys.executable, "-c", child_code, grandchild_code, id_file],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                start_new_session=True)
        children = []
        try:
            line = proc.stdout.readline().strip()
            if not line:
                raise RuntimeError("intermediate child did not start")
            child = int(line)
            groups = [os.getpgid(proc.pid), os.getpgid(child)]
            assert groups[0] == groups[1], "intermediate child did not inherit the driver group"
            deadline = time.monotonic() + 2
            while not os.path.isfile(id_file):
                assert time.monotonic() < deadline, "independent grandchild did not write its identity"
                time.sleep(0.02)
            with open(id_file) as handle:
                grandchild = int(handle.read())
            groups.append(os.getpgid(grandchild))
            assert groups[-1] == grandchild, "grandchild did not create an independent session"
            children = [child, grandchild]
            assert reap_process_tree(proc, 1.5) == 124, "cleanup did not report a timeout"
            for pid in children:
                assert not state(pid) or state(pid).startswith("Z"), f"live process survived cleanup: {pid}"
        finally:
            if proc.poll() is None:
                reap_process_tree(proc, 0.2)
            # The assertion happens before this safety-net cleanup, so it can
            # observe a real leak. Even a failed test must leave nothing alive.
            for group in groups:
                if group == os.getpgid(0):
                    continue
                try:
                    os.killpg(group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if proc.poll() is None:
                proc.kill()
            proc.stdout.close()
            proc.stderr.close()
            proc.wait(timeout=5)


def check_gate_cancellation():
    import gate
    from calibration_checks import test_root
    class Driver:
        pid = 0
        def poll(self):
            return None
    calls = []
    def fake_reaper(_driver, timeout_s):
        calls.append(timeout_s)
        if len(calls) == 1:
            assert callable(signal.getsignal(signal.SIGTERM)), "no cancellation handler installed"
            os.kill(os.getpid(), signal.SIGTERM)
        return 0
    root, budget_path = test_root("ledger-heavy-v2")
    before = open(budget_path).read()
    old_handler = signal.getsignal(signal.SIGTERM)
    try:
        with unittest.mock.patch.object(gate.subprocess, "Popen", return_value=Driver()), \
                unittest.mock.patch.object(gate, "reap_process_tree", side_effect=fake_reaper), \
                unittest.mock.patch.object(sys, "argv", ["gate.py", "--binary", sys.executable,
                                                        "--scenarios", "ledger", "--budgets", budget_path]):
            try:
                gate.main()
            except SystemExit as error:
                assert str(error) == "perf gate cancelled", str(error)
            else:
                raise AssertionError("cancellation did not escape the active driver wait")
        assert calls == [900, 0], calls
        assert signal.getsignal(signal.SIGTERM) == old_handler, "signal handler was not restored"
        assert open(budget_path).read() == before
    finally:
        shutil.rmtree(root, ignore_errors=True)


def check_native_warm_cancellation():
    import fixtures
    import scenarios
    calls = []
    native_driver = SimpleNamespace(pid=1, poll=lambda: None,
                                    stdout=io.StringIO(), stderr=io.StringIO())
    def fake_reaper(_driver, timeout_s):
        calls.append(timeout_s)
        if len(calls) == 1:
            os.kill(os.getpid(), signal.SIGTERM)
            time.sleep(0.01)
        return 0
    process = SimpleNamespace(pid=1, wait=lambda timeout: 0, kill=lambda: None, poll=lambda: 0)
    def fake_prepare(root, _scenario, _base, *_args, binary=None, **_kwargs):
        env["KIMCHI_PERF_WARM"] = json.dumps(scenarios.warm_ledger(root, env, os.path.join(root, "work"), binary))
        return env, os.path.join(root, "work")
    tp = SimpleNamespace(proc=process, send=lambda _text: None, plain=lambda: "ready")
    server = SimpleNamespace(shutdown=lambda: None, server_close=lambda: None)
    root = tempfile.mkdtemp(prefix="perf-warm-cancel-")
    output = os.path.join(root, "ledger.jsonl")
    env = {"HOME": os.path.join(root, "home"), "TMPDIR": os.path.join(root, "tmp"),
           "KIMCHI_PERF_FIXTURE_GENERATION": fixtures.LEDGER_GENERATION,
           "KIMCHI_REMOTE_ENDPOINT": "http://fixture.invalid"}
    try:
        with unittest.mock.patch.object(scenarios.fakellm, "start", return_value=(server, SimpleNamespace(), "http://fixture.invalid")), \
                unittest.mock.patch.object(scenarios, "make_workdir", return_value=os.path.join(root, "work")), \
                unittest.mock.patch.object(scenarios, "prepare", side_effect=fake_prepare), \
                unittest.mock.patch.object(scenarios, "check_version", return_value="fixture"), \
                unittest.mock.patch.object(scenarios, "launch", return_value=(tp, None, None)), \
                unittest.mock.patch.object(scenarios.subprocess, "run", return_value=SimpleNamespace(stdout="git fixture")), \
                unittest.mock.patch.object(scenarios, "wait_fixture_ready", return_value="ready"), \
                unittest.mock.patch.object(fixtures, "ledger_projection_health", return_value={"ready": True}), \
                unittest.mock.patch.object(scenarios.subprocess, "Popen", return_value=native_driver), \
                unittest.mock.patch.object(scenarios, "reap_process_tree", side_effect=fake_reaper), \
                unittest.mock.patch.object(scenarios, "cleanup"), \
                unittest.mock.patch.object(sys, "argv", ["scenarios.py", "--binary", sys.executable,
                                                        "--scenario", "ledger", "--out", output]):
            try:
                scenarios.main()
            except SystemExit as error:
                assert error.code == 1, error.code
            else:
                raise AssertionError("SIGTERM did not interrupt native warming")
        assert len(calls) == 2 and calls[-1] == 0, calls
        assert native_driver.stdout.closed and native_driver.stderr.closed
    finally:
        shutil.rmtree(root, ignore_errors=True)


def check_linux_subreaper_contract():
    import sampler
    if sys.platform.startswith("linux"):
        sampler.enable_child_subreaper()
        return
    calls = []
    libc = SimpleNamespace(prctl=lambda operation, setting: calls.append((operation, setting)) or 0)
    with unittest.mock.patch.object(sampler, "IS_LINUX", True), \
            unittest.mock.patch.object(sampler.ctypes, "CDLL", return_value=libc):
        sampler.enable_child_subreaper()
    assert calls == [(36, 1)], calls


if __name__ == "__main__":
    check_independent_grandchild_session()
    check_linux_subreaper_contract()
    check_gate_cancellation()
    check_native_warm_cancellation()
    print("runtime checks OK: nested child sessions, gate, and native cancellation are reaped")
