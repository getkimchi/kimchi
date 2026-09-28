"""Audit completed delivery trials; retain observations without inferring causality."""

from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys


SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("diagnostic", SCRIPTS / "delivery-diagnostic.py")
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


def normalized(text):
    return " ".join(text.replace("\\n", " ").split())


def has_finding(value):
    finding = normalized(diagnostic.fixture.FINDING)
    return any(finding in normalized(text) for text in strings(value))


def check_unstarted_attempt(trial):
    """Recheck the original calibration gap; version 2 also covers it in its grader."""
    reference = trial / "reference.py"
    baseline = trial / "baseline.py"
    reference.write_text(diagnostic.fixture.REFERENCE)
    baseline.write_text(diagnostic.fixture.BASELINE)
    check = trial / "supplement.py"
    check.write_text('''import importlib.util, json, sys
results = {}
for path in sys.argv[1:]:
    spec = importlib.util.spec_from_file_location("candidate", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    events = [{"job": "a", "attempt": 1, "kind": "started"},
              {"job": "a", "attempt": 2, "kind": "completed", "value": 7}]
    expected = {"a": {"attempt": 1, "status": "running", "value": None}}
    actual = module.project(events)
    results[path] = {"passed": actual == expected, "actual": actual, "expected": expected}
print(json.dumps(results))
''')
    candidate = trial / "final/consumer.py"
    checked = subprocess.run(["/usr/bin/sandbox-exec", "-f", str(trial / "sandbox.sb"),
                              "python3", str(check), str(baseline), str(reference), str(candidate)],
                             cwd=trial / "final", env=diagnostic.read_json(trial / "env.json"),
                             capture_output=True, text=True, timeout=30, check=True)
    results = json.loads(checked.stdout)
    assert not results[str(baseline)]["passed"] and results[str(reference)]["passed"]
    return results[str(candidate)]


def analyze(trial):
    result = diagnostic.read_json(trial / "result.json")
    cleanup = diagnostic.read_json(trial / "cleanup.json")
    assert cleanup == dict(live=False, home_removed=True), cleanup
    assert result["status"] == "completed", result
    rows = [json.loads(line) for line in (trial / "audit.jsonl").read_text().splitlines()]
    checkpoint = next(row for row in rows if row["kind"] == "checkpoint")
    requests = [row for row in rows if row["kind"] == "request"]
    edits = [row for row in rows if row["kind"] == "edit"]
    assert edits and edits[-1]["after"] == (trial / "final/consumer.py").read_text(), "Final mutation missing from audit"
    received = [row for row in requests if has_finding(row["payload"]["messages"])]
    calls = [row for row in rows if row["kind"] == "tool_call"]
    run = Path(diagnostic.read_json(trial / "run.json")["run"])
    usage = Counter(input=0, output=0, cacheRead=0, cacheWrite=0)
    sessions_with_new_inference = set()
    recipient_session = None
    for path in (run / "sessions").glob("*.jsonl"):
        entries = [json.loads(line) for line in path.read_text().splitlines()]
        is_recipient = path == Path(result["sessionFile"])
        if is_recipient:
            recipient_session = entries[0]["id"]
        for entry in entries[1 + checkpoint["entryCount"]:] if is_recipient else entries[1:]:
            message = entry.get("message", {})
            if message.get("role") == "assistant":
                sessions_with_new_inference.add(entries[0]["id"])
                for key in usage:
                    usage[key] += message.get("usage", {}).get(key, 0)
    assert sessions_with_new_inference == {recipient_session}, sessions_with_new_inference
    assert all(row["sessionId"] == recipient_session for row in requests)
    checkpoint_usage = diagnostic.read_json(trial.parent / "checkpoint.json")["usage"]
    # Native session totals include the cloned checkpoint's already-paid history.
    assert {key: usage[key] + checkpoint_usage[key] for key in usage} == result["usage"]
    assert all(row["payload"]["model"] == "glm-5.3-flash" and row["payload"]["reasoning_effort"] == "low" for row in requests)

    # Replay saved edits only after the worker has stopped, under its original sandbox.
    edit_scores = []
    for index, edit in enumerate(edits):
        candidate = trial / f"edit-{index + 1}.py"
        candidate.write_text(edit["after"])
        graded = subprocess.run(["/usr/bin/sandbox-exec", "-f", str(trial / "sandbox.sb"),
                                 "python3", str(trial / "grader.py"), str(candidate)],
                                cwd=trial / "final", env=diagnostic.read_json(trial / "env.json"),
                                capture_output=True, text=True, timeout=30, check=True)
        score = json.loads(graded.stdout)
        edit_scores.append(dict(time=edit["time"], passed=score["passed"], total=score["total"]))
    body_time = received[0]["time"] if received else None
    first_edit = edits[0]["time"] if edits else None
    grade = diagnostic.read_json(trial / "grade.json")
    assert grade["protected_files_unchanged"]
    own_checks = []
    for path in sorted((trial / "final").glob("*.py")):
        if path.name in {"consumer.py", "producer.py"}:
            continue
        checked = subprocess.run(["/usr/bin/sandbox-exec", "-f", str(trial / "sandbox.sb"), "python3", str(path)],
                                 cwd=trial / "final", env=diagnostic.read_json(trial / "env.json"),
                                 capture_output=True, text=True, timeout=30)
        own_checks.append(dict(file=path.name, exit_code=checked.returncode))
    condition = result["condition"]
    if condition == "artifacts":
        assert not received and not result["published"]
    elif condition == "early":
        assert received and received[0] == requests[0] and body_time < first_edit
    elif condition == "delayed":
        assert received and first_edit < body_time
    elif condition == "board":
        assert any(row["kind"] == "receipt" and row["receipt"].get("ok") for row in rows)
    return dict(label=trial.name, condition=condition, status=result["status"],
                passed=grade["passed"], total=grade["total"], protected_files_unchanged=True,
                seconds=(result["completedAt"] - result["startedAt"]) / 1000,
                usage=dict(usage), request_count=len(requests), source_status=result["sourceStatus"],
                checkpoint_hash=checkpoint["entriesHash"],
                tool_schema_hash=hashlib.sha256(json.dumps(requests[0]["payload"]["tools"], sort_keys=True).encode()).hexdigest(),
                first_body_request=next((i + 1 for i, row in enumerate(requests) if has_finding(row["payload"]["messages"])), None),
                body_before_first_edit=body_time < first_edit if body_time and first_edit else None,
                board_reads=sum(row["tool"] == "read_agent_board" for row in calls),
                tool_calls=dict(Counter(row["tool"] for row in calls)), edits=edit_scores,
                consumer_sha256=diagnostic.runner.digest(trial / "final/consumer.py"), own_checks=own_checks,
                unstarted_attempt_check=check_unstarted_attempt(trial), cleanup=cleanup)


