#!/usr/bin/env python3
"""Measure ledger operations with an externally attached hardware counter.

The measured tree's source is unmodified: the driver (ledger-bench.ts) imports
its own tree's ledger modules and prints BENCH_OP markers; this harness
attaches the per-process perf_event_open instruction counter to the driver
from outside and reads it at each marker. The delta between an operation's
begin and end markers is that operation's whole-process instruction cost —
its synchronous work across all internal continuations, waiting excluded by
construction (nothing else runs in the process). No source instrumentation,
no async hooks, no latency threshold, no budgets.

Failures are reported, never substituted: a counter that cannot attach, a
driver crash, or a dangling begin marker is an explicit measurement error.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sampler import PERF_COUNT_HW_INSTRUCTIONS, perf_open, perf_read  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", required=True, help="checkout whose own ledger modules get measured")
    ap.add_argument("--ref", required=True, help="label recorded with each result")
    ap.add_argument("--out", required=True, help="JSONL output for per-rep instruction counts")
    ap.add_argument("--records", type=int, default=100_000, help="work records seeded (gate ledger scale)")
    ap.add_argument("--entities", type=int, default=5_000, help="outbox entities claim-resolved per rep")
    ap.add_argument("--repos", type=int, default=20)
    ap.add_argument("--reps", type=int, default=3)
    args = ap.parse_args()

    workdir = tempfile.mkdtemp(prefix="ledger-bench-")
    agent = os.path.join(workdir, "agent")
    env = {**os.environ,
           "KIMCHI_BENCH_RECORDS": str(args.records),
           "KIMCHI_BENCH_ENTITIES": str(args.entities),
           "KIMCHI_BENCH_REPOS": str(args.repos),
           "KIMCHI_BENCH_REPS": str(args.reps)}
    proc = subprocess.Popen(
        ["bun", "tools/perf/ledger-bench.ts", agent], cwd=args.tree, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    fd = perf_open(proc.pid, PERF_COUNT_HW_INSTRUCTIONS)
    if fd is None:
        proc.kill()
        shutil.rmtree(workdir, ignore_errors=True)
        raise SystemExit("perf counter attach failed; refusing to report an invented measurement")
    begun, results, problems = {}, [], []
    for line in proc.stdout:
        line = line.rstrip("\n")
        parts = line.split(" ")
        if parts[0] == "BENCH_OP" and len(parts) == 5:
            _, op, rep, phase = parts[1], parts[2], parts[3], parts[4]
            if phase == "begin":
                begun[(op, rep)] = perf_read(fd)
            elif phase == "end":
                start = begun.pop((op, rep), None)
                if start is None:
                    problems.append(f"{op} rep {rep}: end marker without begin")
                else:
                    results.append({"ref": args.ref, "op": op, "rep": int(rep),
                                    "instructions": perf_read(fd) - start})
        elif parts[0] == "BENCH_ERROR":
            problems.append(line)
        elif line:
            print(line, flush=True)
    rc = proc.wait()
    os.close(fd)
    shutil.rmtree(workdir, ignore_errors=True)
    for key in sorted(begun):
        problems.append(f"{key[0]} rep {key[1]}: begin marker never closed (driver died mid-operation?)")
    if rc != 0:
        problems.append(f"driver exited {rc}")
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "a", encoding="utf-8") as out:
        for row in results:
            out.write(json.dumps(row) + "\n")
        out.write(json.dumps({"ref": args.ref, "problems": problems,
                              "samples": len(results)}) + "\n")
    print(json.dumps({"ref": args.ref, "samples": len(results), "problems": problems}), flush=True)
    if problems or not results:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
