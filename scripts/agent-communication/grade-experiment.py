"""Grade completed trial snapshots in separate directories, never modifying trial output."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess


spec = importlib.util.spec_from_file_location("preflight", Path(__file__).with_name("preflight-compaction.py"))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


def execute(command, directory, log, environment):
    with log.open("w") as stream:
        try:
            return subprocess.run(command, cwd=directory, env=environment, stdout=stream,
                                  stderr=subprocess.STDOUT, timeout=240).returncode
        except subprocess.TimeoutExpired:
            return 124


def grade(root, label, repo, frozen):
    source = root / f"{label}-final"
    assert source.is_dir(), "Only atomically published final snapshots can be graded"
    base = root / "grading"
    base.mkdir(exist_ok=True)
    destination = base / label
    assert not destination.exists(), "Keep previous grading attempts; do not overwrite them"
    shutil.copytree(source, destination, symlinks=True)
    (destination / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)
    environment = dict(os.environ)
    for key in ["KIMCHI_PERMISSIONS", "KIMCHI_NO_UPDATE_CHECK"]:
        environment.pop(key, None)
    home = base / f"{label}-home"
    home.mkdir()
    environment.update(HOME=str(home), PI_CODING_AGENT_DIR=str(home / "harness"), KIMCHI_CODING_AGENT_DIR=str(home / "harness"))
    protected = ["package.json", "pnpm-lock.yaml", "tsconfig.json", "vitest.config.ts", "TASK.md"]
    protected.extend(str(path.relative_to(root / "seed")) for path in (root / "seed/patches").rglob("*") if path.is_file())
    changed_protected = [name for name in protected if (root / "seed" / name).is_file()
                         and (not (source / name).is_file() or (root / "seed" / name).read_bytes() != (source / name).read_bytes())]
    result = {"label": label, "protected_changes": changed_protected, "own_checks": {}}
    for name in ["test:compaction-local", "typecheck", "check:compaction-style", "build:binary"]:
        result["own_checks"][name] = execute(["pnpm", "run", name], destination,
                                              base / f"{label}-{name.replace(':', '-')}.log", environment)
    if result["own_checks"]["build:binary"] == 0:
        result["binary_sha256"] = hashlib.sha256((destination / "dist/bin/kimchi").read_bytes()).hexdigest()
        for name, expected in frozen["grading_files"].items():
            path = Path(frozen["artifact_root"]) / "reference" / name
            assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, f"Frozen grader changed: {name}"
            (destination / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination / name)
        for kind, command in {
            "process": ["pnpm", "exec", "vitest", "run", "--config", "tests/smoke/vitest.config.ts", preflight.GRADING_FILES[0]],
            "adapter": ["pnpm", "exec", "vitest", "run", "src/extensions/model-guard.test.ts", "-t", preflight.DIAGNOSTICS],
        }.items():
            report = base / f"{label}-{kind}.json"
            code = execute([*command, "--reporter=json", f"--outputFile={report}"], destination,
                           base / f"{label}-{kind}.log", environment)
            data = json.loads(report.read_text()) if report.exists() else {}
            result[kind] = {"exit_code": code, "passed": data.get("numPassedTests"), "failed": data.get("numFailedTests"),
                            "cases": [{"title": case["title"], "status": case["status"], "failures": case.get("failureMessages", [])}
                                      for suite in data.get("testResults", []) for case in suite["assertionResults"]
                                      if case["status"] not in {"pending", "skipped"}]}
    (base / f"{label}-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: value for key, value in result.items() if key not in {"process", "adapter"}}, indent=2), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("labels", nargs="+")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    frozen = json.loads((repo / "docs/subagentComms/compaction-preflight.json").read_text())
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = [pool.submit(grade, args.root.resolve(), label, repo, frozen) for label in args.labels]
        for future in pending:
            future.result()


if __name__ == "__main__":
    main()
