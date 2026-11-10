#!/usr/bin/env python3
"""Scenario runner for the kimchi perf gate.

Three scenarios, one per shipped regression class:
  - session:  clean HOME, a short TUI session with tool turns.
             Gates disk bytes written + instructions (v1.22 wrote 3-4x more).
  - resume:  a large multi-compaction session, resumed with --continue.
             Gates load/turn instructions + peak footprint (v1.11 was 3-9x).
  - idle:    an aged HOME (synthetic ledger/queue); pure idle timeline.
             Gates per-pass instructions, reads and child spawns (v1.10 class).

All timings beyond scenario orchestration (marker waits) are advisory only;
gated metrics are instructions, bytes, footprint and child counts from
tools/perf/sampler.py.

Usage:
  python3 tools/perf/scenarios.py --binary dist/kimchi --scenario session \
      --out runs.jsonl [--workroot DIR] [--reps 2]
"""
import argparse
import hashlib
import json
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fakellm  # noqa: E402
import fixtures  # noqa: E402
from sampler import GateCgroup, Pty, TreeSampler, delta, wait_zombie  # noqa: E402


def launch(env, cwd, argv, scenario, rep_tag="r", sampler_interval=0.2):
    """Spawn the binary in a PTY, inside a fresh accounting cgroup when the
    kernel permits (Linux CI runner); otherwise legacy per-pid sampling.
    Returns (tp, sampler, cleanup_callable's cgroup-or-None)."""
    # The monotonic timestamp makes every launch's cgroup name unique: a
    # leftover cgroup from a previous rep (rmdir races zombie reparenting)
    # can then never silently be re-measured into this run.
    cg = GateCgroup.create(f"perf-gate-{scenario}-{rep_tag}-{os.getpid()}-{time.monotonic_ns()}")
    tp = Pty(cg.wrap(argv) if cg else argv, env, cwd)
    sampler = TreeSampler(tp.proc.pid, interval=sampler_interval, cgroup=cg)
    return tp, sampler, cg

READY_MARKERS = ["ask anything or type / for commands", "ask anything", "type / for commands"]
REPOS = 8
KEYLAT_SLOW_MS = 100  # probes slower than this are recorded with their time and phase


def host_info():
    """Which machine measured this record. Instruction counts differ across CPU
    types behind the same runner label, so every record carries the CPU model,
    core count, kernel and (in CI) the runner image."""
    import platform
    info = {"arch": platform.machine(), "ncpu": os.cpu_count(), "kernel": platform.release()}
    model = None
    if sys.platform.startswith("linux"):
        try:
            out = subprocess.run(["lscpu"], capture_output=True, text=True, timeout=10).stdout
            fields = dict(line.split(":", 1) for line in out.splitlines() if ":" in line)
            fields = {k.strip(): v.strip() for k, v in fields.items()}
            model = fields.get("Model name")
            info["cpu_vendor"] = fields.get("Vendor ID")
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
        if not model:
            try:
                for line in open("/proc/cpuinfo"):
                    k, _, v = line.partition(":")
                    if k.strip() in ("model name", "CPU part"):
                        model = v.strip()
                        break
            except OSError:
                pass
    elif sys.platform == "darwin":
        try:
            model = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True,
                                   text=True, timeout=10).stdout.strip() or None
        except (OSError, subprocess.SubprocessError):
            pass
    info["cpu_model"] = model
    for env in ("ImageOS", "ImageVersion", "RUNNER_NAME"):
        if os.environ.get(env):
            info[env.lower()] = os.environ[env]
    return info


def child_env(home, base_url, tmpdir, binary=None):
    env = {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": home, "USER": os.environ.get("USER", "bench"), "SHELL": "/bin/zsh",
        "LANG": "en_US.UTF-8",
        "TERM": "xterm-256color", "COLORTERM": "truecolor", "TMPDIR": tmpdir,
        "KIMCHI_PERMISSIONS": "yolo", "KIMCHI_NO_UPDATE_CHECK": "1", "KIMCHI_REMOTE_RUN": "0",
        "KIMCHI_REMOTE_ENDPOINT": base_url, "KIMCHI_PARENT_SESSION_ID": "",
    }
    if binary:
        # release trees carry share/kimchi next to bin/; older builds need it via PI_PACKAGE_DIR
        pkg = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(binary))), "share", "kimchi")
        if os.path.isdir(pkg):
            env["PI_PACKAGE_DIR"] = pkg
    return env


def make_workdir(root):
    """A working repo: files + one commit, like a fresh clone."""
    wd = os.path.join(root, "work")
    os.makedirs(wd, exist_ok=True)
    with open(os.path.join(wd, "big.txt"), "w") as f:
        for i in range(1500):
            f.write(f"line {i}: lorem ipsum dolor sit amet consectetur adipiscing elit\n")
    for i in range(30):
        with open(os.path.join(wd, f"mod{i}.ts"), "w") as f:
            f.write(f"export const v{i} = {i}\n")
    env = {"PATH": "/usr/bin:/bin", "HOME": root, "GIT_CONFIG_NOSYSTEM": "1"}
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, ".gitconfig"), "w") as g:
        g.write("[user]\n\tname = bench\n\temail = bench@example.com\n[init]\n\tdefaultBranch = main\n")
    for c in (["git", "init", "-q"], ["git", "add", "."],
              ["git", "-c", "user.email=b@b", "-c", "user.name=b", "commit", "-qm", "init"]):
        subprocess.run(c, cwd=wd, env=env, check=True, capture_output=True)
    return wd


def session_dir(home, wd):
    """The encoded sessions directory kimchi looks in for `--continue` in wd."""
    cwd = os.path.realpath(wd)
    enc = "--" + re.sub(r"[/\\:]", "-", cwd.lstrip("/")) + "--"
    return os.path.join(home, ".config", "kimchi", "harness", "sessions", enc)


