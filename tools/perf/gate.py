#!/usr/bin/env python3
"""The perf gate: run scenarios, compare against budgets, fail loudly.

Gated metrics are kernel-exact counters, contention-insensitive by
construction: instructions/cycles aggregated over the tree's cgroup (short-
lived children counted, never sampled), root rchar/wchar, cgroup memory.peak
and pids.peak. The one exception is keystroke echo latency, gated as a
coarse absolute blocker detector (under 100 ms), not a calibrated budget:
wall-clock can never be 100% deterministic, but a 25x margin over observed
noise makes pass/fail insensitive to scheduling jitter. Budgets live in
tools/perf/budgets.json as median x headroom from a calibration run on one
runner class — regenerate deliberately with `pnpm run perf:budgets`, never
hand-tune a failing number away.

Usage:
  python3 tools/perf/gate.py --binary dist/kimchi            # run + compare
  python3 tools/perf/gate.py --calibrate                      # rewrite budgets.json
  python3 tools/perf/gate.py --dry-run --runs file.jsonl     # classify canned runs
"""
import argparse
import json
import math
import os
import re
import statistics
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BUDGETS = os.path.join(HERE, "budgets.json")

def _wu(instr, cycles, cpu_ms=0):
    """The gated work counter, tiered: instructions retired, else cycles, else
    CPU milliseconds. macOS 15's kernel reports zero for both hardware counters
    (they work on newer arm64 macOS); the tier is uniform within a runner class,
    and budgets are runner-class-pinned, so cross-tier comparison never happens.
    Zero on all three is a broken counter, caught by the zero-median guard."""
    return instr or cycles or cpu_ms


# metric name -> (extractor, unit, why it is gated, headroom)
# extractors receive one scenario's record and return a number or None.
# Headroom is measured, not chosen: with 4 samples per metric the budget
# must clear the observed run-to-run spread by ~3x. Measured spreads:
# session writes 0.1%, idle reads 4.5%, resume load 4.4%, session work
# 5.8%, idle work 15.1% (pass-period phase in the idle window), keystroke
# p95 142% (the one wall-clock metric). Headrooms follow: bytes tightest,
# wall-clock loosest.
BYTES = 1.1
WORK = 1.25
IDLE_WORK = 1.35
IDLE_READS = 1.25  # pass-phase shifts whole passes in/out of the window:
                   # measured same-SHA spread 8.4% (x3), vs 0.03% for session bytes
