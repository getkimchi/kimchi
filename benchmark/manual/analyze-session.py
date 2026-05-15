#!/usr/bin/env python3
"""Analyze all runs in a benchmark session."""

import json
import subprocess
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

IMPROVEMENT_DIR = Path(__file__).parent
SESSIONS_DIR = IMPROVEMENT_DIR / "sessions"

TASK_CRITERIA = {
    "simple": {
        "min_subagents": 0,
        "max_subagents": 2,
        "max_tokens": 300_000,
        "max_duration_s": 300,
    },
    "complex": {
        "min_subagents": 1,
        "max_subagents": 5,
        "max_tokens": 700_000,
        "max_duration_s": 600,
    },
    "complex-single": {
        "min_subagents": 0,
        "max_subagents": 0,
        "max_tokens": 500_000,
        "max_duration_s": 600,
    },
    "research": {
        "min_subagents": 0,
        "max_subagents": 1,
        "max_tokens": 30_000,
        "max_duration_s": 120,
    },
    "mega": {
        "min_subagents": 3,
        "max_subagents": 6,
        "max_tokens": 800_000,
        "max_duration_s": 900,
    },
    "explore": {
        "min_subagents": 1,
        "max_subagents": 4,
        "max_tokens": 500_000,
        "max_duration_s": 600,
    },
}


def format_tokens(n):
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}m"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def parse_elapsed_to_seconds(elapsed_str):
    elapsed_str = elapsed_str.strip()
    if "m" in elapsed_str and "s" in elapsed_str:
        parts = elapsed_str.split("m")
        mins = int(parts[0].strip())
        secs = float(parts[1].replace("s", "").strip())
        return mins * 60 + secs
    if "s" in elapsed_str:
        return float(elapsed_str.replace("s", "").strip())
    return 0.0


