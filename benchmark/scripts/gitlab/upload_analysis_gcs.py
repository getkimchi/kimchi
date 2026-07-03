#!/usr/bin/env python3
"""Upload the benchmark session analysis HTML to the existing GCS run prefix."""

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


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        return None
    except json.JSONDecodeError:
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


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def main() -> int:
    metadata_path = Path(getenv("BENCHMARK_RUN_METADATA", ".benchmark/run-metadata.json"))
    analysis_path = Path(getenv("BENCHMARK_ANALYSIS_OUTPUT", ".benchmark/analysis.html"))

    run_metadata = load_json(metadata_path)
    if run_metadata is None:
        return skip_upload(f"No benchmark run metadata found at {metadata_path}; skipping analysis upload.")

    if not analysis_path.is_file():
        return skip_upload(f"No analysis HTML found at {analysis_path}; skipping analysis upload.")

    gcs_prefix = metadata_string(metadata_dict(run_metadata, "gcs"), "prefix")
    if not gcs_prefix:
        return skip_upload("No GCS prefix found in benchmark run metadata; skipping analysis upload.")

    bucket = require_env("BENCHMARK_GCS_BUCKET")

    destination = f"gs://{bucket}/{gcs_prefix}/analysis.html"
    print(f"Uploading benchmark analysis to {destination}")
    run(["gcloud", "storage", "cp", str(analysis_path), destination, "--quiet"])

    # Upload analysis.json if it exists
    json_analysis_path = Path(getenv("BENCHMARK_ANALYSIS_JSON_OUTPUT", ".benchmark/analysis.json"))
    if json_analysis_path.is_file():
        json_destination = f"gs://{bucket}/{gcs_prefix}/analysis.json"
        print(f"Uploading benchmark analysis JSON to {json_destination}")
        run(["gcloud", "storage", "cp", str(json_analysis_path), json_destination, "--quiet"])
    else:
        print(f"Analysis JSON not found at {json_analysis_path}; skipping JSON upload.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