def check_version(binary, env, cwd):
    """The binary's self-reported version, sanitized for logs and summaries.

    Empty output means a stale re-exec (an old build re-executing an updated
    one); the gate also cross-checks that every rep reports the same string.
    Control characters and backticks are stripped so the value is safe to
    interpolate into CI markdown.
    """
    try:
        p = subprocess.run([binary, "--version"], env=env, cwd=cwd, capture_output=True,
                           text=True, stdin=subprocess.DEVNULL, timeout=60)
    except subprocess.TimeoutExpired:
        return ""
    reported = p.stdout.strip().splitlines()
    if not reported:
        return ""
    return re.sub(r"[\x00-\x1f\x7f`]", "", reported[0])[:120]


# ---------------------------------------------------------------- scenarios
def run_session(binary, env, cwd, srv_state, idle_s=10):
    """Clean TUI session with two turns (one with tools). Gate: disk_w, instr."""
    # Submit-latency marks (KIMCHI_SUBMIT_TIMING, when the binary carries the
    # instrument): Enter to the user's message entering the session. The gate
    # budgets the max across turns; reintroduced blocking between submit and
    # the request lands here at its full duration. The env var points inside
    # the per-run HOME; a binary without the instrument never writes the file.
    marks_path = os.path.join(env["HOME"], "submit-timing.jsonl")
    env["KIMCHI_SUBMIT_TIMING"] = marks_path
    argv = [binary, "--provider", "fake", "--model", "basic"]
    tp, sampler, cg = launch(env, cwd, argv, "session")
    pid = tp.proc.pid
    res = {"ok": False}
    try:
        t_spawn = time.time()
        if not tp.wait_for(READY_MARKERS, 90):
            res["error"] = "ready marker not seen"
            res["exit_code"] = tp.proc.poll()  # 87: cgroup join failed (wrap())
            res["screen_tail"] = tp.plain()[-1200:]
            return res
        res["ready_s"] = time.time() - t_spawn
        # Startup work and memory at the moment the prompt appears: catches
        # bundled-skill/extension loading growth that ready_s (wall-clock)
        # only shows as noise. Cumulative snapshot, recorded before any
        # counted window — shifts nothing measured later.
        sampler.sample()
        su = sampler.totals()
        su_c = pick_counters(su)
        res["startup"] = {"instr": su_c["instr"], "cycles": su_c["cycles"], "cpu_ms": su_c["cpu_ms"],
                          "rss": rss_now(su), "mem_current": (su.get("cg") or {}).get("mem_current")}
        time.sleep(3)
        for kind, prompt in (("text", "hello there TOK{tok}"), ("tools", "TOOLS run them TOK{tok}")):
            tok = f"{random.randrange(10**8):08d}"
            start = len(tp.plain())
            tp.send(prompt.format(tok=tok))
            time.sleep(0.3)
            tp.send("\r")
            if not tp.wait_for([f"BENCH_DONE_{tok}"], 120, start):
                res["error"] = f"{kind} turn marker not seen"
                res["screen_tail"] = tp.plain()[-1200:]
                return res
            time.sleep(1)
        # Thinking-stall turn (the #1645 class): while a ~360KB thinking block
        # streams at a realistic cadence, the TUI must keep repainting between
        # chunks. A renderer that re-derives the full accumulated thinking text
        # per delta blocks the event loop for seconds; with output flowing at
        # 25msgaps max ~40ms when healthy, the stall shows up directly as an
        # inter-output gap. Keystroke-echo probes are NOT usable here: during
        # continuous output they time background chunks, not the echo.
        think_tok = f"{random.randrange(10**8):08d}"
        start = len(tp.plain())
        think_t0 = time.time()
        sampler.sample()
        think_instr0 = flatten_total(sampler.totals())["instr"] or 0
        tp.send(f"THINK hard TOK{think_tok}")
        time.sleep(0.3)
        tp.send("\r")
        gaps = []
        last_n = tp.bytes_out()
        last_t = time.perf_counter()
        deadline = time.time() + 120
        while True:
            if f"BENCH_DONE_{think_tok}" in tp.plain()[start:]:
                break
            if time.time() > deadline:
                res["error"] = "thinking turn marker not seen"
                res["screen_tail"] = tp.plain()[-1200:]
                return res
            n = tp.bytes_out()
            now = time.perf_counter()
            if n != last_n:
                gaps.append((now - last_t) * 1000)
                last_n, last_t = n, now
            time.sleep(0.008)  # ~2x finer than the healthiest chunk cadence
        res["thinking_turn_s"] = time.time() - think_t0
        # Work units spent only on the thinking turn: kernel counter delta
        # sampled around the turn (same flatten_total shape as the session
        # total, so cgroup tiers stay exact). The #1645 class costs ~11x a
        # healthy turn on the same fixture (measured 183G vs 16G sampling
        # tier, 386ms vs 68ms max inter-output gap).
        sampler.sample()
        res["think_instr"] = (flatten_total(sampler.totals())["instr"] or 0) - think_instr0
        res["thinking_gaps"] = len(gaps)
        if gaps:
            lat = sorted(gaps)
            res["thinking_gap_p95_ms"] = lat[max(0, int(len(lat) * 0.95) - 1)]
            res["thinking_gap_max_ms"] = lat[-1]
            print(f"session thinking output-gaps n={len(lat)} turn={res['thinking_turn_s']:.1f}s "
                  f"instr={res['think_instr']/1e9:.2f}G "
                  f"p95={res['thinking_gap_p95_ms']:.1f}ms max={lat[-1]:.1f}ms "
                  # engagement evidence: if derivation runs per update, cost grows with
                  # accumulated text — the last-decile window must beat the first one.
                  f"first={sum(gaps[:50])/max(1,min(50,len(gaps))):.1f}ms "
                  f"last={sum(gaps[-50:])/max(1,min(50,len(gaps))):.1f}ms", flush=True)
        else:
            res["thinking_gap_p95_ms"] = None
            res["thinking_gap_max_ms"] = None
            print("session thinking output-gaps n=0 (turn produced no output)", flush=True)
        time.sleep(idle_s)
        sampler.sample()  # last live sample: io bytes and counters, pre-quit
        # sampling stops here — a sample landing while kimchi is dying would
        # read zero io and overwrite the final numbers
        sampler.stop()
        final = wait_zombie_after_quit(tp, pid, sampler)
        if final is False:
            res["error"] = "process did not exit on /quit (or was reaped early)"
            res["screen_tail"] = tp.plain()[-1200:]
            return res
        res["ok"] = True
        tot = sampler.totals()
        if cg is not None:
            # The /quit flush (session writes, reporting archive) happens after
            # the last live sample; the cgroup counters are still readable, so
            # refresh them post-exit to account the quit phase exactly.
            sampler.cg_snap = cg.snap()
        if isinstance(final, dict):
            # Merge, never replace: a Linux zombie's /proc has the final CPU
            # times but not io bytes or perf counters (those live in the last
            # live sample); a macOS zombie rusage is complete either way. The
            # "zombie" sentinel means /proc was unreadable — the pre-quit
            # sample stands (fail visible: stats unavailable), never crash.
            for k in ("cpu_ms", "user_ms", "sys_ms", "child_cpu_ms",
                      "instr", "cycles", "disk_r", "disk_w", "logical_w", "max_footprint"):
                if final.get(k):
                    tot["main"][k] = final[k]
        res["total"] = flatten_total(tot)
        res["counter"] = counter_tier(tot)
        # Parse the submit-timing marks after the process is gone: the file
        # is complete then, and the quit flush cannot interleave.
        res["submit_timing"] = False
        try:
            with open(marks_path, encoding="utf-8") as fh:
                marks = [json.loads(line) for line in fh if line.strip()]
        except OSError:
            marks = []
        if marks:
            res["submit_timing"] = True
            lat, pending = [], None
            for mark in marks:
                if mark.get("event") == "submit.input":
                    pending = mark["t"]
                elif (mark.get("event") == "message.entryStart" and mark.get("role") == "user"
                      and pending is not None):
                    lat.append(mark["t"] - pending)
                    pending = None
            if lat:
                res["submit_echo_ms"] = lat
                res["submit_echo_max_ms"] = max(lat)
            else:
                # The instrument ran but produced no user-entry samples — a
                # measurement failure, not an absent instrument; fail the rep
                # so the classifier's dormant-lane SKIP can never mask it.
                res["ok"] = False
                res["error"] = "submit-timing marks present but no user-entry samples"
    finally:
        cleanup(tp, pid, sampler, cg)
    res["home_bytes"] = home_footprint(env["HOME"])
    return res


