#!/usr/bin/env python3
"""Exact kernel-level resource sampling for the kimchi perf gate.

Metrics come from per-process kernel counters, sampled at phase boundaries
plus a background tree sampler; final main-process numbers are read from the
zombie (waitid WNOWAIT) where the platform allows it. Everything gated is
contention-insensitive by construction: instructions/cycles, bytes through
read/write, peak RSS, child-process counts — never wall-clock, with the one
deliberate exception of keystroke echo latency (single-tenant runner VM).

Backends: Linux (perf_event_open inherited counters + /proc) is the CI
backend; macOS (libproc rusage) remains for local development runs.
"""
import ctypes
import ctypes.util
import fcntl
import os
import pty
import re
import signal
import struct
import subprocess
import sys
import termios
import threading
import time

IS_LINUX = sys.platform.startswith("linux")
IS_MACOS = sys.platform == "darwin"

if IS_MACOS:
    libproc = ctypes.CDLL(ctypes.util.find_library("proc"))
    libc = ctypes.CDLL(ctypes.util.find_library("c"))

    class RUsageV4(ctypes.Structure):
        _fields_ = [("ri_uuid", ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in (
            "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins", "wired_size",
            "resident_size", "phys_footprint", "proc_start_abstime", "proc_exit_abstime",
            "child_user_time", "child_system_time", "child_pkg_idle_wkups", "child_interrupt_wkups",
            "child_pageins", "child_elapsed_abstime", "diskio_bytesread", "diskio_byteswritten",
            "qos_default", "qos_maintenance", "qos_background", "qos_utility", "qos_legacy",
            "qos_user_initiated", "qos_user_interactive", "billed_system_time", "serviced_system_time",
            "logical_writes", "lifetime_max_phys_footprint", "instructions", "cycles", "billed_energy",
            "serviced_energy", "interval_max_phys_footprint", "runnable_time")]

    class TB(ctypes.Structure):
        _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]

    _tb = TB()
    libc.mach_timebase_info(ctypes.byref(_tb))
    TICK_NS = _tb.numer / _tb.denom

elif IS_LINUX:
    libc = ctypes.CDLL("libc.so.6", use_errno=True)

    # struct perf_event_attr, layout-identical through bp_len on all 64-bit ABIs
    class PerfEventAttr(ctypes.Structure):
        _fields_ = [("type", ctypes.c_uint32), ("size", ctypes.c_uint32),
                    ("config", ctypes.c_uint64), ("sample_period", ctypes.c_uint64),
                    ("sample_type", ctypes.c_uint64), ("read_format", ctypes.c_uint64),
                    ("flags", ctypes.c_uint64), ("wakeup", ctypes.c_uint32),
                    ("bp_type", ctypes.c_int32), ("bp_addr", ctypes.c_uint64),
                    ("bp_len", ctypes.c_uint64)]

    PERF_TYPE_HARDWARE = 0
    PERF_COUNT_HW_CPU_CYCLES = 0
    PERF_COUNT_HW_INSTRUCTIONS = 1
    # attr.flags bitfield (include/uapi/linux/perf_event.h): exclude_user is
    # bit 4 and exclude_kernel bit 5 — confusing them would make the gate
    # count kernel-mode instructions only and blind it to the user-space CPU
    # regressions it exists to catch. Count user+kernel (both real work),
    # exclude only the hypervisor (bit 6).
    PERF_FLAG_EXCLUDE_HV_BIT = 1 << 6     # attr.flags: exclude_hv
    PERF_FLAG_PID_CGROUP = 4              # pid arg is a cgroup fd
    SYS_PERF_EVENT_OPEN = 241             # same number on x86_64 and aarch64
    CLK_TCK = os.sysconf("SC_CLK_TCK")
    libc.syscall.restype = ctypes.c_long

    def perf_open(pid, config):
        """Attach an inherited per-process hardware counter; None when blocked.

        perf_event_open is a raw syscall (glibc does not export a wrapper).
        """
        a = PerfEventAttr()
        a.type, a.size, a.config = PERF_TYPE_HARDWARE, ctypes.sizeof(PerfEventAttr), config
        a.flags = PERF_FLAG_EXCLUDE_HV_BIT
        fd = libc.syscall(SYS_PERF_EVENT_OPEN, ctypes.byref(a), pid, -1, -1, 0)
        return fd if fd >= 0 else None

    def perf_open_cgroup(cgfd, cpu, config):
        """Attach a hardware counter to a cgroup on one CPU; None when blocked.

        This runner kernel accepts cgroup monitoring only with a specific CPU
        (cpu=-1 is EINVAL); one counter per online CPU, summed, is the exact
        whole-tree aggregate. CPU-specific cgroup counters are classed as CPU
        monitoring, so the workflow sets perf_event_paranoid=0.
        """
        a = PerfEventAttr()
        a.type, a.size, a.config = PERF_TYPE_HARDWARE, ctypes.sizeof(PerfEventAttr), config
        a.flags = PERF_FLAG_EXCLUDE_HV_BIT
        fd = libc.syscall(SYS_PERF_EVENT_OPEN, ctypes.byref(a), cgfd, cpu, -1, PERF_FLAG_PID_CGROUP)
        return fd if fd >= 0 else None

    def perf_read(fd):
        buf = ctypes.c_uint64()
        n = libc.read(fd, ctypes.byref(buf), 8)
        return buf.value if n == 8 else 0


