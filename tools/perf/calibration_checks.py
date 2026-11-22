#!/usr/bin/env python3
"""Focused calibration/generation contract checks."""
import copy
import json
import os
import shutil
import sys
import tempfile
import unittest

import fixtures
import gate


def base_record(scenario, rep=0):
    row = {"scenario": scenario, "ok": True, "counter": "cgroup-instructions",
           "version": "fixture", "git": "fixture", "rep": rep,
           "keylat_p95_ms": 5.0, "keylat_max_ms": 7.0, "peak_mem": 100e6}
    if scenario == "session":
        row["total"] = {"instr": 100, "cycles": 0, "cpu_ms": 0, "disk_w": 2e6,
                        "disk_r": 1e6, "logical_w": 0, "peak_mem": 100e6}
        row["think_instr"] = 6e9
        row["submit_timing"] = False
    elif scenario == "resume":
        row["load"] = {"instr": 100, "cycles": 0, "cpu_ms": 0, "disk_r": 5e6}
        row["turn"] = {"instr": 100, "cycles": 0, "cpu_ms": 0}
    elif scenario in ("idle", "ledger"):
        row["buckets"] = [
            {"instr": 0, "cycles": 0, "cpu_ms": 0, "desc_instr": 0, "desc_cycles": 0,
             "desc_cpu_ms": 0, "disk_r": 0, "desc_disk_r": 0, "disk_w": 0, "desc_disk_w": 0, "p": 0},
            {"instr": 100, "cycles": 0, "cpu_ms": 30, "desc_instr": 10, "desc_cycles": 0,
             "desc_cpu_ms": 0, "disk_r": 1e6, "desc_disk_r": 1e6, "disk_w": 0, "desc_disk_w": 0, "p": 1},
            {"instr": 120, "cycles": 0, "cpu_ms": 30, "desc_instr": 10, "desc_cycles": 0,
             "desc_cpu_ms": 0, "disk_r": 1e6, "desc_disk_r": 1e6, "disk_w": 1e6, "desc_disk_w": 1e6, "p": 1},
        ]
        if scenario == "idle":
            row["pids_peak"] = 4
            row["buckets"].extend([{**row["buckets"][0], "p": 2}, {**row["buckets"][1], "p": 2}])
        if scenario == "ledger":
            row.update({"fixture_generation": fixtures.LEDGER_GENERATION, "source_sha": "source-fixture",
                        "harness_sha": "harness-fixture", "ledger_indexes": []})
    return row


def test_root(generation):
    root = tempfile.mkdtemp(prefix="perf-calibration-check-")
    budgets = {"_meta": {"counter": "cgroup-instructions", "ledger_generation": generation}}
    for scenario, metrics in gate.EXTRACTORS.items():
        budgets[scenario] = {metric: {"limit": meta[3][1] if meta[3][0] == gate.ABS else 1000}
                             for metric, meta in metrics.items()}
    # Non-ledger limits deliberately differ from the repository's budgets:
    # calibration must preserve the input file's values, not replace them.
    budgets["session"]["instr"]["limit"] = 12345
    budgets["resume"]["load_instr"]["limit"] = 23456
    budgets["idle"]["instr"]["limit"] = 34567
    path = os.path.join(root, "budgets.json")
    with open(path, "w") as f:
        json.dump(budgets, f)
    return root, path


def invoke(binary, budget_path, records, reps=2, scenarios=None):
    groups = {}
    for record in records:
        groups.setdefault(record["scenario"], []).append(record)
    if scenarios is not None:
        groups = {scenarios: groups[scenarios]}
    for_scenario = ["--scenarios", scenarios] if scenarios is not None else []
    with unittest.mock.patch.object(sys, "argv", ["gate.py", "--binary", binary, "--calibrate", "--budgets", budget_path,
                                               "--reps", str(reps), *for_scenario]), \
            unittest.mock.patch.object(gate, "run_scenarios", return_value=(groups, set())):
        gate.main()


def expect_rejection(fn, text):
    try:
        fn()
    except SystemExit as error:
        if text not in str(error):
            raise AssertionError(f"expected {text!r}, got {str(error)!r}") from error
    else:
        raise AssertionError(f"expected rejection {text!r}")


def expect_rejection_without_write(fn, budget_path, text):
    before = open(budget_path).read()
    expect_rejection(fn, text)
    if open(budget_path).read() != before:
        raise AssertionError(f"rejection {text!r} changed its budget file")