def wait_zombie_after_quit(tp, pid, sampler):
    tp.send("/quit")
    time.sleep(0.3)
    tp.send("\r")
    final = wait_zombie(pid, 30)
    if final is False:
        tp.send("\x03")
        time.sleep(0.2)
        tp.send("\x03")
        final = wait_zombie(pid, 10)
    return final


def run_resume(binary, env, cwd, srv_state, settle_s=5):
    """Resume the big session; gate: load+turn instr, peak footprint."""
    argv = [binary, "--provider", "fake", "--model", "basic", "--continue"]
    t_spawn = time.time()
    tp, sampler, cg = launch(env, cwd, argv, "resume", sampler_interval=0.1)
    pid = tp.proc.pid
    res = {"ok": False}
    try:
        if not tp.wait_for(READY_MARKERS, 180):
            res["error"] = "ready marker not seen"
            res["exit_code"] = tp.proc.poll()  # 87: cgroup join failed (wrap())
            res["screen_tail"] = tp.plain()[-1200:]
            return res
        res["ready_s"] = time.time() - t_spawn
        # Same settle window as before (load counters keep their meaning); while
        # waiting, note when screen output last changed: history rendering that
        # continues after the prompt appears is part of what a user waits for.
        settle_end = time.time() + settle_s
        last_n, last_change = tp.bytes_out(), time.time()
        while time.time() < settle_end:
            time.sleep(0.02)
            n = tp.bytes_out()
            if n != last_n:
                last_n, last_change = n, time.time()
        res["settled_s"] = last_change - t_spawn
        res["settled_in_window"] = last_change < settle_end - 0.5
        sampler.sample()
        a = sampler.totals()
        res["load"] = pick_counters(a)
        tok = f"{random.randrange(10**8):08d}"
        start = len(tp.plain())
        tp.send(f"hello there TOK{tok}")
        time.sleep(0.2)
        tp.send("\r")
        t = time.time()
        got = tp.wait_for([f"BENCH_DONE_{tok}"], 180, start)
        res["turn_s"] = time.time() - t if got else None
        time.sleep(1)
        sampler.sample()
        c = sampler.totals()
        res["turn"] = delta(a, c)
        res["peak_mem"] = peak_mem(c)
        res["counter"] = counter_tier(c)
        res["ok"] = bool(got)
        if not got:
            res["error"] = "turn marker not seen"
            res["screen_tail"] = tp.plain()[-1200:]
        # Engagement assertion: a 31 MB session resume cannot cost under a
        # billion instructions; a green-but-tiny load means the fixture no
        # longer exercises the product (e.g. session-file drift) and the
        # budget would gate nothing.
        load_instr = ((res.get("load") or {}).get("instr")) or 0
        if res["ok"] and load_instr < 1_000_000_000:
            res["ok"] = False
            res["error"] = (f"resume did not engage: load work {load_instr:,} instructions "
                            "(session fixture drift?)")
    finally:
        cleanup(tp, pid, sampler, cg)
    res["home_bytes"] = home_footprint(env["HOME"])
    return res


