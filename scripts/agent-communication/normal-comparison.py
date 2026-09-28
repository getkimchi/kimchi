"""Compare current communication with ordinary workers using the agreement fixture."""

import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("agreement", SCRIPTS / "agreement-diagnostic.py")
agreement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agreement)
delivery, runner, fixture = agreement.delivery, agreement.runner, agreement.fixture
read, write = agreement.read, agreement.write
CASES = ["changed", "mistaken"]
ARMS = ["workers", "board"]
FROZEN_SCRIPTS = ["normal-comparison.py", "normal-report.py", "agreement-diagnostic.py",
                  "agreement-fixture.py", "delivery-diagnostic.py", "delivery-fixture.py",
                  "delivery-probe.ts", "run-experiment.py", "trace.py"]


def source_state(repo):
    names = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=repo,
    ).decode().split("\0")
    return dict(source_head=subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
        source_sha256={name: runner.digest(repo / name) if (repo / name).is_file() else None
                       for name in sorted(set(names)) if name})


def experiment_source():
    source = (SCRIPTS / "experiment.ts").read_text()
    old = 'if (name === "resume_subagent" || name === "reconcile_agent_result") return true'
    assert source.count(old) == 1
    return source.replace(old, 'if (name === "resume_subagent") return true')


def task():
    old = "Read evidence after editing and verify\nthe final revision=2 before declaring completion. No sleeping/polling for it."
    assert fixture.TASK.count(old) == 1
    return fixture.TASK.replace(old, "The producer owner checks endpoint integration evidence; the consumer owner\nchecks decoding behavior. Both may inspect all evidence whenever useful. The\nparent verifies final revision=2. No sleeping/polling for publication.")


def prompt(arm):
    launches = []
    for role, turns, budget in [("Lifecycle investigator", 35, 10000), ("Implementation owner", 70, 20000)]:
        args = dict(description=role, subagent_type="General-Purpose", model="glm-5.3-flash",
                    thinking="low", run_in_background=True, max_duration=900,
                    max_turns=turns, token_budget=budget, ferment_v2=False)
        if arm != "workers":
            args["communication"] = "group"
        launches.append(args)
    return agreement.prompt(arm).replace(
        "Give both the full task, ownership and evidence-checking instructions.",
        "Give both the full task and ownership. Use ordinary task TODOs and record checks.",
    ).replace(
        "No other workers, retries or resumes.",
        "No other workers, retries or explicit resume_subagent calls. If a useful answer needs a worker continuation, bound reply_to_agent_message to max_turns 2 and max_duration 60. Do not send confirmation-only replies after verified completion.",
    ) + "\nUse these exact Agent argument values, adding each worker's task in prompt: " + json.dumps(launches) + (
        "\nA launch rejection has not started a worker. Correct it; only a successful result with an agent ID counts as launched."
    )


