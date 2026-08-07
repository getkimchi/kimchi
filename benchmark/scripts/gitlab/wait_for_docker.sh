#!/usr/bin/env bash
# Wait for the Docker daemon (DinD sidecar) to be fully ready before proceeding.
# Used in terminal-bench-2-chunk before_script.
#
# Two-phase probe:
#   Phase 1: `docker info` — the daemon socket responds (necessary but not sufficient).
#   Phase 2: `docker run --rm <probe-image>` — the daemon can actually pull and run a
#            container. This catches the race where the daemon accepts `docker info`
#            but fails concurrent `docker compose up` with
#            "Cannot connect to the Docker daemon" or "unable to get image".
#
# Probe image is pinned to mirror.gcr.io (same policy as the GitLab DinD job) so
# the readiness check does not hit Docker Hub rate limits.
#
# Optional env overrides (mainly for tests):
#   WAIT_FOR_DOCKER_MAX_ATTEMPTS
#   WAIT_FOR_DOCKER_INFO_SLEEP
#   WAIT_FOR_DOCKER_PROBE_MAX_ATTEMPTS
#   WAIT_FOR_DOCKER_PROBE_SLEEP
#   WAIT_FOR_DOCKER_PROBE_IMAGE
set -euo pipefail

log_info() { echo "[INFO] $*"; }
log_error() { echo "[ERROR] $*" >&2; }

max_attempts="${WAIT_FOR_DOCKER_MAX_ATTEMPTS:-60}"
info_sleep="${WAIT_FOR_DOCKER_INFO_SLEEP:-1}"
probe_max_attempts="${WAIT_FOR_DOCKER_PROBE_MAX_ATTEMPTS:-15}"
probe_sleep="${WAIT_FOR_DOCKER_PROBE_SLEEP:-2}"
probe_image="${WAIT_FOR_DOCKER_PROBE_IMAGE:-mirror.gcr.io/library/hello-world}"

# ── Phase 1: daemon socket is responding ─────────────────────────────────────
log_info "Waiting for Docker daemon (socket)..."
attempt=0

while ! docker info >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [[ $attempt -ge $max_attempts ]]; then
        log_error "Docker daemon socket not ready after ${max_attempts} attempts"
        exit 1
    fi
    log_info "Docker not ready yet, waiting... (attempt $attempt/$max_attempts)"
    sleep "$info_sleep"
done

log_info "Docker daemon socket is responding"

# ── Phase 2: daemon can actually run a container ────────────────────────────
# docker info returns before the daemon is fully operational for compose
# operations (image pulls, container starts). Run a real container to confirm
# the full path works before launching 8 parallel trials.
log_info "Verifying Docker daemon can run containers..."
probe_attempt=0
probe_output=""

while ! probe_output=$(docker run --rm --pull=missing "$probe_image" 2>&1); do
    probe_attempt=$((probe_attempt + 1))
    if [[ $probe_attempt -ge $probe_max_attempts ]]; then
        log_error "Docker daemon cannot run containers after ${probe_max_attempts} probe attempts"
        log_error "Last probe output: ${probe_output}"
        exit 1
    fi
    log_info "Docker run probe failed, retrying... (attempt $probe_attempt/$probe_max_attempts)"
    sleep "$probe_sleep"
done

log_info "Docker daemon is fully ready (container probe passed)"