# Advisory idle lanes (never gated). The gated "idle" lane measures an aged
# install whose upload queue cannot drain: the key verifies, but every upload
# is refused with 403 (no upload permission) — a permanent failure the client
# backs off from for hours. These two give the other states:
#   idle_healthy: same aged install, uploads acknowledged, the queue drains
#   idle_fresh:   clean install, nothing queued
IDLE_VARIANTS = ("idle_healthy", "idle_fresh")

BIGTOOLS_TURNS = 10
BIGTOOLS_READS = 8          # read calls per turn, each on a distinct file
BIGTOOLS_FILE_BYTES = 60_000  # > the read tool's 50 KB cap, so every result is ~50 KB
BIGTOOLS_EXTERNALIZE = 16384  # below ~50 KB: #1405's store mirrors every read result
BIGTOOLS_VARIANTS = {
    # #1405's tool-output store on, threshold lowered so built-in read results
    # (capped at 50 KB, below the 64 KiB default) are actually externalized
    "bigtools": {"KIMCHI_TOOL_OUTPUT_EXTERNALIZE_BYTES": str(BIGTOOLS_EXTERNALIZE)},
    # same build, store off: the A/B control (pre-#1405 builds ignore both)
    "bigtools_off": {"KIMCHI_TOOL_OUTPUT_STORE": "off"},
}


def write_bigtools_files(wd, turns=BIGTOOLS_TURNS, reads=BIGTOOLS_READS):
    """Distinct ~60 KB text files big<k>.txt, one per read call of the lane."""
    for k in range(turns * reads):
        line = f"big{k} " + " ".join(f"w{k}-{j}" for j in range(14))
        with open(os.path.join(wd, f"big{k}.txt"), "w") as f:
            n = 0
            i = 0
            while n < BIGTOOLS_FILE_BYTES:
                s = f"{line} {i}\n"
                f.write(s)
                n += len(s)
                i += 1


def rss_now(tot):
    """Resident set right now (root + descendants), bytes. Not the cgroup's
    memory.current: that includes page cache from the files the lane reads."""
    return (tot["main"].get("footprint") or 0) + (tot["desc"].get("footprint") or 0)


def mirror_bytes(tmpdir):
    """Bytes in #1405's tool-output mirror files under the run's TMPDIR."""
    total = 0
    for root, _, files in os.walk(tmpdir):
        if os.path.basename(root).startswith("kimchi-tool-outputs-"):
            total += sum(os.path.getsize(os.path.join(root, f)) for f in files)
    return total


def home_footprint(home):
    """Disk footprint of the kimchi config tree at lane end: total bytes,
    plus bytes per top-level entry under harness/ (the pr-cost-reporting
    dir's growth is where state.json bloat shows up — the number the bulk-
    out-of-state.json work will be judged on)."""
    cfg = os.path.join(home, ".config", "kimchi")
    agent = os.path.join(cfg, "harness")
    out = {"total": 0}
    for root, _dirs, files in os.walk(cfg):
        for f in files:
            try:
                n = os.path.getsize(os.path.join(root, f))
            except OSError:
                continue
            out["total"] += n
            if root == agent:
                out["(harness)"] = out.get("(harness)", 0) + n
            elif root.startswith(agent + os.sep):
                top = os.path.relpath(root, agent).split(os.sep)[0]
                out[top] = out.get(top, 0) + n
    return out


def run_bigtools(binary, env, cwd, srv_state, turns=BIGTOOLS_TURNS, reads=BIGTOOLS_READS):
    """Advisory lane (never gated): many large tool results in one live session.

    Each turn the fake model calls `read` on `reads` distinct ~50 KB files, then
    answers. Records work and resident memory after every turn (growth per
    turn), peak memory, how many bytes #1405's store mirrored to disk
    (engagement), and the smallest tool result the model received per request
    (hydration: a marker leaking to the model would show as ~100 chars).
    """
    argv = [binary, "--provider", "fake", "--model", "basic"]
    tp, sampler, cg = launch(env, cwd, argv, "bigtools")
    pid = tp.proc.pid
    res = {"ok": False, "turns": []}
    try:
        t_spawn = time.time()
        if not tp.wait_for(READY_MARKERS, 90):
            res["error"] = "ready marker not seen"
            res["exit_code"] = tp.proc.poll()
            res["screen_tail"] = tp.plain()[-1200:]
            return res
        res["ready_s"] = time.time() - t_spawn
        time.sleep(3)
        sampler.sample()
        base = sampler.totals()
        base_instr = flatten_total(base)["instr"] or 0
        res["rss_start"] = rss_now(base)
        srv_state.reset_tool_stats()
        for turn in range(turns):
            tok = f"{random.randrange(10**8):08d}"
            start = len(tp.plain())
            t = time.time()
            tp.send(f"BIGTOOLS turn={turn} reads={reads} TOK{tok}")
            time.sleep(0.3)
            tp.send("\r")
            if not tp.wait_for([f"BENCH_DONE_{tok}"], 180, start):
                res["error"] = f"bigtools turn {turn} marker not seen"
                res["screen_tail"] = tp.plain()[-1200:]
                return res
            turn_s = time.time() - t
            time.sleep(1)
            sampler.sample()
            cur = sampler.totals()
            res["turns"].append({"turn": turn, "turn_s": round(turn_s, 3),
                                 "instr": (flatten_total(cur)["instr"] or 0) - base_instr,
                                 "rss": rss_now(cur)})
        time.sleep(2)
        sampler.sample()
        end = sampler.totals()
        res["total"] = flatten_total(end)
        res["work_instr"] = (res["total"]["instr"] or 0) - base_instr
        res["peak_mem"] = peak_mem(end)
        res["rss_end"] = rss_now(end)
        res["mirror_bytes"] = mirror_bytes(env["TMPDIR"])
        res.update(srv_state.tool_stats())
        res["counter"] = counter_tier(end)
        expected = turns * reads
        if res.get("tool_results_seen", 0) < expected:
            res["error"] = f"model saw {res.get('tool_results_seen', 0)} tool results, expected {expected}"
            return res
        res["ok"] = True
        # Post-idle tail: #1405's adaptive GC fires after KIMCHI_IDLE_GC_DELAY_MS
        # (default 120 s) of idle; sample again past it. Pre-#1405 builds have
        # no idle GC — the retained-memory contrast between the two variants
        # (with and without the tool-output store) is the point of this wait.
        time.sleep(130)
        sampler.sample()
        tail = sampler.totals()
        res["rss_after_idle"] = rss_now(tail)
        res["instr_idle_tail"] = (flatten_total(tail)["instr"] or 0) - (res["total"]["instr"] or 0)
    finally:
        cleanup(tp, pid, sampler, cg)
    res["home_bytes"] = home_footprint(env["HOME"])
    return res