# ---------------------------------------------------------------- per-pid rusage
def _proc_stat_fields(pid):
    with open(f"/proc/{pid}/stat", "r") as f:
        data = f.read()
    # comm can contain spaces; fields start after the last ')'
    return data[data.rindex(")") + 2:].split()


def _proc_status_kb(pid, key):
    try:
        with open(f"/proc/{pid}/status", "r") as f:
            for line in f:
                if line.startswith(key + ":"):
                    return int(line.split()[1]) * 1024  # kB -> bytes
    except OSError:
        pass
    return 0


def _proc_io(pid):
    """Byte counters, or None when the read fails (dying process, ptrace
    window): callers must never mistake a failed read for zero bytes."""
    out = {}
    try:
        with open(f"/proc/{pid}/io", "r") as f:
            for line in f:
                k, _, v = line.partition(":")
                out[k] = int(v)
    except (OSError, ValueError):
        return None
    return out


def rusage(pid):
    if IS_MACOS:
        ru = RUsageV4()
        if libproc.proc_pid_rusage(pid, 4, ctypes.byref(ru)) != 0:
            return None
        return {
            "cpu_ms": (ru.user_time + ru.system_time) * TICK_NS / 1e6,
            "user_ms": ru.user_time * TICK_NS / 1e6,
            "sys_ms": ru.system_time * TICK_NS / 1e6,
            "child_cpu_ms": (ru.child_user_time + ru.child_system_time) * TICK_NS / 1e6,
            "instr": ru.instructions,
            "cycles": ru.cycles,
            "disk_r": ru.diskio_bytesread,
            "disk_w": ru.diskio_byteswritten,
            "logical_w": ru.logical_writes,
            "footprint": ru.phys_footprint,
            "max_footprint": ru.lifetime_max_phys_footprint,
            "wakeups": ru.pkg_idle_wkups + ru.interrupt_wkups,
            "pageins": ru.pageins,
        }
    try:
        fields = _proc_stat_fields(pid)
        io = _proc_io(pid)
        io_counts = io or {}
        return {
            "io_ok": io is not None,
            "cpu_ms": (int(fields[11]) + int(fields[12])) * 1000.0 / CLK_TCK,  # utime+stime
            "user_ms": int(fields[11]) * 1000.0 / CLK_TCK,
            "sys_ms": int(fields[12]) * 1000.0 / CLK_TCK,
            # cutime+cstime: CPU of reaped children, accumulated on wait (parity
            # with the macOS field; informational — the gate sums per-pid walks)
            "child_cpu_ms": (int(fields[13]) + int(fields[14])) * 1000.0 / CLK_TCK,
            # rchar/wchar: bytes through read/write syscalls — deterministic,
            # independent of page cache and I/O scheduling
            "instr": 0,  # filled in from the tree-level perf counter
            "cycles": 0,
            "disk_r": io_counts.get("rchar", 0),
            "disk_w": io_counts.get("wchar", 0),
            "logical_w": io_counts.get("write_bytes", 0),
            "footprint": _proc_status_kb(pid, "VmRSS"),
            "max_footprint": _proc_status_kb(pid, "VmHWM"),
            "wakeups": 0,
            "pageins": int(fields[9]) + int(fields[10]) if len(fields) > 10 else 0,  # minflt+majflt
        }
    except (OSError, IndexError, ValueError):
        return None