def main():
    root = Path(sys.argv[1]).resolve()
    for path, digest in diagnostic.read_json(root / "seal.json").items():
        assert diagnostic.runner.digest(Path(path)) == digest, f"Frozen input changed: {path}"
    manifest = diagnostic.read_json(root / "manifest.json")
    assert diagnostic.runner.digest(root / "runtime/bin/kimchi") == manifest["binary_sha256"]
    trials = [analyze(path) for path in sorted(root.glob("trial-*")) if (path / "grade.json").exists()]
    assert trials, "No graded trials"
    assert len({trial["checkpoint_hash"] for trial in trials}) == 1
    assert len({trial["tool_schema_hash"] for trial in trials}) == 1
    expected = {f"trial-{index:02d}": condition for index, condition in enumerate(manifest["conditions"], 1)}
    assert all(expected[trial["label"]] == trial["condition"] for trial in trials)
    report = dict(manifest=manifest, complete=set(expected) == {trial["label"] for trial in trials},
                  report_sha256=diagnostic.runner.digest(Path(__file__)),
                  checkpoint_usage=diagnostic.read_json(root / "checkpoint.json")["usage"], trials=trials)
    diagnostic.write_json(root / "evaluation.json", report)
    for trial in trials:
        print(trial["label"], trial["condition"], f'{trial["passed"]}/{trial["total"]}',
              trial["seconds"], "seconds", "body request", trial["first_body_request"], "edits", len(trial["edits"]))


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-check"]:
        finding = diagnostic.fixture.FINDING
        assert has_finding({"content": [{"text": finding}]})
        assert has_finding({"content": json.dumps({"summary": finding})})
        assert has_finding({"body": normalized(finding)})
        assert not has_finding({"title": "Cancellation request is not an outcome"})
        assert not has_finding({"content": finding[:80]})
        print("Exact body detection checks passed")
    else:
        main()
