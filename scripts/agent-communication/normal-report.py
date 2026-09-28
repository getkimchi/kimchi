"""Summarize completed normal-mode comparisons without treating activity as quality."""

import ast
import difflib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

spec = importlib.util.spec_from_file_location("comparison", Path(__file__).with_name("normal-comparison.py"))
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)
runner, fixture = comparison.runner, comparison.fixture
read, write = comparison.read, comparison.write


def apply(source, call):
    args = call["arguments"]
    if call["name"] == "write":
        return args["content"]
    for edit in args.get("edits", [args]):
        old = edit["oldText"]
        assert source.count(old) == 1, "Cannot exactly replay edit"
        source = source.replace(old, edit["newText"], 1)
    return source


def analyze(trial, result):
    run = Path(result["run"])
    events, terminal, models = [], {}, set()
    owners, ownership_violations = {}, []
    for path in (run / "sessions").glob("*.jsonl"):
        for row in runner.rows(path):
            record = row.get("data", {})
            if row.get("customType") == "subagents:record" and record.get("sessionFile"):
                owners[Path(record["sessionFile"]).name] = record.get("description")
    resumes = dict(turns=0, output=0, tools=[])
    reconciliation = []
    for path in sorted((run / "sessions").glob("*.jsonl")):
        rows = runner.rows(path)
        child = bool(rows[0].get("parentSession"))
        calls, resumed = {}, False
        for row in rows:
            record = row.get("data", {})
            if row.get("customType") == "subagents:record" and record.get("status") in runner.TERMINAL and record.get("completedAt"):
                terminal.setdefault(record["id"], record["completedAt"])
            m = row.get("message", {})
            content = m.get("content", [])
            text = content if isinstance(content, str) else "\n".join(b.get("text", "") for b in content)
            if child and m.get("role") == "user" and text.startswith("Host-mediated answer to your message"):
                resumed = True
            if m.get("role") == "assistant":
                models.add(m["provider"] + "/" + m["model"])
                calls.update({b["id"]: b for b in content if b.get("type") == "toolCall"})
                if resumed:
                    resumes["turns"] += 1
                    resumes["output"] += m.get("usage", {}).get("output", 0)
                    resumes["tools"].extend(b["name"] for b in content if b.get("type") == "toolCall")
            if m.get("role") != "toolResult":
                continue
            call = calls.get(m.get("toolCallId"))
            if m.get("toolName") == "reconcile_agent_result":
                reconciliation.append(dict(error=bool(m.get("isError")), closed_questions="Closed questions:" in text))
            if m.get("isError") or not call or call["name"] not in {"write", "edit"}:
                continue
            target = Path(call["arguments"].get("path", ""))
            target = target if target.is_absolute() else run / target
            if target.parent == run and target.name in fixture.BASELINE:
                events.append((m["timestamp"], child, target.name, call))
                expected = {"Lifecycle investigator": "producer.py", "Implementation owner": "consumer.py"}.get(owners.get(path.name))
                if child and target.name != expected:
                    ownership_violations.append(dict(owner=owners.get(path.name), file=target.name))
    assert models == {"kimchi-dev/glm-5.3-flash"}, models
    assert len(terminal) == 2, terminal
    handoff_at = max(terminal.values())
    source, handoff = dict(fixture.BASELINE), dict(fixture.BASELINE)
    parent_edits, parent_churn = 0, 0
    for timestamp, child, name, call in sorted(events):
        before = source[name]
        source[name] = apply(before, call)
        if timestamp <= handoff_at:
            handoff = dict(source)
        if not child:
            parent_edits += 1
            parent_churn += sum(line[0:1] in {"+", "-"} for line in difflib.ndiff(before.splitlines(), source[name].splitlines()))
    exact = all(source[name] == (trial / "final" / name).read_text() for name in source)
    assert exact, "Source replay differs from final artifact; inspect shell writes before claiming a handoff"
    frozen = trial / "handoff-replay"
    frozen.mkdir(exist_ok=True)
    for name, content in handoff.items():
        (frozen / name).write_text(content)
    env = read(trial / "env.json")
    def sandbox(command, cwd):
        return subprocess.run(["/usr/bin/sandbox-exec", "-f", str(trial / "sandbox.sb"), *command],
                              env=env, cwd=cwd, capture_output=True, text=True, timeout=30)
    graded = sandbox(["python3", str(trial / "grader.py"), str(frozen), result["case"]], frozen)
    graded.check_returncode()
    own = trial / "own-tests"
    if not own.exists():
        shutil.copytree(trial / "final", own)
    tests = sandbox(["python3", "-m", "unittest", "discover", "-s", ".", "-p", "test*.py"], own)
    scripts = []
    for path in sorted(own.glob("test*.py")):
        checked = sandbox(["python3", path.name], own)
        scripts.append(dict(file=path.name, exit=checked.returncode, output=checked.stdout + checked.stderr))
    definitions = {}
    for name in source:
        definitions[name] = [node.name for node in ast.parse(source[name]).body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    audit = runner.rows(trial / "audit.jsonl")
    requests = [r for r in audit if r.get("kind") == "request"]
    communication = {"list_agent_contacts", "send_agent_message", "reply_to_agent_message", "read_agent_board", "post_agent_note", "reconcile_agent_result"}
    if result["arm"] == "workers":
        assert all(not communication.intersection(r["tools"]) for r in requests)
    else:
        assert any("reconcile_agent_result" in r["tools"] for r in requests if not r.get("parentSession"))
        assert any("read_agent_board" in r["tools"] for r in requests if r.get("parentSession"))
    launches = [r for r in audit if r.get("kind") == "launch_or_rejection" and r.get("tool") == "Agent" and not r.get("reason")]
    assert len(launches) == 2
    return dict(handoff_grade=json.loads(graded.stdout), source_replay_exact=exact,
                handoff_definition="Source at the later of the two first terminal worker records; later reply continuations count separately.",
                parent_production_edits=parent_edits, parent_production_line_churn=parent_churn,
                resumed_worker=resumes, reconciliations=reconciliation,
                own_unittest=dict(exit=tests.returncode, output=tests.stdout + tests.stderr),
                own_test_scripts=scripts,
                definitions=definitions, production_lines=sum(len(s.splitlines()) for s in source.values()),
                ownership_violations=ownership_violations,
                request_channels_verified=True, accepted_launches=len(launches))


def report(root):
    rows = []
    for repetition in [1, 2]:
        repeat = root / f"repeat-{repetition}"
        comparison.verify(repeat)
        evaluation = read(repeat / "agreement-evaluation.json")
        for result in evaluation["trials"]:
            trial = repeat / result["label"]
            assert result["cleanup"] == dict(live=False, home_removed=True)
            assert result["protected"]
            assert all(c["passed"] for c in read(trial / "isolation.json"))
            supplement = analyze(trial, result)
            correct_at = next((e["at"] - result["started_at"] for e in result["edits"] if e["grade"]["passed"] == 18), None)
            peer_reads = [(e["timestamp"] / 1000 - result["started_at"]) for e in result["trace"]["board_reads"] if e["own_entry"] is False]
            rows.append(dict(repetition=repetition, label=result["label"], arm=result["arm"], case=result["case"],
                             finish_reason=result["finish_reason"], seconds=result["seconds"],
                             grade=result["grade"], public_check=result["public_check"], usage=result["trace"]["usage"],
                             communication=result["trace"]["summary"], cleanup=result["cleanup"],
                             first_full_score_seconds=correct_at, peer_board_read_seconds=peer_reads,
                             source_sha256=result["source_sha256"], **supplement))
    assert len(rows) == 8
    aggregates = {}
    for arm in comparison.ARMS:
        trials = [r for r in rows if r["arm"] == arm]
        aggregates[arm] = dict(trials=len(trials), final_passed=sum(r["grade"]["passed"] for r in trials),
                               handoff_passed=sum(r["handoff_grade"]["passed"] for r in trials),
                               checks=sum(r["grade"]["total"] for r in trials),
                               mean_seconds=sum(r["seconds"] for r in trials) / len(trials),
                               usage={key: sum(r["usage"][key] for r in trials) for key in trials[0]["usage"]})
    output = dict(capture_root=str(root), report_sha256=runner.digest(Path(__file__)), manifest=read(root / "repeat-1/manifest.json"), trials=rows,
                  aggregates=aggregates,
                  limitations=["Two repeats per case; one small calibrated task and model.",
                               "Concurrent pairs share backend capacity; elapsed time is descriptive.",
                               "Unittest discovery and test-file execution are recorded separately; merely importing a test file does not prove its assertions ran. No broad style/readability score.",
                               "Exact replay covers successful write/edit calls; inspect shell commands before trusting intermediate handoffs."])
    write(root / "normal-evaluation.json", output)
    for r in rows:
        print(r["repetition"], r["label"], "handoff", r["handoff_grade"]["passed"], "final", r["grade"]["passed"],
              "parent edits", r["parent_production_edits"], "output", r["usage"]["output"])


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-check"]:
        assert apply("old", {"name": "write", "arguments": {"content": "new"}}) == "new"
        assert apply("one two", {"name": "edit", "arguments": {"oldText": "two", "newText": "three"}}) == "one three"
        assert apply("one two", {"name": "edit", "arguments": {"edits": [
            {"oldText": "one", "newText": "three"}, {"oldText": "two", "newText": "four"},
        ]}}) == "three four"
        try:
            apply("two two", {"name": "edit", "arguments": {"oldText": "two", "newText": "three"}})
        except AssertionError:
            pass
        else:
            raise AssertionError("Ambiguous replay must fail")
        print("Exact edit replay checks passed")
    else:
        report(Path(sys.argv[1]).resolve())
