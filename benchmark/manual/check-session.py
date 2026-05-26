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

INACTIVITY_THRESHOLD_S = 1800  # 30 minutes


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


def is_session_arg(arg: str) -> bool:
    """Return True if arg looks like a session identifier (digits or existing dir name)."""
    if arg.isdigit():
        return True
    return (SESSIONS_DIR / arg).is_dir()


def resolve_session(arg: str) -> Path:
    if arg.isdigit():
        return SESSIONS_DIR / f"session-{int(arg):02d}"
    return SESSIONS_DIR / arg


def check_jsonl_main(jsonl_paths: list[str]) -> bool:
    """Handle --jsonl mode: report status for each file and exit accordingly."""
    all_done = True
    for path_str in jsonl_paths:
        path = Path(path_str)
        if not path.exists():
            print(f"  {path.name}: NO LOG")
            all_done = False
            continue

        info = check_jsonl(path)
        if info["has_agent_end"]:
            status = "DONE"
        elif info["has_terminated"]:
            status = "TERMINATED"
        elif info["lines"] == 0:
            status = "NO LOG"
            all_done = False
        else:
            status = f"IN PROGRESS (last write {info['file_age_s']:.0f}s ago)"
            all_done = False
        print(f"  {path.name}: {status}")

    return all_done


def main():
    args = sys.argv[1:]

    # --- Check for --jsonl / -j flag (must be recognised before session-arg logic) ---
    jsonl_paths: list[str] = []
    remaining_args: list[str] = []
    jsonl_mode = False

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--jsonl", "-j") and not jsonl_mode:
            jsonl_mode = True
            i += 1
            continue
        if jsonl_mode:
            jsonl_paths.append(arg)
        else:
            remaining_args.append(arg)
        i += 1

    if jsonl_mode:
        if not jsonl_paths:
            print("ERROR: --jsonl requires at least one file path", file=sys.stderr)
            sys.exit(2)
        all_done = check_jsonl_main(jsonl_paths)
        sys.exit(0 if all_done else 1)

    # --- Original session-directory logic ---
    args = remaining_args
    session_dir = None
    task_filters: list[str] = []

    if args:
        # Collect leading args that look like session identifiers
        session_args: list[str] = []
        for arg in args:
            if is_session_arg(arg):
                session_args.append(arg)
            else:
                break

        if session_args:
            # Last session arg wins; rest are task filters
            session_dir = resolve_session(session_args[-1])
            task_filters = args[len(session_args):]
        else:
            # No session arg found — all args are task filters; use latest session
            task_filters = args

    if session_dir is None:
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

    total_runs = len(run_dirs)

    # Filter runs by exact directory-name match (case-insensitive)
    if task_filters:
        filters_lower = [f.lower() for f in task_filters]
        run_dirs = [
            d for d in run_dirs
            if d.name.lower() in filters_lower
        ]
        if not run_dirs:
            print("No runs matched the provided task filters.", file=sys.stderr)
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
    if task_filters:
        print(f"Showing {len(results)} of {total_runs} runs (filter: {', '.join(task_filters)})")
        print(f"Total: {len(results)}  Done: {finished}  Stalled: {stalled}  In progress: {in_progress}  No log: {no_log}")
    else:
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
