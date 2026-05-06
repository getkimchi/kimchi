#!/usr/bin/env python3
"""Check whether all runs in a benchmark session have completed.

Completion is determined by examining session log files (.jsonl) for terminal
events — not by checking OS processes.  A run is considered done when its log
contains an `agent_end` or `agent_terminated` entry.  A run is considered
stalled when its log file has not been modified for longer than a configurable
inactivity threshold (default: 3 minutes).

Exit codes:
  0 — all runs finished (either ended or terminated)
  1 — some runs are still in progress
  2 — error (missing session, no runs, etc.)

Output: one status line per run, then a summary.
"""

import json
import os
import sys
import time
from pathlib import Path

IMPROVEMENT_DIR = Path(__file__).parent
SESSIONS_DIR = IMPROVEMENT_DIR / "sessions"

INACTIVITY_THRESHOLD_S = 180  # 3 minutes with no log writes → stalled


def check_jsonl(path: Path) -> dict:
    has_agent_end = False
    has_terminated = False
    has_prompt_summary = False
    last_ts = None
    line_count = 0

    with open(path) as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            line_count += 1
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue

            custom_type = event.get("customType", "")
            if custom_type == "prompt-summary":
                has_prompt_summary = True

            entry_type = event.get("type", "")
            if entry_type == "agent_end" or custom_type == "agent_end":
                has_agent_end = True
            if entry_type == "agent_terminated" or custom_type == "agent_terminated":
                has_terminated = True

            ts = event.get("timestamp")
            if ts:
                last_ts = ts

    mtime = path.stat().st_mtime
    age_s = time.time() - mtime

    return {
        "file": str(path),
        "lines": line_count,
        "has_agent_end": has_agent_end,
        "has_terminated": has_terminated,
        "has_prompt_summary": has_prompt_summary,
        "file_age_s": round(age_s, 1),
        "stalled": age_s > INACTIVITY_THRESHOLD_S and not has_agent_end and not has_terminated,
    }


def find_latest_jsonl(run_dir: Path) -> Path | None:
    jsonls = sorted(run_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    return jsonls[-1] if jsonls else None


def resolve_session(arg: str) -> Path:
    if arg.isdigit():
        return SESSIONS_DIR / f"session-{int(arg):02d}"
    return SESSIONS_DIR / arg


def main():
    if len(sys.argv) >= 2:
        session_dir = resolve_session(sys.argv[1])
    else:
        sessions = sorted(
            (d for d in SESSIONS_DIR.iterdir() if d.is_dir() and d.name.startswith("session-")),
            key=lambda d: d.name,
        ) if SESSIONS_DIR.exists() else []
        if not sessions:
            print("No sessions found.", file=sys.stderr)
            sys.exit(2)
        session_dir = sessions[-1]

    runs_dir = session_dir / "runs"
    if not runs_dir.exists():
        print(f"No runs directory in {session_dir}", file=sys.stderr)
        sys.exit(2)

    run_dirs = sorted(d for d in runs_dir.iterdir() if d.is_dir())
    if not run_dirs:
        print(f"No run directories in {runs_dir}", file=sys.stderr)
        sys.exit(2)

    results = {}
    for run_dir in run_dirs:
        jsonl = find_latest_jsonl(run_dir)
        if jsonl:
            results[run_dir.name] = check_jsonl(jsonl)
        else:
            results[run_dir.name] = {
                "file": None,
                "lines": 0,
                "has_agent_end": False,
                "has_terminated": False,
                "has_prompt_summary": False,
                "file_age_s": 0,
                "stalled": False,
                "no_log": True,
            }

    finished = 0
    stalled = 0
    in_progress = 0
    no_log = 0

    print(f"Session: {session_dir.name}")
    print("=" * 60)

    for name, info in sorted(results.items()):
        if info.get("no_log"):
            status = "NO LOG"
            no_log += 1
        elif info["has_agent_end"]:
            status = "DONE"
            finished += 1
        elif info["has_terminated"]:
            status = "TERMINATED"
            finished += 1
        elif info["stalled"]:
            status = f"STALLED (no writes for {info['file_age_s']:.0f}s)"
            stalled += 1
        else:
            status = f"IN PROGRESS (last write {info['file_age_s']:.0f}s ago)"
            in_progress += 1

        print(f"  {name}: {status}")

    total = len(results)
    print()
    print(f"Total: {total}  Done: {finished}  Stalled: {stalled}  In progress: {in_progress}  No log: {no_log}")

    all_done = finished + stalled == total and in_progress == 0 and no_log == 0
    if all_done:
        if stalled > 0:
            print(f"\nAll runs finished but {stalled} stalled — their processes should be killed.")
        else:
            print("\nAll runs completed.")
        sys.exit(0)
    else:
        print(f"\n{in_progress + no_log} run(s) still in progress.")
        sys.exit(1)


if __name__ == "__main__":
    main()
