"""Behavioral tests for wait_for_docker.sh.

Runs the real bash script with a fake ``docker`` on PATH so the two-phase
readiness probe is exercised end-to-end (exit codes + phase transitions),
without needing a real daemon.
"""

from __future__ import annotations

import os
import stat
import subprocess
import textwrap
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "wait_for_docker.sh"

# Keep probes fast in tests; production defaults remain in the script.
_TEST_ENV = {
    "WAIT_FOR_DOCKER_MAX_ATTEMPTS": "3",
    "WAIT_FOR_DOCKER_INFO_SLEEP": "0",
    "WAIT_FOR_DOCKER_PROBE_MAX_ATTEMPTS": "3",
    "WAIT_FOR_DOCKER_PROBE_SLEEP": "0",
    "WAIT_FOR_DOCKER_PROBE_IMAGE": "mirror.gcr.io/library/hello-world",
}


def _write_executable(path: Path, contents: str) -> None:
    path.write_text(textwrap.dedent(contents), encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _install_fake_docker(bin_dir: Path, body: str) -> None:
    _write_executable(bin_dir / "docker", f"#!/usr/bin/env bash\n{body}\n")


def _run_script(bin_dir: Path, *, env_extra: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update(_TEST_ENV)
    if env_extra:
        env.update(env_extra)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
    return subprocess.run(
        ["bash", str(SCRIPT)],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )


@pytest.fixture
def bin_dir(tmp_path: Path) -> Path:
    d = tmp_path / "bin"
    d.mkdir()
    return d


def test_script_exists() -> None:
    assert SCRIPT.is_file()


def test_succeeds_when_info_and_run_ok(bin_dir: Path) -> None:
    _install_fake_docker(
        bin_dir,
        """
        case "$*" in
          *info*) exit 0 ;;
          *run*)  exit 0 ;;
          *)      exit 1 ;;
        esac
        """,
    )
    result = _run_script(bin_dir)
    assert result.returncode == 0, result.stderr + result.stdout
    assert "socket is responding" in result.stdout
    assert "container probe passed" in result.stdout
    assert "mirror.gcr.io/library/hello-world" in SCRIPT.read_text(encoding="utf-8")


def test_fails_when_info_never_succeeds(bin_dir: Path) -> None:
    _install_fake_docker(
        bin_dir,
        """
        case "$*" in
          *info*) exit 1 ;;
          *)      exit 0 ;;
        esac
        """,
    )
    result = _run_script(bin_dir)
    assert result.returncode == 1
    assert "socket not ready" in result.stderr
    assert "container probe passed" not in result.stdout


def test_fails_when_run_probe_never_succeeds(bin_dir: Path) -> None:
    _install_fake_docker(
        bin_dir,
        """
        case "$*" in
          *info*) exit 0 ;;
          *run*)  echo "Cannot connect to the Docker daemon at tcp://docker:2375" >&2; exit 1 ;;
          *)      exit 1 ;;
        esac
        """,
    )
    result = _run_script(bin_dir)
    assert result.returncode == 1
    assert "socket is responding" in result.stdout
    assert "cannot run containers" in result.stderr
    assert "Last probe output" in result.stderr
    assert "Cannot connect to the Docker daemon" in result.stderr


def test_retries_info_then_succeeds(bin_dir: Path) -> None:
    state = bin_dir / "info_attempts"
    state.write_text("0", encoding="utf-8")
    _install_fake_docker(
        bin_dir,
        f"""
        state="{state}"
        case "$*" in
          *info*)
            n=$(cat "$state")
            n=$((n + 1))
            echo "$n" > "$state"
            if [[ "$n" -lt 3 ]]; then
              exit 1
            fi
            exit 0
            ;;
          *run*) exit 0 ;;
          *) exit 1 ;;
        esac
        """,
    )
    result = _run_script(bin_dir)
    assert result.returncode == 0, result.stderr + result.stdout
    assert state.read_text(encoding="utf-8").strip() == "3"
    assert "container probe passed" in result.stdout


def test_retries_run_probe_then_succeeds(bin_dir: Path) -> None:
    state = bin_dir / "run_attempts"
    state.write_text("0", encoding="utf-8")
    _install_fake_docker(
        bin_dir,
        f"""
        state="{state}"
        case "$*" in
          *info*) exit 0 ;;
          *run*)
            n=$(cat "$state")
            n=$((n + 1))
            echo "$n" > "$state"
            if [[ "$n" -lt 2 ]]; then
              exit 1
            fi
            exit 0
            ;;
          *) exit 1 ;;
        esac
        """,
    )
    result = _run_script(bin_dir)
    assert result.returncode == 0, result.stderr + result.stdout
    assert state.read_text(encoding="utf-8").strip() == "2"
    assert "Docker run probe failed" in result.stdout
    assert "container probe passed" in result.stdout


def test_probe_uses_configured_image(bin_dir: Path) -> None:
    seen = bin_dir / "seen_cmds"
    seen.write_text("", encoding="utf-8")
    _install_fake_docker(
        bin_dir,
        f"""
        echo "$*" >> "{seen}"
        exit 0
        """,
    )
    # A non-default value proves the override is plumbed through (using the
    # default here would pass even if the script ignored the env var).
    result = _run_script(
        bin_dir,
        env_extra={"WAIT_FOR_DOCKER_PROBE_IMAGE": "example.com/custom/probe:1"},
    )
    assert result.returncode == 0, result.stderr + result.stdout
    cmds = seen.read_text(encoding="utf-8")
    assert "run --rm --pull=missing example.com/custom/probe:1" in cmds
