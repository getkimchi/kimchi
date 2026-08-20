"""Unit tests for preload_task_images.py — best-effort DinD pre-warm."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import preload_task_images as preload


def _write_task_package(cache_root: Path, namespace: str, task: str, checksum: str, compose: str) -> None:
    env_dir = cache_root / "tasks" / "packages" / namespace / task / checksum / "environment"
    env_dir.mkdir(parents=True)
    (env_dir / "docker-compose.yaml").write_text(compose)


def _write_prebuilt_package(
    cache_root: Path,
    task: str,
    *,
    docker_image: str | None = None,
    dockerfile: str | None = None,
    namespace: str = "terminal-bench",
    checksum: str = "deadbeef",
) -> Path:
    """Mirror a real harbor-cached package: task.toml + environment dir (no compose)."""
    package_dir = cache_root / "tasks" / "packages" / namespace / task / checksum
    env_dir = package_dir / "environment"
    env_dir.mkdir(parents=True)
    toml = '[environment]\nbuild_timeout_sec = 600.0\n'
    if docker_image is not None:
        toml += f'docker_image = "{docker_image}"\n'
    (package_dir / "task.toml").write_text(toml)
    if dockerfile is not None:
        (env_dir / "Dockerfile").write_text(dockerfile)
    return package_dir


class TestExtractImages:
    def test_extracts_images_and_dedupes(self, tmp_path: Path) -> None:
        compose = tmp_path / "docker-compose.yaml"
        compose.write_text(
            "services:\n"
            "  agent:\n"
            "    image: alexgshaw/foo:20251031\n"
            "  sidecar:\n"
            "    image: 'alexgshaw/foo:20251031'\n"
            "  other:\n"
            "    image: \"ghcr.io/bar/baz:latest\"\n"
        )
        assert preload._extract_images([compose]) == ["alexgshaw/foo:20251031", "ghcr.io/bar/baz:latest"]

    def test_skips_interpolated_references(self, tmp_path: Path) -> None:
        compose = tmp_path / "docker-compose.yml"
        compose.write_text(
            "services:\n"
            "  a:\n"
            '    image: ${TASK_IMAGE}\n'
            "  b:\n"
            "    image: alexgshaw/real:tag\n"
        )
        assert preload._extract_images([compose]) == ["alexgshaw/real:tag"]

    def test_build_only_services_yield_nothing(self, tmp_path: Path) -> None:
        compose = tmp_path / "docker-compose.yaml"
        compose.write_text("services:\n  a:\n    build: .\n")
        assert preload._extract_images([compose]) == []


class TestTaskTomlArm:
    def test_extracts_prebuilt_docker_image(self, tmp_path: Path) -> None:
        package = _write_prebuilt_package(
            tmp_path, "build-cython-ext", docker_image="alexgshaw/build-cython-ext:20251031"
        )
        assert preload._docker_image_from_task_toml(package) == "alexgshaw/build-cython-ext:20251031"

    def test_missing_or_crooked_config_yields_none(self, tmp_path: Path) -> None:
        assert preload._docker_image_from_task_toml(tmp_path) is None
        package = tmp_path / "pkg"
        package.mkdir()
        (package / "task.toml").write_text("not [valid toml")
        assert preload._docker_image_from_task_toml(package) is None
        (package / "task.toml").write_text('[environment]\ndocker_image = 42\n')
        assert preload._docker_image_from_task_toml(package) is None


class TestDockerfileArm:
    def test_simple_and_platform_flagged_from(self, tmp_path: Path) -> None:
        df = tmp_path / "Dockerfile"
        df.write_text(
            "FROM --platform=linux/amd64 ubuntu:24.04\n"
            "RUN apt-get update\n"
            "FROM scratch\n"
        )
        # 'scratch' is filtered: reserved empty base, nothing to pull.
        assert preload._images_from_dockerfile(df) == ["ubuntu:24.04"]

    def test_multistage_aliases_and_arg_refs_skipped(self, tmp_path: Path) -> None:
        df = tmp_path / "Dockerfile"
        df.write_text(
            "FROM python:3.12 AS builder\n"
            "RUN pip install .\n"
            "FROM builder\n"
            "FROM ${BASE_IMAGE}\n"
            "COPY --from=builder /out /out\n"
        )
        assert preload._images_from_dockerfile(df) == ["python:3.12"]

    def test_scratch_is_not_pullable(self, tmp_path: Path) -> None:
        df = tmp_path / "Dockerfile"
        df.write_text("FROM ubuntu:24.04 AS base\nFROM scratch\nCOPY --from=base /x /x\n")
        # 'scratch' is a reserved empty base; `docker pull scratch` would fail.
        assert preload._images_from_dockerfile(df) == ["ubuntu:24.04"]


class TestImagesForTask:
    def test_combines_all_three_arms_deduped(self, tmp_path: Path) -> None:
        cache = tmp_path / "harbor"
        _write_prebuilt_package(
            cache,
            "task-a",
            docker_image="alexgshaw/task-a:20251031",
            dockerfile="FROM alexgshaw/task-a:20251031\nFROM postgres:16\n",
        )
        _write_task_package(
            cache, "terminal-bench", "task-a", "other999",
            "services:\n  side:\n    image: postgres:16\n",
        )
        assert preload._images_for_task("task-a", cache) == [
            "alexgshaw/task-a:20251031",
            "postgres:16",
        ]

    def test_unknown_task_yields_nothing(self, tmp_path: Path) -> None:
        assert preload._images_for_task("nonexistent", tmp_path) == []


class TestComposeDiscovery:
    def test_finds_compose_by_task_name_across_namespace_and_checksum(self, tmp_path: Path) -> None:
        cache = tmp_path / "harbor"
        _write_task_package(cache, "terminal-bench", "bn-fit-modify", "abc123", "services: {}\n")
        _write_task_package(cache, "terminal-bench", "bn-fit-modify", "def456", "services: {}\n")
        _write_task_package(cache, "terminal-bench", "other-task", "999000", "services: {}\n")

        files = preload._compose_files_for_task("bn-fit-modify", cache)

        assert len(files) == 2
        assert all(f.name == "docker-compose.yaml" for f in files)

    def test_missing_cache_returns_empty(self, tmp_path: Path) -> None:
        assert preload._compose_files_for_task("anything", tmp_path / "nope") == []


class TestChunkTaskResolution:
    def test_explicit_selected_tasks_are_sliced(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SELECTED_TASKS_JSON", json.dumps([f"task-{i}" for i in range(10)]))
        monkeypatch.setenv("BENCH_TASKS_ALL", "false")
        monkeypatch.setenv("BENCH_CHUNK_INDEX", "1")
        monkeypatch.setenv("BENCH_CHUNK_COUNT", "3")

        tasks = preload._resolve_chunk_tasks()

        # slice_tasks([10 tasks], index=1, count=3) → base 3, remainder 1:
        # chunk 0 gets 4, chunk 1 gets 3, chunk 2 gets 3.
        assert tasks == ["task-4", "task-5", "task-6"]

    def test_source_qualified_names_normalise_and_dedupe_before_slicing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Pre-warm exactly the tasks chunk_runner will own: bare, aliases collapsed."""
        monkeypatch.setenv(
            "SELECTED_TASKS_JSON",
            json.dumps(["terminal-bench/fix-git", "fix-git", "extract-elf"]),
        )
        monkeypatch.setenv("BENCH_TASKS_ALL", "false")
        monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")
        monkeypatch.setenv("BENCH_CHUNK_COUNT", "1")

        assert preload._resolve_chunk_tasks() == ["fix-git", "extract-elf"]

    def test_tasks_all_ignores_selected_json_and_uses_dataset_file(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("SELECTED_TASKS_JSON", '["ignored-task"]')
        monkeypatch.setenv("BENCH_TASKS_ALL", "true")
        monkeypatch.setenv("DATASET", "terminal-bench/terminal-bench-2-1")
        monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")
        monkeypatch.setenv("BENCH_CHUNK_COUNT", "1")

        tasks = preload._resolve_chunk_tasks()

        assert "ignored-task" not in tasks
        assert len(tasks) > 0  # static dataset file drove selection

    def test_empty_json_falls_back_to_dataset_file(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("SELECTED_TASKS_JSON", raising=False)
        monkeypatch.setenv("BENCH_TASKS_ALL", "false")
        monkeypatch.setenv("DATASET", "terminal-bench/terminal-bench-2")
        monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")
        monkeypatch.setenv("BENCH_CHUNK_COUNT", "1")

        tasks = preload._resolve_chunk_tasks()

        assert len(tasks) > 0


class TestPreloadImages:
    def test_successful_pulls_count(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(preload, "_docker_pull", lambda image, timeout: (True, "ok"))
        pulled, failed = preload._preload_images(["a:1", "b:2"], retries=3, pull_timeout=60)
        assert (pulled, failed) == (2, 0)

    def test_transient_daemon_error_retries_then_succeeds(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls: list[str] = []

        def flaky(image: str, timeout: int) -> tuple[bool, str]:
            calls.append(image)
            if len(calls) < 3:
                return False, "unable to get image: Cannot connect to the Docker daemon at tcp://docker:2375"
            return True, "ok"

        monkeypatch.setattr(preload, "_docker_pull", flaky)
        monkeypatch.setattr(preload.time, "sleep", lambda _: None)

        pulled, failed = preload._preload_images(["a:1"], retries=3, pull_timeout=60)

        assert (pulled, failed) == (1, 0)
        assert len(calls) == 3

    def test_permanent_failure_skips_and_continues(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def always_fails(image: str, timeout: int) -> tuple[bool, str]:
            return False, "unable to get image 'a:missing': not found"

        monkeypatch.setattr(preload, "_docker_pull", always_fails)
        monkeypatch.setattr(preload.time, "sleep", lambda _: None)

        pulled, failed = preload._preload_images(["a:missing", "b:also-missing"], retries=3, pull_timeout=60)

        # Permanent failures must NOT burn the retry budget: 1 attempt each.
        assert (pulled, failed) == (0, 2)

    def test_exhausted_transient_budget_counts_once(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            preload,
            "_docker_pull",
            lambda image, timeout: (False, "Cannot connect to the Docker daemon at tcp://docker:2375"),
        )
        monkeypatch.setattr(preload.time, "sleep", lambda _: None)

        pulled, failed = preload._preload_images(["a:1"], retries=3, pull_timeout=60)

        assert (pulled, failed) == (0, 1)

    def test_timeout_is_reported_as_failure(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(preload, "_docker_pull", lambda image, timeout: (False, "docker pull timed out after 60s"))
        pulled, failed = preload._preload_images(["a:1"], retries=1, pull_timeout=60)
        assert (pulled, failed) == (0, 1)


class TestMainPrewarmsPrebuiltImages:
    """Regression for the 2026-08-07 trace finding: tb-2/-2-1 tasks declare the
    pullable image in task.toml [environment].docker_image (harbor renders its
    own templated compose), so compose-only scanning pre-warmed NOTHING."""

    def test_task_without_compose_is_still_prewarmed(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv("SELECTED_TASKS_JSON", '["build-cython-ext"]')
        monkeypatch.setenv("BENCH_CHUNK_COUNT", "1")
        monkeypatch.setenv("HARBOR_DATASET_CACHE", str(tmp_path))
        monkeypatch.setenv("BENCHMARK_RESULTS_DIR", str(tmp_path))
        _write_prebuilt_package(
            tmp_path, "build-cython-ext", docker_image="alexgshaw/build-cython-ext:20251031"
        )
        pulled: list[str] = []
        monkeypatch.setattr(
            preload, "_docker_pull", lambda image, timeout: (pulled.append(image), (True, "ok"))[1]
        )

        assert preload.main() == 0

        assert pulled == ["alexgshaw/build-cython-ext:20251031"]
        health = json.loads((tmp_path / "pre-warm-result-chunk-0.json").read_text())
        assert health == {"pulled": 1, "failed": 0, "images_total": 1}


class TestMainContract:
    def test_disable_flag_short_circuits(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("BENCH_TASK_PRELOAD", "false")
        assert preload.main() == 0

    def test_disable_flag_writes_health_marker(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv("BENCH_TASK_PRELOAD", "false")
        monkeypatch.setenv("BENCHMARK_RESULTS_DIR", str(tmp_path))

        assert preload.main() == 0

        health = json.loads((tmp_path / "pre-warm-result-chunk-0.json").read_text())
        assert health["disabled"] is True

    def test_health_file_namespaced_by_chunk_index(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Chunk jobs share the artifact root; the file name must carry BENCH_CHUNK_INDEX."""
        monkeypatch.setenv("BENCH_TASK_PRELOAD", "false")
        monkeypatch.setenv("BENCHMARK_RESULTS_DIR", str(tmp_path))
        monkeypatch.setenv("BENCH_CHUNK_INDEX", "2")

        assert preload.main() == 0

        health = json.loads((tmp_path / "pre-warm-result-chunk-2.json").read_text())
        assert health["disabled"] is True

    def test_prewarm_writes_health_counts(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        monkeypatch.setenv("SELECTED_TASKS_JSON", '["task-a"]')
        monkeypatch.setenv("BENCH_CHUNK_COUNT", "1")
        monkeypatch.setenv("HARBOR_DATASET_CACHE", str(tmp_path))
        monkeypatch.setenv("BENCHMARK_RESULTS_DIR", str(tmp_path))
        _write_task_package(
            tmp_path,
            "terminal-bench",
            "task-a",
            "deadbeef",
            "services:\n  a:\n    image: example/ok:tag\n",
        )
        monkeypatch.setattr(preload, "_docker_pull", lambda image, timeout: (True, "ok"))

        assert preload.main() == 0

        health = json.loads((tmp_path / "pre-warm-result-chunk-0.json").read_text())
        assert health == {"pulled": 1, "failed": 0, "images_total": 1}

    def test_main_never_fails_on_pull_errors(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        monkeypatch.setenv("SELECTED_TASKS_JSON", '["task-a"]')
        monkeypatch.setenv("BENCH_CHUNK_COUNT", "1")
        monkeypatch.setenv("HARBOR_DATASET_CACHE", str(tmp_path))
        _write_task_package(
            tmp_path,
            "terminal-bench",
            "task-a",
            "deadbeef",
            "services:\n  a:\n    image: example/broken:tag\n",
        )
        monkeypatch.setattr(preload, "_docker_pull", lambda image, timeout: (False, "not found"))

        # Best-effort contract: permanent pull failure still exits 0 so the
        # chunk job proceeds — best-effort means the job is NEVER gated here.
        assert preload.main() == 0
