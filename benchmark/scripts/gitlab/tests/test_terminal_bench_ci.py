"""Contract tests for benchmark checkpoint CI wiring."""

from pathlib import Path

CI_CONFIG = (
    Path(__file__).resolve().parents[4] / ".gitlab" / "ci" / "terminal-bench-2.yml"
)
SWE_CI_CONFIG = (
    Path(__file__).resolve().parents[4] / ".gitlab" / "ci" / "swe-bench-pro.yml"
)
ROOT_CI_CONFIG = Path(__file__).resolve().parents[4] / ".gitlab-ci.yml"


def _job_block(config: str, job_name: str, next_job_name: str) -> str:
    start = config.index(job_name)
    end = config.index(next_job_name, start)
    return config[start:end]


def test_analysis_consumes_hydrated_summary_archive_not_chunk_artifacts() -> None:
    config = CI_CONFIG.read_text(encoding="utf-8")
    summary = _job_block(
        config,
        "$[[ inputs.benchmark ]]-summary:",
        "$[[ inputs.benchmark ]]-analyze:",
    )
    analyze = _job_block(
        config,
        "$[[ inputs.benchmark ]]-analyze:",
        "$[[ inputs.benchmark ]]-upload-analysis:",
    )

    assert "- .benchmark-upload/jobs.tar.gz" in summary
    assert "job: $[[ inputs.benchmark ]]-chunks" not in analyze
    assert "job: $[[ inputs.benchmark ]]-summary" in analyze
    assert "tar -xzf .benchmark-upload/jobs.tar.gz" in analyze


def test_summary_uses_static_needs_for_parallel_chunk_artifacts() -> None:
    config = CI_CONFIG.read_text(encoding="utf-8")
    summary = _job_block(
        config,
        "$[[ inputs.benchmark ]]-summary:",
        "$[[ inputs.benchmark ]]-analyze:",
    )
    rules = summary[summary.index("  rules:") : summary.index("  image:")]

    assert (
        "  needs:\n"
        "    - job: $[[ inputs.benchmark ]]-chunks\n"
        "      artifacts: true"
    ) in summary
    assert "needs:" not in rules


def test_swe_summary_preserves_the_five_chunk_positional_ownership() -> None:
    config = SWE_CI_CONFIG.read_text(encoding="utf-8")
    summary = _job_block(
        config,
        "swe-bench-pro-summary:",
        "swe-bench-pro-analyze:",
    )

    assert 'BENCH_CHUNK_COUNT: "5"' in summary


def test_timeout_analysis_consumes_hydrated_summary_archive_not_chunk_artifacts() -> None:
    config = CI_CONFIG.read_text(encoding="utf-8")
    analyze_timeouts = _job_block(
        config,
        "$[[ inputs.benchmark ]]-analyze-timeouts:",
        "$[[ inputs.benchmark ]]-upload-timeout-analysis:",
    )

    assert "job: $[[ inputs.benchmark ]]-chunks" not in analyze_timeouts
    assert "job: $[[ inputs.benchmark ]]-summary" in analyze_timeouts
    assert "tar -xzf .benchmark-upload/jobs.tar.gz" in analyze_timeouts


def test_root_pipeline_forwards_checkpoint_enablement_to_terminal_bench() -> None:
    config = ROOT_CI_CONFIG.read_text(encoding="utf-8")
    terminal_include = _job_block(
        config,
        "- local: /.gitlab/ci/terminal-bench-2.yml",
        "- local: /.gitlab/ci/swe-bench-pro.yml",
    )

    # trial_checkpoints remains a pipeline input (boolean toggle per run).
    # trial_checkpoint_bucket, checkpoint_soft_deadline_seconds, and
    # checkpoint_upload_retries are no longer pipeline inputs: the bucket is a
    # CI/CD variable, the soft deadline is derived from BENCH_JOB_TIMEOUT_SECONDS,
    # and the upload retry count is a code constant.
    assert "trial_checkpoints: $[[ inputs.trial_checkpoints ]]" in terminal_include
    assert "trial_checkpoint_bucket:" not in terminal_include
    assert "checkpoint_soft_deadline_seconds:" not in terminal_include
    assert "checkpoint_upload_retries:" not in terminal_include


def test_chunk_job_sets_job_timeout_for_soft_deadline() -> None:
    config = CI_CONFIG.read_text(encoding="utf-8")
    chunk = _job_block(
        config,
        ".terminal-bench-2-chunk:",
        "$[[ inputs.benchmark ]]-chunks:",
    )

    # The soft deadline is computed as a fraction of the job timeout.
    assert "BENCH_JOB_TIMEOUT_SECONDS: \"43200\"" in chunk  # 12h
    # The old explicit env vars must not be present.
    assert "BENCH_CHECKPOINT_SOFT_DEADLINE_SECONDS" not in chunk
    assert "BENCH_CHECKPOINT_UPLOAD_RETRIES" not in chunk
    # BENCH_CHECKPOINT_BUCKET is a CI/CD variable, not a pipeline input.
    assert "BENCH_CHECKPOINT_BUCKET: $[[ inputs" not in chunk


def test_root_pipeline_forwards_checkpoint_enablement_to_swe_bench_guard() -> None:
    config = ROOT_CI_CONFIG.read_text(encoding="utf-8")
    swe_include = config[config.index("- local: /.gitlab/ci/swe-bench-pro.yml") :]

    assert "trial_checkpoints: $[[ inputs.trial_checkpoints ]]" in swe_include


def _forwarded_inputs(root_config: str, include_path: str) -> set[str]:
    """Input names the root pipeline forwards to an included benchmark file."""
    start = root_config.index(f"- local: {include_path}")
    inputs_start = root_config.index("inputs:", start)
    block = root_config[inputs_start:]
    forwarded = set()
    for line in block.splitlines()[1:]:
        if not line.startswith("      ") or ":" not in line:
            break
        forwarded.add(line.strip().split(":", 1)[0])
    return forwarded


def _declared_inputs() -> set[str]:
    spec = (
        Path(__file__).resolve().parents[4] / ".gitlab" / "ci" / "benchmark.inputs.yml"
    ).read_text(encoding="utf-8")
    body = spec[spec.index("inputs:") :]
    return {
        line.strip().rstrip(":")
        for line in body.splitlines()
        if line.startswith("  ") and not line.startswith("    ") and line.rstrip().endswith(":")
    }


def test_root_pipeline_forwards_every_declared_input_to_both_benchmarks() -> None:
    """An input the root spec accepts but never forwards silently uses its default.

    thinking_level was declared and settable in the UI, yet omitted from both
    include blocks — so every run read 'default' no matter what was selected.
    """
    root = ROOT_CI_CONFIG.read_text(encoding="utf-8")
    declared = _declared_inputs()
    # benchmark selects which file is included, so only that one is exempt.
    for include_path, exempt in (
        ("/.gitlab/ci/terminal-bench-2.yml", set()),
        ("/.gitlab/ci/swe-bench-pro.yml", {"benchmark"}),
    ):
        forwarded = _forwarded_inputs(root, include_path)
        missing = declared - forwarded - exempt
        assert not missing, f"{include_path} does not forward: {sorted(missing)}"
