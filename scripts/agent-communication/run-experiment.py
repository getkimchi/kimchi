"""Run prepared trials through the bundled TMUX controller, retaining every attempt."""

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import time


TERMINAL = {"completed", "steered", "error", "aborted", "stopped"}
IGNORE = {".git", ".kimchi", "sessions", "node_modules", "dist", ".cache", ".test-home", "live-run.json"}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def seal(root):
    paths = [root / "manifest.json", root / "runtime/bin/kimchi"]
    for directory in [root / "seed", Path(__file__).parent]:
        paths.extend(path for path in directory.rglob("*") if path.is_file()
                     and "node_modules" not in path.parts and "__pycache__" not in path.parts)
    for trial in json.loads((root / "manifest.json").read_text())["trials"]:
        directory = Path(trial["directory"])
        paths.extend(directory / name for name in ["env.json", "sandbox.sb", "kimchi", "home/.config/kimchi/harness/extensions/experiment.ts", "home/.config/kimchi/harness/settings.json"])
        task = root / f"{trial['label']}-prompt.txt"
        task.write_text(prompt(trial["arm"]) + "\n")
        paths.append(task)
    return {str(path): digest(path) for path in paths}


def descendants(pid):
    entries = [line.split(None, 2) for line in subprocess.check_output(["ps", "-axo", "pid=,ppid=,command="], text=True).splitlines()]
    found = {pid}
    while True:
        children = {int(row[0]) for row in entries if int(row[1]) in found}
        if children <= found:
            break
        found |= children
    return {int(row[0]): row[2] for row in entries if int(row[0]) in found}


def stop_descendants(captured):
    # Only signal still-matching processes captured below this trial's own pane.
    for sig in [signal.SIGTERM, signal.SIGKILL]:
        current = {int(row[0]): row[1] for line in subprocess.check_output(["ps", "-axo", "pid=,command="], text=True).splitlines() if len(row := line.split(None, 1)) == 2}
        remaining = {pid: command for pid, command in captured.items() if current.get(pid) == command}
        for pid in remaining:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        if remaining:
            time.sleep(0.5)
    current = {int(line.split()[0]) for line in subprocess.check_output(["ps", "-axo", "pid="], text=True).splitlines()}
    assert not (set(remaining) & current), "Trial descendants remain; do not snapshot yet"


def rows(path):
    text = path.read_text()
    result = []
    lines = text.splitlines()
    for index, line in enumerate(lines):
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            if index != len(lines) - 1 or text.endswith("\n"):
                raise
    return result


def snapshot(source, destination):
    staging = destination.with_name(destination.name + ".copying")
    def ignored(path, names):
        excluded = IGNORE if Path(path) == source else {".git", "node_modules", ".cache", ".test-home"}
        return set(names) & excluded
    shutil.copytree(source, staging, symlinks=True, ignore=ignored)
    staging.rename(destination)


def sample(run):
    usage = Counter(input=0, output=0, cacheRead=0, cacheWrite=0)
    parent = []
    for path in (run / "sessions").glob("*.jsonl"):
        entries = rows(path)
        if not entries:
            continue
        if entries[0].get("type") == "session" and not entries[0].get("parentSession"):
            parent = entries
        for entry in entries:
            message = entry.get("message", {})
            if entry.get("type") == "message" and message.get("role") == "assistant":
                for key in usage:
                    usage[key] += message.get("usage", {}).get(key, 0)
    records = {entry["data"]["id"]: entry["data"] for entry in parent
               if entry.get("customType") == "subagents:record" and entry.get("data", {}).get("visibility") == "user"}
    messages = [entry["message"] for entry in parent if entry.get("type") == "message"]
    last = messages[-1] if messages else {}
    settled = last.get("role") == "assistant" and last.get("stopReason") in {"stop", "error", "aborted"}
    latest_worker = max((record.get("completedAt", 0) or 0 for record in records.values()), default=0)
    return {"usage": dict(usage), "records": list(records.values()),
            "settled": settled and last.get("timestamp", 0) >= latest_worker,
            "workers_terminal": all(record["status"] in TERMINAL for record in records.values())}


