"""Small process-tree cleanup checks; creates only its own throwaway children."""

import os
import signal
import subprocess
import sys
import shutil
import tempfile
import time
import unittest.mock
from types import SimpleNamespace

from sampler import descendant_process_groups, reap_process_tree


def state(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True,
                            text=True, check=False, timeout=5)
    return result.stdout.strip()


def check_independent_grandchild_session(root_exits_first=False):
    """Nested independent descendants survive neither early root exit nor timeout."""
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
            owned = descendant_process_groups(proc.pid)
            if root_exits_first:
                proc.kill()
                proc.wait(timeout=5)
            result = reap_process_tree(proc, 0, owned, force=True) if root_exits_first else reap_process_tree(proc, 1.5)
            assert result == 124, "cleanup did not report a timeout"
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
        pid = 99999999
        def poll(self):
            return None
    calls = []
    def fake_reaper(_driver, timeout_s, _owned_groups, **_kwargs):
        calls.append((timeout_s, _kwargs.get("force", False)))
        if len(calls) == 1:
            assert callable(signal.getsignal(signal.SIGTERM)), "no cancellation handler installed"
            raise SystemExit("perf gate cancelled")
        return 0
    root, budget_path = test_root("ledger-heavy-v2")
    before = open(budget_path).read()
    old_handler = signal.getsignal(signal.SIGTERM)
    real_popen = gate.subprocess.Popen
    def fake_popen(argv, **kwargs):
        return real_popen(argv, **kwargs) if argv[0] == "ps" else Driver()
    try:
        with unittest.mock.patch.object(gate.subprocess, "Popen", side_effect=fake_popen), \
                unittest.mock.patch.object(gate, "reap_process_tree", side_effect=fake_reaper), \
                unittest.mock.patch.object(sys, "argv", ["gate.py", "--binary", sys.executable,
                                                        "--scenarios", "ledger", "--budgets", budget_path]):
            try:
                gate.main()
            except SystemExit as error:
                assert str(error) == "perf gate cancelled", str(error)
            else:
                raise AssertionError("cancellation did not escape the active driver wait")
        assert len(calls) == 2, calls
        assert calls[0] == (gate.scenario_timeout("ledger", 2), False), calls
        assert calls[1] == (0, True), calls
        assert signal.getsignal(signal.SIGTERM) == old_handler, "signal handler was not restored"
        assert open(budget_path).read() == before
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _run_scenario(binary, output):
    import scenarios
    sys.argv = ["scenarios.py", "--binary", binary, "--scenario", "ledger", "--out", output]
    scenarios.main()


def check_native_warm_cancellation():
    """Cancel a real scenario after native warm-up starts and require a clean tree."""
    import multiprocessing
    root = tempfile.mkdtemp(prefix="perf-warm-cancel-")
    binary = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../dist/bin/kimchi"))
    prior = os.environ.get("KIMCHI_PERF_LEDGER_RECORDS")
    os.environ["KIMCHI_PERF_LEDGER_RECORDS"] = "2400"
    process = multiprocessing.Process(target=_run_scenario, args=(binary, os.path.join(root, "result.jsonl")), daemon=True)
    process.start()
    try:
        deadline = time.monotonic() + 180
        while True:
            waves = subprocess.check_output(["ps", "-axo", "pid=,command="], text=True).splitlines()
            if any("/tmp/kimchi-realistic-fixture/tools/perf/warm-billing.ts" in row for row in waves):
                break
            assert process.exitcode is None, f"scenario exited before native warming: {process.exitcode}"
            assert time.monotonic() < deadline, "native warming did not start in time"
            time.sleep(0.1)
        os.kill(process.pid, signal.SIGTERM)
        process.join(timeout=30)
        assert not process.is_alive(), "scenario did not stop after SIGTERM"
        assert process.exitcode == 1, process.exitcode
        survivors = []
        for row in subprocess.check_output(["ps", "-axo", "pid=,stat=,command="], text=True).splitlines():
            _, stat, command = row.strip().split(None, 2)
            argv = command.split()
            app = bool(argv and argv[0] == binary)
            native = bool(argv and argv[0].endswith("/bun") and len(argv) > 1 and argv[1].endswith("warm-billing.ts"))
            if (app or native) and not stat.startswith("Z"):
                survivors.append({"stat": stat, "argv0": argv[0], "script": argv[1] if len(argv) > 1 else None})
        assert not survivors, survivors
    finally:
        if process.is_alive():
            os.kill(process.pid, signal.SIGKILL)
            process.join(timeout=10)
        shutil.rmtree(root, ignore_errors=True)
        if prior is None:
            os.environ.pop("KIMCHI_PERF_LEDGER_RECORDS", None)
        else:
            os.environ["KIMCHI_PERF_LEDGER_RECORDS"] = prior


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


def check_timeout_composition():
    import gate
    assert gate.scenario_timeout("ledger", 2) == 2700, gate.scenario_timeout("ledger", 2)
    assert gate.scenario_timeout("session", 2) == 900
    expected_growth = gate.scenario_timeout("ledger", 3) - gate.scenario_timeout("ledger", 2)
    assert expected_growth == 780, expected_growth


if __name__ == "__main__":
    check_independent_grandchild_session()
    check_independent_grandchild_session(root_exits_first=True)
    check_timeout_composition()
    check_linux_subreaper_contract()
    check_gate_cancellation()
    check_native_warm_cancellation()
    print("runtime checks OK: nested child sessions, gate, and native cancellation are reaped")
