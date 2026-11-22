"""Small process-tree cleanup checks; creates only its own throwaway children."""

import os
import signal
import subprocess
import sys
import tempfile
import time

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


if __name__ == "__main__":
    check_independent_grandchild_session()
    print("runtime checks OK: nested independent child sessions are reaped on timeout")
