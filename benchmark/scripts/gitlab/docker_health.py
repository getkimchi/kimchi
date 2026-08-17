"""Shared Docker daemon health signals for benchmark orchestration."""

from __future__ import annotations

DOCKER_DAEMON_UNREACHABLE_MARKER = "cannot connect to the docker daemon"
DOCKER_DAEMON_UNREACHABLE_SUBCATEGORY = "docker_daemon_unreachable"
