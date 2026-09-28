"""Small live calibration matrix for revising a shared contract; reuses delivery isolation."""

import concurrent.futures
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

import importlib.util


SCRIPTS = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


delivery = load("delivery-diagnostic")
fixture = load("agreement-fixture")
runner = delivery.runner
trace = load("trace")
read, write = delivery.read_json, delivery.write_json
CASES = ["changed", "unchanged", "mistaken"]
ARMS = ["workers", "messages", "board"]


def prompt(arm):
    channel = 'Set communication to "group".' if arm != "workers" else "Do not set communication."
    return f'''Read TASK.md and finish the event bridge. Launch exactly two General-Purpose workers together: Lifecycle investigator owns producer.py; Implementation owner owns consumer.py. Give both the full task, ownership and evidence-checking instructions. Model glm-5.3-flash, thinking low, run_in_background true, max_duration 900, ferment_v2 false. Lifecycle investigator: max_turns 35, token_budget 10000. Implementation owner: max_turns 70, token_budget 20000. {channel}
Use available channels and shared files when another owner's assumption changes; there is no posting quota. Same evidence access for everyone. No other workers, retries or resumes. Correct rejected launch parameters. Collect both results, inspect revision=2 evidence, run python3 verify.py, and repair any incompatibility after both workers finish. Do not finish after announcing a plan. If waiting, get_subagent_result(wait: true) or end the current tool loop so completion notices can arrive; no shell sleep or polling. The host publishes evidence automatically after the first component change. No installs, personal data, external research, commits or publication. Report actual verification and any unresolved work.'''


def prepare():
    fixture.self_check()
    root = delivery.prepare()
    shutil.rmtree(root / "seed")
    fixture.seed(root / "seed")
    manifest = read(root / "manifest.json")
    manifest.update(experiment="changing-agreement-calibration", cases=CASES, arms=ARMS,
                    wall_seconds=300, max_output_tokens=25000, max_total_tokens=1000000,
                    grader_cases=18, conditions=None, replay=None,
                    recipient_limits=None,
                    worker_limits={"producer": {"turns": 35, "output": 10000}, "consumer": {"turns": 70, "output": 20000}},
                    build_note="Reuses delivery build; its test-only command is registered but never invoked. Ordinary parent and workers perform all inference.")
    write(root / "manifest.json", manifest)
    source = root / "protocol-source"
    source.mkdir()
    for name in ["agreement-diagnostic.py", "agreement-fixture.py", "delivery-diagnostic.py", "delivery-fixture.py",
                 "delivery-probe.ts", "experiment.ts", "run-experiment.py", "trace.py"]:
        shutil.copy2(SCRIPTS / name, source / name)
    for arm in ARMS:
        (source / f"{arm}-prompt.txt").write_text(prompt(arm))
    paths = [root / "manifest.json", root / "runtime/bin/kimchi", *source.iterdir(), *(root / "seed").iterdir()]
    write(root / "agreement-seal.json", {str(path): runner.digest(path) for path in paths})
    print("Agreement matrix ready:", root, flush=True)


def execute(root, case, arm):
    label = f"{case}-{arm}"
    trial = root / label
    assert not trial.exists(), "Never replace an existing attempt"
    manifest = read(root / "manifest.json")
    env, run = {}, None
    result = dict(case=case, arm=arm, label=label, edits=[], publication=None)

    def control(action, *args, content=None):
        return subprocess.run(["node", str(delivery.CONTROLLER), action, *map(str, args)],
                              env=env, input=content, capture_output=True, text=True, timeout=30)

    try:
        trial, env = delivery.setup_trial(root, label, "checkpoint")
        extensions = trial / "home/.config/kimchi/harness/extensions"
        (extensions / "delivery-probe.ts").unlink()
        source = (root / "protocol-source/experiment.ts").read_text()
        source += f'\nexport default function(pi: ExtensionAPI) {{ installExperiment(pi, {json.dumps(arm)}, {json.dumps(str(trial / "audit.jsonl"))}); }}\n'
        (extensions / "experiment.ts").write_text(source)
        started = control("start", "glm-5.3-flash", "kimchi-dev", "default")
        (trial / "startup.txt").write_text(started.stdout + started.stderr)
        run_line = next((line[5:] for line in started.stdout.splitlines() if line.startswith("Run: ")), None)
        run = Path(run_line) if run_line else None
        started.check_returncode()
        assert run is not None
        result["run"] = str(run)
        write(trial / "run.json", result)
        for _ in range(60):
            view = control("status", run).stdout
            if "ask anything or type / for commands" in view and f"Communication experiment: {arm}" in view:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Startup did not become ready")
        shutil.copytree(root / "seed", run, dirs_exist_ok=True)
        previous = {name: (run / name).read_bytes() for name in fixture.BASELINE}
        started_at = time.time()
        result["started_at"] = started_at
        control("send", run, "-", content=(root / "protocol-source" / f"{arm}-prompt.txt").read_text()).check_returncode()
        print(label, "started", flush=True)
        settled_at, last_report = None, 0
        while True:
            now = time.time()
            changed = []
            for name in previous:
                content = (run / name).read_bytes() if (run / name).exists() else b""
                if content != previous[name]:
                    changed.append(name)
                    previous[name] = content
            if changed:
                capture = trial / "edits" / str(len(result["edits"]) + 1)
                capture.mkdir(parents=True)
                for name, content in previous.items():
                    (capture / name).write_bytes(content)
                result["edits"].append(dict(at=now, files=changed, path=str(capture)))
                if result["publication"] is None:
                    fixture.publish(run, case)
                    result["publication"] = time.time()
            state = runner.sample(run, trial / "audit.jsonl")
            result["observed"] = state
            reason = None
            if now - started_at > manifest["wall_seconds"]:
                reason = "wall_limit"
            elif state["usage"]["output"] >= manifest["max_output_tokens"] or sum(state["usage"].values()) >= manifest["max_total_tokens"]:
                reason = "token_limit"
            elif state["settled"] and state["workers_terminal"]:
                settled_at = settled_at or now
                if now - settled_at >= 5:
                    reason = "settled"
            else:
                settled_at = None
            if reason:
                result.update(finish_reason=reason, seconds=now - started_at)
                break
            if now - last_report > 30:
                (trial / "latest-tui.txt").write_text(control("status", run).stdout)
                print(label, round(now - started_at), "seconds", state["usage"]["output"], "output tokens", flush=True)
                last_report = now
            time.sleep(0.3)
        (trial / "final-tui.txt").write_text(control("status", run).stdout)
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
    finally:
        live_after = None if run else False
        try:
            if run:
                live = read(run / "live-run.json")
                probe = subprocess.run(["tmux", "display-message", "-p", "-t", live.get("pane", f"={live['tmux']}"), "#{pane_pid}"], env=env, capture_output=True, text=True)
                captured = runner.descendants(int(probe.stdout)) if probe.returncode == 0 else {}
                control("stop", run)
                runner.stop_descendants(captured)
                assert control("status", run).stdout.startswith("Live: false")
                live_after = False
                runner.snapshot(run, trial / "final")
        finally:
            shutil.rmtree(trial / "home", ignore_errors=True)
            write(trial / "cleanup.json", dict(live=live_after, home_removed=not (trial / "home").exists()))
            write(trial / "run.json", result)
    print(label, result.get("finish_reason", result.get("error")), flush=True)
    return result


