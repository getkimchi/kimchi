#!/usr/bin/env python3
"""Upload generated benchmark summary JSON to the existing GCS run prefix."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any


def getenv(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def require_env(name: str) -> str:
    value = getenv(name)
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def metadata_dict(metadata: dict[str, Any], key: str) -> dict[str, Any]:
    value = metadata.get(key)
    return value if isinstance(value, dict) else {}


def metadata_string(metadata: dict[str, Any], key: str) -> str | None:
    value = metadata.get(key)
    if value is None:
        return None
    text = str(value)
    return text if text else None


def upload_required() -> bool:
    return getenv("GCS_UPLOAD_REQUIRED").lower() == "true"


def skip_upload(message: str) -> int:
    print(message)
    return 1 if upload_required() else 0


def main() -> int:
    metadata_path = Path(getenv("BENCHMARK_RUN_METADATA", ".benchmark/run-metadata.json"))
    summary_path = Path(getenv("BENCHMARK_SUMMARY_PATH", ".benchmark/summary.json"))

    run_metadata = load_json(metadata_path)
    if run_metadata is None:
        return skip_upload(f"No benchmark run metadata found at {metadata_path}; skipping summary upload.")
    if not summary_path.is_file():
        return skip_upload(f"No benchmark summary found at {summary_path}; skipping summary upload.")

    gcs_prefix = metadata_string(metadata_dict(run_metadata, "gcs"), "prefix")
    if not gcs_prefix:
        return skip_upload("No GCS prefix found in benchmark run metadata; skipping summary upload.")

    bucket = require_env("BENCHMARK_GCS_BUCKET")

    destination = f"gs://{bucket}/{gcs_prefix}/summary.json"
    print(f"Uploading benchmark summary to {destination}")
    run(["gcloud", "storage", "cp", str(summary_path), destination, "--quiet"])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