def check_cases():
    root, budget_path = test_root("definitely-old")
    records = [base_record(scenario) for scenario in gate.EXTRACTORS]
    records_path = os.path.join(root, "records.jsonl")
    with open(records_path, "w") as f:
        for scenario, record in enumerate(records):
            record["fixture_generation"] = "definitely-old"
            f.write(json.dumps(record) + "\n")
    with unittest.mock.patch.object(sys, "argv", ["gate.py", "--dry-run", "--runs", records_path, "--budgets", budget_path]):
        expect_rejection_without_write(lambda: gate.main(), budget_path, "unsupported ledger budget generation")
    with unittest.mock.patch.object(sys, "argv", ["gate.py", "--binary", sys.executable, "--scenarios", "ledger", "--budgets", budget_path]):
        expect_rejection_without_write(lambda: gate.main(), budget_path, "unsupported ledger budget generation")
    shutil.rmtree(root, ignore_errors=True)

    root, budget_path = test_root(fixtures.LEDGER_GENERATION)
    scaled = base_record("ledger")
    scaled["fixture_generation"] = "ledger-heavy-scaled:2400:2:1440"
    with unittest.mock.patch.object(gate, "run_scenarios", return_value=({"ledger": [scaled]}, set())), \
            unittest.mock.patch.object(sys, "argv", ["gate.py", "--binary", sys.executable,
                                                    "--scenarios", "ledger", "--budgets", budget_path]):
        expect_rejection_without_write(lambda: gate.main(), budget_path, "ledger generation mismatch")
    anonymous = base_record("ledger")
    anonymous.pop("source_sha")
    anonymous_path = os.path.join(root, "anonymous.jsonl")
    with open(anonymous_path, "w") as f:
        f.write(json.dumps(anonymous) + "\n")
    with unittest.mock.patch.object(sys, "argv", ["gate.py", "--dry-run", "--runs", anonymous_path, "--budgets", budget_path]):
        expect_rejection_without_write(lambda: gate.main(), budget_path, "missing measurement identity: source_sha")
    shutil.rmtree(root, ignore_errors=True)

    root, budget_path = test_root("previous-generation")
    records = []
    for scenario in gate.EXTRACTORS:
        record = base_record(scenario)
        if scenario == "ledger":
            record["keylat_p95_ms"] = 336.0
        records.extend([record, copy.deepcopy(record)])
    before = json.load(open(budget_path))
    expect_rejection_without_write(lambda: invoke(sys.executable, budget_path, records), budget_path, "failed its guards")
    if json.load(open(budget_path)) != before:
        raise AssertionError("budget-failing source rewrote budgets")
    records = []
    for scenario in gate.EXTRACTORS:
        root_record = base_record(scenario)
        records.extend([root_record, copy.deepcopy(root_record)])
    invoke(sys.executable, budget_path, records)
    changed = json.load(open(budget_path))
    if changed["_meta"]["ledger_generation"] != fixtures.LEDGER_GENERATION:
        raise AssertionError("measured generation was not preserved")
    for section in ("session", "resume", "idle"):
        if changed[section] != before[section]:
            raise AssertionError(f"non-ledger section {section} was rewritten")
    shutil.rmtree(root, ignore_errors=True)

    root, budget_path = test_root(fixtures.LEDGER_GENERATION)
    expect_rejection_without_write(lambda: invoke(sys.executable, budget_path, [base_record("ledger")], reps=1),
                                   budget_path, "exactly two complete passing repetitions")
    shutil.rmtree(root, ignore_errors=True)
    root, budget_path = test_root(fixtures.LEDGER_GENERATION)
    records = [base_record("ledger") for _ in range(3)]
    expect_rejection_without_write(lambda: invoke(sys.executable, budget_path, records, reps=3, scenarios="ledger"),
                                   budget_path, "exactly two complete passing repetitions")
    shutil.rmtree(root, ignore_errors=True)

    root, budget_path = test_root(fixtures.LEDGER_GENERATION)
    records = [base_record("ledger"), base_record("ledger")]
    records[-1] = copy.deepcopy(records[-1])
    records[-1]["source_sha"] = "different-source"
    expect_rejection_without_write(lambda: invoke(sys.executable, budget_path, records, scenarios="ledger"), budget_path, "inconsistent source_sha")
    root, budget_path = test_root(fixtures.LEDGER_GENERATION)
    with open(budget_path) as f:
        old = json.load(f)
    old["_meta"]["source_sha"] = "old-source"
    old["_meta"]["harness_sha"] = "old-harness"
    with open(budget_path, "w") as f:
        json.dump(old, f)
    before = json.load(open(budget_path))
    records = [base_record("session"), base_record("session")]
    invoke(sys.executable, budget_path, records, scenarios="session")
    changed = json.load(open(budget_path))
    if changed["ledger"] != before["ledger"]: raise AssertionError("session calibration rewrote ledger limits")
    for key in ("ledger_generation", "source_sha", "harness_sha"):
        if changed["_meta"].get(key) != before["_meta"].get(key):
            raise AssertionError(f"session calibration rewrote {key}")
    if gate.generation_mismatch([], changed) is not None:
        raise AssertionError("session calibration produced an unusable ledger generation")
    shutil.rmtree(root, ignore_errors=True)
    print("calibration checks OK: generation failures and preservation are verified")


if __name__ == "__main__":
    check_cases()
