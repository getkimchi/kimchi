"""Small process-tree cleanup checks; creates only its own throwaway children."""

import os
import signal
import sqlite3
import subprocess
import sys
import shutil
import tempfile
import threading
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


def check_no_rescan_of_reaped_root():
    import sampler
    proc = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)
    group = os.getpgid(proc.pid)
    proc.wait(timeout=10)
    try:
        with unittest.mock.patch.object(sampler, "descendant_process_groups",
                                        side_effect=AssertionError("reaped PID was rescanned")):
            result = sampler.reap_process_tree(proc, 0, {group}, force=True)
        assert result == 124, result
    finally:
        proc.wait(timeout=10)


def check_gate_cancellation_before_owned():
    import gate
    from calibration_checks import test_root
    class Driver:
        def __init__(self):
            self.signaled = False
        @property
        def pid(self):
            if not self.signaled:
                self.signaled = True
                signal.raise_signal(signal.SIGTERM)
            return 99999999
    driver = Driver()
    calls = []
    def fake_reaper(actual, timeout_s, groups, **_kwargs):
        calls.append((actual, groups, timeout_s, _kwargs.get("force", False)))
        return 0
    root, budget_path = test_root("ledger-heavy-v2")
    old_handler = signal.getsignal(signal.SIGTERM)
    real_popen = gate.subprocess.Popen
    def fake_popen(argv, **kwargs):
        return real_popen(argv, **kwargs) if argv[0] == "ps" else driver
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
                raise AssertionError("early cancellation was not delivered")
        assert calls == [(driver, set(), 0, True)], calls
        assert signal.getsignal(signal.SIGTERM) == old_handler, "signal handler was not restored"
    finally:
        shutil.rmtree(root, ignore_errors=True)


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
        driver_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "warm-billing.ts"))
        deadline = time.monotonic() + 180
        while True:
            waves = subprocess.check_output(["ps", "-axo", "pid=,command="], text=True).splitlines()
            if any(driver_path in row.split() for row in waves):
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
            os.kill(process.pid, signal.SIGTERM)
            process.join(timeout=30)
        if process.is_alive():
            os.kill(process.pid, signal.SIGKILL)
            process.join(timeout=10)
        assert not process.is_alive(), "failed to terminate owned scenario"
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


def check_permission_errors_are_not_suppressed():
    import sampler
    class Driver:
        pid = 99999999
        def __init__(self):
            self.returncode = -9
            self.waited = []
            self.kill_called = False
        def poll(self):
            return -9
        def wait(self, timeout):
            self.waited.append(timeout)
            return -9
        def kill(self):
            self.kill_called = True
    proc = Driver()
    with unittest.mock.patch.object(sampler.os, "getpgid", return_value=0), \
            unittest.mock.patch.object(sampler.os, "killpg", side_effect=PermissionError("fixture denied")):
        try:
            sampler.reap_process_tree(proc, 0, {proc.pid}, force=True)
        except PermissionError as error:
            assert str(error) == "fixture denied", str(error)
        else:
            raise AssertionError("permission error was suppressed")
    assert proc.waited == [10], proc.waited
    assert not proc.kill_called


def check_zombie_cleanup():
    import sampler
    proc = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)
    group = os.getpgid(proc.pid)
    try:
        state = sampler.wait_zombie(proc.pid, 10)
        assert state is not False, "child did not exit"
        status = subprocess.check_output(["ps", "-p", str(proc.pid), "-o", "stat="], text=True).strip()
        assert status.startswith("Z"), status
        with unittest.mock.patch.object(sampler.os, "killpg", side_effect=PermissionError("owned zombie")):
            result = sampler.reap_process_tree(proc, 0, {group}, force=True)
        assert result == 124, result
        assert proc.poll() is not None, "zombie root was not reaped"
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=10)


def check_remap_sqlite_atomicity():
    import fixtures
    source_home = tempfile.mkdtemp(prefix="perf-remap-source-")
    destination_home = tempfile.mkdtemp(prefix="perf-remap-destination-")
    source = os.path.join(source_home, ".config", "kimchi", "harness")
    os.makedirs(os.path.join(source, "pr-cost-reporting"), exist_ok=True)
    db = os.path.join(source, "pr-cost-reporting", "ledger.db")
    writer = sqlite3.connect(db, check_same_thread=False)
    try:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA synchronous=FULL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.executescript(fixtures.LEDGER_SCHEMA)
        sample = os.path.join(source, "sample.jsonl")
        with open(sample, "w") as handle:
            handle.write("{}\n")
        writer.execute("INSERT INTO journal_cursor VALUES (?, 0, 0, 0, 0, '', 0)", (sample,))
        writer.commit()
        stop = threading.Event()
        failures = []

        def produce():
            try:
                for block in range(48):
                    if stop.is_set():
                        break
                    with writer:
                        writer.executemany(
                            "INSERT INTO bookkeeping VALUES (?, ?, ?, ?)",
                            [("remap", f"{block}-{index}-costs", f"{block}-{index}-" + ("x" * 1024), 0)
                             for index in range(80)],
                        )
                        writer.execute("UPDATE journal_cursor SET offset = ?", (block + 1,))
                    if block % 4 == 3:
                        writer.execute("PRAGMA wal_checkpoint(RESTART)")
            except Exception as error:
                failures.append(repr(error))

        thread = threading.Thread(target=produce, daemon=True)
        thread.start()
        original_validator = fixtures.validate_warm_home
        try:
            # Exercise atomicity, not the separately tested claim and shape guards.
            fixtures.validate_warm_home = lambda _home: None
            fixtures.remap_warm_home(source_home, destination_home)
            destination_db = os.path.join(destination_home, ".config", "kimchi", "harness",
                                          "pr-cost-reporting", "ledger.db")
            with sqlite3.connect(destination_db) as con:
                records = con.execute("SELECT COUNT(*) FROM bookkeeping").fetchone()[0]
                cursor = con.execute("SELECT offset FROM journal_cursor").fetchone()[0]
            assert records > 0 and cursor > 0, {"records": records, "cursor": cursor}
            assert not failures, failures
            assert os.stat(db).st_mode & 0o777 == os.stat(destination_db).st_mode & 0o777
        finally:
            fixtures.validate_warm_home = original_validator
            stop.set()
            thread.join(timeout=10)
            assert not thread.is_alive(), "warm-copy writer remained active"
    finally:
        writer.close()
        shutil.rmtree(source_home, ignore_errors=True)
        shutil.rmtree(destination_home, ignore_errors=True)


if __name__ == "__main__":
    check_independent_grandchild_session()
    check_remap_sqlite_atomicity()
    check_permission_errors_are_not_suppressed()
    check_zombie_cleanup()
    check_independent_grandchild_session(root_exits_first=True)
    check_no_rescan_of_reaped_root()
    check_gate_cancellation_before_owned()
    check_timeout_composition()
    check_linux_subreaper_contract()
    check_gate_cancellation()
    check_native_warm_cancellation()
    print("runtime checks OK: nested child sessions, gate, and native cancellation are reaped")
