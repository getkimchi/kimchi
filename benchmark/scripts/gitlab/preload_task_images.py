"""Best-effort pre-warm of task images into the DinD sidecar before trials start.

Why this exists: every chunk job gets a fresh, empty Docker-in-Docker daemon.
Without pre-warming, the first trial of each task lazily pulls its (often
multi-GB) image — the same total bytes, but as N concurrent cold-start
`docker compose up` storms against a daemon that has only been probed with a
tiny hello-world (see wait_for_docker.sh). Pulling the chunk's task images
serially in before_script:

  * serves as a real-path readiness check (proves the daemon can pull what
    trials will actually need, not just hello-world),
  * removes the cold-first-wave pull storm from trial start,
  * surfaces permanently broken images loudly in the job log before trials
    start (and in docker_health's prewarm.failed count) instead of leaving
    them to be discovered one trial at a time.

Best-effort by contract: a single broken image must not block ~30 other tasks
in the chunk, so pull failures are logged and never fail the job (callers may
still guard with `|| true`). The same volume would be pulled lazily anyway —
this only changes when and how (serial, upfront).

Chunk correctness: resolves the same selected task list as chunk_runner
(SELECTED_TASKS_JSON, or the static dataset file when BENCH_TASKS_ALL=true)
and slices it with chunk_slicing.slice_tasks() using the same
BENCH_CHUNK_INDEX / BENCH_CHUNK_COUNT, so each pod pre-warms exactly its own
chunk.

Image sources (mirrors the three environment definitions harbor's
DockerEnvironment accepts, covering every dataset we run):

  1. task.toml [environment].docker_image — prebuilt-image tasks, e.g. all
     terminal-bench-2/-2-1 tasks (harbor pulls this via its own templated
     docker-compose-prebuilt.yaml, so a compose-file scan would miss it).
  2. environment/Dockerfile FROM refs — build-based tasks, e.g. swebenchpro
     (FROM jefzda/sweap-images:<tag>; multi-stage aliases and ${ARG} refs
     are skipped).
  3. environment/docker-compose.y*ml `image:` refs — multi-service tasks
     shipping their own compose. None of the datasets we currently run uses
     this; kept so future compose-based tasks work without code changes.

Reference interpolation (${VAR}) is skipped in all three arms — only harbor
can resolve those task-specific values.

Env overrides:
  BENCH_TASK_PRELOAD       — "false"/"0"/"no" disables pre-warming (default on)
  BENCH_TASK_PRELOAD_RETRIES — max attempts per image on transient daemon
                             connectivity failures (default 3)
  BENCH_TASK_PRELOAD_PULL_TIMEOUT_SECONDS — per-pull timeout (default 1800)
  HARBOR_DATASET_CACHE     — harbor task cache root (image bakes this;
                             default /root/.cache/harbor)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import tomllib
from pathlib import Path

# This script runs as `python3 benchmark/scripts/gitlab/preload_task_images.py`,
# so this directory is on sys.path and these sibling modules import cleanly.
from chunk_runner import _fetch_all_tasks
from chunk_slicing import slice_tasks

# Same production-verified marker as the in-process retry wrapper
# (kimchi_agent.docker_retry._RETRY_MARKER) and the classify rule
# (docker_daemon_unreachable); keep all three in sync.
_DAEMON_UNREACHABLE_MARKER = "Cannot connect to the Docker daemon"

_ENV_DISABLE = "BENCH_TASK_PRELOAD"
_ENV_RETRIES = "BENCH_TASK_PRELOAD_RETRIES"
_ENV_PULL_TIMEOUT = "BENCH_TASK_PRELOAD_PULL_TIMEOUT_SECONDS"
_ENV_RESULTS_DIR = "BENCHMARK_RESULTS_DIR"

_DEFAULT_CACHE = "/root/.cache/harbor"

# Job-level pre-warm outcome, folded into chunk-meta's "docker_health" block by
# chunk_runner. The filename is namespaced by BENCH_CHUNK_INDEX because every
# chunk job writes to the same artifact root (an un-namespaced file is
# last-writer-wins when artifacts are merged). Contents are per attempt: every
# attempt pre-warms against a fresh DinD daemon, and chunk_runner's
# prior-artifact restore deliberately skips these files so a retry never
# reports a stale attempt's pull counts.
_ENV_CHUNK_INDEX = "BENCH_CHUNK_INDEX"


def _health_file_name() -> str:
    """Chunk-namespaced health filename (chunk jobs share the artifact root)."""
    return f"pre-warm-result-chunk-{os.environ.get(_ENV_CHUNK_INDEX, '0')}.json"

# Matches "  image: name:tag" lines in compose files (any indent, optional quotes).
_IMAGE_LINE = re.compile(r"^\s*image:\s*[\"']?([^\s\"']+)[\"']?\s*(?:#.*)?$", re.MULTILINE)

# Matches Dockerfile FROM lines: optional --platform flag, image ref, optional
# "AS <stage>" alias (captured separately so later stage references can be
# told apart from pullable images).
_FROM_LINE = re.compile(
    r"^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$",
    re.IGNORECASE | re.MULTILINE,
)


def _uninterpolated(ref: str) -> bool:
    """True if an image ref contains no ${VAR} / {placeholder} interpolation
    that only harbor (task-specific env) or compose could resolve."""
    return "{" not in ref


def _log(level: str, message: str) -> None:
    stream = sys.stderr if level == "ERROR" else sys.stdout
    print(f"[{level}] {message}", file=stream, flush=True)


def _write_health(payload: dict) -> None:
    """Write the pre-warm outcome for chunk_runner's docker_health aggregation.

    Best-effort: never let metrics break the job (matches the script contract).
    """
    raw = os.environ.get(_ENV_RESULTS_DIR)
    if not raw:
        return
    try:
        path = Path(raw) / _health_file_name()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        _log("ERROR", "failed to write pre-warm health file (metrics only; continuing)")


def _resolve_chunk_tasks() -> list[str]:
    """Resolve the selected task list and slice it for this chunk.

    Mirrors chunk_runner's selection logic: explicit SELECTED_TASKS_JSON wins;
    when tasks_all is true (or the JSON is empty/unset) fall back to the static
    dataset file. Slicing is shared with chunk_runner via slice_tasks().
    """
    # Same env default as chunk_runner.main().
    dataset = os.environ.get("DATASET", "terminal-bench/terminal-bench-2")
    tasks_all = os.environ.get("BENCH_TASKS_ALL", "false").strip().lower() in ("true", "1", "yes")

    selected: list[str] = json.loads(os.environ.get("SELECTED_TASKS_JSON", "[]"))
    if tasks_all or not selected:
        # chunk_runner owns the dataset-file mapping; reuse it instead of
        # duplicating _DATASET_FILE_MAP here.
        selected = _fetch_all_tasks(dataset, bench_dir=Path("."))

    chunk_index = int(os.environ.get("BENCH_CHUNK_INDEX", "0"))
    chunk_count = int(os.environ.get("BENCH_CHUNK_COUNT", "1"))
    return slice_tasks(selected, chunk_index=chunk_index, chunk_count=chunk_count)


def _package_dirs_for_task(task: str, cache_root: Path) -> list[Path]:
    """Cache dirs (one per checksum) holding task <task> under any namespace."""
    packages = cache_root / "tasks" / "packages"
    if not packages.is_dir():
        return []
    dirs: list[Path] = []
    for namespace in sorted(packages.iterdir()):
        env_dir = namespace / task
        if not env_dir.is_dir():
            continue
        dirs.extend(sorted(d for d in env_dir.iterdir() if d.is_dir()))
    return dirs


def _compose_files_for_task(task: str, cache_root: Path) -> list[Path]:
    """Find compose files under the harbor cache for one task, any namespace/checksum."""
    files: list[Path] = []
    for package_dir in _package_dirs_for_task(task, cache_root):
        files.extend(sorted((package_dir / "environment").glob("docker-compose.y*ml")))
    return files


def _docker_image_from_task_toml(package_dir: Path) -> str | None:
    """Arm 1: prebuilt image ref from task.toml [environment].docker_image.

    terminal-bench-2/-2-1 tasks use this; harbor pulls the image through its
    own templated docker-compose-prebuilt.yaml, so compose scanning alone
    never sees it. Unparseable/missing configs yield None (best-effort).
    """
    toml_path = package_dir / "task.toml"
    if not toml_path.is_file():
        return None
    try:
        data = tomllib.loads(toml_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return None
    image = data.get("environment", {}).get("docker_image")
    if not isinstance(image, str) or not image or not _uninterpolated(image):
        return None
    return image


def _images_from_dockerfile(dockerfile: Path) -> list[str]:
    """Arm 2: FROM refs from a Dockerfile (swebenchpro-style build tasks).

    Multi-stage builds may reference earlier stage names in FROM; those are
    aliases, not pullable images, and are skipped alongside ${ARG} refs.
    """
    images: list[str] = []
    stage_aliases: set[str] = set()
    for match in _FROM_LINE.finditer(dockerfile.read_text(encoding="utf-8")):
        ref, alias = match.group(1), match.group(2)
        if alias:
            stage_aliases.add(alias.casefold())
        if (
            _uninterpolated(ref)
            and ref != "scratch"  # reserved empty base; nothing to pull
            and ref.casefold() not in stage_aliases
            and ref not in images
        ):
            images.append(ref)
    return images


def _images_for_task(task: str, cache_root: Path) -> list[str]:
    """All pullable image refs for one task across the three arms, deduped."""
    images: list[str] = []

    def _add(ref: str | None) -> None:
        if ref and ref not in images:
            images.append(ref)

    for package_dir in _package_dirs_for_task(task, cache_root):
        _add(_docker_image_from_task_toml(package_dir))
        dockerfile = package_dir / "environment" / "Dockerfile"
        if dockerfile.is_file():
            for ref in _images_from_dockerfile(dockerfile):
                _add(ref)
    for ref in _extract_images(_compose_files_for_task(task, cache_root)):
        _add(ref)
    return images


def _extract_images(compose_files: list[Path]) -> list[str]:
    """Extract deduplicated, directly-pullable image references from compose files.

    Skips services that only build (no image line) and image references with
    unresolved ${VAR} interpolation (harbor resolves those at trial time from
    task-specific env that we don't have here).
    """
    seen: list[str] = []
    for path in compose_files:
        for match in _IMAGE_LINE.finditer(path.read_text(encoding="utf-8")):
            image = match.group(1)
            if "${" in image or "{" in image:
                continue
            if image not in seen:
                seen.append(image)
    return seen


def _docker_pull(image: str, timeout_seconds: int) -> tuple[bool, str]:
    """Run one docker pull; returns (success, combined_output)."""
    try:
        proc = subprocess.run(
            ["docker", "pull", image],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return False, f"docker pull timed out after {timeout_seconds}s"
    output = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode == 0, output


def _preload_images(images: list[str], *, retries: int, pull_timeout: int) -> tuple[int, int]:
    """Serially pull images with bounded retries on transient daemon errors.

    Returns (pulled, failed). Never raises: permanent failures (missing image,
    bad tag) are logged and skipped — the task's own trial will classify them.
    """
    pulled = 0
    failed = 0
    for index, image in enumerate(images, start=1):
        for attempt in range(1, retries + 1):
            _log("INFO", f"[{index}/{len(images)}] pull {image} (attempt {attempt}/{retries})")
            ok, output = _docker_pull(image, pull_timeout)
            if ok:
                pulled += 1
                break
            transient = _DAEMON_UNREACHABLE_MARKER.casefold() in output.casefold()
            if transient and attempt < retries:
                delay = 5.0 * attempt
                _log("INFO", f"  daemon unreachable; retrying in {delay:.0f}s")
                time.sleep(delay)
                continue
            failed += 1
            kind = "transient (budget exhausted)" if transient else "permanent"
            _log("ERROR", f"  pull failed ({kind}): {output.strip()[-300:]}")
            break
    return pulled, failed


def main() -> int:
    if os.environ.get(_ENV_DISABLE, "true").strip().lower() in ("false", "0", "no"):
        _log("INFO", f"task image pre-warm disabled via ${_ENV_DISABLE}")
        _write_health({"disabled": True, "pulled": 0, "failed": 0})
        return 0

    retries = int(os.environ.get(_ENV_RETRIES, "3"))
    pull_timeout = int(os.environ.get(_ENV_PULL_TIMEOUT, "1800"))
    cache_root = Path(os.environ.get("HARBOR_DATASET_CACHE", _DEFAULT_CACHE))

    tasks = _resolve_chunk_tasks()
    if not tasks:
        _log("INFO", "no tasks selected for this chunk; nothing to pre-warm")
        _write_health({"pulled": 0, "failed": 0, "note": "no_tasks"})
        return 0
    _log("INFO", f"pre-warming images for {len(tasks)} tasks in this chunk")

    images = list(
        dict.fromkeys(ref for task in tasks for ref in _images_for_task(task, cache_root))
    )
    if not images:
        _log("INFO", "no pullable image references found (build-only tasks or empty cache)")
        _write_health({"pulled": 0, "failed": 0, "note": "no_images"})
        return 0
    _log("INFO", f"found {len(images)} unique images to pull")

    pulled, failed = _preload_images(images, retries=retries, pull_timeout=pull_timeout)
    _write_health({"pulled": pulled, "failed": failed, "images_total": len(images)})
    _log("INFO", f"pre-warm complete: {pulled} pulled, {failed} failed (best-effort, job continues)")
    # Best-effort contract: failures are surfaced in logs, never in exit status.
    return 0


if __name__ == "__main__":
    sys.exit(main())