# Budget modes: ("ratio", h) → ceil(median × h); ("add", a) → max reps + a,
# for exact discrete counters where ratio-on-small-integers is meaningless;
# ("abs", c) → constant c regardless of calibration, for coarse detectors
# keyed to regression magnitude, never to machine noise.
RATIO, ADD, ABS = "ratio", "add", "abs"
EXTRACTORS = {
    "session": {
        "instr": (lambda r: _wu((r.get("total") or {}).get("instr"), (r.get("total") or {}).get("cycles"),
                                (r.get("total") or {}).get("cpu_ms")), "work units",
                  "whole-session work; catches per-turn blowups", (RATIO, WORK)),
        "disk_w_mb": (lambda r: (r.get("total") or {}).get("disk_w", 0) / 1e6, "MB written",
                      "ledger/WAL/session churn (v1.22 wrote more)", (RATIO, BYTES)),
        "peak_mem_mb": (lambda r: ((r.get("total") or {}).get("peak_mem") or 0) / 1e6, "MB peak",
                        "memory ceiling of one ordinary session (whole tree)", (RATIO, WORK)),
    },
    "resume": {
        "load_instr": (lambda r: _wu((r.get("load") or {}).get("instr"), (r.get("load") or {}).get("cycles"),
                                      (r.get("load") or {}).get("cpu_ms")), "work units",
                       "resume of a large compacted session (v1.11 was 3-9x)", (RATIO, WORK)),
        "turn_instr": (lambda r: _wu((r.get("turn") or {}).get("instr"), (r.get("turn") or {}).get("cycles"),
                                      (r.get("turn") or {}).get("cpu_ms")), "work units",
                       "first turn after resume; render of pre-compaction history", (RATIO, WORK)),
        "peak_mem_mb": (lambda r: (r.get("peak_mem") or 0) / 1e6, "MB peak",
                        "retained-history memory (whole tree)", (RATIO, WORK)),
    },
    "idle": {
        # Skip the first bucket: it mixes startup with the first background pass.
        # Gating steady-state buckets only keeps a 1.5x per-pass regression at 1.5x
        # of the gated total, instead of being diluted by fixed startup work.
        "instr": (lambda r: sum(_wu(b.get("instr", 0), b.get("cycles", 0), b.get("cpu_ms", 0)) +
                                 _wu(b.get("desc_instr", 0), b.get("desc_cycles", 0), b.get("desc_cpu_ms", 0))
                                 for b in r.get("buckets", [])[1:]),
                  "work units", "idle background work over the window (v1.10 class)", (RATIO, IDLE_WORK)),
        "read_mb": (lambda r: sum((b.get("disk_r", 0) + b.get("desc_disk_r", 0)) for b in r.get("buckets", [])[1:]) / 1e6,
                    "MB read", "root's own per-pass re-reads of accumulated data", (RATIO, IDLE_READS)),
        # pids.peak is the kernel's own record of the run's peak concurrency —
        # exact, unlike any sampled child count. The additive allowance covers
        # an occasional extra helper, not a ratio on a small integer.
        "pids_peak": (lambda r: (r.get("pids_peak") or 0), "procs peak",
                      "peak helper concurrency (git pollers, tar+gzip archiver)", (ADD, 2)),
        # Wall-clock, but gated as a coarse detector: ~75 probes per idle
        # window, normal p95 is ~4 ms (dead-stable across runs), and the
        # historical regressions stalled EVERY keystroke at 0.9-1.9 s. p95
        # keeps the gate immune to single-sample VM pauses (a lone >200 ms
        # host dip was observed once); the historical stall moves p95
        # wholesale past the threshold, 20x above noise and 9x below a
        # real regression.
        "keylat_p95_ms": (lambda r: r.get("keylat_p95_ms"), "ms p95",
                          "keystroke echo latency; absolute event-loop-blocker detector", (ABS, 100.0)),
    },
}

def tier_mismatch(recs, expected):
    """The counter tier(s) these records used vs the calibration tier, or
    None when they agree. Missing/None tiers never match — fail closed."""
    tiers = {r.get("counter") for r in recs}
    if tiers != {expected}:
        return sorted(tiers, key=str)
    return None