def prompt(arm):
    common = "Read TASK.md and complete the isolated compaction repair. All source and installed dependencies are available. Use ordinary TODOs and record concrete checks. Preserve protected files and other owners' edits. Do not install dependencies, research externally, inspect personal data or other trials, commit, or publish. Run all three public verification commands and report actual failures. Finish without asking for another user prompt. "
    if arm == "solo":
        return common + "This is the solo arm: investigate, implement, review and repair the complete task yourself without delegation."
    channel = "Do not set communication." if arm == "workers" else 'Set communication to "group".'
    return common + f'''Launch exactly three General-Purpose workers together in one tool-call batch, with exact descriptions Lifecycle investigator, Boundary investigator and Implementation owner. Model glm-5.3-flash, thinking low, run_in_background true, max_duration 900, ferment_v2 false. Both investigators use max_turns 35 and token_budget 10000; the Implementation owner uses max_turns 70 and token_budget 20000. {channel} Give each the full TASK scope, its exact ownership, and instructions to read TASK.md before working. Every worker can read all files and use its owned shared notes and available channels. There is no posting or question quota. Inspect emerging findings and relay useful information while they run. Correct rejected launches, but never retry or resume a started worker. Collect all three final results, review the combined work, then launch one Repair owner (General-Purpose, same model/thinking/channel, background, max_turns 70, max_duration 900, token_budget 10000, ferment_v2 false) with the complete task and findings. It owns repair and verification after initial workers finish, and must run all three public checks. Do not repair production directly. Collect its result and report actual verification. No other workers. Do not use reconcile_agent_result in this comparison.'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("labels", nargs="*")
    parser.add_argument("--seal", action="store_true", help="Freeze inputs before any trial starts")
    args = parser.parse_args()
    root = args.root.resolve()
    if args.seal:
        assert not (root / "seal.json").exists(), "Do not overwrite a frozen protocol"
        (root / "seal.json").write_text(json.dumps(seal(root), indent=2) + "\n")
        return
    assert args.labels
    manifest = json.loads((root / "manifest.json").read_text())
    controller = Path(__file__).resolve().parents[2] / "resources/skills/kimchi-tmux/scripts/harness-live.mjs"
    trials = {trial["label"]: trial for trial in manifest["trials"]}
    assert all(check["passed"] for check in json.loads((root / "isolation.json").read_text()))
    for name, expected in json.loads((root / "seal.json").read_text()).items():
        path = Path(name)
        # Completed trials have their credential homes removed.
        if not path.exists() and any((root / f"{trial['label']}-cleanup.json").exists() and path.is_relative_to(Path(trial["directory"]) / "home") for trial in trials.values()):
            continue
        assert digest(path) == expected, f"Frozen input changed: {path}"

    def control(trial, action, *arguments, content=None):
        environment = json.loads((Path(trial["directory"]) / "env.json").read_text())
        return subprocess.run(["node", str(controller), action, *map(str, arguments)],
                              env=environment, input=content, capture_output=True, text=True, timeout=30)

    active = []
    for label in args.labels:
        trial = dict(trials[label])
        receipt = root / f"{label}-run.json"
        assert not receipt.exists(), "Never automatically restart an existing trial"
        result = control(trial, "start", "glm-5.3-flash", "kimchi-dev", "default")
        if result.returncode:
            raise RuntimeError(result.stderr + result.stdout)
        run = Path(next(line[5:] for line in result.stdout.splitlines() if line.startswith("Run: ")))
        trial["run"] = str(run)
        receipt.write_text(json.dumps(trial, indent=2) + "\n")
        for _ in range(40):
            view = control(trial, "status", run).stdout
            if "ask anything or type / for commands" in view and f"Communication experiment: {trial['arm']}" in view:
                break
            time.sleep(0.5)
        else:
            (root / f"{label}-startup.txt").write_text(view)
            raise RuntimeError(f"{label} not ready; inspect its existing session")
        shutil.copytree(root / "seed", run, dirs_exist_ok=True, symlinks=True)
        subprocess.run(["git", "add", "--", ".", ":!live-run.json", ":!sessions"], cwd=run, check=True)
        subprocess.run(["git", "-c", "user.name=CommunicationEval", "-c", "user.email=eval@localhost", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Isolated task baseline"], cwd=run, check=True)
        (root / f"{label}-preflight-tui.txt").write_text(view)
        task_prompt = (root / f"{label}-prompt.txt").read_text()
        sent = control(trial, "send", run, "-", content=task_prompt)
        assert sent.returncode == 0, sent.stderr
        trial["started_at"] = time.time()
        receipt.write_text(json.dumps(trial, indent=2) + "\n")
        active.append(trial)
        print(label, trial["arm"], "started", run, flush=True)

    last_report = 0
    while active:
        for trial in list(active):
            run = Path(trial["run"])
            state = sample(run)
            usage = state["usage"]
            reason = None
            if time.time() - trial["started_at"] > manifest["wall_seconds"]:
                reason = "wall_limit"
            elif usage["output"] >= manifest["max_output_tokens"] or sum(usage.values()) >= manifest["max_total_tokens"]:
                reason = "token_limit"
            elif state["settled"] and state["workers_terminal"]:
                trial.setdefault("settled_seen", time.time())
                if time.time() - trial["settled_seen"] >= 5:
                    reason = "settled"
            else:
                trial.pop("settled_seen", None)
            if reason:
                view = control(trial, "status", run).stdout
                (root / f"{trial['label']}-final-tui.txt").write_text(view)
                environment = json.loads((Path(trial["directory"]) / "env.json").read_text())
                live = json.loads((run / "live-run.json").read_text())
                pid = int(subprocess.check_output(["tmux", "display-message", "-p", "-t", live["pane"], "#{pane_pid}"], env=environment, text=True))
                captured = descendants(pid)
                control(trial, "stop", run)
                stop_descendants(captured)
                stopped = control(trial, "status", run)
                assert stopped.stdout.startswith("Live: false"), stopped.stdout
                snapshot(run, root / f"{trial['label']}-final")
                trial.update(finished_at=time.time(), finish_reason=reason, observed=state)
                (root / f"{trial['label']}-run.json").write_text(json.dumps(trial, indent=2) + "\n")
                home = Path(trial["directory"]) / "home"
                shutil.rmtree(home)
                (root / f"{trial['label']}-cleanup.json").write_text(json.dumps({"live": False, "home_removed": not home.exists()}) + "\n")
                print(trial["label"], reason, usage, flush=True)
                active.remove(trial)
        if time.time() - last_report >= 30:
            print("Active:", ", ".join(trial["label"] for trial in active), flush=True)
            last_report = time.time()
        time.sleep(0.5)


if __name__ == "__main__":
    main()
