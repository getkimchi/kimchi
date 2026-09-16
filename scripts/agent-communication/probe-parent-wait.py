"""Prepare four isolated parent-wakeup probes; no inference starts here."""

import importlib.util
import json
from pathlib import Path
import subprocess


scripts = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("runner", scripts / "run-experiment.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

COMMON = """Complete the small isolated task in TASK.md. Launch exactly one General-Purpose background worker with description Lifecycle investigator, model glm-5.3-flash, thinking low, max_turns 35, max_duration 900, token_budget 10000, ferment_v2 false, and no communication field. Give it the complete worker assignment from TASK.md. Do not do its work yourself or launch any other worker. Collect its final result, verify the artifact yourself, and report the observed worker status and artifact value. Finish without needing another user prompt. Do not install dependencies, research externally, read personal data or other trials, commit or publish. You have no other work while the worker runs."""

GUIDANCE = """ Background completion notices arrive after your current tool loop ends. If you have no independent work, end your turn so the notice can wake you, or use get_subagent_result with wait: true. Do not wait by sleeping or polling files through bash. Read the returned worker status and abort reason before deciding what happened."""

TASK = """# Parent result-collection probe

The parent delegates the following assignment to one background worker, collects
its result and independently checks the artifact. This is a runtime probe, not
a source repair. Leave repository source unchanged.

## Worker assignment

Read this file. Run one bash command that waits 15 seconds, then writes exactly
`{"value": 2310}` followed by a newline to `worker-result.json` in the current
directory. The delay deliberately keeps this probe's worker alive after its
background launch. Verify the file, then return its path and value. Do not
delegate, edit other files, install anything or research externally.
"""


def main():
    result = subprocess.run([
        "python3", str(scripts / "prepare-experiment.py"), "--purpose", "calibration",
        "--arms", "workers", "workers", "workers", "workers",
        "--max-total-tokens", "1000000", "--max-output-tokens", "10000", "--wall-seconds", "240",
    ], capture_output=True, text=True, check=True)
    root = Path(result.stdout.splitlines()[0])
    manifest = json.loads((root / "manifest.json").read_text())
    manifest.update(purpose="parent-wakeup-probe", workload="one delayed artifact and parent verification",
                    conditions=["native", "guided", "guided", "native"],
                    comparison="Only the parent's waiting guidance changes; product, worker, task and budgets are fixed.")
    (root / "seed/TASK.md").write_text(TASK)
    for trial, condition in zip(manifest["trials"], manifest["conditions"]):
        trial["condition"] = condition
        (Path(trial["directory"]) / "probe/TASK.md").write_text(TASK)
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    subprocess.run(["python3", str(scripts / "check-isolation.py"), str(root)], check=True)
    frozen = runner.seal(root)
    for trial in manifest["trials"]:
        path = root / f"{trial['label']}-prompt.txt"
        path.write_text(COMMON + (GUIDANCE if trial["condition"] == "guided" else "") + "\n")
        frozen[str(path)] = runner.digest(path)
    (root / "seal.json").write_text(json.dumps(frozen, indent=2) + "\n")
    print(root, flush=True)
    print("Prepared and frozen; run with run-experiment.py and all four trial labels.")


if __name__ == "__main__":
    main()