def run_selfcheck():
    """Contract test for the classifier: synthetic records + budgets through
    compare(), asserting every fail-closed branch fires. The gate has no
    other unit tests (no Python test infra in the repo); this is its suite."""
    rec_tpl = {
        "session": {"scenario": "session", "ok": True, "counter": "cgroup-instructions",
                    "total": {"instr": 100, "cycles": 0, "cpu_ms": 0, "disk_w": 2e6, "disk_r": 1e6,
                              "logical_w": 0, "peak_mem": 100e6}},
        "resume": {"scenario": "resume", "ok": True, "counter": "cgroup-instructions",
                   "load": {"instr": 100, "cycles": 0, "cpu_ms": 0},
                   "turn": {"instr": 100, "cycles": 0, "cpu_ms": 0}, "peak_mem": 100e6},
        "idle": {"scenario": "idle", "ok": True, "counter": "cgroup-instructions",
                 "buckets": [{"instr": 0, "cycles": 0, "cpu_ms": 0, "desc_instr": 0, "desc_cycles": 0,
                              "desc_cpu_ms": 0, "disk_r": 0, "desc_disk_r": 0},
                             {"instr": 100, "cycles": 0, "cpu_ms": 0, "desc_instr": 0, "desc_cycles": 0,
                              "desc_cpu_ms": 0, "disk_r": 1e6, "desc_disk_r": 0}],
                 "pids_peak": 4, "keylat_p95_ms": 5.0},
    }

    def budgets_for(over=None):
        b = {"_meta": {"counter": "cgroup-instructions"}}
        for sc, metrics in EXTRACTORS.items():
            b[sc] = {}
            for m, meta in metrics.items():
                default = meta[3][1] if meta[3][0] == ABS else 1000
                b[sc][m] = {"limit": (over or {}).get((sc, m), default)}
        return b

    def classify(sc, rec, budgets):
        metrics, _ = collect([rec])
        return compare(sc, metrics, budgets)

    problems = []
    good = budgets_for()
    # 1. In-budget records pass.
    for sc, rec in rec_tpl.items():
        _, fails = classify(sc, rec, good)
        if fails:
            problems.append(f"{sc}: in-budget record failed: {fails}")
    # 2. A breach fails with the ratio.
    _, fails = classify("session", rec_tpl["session"], budgets_for({("session", "instr"): 50}))
    if not any(f[1] == "instr" for f in fails):
        problems.append("session: a 2x instr breach did not fail")
    # 3. A zero counter reading fails as broken, never passes.
    zero = dict(rec_tpl["session"])
    zero["total"] = {"instr": 0, "cycles": 0, "cpu_ms": 0, "disk_w": 2e6, "disk_r": 1e6,
                     "logical_w": 0, "peak_mem": 100e6}
    rows, fails = classify("session", zero, good)
    if not any("counter reads zero" in r[-1] for r in rows):
        problems.append("session: zero counter reading was not flagged")
    # 4. A never-measured metric fails closed.
    nokeylat = dict(rec_tpl["idle"])
    nokeylat.pop("keylat_p95_ms")
    _, fails = classify("idle", nokeylat, good)
    if not any(f[1] == "keylat_p95_ms" for f in fails):
        problems.append("idle: missing keylat metric did not fail closed")
    # 5. A missing budget key fails closed; a flat/malformed budget value must
    #    not crash the classifier either.
    b5 = budgets_for()
    del b5["resume"]["load_instr"]
    _, fails = classify("resume", rec_tpl["resume"], b5)
    if not any(f[1] == "load_instr" for f in fails):
        problems.append("resume: missing budget key did not fail closed")
    b6 = budgets_for()
    b6["session"]["instr"] = 12345  # flat value, malformed
    rows, fails = classify("session", rec_tpl["session"], b6)
    if not any(f[1] == "instr" for f in fails):
        problems.append("session: malformed (flat) budget value did not fail closed")
    # 6. Unknown budget keys/scenarios and tier mismatches are flagged.
    b7 = budgets_for()
    b7["session"]["bogus_metric"] = {"limit": 1}
    rows, _ = classify("session", rec_tpl["session"], b7)
    if not any("unknown budget key" in r[-1] for r in rows):
        problems.append("session: unknown budget key not flagged")
    if tier_mismatch([rec_tpl["session"]], "cgroup-instructions") is not None:
        problems.append("tier guard: matching tier flagging as mismatch")
    if tier_mismatch([{"counter": "cpu_ms"}], "cgroup-instructions") is None:
        problems.append("tier guard: cpu_ms vs cgroup-instructions not flagged")
    if tier_mismatch([{}], "cgroup-instructions") is None:
        problems.append("tier guard: missing counter tier not flagged")
    if problems:
        print("GATE SELFCHECK FAILED:\n- " + "\n- ".join(problems), file=sys.stderr)
        return 1
    print("gate selfcheck OK: classifier fails closed exactly where it must")
    return 0


ADVISORY = {  # reported, never gated: wall-clock is contention noise
    "session": {"ready_s": lambda r: r.get("ready_s")},
    "resume": {"ready_s": lambda r: r.get("ready_s"), "turn_s": lambda r: r.get("turn_s")},
    "idle": {"ready_s": lambda r: r.get("ready_s"),
              "keylat_p50_ms": lambda r: r.get("keylat_p50_ms"),
              "keylat_max_ms": lambda r: r.get("keylat_max_ms"),
              "keylat_over_100ms": lambda r: r.get("keylat_over_100ms")},
}


