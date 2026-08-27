#!/usr/bin/env python3
"""Aggregate terminal-bench job results into a frozen baseline artifact.

Reads chunk job directories (chunk-N-*/<task>__<trial>/) produced by harbor runs
and emits a single JSON document with per-task metrics suitable for A/B
comparison against future runs:

- verifier reward/outcome
- tokens: input/output/cache (from harbor agent_result)
- cache economics: latest cumulative cache_summary journal entry (kimi
  instrumentation, token-optimization Phase 0)
- context surface: latest context_assembly composition entry (system prompt
  estimated tokens, per-component breakdown) and prefix-change count
- timings: agent execution wall time

Usage:
    python3 scripts/aggregate-baseline.py jobs/ > baselines/baseline-<name>.json

The output is intentionally plain JSON with a stable shape; per-run metadata
(models, agent version, dataset ref) is included so baselines stay comparable
across harness changes.
"""

import importlib.util
import json
import sys
from pathlib import Path

BENCH_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = BENCH_ROOT.parent.parent

# Reuse the manual benchmark's journal-entry parsing so the two baselines read
# the same fields with the same logic.
spec = importlib.util.spec_from_file_location(
    "analyze_session", REPO_ROOT / "benchmark" / "manual" / "analyze-session.py"
)
_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_module)
latest_context_assembly = _module.latest_context_assembly
latest_cache_summary = _module.latest_cache_summary


def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def read_session_events(trial_dir: Path):
    """Custom journal events (context_assembly / cache_summary / trace_ids)."""
    events = []
    for jsonl in trial_dir.glob("agent/sessions/*.jsonl"):
        try:
            for raw in jsonl.read_text().splitlines():
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "custom" and event.get("customType") in (
                    "context_assembly",
                    "cache_summary",
                    "trace_ids",
                ):
                    events.append(event)
        except OSError:
            continue
    return events


def extract_trial(task_name: str, trial_dir: Path) -> dict | None:
    result = load_json(trial_dir / "result.json")
    if not result:
        return None

    agent_result = result.get("agent_result") or {}
    verifier_result = result.get("verifier_result") or {}
    agent_execution = result.get("agent_execution") or {}

    events = read_session_events(trial_dir)
    cache = latest_cache_summary(events)
    context = latest_context_assembly(events)

    duration_s = None
    started = agent_execution.get("started_at")
    finished = agent_execution.get("finished_at")
    if started and finished:
        from datetime import datetime

        t1 = datetime.fromisoformat(started.replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(finished.replace("Z", "+00:00"))
        duration_s = round((t2 - t1).total_seconds(), 1)

    return {
        "trial": result.get("trial_name"),
        "reward": (verifier_result.get("rewards") or {}).get("reward"),
        "outcome": result.get("outcome"),
        "n_input_tokens": agent_result.get("n_input_tokens"),
        "n_output_tokens": agent_result.get("n_output_tokens"),
        "n_cache_tokens": agent_result.get("n_cache_tokens"),
        "cost_usd": agent_result.get("cost_usd"),
        "duration_s": duration_s,
        # Instrumentation (token-optimization Phase 0). None when the trial's
        # session predates the instrumentation commits.
        "cache_cumulative": None
        if cache is None
        else {
            "input_tokens": cache.get("inputTokens"),
            "output_tokens": cache.get("outputTokens"),
            "cache_read_tokens": cache.get("cacheReadTokens"),
            "cache_write_tokens": cache.get("cacheWriteTokens"),
            "cost_dollars": cache.get("costDollars"),
        },
        "context": context,
    }


def aggregate(jobs_dir: Path) -> dict:
    tasks: dict[str, dict] = {}
    meta: dict = {
        "job_dirs": [],
        "models": set(),
        "agent_versions": set(),
        "dataset_refs": set(),
        "skips": [],
    }

    for job_dir in sorted(jobs_dir.iterdir()):
        if not job_dir.is_dir() or job_dir.name == "chunk-meta":
            continue
        job_config = load_json(job_dir / "config.json") or {}
        meta["job_dirs"].append(job_dir.name)
        for agent in job_config.get("agents", []):
            if agent.get("model_name"):
                meta["models"].add(agent["model_name"])
        for dataset in job_config.get("datasets", []):
            if dataset.get("ref"):
                meta["dataset_refs"].add(dataset["ref"])

        for trial_dir in sorted(p for p in job_dir.iterdir() if p.is_dir() and "__" in p.name):
            result = load_json(trial_dir / "result.json")
            if not result:
                meta["skips"].append(f"{job_dir.name}/{trial_dir.name} (no result.json)")
                continue
            task_name = result.get("task_name") or trial_dir.name.split("__")[0]
            trial = extract_trial(task_name, trial_dir)
            if trial is None:
                meta["skips"].append(f"{job_dir.name}/{trial_dir.name} (unparseable)")
                continue

            # Multiple chunks might rerun a task; keep the first and record dupes.
            if task_name in tasks:
                meta["skips"].append(f"{job_dir.name}/{trial_dir.name} (duplicate task {task_name})")
                continue
            tasks[task_name] = trial
            agent_info = result.get("agent_info") or {}
            version = agent_info.get("version")
            if version:
                meta["agent_versions"].add(version)

    rewards = [t["reward"] for t in tasks.values() if t["reward"] is not None]
    summary = {
        "task_count": len(tasks),
        "reward_mean": round(sum(rewards) / len(rewards), 4) if rewards else None,
        "pass_count": sum(1 for t in tasks.values() if t["reward"] == 1.0),
        "fail_count": sum(1 for t in tasks.values() if t["reward"] == 0.0),
        "total_input_tokens": sum(t["n_input_tokens"] or 0 for t in tasks.values()),
        "total_output_tokens": sum(t["n_output_tokens"] or 0 for t in tasks.values()),
        "total_cache_tokens": sum(t["n_cache_tokens"] or 0 for t in tasks.values()),
        "with_cache_summary": sum(1 for t in tasks.values() if t["cache_cumulative"] is not None),
        "with_context_assembly": sum(1 for t in tasks.values() if t["context"] is not None),
    }

    return {
        "schema_version": 1,
        "meta": {
            **meta,
            "models": sorted(meta["models"]),
            "agent_versions": sorted(meta["agent_versions"]),
            "dataset_refs": sorted(meta["dataset_refs"]),
        },
        "summary": summary,
        "tasks": dict(sorted(tasks.items())),
    }


def main(argv: list[str]) -> int:
    jobs_dir = Path(argv[1] if len(argv) > 1 else BENCH_ROOT / "jobs").resolve()
    if not jobs_dir.is_dir():
        print(f"jobs dir not found: {jobs_dir}", file=sys.stderr)
        return 1
    doc = aggregate(jobs_dir)
    json.dump(doc, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