def probe_keylat(tp, timeout_s=5.0):
    """Time one keystroke's echo: send a char, wait for the first PTY output,
    erase it. None on timeout."""
    quiet_until = time.time() + 0.3  # let unrelated output drain first
    # The drain extends while output keeps arriving, but a pathologically chatty
    # TUI must not hang the probe (and the whole idle bucket loop) forever:
    # cap the drain, then time the echo regardless.
    quiet_cap = time.time() + 5.0
    while time.time() < quiet_until and time.time() < quiet_cap:
        n0 = tp.bytes_out()
        time.sleep(0.05)
        if tp.bytes_out() != n0:
            quiet_until = time.time() + 0.3
    n0 = tp.bytes_out()
    t = time.perf_counter()
    tp.send("x")
    deadline = t + timeout_s
    while tp.bytes_out() == n0 and time.perf_counter() < deadline:
        time.sleep(0.002)
    if tp.bytes_out() == n0:
        return None
    lat = (time.perf_counter() - t) * 1000
    tp.send("\x7f")
    time.sleep(0.05)
    return lat


def counter_tier(tot):
    """Which work counter this run actually measured. Recorded per run and
    cross-checked against the budgets' calibration tier — a silent tier
    drift would compare incomparable numbers. The cgroup tiers are the
    kernel-exact ones; per-pid tiers remain for local sampling fallback."""
    cg = (tot or {}).get("cg") or {}
    if cg.get("instr", 0) > 0:
        return "cgroup-instructions"
    if cg.get("cycles", 0) > 0:
        return "cgroup-cycles"
    if cg.get("cpu_ms", 0) > 0:
        return "cgroup-cpu_ms"
    main = (tot or {}).get("main") or {}
    if main.get("instr", 0) > 0:
        return "instructions"
    if main.get("cycles", 0) > 0:
        return "cycles"
    return "cpu_ms"


