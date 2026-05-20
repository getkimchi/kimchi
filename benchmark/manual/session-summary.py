#!/usr/bin/env python3
"""Extract token usage summary from a kimchi session log."""

import json
import sys
from datetime import datetime
from pathlib import Path


def format_duration(ms: int) -> str:
    s = ms / 1000
    if s < 60:
        return f"{s:.1f}s"
    m = int(s // 60)
    rem = round(s % 60)
    return f"{m}m {rem}s"


def summarize(path: str):
    orch_input = orch_output = 0
    subagents = []
    start_ts = end_ts = None

    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue

            ts = e.get("timestamp")
            if ts:
                if start_ts is None:
                    start_ts = ts
                end_ts = ts

            if e.get("type") != "message":
                continue

            msg = e.get("message", {})
            role = msg.get("role", "")

            if role == "assistant":
                usage = msg.get("usage", {})
                orch_input += usage.get("input", 0)
                orch_output += usage.get("output", 0)

            if role == "toolResult" and msg.get("toolName") in {"Agent", "get_subagent_result"}:
                details = msg.get("details") or {}
                tu = details.get("tokenUsage", {})
                subagents.append({
                    "model": None,
                    "input": tu.get("input", 0),
                    "output": tu.get("output", 0),
                    "durationMs": details.get("durationMs", 0),
                })

    sub_input = sum(s["input"] for s in subagents)
    sub_output = sum(s["output"] for s in subagents)
    total_input = orch_input + sub_input
    total_output = orch_output + sub_output

    duration_ms = 0
    if start_ts and end_ts:
        t1 = datetime.fromisoformat(start_ts.replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(end_ts.replace("Z", "+00:00"))
        duration_ms = int((t2 - t1).total_seconds() * 1000)

    print(f"\nSession summary  ({format_duration(duration_ms)})")
    print(f"  {'orchestrator':<16} ↑{orch_input:>10,}   ↓{orch_output:>8,}   total {orch_input+orch_output:>10,}")
    if subagents:
        print(f"  {'subagents':<16} ↑{sub_input:>10,}   ↓{sub_output:>8,}   total {sub_input+sub_output:>10,}")
        for i, s in enumerate(subagents, 1):
            dur = format_duration(s["durationMs"])
            print(f"    [{i}] ↑{s['input']:>10,}   ↓{s['output']:>8,}   {dur}")
    print(f"  {'total':<16} ↑{total_input:>10,}   ↓{total_output:>8,}   total {total_input+total_output:>10,}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        # Find the most recent session log
        sessions_dir = Path.home() / ".config/kimchi/harness/sessions"
        logs = sorted(sessions_dir.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime)
        if not logs:
            print("No session logs found")
            sys.exit(1)
        path = str(logs[-1])
        print(f"Using: {path}")
    else:
        path = sys.argv[1]

    summarize(path)
