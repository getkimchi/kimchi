"""Build, checkpoint and run the four-condition delivery diagnostic on macOS."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parents[1]
CONTROLLER = REPO / "resources/skills/kimchi-tmux/scripts/harness-live.mjs"


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixture = load("delivery-fixture")
runner = load("run-experiment")
CONDITIONS = ["artifacts", "early", "board", "delayed", "delayed", "board", "early", "artifacts"]


def write_json(path, data):
    pending = path.with_suffix(path.suffix + ".pending")
    pending.write_text(json.dumps(data, indent=2) + "\n")
    pending.replace(path)


def read_json(path):
    return json.loads(path.read_text())


def prepare():
    os.umask(0o077)
    root = Path(tempfile.mkdtemp(prefix="kimchi-delivery-", dir="/private/tmp"))
    print(root, flush=True)
    build = root / "build"
    build.mkdir()
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git", "archive", "HEAD"], cwd=REPO, stdout=archive, check=True)
        archive.seek(0)
        subprocess.run(["tar", "-x", "-C", str(build)], stdin=archive, check=True)
    (build / "node_modules").symlink_to(REPO / "node_modules", target_is_directory=True)
    shutil.copy2(SCRIPTS / "delivery-probe.ts", build / "scripts/agent-communication/delivery-probe.ts")
    index = build / "src/extensions/agents/index.ts"
    source = index.read_text()
    anchor = "\n\tactiveManager = manager\n\tmanager.setMessageEventHandler"
    assert source.count(anchor) == 1
    source = 'import { installDeliveryProbe } from "../../../scripts/agent-communication/delivery-probe.js"\n' + source
    source = source.replace(anchor, "\n\tactiveManager = manager\n\tinstallDeliveryProbe(pi, manager)\n\tmanager.setMessageEventHandler")
    index.write_text(source)
    with (root / "build.log").open("w") as log:
        subprocess.run(["pnpm", "run", "build:binary"], cwd=build, stdout=log, stderr=subprocess.STDOUT, check=True)
    shutil.copytree(build / "dist", root / "runtime", symlinks=True)
    fixture.seed(root / "seed")
    manifest = {
        "protocol_version": 2, "grader_cases": len(fixture.cases()),
        "source_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip(),
        "binary_sha256": runner.digest(root / "runtime/bin/kimchi"),
        "probe_sha256": runner.digest(SCRIPTS / "delivery-probe.ts"),
        "fixture_sha256": runner.digest(SCRIPTS / "delivery-fixture.py"),
        "driver_sha256": runner.digest(Path(__file__)),
        "model": "kimchi-dev/glm-5.3-flash", "thinking": "low", "ferment_v2": False,
        "recipient_limits": {"max_turns": 35, "output_tokens": 10000, "seconds": 600},
        "wall_seconds": 660, "conditions": CONDITIONS,
        "replay": "Host-controlled queued source uses native authorized broker and board. No source inference or autonomous discovery is claimed.",
    }
    write_json(root / "manifest.json", manifest)
    fixture.self_check()
    print("Built isolated diagnostic. Next: checkpoint ROOT", flush=True)
    return root


def setup_trial(root, label, condition):
    trial = root / label
    trial.mkdir()
    home = trial / "home"
    agent = home / ".config/kimchi/harness"
    for path in [agent / "extensions", trial / "tmp", trial / "sockets"]:
        path.mkdir(parents=True)
    source_config = read_json(Path.home() / ".config/kimchi/config.json")
    source_provider = read_json(Path.home() / ".config/kimchi/harness/models.json")["providers"]["kimchi-dev"]
    provider = {**source_provider, "models": [model for model in source_provider["models"] if model["id"] == "glm-5.3-flash"]}
    assert len(provider["models"]) == 1, "Configured diagnostic model missing"
    write_json(home / ".config/kimchi/config.json", {
        **{key: source_config[key] for key in ["apiKey", "llmEndpoint"] if key in source_config},
        "migrationState": "done", "skillPaths": [], "telemetry": {"enabled": False},
        "onboarding": {"hideSessionModeDialog": True, "sessionModeWizardSeenAt": True},
        "surveys": source_config.get("surveys", {}),
    })
    write_json(agent / "models.json", {"providers": {"kimchi-dev": provider}})
    write_json(agent / "settings.json", {"resources": {"extensions.ferment-v2": False, "extensions.agent-communication": True},
                                          "compaction": {"enabled": False}, "hideThinkingBlock": True})
    write_json(agent / "permissions.json", {"defaultMode": "auto"})
    shutil.copy2(root / "build/scripts/agent-communication/delivery-probe.ts", agent / "extensions/delivery-probe.ts")
    protocol = dict(condition=condition, audit=str(trial / "audit.jsonl"), result=str(trial / "result.json"), finding=fixture.FINDING)
    if condition != "checkpoint":
        checkpoint = read_json(root / "checkpoint.json")
        shutil.copy2(root / "checkpoint.jsonl", trial / "checkpoint.jsonl")
        protocol.update(checkpoint=str(trial / "checkpoint.jsonl"), checkpointCwd=checkpoint["cwd"])
    write_json(trial / "protocol.json", protocol)
    profile = trial / "sandbox.sb"
    profile.write_text(f'''(version 1)
(allow default)
(deny file-write*)
(deny file-read* (subpath "/Users") (subpath "/private/tmp") (subpath "/tmp") (subpath "/private/var/folders") (subpath "/var/folders"))
(allow file-read* (subpath "{root}/runtime") (subpath "{trial}"))
(allow file-read-metadata)
(allow file-write* (subpath "{trial}") (subpath "/dev"))
(deny network-outbound)
(allow network-outbound (remote tcp "*:443"))
(allow network-outbound (remote tcp "localhost:*"))
(allow network-outbound (remote unix-socket (subpath "{trial}")))
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
''')
    wrapper = trial / "kimchi"
    wrapper.write_text(f'#!/bin/sh\nexec /usr/bin/sandbox-exec -f "{profile}" "{root}/runtime/bin/kimchi" "$@"\n')
    wrapper.chmod(0o700)
    env = {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home),
           "SHELL": "/bin/bash", "TMPDIR": str(trial / "tmp"), "TMUX_TMPDIR": str(trial / "sockets"),
           "TERM": "xterm-256color", "LANG": "en_US.UTF-8", "KIMCHI_BINARY": str(wrapper),
           "KIMCHI_EXTRA_ARGS": "--thinking low", "KIMCHI_PERMISSIONS": "auto", "KIMCHI_NO_UPDATE_CHECK": "1",
           "KIMCHI_TELEMETRY_ENABLED": "false", "KIMCHI_DELIVERY_PROTOCOL": str(trial / "protocol.json")}
    write_json(trial / "env.json", env)
    checks = []
    for name, command, allowed in [
        ("own-protocol", ["cat", str(trial / "protocol.json")], True),
        ("reference-denied", ["cat", str(SCRIPTS / "delivery-fixture.py")], False),
        ("other-trial-denied", ["cat", str(root / "manifest.json")], False),
        ("outside-write-denied", ["touch", str(root / "forbidden")], False),
        ("python", ["python3", "--version"], True),
        ("binary", [str(wrapper), "--version"], True),
    ]:
        result = subprocess.run(["/usr/bin/sandbox-exec", "-f", str(profile), *command], env=env, cwd=trial, capture_output=True, timeout=30)
        checks.append(dict(name=name, passed=(result.returncode == 0) == allowed, exit_code=result.returncode))
        if name == "binary" and result.returncode:
            (trial / "binary-error.txt").write_bytes(result.stderr)
    write_json(trial / "isolation.json", checks)
    assert all(check["passed"] for check in checks), "Isolation check failed; no inference started"
    return trial, env


def run_trial(root, label, condition):
    manifest = read_json(root / "manifest.json")
    assert runner.digest(root / "runtime/bin/kimchi") == manifest["binary_sha256"]
    assert runner.digest(SCRIPTS / "delivery-fixture.py") == manifest["fixture_sha256"]
    assert runner.digest(SCRIPTS / "delivery-probe.ts") == manifest["probe_sha256"]
    assert runner.digest(Path(__file__)) == manifest["driver_sha256"]
    trial = root / label
    assert not trial.exists(), "Never overwrite or automatically restart an existing attempt"
    env = {}

    def control(action, *args):
        return subprocess.run(["node", str(CONTROLLER), action, *map(str, args)], env=env,
                              capture_output=True, text=True, timeout=30)

    run = None
    started = time.time()
    try:
        trial, env = setup_trial(root, label, condition)
        launched = control("start", "glm-5.3-flash", "kimchi-dev", "default")
        (trial / "startup.txt").write_text(launched.stdout + launched.stderr)
        run_line = next((line[5:] for line in launched.stdout.splitlines() if line.startswith("Run: ")), None)
        run = Path(run_line) if run_line else None
        launched.check_returncode()
        assert run is not None, "Controller did not return a run directory"
        write_json(trial / "run.json", dict(run=str(run), condition=condition, started=started))
        for _ in range(60):
            view = control("status", run).stdout
            if "ask anything or type / for commands" in view:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Startup did not become ready")
        shutil.copytree(root / "seed", run, dirs_exist_ok=True)
        control("send", run, "/delivery-diagnostic").check_returncode()
        print(label, condition, "started", run, flush=True)
        last_report = 0
        while not (trial / "result.json").exists():
            if time.time() - started > manifest["wall_seconds"]:
                raise TimeoutError("Diagnostic wall limit; saved output remains partial")
            if time.time() - last_report > 30:
                view = control("status", run).stdout
                (trial / "latest-tui.txt").write_text(view)
                if view.startswith("Live: false"):
                    raise RuntimeError("Diagnostic process stopped without a completion receipt")
                print(label, "active", round(time.time() - started), "seconds", flush=True)
                last_report = time.time()
            time.sleep(0.25)
        result = read_json(trial / "result.json")
        (trial / "final-tui.txt").write_text(control("status", run).stdout)
        return result
    except Exception as error:
        write_json(trial / "error.json", dict(type=type(error).__name__, message=str(error)))
        raise
    finally:
        live_after_cleanup = None if run else False
        try:
            if run is not None:
                live = read_json(run / "live-run.json")
                probe = subprocess.run(["tmux", "display-message", "-p", "-t", live.get("pane", f"={live['tmux']}"), "#{pane_pid}"], env=env, capture_output=True, text=True)
                captured = runner.descendants(int(probe.stdout)) if probe.returncode == 0 else {}
                control("stop", run)
                runner.stop_descendants(captured)
                assert control("status", run).stdout.startswith("Live: false")
                live_after_cleanup = False
                runner.snapshot(run, trial / "final")
        finally:
            if (trial / "home").exists():
                shutil.rmtree(trial / "home")
            write_json(trial / "cleanup.json", dict(live=live_after_cleanup, home_removed=not (trial / "home").exists()))


def checkpoint(root):
    assert not (root / "checkpoint.json").exists(), "Never replace a saved checkpoint"
    result = run_trial(root, "checkpoint-run", "checkpoint")
    assert result["status"] == "completed", result["status"]
    run = Path(result["cwd"])
    for path in (root / "seed").iterdir():
        assert runner.digest(run / path.name) == runner.digest(path), f"Checkpoint changed {path.name}"
    shutil.copy2(result["sessionFile"], root / "checkpoint.jsonl")
    write_json(root / "checkpoint.json", result)
    paths = [root / "checkpoint.jsonl", root / "manifest.json", *list((root / "seed").iterdir())]
    write_json(root / "seal.json", {str(path): runner.digest(path) for path in paths})
    print("Checkpoint saved and frozen", root, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "checkpoint", "run", "grade"])
    parser.add_argument("root", type=Path, nargs="?")
    parser.add_argument("labels", nargs="*")
    args = parser.parse_args()
    if args.action == "prepare":
        prepare()
        return
    if args.root is None:
        parser.error("root required")
    root = args.root.resolve()
    assert runner.digest(SCRIPTS / "delivery-fixture.py") == read_json(root / "manifest.json")["fixture_sha256"], "Use the frozen fixture version for this capture"
    if args.action == "checkpoint":
        checkpoint(root)
        return
    for path, digest in read_json(root / "seal.json").items():
        assert runner.digest(Path(path)) == digest, f"Frozen input changed: {path}"
    trials = {f"trial-{index:02d}": condition for index, condition in enumerate(CONDITIONS, 1)}
    if args.action == "run":
        for label in args.labels or trials:
            result = run_trial(root, label, trials[label])
            print(label, result["status"], result["usage"], flush=True)
    else:
        for label in args.labels or trials:
            trial = root / label
            candidate = trial / "final/consumer.py"
            if not candidate.exists():
                continue
            grader = trial / "grader.py"
            shutil.copy2(SCRIPTS / "delivery-fixture.py", grader)
            graded = subprocess.run(["/usr/bin/sandbox-exec", "-f", str(trial / "sandbox.sb"),
                                     "python3", str(grader), str(candidate)], cwd=candidate.parent,
                                    env=read_json(trial / "env.json"), capture_output=True, text=True, timeout=30)
            graded.check_returncode()
            grade = json.loads(graded.stdout)
            grade["protected_files_unchanged"] = all(runner.digest(trial / "final" / name) == runner.digest(root / "seed" / name)
                                                     for name in ["TASK.md", "producer.py", "test_consumer.py"])
            write_json(trial / "grade.json", grade)
            print(label, grade["passed"], "/", grade["total"], flush=True)


if __name__ == "__main__":
    main()
