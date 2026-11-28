"""Extract aggregate, non-sensitive results from Inspect logs."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

ATB_TASK_NAMES = {
    "inspect_evals/agent_threat_bench_memory_poison": "memory_poison",
    "inspect_evals/agent_threat_bench_autonomy_hijack": "autonomy_hijack",
    "inspect_evals/agent_threat_bench_data_exfil": "data_exfil",
}
ATB_EXPECTED = {"memory_poison": 10, "autonomy_hijack": 6, "data_exfil": 8}


def _metric_value(metric: Any) -> float | int | bool | None:
    value = getattr(metric, "value", None)
    return None if isinstance(value, float) and not math.isfinite(value) else value


def _metrics(log: Any) -> dict[str, float | int | bool | None]:
    metrics: dict[str, float | int | bool | None] = {}
    results = getattr(log, "results", None)
    for score in getattr(results, "scores", None) or []:
        for name, metric in (getattr(score, "metrics", None) or {}).items():
            metrics[name] = _metric_value(metric)
    return metrics


def _counts(log: Any, expected_samples: int) -> tuple[str, int, int, int]:
    results = getattr(log, "results", None)
    samples = getattr(log, "samples", None) or []
    total = getattr(results, "total_samples", None)
    completed = getattr(results, "completed_samples", None)
    if total is None:
        total = len(getattr(log.eval.dataset, "sample_ids", None) or samples)
    if completed is None:
        completed = sum(getattr(sample, "error", None) is None for sample in samples)
    error_count = sum(getattr(sample, "error", None) is not None for sample in samples)
    if log.status in {"error", "failed", "cancelled"}:
        status = "failed"
    elif log.status == "success" and total == expected_samples and completed == expected_samples and error_count == 0:
        status = "complete"
    else:
        status = "incomplete"
    return status, int(total), int(completed), int(error_count)


def collect_atb_log(log: Any, *, expected_samples: int) -> dict[str, Any]:
    """Return one task summary with utility and security in distinct fields."""
    name = ATB_TASK_NAMES.get(log.eval.task)
    if name is None:
        raise ValueError("unexpected AgentThreatBench task in log directory")
    status, total, completed, errors = _counts(log, expected_samples)
    metrics: dict[str, Any] = {}
    for score in log.results.scores if getattr(log, "results", None) else []:
        if score.name not in {"utility", "security"}:
            continue
        metrics[score.name] = _metric_value(score.metrics.get("accuracy"))
        metrics[f"{score.name}_stderr"] = _metric_value(score.metrics.get("stderr"))
    return {
        "name": name,
        "status": status,
        "expected_samples": expected_samples,
        "total_samples": total,
        "completed_samples": completed,
        "error_count": errors,
        "metrics": metrics,
    }


def collect_agentharm_log(log: Any, *, expected_samples: int = 176) -> dict[str, Any]:
    """Return aggregate and category metrics, never sample text or explanations."""
    status, total, completed, errors = _counts(log, expected_samples)
    metrics = _metrics(log)
    category_counts: dict[str, int] = {}
    for sample in getattr(log, "samples", None) or []:
        category = getattr(sample, "metadata", {}).get("category")
        if isinstance(category, str):
            category_counts[category] = category_counts.get(category, 0) + 1
    categories = [
        {
            "name": category,
            "sample_count": count,
            "avg_score": metrics.get(f"{category}_avg_scores"),
            "avg_refusals": metrics.get(f"{category}_avg_refusals"),
        }
        for category, count in sorted(category_counts.items())
    ]
    return {
        "status": status,
        "expected_samples": expected_samples,
        "total_samples": total,
        "completed_samples": completed,
        "error_count": errors,
        "metrics": {name: metrics.get(name) for name in ("avg_score", "avg_full_score", "avg_refusals", "avg_score_non_refusals")},
        "categories": categories,
    }


def _read_logs(log_dir: Path) -> list[Any]:
    from inspect_ai.log import read_eval_log

    # Full samples are needed only for counts and category names. No sample
    # content is copied to the returned objects or to artifacts.
    return [read_eval_log(str(path), header_only=False) for path in sorted(log_dir.glob("*.eval"))]


def collect_atb(log_dir: Path) -> dict[str, Any]:
    logs = _read_logs(log_dir)
    tasks = [collect_atb_log(log, expected_samples=ATB_EXPECTED[ATB_TASK_NAMES[log.eval.task]]) for log in logs]
    by_name = {task["name"]: task for task in tasks}
    for name, expected in ATB_EXPECTED.items():
        by_name.setdefault(
            name,
            {
                "name": name,
                "status": "missing",
                "expected_samples": expected,
                "total_samples": 0,
                "completed_samples": 0,
                "error_count": 0,
                "metrics": {},
            },
        )
    ordered = [by_name[name] for name in ("memory_poison", "autonomy_hijack", "data_exfil")]
    total = sum(task["total_samples"] for task in ordered)
    completed = sum(task["completed_samples"] for task in ordered)
    errors = sum(task["error_count"] for task in ordered)
    if all(task["status"] == "complete" for task in ordered) and total == completed == 24 and errors == 0:
        status = "complete"
    elif any(task["status"] in {"failed", "missing"} for task in ordered):
        status = "failed"
    else:
        status = "incomplete"
    weighted = {
        metric: sum(task["metrics"].get(metric, 0.0) * task["expected_samples"] for task in ordered) / 24
        for metric in ("utility", "security")
    }
    return {
        "status": status,
        "expected_samples": 24,
        "total_samples": total,
        "completed_samples": completed,
        "error_count": errors,
        "metrics": weighted,
        "tasks": ordered,
    }


def collect_agentharm(log_dir: Path) -> dict[str, Any]:
    logs = _read_logs(log_dir)
    if len(logs) != 1:
        return {
            "status": "missing" if not logs else "failed",
            "expected_samples": 176,
            "total_samples": 0,
            "completed_samples": 0,
            "error_count": 0,
            "metrics": {},
            "categories": [],
        }
    return collect_agentharm_log(logs[0])
