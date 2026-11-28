"""Configuration and Inspect command construction for guardrails benchmarks."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

INSPECT_VERSION = "0.3.277"
INSPECT_EVALS_REVISION = "eb5383efecd8ac6d23fd276757b811f3db05a1f5"
INSPECT_EVALS_VERSION = "0.24.1.dev17+geb5383efe"
AGENTHARM_DATASET_REVISION = "e23b3fe60a0da9037314b88e5ee3a0c054970dad"
GATEWAY_BASE_URL = "https://llm.kimchi.dev/openai/v1"
MODEL_MAP_PATH = Path(__file__).with_name("models.json")
ROUTES = ("baseline", "guarded")


def _model_map(path: Path = MODEL_MAP_PATH) -> dict[str, str]:
    raw: Any = json.loads(path.read_text(encoding="utf-8"))
    models = raw.get("models") if isinstance(raw, dict) else None
    if not isinstance(models, dict) or not models:
        raise ValueError(f"model map {path} must contain a non-empty 'models' object")
    if not all(isinstance(label, str) and label and isinstance(model_id, str) and model_id for label, model_id in models.items()):
        raise ValueError(f"model map {path} entries must be non-empty label/model-id strings")
    return dict(models)


def select_models(selection: str, *, path: Path = MODEL_MAP_PATH) -> list[str]:
    """Resolve a dispatch choice to model labels without changing their order."""
    models = _model_map(path)
    if selection == "both":
        return list(models)
    if selection not in models:
        choices = ", ".join([*models, "both"])
        raise ValueError(f"unknown model selection {selection!r}; choose one of: {choices}")
    return [selection]


def model_id(label: str, *, path: Path = MODEL_MAP_PATH) -> str:
    return _model_map(path)[label]


def build_matrix(selection: str) -> list[dict[str, str]]:
    """Build independent baseline/guarded entries for every selected model."""
    return [
        {"label": label, "model_id": model_id(label), "route": route}
        for label in select_models(selection)
        for route in ROUTES
    ]


def provider_config(route: str, model: str) -> dict[str, str]:
    """Separate target and grader providers. Graders are always unguarded."""
    if route not in ROUTES:
        raise ValueError(f"unknown provider route {route!r}")
    route_upper = route.upper()
    return {
        "route": route,
        "target_model": f"openai-api/{route}/{model}",
        "target_api_key_env": f"{route_upper}_API_KEY",
        "target_base_url_env": f"{route_upper}_BASE_URL",
        "target_base_url": GATEWAY_BASE_URL,
        "refusal_judge": "openai-api/baseline/glm-5.3-flash",
        "semantic_judge": "openai-api/baseline/kimi-k3",
        "judge_api_key_env": "BASELINE_API_KEY",
        "judge_base_url_env": "BASELINE_BASE_URL",
        "judge_base_url": GATEWAY_BASE_URL,
    }


def build_inspect_command(
    *,
    suite: str,
    task_file: str,
    provider: dict[str, str],
    log_dir: str,
) -> list[str]:
    """Build reproducible Inspect arguments; credentials stay in the environment."""
    if suite not in {"agent_threat_bench", "agentharm"}:
        raise ValueError(f"unknown benchmark suite {suite!r}")
    command = [
        "inspect",
        "eval-set" if suite == "agent_threat_bench" else "eval",
        task_file,
        "--model",
        provider["target_model"],
        "--epochs",
        "1",
        "--max-connections",
        "8",
        "--message-limit",
        "20",
        "--sandbox",
        "local",
        "--display",
        "plain",
        "--log-dir",
        log_dir,
    ]
    if suite == "agentharm":
        command.extend(
            [
                "-T",
                "split=test_public",
                "-T",
                f"semantic_judge={provider['semantic_judge']}",
                "-T",
                f"refusal_judge={provider['refusal_judge']}",
            ]
        )
    return command


REPO_ROOT = Path(__file__).resolve().parents[2]


def validate_provider_environment(provider: dict[str, str], env: dict[str, str]) -> None:
    """Check key presence without logging or returning any key material."""
    missing = [
        name
        for name in {provider["target_api_key_env"], provider["judge_api_key_env"]}
        if not env.get(name, "").strip()
    ]
    if missing:
        raise ValueError(f"missing required API key environment variable(s): {', '.join(sorted(missing))}")


def _harness_version(binary: Path) -> str:
    completed = subprocess.run(
        [str(binary), "--version"],
        check=True,
        capture_output=True,
        text=True,
    )
    lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if not lines:
        raise ValueError("the built Kimchi binary printed no version")
    # Version output is metadata, but cap and strip it before it reaches reports.
    return re.sub(r"[\x00-\x1f\x7f`]", "", lines[-1])[:120]


def _failed_suite(suite: str) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": "failed",
        "expected_samples": 24 if suite == "agent_threat_bench" else 176,
        "total_samples": 0,
        "completed_samples": 0,
        "error_count": 0,
        "metrics": {},
    }
    if suite == "agent_threat_bench":
        result["tasks"] = [
            {
                "name": name,
                "status": "missing",
                "expected_samples": expected,
                "total_samples": 0,
                "completed_samples": 0,
                "error_count": 0,
                "metrics": {},
            }
            for name, expected in (("memory_poison", 10), ("autonomy_hijack", 6), ("data_exfil", 8))
        ]
    else:
        result["categories"] = []
    return result


def _run_suite(
    *,
    suite: str,
    label: str,
    provider: dict[str, str],
    binary: Path,
    log_root: Path,
    env: dict[str, str],
) -> dict[str, Any]:
    from collect import collect_agentharm, collect_atb

    log_dir = log_root / f"{label}-{provider['route']}" / suite
    log_dir.mkdir(parents=True, exist_ok=True)
    task_file = REPO_ROOT / "tools" / "guardrails-benchmark" / ("atb_tasks.py" if suite == "agent_threat_bench" else "agentharm_task.py")
    command = build_inspect_command(
        suite=suite,
        task_file=str(task_file.relative_to(REPO_ROOT)),
        provider=provider,
        log_dir=str(log_dir),
    )
    # Raw console output stays in the runner's private temporary area. It is
    # neither printed nor uploaded, since provider errors can contain prompts.
    with (log_dir / "inspect.stdout.log").open("w", encoding="utf-8") as stdout, (
        log_dir / "inspect.stderr.log"
    ).open("w", encoding="utf-8") as stderr:
        try:
            process = subprocess.run(
                command,
                cwd=REPO_ROOT,
                env={**env, "KIMCHI_BENCH_BINARY": str(binary)},
                stdout=stdout,
                stderr=stderr,
                check=False,
            )
            exit_code = process.returncode
        except OSError:
            exit_code = 127

    try:
        result = collect_atb(log_dir) if suite == "agent_threat_bench" else collect_agentharm(log_dir)
    except Exception:
        # Diagnostics remain only in private logs; the artifact records a
        # sanitized failure and coverage counts instead of exception text.
        result = _failed_suite(suite)
    if exit_code != 0:
        result["status"] = "failed"
        result["process_exit_code"] = exit_code
    print(f"{label}/{provider['route']}/{suite}: {_display_status(result)}", flush=True)
    return result


def _display_status(result: dict[str, Any]) -> str:
    status = str(result.get("status", "missing"))
    samples = f"{result.get('completed_samples', 0)}/{result.get('expected_samples', 0)} samples"
    exit_code = result.get("process_exit_code")
    return f"{status}, {samples}" + (f", Inspect exit code {exit_code}" if exit_code is not None else "")


def run_benchmarks(*, label: str, route: str, commit_sha: str, binary: Path, output: Path, log_root: Path) -> None:
    """Run both suites independently and sanitize their results into one JSON file."""
    selected_model = model_id(label)
    provider = provider_config(route, selected_model)
    env = os.environ.copy()
    validate_provider_environment(provider, env)
    env.setdefault(provider["target_base_url_env"], provider["target_base_url"])
    env.setdefault(provider["judge_base_url_env"], provider["judge_base_url"])
    binary = binary.resolve()
    version = _harness_version(binary)

    context = {
        "commit_sha": commit_sha,
        "harness_version": version,
        "inspect_ai": INSPECT_VERSION,
        "inspect_evals": INSPECT_EVALS_VERSION,
        "inspect_evals_revision": INSPECT_EVALS_REVISION,
        "agentharm_dataset_revision": AGENTHARM_DATASET_REVISION,
    }
    result = {
        "schema_version": 1,
        "route": route,
        "label": label,
        "model_id": selected_model,
        "context": context,
        "run_config": {
            "epochs": 1,
            "max_connections": 8,
            "message_limit": 20,
            "harness_invocation": "dist/bin/kimchi --print via Inspect sandbox_agent_bridge",
            "split": "test_public",
            "refusal_judge": "glm-5.3-flash",
            "semantic_judge": "kimi-k3",
            "grader_route": "baseline",
        },
        "suites": {},
    }
    for suite in ("agent_threat_bench", "agentharm"):
        result["suites"][suite] = _run_suite(
            suite=suite,
            label=label,
            provider=provider,
            binary=binary,
            log_root=log_root,
            env=env,
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def _load_sanitized_results(results_dir: Path) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for path in sorted(results_dir.rglob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(record, dict) or record.get("schema_version") != 1:
            continue
        if record.get("route") not in ROUTES or not isinstance(record.get("label"), str):
            continue
        results.append(record)
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    matrix_parser = subparsers.add_parser("matrix", help="print the dispatch matrix as JSON")
    matrix_parser.add_argument("--selection", required=True)

    run_parser = subparsers.add_parser("run", help="run both suites for one model/route")
    run_parser.add_argument("--label", required=True)
    run_parser.add_argument("--route", choices=ROUTES, required=True)
    run_parser.add_argument("--commit-sha", required=True)
    run_parser.add_argument("--binary", type=Path, required=True)
    run_parser.add_argument("--output", type=Path, required=True)
    run_parser.add_argument("--log-root", type=Path, required=True)

    report_parser = subparsers.add_parser("report", help="write both Markdown reports from sanitized JSON")
    report_parser.add_argument("--selection", required=True)
    report_parser.add_argument("--results-dir", type=Path, required=True)
    report_parser.add_argument("--out-dir", type=Path, required=True)
    report_parser.add_argument("--step-summary", type=Path)
    args = parser.parse_args(argv)

    if args.command == "matrix":
        print(json.dumps(build_matrix(args.selection), separators=(",", ":")))
        return 0
    if args.command == "run":
        run_benchmarks(
            label=args.label,
            route=args.route,
            commit_sha=args.commit_sha,
            binary=args.binary,
            output=args.output,
            log_root=args.log_root,
        )
        return 0

    from report import generate_reports

    records = _load_sanitized_results(args.results_dir)
    failures = generate_reports(
        records,
        selection=args.selection,
        out_dir=args.out_dir,
        step_summary_path=args.step_summary,
    )
    if failures:
        for failure in failures:
            print(f"INCOMPLETE: {failure}", file=sys.stderr)
        return 1
    print("All selected benchmark runs completed with full sample coverage.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
