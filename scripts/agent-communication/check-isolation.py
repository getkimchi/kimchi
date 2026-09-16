"""Check each prepared sandbox before exposing a workload to a live model."""

import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    attempt = len(list(root.glob("isolation-attempt-*.json"))) + 1
    checks = []
    for trial in manifest["trials"]:
        directory = Path(trial["directory"])
        environment = json.loads((directory / "env.json").read_text())
        prefix = ["/usr/bin/sandbox-exec", "-f", str(directory / "sandbox.sb")]

        def check(name, command, allowed, timeout=30):
            result = subprocess.run(prefix + command, cwd=directory / "probe", env=environment,
                                    capture_output=True, text=True, timeout=timeout)
            passed = (result.returncode == 0) == allowed
            checks.append({"trial": trial["label"], "name": name, "exit_code": result.returncode, "passed": passed})
            (root / "isolation.json").write_text(json.dumps(checks, indent=2) + "\n")
            (root / f"isolation-attempt-{attempt:02d}.json").write_text(json.dumps(checks, indent=2) + "\n")
            if not passed:
                (directory / f"preflight-{name}-{attempt:02d}.log").write_text(result.stdout + result.stderr)
                raise RuntimeError(f"{trial['label']}: {name} failed; inspect retained log")

        for name, path, allowed in [
            ("own-task", directory / "probe/TASK.md", True),
            ("parent-seed", root / "seed/TASK.md", False),
            ("other-trial", root / ("trial-02" if trial["label"] == "trial-01" else "trial-01") / "probe/TASK.md", False),
            ("original-checkout", Path(__file__).resolve().parents[2] / "package.json", False),
        ]:
            assert path.exists(), path
            check(name, ["/bin/cat", str(path)], allowed)
        check("outside-write", ["/usr/bin/touch", str(root / "forbidden")], False)
        check("dependency-write", ["/usr/bin/touch", str(root / "toolchain/forbidden")], False)
        check("npm-blocked", ["/opt/homebrew/bin/npm", "--version"], False)
        check("pnpm", [str(directory / "bin/pnpm"), "--version"], True)
        check("binary", [str(root / "runtime/bin/kimchi"), "--version"], True)
        if trial["label"] == "trial-01":
            check("public-tests", [str(directory / "bin/pnpm"), "run", "test:compaction-local"], True, 120)
            check("typecheck", [str(directory / "bin/pnpm"), "run", "typecheck"], True, 120)
    print(f"{len(checks)} isolation and toolchain checks passed")


if __name__ == "__main__":
    main()
