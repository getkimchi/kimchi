#!/usr/bin/env python3
"""Compare token usage and quality metrics between two benchmark sessions."""

import json
import subprocess
import sys
from pathlib import Path

IMPROVEMENT_DIR = Path(__file__).parent
SESSIONS_DIR = IMPROVEMENT_DIR / "sessions"


def format_tokens(n):
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}m"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def wilson_lower_bound(wins, total, z=1.645):
    """One-sided 95% Wilson lower bound on a win rate (stdlib only).

    Used to keep single-task token flukes from reading as regressions: treat
    'candidate improved on this task' as a Bernoulli trial and ship the lower
    bound of the interval. Interpretation: > 0.5 means improvement is
    statistically supported across replicate sessions.
    """
    if total == 0:
        return 0.0
    p = wins / total
    denom = 1 + z * z / total
    centre = p + z * z / (2 * total)
    margin = z * (p * (1 - p) / total + z * z / (4 * total * total)) ** 0.5
    return max(0.0, (centre - margin) / denom)


def _metric(metrics, *path):
    """Nested getter that returns None when the session predates instrumentation."""
    cur = metrics
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def compare_optional(a, b, label, path_a, path_b=None):
    """Print a single optional-metric comparison row; returns the pandas row or None."""
    path_b = path_b or path_a
    va = _metric(a, *path_a)
    vb = _metric(b, *path_b)
    if va is None and vb is None:
        return None
    delta = delta_str(va, vb) if isinstance(va, (int, float)) and isinstance(vb, (int, float)) else "N/A"
    print(
        f"  {label:<28} {format_tokens(va) if isinstance(va, int) else va!r:>10}"
        f"  {format_tokens(vb) if isinstance(vb, int) else vb!r:>10}  {delta:>8}"
    )
    return va, vb


def delta_str(a, b):
    if a == 0:
        return "N/A"
    pct = (b - a) / a * 100
    sign = "+" if pct >= 0 else ""
    return f"{sign}{pct:.1f}%"


def ensure_analysis(session_dir):
    analysis_file = session_dir / "analysis.json"
    if not analysis_file.exists():
        print(f"Running analysis for {session_dir.name}...")
        subprocess.run(
            [sys.executable, str(IMPROVEMENT_DIR / "analyze-session.py"), str(session_dir)],
            check=True,
        )
    if not analysis_file.exists():
        return None
    with open(analysis_file) as f:
        return json.load(f)


def resolve_session(arg):
    if arg.isdigit():
        return SESSIONS_DIR / f"session-{int(arg):02d}"
    return SESSIONS_DIR / arg


def compare(session_a_dir, session_b_dir):
    a = ensure_analysis(session_a_dir)
    b = ensure_analysis(session_b_dir)

    if not a or not b:
        print("Could not load metrics for one or both sessions.", file=sys.stderr)
        sys.exit(1)

    all_runs = sorted(set(a.keys()) | set(b.keys()))

    print(f"\nComparing {session_a_dir.name} vs {session_b_dir.name}")
    print("=" * 84)
    header = (
        f"{'Run':<22}  {'Tokens A':>10}  {'Tokens B':>10}  {'Delta':>8}"
        f"  {'Sub A':>5}  {'Sub B':>5}  {'Dur A':>8}  {'Dur B':>8}"
    )
    print(header)
    print("-" * 84)

    for run in all_runs:
        if run not in a:
            print(f"{run:<22}  (only in {session_b_dir.name})")
            continue
        if run not in b:
            print(f"{run:<22}  (only in {session_a_dir.name})")
            continue

        ta = a[run]["total_tokens"]
        tb = b[run]["total_tokens"]
        sa = a[run]["subagent_count"]
        sb = b[run]["subagent_count"]
        da = a[run]["elapsed"]
        db = b[run]["elapsed"]

        print(
            f"{run:<22}  {format_tokens(ta):>10}  {format_tokens(tb):>10}  {delta_str(ta, tb):>8}"
            f"  {sa:>5}  {sb:>5}  {da:>8}  {db:>8}"
        )

    print()

    # Optional instrumentation metrics (token-optimization Phase 0): sessions that
    # predate the cache-summary/context-assembly entries simply lack the fields.
    instrumented = [run for run in all_runs if run in a and run in b and a[run].get("cache") and b[run].get("cache")]
    if instrumented:
        print(f"Cache/context metrics ({len(instrumented)} run(s) with instrumentation)")
        print("-" * 84)
        for run in instrumented:
            print(f"{run}")
            compare_optional(a[run], b[run], "cache-read tokens", ("cache", "cacheReadTokens"))
            compare_optional(a[run], b[run], "cache-write tokens", ("cache", "cacheWriteTokens"))
            compare_optional(a[run], b[run], "cost (usd)", ("cache", "costDollars"))
            compare_optional(a[run], b[run], "system prompt (est)", ("context", "system_prompt_tokens_est"))
            compare_optional(a[run], b[run], "tool surface (est)", ("context", "tool_surface_tokens_est"))
            compare_optional(a[run], b[run], "prefix changes", ("context", "prefix_changes"))

    # Win-rate summary: across paired replicate sessions, how many tasks improved.
    paired = [
        (run, a[run]["total_tokens"], b[run]["total_tokens"])
        for run in all_runs
        if run in a and run in b and a[run]["total_tokens"] > 0
    ]
    if paired:
        wins = sum(1 for _, ta, tb in paired if tb < ta)
        ties = sum(1 for _, ta, tb in paired if tb == ta)
        lower = wilson_lower_bound(wins, len(paired))
        print(
            f"Token win rate (B improved): {wins}/{len(paired)}"
            f" (ties: {ties}); Wilson lower bound {lower:.2f}"
            f" — {'improvement supported' if lower > 0.5 else 'not supported at 95%'}"
        )
        print()


if __name__ == "__main__":
    all_sessions = sorted(
        (d for d in SESSIONS_DIR.iterdir() if d.is_dir() and d.name.startswith("session-")),
        key=lambda d: d.name,
    ) if SESSIONS_DIR.exists() else []

    if len(sys.argv) >= 3:
        session_a = resolve_session(sys.argv[1])
        session_b = resolve_session(sys.argv[2])
    elif len(sys.argv) == 2:
        session_b = resolve_session(sys.argv[1])
        idx = next((i for i, s in enumerate(all_sessions) if s.name == session_b.name), None)
        if idx is None or idx == 0:
            print("Cannot find a previous session to compare against.", file=sys.stderr)
            sys.exit(1)
        session_a = all_sessions[idx - 1]
    else:
        if len(all_sessions) < 2:
            print("Need at least 2 sessions to compare.", file=sys.stderr)
            sys.exit(1)
        session_a, session_b = all_sessions[-2], all_sessions[-1]

    for s in (session_a, session_b):
        if not s.exists():
            print(f"Session directory not found: {s}", file=sys.stderr)
            sys.exit(1)

    compare(session_a, session_b)