def collect(records):
    """records for one scenario -> {metric: [values per rep]}, plus advisory means."""
    out, adv = {}, {}
    for r in records:
        for m, ex in EXTRACTORS.get(r["scenario"], {}).items():
            v = ex[0](r)
            if isinstance(v, (int, float)):
                out.setdefault(m, []).append(v)
        for m, fn in ADVISORY.get(r["scenario"], {}).items():
            v = fn(r)
            if isinstance(v, (int, float)):
                adv.setdefault(m, []).append(v)
    return out, adv


def compare(scenario, metrics, budgets):
    rows, failures = [], []
    for m in sorted(EXTRACTORS.get(scenario, {})):
        values = metrics.get(m, [])
        mode = EXTRACTORS[scenario][m][3][0]
        if not values:
            # Fail closed for an unmeasured gated metric too (e.g. keystroke
            # probing never produced a sample): an absent observation is not
            # evidence of health.
            rows.append((scenario, m, None, None, None, "FAIL (metric never measured)"))
            failures.append((scenario, m, None, None, None))
            continue
        measured = statistics.median(values) if mode == RATIO else max(values)
        # Flat/non-object budget values (malformed file, hand edit) fail
        # closed as "no budget" instead of crashing with AttributeError.
        spec = budgets.get(scenario, {}).get(m)
        limit = spec.get("limit") if isinstance(spec, dict) else None
        if limit is None:
            # Fail closed: a metric with no budget entry is ungated, and the
            # sanctioned escape hatch is regenerating budgets deliberately —
            # never a silent pass because a key went missing or was renamed.
            rows.append((scenario, m, measured, None, None, "FAIL (no budget; run pnpm run perf:budgets)"))
            failures.append((scenario, m, measured, None, None))
            continue
        ratio = measured / limit if limit else float("inf")
        status = "PASS" if measured <= limit else f"FAIL ({ratio:.2f}x limit)"
        if measured <= 0:
            # A gated metric of exactly zero means the counter did not fire
            # (unsupported on this runner) — never a pass.
            status = "FAIL (counter reads zero; runner/kernel does not report it)"
            failures.append((scenario, m, measured, limit, None))
        elif measured > limit:
            failures.append((scenario, m, measured, limit, ratio))
        rows.append((scenario, m, measured, limit, ratio, status))
    # Budget keys this gate does not know: rename drift in the other direction.
    # Keys are validated before rendering: budgets.json is PR-controlled, and
    # its keys reach the CI step summary — a hostile key never prints raw.
    for m in budgets.get(scenario, {}):
        if m not in EXTRACTORS.get(scenario, {}) and not str(m).startswith("_"):
            safe = re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", str(m))
            label = m if safe else "<invalid budget key>"
            rows.append((scenario, label, None, budgets[scenario][m].get("limit"), None, "WARN (unknown budget key)"))
    return rows, failures


def load_runs(path, out_dir):
    """Parse a scenario's JSONL, tolerating a truncated final line from a killed run."""
    records = []
    if not os.path.exists(path):
        return records
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                print(f"[gate] warning: truncated record at end of {path}", file=sys.stderr)
    return records


def run_scenarios(binary, scenarios, args, out_dir):
    """Run each scenario; a failed scenario does not abort the others.

    The gate's whole point is diagnosing failures, so one broken scenario
    must not discard the report or the measurements of the rest. A scenario
    whose subprocess exited non-zero (or that recorded a failed rep) is
    reported as failed even when its surviving reps pass budgets — a failed
    rep never hides behind a green median.
    """
    by_scenario, failed = {}, set()
    for sc in scenarios:
        runs = os.path.join(out_dir, f"{sc}.jsonl")
        if os.path.exists(runs):
            os.remove(runs)
        cmd = [sys.executable, os.path.join(HERE, "scenarios.py"), "--binary", binary,
               "--scenario", sc, "--out", runs, "--reps", str(args.reps),
               "--idle", str(args.idle), "--session-mb", str(args.session_mb),
               "--workroot", os.path.join(out_dir, f"root-{sc}")]
        if args.expect_version:
            cmd += ["--expect-version", args.expect_version]
        print(f"[gate] {sc}: {' '.join(cmd)}", flush=True)
        try:
            proc = subprocess.run(cmd, check=False, timeout=900)
            returncode = proc.returncode
        except subprocess.TimeoutExpired:
            # The scenario's internal waits should bound it well under this;
            # hanging here means a deadlock — report it as a failed scenario
            # instead of letting the whole workflow job time out silently.
            returncode = 124
            print(f"[gate] {sc} hung: killed after 900s", file=sys.stderr)
        records = load_runs(runs, out_dir)
        if returncode != 0 or any(not r.get("ok", False) for r in records):
            failed.add(sc)
            failed_recs = [r for r in records if not r.get("ok", False)]
            detail = failed_recs[-1].get("error") if failed_recs else f"exit code {returncode}"
            print(f"[gate] {sc} FAILED: {detail}", file=sys.stderr)
        by_scenario[sc] = records
    return by_scenario, failed


