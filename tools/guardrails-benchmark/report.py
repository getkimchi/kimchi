"""Render sanitized guardrails benchmark reports and GitHub step summaries."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from benchmark import (
    AGENTHARM_DATASET_REVISION,
    INSPECT_EVALS_REVISION,
    INSPECT_EVALS_VERSION,
    INSPECT_VERSION,
    ROUTES,
    model_id,
    select_models,
)

SUITE_NAMES = {"agent_threat_bench": "AgentThreatBench", "agentharm": "AgentHarm"}
ATB_TASKS = (
    ("memory_poison", 10),
    ("autonomy_hijack", 6),
    ("data_exfil", 8),
)


def _score(value: Any) -> str:
    return f"{value:.3f}" if isinstance(value, int | float) else "—"


def _delta(baseline: Any, guarded: Any) -> str:
    if not isinstance(baseline, int | float) or not isinstance(guarded, int | float):
        return "—"
    return f"{guarded - baseline:+.3f}".replace("-", "−")


def _suite_status(suite: dict[str, Any]) -> str:
    return str(suite.get("status", "missing")).upper()


def _samples(suite: dict[str, Any]) -> str:
    return f"{suite.get('completed_samples', 0)}/{suite.get('expected_samples', 0)}"


def _empty_suite(suite_name: str) -> dict[str, Any]:
    suite: dict[str, Any] = {
        "status": "missing",
        "expected_samples": 24 if suite_name == "agent_threat_bench" else 176,
        "total_samples": 0,
        "completed_samples": 0,
        "error_count": 0,
        "metrics": {},
    }
    if suite_name == "agent_threat_bench":
        suite["tasks"] = [
            {
                "name": name,
                "status": "missing",
                "expected_samples": expected,
                "total_samples": 0,
                "completed_samples": 0,
                "error_count": 0,
                "metrics": {},
            }
            for name, expected in ATB_TASKS
        ]
    else:
        suite["categories"] = []
    return suite


def _default_context() -> dict[str, str]:
    return {
        "commit_sha": "unknown",
        "harness_version": "unknown",
        "inspect_ai": INSPECT_VERSION,
        "inspect_evals": INSPECT_EVALS_VERSION,
        "inspect_evals_revision": INSPECT_EVALS_REVISION,
        "agentharm_dataset_revision": AGENTHARM_DATASET_REVISION,
    }


def _missing_run(label: str, route: str, context: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "route": route,
        "label": label,
        "model_id": model_id(label),
        "context": context,
        "run_config": {},
        "suites": {name: _empty_suite(name) for name in SUITE_NAMES},
    }


def _normalized_runs(records: list[dict[str, Any]], selection: str) -> dict[tuple[str, str], dict[str, Any]]:
    labels = select_models(selection)
    by_key = {(record["route"], record["label"]): record for record in records}
    context = next((record.get("context") for record in records if record.get("context")), _default_context())
    return {
        (route, label): by_key.get((route, label), _missing_run(label, route, context))
        for label in labels
        for route in ROUTES
    }


def _metadata_lines(context: dict[str, Any]) -> list[str]:
    return [
        f"- Commit: `{context['commit_sha']}`",
        f"- Built harness: `dist/bin/kimchi`, version `{context['harness_version']}`",
        f"- Inspect AI: `{context['inspect_ai']}`",
        f"- Inspect Evals: `{context['inspect_evals']}` (`{context['inspect_evals_revision']}`)",
        f"- AgentHarm dataset revision: `{context['agentharm_dataset_revision']}`",
    ]


def _render_atb(suite: dict[str, Any]) -> list[str]:
    lines = [
        "### AgentThreatBench",
        "",
        f"Status: **{_suite_status(suite)}** · Samples: {_samples(suite)} · Errors: {suite.get('error_count', 0)}",
        "",
        "| Task | Status | Samples | Errors | Utility | Security |",
        "|---|---|---:|---:|---:|---:|",
    ]
    tasks = {task["name"]: task for task in suite.get("tasks", [])}
    for name, expected in ATB_TASKS:
        task = tasks.get(name, _empty_suite("agent_threat_bench")["tasks"][0] | {"name": name, "expected_samples": expected})
        metrics = task.get("metrics", {})
        lines.append(
            f"| `{name}` | {_suite_status(task)} | {_samples(task)} | {task.get('error_count', 0)} "
            f"| {_score(metrics.get('utility'))} | {_score(metrics.get('security'))} |"
        )
    return lines


def _render_agentharm(suite: dict[str, Any]) -> list[str]:
    metrics = suite.get("metrics", {})
    lines = [
        "### AgentHarm — harmful `test_public`",
        "",
        f"Status: **{_suite_status(suite)}** · Samples: {_samples(suite)} · Errors: {suite.get('error_count', 0)}",
        "",
        "| Average harm score | Average full score | Average refusals | Average non-refusal harm |",
        "|---:|---:|---:|---:|",
        f"| {_score(metrics.get('avg_score'))} | {_score(metrics.get('avg_full_score'))} "
        f"| {_score(metrics.get('avg_refusals'))} | {_score(metrics.get('avg_score_non_refusals'))} |",
        "",
        "| Category | Samples | Average harm score | Average refusals |",
        "|---|---:|---:|---:|",
    ]
    categories = suite.get("categories", [])
    if categories:
        for category in categories:
            lines.append(
                f"| {category['name']} | {category['sample_count']} "
                f"| {_score(category.get('avg_score'))} | {_score(category.get('avg_refusals'))} |"
            )
    else:
        lines.append("| — | 0 | — | — |")
    return lines


def render_configuration_report(
    route: str,
    records: list[dict[str, Any]],
    *,
    selection: str,
) -> str:
    runs = _normalized_runs(records, selection)
    context = runs[(route, select_models(selection)[0])]["context"]
    config = next((run.get("run_config") for run in runs.values() if run.get("run_config")), {})
    lines = [
        f"# Guardrails benchmark — {route}",
        "",
        f"Guardrails **{'disabled' if route == 'baseline' else 'enabled'}**. "
        "Only aggregate metrics and run metadata are included; raw prompts, completions, transcripts and API responses are excluded.",
        "",
        "## Run metadata",
        "",
        *_metadata_lines(context),
        "",
        "## Run configuration",
        "",
        f"- Harness invocation: `{config.get('harness_invocation', 'not recorded (missing run)')}`",
        f"- Epochs: {config.get('epochs', 1)}; max connections: {config.get('max_connections', 8)}; message limit: {config.get('message_limit', 20)}",
        f"- AgentHarm split: `{config.get('split', 'test_public')}`",
        f"- Refusal judge: `{config.get('refusal_judge', 'glm-5.3-flash')}`; semantic judge: `{config.get('semantic_judge', 'kimi-k3')}`; grader route: `baseline`",
        "",
    ]
    for label in select_models(selection):
        run = runs[(route, label)]
        lines.extend([f"## {label}", "", f"Model ID: `{run['model_id']}`", ""])
        lines.extend(_render_atb(run["suites"]["agent_threat_bench"]))
        lines.append("")
        lines.extend(_render_agentharm(run["suites"]["agentharm"]))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_step_summary(records: list[dict[str, Any]], *, selection: str) -> str:
    runs = _normalized_runs(records, selection)
    context = next((run.get("context") for run in runs.values() if run.get("context")), _default_context())
    lines = [
        "## Guardrails benchmark",
        "",
        f"Commit `{context['commit_sha']}` · built harness `{context['harness_version']}` · "
        f"Inspect AI `{context['inspect_ai']}` · Inspect Evals `{context['inspect_evals_revision']}`",
        "",
        "### Status",
        "",
        "| Model | Suite | Baseline | Guarded |",
        "|---|---|---|---|",
    ]
    for label in select_models(selection):
        for suite_name, display_name in SUITE_NAMES.items():
            baseline = runs[("baseline", label)]["suites"][suite_name]
            guarded = runs[("guarded", label)]["suites"][suite_name]
            lines.append(
                f"| `{label}` | {display_name} | {_suite_status(baseline)} · {_samples(baseline)} "
                f"| {_suite_status(guarded)} · {_samples(guarded)} |"
            )
    lines.extend(
        [
            "",
            "### Comparison",
            "",
            "Scores are shown to three decimals. For AgentHarm harm, lower is better; for utility, security, full score and refusals, the raw values are compared without assigning a verdict.",
            "",
            "| Model | Suite / task | Metric | Baseline | Guarded | Δ guarded − baseline |",
            "|---|---|---|---:|---:|---:|",
        ]
    )
    for label in select_models(selection):
        for task_name, _ in ATB_TASKS:
            baseline_tasks = {task["name"]: task for task in runs[("baseline", label)]["suites"]["agent_threat_bench"].get("tasks", [])}
            guarded_tasks = {task["name"]: task for task in runs[("guarded", label)]["suites"]["agent_threat_bench"].get("tasks", [])}
            baseline_metrics = baseline_tasks.get(task_name, {}).get("metrics", {})
            guarded_metrics = guarded_tasks.get(task_name, {}).get("metrics", {})
            for metric in ("utility", "security"):
                lines.append(
                    f"| `{label}` | ATB `{task_name}` | {metric} | {_score(baseline_metrics.get(metric))} "
                    f"| {_score(guarded_metrics.get(metric))} | {_delta(baseline_metrics.get(metric), guarded_metrics.get(metric))} |"
                )
        baseline_metrics = runs[("baseline", label)]["suites"]["agentharm"].get("metrics", {})
        guarded_metrics = runs[("guarded", label)]["suites"]["agentharm"].get("metrics", {})
        for metric, display in (
            ("avg_score", "average harm"),
            ("avg_full_score", "average full score"),
            ("avg_refusals", "average refusals"),
        ):
            lines.append(
                f"| `{label}` | AgentHarm | {display} | {_score(baseline_metrics.get(metric))} "
                f"| {_score(guarded_metrics.get(metric))} | {_delta(baseline_metrics.get(metric), guarded_metrics.get(metric))} |"
            )
    return "\n".join(lines) + "\n"


def _suite_issues(route: str, label: str, suite_name: str, suite: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    prefix = f"{route}/{label}/{suite_name}"
    if suite.get("status") != "complete":
        issues.append(f"{prefix}: {_suite_status(suite)}")
    expected = int(suite.get("expected_samples", 0))
    if suite.get("completed_samples") != expected or suite.get("total_samples") != expected:
        issues.append(f"{prefix}: expected {expected} samples, got {_samples(suite)} completed")
    if suite.get("error_count"):
        issues.append(f"{prefix}: {suite['error_count']} sample error(s)")
    if suite_name == "agent_threat_bench":
        tasks = {task["name"]: task for task in suite.get("tasks", [])}
        for task_name, task_expected in ATB_TASKS:
            task = tasks.get(task_name)
            if task is None:
                issues.append(f"{prefix}/{task_name}: MISSING")
            elif task.get("status") != "complete" or task.get("completed_samples") != task_expected:
                issues.append(f"{prefix}/{task_name}: {_suite_status(task)}, {_samples(task)} completed")
    return issues


def generate_reports(
    records: list[dict[str, Any]],
    *,
    selection: str,
    out_dir: Path,
    step_summary_path: Path | None,
) -> list[str]:
    """Write both configuration reports and return every coverage failure."""
    runs = _normalized_runs(records, selection)
    normalized = list(runs.values())
    out_dir.mkdir(parents=True, exist_ok=True)
    for route in ROUTES:
        (out_dir / f"{route}.md").write_text(
            render_configuration_report(route, normalized, selection=selection),
            encoding="utf-8",
        )
    if step_summary_path is not None:
        step_summary_path.write_text(render_step_summary(normalized, selection=selection), encoding="utf-8")

    failures: list[str] = []
    for (route, label), run in runs.items():
        for suite_name, suite in run["suites"].items():
            failures.extend(_suite_issues(route, label, suite_name, suite))
    return failures
