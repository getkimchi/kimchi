#!/usr/bin/env python3
"""Tests for upload_analysis_gcs.py."""

from __future__ import annotations

import ast
import json
import os
from pathlib import Path
from unittest.mock import patch

from upload_analysis_gcs import main


def test_upload_script_parses_with_ci_python_3_11() -> None:
    script_path = Path(__file__).parent.parent / "upload_analysis_gcs.py"

    ast.parse(script_path.read_text(encoding="utf-8"), filename=str(script_path), feature_version=(3, 11))


def test_main_uploads_analysis_html(tmp_path: Path) -> None:
    metadata_path = tmp_path / "run-metadata.json"
    metadata_path.write_text(
        json.dumps(
            {
                "gcs": {
                    "prefix": "runs/benchmark=tb2/coding_agent=kimchi/model_provider=dev/"
                    "model=m/date=2026-01-01/run=gitlab-p1-j2"
                },
            }
        )
    )
    analysis_path = tmp_path / "analysis.html"
    analysis_path.write_text("<html><body>Analysis</body></html>")

    captured: list[list[str]] = []

    def fake_run(cmd: list[str]) -> None:
        captured.append(cmd)

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RUN_METADATA": str(metadata_path),
                "BENCHMARK_ANALYSIS_OUTPUT": str(analysis_path),
                "BENCHMARK_GCS_BUCKET": "test-bucket",
                "GCS_UPLOAD_REQUIRED": "true",
            },
            clear=False,
        ),
        patch("upload_analysis_gcs.run", side_effect=fake_run),
    ):
        assert main() == 0

    assert len(captured) == 1
    assert captured[0][0] == "gcloud"
    assert captured[0][2] == "cp"
    assert captured[0][3] == str(analysis_path)
    assert (
        captured[0][4]
        == "gs://test-bucket/runs/benchmark=tb2/coding_agent=kimchi/model_provider=dev/model=m/date=2026-01-01/run=gitlab-p1-j2/analysis.html"
    )


def test_main_skips_when_metadata_missing(tmp_path: Path) -> None:
    analysis_path = tmp_path / "analysis.html"
    analysis_path.write_text("<html></html>")

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RUN_METADATA": str(tmp_path / "missing.json"),
                "BENCHMARK_ANALYSIS_OUTPUT": str(analysis_path),
                "BENCHMARK_GCS_BUCKET": "test-bucket",
                "GCS_UPLOAD_REQUIRED": "true",
            },
            clear=False,
        ),
        patch("upload_analysis_gcs.run") as mock_run,
    ):
        assert main() == 1
        mock_run.assert_not_called()


def test_main_skips_when_analysis_file_missing(tmp_path: Path) -> None:
    metadata_path = tmp_path / "run-metadata.json"
    metadata_path.write_text(json.dumps({"gcs": {"prefix": "runs/prefix"}}))

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RUN_METADATA": str(metadata_path),
                "BENCHMARK_ANALYSIS_OUTPUT": str(tmp_path / "missing.html"),
                "BENCHMARK_GCS_BUCKET": "test-bucket",
                "GCS_UPLOAD_REQUIRED": "true",
            },
            clear=False,
        ),
        patch("upload_analysis_gcs.run") as mock_run,
    ):
        assert main() == 1
        mock_run.assert_not_called()


def test_main_skips_when_gcs_prefix_missing(tmp_path: Path) -> None:
    metadata_path = tmp_path / "run-metadata.json"
    metadata_path.write_text(json.dumps({"gcs": {}}))
    analysis_path = tmp_path / "analysis.html"
    analysis_path.write_text("<html></html>")

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RUN_METADATA": str(metadata_path),
                "BENCHMARK_ANALYSIS_OUTPUT": str(analysis_path),
                "BENCHMARK_GCS_BUCKET": "test-bucket",
                "GCS_UPLOAD_REQUIRED": "true",
            },
            clear=False,
        ),
        patch("upload_analysis_gcs.run") as mock_run,
    ):
        assert main() == 1
        mock_run.assert_not_called()


def test_main_returns_0_when_upload_not_required_and_file_missing(tmp_path: Path) -> None:
    metadata_path = tmp_path / "run-metadata.json"
    metadata_path.write_text(json.dumps({"gcs": {"prefix": "runs/prefix"}}))

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RUN_METADATA": str(metadata_path),
                "BENCHMARK_ANALYSIS_OUTPUT": str(tmp_path / "missing.html"),
                "BENCHMARK_GCS_BUCKET": "test-bucket",
                "GCS_UPLOAD_REQUIRED": "false",
            },
            clear=False,
        ),
        patch("upload_analysis_gcs.run") as mock_run,
    ):
        assert main() == 0
        mock_run.assert_not_called()


def test_main_uploads_analysis_html_to_2_1_prefix(tmp_path: Path) -> None:
    """A 2.1 run's gcs.prefix routes analysis.html under runs/benchmark=terminal-bench-2-1/.

    Mirrors test_main_uploads_analysis_html but with the metadata's `gcs.prefix`
    set to a 2.1 prefix, proving the analysis upload lands in a namespace
    disjoint from the 2.0 default.
    """
    metadata_path = tmp_path / "run-metadata.json"
    metadata_path.write_text(
        json.dumps(
            {
                "gcs": {
                    "prefix": "runs/benchmark=terminal-bench-2-1/coding_agent=kimchi/"
                    "model_provider=dev/model=m/date=2026-01-01/run=gitlab-p1-j2"
                },
            }
        )
    )
    analysis_path = tmp_path / "analysis.html"
    analysis_path.write_text("<html><body>Analysis</body></html>")

    captured: list[list[str]] = []

    def fake_run(cmd: list[str]) -> None:
        captured.append(cmd)

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RUN_METADATA": str(metadata_path),
                "BENCHMARK_ANALYSIS_OUTPUT": str(analysis_path),
                "BENCHMARK_GCS_BUCKET": "test-bucket",
                "GCS_UPLOAD_REQUIRED": "true",
            },
            clear=False,
        ),
        patch("upload_analysis_gcs.run", side_effect=fake_run),
    ):
        assert main() == 0

    assert len(captured) == 1
    assert captured[0][0] == "gcloud"
    assert captured[0][2] == "cp"
    assert captured[0][3] == str(analysis_path)
    assert (
        captured[0][4]
        == "gs://test-bucket/runs/benchmark=terminal-bench-2-1/coding_agent=kimchi/"
        "model_provider=dev/model=m/date=2026-01-01/run=gitlab-p1-j2/analysis.html"
    )