def grade(root):
    reports = []
    for case in CASES:
        for arm in ARMS:
            trial = root / f"{case}-{arm}"
            if not (trial / "run.json").exists():
                continue
            result = read(trial / "run.json")
            shutil.copy2(root / "protocol-source/agreement-fixture.py", trial / "grader.py")
            env = read(trial / "env.json")
            def sandbox(command, cwd):
                return subprocess.run(["/usr/bin/sandbox-exec", "-f", str(trial / "sandbox.sb"), *command],
                                      cwd=cwd, env=env, capture_output=True, text=True, timeout=30)
            final = trial / "final"
            if not final.exists():
                reports.append(result)
                continue
            before = {name: runner.digest(final / name) for name in ["producer.py", "consumer.py", "upstream.json", "TASK.md", "verify.py", "operator-note.txt"]}
            graded = sandbox(["python3", str(trial / "grader.py"), str(final), case], final)
            graded.check_returncode()
            result["grade"] = json.loads(graded.stdout)
            check = sandbox(["python3", "verify.py"], final)
            result["public_check"] = dict(exit=check.returncode, output=check.stdout + check.stderr)
            expected = fixture.evidence(case) if result["publication"] else fixture.evidence(case, 1)
            result["protected"] = read(final / "upstream.json") == expected and all(
                runner.digest(final / name) == runner.digest(root / "seed" / name) for name in ["TASK.md", "verify.py"])
            assert before == {name: runner.digest(final / name) for name in before}, "Grading changed saved inputs"
            result["source_sha256"] = before
            result["trace"] = trace.analyze(list((Path(result["run"]) / "sessions").glob("*.jsonl")))
            assert result["trace"]["usage"] == result["observed"]["usage"]
            result["cleanup"] = read(trial / "cleanup.json")
            for edit in result["edits"]:
                captured = Path(edit["path"])
                checked = sandbox(["python3", str(trial / "grader.py"), str(captured), case], captured)
                checked.check_returncode()
                edit["grade"] = json.loads(checked.stdout)
            reports.append(result)
            print(result["label"], result["grade"]["passed"], "/18", round(result["seconds"], 1), "seconds", flush=True)
    write(root / "agreement-evaluation.json", dict(manifest=read(root / "manifest.json"), trials=reports))


if __name__ == "__main__":
    action = sys.argv[1]
    if action == "prepare":
        prepare()
    else:
        root = Path(sys.argv[2]).resolve()
        for path, expected in read(root / "agreement-seal.json").items():
            assert runner.digest(Path(path)) == expected, f"Frozen input changed: {path}"
        for name in ["agreement-diagnostic.py", "agreement-fixture.py", "experiment.ts", "delivery-diagnostic.py", "run-experiment.py", "trace.py"]:
            assert runner.digest(SCRIPTS / name) == runner.digest(root / "protocol-source" / name), f"Driver changed: {name}"
        if action == "run":
            for case in sys.argv[3:] or CASES:
                assert case in CASES
                with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                    list(pool.map(lambda arm: execute(root, case, arm), ARMS))
        elif action == "grade":
            grade(root)
        else:
            raise ValueError(action)
