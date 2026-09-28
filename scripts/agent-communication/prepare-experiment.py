"""Prepare isolated local homes and sandbox profiles; does not start inference."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arms", nargs="+", choices=["solo", "workers", "messages", "board"],
                        default=["solo", "workers", "messages", "board", "board", "messages", "workers", "solo"])
    parser.add_argument("--purpose", choices=["comparison", "calibration"], default="comparison")
    parser.add_argument("--max-total-tokens", type=int, default=2000000)
    parser.add_argument("--max-output-tokens", type=int, default=60000)
    parser.add_argument("--wall-seconds", type=int, default=1080)
    parser.add_argument("--oauth", action="store_true", help="Use the historical OAuth repair workload")
    parser.add_argument("--model", default="glm-5.3-flash", help="Configured kimchi-dev model for every parent and worker")
    args = parser.parse_args()
    if len(args.arms) < 2 or min(args.max_total_tokens, args.max_output_tokens, args.wall_seconds) <= 0:
        parser.error("Use at least two isolated homes and positive limits")
    os.umask(0o077)
    scripts = Path(__file__).resolve().parent
    repo = scripts.parents[1]
    root = Path(tempfile.mkdtemp(prefix="kimchi-compaction-arms-", dir="/private/tmp"))
    print(root, flush=True)
    seed = root / "seed"
    seed.mkdir()
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git", "archive", "HEAD" if args.oauth else "76337bd7f794331b6310c7e7f78272b4dd400f5d"], cwd=repo, stdout=archive, check=True)
        archive.seek(0)
        subprocess.run(["tar", "-x", "-C", str(seed)], stdin=archive, check=True)
    shutil.copytree(repo / "dist", root / "runtime", symlinks=True)
    # Private copy: models may inspect dependencies but the sandbox cannot modify them.
    (root / "toolchain").mkdir()
    subprocess.run(["cp", "-cR", str(repo / "node_modules"), str(root / "toolchain/node_modules")], check=True)
    pnpm_root = Path(shutil.which("pnpm")).resolve().parent.parent
    subprocess.run(["cp", "-cR", str(pnpm_root), str(root / "pnpm")], check=True)
    (seed / "node_modules").mkdir()
    for dependency in (root / "toolchain/node_modules").iterdir():
        if dependency.name not in {".vite", ".vite-temp", ".cache"}:
            (seed / "node_modules" / dependency.name).symlink_to(dependency, target_is_directory=dependency.is_dir())
    shutil.copy2(scripts / "compaction-task.md", seed / "TASK.md")
    package = json.loads((seed / "package.json").read_text())
    package["scripts"]["test:compaction-local"] = 'mkdir -p .test-home && env -u KIMCHI_PERMISSIONS -u KIMCHI_NO_UPDATE_CHECK HOME="$PWD/.test-home" PI_CODING_AGENT_DIR="$PWD/.test-home/.config/kimchi/harness" KIMCHI_CODING_AGENT_DIR="$PWD/.test-home/.config/kimchi/harness" vitest run src/extensions/model-guard.test.ts src/upstream-inline-compact-patch.test.ts src/tool-call-in-flight.test.ts src/extensions/compaction-evaluation.test.ts'
    package["scripts"]["check:compaction-style"] = "biome check src/extensions/model-guard* src/extensions/compaction* src/tool-call-in-flight* src/upstream-inline-compact-patch*"
    (seed / "package.json").write_text(json.dumps(package, indent="\t") + "\n")
    if args.oauth:
        import importlib.util
        spec = importlib.util.spec_from_file_location("oauth", scripts / "oauth-comparison.py")
        oauth = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(oauth)
        oauth.seed(repo, seed)
    config_source = json.loads((Path.home() / ".config/kimchi/config.json").read_text())
    provider = json.loads((Path.home() / ".config/kimchi/harness/models.json").read_text())["providers"]["kimchi-dev"]
    provider = {**provider, "models": [model for model in provider["models"] if model["id"] == args.model]}
    assert len(provider["models"]) == 1
    trials = []
    repetitions = {}
    for index, arm in enumerate(args.arms, 1):
        repetitions[arm] = repetitions.get(arm, 0) + 1
        label = f"trial-{index:02d}"
        trial = root / label
        home = trial / "home"
        agent = home / ".config/kimchi/harness"
        for path in [agent / "extensions", trial / "tmp", trial / "sockets", trial / "bin", trial / "probe"]:
            path.mkdir(parents=True)
        for path, data in {
            home / ".config/kimchi/config.json": {
                **{key: config_source[key] for key in ["apiKey", "llmEndpoint"] if key in config_source},
                "migrationState": "done", "skillPaths": [],
                "onboarding": {"hideSessionModeDialog": True, "sessionModeWizardSeenAt": True},
                "surveys": config_source.get("surveys", {}), "telemetry": {"enabled": False},
            },
            agent / "models.json": {"providers": {"kimchi-dev": provider}},
            agent / "settings.json": {"resources": {"extensions.ferment-v2": False, "extensions.agent-communication": True}, "hideThinkingBlock": True, "compaction": {"enabled": False}},
            agent / "permissions.json": {"defaultMode": "auto"},
        }.items():
            path.write_text(json.dumps(data, indent=2) + "\n")
            path.chmod(0o600)
        extension = (scripts / "experiment.ts").read_text()
        extension += f'\nexport default function (pi: ExtensionAPI) {{ installExperiment(pi, {json.dumps(arm)}, {json.dumps(str(trial / "audit.jsonl"))}, {json.dumps(args.model)}); }}\n'
        (agent / "extensions/experiment.ts").write_text(extension)
        pnpm = trial / "bin/pnpm"
        pnpm.write_text(f'#!/bin/sh\nexec /opt/homebrew/bin/node "{root}/pnpm/bin/pnpm.cjs" "$@"\n')
        pnpm.chmod(0o700)
        profile = trial / "sandbox.sb"
        profile.write_text(f'''(version 1)
(allow default)
(deny file-write*)
(deny file-read* (subpath "/Users") (subpath "/private/tmp") (subpath "/tmp") (subpath "/private/var/folders") (subpath "/var/folders"))
(allow file-read* (subpath "{root}/runtime") (subpath "{root}/pnpm") (subpath "{root}/toolchain") (subpath "{trial}"))
(allow file-read-metadata)
(allow file-write* (subpath "{trial}") (subpath "/dev"))
(deny file-read* (subpath "/opt/homebrew/lib/node_modules/npm"))
(deny network-outbound)
(allow network-outbound (remote tcp "*:443"))
(allow network-outbound (remote tcp "localhost:*"))
(allow network-outbound (remote unix-socket (subpath "{trial}")))
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
''')
        wrapper = trial / "kimchi"
        wrapper.write_text(f'#!/bin/sh\nexec /usr/bin/sandbox-exec -f "{profile}" "{root}/runtime/bin/kimchi" "$@"\n')
        wrapper.chmod(0o700)
        environment = {
            "PATH": f"{trial}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(home), "SHELL": "/bin/bash", "TMPDIR": str(trial / "tmp"),
            "TMUX_TMPDIR": str(trial / "sockets"), "TERM": "xterm-256color", "LANG": "en_US.UTF-8",
            "KIMCHI_BINARY": str(wrapper), "KIMCHI_EXTRA_ARGS": "--thinking low",
            "KIMCHI_PERMISSIONS": "auto", "KIMCHI_NO_UPDATE_CHECK": "1", "KIMCHI_TELEMETRY_ENABLED": "false",
        }
        (trial / "env.json").write_text(json.dumps(environment, indent=2) + "\n")
        shutil.copytree(seed, trial / "probe", dirs_exist_ok=True, symlinks=True)
        trials.append({"label": label, "arm": arm, "repetition": repetitions[arm], "directory": str(trial)})
    manifest = {
        "runner_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
        "target_ref": "dcc26382^" if args.oauth else "76337bd7f794331b6310c7e7f78272b4dd400f5d",
        "reference_ref": "dcc26382" if args.oauth else "716bd797c9802b20ef1da4ccde7caace26173a22",
        "workload": "oauth" if args.oauth else "compaction",
        "binary_sha256": hashlib.sha256((root / "runtime/bin/kimchi").read_bytes()).hexdigest(),
        "model": f"kimchi-dev/{args.model}", "thinking": "low", "worker_ferment": False,
        "purpose": args.purpose,
        "max_output_tokens": args.max_output_tokens, "max_total_tokens": args.max_total_tokens,
        "wall_seconds": args.wall_seconds,
        "budget_note": "Monitor counts all captured parent and worker usage, including cache reads, after responses complete. Concurrent or in-flight responses can exceed the cap; report the observed excess.",
        "trials": trials,
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{len(trials)} isolated homes prepared; inference has not started.")


if __name__ == "__main__":
    main()
