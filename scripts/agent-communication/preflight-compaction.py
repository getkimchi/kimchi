"""Build historical compaction binaries and check the same process regression against both."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


REFS = {
    "baseline": "76337bd7f794331b6310c7e7f78272b4dd400f5d",
    "reference": "716bd797c9802b20ef1da4ccde7caace26173a22",
}
GRADING_FILES = [
    "tests/smoke/print-mid-turn-compaction.test.ts",
    "tests/smoke/print-config.ts",
    "tests/e2e/tui/support/fake-openai-server.ts",
]


def run(command, cwd, log):
    with log.open("w") as output:
        return subprocess.run(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT).returncode


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(repo, root, label, ref):
    destination = root / label
    destination.mkdir()
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git", "archive", ref], cwd=repo, stdout=archive, check=True)
        archive.seek(0)
        subprocess.run(["tar", "-x", "-C", str(destination)], stdin=archive, check=True)
    (destination / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)
    code = run(["pnpm", "run", "build:binary"], destination, root / f"{label}-build.log")
    if code:
        raise RuntimeError(f"{label} build failed ({code}); see {root / (label + '-build.log')}")
    return digest(destination / "dist/bin/kimchi")


def grade(root, label):
    command = ["pnpm", "exec", "vitest", "run", "--config", "tests/smoke/vitest.config.ts",
               GRADING_FILES[0], "--reporter=json", f"--outputFile=../{label}-process-tests.json"]
    code = run(command, root / label, root / f"{label}-tests.log")
    report = json.loads((root / f"{label}-process-tests.json").read_text())
    return {
        "command": command, "exit_code": code,
        "passed": report["numPassedTests"], "failed": report["numFailedTests"],
        "cases": [{"title": case["title"], "status": case["status"]}
                  for suite in report["testResults"] for case in suite["assertionResults"]],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    repo = args.repo.resolve()
    root = Path(tempfile.mkdtemp(prefix="kimchi-comms-compaction-")).resolve()
    print(root, flush=True)
    source = {"runner_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
              "refs": REFS, "repository": str(repo)}
    (root / "source.json").write_text(json.dumps(source, indent=2) + "\n")
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = {label: pool.submit(prepare, repo, root, label, ref) for label, ref in REFS.items()}
        binaries = {label: future.result() for label, future in pending.items()}
    for name in GRADING_FILES:
        shutil.copy2(root / "reference" / name, root / "baseline" / name)
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = {label: pool.submit(grade, root, label) for label in REFS}
        results = {label: future.result() for label, future in pending.items()}
    report = {**source, "binaries": binaries,
              "grading_files": {name: digest(root / "reference" / name) for name in GRADING_FILES},
              "results": results,
              "scope": "Grader preflight only; no agent-generated changes or communication comparison."}
    (root / "preflight.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(results, indent=2))
    expected = {"baseline": ["failed", "passed"], "reference": ["passed", "passed"]}
    for label, statuses in expected.items():
        if [case["status"] for case in results[label]["cases"]] != statuses:
            raise SystemExit(f"Unexpected {label} results; inspect retained artifacts before using this grader")


if __name__ == "__main__":
    main()