def prepare():
    fixture.self_check()
    os.umask(0o077)
    root = Path(tempfile.mkdtemp(prefix="kimchi-normal-comparison-", dir="/private/tmp"))
    print("Building candidate:", root, flush=True)
    provenance = source_state(delivery.REPO)
    with (root / "build.log").open("w") as log:
        subprocess.run(["pnpm", "run", "build:binary"], cwd=delivery.REPO,
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    assert source_state(delivery.REPO) == provenance, "Source changed during build; prepare a fresh cohort"
    binary = runner.digest(delivery.REPO / "dist/bin/kimchi")
    for repetition in [1, 2]:
        repeat = root / f"repeat-{repetition}"
        repeat.mkdir()
        shutil.copytree(delivery.REPO / "dist", repeat / "runtime", symlinks=True)
        # setup_trial copies this existing extension before execute removes it.
        build = repeat / "build/scripts/agent-communication"
        build.mkdir(parents=True)
        shutil.copy2(SCRIPTS / "delivery-probe.ts", build / "delivery-probe.ts")
        fixture.seed(repeat / "seed")
        (repeat / "seed/TASK.md").write_text(task())
        source = repeat / "protocol-source"
        source.mkdir()
        for name in FROZEN_SCRIPTS:
            shutil.copy2(SCRIPTS / name, source / name)
        shutil.copy2(delivery.CONTROLLER, source / "harness-live.mjs")
        (source / "experiment.ts").write_text(experiment_source())
        for arm in ARMS:
            (source / f"{arm}-prompt.txt").write_text(prompt(arm))
        manifest = dict(experiment="current-communication-vs-normal-workers", repetition=repetition,
                        cases=CASES, arms=ARMS, source_head=provenance["source_head"],
                        source_sha256=provenance["source_sha256"], binary_sha256=binary,
                        build_command="pnpm run build:binary", build_log_sha256=runner.digest(root / "build.log"),
                        launch_instructions="Exact arguments and rejection handling; scoring unchanged from the earlier cohort.",
                        model="kimchi-dev/glm-5.3-flash", thinking="low", ferment_v2=False,
                        wall_seconds=300, max_output_tokens=25000, max_total_tokens=1000000,
                        grader_cases=18, parent_check="python3 verify.py", worker_reread_required=False,
                        limitation="Small previously calibrated task; timing is descriptive, not a long-work quality claim.")
        write(repeat / "manifest.json", manifest)
        paths = [repeat / "manifest.json", *source.iterdir(), *(repeat / "seed").iterdir(),
                 *(p for p in (repeat / "runtime").rglob("*") if p.is_file())]
        write(repeat / "seal.json", {str(path): runner.digest(path) for path in paths})
    assert source_state(delivery.REPO) == provenance, "Source changed while freezing inputs"
    print(root, flush=True)


def verify(repeat):
    for name, digest in read(repeat / "seal.json").items():
        assert runner.digest(Path(name)) == digest, f"Frozen input changed: {name}"
    for name in FROZEN_SCRIPTS:
        assert runner.digest(SCRIPTS / name) == runner.digest(repeat / "protocol-source" / name), name
    assert runner.digest(delivery.CONTROLLER) == runner.digest(repeat / "protocol-source/harness-live.mjs")


def self_check():
    with tempfile.TemporaryDirectory() as directory:
        repo = Path(directory)
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        tracked = repo / "tracked"
        tracked.write_text("before")
        subprocess.run(["git", "add", "tracked"], cwd=repo, check=True)
        subprocess.run(["git", "-c", "user.name=Check", "-c", "user.email=check@example.invalid",
                        "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], cwd=repo, check=True)
        before = source_state(repo)
        tracked.write_text("after")
        assert source_state(repo) != before
        (repo / "untracked").write_text("new")
        assert "untracked" in source_state(repo)["source_sha256"]
        tracked.unlink()
        assert source_state(repo)["source_sha256"]["tracked"] is None
    fixture.self_check()
    for arm in ARMS:
        arguments = json.loads(prompt(arm).split("task in prompt: ")[1].split("\n")[0])
        assert [a["description"] for a in arguments] == ["Lifecycle investigator", "Implementation owner"]
        assert all(a["subagent_type"] == "General-Purpose" for a in arguments)
        assert all((a.get("communication") == "group") == (arm == "board") for a in arguments)
    print("Candidate provenance detects modified, new and deleted files")


if __name__ == "__main__":
    action = sys.argv[1]
    if action == "--self-check":
        self_check()
    elif action == "prepare":
        prepare()
    else:
        root = Path(sys.argv[2]).resolve()
        agreement.CASES, agreement.ARMS = CASES, ARMS
        for repetition in [1, 2]:
            repeat = root / f"repeat-{repetition}"
            verify(repeat)
            if action == "run":
                for case in CASES:
                    arms = ARMS if repetition == 1 else ARMS[::-1]
                    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                        list(pool.map(lambda arm: agreement.execute(repeat, case, arm), arms))
            elif action == "grade":
                agreement.grade(repeat)
            else:
                raise ValueError(action)