def analyze_jsonl(path):
    summary_details = None
    subagent_count = 0
    orch_tool_calls = []
    terminated = False
    start_ts = end_ts = None
    orch_input = orch_output = 0
    sub_input = sub_output = 0

    with open(path) as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue

            ts = event.get("timestamp")
            if ts:
                if start_ts is None:
                    start_ts = ts
                end_ts = ts

            if event.get("customType") == "prompt-summary":
                summary_details = event.get("details", {})

            if event.get("customType") == "agent_terminated":
                terminated = True

            if event.get("type") == "message":
                msg = event.get("message", {})
                role = msg.get("role", "")
                if role == "toolResult" and msg.get("toolName") == "subagent":
                    subagent_count += 1
                    tu = (msg.get("details") or {}).get("tokenUsage") or {}
                    sub_input += tu.get("input", 0)
                    sub_output += tu.get("output", 0)
                if role == "assistant":
                    usage = msg.get("usage") or {}
                    orch_input += usage.get("input", 0)
                    orch_output += usage.get("output", 0)
                    for item in msg.get("content", []):
                        if item.get("type") == "toolCall" and item.get("name") != "subagent":
                            orch_tool_calls.append(item.get("name"))

    if summary_details:
        total = summary_details.get("total") or {}
        orch = summary_details.get("orchestrator") or {}
        subs = summary_details.get("subagents") or {}
        elapsed = summary_details.get("elapsed", "")
        duration_s = parse_elapsed_to_seconds(elapsed)
        return {
            "elapsed": elapsed,
            "duration_s": duration_s,
            "total_tokens": total.get("input", 0) + total.get("output", 0),
            "orch_tokens": orch.get("input", 0) + orch.get("output", 0),
            "sub_tokens": subs.get("input", 0) + subs.get("output", 0),
            "subagent_count": subagent_count,
            "orch_tool_calls": orch_tool_calls,
            "terminated": terminated,
        }

    if not start_ts or not end_ts or (orch_input + orch_output) == 0:
        return None

    t1 = datetime.fromisoformat(start_ts.replace("Z", "+00:00"))
    t2 = datetime.fromisoformat(end_ts.replace("Z", "+00:00"))
    duration_s = (t2 - t1).total_seconds()
    m, s = int(duration_s // 60), int(duration_s % 60)
    elapsed = f"{m}m {s}s" if m else f"{s}s"

    return {
        "elapsed": elapsed,
        "duration_s": duration_s,
        "total_tokens": orch_input + orch_output + sub_input + sub_output,
        "orch_tokens": orch_input + orch_output,
        "sub_tokens": sub_input + sub_output,
        "subagent_count": subagent_count,
        "orch_tool_calls": orch_tool_calls,
        "terminated": terminated,
    }


def task_from_run_name(run_name):
    for task in sorted(TASK_CRITERIA.keys(), key=len, reverse=True):
        if run_name.startswith(task):
            return task
    return None


def quality_checks(metrics, task):
    criteria = TASK_CRITERIA.get(task)
    if not criteria:
        return []

    checks = []
    sub = metrics["subagent_count"]
    min_s, max_s = criteria["min_subagents"], criteria["max_subagents"]

    if min_s == max_s == 0:
        if sub == 0:
            checks.append(("PASS", "no subagents spawned (expected: 0)"))
        else:
            checks.append(("FAIL", f"spawned {sub} subagent(s) (expected: 0)"))
    elif sub < min_s:
        checks.append(("WARN", f"subagents: {sub} (expected: {min_s}–{max_s})"))
    elif sub > max_s:
        checks.append(("WARN", f"subagents: {sub} (expected: {min_s}–{max_s})"))
    else:
        checks.append(("PASS", f"subagents: {sub} (expected: {min_s}–{max_s})"))

    total = metrics["total_tokens"]
    budget = criteria["max_tokens"]
    label = f"tokens: {format_tokens(total)} (budget: {format_tokens(budget)})"
    checks.append(("PASS" if total <= budget else "FAIL", label))

    dur = metrics["duration_s"]
    max_dur = criteria["max_duration_s"]
    dur_str = f"{int(dur // 60)}m {int(dur % 60)}s" if dur >= 60 else f"{dur:.1f}s"
    max_str = f"{max_dur // 60}m" if max_dur >= 60 else f"{max_dur}s"
    checks.append(("PASS" if dur <= max_dur else "FAIL", f"duration: {dur_str} (budget: {max_str})"))

    return checks


def find_latest_jsonl(run_dir):
    jsonls = sorted(Path(run_dir).glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    return jsonls[-1] if jsonls else None


def analyze_session(session_dir):
    runs_dir = session_dir / "runs"
    if not runs_dir.exists():
        return None

    results = {}
    for run_dir in sorted(d for d in runs_dir.iterdir() if d.is_dir()):
        jsonl = find_latest_jsonl(run_dir)
        if not jsonl:
            continue
        metrics = analyze_jsonl(jsonl)
        if metrics:
            results[run_dir.name] = metrics

    return results or None


def print_report(session_name, results):
    print(f"\nSession: {session_name}")
    print("=" * 70)

    for run_name, metrics in sorted(results.items()):
        task = task_from_run_name(run_name)
        checks = quality_checks(metrics, task) if task else []

        if all(c[0] == "PASS" for c in checks):
            overall = "PASS"
        elif any(c[0] == "FAIL" for c in checks):
            overall = "FAIL"
        else:
            overall = "WARN"

        terminated_tag = "  (terminated)" if metrics.get("terminated") else ""
        print(f"\n{run_name}  [{overall}]{terminated_tag}")
        print(f"  Duration:  {metrics['elapsed']}")
        print(f"  Tokens:    {format_tokens(metrics['total_tokens'])} total"
              f"  (orch: {format_tokens(metrics['orch_tokens'])}, sub: {format_tokens(metrics['sub_tokens'])})")
        print(f"  Subagents: {metrics['subagent_count']}")

        if metrics["orch_tool_calls"]:
            counts = Counter(metrics["orch_tool_calls"])
            tools_str = ", ".join(f"{k}×{v}" for k, v in sorted(counts.items()))
            print(f"  Orch tools: {tools_str}")

        for status, msg in checks:
            symbol = "+" if status == "PASS" else ("!" if status == "WARN" else "x")
            print(f"  [{symbol}] {msg}")

    print()


def resolve_session(arg):
    if arg.isdigit():
        return SESSIONS_DIR / f"session-{int(arg):02d}"
    return SESSIONS_DIR / arg


if __name__ == "__main__":
    if len(sys.argv) >= 2:
        session_dir = resolve_session(sys.argv[1])
    else:
        sessions = sorted(
            (d for d in SESSIONS_DIR.iterdir() if d.is_dir() and d.name.startswith("session-")),
            key=lambda d: d.name,
        ) if SESSIONS_DIR.exists() else []
        if not sessions:
            print("No sessions found. Run ./new-session.sh to create one.", file=sys.stderr)
            sys.exit(1)
        session_dir = sessions[-1]

    if not session_dir.exists():
        print(f"Session directory not found: {session_dir}", file=sys.stderr)
        sys.exit(1)

    results = analyze_session(session_dir)
    if not results:
        print(f"No completed runs found in {session_dir}/runs/", file=sys.stderr)
        sys.exit(1)

    print_report(session_dir.name, results)

    analysis_file = session_dir / "analysis.json"
    with open(analysis_file, "w") as f:
        json.dump(results, f, indent=2)
    print(f"Saved: {analysis_file}")