def child_pids(pid):
    if IS_MACOS:
        buf = (ctypes.c_int * 4096)()
        n = libproc.proc_listchildpids(pid, buf, ctypes.sizeof(buf))
        if n <= 0:
            return []
        if n > 4096:
            n //= ctypes.sizeof(ctypes.c_int)
        return [buf[i] for i in range(n) if buf[i] > 0]
    out = []
    try:
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                fields = _proc_stat_fields(entry)
                if int(fields[1]) == pid:  # PPid
                    out.append(int(entry))
            except (OSError, IndexError, ValueError):
                continue
    except OSError:
        pass
    return out


def tree(pid):
    out, stack = [], [pid]
    while stack:
        p = stack.pop()
        out.append(p)
        stack.extend(child_pids(p))
    return out


class GateCgroup:
    """A cgroup v2 containing exactly the measured process tree.

    Gives kernel-exact whole-tree counters — the difference between sampling
    and accounting: short-lived children (git helpers, tar+gzip in the
    reporting pass) live 10-100 ms and a 200 ms sampler misses them
    nondeterministically; the cgroup never misses. Counters used:
      - perf instructions/cycles per online CPU, summed (exact child work)
      - pids.peak: exact peak concurrency (replaces sampled child counts)
      - memory.peak: exact whole-tree peak RSS
      - cpu.stat usage_usec: tree CPU fallback tier
    The measured root is placed via the spawn wrapper (Pty argv), before
    exec, so not even a millisecond's worth of children escapes membership.
    """

    CGROOT = "/sys/fs/cgroup"

    def __init__(self, name):
        self.path = os.path.join(self.CGROOT, name)
        self.dirfd = None
        self.fds = {}  # (cpu, "instr"|"cycles") -> fd

    @staticmethod
    def _online_cpus():
        try:
            cpus = []
            for part in open("/sys/devices/system/cpu/online").read().strip().split(","):
                lo, _, hi = part.partition("-")
                cpus.extend(range(int(lo), int(hi or lo) + 1))
            return cpus
        except (OSError, ValueError):
            return list(range(os.cpu_count() or 1))

    @classmethod
    def create(cls, name):
        """Create and instrument a cgroup, or return None (no sudo, no
        controllers, old kernel): callers fall back to the sampling path.
        Never raises: a broken measurement backend must degrade to the
        legacy tier (which the gate then refuses to compare against
        cgroup-calibrated budgets — fail-closed is at the tier check).
        """
        if not IS_LINUX:
            return None
        self = cls(name)
        try:
            if subprocess.run(["sudo", "-n", "mkdir", "-p", self.path],
                              capture_output=True, timeout=20).returncode != 0:
                return None
            subprocess.run(["sudo", "-n", "chown", "-R", f"{os.getuid()}:{os.getgid()}", self.path],
                           capture_output=True, timeout=20)
            with open(os.path.join(self.path, "memory.peak")) as f:
                f.read()  # old kernels lack memory.peak: refuse the backend
            open(os.path.join(self.path, "pids.peak")).close()
            # A stale cgroup from a killed run (rmdir races with zombie
            # reparenting) would carry its peaks into this measurement;
            # resetting them keeps every run's peaks fresh regardless.
            for peakfile in ("memory.peak", "pids.peak"):
                try:
                    with open(os.path.join(self.path, peakfile), "w") as f:
                        f.write("1")
                except OSError:
                    pass
            self.dirfd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY)
            for cpu in self._online_cpus():
                for kind, config in (("instr", PERF_COUNT_HW_INSTRUCTIONS),
                                     ("cycles", PERF_COUNT_HW_CPU_CYCLES)):
                    fd = perf_open_cgroup(self.dirfd, cpu, config)
                    if fd is not None:
                        self.fds[(cpu, kind)] = fd
            if not any(k == "instr" for _, k in self.fds):
                raise IOError("could not attach cgroup instruction counters")
            return self
        except (OSError, subprocess.SubprocessError):
            self.close()
            return None

    def wrap(self, argv):
        """argv prefixing that moves the new pid into the cgroup pre-exec.

        The move needs root: the writer needs write access to the common
        ancestor's cgroup.procs (here the root cgroup), not just the
        chowned subdir — an unprivileged echo fails EPERM and the process
        silently runs unmeasured. Failure is loud: exit 87, the ready
        marker never appears, the scenario and gate fail closed.
        """
        return ["bash", "-c", f'echo $$ | sudo -n tee "{self.path}/cgroup.procs" > /dev/null || exit 87; '
                              'exec "$@"', "cgwrap"] + list(argv)

    def _read(self, name):
        with open(os.path.join(self.path, name)) as f:
            return f.read().strip()

    def snap(self):
        out = {"instr": 0.0, "cycles": 0.0,
               "cpu_ms": 0.0, "mem_current": 0, "mem_peak": 0,
               "pids_current": 0, "pids_peak": 0}
        for (_, kind), fd in self.fds.items():
            out[kind] += perf_read(fd)
        try:
            for line in self._read("cpu.stat").splitlines():
                k, _, v = line.partition(" ")
                if k == "usage_usec":
                    out["cpu_ms"] = int(v) / 1e3
            out["mem_current"] = int(self._read("memory.current"))
            out["mem_peak"] = int(self._read("memory.peak"))
            out["pids_current"] = int(self._read("pids.current"))
            out["pids_peak"] = int(self._read("pids.peak"))
        except (OSError, ValueError):
            pass
        return out

    def close(self):
        """Remove the cgroup. rmdir fails EBUSY while any process — alive or
        zombie — is still a member, and grandchildren that outlived the
        measured root are reaped asynchronously by init, so drain strays and
        retry for a bounded time. A cgroup that still can't go is reported
        (and is harmless: create() resets peaks on every new run)."""
        for fd in self.fds.values():
            try:
                os.close(fd)
            except OSError:
                pass
        self.fds.clear()
        if self.dirfd is not None:
            try:
                os.close(self.dirfd)
            except OSError:
                pass
            self.dirfd = None
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            try:
                with open(os.path.join(self.path, "cgroup.procs")) as f:
                    members = [int(p) for p in f.read().split()]
            except OSError:
                members = []
            if members:
                for p in members:
                    try:
                        os.kill(p, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
            if os.path.exists(self.path):
                try:
                    # Short timeout: this call is inside a 3 s deadline loop,
                    # so a hung sudo/rmdir must not blow the budget widemouth.
                    subprocess.run(["sudo", "-n", "rmdir", self.path],
                                   capture_output=True, timeout=2)
                except subprocess.SubprocessError:
                    pass  # hung sudo; the next iteration retries until deadline
                if not os.path.exists(self.path):
                    return
            else:
                return
            time.sleep(0.05)
        print(f"sampler: unable to remove cgroup {self.path}; left behind",
              file=sys.stderr)


class TreeSampler:
    """Background sampler that remembers the last rusage of every descendant pid.

    On Linux, an instructions and a cycles counter are attached per process
    as it first appears in the tree (inherit-mode aggregation is documented as
    unreliable for read(); per-pid attach matches the /proc lifecycle exactly:
    a process that exits between samples keeps its last-seen counts, like the
    other metrics). Attach needs perf_event_paranoid <= 1 — the workflow
    lowers it; without it the work metric falls back to CPU time and the
    tier mismatch fails the gate.
    """

    def __init__(self, root, interval=0.2, cgroup=None):
        self.root, self.interval = root, interval
        self.cg = cgroup          # GateCgroup or None (legacy sampling tier)
        self.cg_snap = None
        self.last = {}
        self.cmds = {}
        self.stop_ev = threading.Event()
        self.lock = threading.Lock()
        # perf is opened/closed from sample(), which runs on the background
        # thread AND is called directly by scenario code between phases — one
        # thread may be mid-open while the other closes evicted entries. All
        # perf-table mutation and fd reads go through perf_lock.
        self.perf_lock = threading.Lock()
        self.perf = {}  # pid -> {"instr": fd, "cycles": fd}; opened per process on first sight
        self.perf_disabled = not IS_LINUX
        self.io_sticky = 0  # io reads that kept last-known values (dying processes)
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()

    def _name(self, pid):
        if IS_MACOS:
            buf = ctypes.create_string_buffer(1024)
            libproc.proc_name(pid, buf, 1024)
            return buf.value.decode(errors="replace")
        try:
            with open(f"/proc/{pid}/comm", "r") as f:
                return f.read().strip()
        except OSError:
            return ""

    def _perf_for(self, pid):
        """Open (once) and return the counters for a pid; {} when unavailable."""
        if pid not in self.perf and not self.perf_disabled:
            fds = {}
            for name, config in (("instr", PERF_COUNT_HW_INSTRUCTIONS),
                                 ("cycles", PERF_COUNT_HW_CPU_CYCLES)):
                fd = perf_open(pid, config)
                if fd is not None:
                    fds[name] = fd
            if not fds:
                # One failure marks the backend off for the run (policy, not
                # a per-process condition); the tier record makes it visible.
                self.perf_disabled = True
            self.perf[pid] = fds
        return self.perf.get(pid) or {}

    def sample(self):
        if self.cg is not None:
            self.cg_snap = self.cg.snap()
        pids = tree(self.root)
        seen = set()
        for p in pids:
            seen.add(p)
            r = rusage(p)
            if r:
                with self.perf_lock:
                    for name, fd in self._perf_for(p).items():
                        r[name] = perf_read(fd)
                with self.lock:
                    if not r.pop("io_ok", True):
                        # io unreadable this tick (process dying): keep the last
                        # known byte counts instead of zeroing them out
                        prev = self.last.get(p)
                        if prev:
                            for k in ("disk_r", "disk_w", "logical_w"):
                                r[k] = prev.get(k, 0)
                            self.io_sticky += 1
                    if p not in self.cmds:
                        self.cmds[p] = self._name(p)
                    self.last[p] = r
        # Processes that vanished keep their last-seen counts; close their fds.
        with self.perf_lock:
            for p in [p for p in self.perf if p not in seen]:
                for fd in self.perf.pop(p, {}).values():
                    try:
                        os.close(fd)
                    except OSError:
                        pass

    def _run(self):
        while not self.stop_ev.is_set():
            self.sample()
            self.stop_ev.wait(self.interval)

    def stop(self):
        self.stop_ev.set()
        self.t.join()
        # No more counter opens after stop: a late sample() (failure paths
        # collecting whatever the last tick saw) must not reopen fds that
        # nobody closes afterwards.
        self.perf_disabled = True
        with self.perf_lock:
            for fds in self.perf.values():
                for fd in fds.values():
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            self.perf.clear()

    def totals(self):
        """main = root's own; desc = descendants (last seen); counts distinct child pids."""
        with self.lock:
            main = dict(self.last.get(self.root) or {})
            desc = {k: 0.0 for k in ("cpu_ms", "instr", "cycles", "disk_r", "disk_w", "logical_w", "footprint")}
            for p, r in self.last.items():
                if p == self.root:
                    continue
                for k in desc:
                    desc[k] += r[k]
            names = {}
            for p, n in self.cmds.items():
                if p != self.root:
                    names[n] = names.get(n, 0) + 1
            return {"main": main, "desc": desc,
                    "cg": self.cg_snap or {},
                    "n_children": len(self.cmds) - (1 if self.root in self.cmds else 0),
                    "child_names": names}


def wait_zombie(pid, timeout):
    """Wait for exit without reaping; returns final rusage of the zombie."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            info = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
        except ChildProcessError:
            return None
        if info is not None:
            # On Linux the zombie's /proc files are gone or unreadable; the
            # last background sample carries the near-final numbers.
            final = rusage(pid)
            if final:
                return final
            return "zombie"
        time.sleep(0.02)
    return False


ANSI = re.compile(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]")


class Pty:
    def __init__(self, argv, env, cwd, rows=40, cols=120):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.proc = subprocess.Popen(argv, env=env, cwd=cwd, stdin=slave, stdout=slave, stderr=slave,
                                     start_new_session=True, close_fds=True)
        os.close(slave)
        self.buf = bytearray()
        self.lock = threading.Lock()
        self.alive = True
        self.t = threading.Thread(target=self._reader, daemon=True)
        self.t.start()

    def _reader(self):
        while self.alive:
            try:
                d = os.read(self.master, 65536)
            except OSError:
                break
            if not d:
                break
            with self.lock:
                self.buf += d
            # answer cursor-position / device-attribute queries so TUIs don't stall.
            # Guarded: close() may have closed the master while this chunk was
            # in flight, and a dead child turns the write into an OSError.
            if not self.alive:
                break
            try:
                if b"\x1b[6n" in d:
                    os.write(self.master, b"\x1b[1;1R")
                if b"\x1b[c" in d:
                    os.write(self.master, b"\x1b[?62;22c")
            except OSError:
                break

    def plain(self):
        with self.lock:
            return ANSI.sub(b"", bytes(self.buf)).decode(errors="replace")

    def bytes_out(self):
        with self.lock:
            return len(self.buf)

    def wait_for(self, needles, timeout, start=0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            p = self.plain()[start:]
            for n in needles:
                if n in p:
                    return n
            # Dead process + drained reader: no marker will ever arrive.
            # Without this, a crashed binary burns the full timeout per wait.
            if self.proc.poll() is not None and not self.t.is_alive():
                return None
            time.sleep(0.05)
        return None

    def send(self, s):
        os.write(self.master, s.encode())

    def close(self):
        self.alive = False
        try:
            os.close(self.master)
        except OSError:
            pass
        # The reader unblocks via EIO/EOF once the child's process group is
        # dead (cleanup() killpgs before closing); joining keeps the fd from
        # being reused while the reader might still touch it.
        self.t.join(timeout=2)


def delta(a, b):
    """Per-phase deltas. With a cgroup backend, the work counters are the
    exact tree aggregates; disk_r/disk_w stay the root process's own
    rchar/wchar (exact per-process syscall counters; child byte traffic is
    covered by the child work now being counted exactly)."""
    if not a or not b:
        return {}
    ca, cb = a.get("cg") or {}, b.get("cg") or {}
    if cb:
        d = {k: cb.get(k, 0) - ca.get(k, 0) for k in ("instr", "cycles", "cpu_ms")}
        d["disk_r"] = b["main"].get("disk_r", 0) - a["main"].get("disk_r", 0)
        d["disk_w"] = b["main"].get("disk_w", 0) - a["main"].get("disk_w", 0)
        d["footprint_end"] = b["main"].get("footprint", 0)
        return d
    keys = ("cpu_ms", "instr", "cycles", "disk_r", "disk_w", "logical_w", "wakeups", "pageins")
    d = {k: b["main"].get(k, 0) - a["main"].get(k, 0) for k in keys if k in b["main"]}
    for k in ("cpu_ms", "instr", "cycles", "disk_r", "disk_w", "logical_w"):
        d["desc_" + k] = b["desc"][k] - a["desc"][k]
    d["child_cpu_ms"] = b["main"].get("child_cpu_ms", 0) - a["main"].get("child_cpu_ms", 0)
    d["footprint_end"] = b["main"].get("footprint", 0)
    return d