def run_idle(binary, env, cwd, srv_state, total_s=70, bucket_s=10.0, stuck_s=60):
    """Aged HOME, idle. Gate: per-pass instr, reads, children, keystroke p95.

    Keystroke echo latency — the one wall-clock metric, measured on a
    single-tenant runner VM — is probed throughout the idle window: type a
    char, time the first PTY bytes back (its echo), erase it. The reconcile
    pass blocking the event loop shows up directly as echo latency.

    Two phases, tagged per bucket via `"p"`:
    1. the aged state as seeded — a queue whose uploads are refused with
       403 (the key verifies but lacks upload permission), so a reconcile
       schedule occupied by real due work is the measured steady state;
    2. `retire_queue_retries` moves every retry deadline past the window —
       the queue is still full and the endpoint still refuses, but nothing
       is due. A gate that honours the retry schedule shows background work
       collapse after the single change-absorbing pass; anything that re-runs
       the cycle on its own timer (the #1529 class) keeps paying full passes.
    """
    argv = [binary, "--provider", "fake", "--model", "basic"]
    t0 = time.time()
    tp, sampler, cg = launch(env, cwd, argv, "idle")
    pid = tp.proc.pid
    res = {"ok": False, "buckets": [], "keylat_ms": [], "keylat_slow": []}
    try:
        if not tp.wait_for(READY_MARKERS, 120):
            res["error"] = "ready marker not seen"
            res["exit_code"] = tp.proc.poll()  # 87: cgroup join failed (wrap())
            res["screen_tail"] = tp.plain()[-1200:]
            return res
        res["ready_s"] = time.time() - t0
        sampler.sample()
        prev = sampler.totals()
        prev_routes, _ = srv_state.snapshot()

        def window(phase, seconds):
            n = int(seconds / bucket_s)
            nonlocal prev, prev_routes
            for _ in range(n):
                deadline = time.time() + bucket_s
                while time.time() < deadline:
                    t_probe = time.time() - t0
                    lat = probe_keylat(tp)
                    if lat is not None:
                        res["keylat_ms"].append(lat)
                        if lat > KEYLAT_SLOW_MS:
                            # when it happened (s since launch) and in which phase,
                            # so one-off stalls can be tied to a background pass
                            res["keylat_slow"].append({"t": round(t_probe, 2), "p": phase,
                                                       "ms": round(lat, 1)})
                    time.sleep(1.2)
                sampler.sample()
                cur = sampler.totals()
                routes, _ = srv_state.snapshot()
                d = delta(prev, cur)
                d["t"] = round(time.time() - t0, 1)
                d["p"] = phase
                d["requests"] = sum(routes.values()) - sum(prev_routes.values())
                d["n_children"] = cur["n_children"]
                res["buckets"].append(d)
                prev, prev_routes = cur, routes

        window(1, total_s)
        if stuck_s > 0:
            # Engagement invariant for the selfcheck: the queue's state file must
            # have moved BEFORE the retire step — after it, state.json changes for
            # free regardless of whether a pass ever ran.
            sp = os.path.join(env["HOME"], ".config", "kimchi", "harness", "pr-cost-reporting", "state.json")
            res["state_at_retire"] = hashlib.sha256(open(sp, "rb").read()).hexdigest() if os.path.exists(sp) else None
            fixtures.retire_queue_retries(env["HOME"])
            window(2, stuck_s)
        # Wall-clock length of what the gated sums actually cover: the
        # extractors skip each phase's first bucket (startup / the
        # change-absorbing pass), so per-minute normalisation must use the
        # same span — bucket count minus one, times the bucket length.
        res["window_s"] = {str(p): max(0, len([b for b in res["buckets"] if b.get("p", 1) == p]) - 1) * bucket_s
                            for p in (1, 2)}
        res["uploads_accepted"] = srv_state.uploads_accepted  # healthy lane: proof the queue drained
        res["peak_mem"] = peak_mem(prev)
        res["pids_peak"] = (prev.get("cg") or {}).get("pids_peak", 0)
        res["child_names"] = prev["child_names"]  # advisory: sampled; names for debugging only
        res["counter"] = counter_tier(prev)
        lat = sorted(res.pop("keylat_ms"))
        if lat:
            res["keylat_p50_ms"] = lat[len(lat) // 2]
            res["keylat_p95_ms"] = lat[max(0, int(len(lat) * 0.95) - 1)]
            res["keylat_max_ms"] = lat[-1]
            res["keylat_over_100ms"] = sum(1 for x in lat if x > 100)
        res["ok"] = True
    finally:
        cleanup(tp, pid, sampler, cg)
    res["home_bytes"] = home_footprint(env["HOME"])
    sj = os.path.join(env["HOME"], ".config", "kimchi", "harness", "pr-cost-reporting", "state.json")
    res["state_json_bytes"] = os.path.getsize(sj) if os.path.exists(sj) else None
    return res


def pick_counters(tot):
    """Work counters at a snapshot: exact tree aggregates with the cgroup
    backend, main+descendant sums on the sampling tier."""
    cg = tot.get("cg") or {}
    if cg:
        return {"instr": cg.get("instr"), "cycles": cg.get("cycles"),
                "cpu_ms": cg.get("cpu_ms"),
                "disk_r": tot["main"].get("disk_r"), "disk_w": tot["main"].get("disk_w")}
    main, desc = tot["main"], tot["desc"]
    return {k: (main.get(k) or 0) + (desc.get(k) or 0)
            for k in ("instr", "cycles", "cpu_ms", "disk_r", "disk_w")}


def peak_mem(tot):
    """Exact whole-tree peak RSS with the cgroup backend; else the root's
    own lifetime-max footprint (sampling tier, children unmeasured)."""
    cg = tot.get("cg") or {}
    return cg.get("mem_peak") or tot["main"].get("max_footprint")


def flatten_total(tot):
    cg = tot.get("cg") or {}
    main, desc = tot["main"], tot["desc"]
    exact = bool(cg)
    return {"instr": cg.get("instr") if exact else (main.get("instr") or 0) + desc.get("instr", 0),
            "cycles": cg.get("cycles") if exact else (main.get("cycles") or 0) + desc.get("cycles", 0),
            "cpu_ms": cg.get("cpu_ms") if exact else (main.get("cpu_ms") or 0) + desc.get("cpu_ms", 0),
            "disk_w": main.get("disk_w"), "disk_r": main.get("disk_r"),
            "logical_w": main.get("logical_w"), "peak_mem": peak_mem(tot),
            "pids_peak": cg.get("pids_peak", 0),
            "child_cpu_ms": main.get("child_cpu_ms"),
            "n_children": tot["n_children"], "child_names": tot["child_names"]}


def cleanup(tp, pid, sampler, cg=None):
    try:
        tp.send("/quit\r")
        wait_zombie(pid, 10)
    except Exception:
        pass
    if not sampler.stop_ev.is_set():
        sampler.stop()
    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:
        pass
    tp.proc.wait()
    tp.close()
    if cg is not None:
        cg.close()


# ---------------------------------------------------------------- driver
def prepare(root, scenario, base_url, session_target_mb=8, binary=None):
    """Build the per-rep environment for one scenario. Returns (env, cwd)."""
    home = os.path.join(root, "home")
    wd = os.path.join(root, "work")
    tmpdir = os.path.join(root, "tmp")
    os.makedirs(tmpdir, exist_ok=True)
    if scenario in ("idle", "idle_healthy"):
        repos = [os.path.join(root, "repos", f"repo{i}") for i in range(REPOS)]
        for i, r in enumerate(repos):
            fixtures.make_repo(r, f"repo{i}", commits=4 + i % 3)
        fixtures.aged_home(home, base_url, repos)
        wd = make_workdir(os.path.join(root, "wdroot"))
    else:
        fixtures.seed_clean_home(home, base_url)
        wd = make_workdir(os.path.join(root, "wdroot"))
        if scenario == "resume":
            sdir = session_dir(home, wd)
            os.makedirs(sdir, exist_ok=True)
            fixtures.write_big_session(os.path.join(sdir, "bench-session.jsonl"),
                                       os.path.realpath(wd), target_bytes=session_target_mb * 1024 * 1024)
        if scenario in BIGTOOLS_VARIANTS:
            write_bigtools_files(wd)
    env = child_env(home, base_url, tmpdir, binary)
    env.update(BIGTOOLS_VARIANTS.get(scenario, {}))
    return env, wd


def selfcheck(binary, session_mb=2, idle_s=20):
    """Assert the harness itself works: fixtures are deterministic, product
    validators pass, and all three scenarios run green against the binary.

    This is the test suite for a tool with no other tests (no Python test
    infra in the repo); it also catches fixture drift against the product's
    schemas before it degrades the gate into measuring nothing.
    """
    import hashlib

    root = tempfile.mkdtemp(prefix="kperf-selfcheck-")
    failures = []
    home = None
    try:
        if os.environ.get("KIMCHI_PERF_REQUIRE_EXACT") == "1":
            probe = GateCgroup.create(f"perf-gate-selfcheck-{os.getpid()}")
            if probe is None:
                failures.append("exact cgroup backend unavailable (sudo? controllers? per-CPU perf attach?)")
            else:
                probe.close()
        # (create() itself refuses the backend when pids.peak is unreadable,
        # so the old-kernel case lands in the failure above)
        # 1. session fixture: byte-identical regeneration
        hashes = []
        for run in range(2):
            p = os.path.join(root, f"sess{run}.jsonl")
            fixtures.write_big_session(p, "/tmp/wd", target_bytes=session_mb * 1024 * 1024)
            hashes.append(hashlib.sha256(open(p, "rb").read()).hexdigest())
        if hashes[0] != hashes[1]:
            failures.append("session fixture not deterministic")
        # 2. aged fixture + git repos: byte-identical regeneration into the same root
        # (repo dirs are wiped first: make_repo appends to worktree files)
        repo_heads, ledger_shas, state_shas = [], [], []
        for _ in range(2):
            home = os.path.join(root, "home")
            shutil.rmtree(home, ignore_errors=True)
            for i in range(2):
                shutil.rmtree(os.path.join(root, f"repo{i}"), ignore_errors=True)
                shutil.rmtree(os.path.join(root, f"repo{i}-home"), ignore_errors=True)
            repos = [fixtures.make_repo(os.path.join(root, f"repo{i}"), f"repo{i}", commits=4) for i in range(2)]
            db = fixtures.aged_home(home, "http://127.0.0.1:1", repos)
            repo_heads.append([subprocess.run(["git", "-C", r, "log", "--format=%H"],
                                              capture_output=True, text=True).stdout for r in repos])
            ledger_shas.append(hashlib.sha256(open(db, "rb").read()).hexdigest())
            sp = os.path.join(home, ".config", "kimchi", "harness", "pr-cost-reporting", "state.json")
            state_shas.append(hashlib.sha256(open(sp, "rb").read()).hexdigest())
        if repo_heads[0] != repo_heads[1]:
            failures.append("git fixture not deterministic (commit hashes differ across regenerations)")
        if ledger_shas[0] != ledger_shas[1]:
            failures.append("aged ledger not deterministic across regenerations")
        if state_shas[0] != state_shas[1]:
            failures.append("reporting state not deterministic across regenerations")
        ledger = ledger_shas[0]
        # 3. product validators accept the fixture (bun required; skip silently outside a checkout)
        validator = os.path.join(os.path.dirname(os.path.abspath(__file__)), "validate-fixture.ts")
        if os.path.isfile(validator) and shutil.which("bun"):
            pc = os.path.join(home, ".config", "kimchi", "harness", "pr-cost-reporting")
            p = subprocess.run(["bun", "run", validator, pc], capture_output=True, text=True)
            if p.returncode != 0:
                failures.append(f"product validators rejected the fixture: {p.stdout} {p.stderr}")
        # 4. one short rep per scenario (gated three + the healthy idle lane:
        #    its queue must drain within the window, proving the accept regime)
        srv, state, base = fakellm.start()
        try:
            for sc in ("session", "resume", "idle", "idle_healthy"):
                rep_root = os.path.join(root, f"smoke-{sc}")
                os.makedirs(rep_root)
                state_before = None
                routes_before = None
                env, cwd = prepare(rep_root, sc, base, session_mb, binary=binary)
                if not check_version(binary, env, cwd):
                    failures.append(f"{sc}: binary reports no version")
                    continue
                if sc == "session":
                    r = run_session(binary, env, cwd, state)
                elif sc == "resume":
                    r = run_resume(binary, env, cwd, state)
                else:
                    sp = os.path.join(rep_root, "home", ".config", "kimchi", "harness", "pr-cost-reporting", "state.json")
                    state_before = open(sp, "rb").read() if os.path.exists(sp) else None
                    routes_before, _ = state.snapshot()
                    # healthy idle: uploads acknowledged; a short window is enough
                    # to prove the queue drains. Gated idle keeps its phases.
                    state.accept_uploads = sc == "idle_healthy"
                    r = (run_idle(binary, env, cwd, state, 20, stuck_s=0) if sc == "idle_healthy"
                         else run_idle(binary, env, cwd, state, idle_s))
                    state.accept_uploads = False
                if not r.get("ok", False):
                    failures.append(f"{sc}: {r.get('error')}\n{r.get('screen_tail', '')[-400:]}")
                # new advisory fields must be present in every green record
                if r.get("ok", False):
                    if "home_bytes" not in r:
                        failures.append(f"{sc}: record lacks home_bytes")
                    if sc == "session" and "startup" not in r:
                        failures.append("session: record lacks startup")
                    if sc in ("idle", "idle_healthy") and "window_s" not in r:
                        failures.append(f"{sc}: record lacks window_s")
                # engagement: the aged reporting queue must actually run — its
                # state file is rewritten (upload-refusal backoff) when the pass
                # engages. Compare against the state captured BEFORE the retire
                # step: retirement itself rewrites state.json, so post-run
                # content can no longer prove engagement.
                if sc == "idle" and state_before is not None:
                    sp = os.path.join(rep_root, "home", ".config", "kimchi", "harness", "pr-cost-reporting", "state.json")
                    after = open(sp, "rb").read() if os.path.exists(sp) else None
                    engaged = r.get("state_at_retire")
                    unchanged = (engaged == hashlib.sha256(state_before).hexdigest()) if engaged is not None else (after == state_before)
                    if unchanged:
                        failures.append("idle: reporting queue never engaged before retire (state.json unchanged; fixture drift?)")
                    # forbidden regime: the worker passes the account check, so a
                    # snapshot upload must have reached the server (and been refused)
                    routes_after, _ = state.snapshot()
                    posted = sum(n for k, n in routes_after.items()
                                 if k.startswith("POST ") and "/pr-cost-snapshots" in k)
                    posted_before = sum(n for k, n in (routes_before or {}).items()
                                         if k.startswith("POST ") and "/pr-cost-snapshots" in k)
                    if posted - posted_before < 1:
                        failures.append("idle: no snapshot upload reached the server "
                                        "(worker never passed the account check?)")
                if sc == "idle_healthy":
                    if r.get("uploads_accepted", 0) < 1:
                        failures.append("idle_healthy: no upload accepted (queue did not drain?)")
        finally:
            srv.shutdown()
            srv.server_close()
        print(f"session sha {hashes[0][:16]}  ledger sha {ledger[:16]}")
        if failures:
            raise SystemExit("SELFCHECK FAILED:\n- " + "\n- ".join(failures))
        print("selfcheck OK: fixtures deterministic, validators green, scenarios green")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True, help="kimchi binary (dist/bin/kimchi or a release tree's bin/kimchi)")
    ap.add_argument("--scenario", choices=["session", "resume", "idle", *IDLE_VARIANTS, *BIGTOOLS_VARIANTS])
    ap.add_argument("--selfcheck", action="store_true",
                    help="verify the harness: fixture determinism, product validators, one smoke rep per scenario")
    ap.add_argument("--out", default=None)
    ap.add_argument("--workroot", default=None)
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--idle", type=float, default=90.0, help="idle scenario window (s; whole 30s pass periods)")
    ap.add_argument("--stuck", type=float, default=60.0, help="idle stuck-queue phase window (s; 0 disables the phase)")
    ap.add_argument("--session-mb", type=int, default=8,
                    help="resume fixture session size in MB (8 for local, 31 in CI)")
    ap.add_argument("--expect-version", default=None,
                    help="refuse to measure unless the binary self-reports this version (CI passes the built tree's)")
    args = ap.parse_args()
    args.binary = os.path.abspath(args.binary)

    # Let SIGTERM (job timeout, cancel) unwind through the finally blocks so
    # the measured process tree is killed and the workroot removed. Re-arm the
    # default disposition first: a second SIGTERM arriving mid-cleanup (e.g.
    # while cg.close() drains strays) must kill outright, not re-enter the
    # handler and abort the teardown halfway.
    def _sigterm(*_):
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        sys.exit(1)
    signal.signal(signal.SIGTERM, _sigterm)

    if args.selfcheck:
        selfcheck(args.binary)
        return
    if not args.scenario or not args.out:
        raise SystemExit("--scenario and --out are required (or use --selfcheck)")

    srv, state, base = fakellm.start()
    # Healthy idle: the platform acknowledges uploads, so the aged queue drains.
    # Every lane runs the default "forbidden" upload regime (key verifies,
    # uploads get 403); session/resume never reach the upload routes either way.
    state.accept_uploads = args.scenario == "idle_healthy"
    state.upload_failure = "forbidden"
    git_version = subprocess.run(["git", "--version"], capture_output=True, text=True).stdout.strip()
    root = os.path.realpath(args.workroot or tempfile.mkdtemp(prefix="kperf-"))
    os.makedirs(root, exist_ok=True)
    print(f"workroot {root}", flush=True)
    versions = set()
    host = host_info()
    try:
        with open(args.out, "a") as out:
            for rep in range(args.reps):
                rep_root = os.path.join(root, f"rep{rep}")
                shutil.rmtree(rep_root, ignore_errors=True)
                os.makedirs(rep_root)
                env, cwd = prepare(rep_root, args.scenario, base, args.session_mb, binary=args.binary)
                version = check_version(args.binary, env, cwd)
                if not version:
                    raise SystemExit("binary reports no version; refusing to benchmark")
                if args.expect_version and version != args.expect_version:
                    raise SystemExit(f"binary reports version {version!r}, expected {args.expect_version!r}; "
                                     "refusing to benchmark (stale re-exec?)")
                versions.add(version)
                if args.scenario == "session":
                    r = run_session(args.binary, env, cwd, state)
                elif args.scenario == "resume":
                    r = run_resume(args.binary, env, cwd, state)
                elif args.scenario in BIGTOOLS_VARIANTS:
                    r = run_bigtools(args.binary, env, cwd, state)
                elif args.scenario in IDLE_VARIANTS:
                    # one window, no stuck phase: there is no failing queue to retire
                    r = run_idle(args.binary, env, cwd, state, args.idle, stuck_s=0)
                else:
                    r = run_idle(args.binary, env, cwd, state, args.idle, stuck_s=args.stuck)
                r.update({"scenario": args.scenario, "rep": rep, "version": version, "git": git_version,
                          "host": host})
                out.write(json.dumps(r) + "\n")
                out.flush()
                total = r.get("total") or {}
                print(f"rep{rep} {args.scenario} ok={r.get('ok', False)} "
                      f"instr={total.get('instr', r.get('load', {}).get('instr', 0) or 0)} "
                      f"dw={total.get('disk_w', 0) / 1e6 if total.get('disk_w') else 0:.2f}MB "
                      f"{r.get('error', '')}", flush=True)
                if not r.get("ok", False):
                    raise SystemExit(f"scenario {args.scenario} rep {rep} failed: {r.get('error')}")
        if len(versions) > 1:
            raise SystemExit(f"binary reported different versions across reps: {sorted(versions)}")
    finally:
        srv.shutdown()
        srv.server_close()
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
