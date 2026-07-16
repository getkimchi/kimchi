#!/usr/bin/env python3
"""Retry failed pipelines for daily scheduled TB2.1 benchmark runs."""

from __future__ import annotations

import json
import os
import sys
from typing import Any
from urllib import error, request
from urllib.parse import quote

TAG = "daily-tb2"


def _api(base: str, token: str, project: str, method: str, path: str, data: dict | None = None) -> Any:
    """Make an authenticated GitLab API request and return the parsed JSON body."""
    url = f"{base}/projects/{project}/{path}"
    headers = {"PRIVATE-TOKEN": token, "Accept": "application/json"}
    body = json.dumps(data).encode() if data else None
    if body:
        headers["Content-Type"] = "application/json"
    req = request.Request(url, data=body, headers=headers, method=method)
    try:
        with request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise RuntimeError(f"{method} {url} → {e.code}: {detail}") from e


def _is_daily_tb2(schedule: dict) -> bool:
    """True if schedule is an active daily TB2 run with tasks_all enabled."""
    if not schedule.get("active"):
        return False
    inputs = {i["name"]: i.get("value") for i in schedule.get("inputs", []) if "name" in i}
    if inputs:
        return inputs.get("benchmark_tag") == TAG and inputs.get("tasks_all") is True
    # inputs not visible with Developer role — fall back to description prefix.
    return schedule.get("description", "").startswith("Daily TB2 - ")


def main() -> int:
    project = os.environ.get("CI_PROJECT_ID") or os.environ.get("CI_PROJECT_PATH")
    token = os.environ.get("GITLAB_TOKEN")
    if not project:
        raise SystemExit("CI_PROJECT_ID or CI_PROJECT_PATH must be set.")
    if not token:
        raise SystemExit("GITLAB_TOKEN must be set to a project access token with api scope.")

    base = os.environ.get("CI_API_V4_URL") or f"{os.environ.get('CI_SERVER_URL', 'https://gitlab.com').rstrip('/')}/api/v4"
    project = quote(project, safe="") if "/" in project else project

    # Retry behaviour overrides
    dry_run = os.environ.get("TB21_RETRY_DRY_RUN", "false").strip().lower() in {"1", "true", "yes"}
    max_per_run = int(os.environ.get("TB21_RETRY_MAX_PER_RUN", "3"))
    retry_statuses = frozenset(
        s.strip() for s in os.environ.get("TB21_RETRY_STATUS_FILTER", "failed").split(",")
    )

    all_schedules = _api(base, token, project, "GET", "pipeline_schedules?per_page=100&scope=active")
    schedules = [s for s in all_schedules if _is_daily_tb2(s)]
    report: list[dict[str, Any]] = []
    retried = 0

    for schedule in sorted(schedules, key=lambda s: s.get("id", 0)):
        sid = schedule.get("id")
        pipelines = _api(
            base, token, project, "GET",
            f"pipeline_schedules/{sid}/pipelines?per_page=1&order_by=id&sort=desc",
        )
        if not pipelines:
            report.append({
                "schedule_id": sid,
                "description": schedule.get("description", ""),
                "action": "no_pipelines",
            })
            continue

        pipeline = pipelines[0]
        status = pipeline.get("status", "unknown")
        reason = f"status={status}"

        if status not in retry_statuses:
            action = "no_action"
        elif retried >= max_per_run:
            action = "skipped_max_per_run"
        elif dry_run:
            action = "would_retry"
        else:
            _api(base, token, project, "POST", f"pipelines/{pipeline['id']}/retry")
            retried += 1
            action = "retried"

        report.append({
            "schedule_id": sid, "description": schedule.get("description", ""), "pipeline_id": pipeline.get("id"),
            "status": status, "web_url": pipeline.get("web_url"), "action": action, "reason": reason,
        })

    with open("tb21-retry-report.json", "w") as f:
        json.dump(report, f, indent=2)

    print(f"Inspected {len(report)} daily TB2 schedule(s)")
    for e in report:
        pid = e.get("pipeline_id")
        link = e.get("web_url", "")
        if pid:
            print(f"  schedule={e['schedule_id']} pipeline={pid} status={e['status']} action={e['action']} {link}")
        else:
            print(f"  schedule={e['schedule_id']} action={e['action']} ({e.get('description', '')})")
    skipped = sum(1 for r in report if r["action"] == "no_action")
    would_retry = sum(1 for r in report if r["action"] == "would_retry")
    over_limit = sum(1 for r in report if r["action"] == "skipped_max_per_run")
    print(f"Retried {retried} failed pipeline(s)")
    print(f"Skipped: {skipped} not eligible, {would_retry} would retry (dry-run), {over_limit} over max per run")
    return 0


if __name__ == "__main__":
    sys.exit(main())
