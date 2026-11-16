#!/usr/bin/env python3
"""Measure raw CPU instructions per watchdog-observed blocking episode.

Identical session workloads on differently built binaries. No gate or budget:
results include raw p95/max/total/count plus explicit measurement failures.
"""
import argparse
import json
import os
import shutil

import fakellm
from scenarios import check_version, host_info, prepare, run_session


def episode_stats(path):
    """Read one process's private trace; zero episodes are absent, not healthy."""
    try:
        with open(path, encoding="utf-8") as stream:
            records = [json.loads(line) for line in stream if line.strip()]
    except (OSError, ValueError) as error:
        return {"blocking_measurement": "error", "blocking_instr_error": str(error)}
    failures = [record for record in records
                if record.get("event") in ("blocking.instr.unsupported", "blocking.instr.error",
                                           "blocking.instr.truncated")]
    summaries = [record for record in records if record.get("event") == "blocking.instr.summary"]
    if failures:
        reason = failures[-1].get("reason") or failures[-1].get("event")
        return {"blocking_measurement": "error", "blocking_instr_error": reason}
    if len(summaries) != 1:
        return {"blocking_measurement": "error",
                "blocking_instr_error": f"expected one summary, found {len(summaries)}"}
    summary = summaries[-1]
    if not summary.get("samples"):
        return {"blocking_measurement": "no_episodes", "blocking_instr_samples": 0}
    return {
        "blocking_measurement": "ok",
        "blocking_instr_p95": summary["p95"],
        "blocking_instr_max": summary["max"],
        "blocking_instr_total": summary["total"],
        "blocking_instr_samples": summary["samples"],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--reps", type=int, default=1)
    args = parser.parse_args()
    if args.reps < 1:
        parser.error("--reps must be positive")
    root = os.path.abspath(os.path.join(args.out + ".work"))
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    host = host_info()
    failed = False
    with open(args.out, "a", encoding="utf-8") as output:
        for rep in range(args.reps):
            rep_root = os.path.join(root, f"rep{rep}")
            shutil.rmtree(rep_root, ignore_errors=True)
            state = None
            trace_path = os.path.join(rep_root, "blocking-instructions.jsonl")
            try:
                server, state, base_url = fakellm.start()
                env, cwd = prepare(rep_root, "session", base_url, binary=os.path.abspath(args.binary))
                env["KIMCHI_BLOCKING_INSTRUMENT"] = trace_path
                result = run_session(os.path.abspath(args.binary), env, cwd, state)
                result["version"] = check_version(args.binary, env, cwd)
            except Exception as error:
                result = {"ok": False, "error": str(error)}
            finally:
                if state is not None:
                    server.shutdown()
                    server.server_close()
            result.update(episode_stats(trace_path))
            if not result["ok"] or result["blocking_measurement"] == "error":
                failed = True
            result.update({"ref": args.ref, "rep": rep, "scenario": "session", "host": host})
            output.write(json.dumps(result) + "\n")
            output.flush()
            print(json.dumps({key: result.get(key) for key in
                              ("ref", "rep", "ok", "version", "blocking_measurement",
                               "blocking_instr_p95", "blocking_instr_max", "blocking_instr_total",
                               "blocking_instr_samples", "blocking_instr_error", "error")}), flush=True)
    shutil.rmtree(root, ignore_errors=True)
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