def _meta(binary_version, git_binary, reps):
    """Calibration context: what machine and tree produced these budgets."""
    import platform
    import subprocess as sp
    meta = {"headroom": "per-metric, from measured run-to-run spread (see gate.py)", "calibrated": binary_version,
            "git": git_binary, "reps": reps,
            "arch": platform.machine(), "macos": platform.mac_ver()[0],
            "note": "regenerated by pnpm run perf:budgets; review the diff"}
    try:
        meta["commit"] = sp.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True,
                                 cwd=HERE, timeout=10).stdout.strip()
    except Exception:
        pass
    for env in ("RUNNER_NAME", "ImageOS", "RUNNER_ARCH"):
        if os.environ.get(env):
            meta[env.lower()] = os.environ[env]
    return meta


def markdown(rows, advisory, ctx):
    import re as _re

    def clean(v):
        # Every cell that can carry a string from outside the gate (version,
        # git, budget keys) goes through here: control chars (incl. newlines)
        # strip, backticks and pipes neutralise code spans and table breaks.
        return (_re.sub(r"[\x00-\x1f\x7f]", "", str(v))
                .replace("`", "'").replace("|", "/").replace("<", "\u2039").replace(">", "\u203a"))[:120]

    lines = ["## Perf gate", "", f"binary `{clean(ctx.get('version', '?'))}` — `{clean(ctx.get('git', '?'))}`", ""]
    lines += ["| scenario | metric | measured | limit | ratio | status |", "|---|---|---|---|---|---|"]
    for sc, m, measured, limit, ratio, status in rows:
        def fmt(v):
            return "—" if v is None else (f"{v:,.0f}" if abs(v or 0) >= 1000 else f"{v:,.2f}")
        lines.append(f"| {clean(sc)} | {clean(m)} | {fmt(measured)} | {fmt(limit)} | "
                     f"{'—' if ratio is None else f'{ratio:.2f}'} | {clean(status)} |")
    if advisory:
        lines += ["", "Advisory (never gated):"]
        for sc, ms in advisory.items():
            for m, v in ms.items():
                lines.append(f"- {sc}.{m}: {v:,.2f} (median)")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", default=os.path.join(os.path.dirname(HERE), "..", "dist", "bin", "kimchi"))
    ap.add_argument("--budgets", default=DEFAULT_BUDGETS)
    ap.add_argument("--out", default=None, help="runs directory (default: <temp>/kimchi-perf-gate; must be outside any kimchi project)")
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--scenarios", default="session,resume,idle")
    ap.add_argument("--idle", type=float, default=90.0)  # whole 30s pass periods
    ap.add_argument("--session-mb", type=int, default=31)
    ap.add_argument("--calibrate", action="store_true", help="rewrite budgets.json from this run")
    ap.add_argument("--dry-run", action="store_true", help="classify --runs JSONL files, no execution")
    ap.add_argument("--runs", default=None, help="with --dry-run: comma list of JSONL files")
    ap.add_argument("--expect-version", default=None, help="passed to scenarios.py; refuse other self-reported versions")
    ap.add_argument("--selfcheck", action="store_true",
                    help="contract-test the classifier on synthetic records (no binary needed)")
    args = ap.parse_args()
    if args.selfcheck:
        sys.exit(run_selfcheck())
    scenarios = args.scenarios.split(",")
    unknown_sc = [s for s in scenarios if s not in EXTRACTORS]
    if unknown_sc:
        raise SystemExit(f"unknown scenario(s): {', '.join(unknown_sc)} "
                         f"(valid: {', '.join(EXTRACTORS)})")

    if args.dry_run:
        records = []
        for f in (args.runs or "").split(","):
            if f:
                records += load_runs(f, None)
        budgets = json.load(open(args.budgets))
        expected_tier = budgets.get("_meta", {}).get("counter")
        if not expected_tier:
            raise SystemExit("budgets lack _meta.counter; refusing to classify without a counter tier")
        all_rows, all_adv, failures = [], {}, []
        for sc in scenarios:
            recs = [r for r in records if r.get("scenario") == sc and r.get("ok", False)]
            if not recs:
                failures.append((sc, "records", None, None, None))
                all_rows.append((sc, "records", None, None, None, "FAIL (no records)"))
                continue
            tiers = tier_mismatch(recs, expected_tier)
            if tiers is not None:
                failures.append((sc, "counter-tier", None, None, None))
                all_rows.append((sc, "counter-tier", None, None, None,
                                 f"FAIL (measured {tiers} but budgets calibrated on {expected_tier})"))
                continue
            metrics, adv = collect(recs)
            rows, fails = compare(sc, metrics, budgets)
            all_rows += rows
            failures += fails
            if adv:
                all_adv[sc] = {m: statistics.median(v) for m, v in adv.items()}
        print(markdown(all_rows, all_adv, {}))
        sys.exit(1 if failures else 0)

    binary = os.path.abspath(args.binary)
    if not os.path.isfile(binary):
        raise SystemExit(f"binary not found: {binary} (run pnpm run build:binary)")
    # Never inside a project: an ancestor directory holding .kimchi triggers
    # the project-trust prompt and the ready marker never appears. That includes
    # this repo itself, and a shared fixed dir would let two concurrent local
    # runs delete each other's workroots — hence a unique dir per invocation.
    out_dir = os.path.abspath(args.out or tempfile.mkdtemp(prefix="kimchi-perf-gate-"))
    probe = out_dir
    while True:
        if os.path.exists(os.path.join(probe, ".kimchi")):
            raise SystemExit(f"runs directory is inside a kimchi project (trust prompt): {out_dir}")
        if os.path.dirname(probe) == probe:
            break
        probe = os.path.dirname(probe)
    os.makedirs(out_dir, exist_ok=True)
    print(f"[gate] runs directory: {out_dir}", flush=True)

    by_scenario, failed_scenarios = run_scenarios(binary, scenarios, args, out_dir)

    ctx = {}
    versions = set()
    for recs in by_scenario.values():
        for r in recs:
            if r.get("version"):
                versions.add(r["version"])
        if recs and not ctx:
            ctx = {"version": recs[0].get("version"), "git": recs[0].get("git")}
    if len(versions) > 1:
        print(f"PERF GATE FAILED: binary reported different versions across runs: {sorted(versions)}",
              file=sys.stderr)
        sys.exit(1)

    if args.calibrate:
        # A failed rep (scenario crashed, cgroup join failed, ...) must never
        # be folded into budgets: its partial counters would silently lower
        # every limit. Calibrate from a fully green run only.
        if failed_scenarios:
            raise SystemExit(f"refusing to calibrate: failed scenario(s): {', '.join(sorted(failed_scenarios))}; "
                             "fix the failure before regenerating budgets")
        ok_by_scenario = {sc: [r for r in recs if r.get("ok", False)]
                          for sc, recs in by_scenario.items()}
        empty = [sc for sc, recs in ok_by_scenario.items() if not recs]
        if empty:
            raise SystemExit(f"refusing to calibrate: no passing records for {', '.join(empty)}; "
                             "fix the scenario before regenerating budgets")
        tiers = {r.get("counter") for recs in ok_by_scenario.values() for r in recs}
        if len(tiers) > 1:
            raise SystemExit(f"refusing to calibrate: runs mixed work-counter tiers {sorted(tiers)}; "
                             "fix the sampler before regenerating budgets")
        if not tiers or None in tiers:
            raise SystemExit("refusing to calibrate: records lack a work-counter tier; "
                             "a hidden sampler regression must not stamp a bogus _meta.counter")
        budgets = {"_meta": _meta(ctx.get("version", "?"), ctx.get("git", "?"), args.reps)}
        budgets["_meta"]["counter"] = sorted(tiers)[0]
        for sc, recs in ok_by_scenario.items():
            metrics, _ = collect(recs)
            missing = [m for m in EXTRACTORS[sc] if not metrics.get(m)]
            if missing:
                raise SystemExit(f"refusing to calibrate: {sc} never measured {', '.join(missing)}")
            # A zero reading means the counter did not fire (broken backend
            # that still produced ok records): calibrating a zero limit would
            # fail every subsequent run with a misleading signal. Refuse.
            zero = [m for m in EXTRACTORS[sc]
                    if metrics.get(m) and max(metrics[m]) <= 0 and m != "keylat_over_100ms"]
            if zero:
                raise SystemExit(f"refusing to calibrate: {sc} read zero for {', '.join(zero)}; "
                                 "fix the counter before regenerating budgets")
            def limit_of(sc, m, v):
                mode, param = EXTRACTORS[sc][m][3]
                if mode == RATIO:
                    return math.ceil(statistics.median(v) * param)
                if mode == ADD:
                    return max(v) + param
                return param  # ABS: constant detector, independent of observation
            budgets[sc] = {m: {"limit": limit_of(sc, m, v),
                               "budget_note": EXTRACTORS[sc][m][2]}
                          for m, v in metrics.items()}
        with open(args.budgets, "w") as f:
            json.dump(budgets, f, indent=1)
            f.write("\n")
        print(f"[gate] calibrated budgets written to {args.budgets}")
        return

    budgets = json.load(open(args.budgets))
    all_rows, all_adv, failures = [], {}, []
    # The tier guard compares this run's counter against the one the budgets
    # were calibrated on; a budgets file without a tier would let the guard
    # pass vacuously, so its absence is a failure, not a skip.
    expected_tier = budgets.get("_meta", {}).get("counter")
    if not expected_tier:
        raise SystemExit("budgets lack _meta.counter; refusing to compare without a counter tier")
    for bsc in budgets:
        if bsc != "_meta" and bsc not in EXTRACTORS:
            all_rows.append((bsc, "-", None, None, None, "WARN (unknown budget scenario)"))
    for sc in scenarios:
        recs = [r for r in by_scenario[sc] if r.get("ok", False)]
        if not recs:
            failures.append((sc, "records", None, None, None))
            all_rows.append((sc, "records", None, None, None, "FAIL (no records; scenario did not complete)"))
            continue
        metrics, adv = collect(recs)
        rows, fails = compare(sc, metrics, budgets)
        all_rows += rows
        failures += fails
        if adv:
            all_adv[sc] = {m: statistics.median(v) for m, v in adv.items()}
        if sc in failed_scenarios:
            failures.append((sc, "reps", None, None, None))
            all_rows.append((sc, "reps", None, None, None,
                             "FAIL (a rep failed; surviving reps are advisory until fixed)"))
        tiers = tier_mismatch(recs, expected_tier)
        if tiers is not None:
            # The budgets were calibrated on one work counter and this run
            # measured another — the numbers are not comparable; that is a
            # broken counter (perf_event_paranoid?), never a pass.
            failures.append((sc, "counter-tier", None, None, None))
            all_rows.append((sc, "counter-tier", None, None, None,
                             f"FAIL (measured {tiers} but budgets calibrated on {expected_tier})"))
    report = markdown(all_rows, all_adv, ctx)
    print(report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write(report + "\n")
    if failures:
        print(f"\nPERF GATE FAILED: {len(failures)} metric(s) over budget", file=sys.stderr)
        sys.exit(1)
    print("\nPERF GATE PASSED")


if __name__ == "__main__":
    main()
